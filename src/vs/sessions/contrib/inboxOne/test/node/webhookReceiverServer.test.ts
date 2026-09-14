/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ok, strictEqual } from 'assert';
import { createHmac } from 'crypto';
import type * as http from 'http';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { normalizeWebhook, verifyWebhookSignature } from '../../common/githubWebhook.js';
import { IWebhookRequest, startLocalWebhookReceiver } from '../../node/webhookReceiverServer.js';

interface ITestResponse {
	statusCode: number;
	body: string;
}

async function send(
	port: number,
	options: { method?: string; path?: string; body?: string; headers?: Record<string, string> },
): Promise<ITestResponse> {
	const httpModule = await import('http');
	const payload = options.body === undefined ? undefined : Buffer.from(options.body, 'utf8');
	const headers: Record<string, string> = { ...(options.headers ?? {}) };
	if (payload) {
		headers['content-length'] = String(payload.length);
	}
	const req: http.ClientRequest = httpModule.request({
		host: '127.0.0.1',
		port,
		method: options.method ?? 'POST',
		path: options.path ?? '/inbox-one/webhook',
		headers,
	});
	const responsePromise = new Promise<ITestResponse>((resolve, reject) => {
		req.on('response', res => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
			res.on('error', reject);
		});
		req.on('error', reject);
	});
	if (payload) {
		req.write(payload);
	}
	req.end();
	return responsePromise;
}

suite('Inbox One - local webhook receiver', () => {

	ensureNoDisposablesAreLeakedInTestSuite();
	const logService = new NullLogService();

	async function startWith(received: IWebhookRequest[]) {
		return startLocalWebhookReceiver({ onWebhook: req => received.push(req) }, logService);
	}

	test('accepts a POSTed webhook and parses headers + raw body', async () => {
		const received: IWebhookRequest[] = [];
		const receiver = await startWith(received);
		try {
			const body = JSON.stringify({ action: 'opened', pull_request: { number: 842 }, repository: { full_name: 'acme/api' } });
			const res = await send(receiver.port, {
				body,
				headers: {
					'content-type': 'application/json',
					'x-github-event': 'pull_request',
					'x-github-delivery': 'gid-123',
					'x-hub-signature-256': 'sha256=deadbeef',
				},
			});
			strictEqual(res.statusCode, 204);
			strictEqual(received.length, 1);
			strictEqual(received[0].event, 'pull_request');
			strictEqual(received[0].delivery, 'gid-123');
			strictEqual(received[0].signature256, 'sha256=deadbeef');
			strictEqual(received[0].rawBody, body);
		} finally {
			receiver.dispose();
		}
	});

	test('a real delivery flows through verify + normalize end to end', async () => {
		const received: IWebhookRequest[] = [];
		const receiver = await startWith(received);
		try {
			const secret = 's3cr3t';
			const body = JSON.stringify({ action: 'opened', issue: { number: 17 }, repository: { full_name: 'acme/api' } });
			const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
			const res = await send(receiver.port, {
				body,
				headers: {
					'content-type': 'application/json',
					'x-github-event': 'issues',
					'x-github-delivery': 'gid-e2e',
					'x-hub-signature-256': signature,
				},
			});
			strictEqual(res.statusCode, 204);
			strictEqual(received.length, 1);

			// The received delivery verifies against a locally-computed HMAC and
			// normalizes into a dispatchable event -- the full physical->logical path.
			const computed = createHmac('sha256', secret).update(received[0].rawBody).digest('hex');
			strictEqual(verifyWebhookSignature(computed, received[0].signature256), true);
			const event = normalizeWebhook(
				{ event: received[0].event, delivery: received[0].delivery, signature256: received[0].signature256 },
				JSON.parse(received[0].rawBody),
				Date.now(),
			);
			ok(event, 'delivery normalized to an event');
			strictEqual(event!.type, 'issues');
			strictEqual(event!.repo, 'acme/api');
			strictEqual(event!.deliveryId, 'gid-e2e');
		} finally {
			receiver.dispose();
		}
	});

	test('a tampered body fails signature verification', async () => {
		const received: IWebhookRequest[] = [];
		const receiver = await startWith(received);
		try {
			const secret = 's3cr3t';
			const body = JSON.stringify({ action: 'opened', pull_request: { number: 1 } });
			const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
			await send(receiver.port, {
				body: body + ' ', // tamper: extra byte after signing
				headers: { 'x-github-event': 'pull_request', 'x-github-delivery': 'gid-tamper', 'x-hub-signature-256': signature },
			});
			strictEqual(received.length, 1);
			const computed = createHmac('sha256', secret).update(received[0].rawBody).digest('hex');
			strictEqual(verifyWebhookSignature(computed, received[0].signature256), false);
		} finally {
			receiver.dispose();
		}
	});

	test('GET is a liveness probe (200) and does not deliver', async () => {
		const received: IWebhookRequest[] = [];
		const receiver = await startWith(received);
		try {
			const res = await send(receiver.port, { method: 'GET', body: undefined });
			strictEqual(res.statusCode, 200);
			strictEqual(received.length, 0);
		} finally {
			receiver.dispose();
		}
	});

	test('wrong path -> 404, wrong method -> 405', async () => {
		const received: IWebhookRequest[] = [];
		const receiver = await startWith(received);
		try {
			const notFound = await send(receiver.port, { path: '/nope', body: '{}' });
			strictEqual(notFound.statusCode, 404);
			const wrongMethod = await send(receiver.port, { method: 'PUT', body: '{}' });
			strictEqual(wrongMethod.statusCode, 405);
			strictEqual(received.length, 0);
		} finally {
			receiver.dispose();
		}
	});

	test('binds a loopback address with a real port and path', async () => {
		const received: IWebhookRequest[] = [];
		const receiver = await startWith(received);
		try {
			ok(receiver.baseUrl.startsWith('http://127.0.0.1:'));
			ok(receiver.port > 0);
			strictEqual(receiver.path, '/inbox-one/webhook');
		} finally {
			receiver.dispose();
		}
	});
});
