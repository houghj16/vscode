/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { WorkerRole } from '../common/eventTaxonomy.js';
import { IEventIngress } from '../common/eventIngress.js';
import { ActionType, EventSource, EvidenceRung, IIngressEvent, ILogicalTask } from '../common/inboxOneTypes.js';
import { IWorkerDispatcher, IWorkerDispatchRequest, IWorkerDispatchResult } from '../common/workerDispatcher.js';
import { ITranscriptSource } from '../common/workerResult.js';

/** URI scheme for a session run by the in-window simulator (dev builds only). */
export const SIMULATED_SCHEME = 'inboxone-sim';

/** How long a simulated worker "runs" before it finishes, so the Cooking UX is observable. */
const SIMULATED_RUN_MS = 1500;

/** Whether a session ref is served by the simulator. */
export function isSimulatedRef(sessionRef: string): boolean {
	return sessionRef.startsWith(`${SIMULATED_SCHEME}:`);
}

/** The dispatch wiring the coordinator should use, resolved from build quality + the simulate setting. */
export interface IDispatchWiring {
	/** Wire the in-window simulator as a fallback when the real dispatch defers. */
	readonly useSimulator: boolean;
	/** Let the real dispatcher target the repo as a cloud workspace when no local folder is open. */
	readonly allowCloudFallback: boolean;
}

/**
 * Decides how the coordinator wires dispatch (technical spec 2.2). Stable builds
 * always use the real dispatcher with the cloud fallback and never simulate. Dev
 * builds simulate by default (fast, deterministic, host-free), but the user can
 * turn simulation off (`inboxOne.simulateWorkers: false`) to exercise the real
 * agent host / cloud path -- at which point the cloud fallback is re-enabled so a
 * connected host actually drives workers. Pure, so it is unit-testable.
 */
export function resolveDispatchWiring(isDevBuild: boolean, simulate: boolean): IDispatchWiring {
	const useSimulator = isDevBuild && simulate;
	// The simulator owns the no-host case; when it is off, the real dispatcher may
	// target the repo as a cloud workspace so a connected host can run the worker.
	return { useSimulator, allowCloudFallback: !useSimulator };
}

/**
 * The in-window worker simulator (dev builds only, technical spec 2.3).
 *
 * When no agent host / session target is available, this stands in for a real
 * worker so the WHOLE production pipeline still runs headless: a dispatched
 * worker "runs" for a moment, emits a role-faithful emit-result document, and
 * finishes via a `task_finished` ambient event on the SAME ingress a real
 * session uses. The coordinator then reads that document through the ordinary
 * {@link ITranscriptSource} seam and HOST-validates it into an evidence pack and
 * a HOST-computed tier -- exactly as it would for a real worker. Nothing here
 * writes evidence directly, so the dev inbox shows real, non-hardcoded results.
 *
 * It is gated to non-stable builds by its wiring (see diffyCoordinatorService),
 * so simulated evidence can never appear in production.
 */
export class SimulatedWorkerRuntime extends Disposable implements ITranscriptSource {

	/** sessionRef -> the worker's final message (its emit-result document). */
	private readonly transcripts = new Map<string, string>();
	private readonly timers = this._register(new DisposableStore());

	constructor(
		private readonly ingress: IEventIngress,
		private readonly logService: ILogService,
		private readonly runDelayMs: number = SIMULATED_RUN_MS,
	) {
		super();
	}

	/** Allocates a simulated session ref and schedules its run + completion. */
	run(role: WorkerRole, task: ILogicalTask, reuseRef?: string): string {
		const sessionRef = reuseRef ?? `${SIMULATED_SCHEME}://worker/${generateUuid()}`;
		this.transcripts.set(sessionRef, simulateWorkerFinalMessage(role, task));
		this.logService.info(`[inboxOne] (sim) worker ${role} running for ${task.repo ?? 'repo'} -> ${sessionRef}`);
		this.timers.add(disposableTimeout(() => {
			this.ingress.submit(finishedEvent(sessionRef))
				.catch(err => this.logService.error('[inboxOne] (sim) finished-event submit failed', err));
		}, this.runDelayMs));
		return sessionRef;
	}

	async readFinalMessage(_task: ILogicalTask, sessionRef: string): Promise<string | undefined> {
		return this.transcripts.get(sessionRef);
	}

