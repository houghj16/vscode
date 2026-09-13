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
});
