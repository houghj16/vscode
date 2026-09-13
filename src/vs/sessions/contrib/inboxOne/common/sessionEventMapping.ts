/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionStatus } from '../../../services/sessions/common/session.js';

/**
 * Maps agent-session lifecycle to normalized ambient event types (technical spec
 * 3, design 4). The thread is the central primitive: a worker finishing or
 * needing input is an ambient event just like a new PR. These types flow through
 * the same ingress and are routed by the coordinator to the owning task (G15).
 *
 * | SessionStatus | event type    | effect                                   |
 * |---------------|---------------|------------------------------------------|
 * | Completed     | task_finished | assemble evidence + land                 |
 * | NeedsInput    | needs_input   | Blocked (one recovery step)              |
 * | Error         | failed        | failed attempt (+ Retry)                 |
 * | InProgress    | progress      | non-dispatching; Cooking view only       |
 * | Untitled      | (none)        | not an event                             |
 */

export const enum SessionEventType {
	TaskFinished = 'task_finished',
	NeedsInput = 'needs_input',
	Failed = 'failed',
	Progress = 'progress',
}

/** Event types that never change task state -- they only refresh the Cooking view. */
export const NON_DISPATCHING_SESSION_EVENTS: ReadonlySet<string> = new Set([SessionEventType.Progress]);

/** Maps a session status to its event type, or `undefined` when it is not an event. */
export function mapSessionStatusToEventType(status: SessionStatus): SessionEventType | undefined {
	switch (status) {
		case SessionStatus.Completed:
			return SessionEventType.TaskFinished;
		case SessionStatus.NeedsInput:
			return SessionEventType.NeedsInput;
		case SessionStatus.Error:
			return SessionEventType.Failed;
		case SessionStatus.InProgress:
			return SessionEventType.Progress;
		case SessionStatus.Untitled:
		default:
			return undefined;
	}
}

/**
 * Whether a status transition should EMIT an event. We emit on edges into a
 * meaningful state, and de-duplicate repeats of the same status. `InProgress`
 * emits a (non-dispatching) progress event only on the first entry so the
 * Cooking view updates without a storm.
 */
export function shouldEmitOnTransition(previous: SessionStatus | undefined, next: SessionStatus): boolean {
	if (previous === next) {
		return false;
	}
	return mapSessionStatusToEventType(next) !== undefined;
}
