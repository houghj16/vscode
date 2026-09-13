/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { compareRanked, computeRank, decideTier, explainRank, rank } from '../../common/ranking.js';
import { InboxOneTier } from '../../common/inboxOneTypes.js';

suite('Inbox One - ranking & tiering', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('incident forces Critical regardless of other signals', () => {
		assert.strictEqual(decideTier({ incident: true }), InboxOneTier.Critical);
		assert.strictEqual(decideTier({ reachableSecurityExposure: true }), InboxOneTier.Critical);
		assert.strictEqual(decideTier({ expiringHighBlastRadius: true }), InboxOneTier.Critical);
	});

	test('blocking work is Urgent when not on fire', () => {
		assert.strictEqual(decideTier({ blocking: true }), InboxOneTier.Urgent);
		assert.strictEqual(decideTier({ blocksPeople: 2 }), InboxOneTier.Urgent);
	});

	test('non-blocking, non-incident work is FYI', () => {
		assert.strictEqual(decideTier({ autoHandledDone: true }), InboxOneTier.Fyi);
		assert.strictEqual(decideTier({ impact: 0.9 }), InboxOneTier.Fyi);
	});

	test('tiering is a policy separate from rank: high score stays FYI when not blocking', () => {
		const r = rank({ impact: 1, urgency: 1, evidenceConfidence: 1 });
		assert.strictEqual(r.tier, InboxOneTier.Fyi);
		assert.ok(r.rank > 0);
	});

	test('computeRank rewards urgency, impact, blocking, affinity and penalizes effort', () => {
		const low = computeRank({ urgency: 0, impact: 0, evidenceConfidence: 0 });
		const high = computeRank({ urgency: 1, impact: 1, evidenceConfidence: 1, blocksPeople: 5, recipientAffinity: 1 });
		assert.ok(high > low);
		const withEffort = computeRank({ urgency: 1, decisionEffort: 1 });
		const withoutEffort = computeRank({ urgency: 1, decisionEffort: 0 });
		assert.ok(withoutEffort > withEffort);
	});

	test('model-authored numbers are clamped, never authoritative', () => {
		// Out-of-range hints do not blow up the score.
		const a = computeRank({ urgency: 999, impact: -5, evidenceConfidence: 42 });
		const b = computeRank({ urgency: 1, impact: 0, evidenceConfidence: 1 });
		assert.strictEqual(a, b);
	});

	test('explainRank is plain language with no score math', () => {
		const reason = explainRank({ blocksPeople: 2, recipientAffinity: 0.8 }, InboxOneTier.Urgent);
		assert.ok(reason.toLowerCase().includes('blocks 2 people'));
		assert.ok(reason.includes('you own this area'));
		assert.ok(!/\d\.\d/.test(reason), 'reason should not contain raw scores');
	});

	test('explainRank uses singular for one blocked person', () => {
		assert.ok(explainRank({ blocksPeople: 1 }, InboxOneTier.Urgent).toLowerCase().includes('blocks 1 person'));
	});

	test('explainRank falls back to an awareness reason when no signals', () => {
		assert.ok(explainRank({}, InboxOneTier.Fyi).toLowerCase().includes('awareness'));
	});

	test('compareRanked orders higher rank first, ties break toward perishable', () => {
		const a = rank({ urgency: 1, perishability: 0.2 });
		const b = rank({ urgency: 0.5, perishability: 0.9 });
		assert.ok(compareRanked(a, b) < 0, 'higher rank a should sort before b');

		const c = rank({ urgency: 0.5, perishability: 0.2 });
		const d = rank({ urgency: 0.5, perishability: 0.9 });
		// same rank -> more perishable (d) first
		assert.ok(compareRanked(c, d) > 0);
	});
});
