/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { evaluateGate, GateDecision, GateDropReason, IGateContext } from '../../common/dispatchGate.js';
import { classifyEvent, TriggerFamily, WorkerRole } from '../../common/eventTaxonomy.js';
import { EventSource, IEventSubject, IIngressEvent } from '../../common/inboxOneTypes.js';

function event(type: string, action: string | undefined, subject: IEventSubject, repo: string | undefined = 'acme/api', source = EventSource.World): IIngressEvent {
	return { deliveryId: 'd1', source, repo, type, action, subject, receivedAt: 0 };
}

function permissiveCtx(overrides: Partial<IGateContext> = {}): IGateContext {
	return {
		isRepoEnrolled: () => true,
		isTriggerEnabled: () => true,
		hasInflightForGroupKey: () => false,
		canAdmit: () => true,
		...overrides,
	};
}

function assertDrop(decision: GateDecision, reason: GateDropReason): void {
	assert.strictEqual(decision.dispatch, false);
	if (!decision.dispatch) {
		assert.strictEqual(decision.reason, reason);
	}
}

suite('Inbox One - event taxonomy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('PR work actions classify as code-review', () => {
		for (const action of ['opened', 'ready_for_review', 'review_requested', 'synchronize', 'reopened']) {
			const c = classifyEvent(event('pull_request', action, { kind: 'pr', id: '842' }));
			assert.ok(c, `expected classification for pull_request/${action}`);
			assert.strictEqual(c!.role, WorkerRole.CodeReview);
			assert.strictEqual(c!.family, TriggerFamily.PullRequests);
		}
	});

	test('non-work PR actions do not classify', () => {
		assert.strictEqual(classifyEvent(event('pull_request', 'assigned', { kind: 'pr', id: '1' })), undefined);
		assert.strictEqual(classifyEvent(event('pull_request', 'closed', { kind: 'pr', id: '1' })), undefined);
	});

	test('issue work actions classify as issue-triage', () => {
		const c = classifyEvent(event('issues', 'opened', { kind: 'issue', id: '901' }));
		assert.strictEqual(c!.role, WorkerRole.IssueTriage);
		assert.strictEqual(c!.family, TriggerFamily.Issues);
	});

	test('only failed checks classify as implement-fix', () => {
		assert.strictEqual(classifyEvent(event('check_run', 'failed', { kind: 'check', id: 'r' }))!.role, WorkerRole.ImplementFix);
		assert.strictEqual(classifyEvent(event('check_run', 'completed', { kind: 'check', id: 'r' })), undefined);
		assert.strictEqual(classifyEvent(event('workflow_run', 'failure', { kind: 'check', id: 'r' }))!.role, WorkerRole.ImplementFix);
	});

	test('security alerts classify with the security family', () => {
		const c = classifyEvent(event('code_scanning_alert', 'created', { kind: 'security', id: 'CVE-1' }));
		assert.strictEqual(c!.family, TriggerFamily.Security);
		assert.strictEqual(c!.role, WorkerRole.ImplementFix);
	});

	test('unknown event types do not classify', () => {
		assert.strictEqual(classifyEvent(event('star', 'created', { kind: 'pr', id: '1' })), undefined);
	});
});

suite('Inbox One - dispatch gate', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const prEvent = () => event('pull_request', 'opened', { kind: 'pr', id: '842' });

	test('all checks pass -> dispatch with the classified role', () => {
		const d = evaluateGate(prEvent(), 'acme/api:pr:842', permissiveCtx());
		assert.strictEqual(d.dispatch, true);
		if (d.dispatch) {
			assert.strictEqual(d.role, WorkerRole.CodeReview);
			assert.strictEqual(d.groupKey, 'acme/api:pr:842');
			assert.strictEqual(d.subjectKind, 'pr');
		}
	});

	test('session events are not gated here (routed to reactivation)', () => {
		const e = event('task_finished', undefined, { kind: 'session', id: 's1' }, undefined, EventSource.Session);
		assertDrop(evaluateGate(e, 'session:s1', permissiveCtx()), GateDropReason.SessionEvent);
	});

	test('no value: unclassifiable event drops', () => {
		assertDrop(evaluateGate(event('star', 'created', { kind: 'pr', id: '1' }), 'acme/api:pr:1', permissiveCtx()), GateDropReason.NoValue);
	});

	test('non-work action drops as no value', () => {
		assertDrop(evaluateGate(event('pull_request', 'assigned', { kind: 'pr', id: '1' }), 'acme/api:pr:1', permissiveCtx()), GateDropReason.NoValue);
	});

	test('mandate: unenrolled repo drops', () => {
		assertDrop(evaluateGate(prEvent(), 'acme/api:pr:842', permissiveCtx({ isRepoEnrolled: () => false })), GateDropReason.OutsideMandate);
	});

	test('mandate: disabled trigger drops', () => {
		assertDrop(evaluateGate(prEvent(), 'acme/api:pr:842', permissiveCtx({ isTriggerEnabled: () => false })), GateDropReason.OutsideMandate);
	});

	test('mandate: missing group_key drops', () => {
		assertDrop(evaluateGate(prEvent(), undefined, permissiveCtx()), GateDropReason.OutsideMandate);
	});

	test('non-redundant: an in-flight task for the group_key drops (I1)', () => {
		assertDrop(evaluateGate(prEvent(), 'acme/api:pr:842', permissiveCtx({ hasInflightForGroupKey: () => true })), GateDropReason.Redundant);
	});

	test('budget: over-budget queues rather than drops', () => {
		const d = evaluateGate(prEvent(), 'acme/api:pr:842', permissiveCtx({ canAdmit: () => false }));
		assert.strictEqual(d.dispatch, false);
		if (!d.dispatch) {
			assert.strictEqual(d.disposition, 'queue');
			assert.strictEqual(d.reason, GateDropReason.OverBudget);
		}
	});

	test('checks are ordered: mandate is evaluated before redundancy/budget', () => {
		// Unenrolled + in-flight + over budget: mandate wins (checked first of the three).
		assertDrop(
			evaluateGate(prEvent(), 'acme/api:pr:842', permissiveCtx({ isRepoEnrolled: () => false, hasInflightForGroupKey: () => true, canAdmit: () => false })),
			GateDropReason.OutsideMandate
		);
	});
});
