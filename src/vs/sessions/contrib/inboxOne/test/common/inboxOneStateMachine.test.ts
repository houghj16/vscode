/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { canTransition, getTransition, isCookingState, isDecisionState, isResolvedState, TaskTrigger } from '../../common/inboxOneStateMachine.js';
import { LogicalTaskState } from '../../common/inboxOneTypes.js';

suite('Inbox One - state machine', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	interface Case {
		from: LogicalTaskState;
		trigger: TaskTrigger;
		to: LogicalTaskState;
		newAttempt: boolean;
		terminal?: boolean;
	}

	const legal: Case[] = [
		// cooking
		{ from: LogicalTaskState.Cooking, trigger: TaskTrigger.EvidenceAssembled, to: LogicalTaskState.Decision, newAttempt: false },
		{ from: LogicalTaskState.Cooking, trigger: TaskTrigger.Blocker, to: LogicalTaskState.Blocked, newAttempt: false },
		{ from: LogicalTaskState.Cooking, trigger: TaskTrigger.AttemptFailed, to: LogicalTaskState.Decision, newAttempt: false },
		{ from: LogicalTaskState.Cooking, trigger: TaskTrigger.AutoAccept, to: LogicalTaskState.Confirming, newAttempt: false },
		{ from: LogicalTaskState.Cooking, trigger: TaskTrigger.CancelWork, to: LogicalTaskState.Archived, newAttempt: false },
		// decision
		{ from: LogicalTaskState.Decision, trigger: TaskTrigger.Steer, to: LogicalTaskState.Cooking, newAttempt: true },
		{ from: LogicalTaskState.Decision, trigger: TaskTrigger.Retry, to: LogicalTaskState.Cooking, newAttempt: true },
		{ from: LogicalTaskState.Decision, trigger: TaskTrigger.MaterialChange, to: LogicalTaskState.Cooking, newAttempt: true },
		{ from: LogicalTaskState.Decision, trigger: TaskTrigger.Accept, to: LogicalTaskState.Confirming, newAttempt: false },
		{ from: LogicalTaskState.Decision, trigger: TaskTrigger.Dismiss, to: LogicalTaskState.Archived, newAttempt: false },
		// blocked
		{ from: LogicalTaskState.Blocked, trigger: TaskTrigger.RecoverySupplied, to: LogicalTaskState.Cooking, newAttempt: true },
		{ from: LogicalTaskState.Blocked, trigger: TaskTrigger.Steer, to: LogicalTaskState.Cooking, newAttempt: true },
		{ from: LogicalTaskState.Blocked, trigger: TaskTrigger.Dismiss, to: LogicalTaskState.Archived, newAttempt: false },
		// confirming
		{ from: LogicalTaskState.Confirming, trigger: TaskTrigger.ConfirmSucceeded, to: LogicalTaskState.Completed, newAttempt: false },
		{ from: LogicalTaskState.Confirming, trigger: TaskTrigger.ConfirmFailed, to: LogicalTaskState.Decision, newAttempt: false },
		// completed
		{ from: LogicalTaskState.Completed, trigger: TaskTrigger.Reopen, to: LogicalTaskState.Cooking, newAttempt: true },
		{ from: LogicalTaskState.Completed, trigger: TaskTrigger.MaterialChange, to: LogicalTaskState.Cooking, newAttempt: true },
		// archived
		{ from: LogicalTaskState.Archived, trigger: TaskTrigger.Restore, to: LogicalTaskState.Decision, newAttempt: false },
		{ from: LogicalTaskState.Archived, trigger: TaskTrigger.Delete, to: LogicalTaskState.Archived, newAttempt: false, terminal: true },
	];

	for (const c of legal) {
		test(`${c.from} --${c.trigger}--> ${c.to}`, () => {
			const t = getTransition(c.from, c.trigger);
			assert.ok(t, `expected legal transition ${c.from}/${c.trigger}`);
			assert.strictEqual(t!.to, c.to);
			assert.strictEqual(t!.opensNewAttempt, c.newAttempt);
			assert.strictEqual(!!t!.terminal, !!c.terminal);
		});
	}

	test('illegal transitions are rejected', () => {
		// Accept is only valid from a decision, never from cooking.
		assert.strictEqual(canTransition(LogicalTaskState.Cooking, TaskTrigger.Accept), false);
		// You cannot dismiss a completed task (archive it instead), nor delete a live one.
		assert.strictEqual(canTransition(LogicalTaskState.Completed, TaskTrigger.Dismiss), false);
		assert.strictEqual(canTransition(LogicalTaskState.Cooking, TaskTrigger.Delete), false);
		// Confirming cannot be steered or dismissed mid-flight.
		assert.strictEqual(canTransition(LogicalTaskState.Confirming, TaskTrigger.Steer), false);
		assert.strictEqual(canTransition(LogicalTaskState.Confirming, TaskTrigger.Dismiss), false);
		// Evidence cannot be assembled onto an archived task.
		assert.strictEqual(canTransition(LogicalTaskState.Archived, TaskTrigger.EvidenceAssembled), false);
	});

	test('every legal transition targets a known state', () => {
		const knownStates = new Set<string>([
			LogicalTaskState.Cooking,
			LogicalTaskState.Decision,
			LogicalTaskState.Blocked,
			LogicalTaskState.Confirming,
			LogicalTaskState.Completed,
			LogicalTaskState.Archived,
		]);
		for (const c of legal) {
			const t = getTransition(c.from, c.trigger)!;
			assert.ok(knownStates.has(t.to), `unknown target state ${t.to}`);
		}
	});

	test('state predicates classify sections correctly', () => {
		assert.ok(isCookingState(LogicalTaskState.Cooking));
		assert.ok(isCookingState(LogicalTaskState.Confirming));
		assert.ok(!isCookingState(LogicalTaskState.Decision));

		assert.ok(isDecisionState(LogicalTaskState.Decision));
		assert.ok(isDecisionState(LogicalTaskState.Blocked));
		assert.ok(!isDecisionState(LogicalTaskState.Completed));

		assert.ok(isResolvedState(LogicalTaskState.Completed));
		assert.ok(isResolvedState(LogicalTaskState.Archived));
		assert.ok(!isResolvedState(LogicalTaskState.Cooking));
	});
});
