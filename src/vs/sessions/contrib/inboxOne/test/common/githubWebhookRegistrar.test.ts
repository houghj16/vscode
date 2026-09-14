/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ensureRepoWebhook,
	IEnsureWebhookRequest,
	INBOX_ONE_WEBHOOK_EVENTS,
	INBOX_ONE_WEBHOOK_PATH,
	IRegistrarResponse,
	RegistrarRequest,
	WebhookRegistrationOutcome,
} from '../../common/githubWebhookRegistrar.js';

interface IRecordedCall {
	method: string;
	path: string;
	body?: unknown;
}

function recorder(responses: (call: IRecordedCall) => IRegistrarResponse<unknown>): { request: RegistrarRequest; calls: IRecordedCall[] } {
	const calls: IRecordedCall[] = [];
	const request: RegistrarRequest = async <T>(method: string, path: string, body?: unknown) => {
		const call = { method, path, body };
		calls.push(call);
		return responses(call) as IRegistrarResponse<T>;
	};
	return { request, calls };
}

const REQ: IEnsureWebhookRequest = {
	repo: 'acme/api',
	webhookUrl: `https://tunnel.example${INBOX_ONE_WEBHOOK_PATH}`,
	secret: 's3cr3t',
	events: ['issues', 'pull_request'],
};

suite('Inbox One - GitHub webhook registrar', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates a webhook when none exists', async () => {
		const { request, calls } = recorder(call => {
			if (call.method === 'GET') { return { data: [], statusCode: 200 }; }
			return { data: { id: 55 }, statusCode: 201 };
		});
		const result = await ensureRepoWebhook(request, REQ);
		assert.strictEqual(result.outcome, WebhookRegistrationOutcome.Created);
		assert.strictEqual(result.hookId, 55);
		// POST to the repo hooks endpoint with our url + secret + json content type.
		const post = calls.find(c => c.method === 'POST');
		assert.ok(post);
		assert.strictEqual(post!.path, '/repos/acme/api/hooks');
		const body = post!.body as { config: { url: string; content_type: string; secret: string }; events: string[]; active: boolean };
		assert.strictEqual(body.config.url, REQ.webhookUrl);
		assert.strictEqual(body.config.content_type, 'json');
		assert.strictEqual(body.config.secret, 's3cr3t');
		assert.strictEqual(body.active, true);
		assert.deepStrictEqual(body.events, ['issues', 'pull_request']);
	});

	test('is a no-op when the correct webhook already exists', async () => {
		const { request, calls } = recorder(call => {
			if (call.method === 'GET') {
				return { data: [{ id: 7, active: true, events: ['issues', 'pull_request', 'check_run'], config: { url: REQ.webhookUrl } }], statusCode: 200 };
			}
			throw new Error('should not mutate');
		});
		const result = await ensureRepoWebhook(request, REQ);
		assert.strictEqual(result.outcome, WebhookRegistrationOutcome.Unchanged);
		assert.strictEqual(result.hookId, 7);
		assert.strictEqual(calls.filter(c => c.method !== 'GET').length, 0, 'no mutating calls');
	});

	test('patches the URL when the tunnel rotated (recognized by path suffix)', async () => {
		const oldUrl = `https://old-tunnel.example${INBOX_ONE_WEBHOOK_PATH}`;
		const { request, calls } = recorder(call => {
			if (call.method === 'GET') {
				return { data: [{ id: 9, active: true, events: ['issues', 'pull_request'], config: { url: oldUrl } }], statusCode: 200 };
			}
			return { data: { id: 9 }, statusCode: 200 };
		});
		const result = await ensureRepoWebhook(request, REQ);
		assert.strictEqual(result.outcome, WebhookRegistrationOutcome.Updated);
		assert.strictEqual(result.hookId, 9);
		const patch = calls.find(c => c.method === 'PATCH');
		assert.ok(patch);
		assert.strictEqual(patch!.path, '/repos/acme/api/hooks/9');
		assert.strictEqual((patch!.body as { config: { url: string } }).config.url, REQ.webhookUrl);
	});

	test('patches when events are missing even if the URL matches', async () => {
		const { request, calls } = recorder(call => {
			if (call.method === 'GET') {
				return { data: [{ id: 3, active: true, events: ['issues'], config: { url: REQ.webhookUrl } }], statusCode: 200 };
			}
			return { data: { id: 3 }, statusCode: 200 };
		});
		const result = await ensureRepoWebhook(request, REQ);
		assert.strictEqual(result.outcome, WebhookRegistrationOutcome.Updated);
		assert.ok(calls.some(c => c.method === 'PATCH'));
	});

	test('re-activates when the existing hook is inactive', async () => {
		const { request } = recorder(call => {
			if (call.method === 'GET') {
				return { data: [{ id: 4, active: false, events: ['issues', 'pull_request'], config: { url: REQ.webhookUrl } }], statusCode: 200 };
			}
			return { data: { id: 4 }, statusCode: 200 };
		});
		const result = await ensureRepoWebhook(request, REQ);
		assert.strictEqual(result.outcome, WebhookRegistrationOutcome.Updated);
	});

	test('ignores hooks that are not ours', async () => {
		const { request, calls } = recorder(call => {
			if (call.method === 'GET') {
				return { data: [{ id: 1, active: true, config: { url: 'https://other.example/some/hook' } }], statusCode: 200 };
			}
			return { data: { id: 99 }, statusCode: 201 };
		});
		const result = await ensureRepoWebhook(request, REQ);
		assert.strictEqual(result.outcome, WebhookRegistrationOutcome.Created);
		assert.ok(calls.some(c => c.method === 'POST'), 'creates our own hook rather than touching the foreign one');
	});

	test('reports failure on a list error and never mutates', async () => {
		const { request, calls } = recorder(() => ({ data: undefined, statusCode: 403 }));
		const result = await ensureRepoWebhook(request, REQ);
		assert.strictEqual(result.outcome, WebhookRegistrationOutcome.Failed);
		assert.strictEqual(calls.filter(c => c.method !== 'GET').length, 0);
	});

	test('reports failure on an invalid repo', async () => {
		const { request } = recorder(() => ({ data: [], statusCode: 200 }));
		const result = await ensureRepoWebhook(request, { ...REQ, repo: 'not-a-repo' });
		assert.strictEqual(result.outcome, WebhookRegistrationOutcome.Failed);
	});

	test('the event list covers every trigger family', () => {
		for (const e of ['issues', 'pull_request', 'check_run', 'status', 'code_scanning_alert', 'deployment']) {
			assert.ok(INBOX_ONE_WEBHOOK_EVENTS.includes(e), `missing ${e}`);
		}
	});
});
