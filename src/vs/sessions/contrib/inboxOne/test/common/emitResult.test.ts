/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRawWorkerResult, validateWorkerResult } from '../../common/emitResult.js';
import { ActionType, EvidenceRung } from '../../common/inboxOneTypes.js';

function baseEvidence(overrides: Partial<IRawWorkerResult> = {}): IRawWorkerResult {
	return {
		decisionSentence: 'PR #842 is ready to approve',
		claims: [
			{ text: '47/47 checks pass', receiptLink: 'https://run/1', rung: EvidenceRung.SingleRun },
			{ text: 'change limited to the retry path', receiptLink: 'https://diff/1', rung: EvidenceRung.SourceLineage },
		],
		gapLine: 'behavior under production load not verified',
		...overrides,
	};
}

suite('Inbox One - emit-result validation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts a well-formed evidence pack with a valid action', () => {
		const raw = baseEvidence({
			actionType: ActionType.ApprovePr,
			payload: { repo: 'acme/api', prNumber: 842 },
			label: 'Approve PR',
		});
		const result = validateWorkerResult(raw);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.evidence.decisionSentence, 'PR #842 is ready to approve');
			assert.strictEqual(result.evidence.claims.length, 2);
			assert.strictEqual(result.evidence.primaryAction!.actionType, ActionType.ApprovePr);
			assert.strictEqual(result.evidence.primaryAction!.label, 'Approve PR');
		}
	});

	test('accepts an evidence-only result with no action (e.g. FYI analysis)', () => {
		const result = validateWorkerResult(baseEvidence());
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.evidence.primaryAction, undefined);
		}
	});

	test('carries the dedicated worker-authored title verbatim (trimmed), or none', () => {
		const short = validateWorkerResult(baseEvidence({ title: '  PR #842 ready to approve  ' }));
		assert.strictEqual(short.ok, true);
		if (short.ok) {
			assert.strictEqual(short.evidence.title, 'PR #842 ready to approve', 'trimmed, not truncated');
		}

		const none = validateWorkerResult(baseEvidence());
		assert.strictEqual(none.ok, true);
		if (none.ok) {
			assert.strictEqual(none.evidence.title, undefined, 'absent title -> undefined (host falls back to the subject)');
		}
	});

	test('the `other` action becomes a custom ask (Steer), not a typed action', () => {
		const r = validateWorkerResult(baseEvidence({ actionType: 'other', customAsk: 'Which rollout order for #21 and #22?' }));
		assert.strictEqual(r.ok, true);
		if (r.ok) {
			assert.strictEqual(r.evidence.customAsk, 'Which rollout order for #21 and #22?');
			assert.strictEqual(r.evidence.primaryAction, undefined, 'other never yields a typed action');
		}

		// A bare `other` (no customAsk) falls back to the decisionSentence as the ask.
		const bare = validateWorkerResult(baseEvidence({ actionType: 'other' }));
		assert.strictEqual(bare.ok, true);
		if (bare.ok) {
			assert.strictEqual(bare.evidence.customAsk, 'PR #842 is ready to approve');
		}

		// A normal evidence-only result has no custom ask.
		const plain = validateWorkerResult(baseEvidence());
		assert.strictEqual(plain.ok, true);
		if (plain.ok) {
			assert.strictEqual(plain.evidence.customAsk, undefined);
		}
	});

	test('rejects a missing decision sentence', () => {
		const result = validateWorkerResult(baseEvidence({ decisionSentence: '' }));
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.problems.some(p => p.includes('decisionSentence')));
		}
	});

	test('rejects a missing gap line (mandatory Not verified)', () => {
		const result = validateWorkerResult(baseEvidence({ gapLine: '  ' }));
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.problems.some(p => p.includes('gapLine')));
		}
	});

	test('rejects zero claims and too many claims', () => {
		assert.strictEqual(validateWorkerResult(baseEvidence({ claims: [] })).ok, false);
		const tooMany = Array.from({ length: 5 }, (_, i) => ({ text: `c${i}`, rung: EvidenceRung.Illustrative }));
		assert.strictEqual(validateWorkerResult(baseEvidence({ claims: tooMany })).ok, false);
	});

	test('rejects a claim without text', () => {
		const result = validateWorkerResult(baseEvidence({ claims: [{ receiptLink: 'https://x' }] }));
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.problems.some(p => p.includes('claims[0].text')));
		}
	});

	test('rejects an out-of-catalog action type', () => {
		const result = validateWorkerResult(baseEvidence({ actionType: 'delete_repo', payload: {}, label: 'Nuke' }));
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.problems.some(p => p.includes('unknown action_type')));
		}
	});

	test('rejects a malformed action payload', () => {
		const result = validateWorkerResult(baseEvidence({ actionType: ActionType.MergePr, payload: { repo: 'acme/api' }, label: 'Merge' }));
		assert.strictEqual(result.ok, false);
	});

	test('rejects a label longer than the word limit', () => {
		const result = validateWorkerResult(baseEvidence({
			actionType: ActionType.ApprovePr,
			payload: { repo: 'acme/api', prNumber: 1 },
			label: 'this label is definitely too long',
		}));
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.problems.some(p => p.includes('label must be at most')));
		}
	});

	test('rejects an action proposed without a label', () => {
		const result = validateWorkerResult(baseEvidence({ actionType: ActionType.ApprovePr, payload: { repo: 'r', prNumber: 1 } }));
		assert.strictEqual(result.ok, false);
	});

	test('host-authoritative rung: invalid rung defaults to illustrative', () => {
		const result = validateWorkerResult(baseEvidence({ claims: [{ text: 'x', rung: 999 }] }));
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.evidence.claims[0].rung, EvidenceRung.Illustrative);
		}
	});

	test('trims whitespace from decision, gap, claims, and label', () => {
		const result = validateWorkerResult(baseEvidence({
			decisionSentence: '  ready  ',
			gapLine: '  gap  ',
			claims: [{ text: '  c1  ', rung: EvidenceRung.SingleRun }],
			actionType: ActionType.ApprovePr,
			payload: { repo: 'r', prNumber: 1 },
			label: '  Approve PR  ',
		}));
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.evidence.decisionSentence, 'ready');
			assert.strictEqual(result.evidence.gapLine, 'gap');
			assert.strictEqual(result.evidence.claims[0].text, 'c1');
			assert.strictEqual(result.evidence.primaryAction!.label, 'Approve PR');
		}
	});
});
