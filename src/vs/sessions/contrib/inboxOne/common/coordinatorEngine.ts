/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { AdmissionResult, isAdmitted } from './admissionControl.js';
import { evaluateGate, IGateContext } from './dispatchGate.js';
import { validateWorkerResult } from './emitResult.js';
import { triggerFamilyFor, WorkerRole } from './eventTaxonomy.js';
import { deriveGroupKey } from './groupKey.js';
import { currentAttempt, IInboxOneStore } from './inboxOneStore.js';
import { AutonomyLevel, IInboxOneSettings } from './inboxOneSettings.js';
import { AttemptTrigger, EventSource, GroupKey, IIngressEvent, ILogicalTask, LogicalTaskState } from './inboxOneTypes.js';
import { TaskTrigger } from './inboxOneStateMachine.js';
import { rank } from './ranking.js';
import { IWorkerDispatcher } from './workerDispatcher.js';
import { IWorkerResultReader } from './workerResult.js';
import { buildWorkerBrief, WORKER_FINALIZE_PROMPT } from './workerBrief.js';

/** Durable admission manager: reserves/releases slots and enforces caps (design 7.4). */
export interface IAdmissionManager {
	/** Reserve one slot for a task attempt; returns whether admitted. Idempotent. */
	tryReserve(taskId: string, attemptIndex: number, repo: string | undefined): Promise<AdmissionResult>;
	/** Whether a slot could be admitted without reserving (gate budget probe). */
	canAdmit(repo: string | undefined): boolean;
	/** Release a slot on resolve/cancel/fail. Idempotent. */
	release(taskId: string, attemptIndex: number, repo: string | undefined): Promise<void>;
}

/** Builds the self-contained worker brief for a role + task (technical spec 2.2 step 4). */
export type BriefFactory = (role: WorkerRole, task: ILogicalTask) => string;

/**
 * The default brief factory produces the rich, self-contained task brief
 * ({@link buildWorkerBrief}); the harness prepends the operating envelope and the
 * mounted skills persona at dispatch (technical spec 2.2-2.3).
 */
const DEFAULT_BRIEF: BriefFactory = buildWorkerBrief;

/**
 * The coordinator engine (design 4, technical spec 4): the deterministic spine
 * that turns an ambient event into a dispatched worker task. It runs the gate,
 * reserves admission, creates/joins the LogicalTask (idempotent by group_key),
 * and delegates the actual session creation to an {@link IWorkerDispatcher}.
 *
 * Session lifecycle events are routed to reactivation of their owning task rather
 * than gated (gotcha G15). This class is deliberately free of session-runtime and
 * DI coupling so the whole loop is unit-testable.
 */
export class CoordinatorEngine {

	constructor(
		private readonly inboxId: string,
		private readonly store: IInboxOneStore,
		private readonly settings: IInboxOneSettings,
		private readonly admission: IAdmissionManager,
		private readonly dispatcher: IWorkerDispatcher,
		private readonly logService: ILogService,
		private readonly briefFactory: BriefFactory = DEFAULT_BRIEF,
		private readonly resultReader?: IWorkerResultReader,
	) { }

	/** Attempts for which a one-shot finalize relay has already been requested. */
	private readonly finalizeRequested = new Set<string>();

	/** Processes one normalized ambient event. */
	async handleEvent(event: IIngressEvent): Promise<void> {
		if (event.source === EventSource.Session) {
			await this.handleSessionEvent(event);
			return;
		}
		await this.handleWorldEvent(event);
	}

