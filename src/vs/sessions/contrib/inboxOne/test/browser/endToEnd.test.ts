/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IAutomationStorageCompareAndSwapResult, IAutomationStorageService } from '../../../automations/common/automationStorageService.js';
import { InboxOneStore } from '../../browser/inboxOneStore.js';
import { InboxOneSettingsService } from '../../browser/inboxOneSettingsService.js';
import { InboxOneFileStore } from '../../browser/inboxOneFileStore.js';
import { LiveAdmissionManager } from '../../browser/liveAdmissionManager.js';
import { LearningOrchestrator } from '../../browser/learningOrchestrator.js';
import { StubWorkerDispatcher } from '../../browser/stubWorkerDispatcher.js';
import { CoordinatorEngine } from '../../common/coordinatorEngine.js';
import { validateAction } from '../../common/actionCatalog.js';
import { validateWorkerResult } from '../../common/emitResult.js';
import { rank } from '../../common/ranking.js';
import { TaskTrigger } from '../../common/inboxOneStateMachine.js';
import { ActionType, EventSource, EvidenceRung, GestureKind, IIngressEvent, InboxOneTier, LogicalTaskState } from '../../common/inboxOneTypes.js';

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

const FS_ROOT = URI.from({ scheme: Schemas.inMemory, path: '/inbox-one-e2e' });

function prEvent(): IIngressEvent {
	return { deliveryId: 'gh-1', source: EventSource.World, repo: 'acme/api', type: 'pull_request', action: 'opened', subject: { kind: 'pr', id: '842' }, receivedAt: 0 };
}

function issueEvent(): IIngressEvent {
	return { deliveryId: 'gh-issue-1', source: EventSource.World, repo: 'acme/api', type: 'issues', action: 'opened', subject: { kind: 'issue', id: '17' }, receivedAt: 0 };
}

function checkEvent(attachedTo: { kind: 'pr' | 'branch'; id: string }, deliveryId: string): IIngressEvent {
	return { deliveryId, source: EventSource.World, repo: 'acme/api', type: 'check_run', action: 'failed', subject: { kind: 'check', id: deliveryId, attachedTo }, receivedAt: 0 };
}

/**
 * End-to-end scenario across the real components (coordinator, store, settings,
 * admission, file store, learning), with fakes only at the session boundary.
 * This is the logic-level proof of the whole spine: ambient event -> gate ->
 * dispatch -> evidence -> rank -> accept -> execute -> learn.
 */
