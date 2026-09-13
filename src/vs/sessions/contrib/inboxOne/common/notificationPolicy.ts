/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GroupKey, InboxOneTier } from './inboxOneTypes.js';
import { INotificationPreferences } from './inboxOneSettings.js';

/**
 * Notification policy (design 7.5, gotcha G13). Push fires only for
 * Critical/Urgent (per Settings), deduped by group_key -- one push per
 * task-cycle. A reactivation re-notifies ONLY when it RAISES the tier. FYI never
 * pushes. A suppressed push still appears in-inbox (no suppression, only quieter
 * delivery) -- this module governs the push decision, not inbox visibility.
 */

/** Per-task-cycle notification bookkeeping, keyed by group_key. */
export interface INotificationLedgerEntry {
	readonly groupKey: GroupKey;
	/** The tier at which the last push was delivered for the current cycle. */
	readonly lastPushedTier?: InboxOneTier;
	/** The attempt index of the cycle the last push belonged to. */
	readonly cycleIndex: number;
}

/** Tier priority for "raises the tier" comparisons. Higher = more urgent. */
function tierRank(tier: InboxOneTier): number {
	switch (tier) {
		case InboxOneTier.Critical: return 3;
		case InboxOneTier.Urgent: return 2;
		case InboxOneTier.Fyi: return 1;
	}
}

/** Whether Settings allow a push for this tier. */
export function tierPushable(tier: InboxOneTier, prefs: INotificationPreferences): boolean {
	switch (tier) {
		case InboxOneTier.Critical: return prefs.pushCritical;
		case InboxOneTier.Urgent: return prefs.pushUrgent;
		case InboxOneTier.Fyi: return prefs.pushFyi;
	}
}

export interface INotificationDecision {
	readonly push: boolean;
	/** Updated ledger entry to persist when `push` is true (or unchanged when false). */
	readonly nextEntry: INotificationLedgerEntry;
	readonly reason: 'first_push' | 'tier_raised' | 'already_pushed' | 'tier_not_pushable' | 'not_raised';
}

/**
 * Decides whether a task landing at `tier` (in cycle `cycleIndex`) should push.
 *
 * Rules:
 *  - FYI (or any tier disabled in Settings) never pushes.
 *  - The first push in a cycle for a pushable tier pushes.
 *  - Within the same cycle, re-notify only when the tier is RAISED above the last
 *    pushed tier.
 *  - A new cycle (higher cycleIndex) resets and allows a fresh first push.
 */
export function decideNotification(
	tier: InboxOneTier,
	cycleIndex: number,
	prefs: INotificationPreferences,
	previous: INotificationLedgerEntry | undefined,
	groupKey: GroupKey,
): INotificationDecision {
	if (!tierPushable(tier, prefs)) {
		return { push: false, reason: 'tier_not_pushable', nextEntry: previous ?? { groupKey, cycleIndex } };
	}

	// New cycle resets the dedupe window.
	if (!previous || cycleIndex > previous.cycleIndex) {
		return { push: true, reason: 'first_push', nextEntry: { groupKey, cycleIndex, lastPushedTier: tier } };
	}

	// Same cycle: only a tier-raising reactivation re-notifies.
	if (previous.lastPushedTier === undefined) {
		return { push: true, reason: 'first_push', nextEntry: { groupKey, cycleIndex, lastPushedTier: tier } };
	}
	if (tierRank(tier) > tierRank(previous.lastPushedTier)) {
		return { push: true, reason: 'tier_raised', nextEntry: { groupKey, cycleIndex, lastPushedTier: tier } };
	}
	return { push: false, reason: previous.lastPushedTier === tier ? 'already_pushed' : 'not_raised', nextEntry: previous };
}