	private async handleWorldEvent(event: IIngressEvent): Promise<void> {
		const groupKey = deriveGroupKey(event);
		const decision = evaluateGate(event, groupKey, this.gateContext(event));
		if (decision.dispatch) {
			this.logService.info(`[inboxOne] world event ${event.type}/${event.action ?? '-'} ${groupKey ?? '(no key)'}: DISPATCH role=${decision.role}`);
		} else {
			this.logService.info(`[inboxOne] world event ${event.type}/${event.action ?? '-'} ${groupKey ?? '(no key)'}: no-dispatch disposition=${decision.disposition} reason=${decision.reason}`);
		}

		if (!decision.dispatch) {
			if (decision.disposition === 'drop') {
				await this.store.recordDrop({ deliveryId: event.deliveryId, groupKey, reason: decision.reason, droppedAt: Date.now() });
				this.logService.trace(`[inboxOne] gate drop ${event.deliveryId}: ${decision.reason}`);
			} else {
				// Over budget: leave a ledger note; the event will be re-observed on
				// the next backfill/webhook, and admission frees on resolve.
				this.logService.trace(`[inboxOne] gate queue ${event.deliveryId}: ${decision.reason}`);
			}
			return;
		}

		// Create or join the task by group_key (idempotent, I1).
		const { task, created } = await this.store.upsertByGroupKey({
			inboxId: this.inboxId,
			repo: event.repo,
			groupKey: decision.groupKey,
			sourceEvent: event,
			type: decision.role,
			firstAttemptTrigger: AttemptTrigger.Hook,
		});
		if (!created) {
			// A duplicate/later event joined an existing task; nothing new to dispatch.
			this.logService.trace(`[inboxOne] joined existing task ${task.id} for ${decision.groupKey}`);
			return;
		}

		await this.dispatchFor(task, decision.role, decision.groupKey);
	}

	private async handleSessionEvent(event: IIngressEvent): Promise<void> {
		if (!event.sessionId) {
			return;
		}
		const task = this.store.getTaskBySession(event.sessionId) ?? this.store.getTaskBySession(sessionRefFor(event.sessionId));
		if (!task) {
			// A standalone session event with no owning task; Diffy may mint work
			// later, but there is nothing to reactivate here.
			return;
		}
		switch (event.type) {
			case 'task_finished':
				// A conversation thread (not a dispatched worker) finishing is not an
				// evidence-bearing result; leave its inbox item for the human to clear.
				if (task.type === 'conversation') {
					this.logService.trace(`[inboxOne] conversation ${event.sessionId} finished`);
				} else if (!await this.tryLandWorkerResult(task)) {
					await this.store.transition(task.id, TaskTrigger.AttemptFailed);
				}
				break;
			case 'needs_input':
				// Agent sessions end a TURN (status needs-input / waiting) rather than
				// "complete". If the worker produced its emit-result this turn, land it.
				// Otherwise the worker likely stopped at prose findings: ask it once to
				// finalize into the emit-result block, and only block when it still
				// produces nothing after that (or there is no session to relay to).
				if (task.type !== 'conversation' && !await this.tryLandWorkerResult(task) && !await this.tryRequestFinalize(task)) {
					await this.store.transition(task.id, TaskTrigger.Blocker, { recoveryStep: 'Worker needs input.' });
				}
				break;
			case 'failed':
				await this.store.transition(task.id, TaskTrigger.AttemptFailed);
				break;
			case 'progress':
			case 'idle':
			default:
				// Non-dispatching; updates the Cooking view only (G15).
				break;
		}
	}

	/**
	 * Reads a worker's emitted result and, if it is a valid emit-result, HOST-
	 * validates it into an evidence pack, HOST-computes the tier + plain-language
	 * rank reason, and lands it as a Decision (technical spec 2.3). Returns whether
	 * a decision was landed; `false` means no valid result yet (the caller decides
	 * whether that is a failed attempt or a genuine block). Nothing here is
	 * authored by the model except the raw candidate the host validates.
	 */
	private async tryLandWorkerResult(task: ILogicalTask): Promise<boolean> {
		if (!this.resultReader) {
			// No reader wired (e.g. pure-logic tests); the lifecycle signal is
			// recorded but evidence lands via another path.
			return false;
		}
		const sessionRef = currentAttempt(task)?.sessionRef;
		if (!sessionRef) {
			return false;
		}

		let output;
		try {
			output = await this.resultReader.read(task, sessionRef);
		} catch (err) {
			this.logService.error(`[inboxOne] reading worker result for task ${task.id} failed`, err);
			return false;
		}
		if (!output) {
			return false;
		}

		const validated = validateWorkerResult(output.result);
		if (!validated.ok) {
			this.logService.warn(`[inboxOne] worker result for task ${task.id} rejected: ${validated.problems.join('; ')}`);
			return false;
		}

		await this.store.setEvidence(task.id, validated.evidence);
		const ranked = rank(output.signals);
		await this.store.transition(task.id, TaskTrigger.EvidenceAssembled, {
			tier: ranked.tier,
			rank: ranked.rank,
			rankReason: ranked.reason,
		});
		this.logService.info(`[inboxOne] task ${task.id} landed as ${ranked.tier}: ${ranked.reason}`);
		return true;
	}

