/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { classifyEvent, WorkerRole } from './eventTaxonomy.js';
import { GroupKey, IEventSubject, IIngressEvent } from './inboxOneTypes.js';

/**
 * The deterministic dispatch gate (design 4, technical spec 4). Host logic runs
 * BEFORE any model judgement. Dispatch only when ALL five checks hold:
 *
 *   1. Value       - a concrete action/answer is producible (not "an event occurred").
 *   2. Actionable  - there is a clear decision the human could take on the result.
 *   3. Mandate     - enrolled repo + enabled trigger + standing policy.
 *   4. Non-redundant - deduped against in-flight work by group_key.
 *   5. Budget      - within concurrency + credit caps, else queued.
 *
 * The gate is the ONLY filter (I4). Once a worker runs, its result always lands;
 * the gate decides only whether to spend compute at all.
 */

export const enum GateDropReason {
	NoValue = 'no_value',
	NotActionable = 'not_actionable',
	OutsideMandate = 'outside_mandate',
	Redundant = 'redundant',
	OverBudget = 'over_budget',
	SessionEvent = 'session_event',
}

export type GateDisposition = 'drop' | 'queue';

export interface IGateDispatch {
	readonly dispatch: true;
	readonly role: WorkerRole;
	readonly groupKey: GroupKey;
	readonly subjectKind: IEventSubject['kind'];
}

export interface IGateReject {
	readonly dispatch: false;
	/** `drop` records to the ledger and stops; `queue` retries when budget frees. */
	readonly disposition: GateDisposition;
	readonly reason: GateDropReason;
}

export type GateDecision = IGateDispatch | IGateReject;

/**
 * The gate queries this context for the checks it cannot compute from the event
 * alone. Keeping it abstract makes the gate a pure, exhaustively testable
 * function independent of the store, settings, and admission services.
 */
export interface IGateContext {
	/** Mandate: the repo is enrolled and active. */
	isRepoEnrolled(repo: string): boolean;
	/** Mandate: the trigger (event type + action) is enabled in Settings. */
	isTriggerEnabled(type: string, action: string | undefined): boolean;
	/** Non-redundancy: an attempt for this group_key is already in flight. */
	hasInflightForGroupKey(groupKey: GroupKey): boolean;
	/** Budget: an admission slot is available (per-repo/global concurrency + credits). */
	canAdmit(repo: string | undefined): boolean;
}

const reject = (disposition: GateDisposition, reason: GateDropReason): IGateReject => ({ dispatch: false, disposition, reason });

/**
 * Evaluates the dispatch gate for one world event. Agent-session events are not
 * gated here -- the coordinator routes them to reactivation of their owning task.
 */
export function evaluateGate(event: IIngressEvent, groupKey: GroupKey | undefined, ctx: IGateContext): GateDecision {
	// Session lifecycle events reactivate an existing task; they never mint new
	// dispatch decisions here (gotcha G15).
	if (event.source === 'session') {
		return reject('drop', GateDropReason.SessionEvent);
	}

	// 1 + 2. Value and actionable: can this event produce a decision-ready result?
	const classification = classifyEvent(event);
	if (!classification) {
		return reject('drop', GateDropReason.NoValue);
	}
	if (!classification.actionable) {
		return reject('drop', GateDropReason.NotActionable);
	}

	// 3. Mandate: enrolled repo + enabled trigger.
	if (!event.repo || !groupKey) {
		return reject('drop', GateDropReason.OutsideMandate);
	}
	if (!ctx.isRepoEnrolled(event.repo) || !ctx.isTriggerEnabled(event.type, event.action)) {
		return reject('drop', GateDropReason.OutsideMandate);
	}

	// 4. Non-redundant: a duplicate/later event joins the existing task instead of
	// dispatching a second worker (I1).
	if (ctx.hasInflightForGroupKey(groupKey)) {
		return reject('drop', GateDropReason.Redundant);
	}

	// 5. Budget: over-budget work queues for an idle window rather than dropping.
	if (!ctx.canAdmit(event.repo)) {
		return reject('queue', GateDropReason.OverBudget);
	}

	return { dispatch: true, role: classification.role, groupKey, subjectKind: classification.subjectKind };
}
