/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AdmissionResult, canAdmit, dayKey, EMPTY_ADMISSION_STATE, IAdmissionSlot, IAdmissionState, IBudgetCaps, reserve, release } from '../../common/admissionControl.js';

const CAPS: IBudgetCaps = { repoConcurrency: 2, globalConcurrency: 3, dailyCredits: 4, workersPerTask: 2 };
const DAY = Date.UTC(2026, 0, 15, 12, 0, 0); // fixed "now"

function slot(taskId: string, attemptIndex = 0, repo = 'acme/api'): IAdmissionSlot {
	return { taskId, attemptIndex, repo };
}

/** Reserve a sequence of slots, asserting each is admitted, returning final state. */
function admitAll(state: IAdmissionState, slots: IAdmissionSlot[], now = DAY): IAdmissionState {
	for (const s of slots) {
		const r = reserve(state, CAPS, s, now);
		assert.strictEqual(r.result, AdmissionResult.Admitted, `expected admit for ${s.taskId}`);
		state = r.state;
	}
	return state;
}

suite('Inbox One - admission control', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reserve admits under caps and consumes a credit', () => {
		const { state, result } = reserve(EMPTY_ADMISSION_STATE, CAPS, slot('t1'), DAY);
		assert.strictEqual(result, AdmissionResult.Admitted);
		assert.strictEqual(state.slots.length, 1);
		assert.strictEqual(state.creditsUsed, 1);
		assert.strictEqual(state.creditDate, dayKey(DAY));
	});

	test('reserve is idempotent: the same slot does not double-count', () => {
		const first = reserve(EMPTY_ADMISSION_STATE, CAPS, slot('t1'), DAY);
		const second = reserve(first.state, CAPS, slot('t1'), DAY);
		assert.strictEqual(second.result, AdmissionResult.Admitted);
		assert.strictEqual(second.state.slots.length, 1);
		assert.strictEqual(second.state.creditsUsed, 1);
	});

	test('per-repo concurrency cap queues', () => {
		const state = admitAll(EMPTY_ADMISSION_STATE, [slot('t1'), slot('t2')]); // repo cap = 2
		const r = reserve(state, CAPS, slot('t3'), DAY);
		assert.strictEqual(r.result, AdmissionResult.QueuedRepoConcurrency);
		assert.strictEqual(r.state.slots.length, 2); // unchanged
	});

	test('global concurrency cap queues across repos', () => {
		// global cap = 3; repo cap = 2, so spread across repos to hit global first.
		let state = admitAll(EMPTY_ADMISSION_STATE, [slot('t1', 0, 'r1'), slot('t2', 0, 'r1'), slot('t3', 0, 'r2')]);
		const r = reserve(state, CAPS, slot('t4', 0, 'r2'), DAY);
		assert.strictEqual(r.result, AdmissionResult.QueuedGlobalConcurrency);
	});

	test('workers-per-task cap queues additional attempts of one task', () => {
		// Raise repo/global caps so the workers-per-task cap is what binds.
		const caps: IBudgetCaps = { ...CAPS, repoConcurrency: 5, globalConcurrency: 5, workersPerTask: 2 };
		let state = EMPTY_ADMISSION_STATE;
		for (const s of [slot('t1', 0), slot('t1', 1)]) {
			const r = reserve(state, caps, s, DAY);
			assert.strictEqual(r.result, AdmissionResult.Admitted);
			state = r.state;
		}
		const r = reserve(state, caps, slot('t1', 2), DAY);
		assert.strictEqual(r.result, AdmissionResult.QueuedWorkersPerTask);
	});

	test('daily credit cap queues once exhausted', () => {
		// dailyCredits = 4; use 4 across different repos/tasks staying under concurrency by releasing.
		let state = EMPTY_ADMISSION_STATE;
		for (let i = 0; i < 4; i++) {
			const r = reserve(state, CAPS, slot(`t${i}`, 0, `r${i}`), DAY);
			assert.strictEqual(r.result, AdmissionResult.Admitted);
			state = release(r.state, slot(`t${i}`, 0, `r${i}`)); // free concurrency, keep credits spent
		}
		assert.strictEqual(state.creditsUsed, 4);
		const r = reserve(state, CAPS, slot('t9', 0, 'r9'), DAY);
		assert.strictEqual(r.result, AdmissionResult.QueuedDailyCredits);
	});

	test('release frees a concurrency slot and is idempotent', () => {
		const { state } = reserve(EMPTY_ADMISSION_STATE, CAPS, slot('t1'), DAY);
		const afterRelease = release(state, slot('t1'));
		assert.strictEqual(afterRelease.slots.length, 0);
		// Credits are not refunded.
		assert.strictEqual(afterRelease.creditsUsed, 1);
		// Releasing again is a no-op.
		assert.strictEqual(release(afterRelease, slot('t1')).slots.length, 0);
	});

	test('credits reset on a new calendar day', () => {
		let state = admitAll(EMPTY_ADMISSION_STATE, [slot('t1', 0, 'r1')]);
		state = release(state, slot('t1', 0, 'r1'));
		assert.strictEqual(state.creditsUsed, 1);
		const nextDay = DAY + 24 * 60 * 60 * 1000;
		const r = reserve(state, CAPS, slot('t2', 0, 'r2'), nextDay);
		assert.strictEqual(r.result, AdmissionResult.Admitted);
		assert.strictEqual(r.state.creditDate, dayKey(nextDay));
		assert.strictEqual(r.state.creditsUsed, 1); // reset then +1
	});

	test('canAdmit matches reserve without mutating state', () => {
		const state = admitAll(EMPTY_ADMISSION_STATE, [slot('t1'), slot('t2')]); // repo cap reached
		const probe = canAdmit(state, CAPS, slot('t3'), DAY);
		assert.strictEqual(probe, AdmissionResult.QueuedRepoConcurrency);
		assert.strictEqual(state.slots.length, 2); // canAdmit did not mutate
	});

	test('an already-held slot is always admissible even at caps', () => {
		const state = admitAll(EMPTY_ADMISSION_STATE, [slot('t1'), slot('t2')]);
		assert.strictEqual(canAdmit(state, CAPS, slot('t1'), DAY), AdmissionResult.Admitted);
	});
});
