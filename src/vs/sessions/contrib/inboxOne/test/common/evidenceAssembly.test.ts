/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claimFromReceipt, evidenceConfidence, isStale, orderClaims, ReceiptKind, rungForReceipt, stampFreshness } from '../../common/evidenceAssembly.js';
import { EvidenceRung, IEvidenceClaim } from '../../common/inboxOneTypes.js';

suite('Inbox One - evidence assembly', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('rungForReceipt is host-authoritative per receipt kind', () => {
		assert.strictEqual(rungForReceipt(ReceiptKind.Illustrative), EvidenceRung.Illustrative);
		assert.strictEqual(rungForReceipt(ReceiptKind.CheckRun), EvidenceRung.SingleRun);
		assert.strictEqual(rungForReceipt(ReceiptKind.ReproducibleTest), EvidenceRung.ReproducibleTest);
		assert.strictEqual(rungForReceipt(ReceiptKind.Diff), EvidenceRung.SourceLineage);
		assert.strictEqual(rungForReceipt(ReceiptKind.Invariant), EvidenceRung.Invariant);
	});

	test('claimFromReceipt derives the rung from the receipt, not the model', () => {
		const claim = claimFromReceipt({ kind: ReceiptKind.Diff, text: 'change limited to retry path', link: 'https://diff/1' });
		assert.strictEqual(claim.rung, EvidenceRung.SourceLineage);
		assert.strictEqual(claim.receiptLink, 'https://diff/1');
	});

	test('orderClaims leads with the strongest evidence', () => {
		const claims: IEvidenceClaim[] = [
			{ text: 'a', rung: EvidenceRung.Illustrative },
			{ text: 'b', rung: EvidenceRung.SourceLineage },
			{ text: 'c', rung: EvidenceRung.SingleRun },
		];
		const ordered = orderClaims(claims);
		assert.deepStrictEqual(ordered.map(c => c.text), ['b', 'c', 'a']);
	});

	test('orderClaims is stable for equal rungs', () => {
		const claims: IEvidenceClaim[] = [
			{ text: 'x', rung: EvidenceRung.SingleRun },
			{ text: 'y', rung: EvidenceRung.SingleRun },
		];
		assert.deepStrictEqual(orderClaims(claims).map(c => c.text), ['x', 'y']);
	});

	test('evidenceConfidence rises with stronger rungs', () => {
		const weak = evidenceConfidence([{ text: 'a', rung: EvidenceRung.Illustrative }]);
		const strong = evidenceConfidence([{ text: 'b', rung: EvidenceRung.Formal }]);
		assert.ok(strong > weak);
		assert.strictEqual(evidenceConfidence([]), 0);
		assert.ok(strong <= 1);
	});

	test('stampFreshness records the exact inputs', () => {
		const f = stampFreshness({ headSha: 'abc', checkIds: ['1', '2'], eventCursor: '100' }, 5);
		assert.strictEqual(f.headSha, 'abc');
		assert.deepStrictEqual(f.checkIds, ['1', '2']);
		assert.strictEqual(f.eventCursor, '100');
		assert.strictEqual(f.computedAt, 5);
	});

	test('isStale detects a changed head SHA (material change, I6)', () => {
		const stamped = stampFreshness({ headSha: 'abc' }, 1);
		assert.strictEqual(isStale(stamped, { headSha: 'abc' }), false);
		assert.strictEqual(isStale(stamped, { headSha: 'def' }), true);
	});

	test('isStale detects a changed event cursor and check set', () => {
		const stamped = stampFreshness({ eventCursor: '100', checkIds: ['1', '2'] }, 1);
		assert.strictEqual(isStale(stamped, { eventCursor: '101' }), true);
		assert.strictEqual(isStale(stamped, { checkIds: ['1', '2', '3'] }), true);
		assert.strictEqual(isStale(stamped, { checkIds: ['2', '1'] }), false);
	});

	test('isStale ignores inputs absent on either side', () => {
		const stamped = stampFreshness({ headSha: 'abc' }, 1);
		// current head unknown -> cannot prove stale on head
		assert.strictEqual(isStale(stamped, {}), false);
	});
});
