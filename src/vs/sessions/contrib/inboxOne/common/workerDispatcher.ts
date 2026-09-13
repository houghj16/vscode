/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkerRole } from './eventTaxonomy.js';
import { GroupKey, ILogicalTask } from './inboxOneTypes.js';

/**
 * Dispatches a worker session for a task attempt (technical spec 2.2-2.3).
 *
 * The coordinator engine owns the gate/admission/store decisions and delegates
 * ONLY the "create/reuse a session, mount roles, send the brief" step to this
 * interface. In production it is backed by the session harness
 * (`ISessionsManagementService` + `mount_roles`); in tests it is a stub. Keeping
 * it behind an interface lets the whole coordinator loop be unit-tested without
 * the session runtime.
 */
export interface IWorkerDispatcher {
	/**
	 * Dispatches a worker for the task's current attempt. Returns the
	 * provider-neutral session resource backing the attempt. Idempotent with
	 * respect to `(task.id, attemptIndex)` -- a retried dispatch must not
	 * double-run (I2).
	 */
	dispatch(request: IWorkerDispatchRequest): Promise<IWorkerDispatchResult>;

	/**
	 * Relays a steering/continuation message into an existing worker session
	 * (technical spec 2.4). Used by the steer/reopen handoff.
	 */
	relay(sessionRef: string, message: string): Promise<void>;
}

export interface IWorkerDispatchRequest {
	readonly task: ILogicalTask;
	readonly attemptIndex: number;
	readonly role: WorkerRole;
	readonly groupKey: GroupKey;
	/** A prior warm session to reuse, if the coordinator chose reuse (re-scoped). */
	readonly reuseSessionRef?: string;
	/** The self-contained task brief for the worker's first message. */
	readonly brief: string;
}

export interface IWorkerDispatchResult {
	/** The provider-neutral resource of the (new or reused) worker session. */
	readonly sessionRef: string;
	/** Whether an existing session was reused (warm context) vs newly created. */
	readonly reused: boolean;
}
