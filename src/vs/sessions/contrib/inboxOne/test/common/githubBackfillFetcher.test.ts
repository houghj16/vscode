/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyEvent, WorkerRole } from '../../common/eventTaxonomy.js';
import { BackfillRequest, fetchBackfillPage, IBackfillResponse } from '../../common/githubBackfillFetcher.js';

function fakeRequest(items: unknown, statusCode = 200): { request: BackfillRequest; calls: string[] } {
	const calls: string[] = [];
	const request: BackfillRequest = async <T>(_method: string, path: string) => {
		calls.push(path);
		return { data: items as T, statusCode } as IBackfillResponse<T>;
	};
	return { request, calls };
}

suite('Inbox One - GitHub backfill fetcher', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes open issues and PRs into dispatchable events', async () => {
		const { request } = fakeRequest([
			{ number: 17, updated_at: '2026-01-01T10:00:00Z', state: 'open' },
			{ number: 42, updated_at: '2026-01-01T11:00:00Z', state: 'open', pull_request: { url: 'https://api/pr/42' } },
		]);
		const page = await fetchBackfillPage(request, 'acme/api', undefined);
		assert.strictEqual(page.events.length, 2);

		const issue = page.events.find(e => e.type === 'issues')!;
		assert.strictEqual(issue.action, 'opened');
		assert.deepStrictEqual(issue.subject, { kind: 'issue', id: '17' });
		assert.strictEqual(classifyEvent(issue)!.role, WorkerRole.IssueTriage);

		const pr = page.events.find(e => e.type === 'pull_request')!;
		assert.strictEqual(pr.action, 'opened');
		assert.deepStrictEqual(pr.subject, { kind: 'pr', id: '42' });
		assert.strictEqual(classifyEvent(pr)!.role, WorkerRole.CodeReview);
	});

	test('advances the cursor to the newest updated_at', async () => {
		const { request } = fakeRequest([
			{ number: 1, updated_at: '2026-01-01T10:00:00Z', state: 'open' },
			{ number: 2, updated_at: '2026-01-01T12:30:00Z', state: 'open' },
			{ number: 3, updated_at: '2026-01-01T11:00:00Z', state: 'open' },
		]);
		const page = await fetchBackfillPage(request, 'acme/api', '2026-01-01T09:00:00Z');
		assert.strictEqual(page.cursor, '2026-01-01T12:30:00Z');
	});

	test('skips the boundary item equal to the cursor (inclusive since)', async () => {
		const { request } = fakeRequest([
			{ number: 1, updated_at: '2026-01-01T09:00:00Z', state: 'open' }, // == cursor
			{ number: 2, updated_at: '2026-01-01T10:00:00Z', state: 'open' },
		]);
		const page = await fetchBackfillPage(request, 'acme/api', '2026-01-01T09:00:00Z');
		assert.strictEqual(page.events.length, 1);
		assert.strictEqual(page.events[0].subject.id, '2');
	});

	test('closed items map to a non-dispatchable action (gate drops them)', async () => {
		const { request } = fakeRequest([
			{ number: 5, updated_at: '2026-01-01T10:00:00Z', state: 'closed' },
		]);
		const page = await fetchBackfillPage(request, 'acme/api', undefined);
		assert.strictEqual(page.events[0].action, 'closed');
		assert.strictEqual(classifyEvent(page.events[0]), undefined, 'a closed issue yields no dispatchable work');
	});

	test('delivery ids are backfill-scoped and stable per (item, updated_at)', async () => {
		const items = [{ number: 7, updated_at: '2026-01-01T10:00:00Z', state: 'open' }];
		const a = await fetchBackfillPage(fakeRequest(items).request, 'acme/api', undefined);
		const b = await fetchBackfillPage(fakeRequest(items).request, 'acme/api', undefined);
		assert.strictEqual(a.events[0].deliveryId, b.events[0].deliveryId, 'stable across runs -> ingress dedupes');
		assert.ok(a.events[0].deliveryId.startsWith('backfill:acme/api:issue:7:'));
	});

	test('requests the issues endpoint with since + sort', async () => {
		const { request, calls } = fakeRequest([]);
		await fetchBackfillPage(request, 'acme/api', '2026-01-01T09:00:00Z');
		assert.strictEqual(calls.length, 1);
		assert.ok(calls[0].startsWith('/repos/acme/api/issues?'));
		assert.ok(calls[0].includes('sort=updated'));
		assert.ok(calls[0].includes('since=2026-01-01T09'));
	});

	test('returns an empty page on error or invalid repo', async () => {
		const err = await fetchBackfillPage(fakeRequest(undefined, 500).request, 'acme/api', undefined);
		assert.strictEqual(err.events.length, 0);
		const bad = await fetchBackfillPage(fakeRequest([]).request, 'not-a-repo', undefined);
		assert.strictEqual(bad.events.length, 0);
	});
});
