/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EventSource, IDropLedgerEntry, IIngressEvent } from '../../common/inboxOneTypes.js';
import { IBackfillFetcher, IBackfillPage, IReceiverAdapter, IWebhookDelivery, IWebhookIngressHost, WebhookIngress } from '../../common/webhookIngress.js';

// A valid HMAC-SHA256 vector (secret 's3cr3t' over the body below):
const BODY = JSON.stringify({ action: 'opened', pull_request: { number: 1 }, repository: { full_name: 'acme/api' } });

class FakeAdapter implements IReceiverAdapter {
	readonly _onConn = new Emitter<boolean>();
	readonly onConnectivityChange = this._onConn.event;
	readonly _onDelivery = new Emitter<IWebhookDelivery>();
	readonly onDelivery = this._onDelivery.event;
	started = false;
	/** When set, computeSignature returns this fixed digest; otherwise undefined (no secret). */
	signature: string | undefined;
	constructor(signature?: string) { this.signature = signature; }
	async computeSignature(): Promise<string | undefined> { return this.signature; }
	async start(): Promise<void> { this.started = true; }
	dispose(): void { this._onConn.dispose(); this._onDelivery.dispose(); }
}

class FakeFetcher implements IBackfillFetcher {
	calls: Array<{ repo: string; cursor: string | undefined }> = [];
	pages = new Map<string, IBackfillPage>();
	async fetchSince(repo: string, cursor: string | undefined): Promise<IBackfillPage> {
		this.calls.push({ repo, cursor });
		return this.pages.get(repo) ?? { events: [] };
	}
}

class FakeHost implements IWebhookIngressHost {
	submitted: IIngressEvent[] = [];
	drops: IDropLedgerEntry[] = [];
	cursors = new Map<string, string>();
	repos: string[] = [];
	seen = new Set<string>();
	async submit(event: IIngressEvent): Promise<boolean> {
		if (this.seen.has(event.deliveryId)) { return false; }
		this.seen.add(event.deliveryId);
		this.submitted.push(event);
		return true;
	}
	async recordDrop(entry: IDropLedgerEntry): Promise<void> { this.drops.push(entry); }
	getCursor(repo: string): string | undefined { return this.cursors.get(repo); }
	async setCursor(repo: string, cursor: string): Promise<void> { this.cursors.set(repo, cursor); }
	enrolledRepos(): readonly string[] { return this.repos; }
}

function delivery(overrides: Partial<IWebhookDelivery> = {}): IWebhookDelivery {
	return {
		headers: { event: 'pull_request', delivery: 'gid-1', signature256: undefined },
		rawBody: BODY,
		payload: JSON.parse(BODY),
		...overrides,
	};
}

function prEvent(deliveryId: string, id = '1'): IIngressEvent {
	return { deliveryId, source: EventSource.World, repo: 'acme/api', type: 'pull_request', action: 'opened', subject: { kind: 'pr', id }, receivedAt: 0 };
}

suite('Inbox One - WebhookIngress', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function build(adapter: FakeAdapter, fetcher: FakeFetcher, host: FakeHost): WebhookIngress {
		return disposables.add(new WebhookIngress(adapter, fetcher, host, disposables.add(new NullLogService())));
	}

	async function flush(): Promise<void> {
		for (let i = 0; i < 8; i++) { await Promise.resolve(); }
	}

	test('an unsigned delivery (no secret) normalizes and submits', async () => {
		const adapter = new FakeAdapter(undefined);
		const host = new FakeHost();
		build(adapter, new FakeFetcher(), host);
		adapter._onDelivery.fire(delivery());
		await flush();
		assert.strictEqual(host.submitted.length, 1);
		assert.strictEqual(host.submitted[0].subject.id, '1');
		assert.strictEqual(host.drops.length, 0);
	});

	test('a mismatched signature is quarantined, never ingested', async () => {
		const adapter = new FakeAdapter('a'.repeat(64)); // computed digest
		const host = new FakeHost();
		build(adapter, new FakeFetcher(), host);
		adapter._onDelivery.fire(delivery({ headers: { event: 'pull_request', delivery: 'gid-2', signature256: 'sha256=' + 'b'.repeat(64) } }));
		await flush();
		assert.strictEqual(host.submitted.length, 0);
		assert.strictEqual(host.drops.length, 1);
		assert.strictEqual(host.drops[0].reason, 'invalid_signature');
	});

	test('a matching signature is accepted', async () => {
		const digest = 'c'.repeat(64);
		const adapter = new FakeAdapter(digest);
		const host = new FakeHost();
		build(adapter, new FakeFetcher(), host);
		adapter._onDelivery.fire(delivery({ headers: { event: 'pull_request', delivery: 'gid-3', signature256: 'sha256=' + digest } }));
		await flush();
		assert.strictEqual(host.submitted.length, 1);
		assert.strictEqual(host.drops.length, 0);
	});

	test('an unnormalizable delivery is dropped, not submitted', async () => {
		const adapter = new FakeAdapter(undefined);
		const host = new FakeHost();
		build(adapter, new FakeFetcher(), host);
		adapter._onDelivery.fire(delivery({ headers: { event: 'unknown_event', delivery: 'gid-4' }, payload: {} }));
		await flush();
		assert.strictEqual(host.submitted.length, 0);
		assert.strictEqual(host.drops.length, 1);
		assert.strictEqual(host.drops[0].reason, 'unnormalizable');
	});

	test('backfill on recovery submits fetched events and advances the cursor', async () => {
		const adapter = new FakeAdapter(undefined);
		const fetcher = new FakeFetcher();
		const host = new FakeHost();
		host.repos = ['acme/api'];
		fetcher.pages.set('acme/api', { events: [prEvent('b1', '10'), prEvent('b2', '11')], cursor: 'cur-2' });
		const ingress = build(adapter, fetcher, host);

		adapter._onConn.fire(true); // startup recovery
		await flush();

		assert.strictEqual(ingress.backfillRuns, 1);
		assert.strictEqual(host.submitted.length, 2);
		assert.strictEqual(host.cursors.get('acme/api'), 'cur-2');
		assert.strictEqual(fetcher.calls[0].cursor, undefined);
	});

	test('backfill uses the persisted cursor and dedupes against webhook deliveries', async () => {
		const adapter = new FakeAdapter(undefined);
		const fetcher = new FakeFetcher();
		const host = new FakeHost();
		host.repos = ['acme/api'];
		host.cursors.set('acme/api', 'cur-0');
		// The webhook already delivered b1 while up; backfill re-emits it + a new one.
		await host.submit(prEvent('b1', '10'));
		fetcher.pages.set('acme/api', { events: [prEvent('b1', '10'), prEvent('b2', '11')], cursor: 'cur-1' });
		build(adapter, fetcher, host);

		adapter._onConn.fire(true);
		await flush();

		assert.strictEqual(fetcher.calls[0].cursor, 'cur-0', 'resumes from the persisted cursor');
		// b1 deduped by the ingress; only b2 is newly accepted (plus the pre-seeded b1).
		assert.strictEqual(host.submitted.filter(e => e.deliveryId === 'b1').length, 1);
		assert.strictEqual(host.submitted.filter(e => e.deliveryId === 'b2').length, 1);
	});

	test('start() brings the receiver up', async () => {
		const adapter = new FakeAdapter(undefined);
		const ingress = build(adapter, new FakeFetcher(), new FakeHost());
		await ingress.start();
		assert.strictEqual(adapter.started, true);
	});
});
