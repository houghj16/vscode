/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAutomationStorageService } from '../../automations/common/automationStorageService.js';
import { IInboxOneFileStore } from '../common/inboxOneFileStore.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { GestureKind, ILogicalTask, LogicalTaskState } from '../common/inboxOneTypes.js';
import { IExperienceRecord } from '../common/learningLoop.js';
import { DistillerSessionDispatcher } from './distillerSessionDispatcher.js';
import { LearningOrchestrator } from './learningOrchestrator.js';

/**
 * Runs the learning loop on every task resolution (design 6.4). Watches the live
 * task projection; when a task reaches a terminal state it captures an experience
 * record to the file-backed `/experience` store and runs the distiller (which
 * consolidates into the wiki + skill-impact, routed by gesture) then the curator.
 *
 * The distiller is idempotent by resolution id + a persisted watermark (G6), so a
 * reload never double-processes; the in-memory `processed` set avoids redundant
 * work within a session. The gesture is inferred from the terminal state:
 * Completed -> Accept, Archived("not my area") -> NotMyArea, else Dismiss.
 *
 * The deterministic consolidation (wiki log + skill-impact ledger) runs on the
 * host; the semantic authorship (write the lesson, propose the versioned skill
 * diff) is delegated to a stock distiller agent session via the
 * {@link DistillerSessionDispatcher} wired into `distillOne` -- real agent calls
 * when a host is connected, a graceful no-op otherwise.
 */
export class LearningOrchestratorService extends Disposable {

	declare readonly _serviceBrand: undefined;

	private readonly orchestrator: LearningOrchestrator;
	private readonly processed = new Set<string>();
	private readonly ready: Promise<void>;

	constructor(
		@IInboxOneStore private readonly store: IInboxOneStore,
		@IInboxOneFileStore private readonly fileStore: IInboxOneFileStore,
		@IAutomationStorageService storage: IAutomationStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const distiller = this._register(instantiationService.createInstance(DistillerSessionDispatcher));
		this.orchestrator = new LearningOrchestrator(fileStore, storage, logService, distiller.distill);
		this.ready = fileStore.initialize();
		this._register(autorun(reader => {
			const tasks = this.store.tasks.read(reader);
			this.onTasks(tasks).catch(err => this.logService.error('[inboxOne] learning loop failed', err));
		}));
	}

	private async onTasks(tasks: readonly ILogicalTask[]): Promise<void> {
		await this.ready;
		for (const task of tasks) {
			if (task.state !== LogicalTaskState.Completed && task.state !== LogicalTaskState.Archived) {
				continue;
			}
			const attemptIndex = task.attempts[task.currentAttempt]?.index ?? 0;
			const resolutionId = `${task.id}:${attemptIndex}`;
			if (this.processed.has(resolutionId)) {
				continue;
			}
			this.processed.add(resolutionId);
			await this.capture(task, resolutionId);
		}
	}

	private async capture(task: ILogicalTask, resolutionId: string): Promise<void> {
		const gesture = task.state === LogicalTaskState.Completed
			? GestureKind.Accept
			: task.archiveReason === 'not my area'
				? GestureKind.NotMyArea
				: GestureKind.Dismiss;

		const gestures = this.store.getGestures(task.id);
		const record: IExperienceRecord = {
			resolutionId,
			taskId: task.id,
			repo: task.repo,
			role: task.type,
			tier: task.tier,
			gesture: gestures[gestures.length - 1]?.kind ?? gesture,
			outcome: task.state === LogicalTaskState.Completed ? 'accepted' : (task.archiveReason ?? 'archived'),
			resolvedAt: Date.now(),
		};

		await this.fileStore.writeExperience(resolutionId, record);
		const result = await this.orchestrator.distill([record]);
		if (result.consumed.length > 0) {
			await this.orchestrator.curate();
			this.logService.info(`[inboxOne] learning: distilled ${resolutionId} (gesture=${record.gesture}, role=${record.role ?? 'n/a'})`);
		}
	}
}
