/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { deriveGroupKey, slugifyThemeSlug } from '../../common/groupKey.js';
import { EventSource, IEventSubject, IIngressEvent } from '../../common/inboxOneTypes.js';

function event(partial: Partial<IIngressEvent> & { subject: IEventSubject }): IIngressEvent {
	return {
		deliveryId: 'd1',
		source: EventSource.World,
		type: 'test',
		receivedAt: 0,
		...partial,
	};
}

suite('Inbox One - deriveGroupKey', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('pull request keys by repo + number', () => {
		assert.strictEqual(
			deriveGroupKey(event({ repo: 'acme/api', subject: { kind: 'pr', id: '842' } })),
			'acme/api:pr:842'
		);
	});

	test('single issue keys by repo + number', () => {
		assert.strictEqual(
			deriveGroupKey(event({ repo: 'acme/web', subject: { kind: 'issue', id: '901' } })),
			'acme/web:issue:901'
		);
	});

	test('check run attaches to its owning PR task (G2)', () => {
		assert.strictEqual(
			deriveGroupKey(event({ repo: 'acme/api', subject: { kind: 'check', id: 'run-5', attachedTo: { kind: 'pr', id: '842' } } })),
			'acme/api:pr:842'
		);
	});

	test('check run attaches to its owning branch task', () => {
		assert.strictEqual(
			deriveGroupKey(event({ repo: 'acme/api', subject: { kind: 'check', id: 'run-5', attachedTo: { kind: 'branch', id: 'main' } } })),
			'acme/api:branch:main'
		);
	});

	test('check run with no attachment falls back to a branch task', () => {
		assert.strictEqual(
			deriveGroupKey(event({ repo: 'acme/api', subject: { kind: 'check', id: 'main' } })),
			'acme/api:branch:main'
		);
	});

	test('issue cluster keys by normalized theme slug (G9)', () => {
		assert.strictEqual(
			deriveGroupKey(event({ repo: 'acme/web', subject: { kind: 'issue-cluster', id: 'Session Expiry on Mobile Safari' } })),
			'acme/web:issue-cluster:session-expiry-on-mobile-safari'
		);
	});

	test('security alert keys by cve/alert id', () => {
		assert.strictEqual(
			deriveGroupKey(event({ repo: 'acme/api', subject: { kind: 'security', id: 'CVE-2024-1234' } })),
			'acme/api:security:CVE-2024-1234'
		);
	});

	test('deployment keys by environment', () => {
		assert.strictEqual(
			deriveGroupKey(event({ repo: 'acme/api', subject: { kind: 'deploy', id: 'production' } })),
			'acme/api:deploy:production'
		);
	});

	test('standalone session event keys by session id', () => {
		assert.strictEqual(
			deriveGroupKey(event({ source: EventSource.Session, sessionId: 'abc', subject: { kind: 'session', id: 'abc' } })),
			'session:abc'
		);
	});

	test('session subject falls back to event.sessionId when subject id is empty', () => {
		assert.strictEqual(
			deriveGroupKey(event({ source: EventSource.Session, sessionId: 'xyz', subject: { kind: 'session', id: '' } })),
			'session:xyz'
		);
	});

	test('repository world event without a repo yields no key (dropped)', () => {
		assert.strictEqual(
			deriveGroupKey(event({ subject: { kind: 'pr', id: '1' } })),
			undefined
		);
	});

	test('derivation is deterministic and idempotent for the same subject', () => {
		const e = event({ repo: 'acme/api', subject: { kind: 'pr', id: '842' } });
		assert.strictEqual(deriveGroupKey(e), deriveGroupKey(e));
	});

	test('slugifyThemeSlug collapses punctuation and trims hyphens', () => {
		assert.strictEqual(slugifyThemeSlug('  Export to CSV!! '), 'export-to-csv');
		assert.strictEqual(slugifyThemeSlug('___'), 'unnamed');
	});
});
