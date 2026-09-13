/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventSource, GroupKey, IEventSubject, IIngressEvent } from './inboxOneTypes.js';

/**
 * Deterministic `group_key` derivation (technical spec 3).
 *
 * A `group_key` is a stable identity for "the same real problem". Duplicate or
 * later events with the same key join the existing LogicalTask (idempotent)
 * instead of minting a new card. It is also the key for dedupe, reactivation,
 * and notification collapsing.
 *
 * | Subject               | group_key                                  |
 * |-----------------------|--------------------------------------------|
 * | Pull request          | `{repo}:pr:{number}`                        |
 * | CI / check run        | attaches to its PR/branch task             |
 * | Single issue          | `{repo}:issue:{number}`                     |
 * | Issue cluster (triage)| `{repo}:issue-cluster:{theme_slug}`         |
 * | Security alert        | `{repo}:security:{cve|alert_id}`            |
 * | Deployment            | `{repo}:deploy:{env}`                       |
 * | Branch                | `{repo}:branch:{name}`                      |
 * | Standalone session    | `session:{session_id}`                      |
 *
 * Agent session events that belong to a dispatched worker resolve to the task
 * that owns the session via `session_id -> task` in the store; this function
 * only handles the standalone case (`session:{id}`), which Diffy may mint a task
 * from.
 *
 * Returns `undefined` when the event does not carry enough identity to derive a
 * key (e.g. a repository world event without a repo). Such events are dropped.
 */
export function deriveGroupKey(event: IIngressEvent): GroupKey | undefined {
	const subject = event.subject;

	// Standalone agent-session events key by session id. Worker session events
	// that belong to a task are resolved by the store, not here.
	if (subject.kind === 'session') {
		const id = subject.id || event.sessionId;
		return id ? `session:${id}` : undefined;
	}

	// Every remaining subject is repository-scoped.
	const repo = event.repo;
	if (!repo) {
		return undefined;
	}

	switch (subject.kind) {
		case 'pr':
			return `${repo}:pr:${subject.id}`;
		case 'check':
			// CI/check runs are never their own task (gotcha G2): attach to the
			// owning PR or branch task.
			if (subject.attachedTo) {
				return `${repo}:${subject.attachedTo.kind}:${subject.attachedTo.id}`;
			}
			// A check with no known attachment falls back to a branch task.
			return `${repo}:branch:${subject.id}`;
		case 'branch':
			return `${repo}:branch:${subject.id}`;
		case 'issue':
			return `${repo}:issue:${subject.id}`;
		case 'issue-cluster':
			return `${repo}:issue-cluster:${slugifyThemeSlug(subject.id)}`;
		case 'security':
			return `${repo}:security:${subject.id}`;
		case 'deploy':
			return `${repo}:deploy:${subject.id}`;
		default:
			assertNever(subject.kind);
			return undefined;
	}
}

/**
 * Normalizes an issue-cluster theme into a stable slug so re-clustering joins
 * the same task (gotcha G9). Lowercases, collapses non-alphanumerics to single
 * hyphens, and trims leading/trailing hyphens.
 */
export function slugifyThemeSlug(theme: string): string {
	return theme
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		|| 'unnamed';
}

/** Convenience for constructing a repository subject when normalizing GitHub events. */
export function repoSubject(kind: Exclude<IEventSubject['kind'], 'session'>, id: string, attachedTo?: IEventSubject['attachedTo']): IEventSubject {
	return attachedTo ? { kind, id, attachedTo } : { kind, id };
}

/** Convenience for constructing a standalone agent-session subject. */
export function sessionSubject(sessionId: string): IEventSubject {
	return { kind: 'session', id: sessionId };
}

/** True when an event originates from an agent session rather than world monitoring. */
export function isSessionEvent(event: IIngressEvent): boolean {
	return event.source === EventSource.Session;
}

function assertNever(value: never): void {
	throw new Error(`Unexpected group_key subject kind: ${String(value)}`);
}
