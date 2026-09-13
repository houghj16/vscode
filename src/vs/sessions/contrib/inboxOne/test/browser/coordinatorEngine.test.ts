/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AdmissionResult } from '../../common/admissionControl.js';
import { CoordinatorEngine, IAdmissionManager } from '../../common/coordinatorEngine.js';
import { IAutomationStorageCompareAndSwapResult, IAutomationStorageService } from '../../../automations/common/automationStorageService.js';
import { TriggerFamily } from '../../common/eventTaxonomy.js';
import { InboxOneStore } from '../../browser/inboxOneStore.js';
import { AutonomyLevel, IInboxOneSettings, INotificationPreferences, IRepoEnrollment } from '../../common/inboxOneSettings.js';
import { EventSource, IEventSubject, IIngressEvent, LogicalTaskState } from '../../common/inboxOneTypes.js';
import { DEFAULT_BUDGET_CAPS, IBudgetCaps } from '../../common/admissionControl.js';
import { IWorkerDispatcher, IWorkerDispatchRequest, IWorkerDispatchResult } from '../../common/workerDispatcher.js';

class InMemoryCasStorage implements IAutomationStorageService {
	declare readonly _serviceBrand: undefined;
	private readonly map = new Map<string, string>();
	async read(key: string): Promise<string | undefined> { return this.map.get(key); }
	async compareAndSwap(key: string, expected: string | undefined, next: string): Promise<IAutomationStorageCompareAndSwapResult> {
		const current = this.map.get(key);
		if (current === expected) { this.map.set(key, next); return { swapped: true, currentValue: next }; }
		return { swapped: false, currentValue: current };
	}
}

class FakeSettings implements IInboxOneSettings {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private readonly enrollments = new Map<string, IRepoEnrollment>();
	constructor(enrolled: IRepoEnrollment[] = []) { for (const e of enrolled) { this.enrollments.set(e.repo, e); } }
	async initialize(): Promise<void> { }
	listEnrollments(): readonly IRepoEnrollment[] { return [...this.enrollments.values()]; }
	getEnrollment(repo: string): IRepoEnrollment | undefined { return this.enrollments.get(repo); }
	async enrollRepo(e: IRepoEnrollment): Promise<void> { this.enrollments.set(e.repo, e); }
	async updateEnrollment(repo: string, patch: Partial<IRepoEnrollment>): Promise<void> { const cur = this.enrollments.get(repo); if (cur) { this.enrollments.set(repo, { ...cur, ...patch }); } }
	async removeEnrollment(repo: string): Promise<void> { this.enrollments.delete(repo); }
	isRepoEnrolled(repo: string): boolean { return this.enrollments.get(repo)?.active === true; }
	isTriggerEnabled(repo: string, family: TriggerFamily): boolean {
		const e = this.enrollments.get(repo);
		if (!e || !e.active) { return false; }
		return !e.enabledFamilies || e.enabledFamilies.includes(family);
	}
	getBudgetCaps(): IBudgetCaps { return DEFAULT_BUDGET_CAPS; }
	getAutonomy(): AutonomyLevel { return AutonomyLevel.SafeReversible; }
	getNotificationPreferences(): INotificationPreferences { return { pushCritical: true, pushUrgent: true, pushFyi: false }; }
	async setNotificationPreferences(): Promise<void> { }
	getDefaultAutonomy(): AutonomyLevel { return AutonomyLevel.SafeReversible; }
	async setDefaultAutonomy(): Promise<void> { }
	getDefaultBudgets(): IBudgetCaps { return DEFAULT_BUDGET_CAPS; }
	async setDefaultBudgets(): Promise<void> { }
}

class FakeAdmission implements IAdmissionManager {
	admit = true;
	reserved: string[] = [];
	released: string[] = [];
	async tryReserve(taskId: string, attemptIndex: number): Promise<AdmissionResult> {
		if (!this.admit) { return AdmissionResult.QueuedGlobalConcurrency; }
		this.reserved.push(`${taskId}:${attemptIndex}`);
		return AdmissionResult.Admitted;
	}
	canAdmit(): boolean { return this.admit; }
	async release(taskId: string, attemptIndex: number): Promise<void> { this.released.push(`${taskId}:${attemptIndex}`); }
}

class FakeDispatcher implements IWorkerDispatcher {
	dispatched: IWorkerDispatchRequest[] = [];
	relays: { sessionRef: string; message: string }[] = [];
	fail = false;
	async dispatch(request: IWorkerDispatchRequest): Promise<IWorkerDispatchResult> {
		if (this.fail) { throw new Error('dispatch failed'); }
		this.dispatched.push(request);
		return { sessionRef: `session://worker/${request.task.id}`, reused: false };
	}
	async relay(sessionRef: string, message: string): Promise<void> { this.relays.push({ sessionRef, message }); }
}

