/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../../base/common/observable.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { TaskTrigger } from './inboxOneStateMachine.js';
import { AttemptTrigger, GroupKey, IAttempt, IDropLedgerEntry, IEvidencePack, IGesture, IIngressEvent, ILogicalTask, InboxOneTier, LogicalTaskState } from './inboxOneTypes.js';

export const IInboxOneStore = createDecorator<IInboxOneStore>('inboxOneStore');

/** Fields required to mint a brand-new {@link ILogicalTask}. Identity, timestamps, route and attempts are assigned by the store. */
export interface INewTaskInit {
	readonly inboxId: string;
	readonly repo?: string;
	readonly groupKey: GroupKey;
	readonly sourceEvent: IIngressEvent;
	readonly type: string;
	/** The trigger for the initial attempt (usually {@link AttemptTrigger.Hook}). */
	readonly firstAttemptTrigger: AttemptTrigger;
	readonly parentTaskId?: string;
}

/** Result of an idempotent upsert-by-group-key (technical spec 11, I1). */
export interface IUpsertResult {
	readonly task: ILogicalTask;
	/** `true` when a new task was created, `false` when an existing task was joined. */
	readonly created: boolean;
}

/** A partial patch applied to a task within the same transaction as a transition. */
export interface ITaskPatch {
	readonly tier?: InboxOneTier;
	readonly rank?: number;
	readonly rankReason?: string;
	readonly evidence?: IEvidencePack;
	readonly recoveryStep?: string;
	readonly archiveReason?: string;
	readonly type?: string;
	/** Attach/replace the worker session backing the current attempt. */
	readonly sessionRef?: string;
}

/** Options for a guarded transition (tech-spec 9, I6). */
export interface ITransitionOptions {
	/**
	 * Compare-and-swap fence. When set, the transition is rejected as stale if
	 * the task's current attempt index or evidence revision has moved. Used to
	 * prevent accepting on stale evidence and to reconcile multi-device races.
	 */
	readonly expected?: {
		readonly attemptIndex?: number;
		readonly evidenceRevision?: number;
	};
	/** Trigger for the new attempt when the transition opens one. Defaults from the transition trigger. */
	readonly newAttemptTrigger?: AttemptTrigger;
	/** The provider-neutral resource of the (new or reused) worker session for an opened attempt. */
	readonly attemptSessionRef?: string;
}

export const enum TransitionOutcome {
	Applied = 'applied',
	/** The `(state, trigger)` pair is not a legal transition. */
	IllegalTransition = 'illegal_transition',
	/** The CAS fence in {@link ITransitionOptions.expected} did not match; caller must re-verify. */
	Stale = 'stale',
	/** No task exists for the id. */
	NotFound = 'not_found',
}

export interface ITransitionResult {
	readonly outcome: TransitionOutcome;
	/** The task after the transition (present when {@link outcome} is `applied`), else the current task if any. */
	readonly task?: ILogicalTask;
}

/**
 * Durable, provider-neutral store for Inbox One (technical spec 5, 11).
 *
 * Backed by a compare-and-swap ledger so all effects are idempotent and safe
 * under concurrency (I1/I2/I3). The cloud/authoritative store is truth; clients
 * are projections. All mutations are single-writer transactions.
 */
export interface IInboxOneStore {
	readonly _serviceBrand: undefined;

	/** Live projection of all tasks for the inbox, for the tiered list and Diffy header. */
	readonly tasks: IObservable<readonly ILogicalTask[]>;

	getTask(taskId: string): ILogicalTask | undefined;
	getTaskByGroupKey(groupKey: GroupKey): ILogicalTask | undefined;
	/** Resolve the task that owns a worker session (session event routing, G15). */
	getTaskBySession(sessionRef: string): ILogicalTask | undefined;

	/**
	 * Idempotent create-or-join by group_key (I1). A duplicate or later event
	 * with the same key joins the existing task instead of minting a second card.
	 */
	upsertByGroupKey(init: INewTaskInit): Promise<IUpsertResult>;

	/**
	 * Apply a guarded state-machine {@link TaskTrigger} in one transaction,
	 * optionally opening a fresh attempt and patching fields. Rejects illegal or
	 * stale transitions without mutating.
	 */
	transition(taskId: string, trigger: TaskTrigger, patch?: ITaskPatch, options?: ITransitionOptions): Promise<ITransitionResult>;

	/** CAS field update that does not change state (e.g. re-rank, refresh evidence while Cooking). */
	updateTask(taskId: string, patch: ITaskPatch): Promise<ILogicalTask | undefined>;

	/** Append an evidence revision to the current attempt and mark prior evidence historical (I6). */
	setEvidence(taskId: string, evidence: Omit<IEvidencePack, 'revision'>): Promise<ILogicalTask | undefined>;

	/** Record a resolved gesture for the learning loop (design 6.4). */
	recordGesture(gesture: IGesture): Promise<void>;
	getGestures(taskId: string): readonly IGesture[];

	// --- ingress idempotency + progress cursors (tech-spec 3) ---

	/** Atomically records a delivery id; returns `true` if newly seen, `false` if a duplicate (I2). */
	markDeliverySeen(deliveryId: string): Promise<boolean>;
	/** Monotonic per-repo cursor for polling backfill on downtime recovery. */
	getCursor(repo: string): string | undefined;
	setCursor(repo: string, cursor: string): Promise<void>;

	/** Record a dropped event - the only place a non-dispatched event is logged (design 4). */
	recordDrop(entry: IDropLedgerEntry): Promise<void>;
}

/** The current live attempt of a task, or `undefined` if it somehow has none. */
export function currentAttempt(task: ILogicalTask): IAttempt | undefined {
	return task.attempts[task.currentAttempt];
}

/** Convenience: whether the task is currently in one of the given states. */
export function taskInState(task: ILogicalTask, ...states: LogicalTaskState[]): boolean {
	return states.includes(task.state);
}