	/**
	 * Re-runs a warm simulated worker (a steer/continuation relay): it keeps its
	 * transcript and finishes again, so the steered task re-lands a decision. A
	 * no-op for an unknown ref.
	 */
	rerun(sessionRef: string): void {
		if (!this.transcripts.has(sessionRef)) {
			return;
		}
		this.timers.add(disposableTimeout(() => {
			this.ingress.submit(finishedEvent(sessionRef))
				.catch(err => this.logService.error('[inboxOne] (sim) finished-event submit failed', err));
		}, this.runDelayMs));
	}
}

/** Builds the `task_finished` ambient event for a finished simulated worker (matches SessionEventAdapter). */
function finishedEvent(sessionRef: string): IIngressEvent {
	const slash = sessionRef.lastIndexOf('/');
	const id = slash === -1 ? sessionRef : sessionRef.slice(slash + 1);
	return {
		deliveryId: `session:${sessionRef}:task_finished:${generateUuid()}`,
		source: EventSource.Session,
		sessionId: sessionRef,
		type: 'task_finished',
		subject: { kind: 'session', id },
		receivedAt: Date.now(),
	};
}

/**
 * A {@link IWorkerDispatcher} backed by the {@link SimulatedWorkerRuntime}. Used
 * only as a fallback when no real session target exists (dev builds).
 */
export class SimulatedWorkerDispatcher implements IWorkerDispatcher {

	constructor(private readonly runtime: SimulatedWorkerRuntime) { }

	async dispatch(request: IWorkerDispatchRequest): Promise<IWorkerDispatchResult> {
		if (request.reuseSessionRef && isSimulatedRef(request.reuseSessionRef)) {
			this.runtime.run(request.role, request.task, request.reuseSessionRef);
			return { sessionRef: request.reuseSessionRef, reused: true };
		}
		return { sessionRef: this.runtime.run(request.role, request.task), reused: false };
	}

	async relay(sessionRef: string, _message: string): Promise<void> {
		// A relay to a simulated worker re-runs it; the new run re-lands evidence.
		if (isSimulatedRef(sessionRef)) {
			this.runtime.rerun(sessionRef);
		}
	}
}

/**
 * A dispatcher that prefers a real session target and falls back to the
 * simulator when the real dispatch could not target a host (dev builds). Keeps
 * the coordinator host-independent while giving the dev window the full,
 * production-faithful loop with no host connected.
 */
export class FallbackWorkerDispatcher implements IWorkerDispatcher {

	constructor(
		private readonly real: IWorkerDispatcher,
		private readonly simulated: SimulatedWorkerDispatcher,
		private readonly logService: ILogService,
		/** Predicate identifying a real dispatch that deferred for want of a host. */
		private readonly isDeferred: (sessionRef: string) => boolean,
	) { }

	async dispatch(request: IWorkerDispatchRequest): Promise<IWorkerDispatchResult> {
		if (request.reuseSessionRef && isSimulatedRef(request.reuseSessionRef)) {
			return this.simulated.dispatch(request);
		}
		const result = await this.real.dispatch(request);
		if (this.isDeferred(result.sessionRef)) {
			this.logService.info(`[inboxOne] no host for ${request.groupKey}; running the in-window simulator (dev build)`);
			return this.simulated.dispatch(request);
		}
		return result;
	}

	async relay(sessionRef: string, message: string): Promise<void> {
		if (isSimulatedRef(sessionRef)) {
			return this.simulated.relay(sessionRef, message);
		}
		return this.real.relay(sessionRef, message);
	}
}

/** A transcript source that consults each source in order (first non-undefined wins). */
export class CompositeTranscriptSource implements ITranscriptSource {

	constructor(private readonly sources: readonly ITranscriptSource[]) { }

	async readFinalMessage(task: ILogicalTask, sessionRef: string): Promise<string | undefined> {
		for (const source of this.sources) {
			const message = await source.readFinalMessage(task, sessionRef);
			if (message !== undefined) {
				return message;
			}
		}
		return undefined;
	}
}

// --- role-faithful simulated worker output ------------------------------------

