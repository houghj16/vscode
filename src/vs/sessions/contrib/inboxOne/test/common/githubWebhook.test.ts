/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyEvent, WorkerRole } from '../../common/eventTaxonomy.js';
import { IWebhookHeaders, normalizeWebhook, parseSignatureHeader, timingSafeEqualHex, verifyWebhookSignature } from '../../common/githubWebhook.js';
import { EventSource } from '../../common/inboxOneTypes.js';

function headers(event: string, delivery = 'gid-1', signature256?: string): IWebhookHeaders {
	return { event, delivery, signature256 };
}

suite('Inbox One - GitHub webhook normalization', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes a pull_request opened event', () => {
		const ev = normalizeWebhook(headers('pull_request'), {
			action: 'opened',
			pull_request: { number: 842 },
			repository: { full_name: 'acme/api' },
		}, 1000);
		assert.ok(ev);
		assert.strictEqual(ev!.type, 'pull_request');
		assert.strictEqual(ev!.action, 'opened');
		assert.strictEqual(ev!.repo, 'acme/api');
		assert.strictEqual(ev!.source, EventSource.World);
		assert.strictEqual(ev!.deliveryId, 'gid-1');
		assert.deepStrictEqual(ev!.subject, { kind: 'pr', id: '842' });
		// The normalized event must be classifiable by the taxonomy.
		assert.strictEqual(classifyEvent(ev!)!.role, WorkerRole.CodeReview);
	});

	test('normalizes an issues event', () => {
		const ev = normalizeWebhook(headers('issues'), {
			action: 'labeled',
			issue: { number: 17 },
			repository: { full_name: 'acme/api' },
		}, 0);
		assert.deepStrictEqual(ev!.subject, { kind: 'issue', id: '17' });
		assert.strictEqual(classifyEvent(ev!)!.role, WorkerRole.IssueTriage);
	});

	test('folds check_run completion conclusion into the action', () => {
		const failed = normalizeWebhook(headers('check_run'), {
			action: 'completed',
			check_run: { id: 55, conclusion: 'failure', pull_requests: [{ number: 842 }] },
			repository: { full_name: 'acme/api' },
		}, 0);
		assert.strictEqual(failed!.action, 'failure');
		assert.deepStrictEqual(failed!.subject, { kind: 'check', id: '55', attachedTo: { kind: 'pr', id: '842' } });
		// A failed check is dispatchable fix work.
		assert.strictEqual(classifyEvent(failed!)!.role, WorkerRole.ImplementFix);

		const passed = normalizeWebhook(headers('check_run'), {
			action: 'completed',
			check_run: { id: 56, conclusion: 'success', pull_requests: [{ number: 842 }] },
			repository: { full_name: 'acme/api' },
		}, 0);
		assert.strictEqual(passed!.action, 'success');
		// A passing check yields no dispatchable work (taxonomy drops it).
		assert.strictEqual(classifyEvent(passed!), undefined);
	});

	test('check_run without a PR attaches to its branch', () => {
		const ev = normalizeWebhook(headers('check_run'), {
			action: 'completed',
			check_run: { id: 77, conclusion: 'timed_out', check_suite: { head_branch: 'main' } },
			repository: { full_name: 'acme/api' },
		}, 0);
		assert.strictEqual(ev!.action, 'timed_out');
		assert.deepStrictEqual(ev!.subject.attachedTo, { kind: 'branch', id: 'main' });
	});

	test('maps commit status state onto the action', () => {
		const ev = normalizeWebhook(headers('status'), {
			state: 'failure',
			sha: 'abc123',
			branches: [{ name: 'main' }],
			repository: { full_name: 'acme/api' },
		}, 0);
		assert.strictEqual(ev!.action, 'failure');
		assert.deepStrictEqual(ev!.subject, { kind: 'check', id: 'abc123', attachedTo: { kind: 'branch', id: 'main' } });
	});

	test('normalizes a security alert', () => {
		const ev = normalizeWebhook(headers('code_scanning_alert'), {
			action: 'created',
			alert: { number: 3 },
			repository: { full_name: 'acme/api' },
		}, 0);
		assert.deepStrictEqual(ev!.subject, { kind: 'security', id: '3' });
		assert.strictEqual(classifyEvent(ev!)!.role, WorkerRole.ImplementFix);
	});

	test('returns undefined when the subject cannot be derived', () => {
		assert.strictEqual(normalizeWebhook(headers('pull_request'), { action: 'opened', repository: { full_name: 'acme/api' } }, 0), undefined);
		assert.strictEqual(normalizeWebhook(headers('issues'), { action: 'opened' }, 0), undefined);
		assert.strictEqual(normalizeWebhook(headers(''), { pull_request: { number: 1 } }, 0), undefined);
		assert.strictEqual(normalizeWebhook(headers('unknown_event'), { repository: { full_name: 'a/b' } }, 0), undefined);
		assert.strictEqual(normalizeWebhook(headers('pull_request', ''), { pull_request: { number: 1 } }, 0), undefined);
		assert.strictEqual(normalizeWebhook(headers('pull_request'), null, 0), undefined);
	});
});

