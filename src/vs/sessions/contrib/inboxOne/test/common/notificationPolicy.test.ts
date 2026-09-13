/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decideNotification, INotificationLedgerEntry, tierPushable } from '../../common/notificationPolicy.js';
import { InboxOneTier } from '../../common/inboxOneTypes.js';
import { INotificationPreferences } from '../../common/inboxOneSettings.js';

const PREFS: INotificationPreferences = { pushCritical: true, pushUrgent: true, pushFyi: false };
const GK = 'acme/api:pr:842';

suite('Inbox One - notification policy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('tierPushable respects Settings', () => {
		assert.strictEqual(tierPushable(InboxOneTier.Critical, PREFS), true);
		assert.strictEqual(tierPushable(InboxOneTier.Urgent, PREFS), true);
		assert.strictEqual(tierPushable(InboxOneTier.Fyi, PREFS), false);
	});

	test('FYI never pushes', () => {
		const d = decideNotification(InboxOneTier.Fyi, 0, PREFS, undefined, GK);
		assert.strictEqual(d.push, false);
		assert.strictEqual(d.reason, 'tier_not_pushable');
	});

	test('first Urgent push in a cycle pushes', () => {
		const d = decideNotification(InboxOneTier.Urgent, 0, PREFS, undefined, GK);
		assert.strictEqual(d.push, true);
		assert.strictEqual(d.reason, 'first_push');
		assert.strictEqual(d.nextEntry.lastPushedTier, InboxOneTier.Urgent);
	});

	test('a second landing at the same tier in the same cycle does not re-push (G13)', () => {
		const first = decideNotification(InboxOneTier.Urgent, 0, PREFS, undefined, GK);
		const second = decideNotification(InboxOneTier.Urgent, 0, PREFS, first.nextEntry, GK);
		assert.strictEqual(second.push, false);
		assert.strictEqual(second.reason, 'already_pushed');
	});

	test('a tier-raising reactivation re-notifies (Urgent -> Critical)', () => {
		const first = decideNotification(InboxOneTier.Urgent, 0, PREFS, undefined, GK);
		const raised = decideNotification(InboxOneTier.Critical, 0, PREFS, first.nextEntry, GK);
		assert.strictEqual(raised.push, true);
		assert.strictEqual(raised.reason, 'tier_raised');
		assert.strictEqual(raised.nextEntry.lastPushedTier, InboxOneTier.Critical);
	});

	test('a tier-lowering change does not re-notify (Critical -> Urgent)', () => {
		const first = decideNotification(InboxOneTier.Critical, 0, PREFS, undefined, GK);
		const lowered = decideNotification(InboxOneTier.Urgent, 0, PREFS, first.nextEntry, GK);
		assert.strictEqual(lowered.push, false);
		assert.strictEqual(lowered.reason, 'not_raised');
	});

	test('a new cycle resets the dedupe window and allows a fresh push', () => {
		const first = decideNotification(InboxOneTier.Urgent, 0, PREFS, undefined, GK);
		const nextCycle = decideNotification(InboxOneTier.Urgent, 1, PREFS, first.nextEntry, GK);
		assert.strictEqual(nextCycle.push, true);
		assert.strictEqual(nextCycle.reason, 'first_push');
		assert.strictEqual(nextCycle.nextEntry.cycleIndex, 1);
	});

	test('disabling Urgent in Settings suppresses its push but keeps the ledger', () => {
		const prefs: INotificationPreferences = { pushCritical: true, pushUrgent: false, pushFyi: false };
		const prev: INotificationLedgerEntry = { groupKey: GK, cycleIndex: 0 };
		const d = decideNotification(InboxOneTier.Urgent, 0, prefs, prev, GK);
		assert.strictEqual(d.push, false);
		assert.strictEqual(d.reason, 'tier_not_pushable');
		assert.strictEqual(d.nextEntry, prev);
	});
});