suite('Inbox One - end-to-end scenario', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function buildSystem() {
		const casStore = new InMemoryCasStorage();
		const store = disposables.add(new InboxOneStore(casStore));
		const settings = disposables.add(new InboxOneSettingsService(new InMemoryCasStorage()));
		await settings.initialize();
		const admission = new LiveAdmissionManager(store, settings, new InMemoryCasStorage());
		const dispatcher = new StubWorkerDispatcher(new NullLogService());
		const engine = new CoordinatorEngine('my', store, settings, admission, dispatcher, new NullLogService());

		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		const fileStore = disposables.add(new InboxOneFileStore(FS_ROOT, fileService, new NullLogService()));
		await fileStore.initialize();
		const learning = new LearningOrchestrator(fileStore, new InMemoryCasStorage(), new NullLogService());

		return { store, settings, engine, fileStore, learning };
	}

	test('code-review scenario: PR event -> task -> evidence -> approve -> complete -> learn', async () => {
		const { store, settings, engine, fileStore, learning } = await buildSystem();

		// 1. Enroll the repo and fire a PR event.
		await settings.enrollRepo({ repo: 'acme/api', active: true });
		await engine.handleEvent(prEvent());

		const tasks = store.tasks.get();
		assert.strictEqual(tasks.length, 1, 'a task was created');
		const task = tasks[0];
		assert.strictEqual(task.state, LogicalTaskState.Cooking);
		assert.strictEqual(task.type, 'code-review');

		// 2. The worker emits a result; the host validates it into an evidence pack.
		const workerResult = validateWorkerResult({
			decisionSentence: 'PR #842 is ready to approve',
			claims: [
				{ text: '47/47 checks pass', receiptLink: 'https://run/1', rung: EvidenceRung.SingleRun },
				{ text: 'change limited to the retry path', receiptLink: 'https://diff/1', rung: EvidenceRung.SourceLineage },
			],
			gapLine: 'behavior under production load not verified',
			actionType: ActionType.ApprovePr,
			payload: { repo: 'acme/api', prNumber: 842 },
			label: 'Approve PR',
		});
		assert.strictEqual(workerResult.ok, true);
		if (!workerResult.ok) { return; }
		await store.setEvidence(task.id, workerResult.evidence);

		// 3. Host ranks the result and lands it as a Decision in a tier.
		const ranked = rank({ blocksPeople: 2, evidenceConfidence: 0.9, recipientAffinity: 0.8, urgency: 0.6 });
		assert.strictEqual(ranked.tier, InboxOneTier.Urgent);
		const landed = await store.transition(task.id, TaskTrigger.EvidenceAssembled, { tier: ranked.tier, rank: ranked.rank, rankReason: ranked.reason });
		assert.strictEqual(landed.task!.state, LogicalTaskState.Decision);
		assert.strictEqual(landed.task!.tier, InboxOneTier.Urgent);
		assert.ok(landed.task!.rankReason!.toLowerCase().includes('blocks 2 people'));

		// 4. The human accepts. The proposed action re-validates against the catalog.
		const action = landed.task!.evidence!.primaryAction!;
		assert.strictEqual(validateAction(action.actionType, action.payload).valid, true);
		const accepted = await store.transition(task.id, TaskTrigger.Accept, undefined, { expected: { evidenceRevision: 0 } });
		assert.strictEqual(accepted.task!.state, LogicalTaskState.Confirming);

		// 5. The external effect confirms -> Completed.
		const completed = await store.transition(task.id, TaskTrigger.ConfirmSucceeded);
		assert.strictEqual(completed.task!.state, LogicalTaskState.Completed);

		// 6. Record the resolution and run the distiller: the loop closes.
		await store.recordGesture({ taskId: task.id, kind: GestureKind.Accept, timestamp: 1 });
		const distilled = await learning.distill([{ resolutionId: `${task.id}:0`, taskId: task.id, role: 'behavioral-delta', gesture: GestureKind.Accept, resolvedAt: 1 }]);
		assert.strictEqual(distilled.consumed.length, 1);
		const impact = await fileStore.readSkillImpact();
		assert.ok(impact.includes('behavioral-delta'), 'skill-impact updated');
		const log = await fileStore.readWikiLog();
		assert.ok(log.includes('gesture=accept'), 'wiki log captured the resolution');
	});

	test('steer scenario: a decision is steered back to Cooking, prior evidence historical', async () => {
		const { store, settings, engine } = await buildSystem();
		await settings.enrollRepo({ repo: 'acme/api', active: true });
		await engine.handleEvent(prEvent());
		const task = store.tasks.get()[0];

		await store.setEvidence(task.id, { decisionSentence: 'ready', claims: [{ text: 'x', rung: EvidenceRung.SingleRun }], gapLine: 'gap', freshness: { computedAt: 1 } });
		await store.transition(task.id, TaskTrigger.EvidenceAssembled, { tier: InboxOneTier.Urgent });

		// Steer through the fenced handoff.
		const steered = await store.openContinuation(task.id, TaskTrigger.Steer, 'steer-1');
		assert.strictEqual(steered.task!.state, LogicalTaskState.Cooking);
		assert.strictEqual(steered.task!.attempts.length, 2);
		assert.strictEqual(steered.task!.evidence!.historical, true);

		// A double-send of the same steer is fenced (no third attempt).
		const dup = await store.openContinuation(task.id, TaskTrigger.Steer, 'steer-1');
		assert.strictEqual(dup.fencedNoop, true);
		assert.strictEqual(store.getTask(task.id)!.attempts.length, 2);
	});

	test('dismiss scenario: a decision is archived and preserved (not deleted)', async () => {
		const { store, settings, engine } = await buildSystem();
		await settings.enrollRepo({ repo: 'acme/api', active: true });
		await engine.handleEvent(prEvent());
		const task = store.tasks.get()[0];
		await store.transition(task.id, TaskTrigger.EvidenceAssembled, { tier: InboxOneTier.Fyi });
		const dismissed = await store.transition(task.id, TaskTrigger.Dismiss, { archiveReason: 'not reachable, low value' });
		assert.strictEqual(dismissed.task!.state, LogicalTaskState.Archived);
		// Still present (session preserved); can be restored.
		const restored = await store.transition(task.id, TaskTrigger.Restore);
		assert.strictEqual(restored.task!.state, LogicalTaskState.Decision);
	});

	test('issue-triage scenario: issue event -> task -> grouped meta-issues -> complete', async () => {
		const { store, settings, engine } = await buildSystem();
		await settings.enrollRepo({ repo: 'acme/api', active: true });
		await engine.handleEvent(issueEvent());

		const task = store.tasks.get()[0];
		assert.strictEqual(task.type, 'issue-triage', 'an issue dispatches the issue-triage role');
		assert.strictEqual(task.state, LogicalTaskState.Cooking);

		const result = validateWorkerResult({
			decisionSentence: '5 new issues cluster into 2 themes',
			claims: [
				{ text: '3 issues describe the same OAuth timeout', receiptLink: 'https://issues/1', rung: EvidenceRung.SourceLineage },
				{ text: '2 issues are duplicate crash reports', receiptLink: 'https://issues/2', rung: EvidenceRung.SingleRun },
			],
			gapLine: 'severity of the OAuth cluster not yet triaged',
			actionType: ActionType.CreateIssues,
			payload: { repo: 'acme/api', issues: [{ title: 'OAuth timeout meta-issue', body: 'Groups #17, #18, #19' }] },
			label: 'Create issues',
		});
		assert.strictEqual(result.ok, true);
		if (!result.ok) { return; }
		await store.setEvidence(task.id, result.evidence);
		const landed = await store.transition(task.id, TaskTrigger.EvidenceAssembled, { tier: InboxOneTier.Fyi });
		assert.strictEqual(landed.task!.state, LogicalTaskState.Decision);
		// The proposed CreateIssues action validates against the catalog.
		const action = landed.task!.evidence!.primaryAction!;
		assert.strictEqual(validateAction(action.actionType, action.payload).valid, true);

		const accepted = await store.transition(task.id, TaskTrigger.Accept, undefined, { expected: { evidenceRevision: 0 } });
		assert.strictEqual(accepted.task!.state, LogicalTaskState.Confirming);
		const completed = await store.transition(task.id, TaskTrigger.ConfirmSucceeded);
		assert.strictEqual(completed.task!.state, LogicalTaskState.Completed);
	});

	test('implement-fix scenario: failed check -> task -> fix ready -> complete', async () => {
		const { store, settings, engine } = await buildSystem();
		await settings.enrollRepo({ repo: 'acme/api', active: true });
		// A failed check on a branch (no PR) is its own dispatchable fix task.
		await engine.handleEvent(checkEvent({ kind: 'branch', id: 'main' }, 'chk-1'));

		const task = store.tasks.get()[0];
		assert.strictEqual(task.type, 'implement-fix', 'a failed check dispatches the implement-fix role');

		const result = validateWorkerResult({
			decisionSentence: 'The flaky retry test is fixed',
			claims: [
				{ text: 'reproduced the failure 5/5 then 0/20 after the fix', receiptLink: 'https://run/9', rung: EvidenceRung.ReproducibleTest },
			],
			gapLine: 'not run under the full matrix',
			actionType: ActionType.MergePr,
			payload: { repo: 'acme/api', prNumber: 991, base: 'main', strategy: 'squash' },
			label: 'Merge fix',
		});
		assert.strictEqual(result.ok, true);
		if (!result.ok) { return; }
		await store.setEvidence(task.id, result.evidence);
		const landed = await store.transition(task.id, TaskTrigger.EvidenceAssembled, { tier: InboxOneTier.Urgent });
		assert.strictEqual(landed.task!.state, LogicalTaskState.Decision);
		const completed = await store.transition(task.id, TaskTrigger.Accept, undefined, { expected: { evidenceRevision: 0 } })
			.then(() => store.transition(task.id, TaskTrigger.ConfirmSucceeded));
		assert.strictEqual(completed.task!.state, LogicalTaskState.Completed);
	});

	test('cross-role finale: a failed check on an open PR joins the code-review task (I1/G2), no second card', async () => {
		const { store, settings, engine } = await buildSystem();
		await settings.enrollRepo({ repo: 'acme/api', active: true });

		// Code-review work starts on PR #842.
		await engine.handleEvent(prEvent());
		assert.strictEqual(store.tasks.get().length, 1);
		const prTask = store.tasks.get()[0];
		assert.strictEqual(prTask.type, 'code-review');

		// A CI failure lands on the same PR while review work is in flight. It must
		// attach to the PR's task by group_key -- not mint a second implement-fix
		// card -- and must not dispatch a redundant second worker.
		await engine.handleEvent(checkEvent({ kind: 'pr', id: '842' }, 'chk-2'));

		const tasks = store.tasks.get();
		assert.strictEqual(tasks.length, 1, 'the CI failure joined the PR task; one card, not two');
		assert.strictEqual(tasks[0].id, prTask.id, 'same LogicalTask owns both roles');
		assert.strictEqual(tasks[0].groupKey, prTask.groupKey);
	});
});