suite('Inbox One - webhook signature verification', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Real HMAC-SHA256 vectors precomputed with node crypto (kept as constants so
	// this common-layer test imports no platform crypto):
	//   secret 's3cr3t' over body '{"action":"opened","pull_request":{"number":1}}'
	const GOOD = '1a515c62e3562dece9c008c177cec05938b027ef73d59734bc17da0e6bc8aa4c';
	// same secret over a body with a trailing space (tamper):
	const TAMPERED = 'a98ddb96cbba08abd588b0d8547b00f3d386dcd71399f2d7555cb770bfe11da7';
	// a different secret over the original body:
	const WRONG = 'f84d456b3d2c964c15a94858bb3c3bf9565243f2484f88007d37a0c50e03c7c7';

	test('parses a well-formed signature header', () => {
		assert.strictEqual(parseSignatureHeader('sha256=abcDEF01'), 'abcdef01');
		assert.strictEqual(parseSignatureHeader('sha256=00ff'), '00ff');
	});

	test('rejects malformed signature headers', () => {
		assert.strictEqual(parseSignatureHeader(undefined), undefined);
		assert.strictEqual(parseSignatureHeader(''), undefined);
		assert.strictEqual(parseSignatureHeader('sha1=abcd'), undefined);
		assert.strictEqual(parseSignatureHeader('sha256='), undefined);
		assert.strictEqual(parseSignatureHeader('sha256=xyz'), undefined);
		assert.strictEqual(parseSignatureHeader('abcd'), undefined);
	});

	test('constant-time hex compare', () => {
		assert.strictEqual(timingSafeEqualHex('abcd', 'abcd'), true);
		assert.strictEqual(timingSafeEqualHex('abcd', 'abce'), false);
		assert.strictEqual(timingSafeEqualHex('abcd', 'abcde'), false);
		assert.strictEqual(timingSafeEqualHex('', ''), true);
	});

	test('verifies a real HMAC-SHA256 digest end to end', () => {
		assert.strictEqual(verifyWebhookSignature(GOOD, `sha256=${GOOD}`), true);
		// A tampered body yields a different digest and must fail.
		assert.strictEqual(verifyWebhookSignature(GOOD, `sha256=${TAMPERED}`), false);
		// Wrong secret must fail.
		assert.strictEqual(verifyWebhookSignature(GOOD, `sha256=${WRONG}`), false);
		// Missing signature must fail (closed by default).
		assert.strictEqual(verifyWebhookSignature(GOOD, undefined), false);
		// Uppercase digests compare equal (normalized to lower-case).
		assert.strictEqual(verifyWebhookSignature(GOOD.toUpperCase(), `sha256=${GOOD}`), true);
	});
});