interface ISimResult {
	readonly action_type?: string;
	readonly payload?: unknown;
	readonly label?: string;
	readonly decision_sentence: string;
	readonly claims: ReadonlyArray<{ readonly text: string; readonly receipt_link: string; readonly rung: number }>;
	readonly gap_line: string;
}

/**
 * Produces a worker's final message containing a valid `inbox-one-result` block
 * for the role + task. Deterministic and role-faithful; the values are derived
 * from the task (not fixed placeholders), and the block is parsed + HOST-
 * validated + HOST-ranked by the same code a real worker's output flows through.
 */
export function simulateWorkerFinalMessage(role: WorkerRole, task: ILogicalTask): string {
	const result = buildSimResult(role, task);
	const prose = `Simulated ${role} worker (no agent host connected). ${result.decision_sentence}.`;
	return `${prose}\n\n\`\`\`inbox-one-result\n${JSON.stringify(result)}\n\`\`\`\n`;
}

function buildSimResult(role: WorkerRole, task: ILogicalTask): ISimResult {
	const repo = task.repo ?? 'owner/repo';
	const subject = task.sourceEvent.subject;
	const id = subject.id;
	const prNumber = Number(subject.attachedTo?.id ?? subject.id) || 1;

	// A security finding surfaces as an evidence-only decision (no one-click
	// action): reachability needs the production graph, so the human must judge.
	if (subject.kind === 'security') {
		return {
			decision_sentence: `Security alert ${id} is real, but exploit reachability is unconfirmed`,
			claims: [
				{ text: 'The advisory matches a dependency in the lockfile', receipt_link: `https://github.com/${repo}/security`, rung: EvidenceRung.SingleRun },
				{ text: 'No call path from the alert to a request handler was found in the repo', receipt_link: `https://github.com/${repo}/blob/HEAD`, rung: EvidenceRung.ReproducibleTest },
			],
			gap_line: 'Not verified: whether the vulnerable path is reachable with the production dependency graph',
		};
	}

	switch (role) {
		case WorkerRole.IssueTriage:
			return {
				action_type: ActionType.CreateIssues,
				payload: { repo, issues: [{ title: `Cluster: theme around #${id}`, body: `Groups the related reports under one tracking issue.`, sourceIssues: [Number(id) || 0] }] },
				label: 'Group issues',
				decision_sentence: `New issues around #${id} cluster into one actionable theme`,
				claims: [
					{ text: 'Three open issues share the same reproduction and error signature', receipt_link: `https://github.com/${repo}/issues/${id}`, rung: EvidenceRung.SingleRun },
					{ text: 'Each references the same module, so a single fix resolves all of them', receipt_link: `https://github.com/${repo}/issues/${id}`, rung: EvidenceRung.ReproducibleTest },
				],
				gap_line: 'Not verified: whether two lower-signal reports belong to this theme or a separate one',
			};
		case WorkerRole.ImplementFix:
			return {
				action_type: ActionType.MergePr,
				payload: { repo, prNumber, base: 'main', strategy: 'squash' },
				label: 'Merge fix',
				decision_sentence: `The fix for the failing check on PR #${prNumber} is green`,
				claims: [
					{ text: 'The previously red check now passes on the fix branch', receipt_link: `https://github.com/${repo}/pull/${prNumber}/checks`, rung: EvidenceRung.ReproducibleTest },
					{ text: 'The change is scoped to the failing code path and touches no other files', receipt_link: `https://github.com/${repo}/pull/${prNumber}/files`, rung: EvidenceRung.SingleRun },
				],
				gap_line: 'Not verified: behavior of the fix under concurrent load',
			};
		case WorkerRole.CodeReview:
		default:
			return {
				action_type: ActionType.ApprovePr,
				payload: { repo, prNumber: Number(id) || prNumber },
				label: 'Approve PR',
				decision_sentence: `PR #${id} is correct and ready to approve`,
				claims: [
					{ text: 'All required checks pass, including the two that gate the merge', receipt_link: `https://github.com/${repo}/pull/${id}/checks`, rung: EvidenceRung.ReproducibleTest },
					{ text: 'The diff is limited to the described change and preserves existing tests', receipt_link: `https://github.com/${repo}/pull/${id}/files`, rung: EvidenceRung.SingleRun },
				],
				gap_line: 'Not verified: manual QA of the new code path in a staging environment',
			};
	}
}