	/**
	 * When a worker ends a turn with findings but no parseable emit-result, relays
	 * the deterministic {@link WORKER_FINALIZE_PROMPT} once per attempt so the
	 * worker formats what it already found into the machine-readable block. Returns
	 * whether a finalize relay was sent (the caller keeps the task Cooking on
	 * `true`; on `false` there was nothing to relay to or it was already asked, so
	 * the task is genuinely blocked). This authors no evidence.
	 */
	private async tryRequestFinalize(task: ILogicalTask): Promise<boolean> {
		const attempt = currentAttempt(task);
		const sessionRef = attempt?.sessionRef;
		if (!sessionRef) {
			return false;
		}
		const key = `${task.id}#${attempt.index}`;
		if (this.finalizeRequested.has(key)) {
			return false;
		}
		this.finalizeRequested.add(key);
		try {
			await this.dispatcher.relay(sessionRef, WORKER_FINALIZE_PROMPT);
			this.logService.info(`[inboxOne] task ${task.id} asked to finalize its emit-result`);
			return true;
		} catch (err) {
			this.logService.error(`[inboxOne] finalize relay for task ${task.id} failed`, err);
			this.finalizeRequested.delete(key);
			return false;
		}
	}

	private async dispatchFor(task: ILogicalTask, role: WorkerRole, groupKey: GroupKey): Promise<void> {
		const attemptIndex = task.attempts[task.currentAttempt]?.index ?? 0;
		const admission = await this.admission.tryReserve(task.id, attemptIndex, task.repo);
		if (!isAdmitted(admission)) {
			this.logService.trace(`[inboxOne] task ${task.id} queued: ${admission}`);
			return;
		}
		try {
			const result = await this.dispatcher.dispatch({
				task,
				attemptIndex,
				role,
				groupKey,
				brief: this.briefFactory(role, task),
			});
			if (result.deferred) {
				// The worker could not actually start (e.g. no agent host yet): record
				// intent but RELEASE the reserved slot so a stuck "no host" task never
				// permanently consumes admission (design 7.4). The task stays Cooking
				// and is re-dispatchable when a target becomes available.
				await this.admission.release(task.id, attemptIndex, task.repo);
				this.logService.trace(`[inboxOne] task ${task.id} dispatch deferred; admission released`);
			}
			await this.store.updateTask(task.id, { sessionRef: result.sessionRef });
		} catch (err) {
			this.logService.error(`[inboxOne] dispatch failed for task ${task.id}`, err);
			await this.admission.release(task.id, attemptIndex, task.repo);
			await this.store.transition(task.id, TaskTrigger.AttemptFailed);
		}
	}

	private gateContext(event: IIngressEvent): IGateContext {
		return {
			isRepoEnrolled: repo => this.settings.isRepoEnrolled(repo),
			isTriggerEnabled: (type) => {
				const family = triggerFamilyFor(type);
				return family !== undefined && !!event.repo && this.settings.isTriggerEnabled(event.repo, family);
			},
			hasInflightForGroupKey: groupKey => {
				const task = this.store.getTaskByGroupKey(groupKey);
				return !!task && (task.state === LogicalTaskState.Cooking || task.state === LogicalTaskState.Confirming);
			},
			canAdmit: repo => this.admission.canAdmit(repo),
		};
	}

	/** Whether an action is eligible for silent auto-handling under the current autonomy (design 7.3). */
	autoHandleAllowed(repo: string | undefined, actionAutoEligible: boolean): boolean {
		const level = this.settings.getAutonomy(repo);
		if (level === AutonomyLevel.Nothing) {
			return false;
		}
		return actionAutoEligible;
	}
}

function sessionRefFor(sessionId: string): string {
	return `session://worker/${sessionId}`;
}
