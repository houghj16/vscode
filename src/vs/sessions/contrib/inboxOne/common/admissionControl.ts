/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Admission control (design 7.4, technical spec 11). Enforced in the dispatch
 * gate: per-repo concurrency, global concurrency, daily credit cap, and
 * workers-per-task. Each dispatch reserves exactly one admission slot
 * (idempotent); slots release on resolve/cancel/fail. Over-budget dispatches
 * queue for an idle window. This is what makes N-repo scale safe by construction.
 *
 * This module is the pure, exhaustively-testable core. The service wrapper
 * persists {@link IAdmissionState} through the same CAS storage as the task
 * ledger so reservations survive restart and are safe under concurrency.
 */

export interface IBudgetCaps {
	/** Max concurrent attempts for a single repo. */
	readonly repoConcurrency: number;
	/** Max concurrent attempts across all repos. */
	readonly globalConcurrency: number;
	/** Max dispatches admitted per calendar day (credits). */
	readonly dailyCredits: number;
	/** Max concurrent attempts for a single task. */
	readonly workersPerTask: number;
}

export const DEFAULT_BUDGET_CAPS: IBudgetCaps = {
	repoConcurrency: 4,
	globalConcurrency: 20,
	dailyCredits: 40,
	workersPerTask: 3,
};

export interface IAdmissionSlot {
	readonly taskId: string;
	readonly attemptIndex: number;
	readonly repo?: string;
}

export interface IAdmissionState {
	readonly slots: readonly IAdmissionSlot[];
	/** Local calendar day (YYYY-MM-DD) the credit counter belongs to. */
	readonly creditDate: string;
	readonly creditsUsed: number;
}

export const EMPTY_ADMISSION_STATE: IAdmissionState = { slots: [], creditDate: '', creditsUsed: 0 };

export const enum AdmissionResult {
	Admitted = 'admitted',
	QueuedRepoConcurrency = 'queued_repo_concurrency',
	QueuedGlobalConcurrency = 'queued_global_concurrency',
	QueuedWorkersPerTask = 'queued_workers_per_task',
	QueuedDailyCredits = 'queued_daily_credits',
}

export function isAdmitted(result: AdmissionResult): boolean {
	return result === AdmissionResult.Admitted;
}

/** Local calendar day key for the given epoch millis. */
export function dayKey(nowMs: number): string {
	return new Date(nowMs).toISOString().slice(0, 10);
}

function sameSlot(a: IAdmissionSlot, b: IAdmissionSlot): boolean {
	return a.taskId === b.taskId && a.attemptIndex === b.attemptIndex;
}

/** Rolls the credit counter over when the day changed. */
function normalizeDay(state: IAdmissionState, today: string): IAdmissionState {
	return state.creditDate === today ? state : { ...state, creditDate: today, creditsUsed: 0 };
}

/**
 * Whether a slot could be admitted right now, without reserving. Used by the
 * gate's budget check. An already-held slot is always admissible (idempotent).
 */
export function canAdmit(state: IAdmissionState, caps: IBudgetCaps, slot: IAdmissionSlot, nowMs: number): AdmissionResult {
	const today = dayKey(nowMs);
	const normalized = normalizeDay(state, today);

	// Already reserved -> idempotently admissible; no new checks apply.
	if (normalized.slots.some(s => sameSlot(s, slot))) {
		return AdmissionResult.Admitted;
	}
	if (normalized.slots.length >= caps.globalConcurrency) {
		return AdmissionResult.QueuedGlobalConcurrency;
	}
	if (slot.repo && normalized.slots.filter(s => s.repo === slot.repo).length >= caps.repoConcurrency) {
		return AdmissionResult.QueuedRepoConcurrency;
	}
	if (normalized.slots.filter(s => s.taskId === slot.taskId).length >= caps.workersPerTask) {
		return AdmissionResult.QueuedWorkersPerTask;
	}
	if (normalized.creditsUsed >= caps.dailyCredits) {
		return AdmissionResult.QueuedDailyCredits;
	}
	return AdmissionResult.Admitted;
}

/**
 * Attempts to reserve one slot. Idempotent: reserving an already-held slot
 * returns the same state and consumes no additional credit. Returns the next
 * state and the result; when queued, the state is unchanged (day-normalized).
 */
export function reserve(state: IAdmissionState, caps: IBudgetCaps, slot: IAdmissionSlot, nowMs: number): { state: IAdmissionState; result: AdmissionResult } {
	const today = dayKey(nowMs);
	const normalized = normalizeDay(state, today);

	if (normalized.slots.some(s => sameSlot(s, slot))) {
		return { state: normalized, result: AdmissionResult.Admitted };
	}
	const result = canAdmit(normalized, caps, slot, nowMs);
	if (result !== AdmissionResult.Admitted) {
		return { state: normalized, result };
	}
	const next: IAdmissionState = {
		...normalized,
		slots: [...normalized.slots, slot],
		creditsUsed: normalized.creditsUsed + 1,
	};
	return { state: next, result: AdmissionResult.Admitted };
}

/** Releases a slot on resolve/cancel/fail. Idempotent; does not refund credits. */
export function release(state: IAdmissionState, slot: IAdmissionSlot): IAdmissionState {
	if (!state.slots.some(s => sameSlot(s, slot))) {
		return state;
	}
	return { ...state, slots: state.slots.filter(s => !sameSlot(s, slot)) };
}

/** Count of active slots for a repo (for observability / gate reasons). */
export function activeForRepo(state: IAdmissionState, repo: string): number {
	return state.slots.filter(s => s.repo === repo).length;
}