function prEvent(subject: Partial<IEventSubject> = {}): IIngressEvent {
	return { deliveryId: 'd1', source: EventSource.World, repo: 'acme/api', type: 'pull_request', action: 'opened', subject: { kind: 'pr', id: '842', ...subject }, receivedAt: 0 };
}

suite('Inbox One - coordinator engine', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function build(enrolled = true) {
		const store = disposables.add(new InboxOneStore(new InMemoryCasStorage()));
		const settings = new FakeSettings(enrolled ? [{ repo: 'acme/api', active: true }] : []);
		const admission = new FakeAdmission();
		const dispatcher = new FakeDispatcher();
		const engine = new CoordinatorEngine('my', store, settings, admission, dispatcher, new NullLogService());
		return { store, settings, admission, dispatcher, engine };
	}

	test('an enrolled PR event creates a Cooking task and dispatches a worker', async () => {
		const { store, dispatcher, engine } = build();
		await engine.handleEvent(prEvent());
		const tasks = store.tasks.get();
		assert.strictEqual(tasks.length, 1);
		assert.strictEqual(tasks[0].state, LogicalTaskState.Cooking);
		assert.strictEqual(tasks[0].groupKey, 'acme/api:pr:842');
		assert.strictEqual(dispatcher.dispatched.length, 1);
		assert.strictEqual(dispatcher.dispatched[0].role, 'code-review');
		assert.ok(tasks[0].attempts[0].sessionRef, 'session ref recorded on the attempt');
	});

	test('an unenrolled repo drops to the ledger and does not dispatch', async () => {
		const { store, dispatcher, engine } = build(false);
		await engine.handleEvent(prEvent());
		assert.strictEqual(store.tasks.get().length, 0);
		assert.strictEqual(dispatcher.dispatched.length, 0);
	});

	test('a duplicate event joins the existing task (no second dispatch, I1)', async () => {
		const { store, dispatcher, engine } = build();
		await engine.handleEvent(prEvent());
		await engine.handleEvent({ ...prEvent(), deliveryId: 'd2' });
		assert.strictEqual(store.tasks.get().length, 1);
		assert.strictEqual(dispatcher.dispatched.length, 1);
	});

	test('over-budget admission queues instead of dispatching', async () => {
		const { store, dispatcher, admission, engine } = build();
		admission.admit = false;
		await engine.handleEvent(prEvent());
		// The task is created (gate passed) but no worker was dispatched.
		assert.strictEqual(dispatcher.dispatched.length, 0);
		assert.ok(store.tasks.get().length <= 1);
	});

	test('a failed dispatch releases the admission slot and fails the attempt', async () => {
		const { store, dispatcher, admission, engine } = build();
		dispatcher.fail = true;
		await engine.handleEvent(prEvent());
		assert.strictEqual(admission.released.length, 1);
		const task = store.tasks.get()[0];
		assert.strictEqual(task.state, LogicalTaskState.Decision); // failed attempt -> Decision + Retry
	});

	test('a needs_input session event blocks the owning task', async () => {
		const { store, engine } = build();
		await engine.handleEvent(prEvent());
		const task = store.tasks.get()[0];
		const sessionRef = task.attempts[0].sessionRef!;
		const sessionId = sessionRef.replace('session://worker/', '');
		await engine.handleEvent({ deliveryId: 'se1', source: EventSource.Session, sessionId, type: 'needs_input', subject: { kind: 'session', id: sessionId }, receivedAt: 0 });
		assert.strictEqual(store.getTask(task.id)!.state, LogicalTaskState.Blocked);
	});

	test('a failed session event fails the owning attempt', async () => {
		const { store, engine } = build();
		await engine.handleEvent(prEvent());
		const task = store.tasks.get()[0];
		const sessionId = task.attempts[0].sessionRef!.replace('session://worker/', '');
		await engine.handleEvent({ deliveryId: 'se2', source: EventSource.Session, sessionId, type: 'failed', subject: { kind: 'session', id: sessionId }, receivedAt: 0 });
		assert.strictEqual(store.getTask(task.id)!.state, LogicalTaskState.Decision);
	});

	test('a session event for an unknown session is ignored', async () => {
		const { store, engine } = build();
		await engine.handleEvent({ deliveryId: 'se3', source: EventSource.Session, sessionId: 'ghost', type: 'failed', subject: { kind: 'session', id: 'ghost' }, receivedAt: 0 });
		assert.strictEqual(store.tasks.get().length, 0);
	});

	test('a disabled trigger family drops', async () => {
		const store = disposables.add(new InboxOneStore(new InMemoryCasStorage()));
		const settings = new FakeSettings([{ repo: 'acme/api', active: true, enabledFamilies: [TriggerFamily.Issues] }]);
		const dispatcher = new FakeDispatcher();
		const engine = new CoordinatorEngine('my', store, settings, new FakeAdmission(), dispatcher, new NullLogService());
		await engine.handleEvent(prEvent()); // PR family not enabled
		assert.strictEqual(dispatcher.dispatched.length, 0);
	});
});
