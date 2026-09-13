/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEventSubject, IIngressEvent } from './inboxOneTypes.js';

/**
 * Event taxonomy: maps webhook-shaped ambient events to the worker role that can
 * produce a decision-ready result. This is the single source of truth for both
 * the dispatch gate's "value / actionable" checks (design 4) and the Settings
 * trigger families surfaced as checkboxes (design 11).
 *
 * Transports normalize provider signals so that the `action` already encodes the
 * relevant outcome (e.g. a failed check arrives as `check_run` / `failed`), which
 * keeps this classifier a pure function of `(type, action)`.
 */

/** The seeded worker role clusters. Roles are otherwise emergent from skills (design 5). */
export const enum WorkerRole {
	IssueTriage = 'issue-triage',
	ImplementFix = 'implement-fix',
	CodeReview = 'code-review',
}

export interface IEventClassification {
	/** The worker role to dispatch for this event. */
	readonly role: WorkerRole;
	/** The subject kind used to derive the group_key. */
	readonly subjectKind: IEventSubject['kind'];
	/** Whether the produced result yields a clear human decision (design 4 check 2). */
	readonly actionable: boolean;
	/** The trigger family this event belongs to (Settings grouping, design 11). */
	readonly family: TriggerFamily;
}

/** Trigger families as surfaced in Settings > Coordinator (design 11). */
export const enum TriggerFamily {
	Issues = 'issues',
	PullRequests = 'pull_requests',
	Checks = 'checks',
	Security = 'security',
	Deployments = 'deployments',
	AgentSessions = 'agent_sessions',
}

const PR_WORK_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review', 'review_requested', 'synchronize', 'edited']);
const ISSUE_WORK_ACTIONS = new Set(['opened', 'reopened', 'labeled']);
const FAILURE_ACTIONS = new Set(['failed', 'failure', 'errored', 'timed_out']);
const SECURITY_WORK_ACTIONS = new Set(['created', 'reopened', 'appeared_in_branch']);

/**
 * Classifies an event into the work it can produce, or `undefined` when the
 * event yields no concrete, actionable work (the gate then drops it).
 */
export function classifyEvent(event: IIngressEvent): IEventClassification | undefined {
	const action = event.action ?? '';
	switch (event.type) {
		case 'pull_request':
		case 'pull_request_target':
			return PR_WORK_ACTIONS.has(action)
				? { role: WorkerRole.CodeReview, subjectKind: 'pr', actionable: true, family: TriggerFamily.PullRequests }
				: undefined;

		case 'issues':
			return ISSUE_WORK_ACTIONS.has(action)
				? { role: WorkerRole.IssueTriage, subjectKind: 'issue', actionable: true, family: TriggerFamily.Issues }
				: undefined;

		case 'check_run':
		case 'check_suite':
		case 'workflow_run':
		case 'status':
			// Only failures produce fix work; successes may resolve a task but are
			// not their own dispatchable work here (gotcha G2 keeps them on the PR).
			return FAILURE_ACTIONS.has(action)
				? { role: WorkerRole.ImplementFix, subjectKind: 'check', actionable: true, family: TriggerFamily.Checks }
				: undefined;

		case 'code_scanning_alert':
		case 'secret_scanning_alert':
		case 'dependabot_alert':
		case 'repository_vulnerability_alert':
			return SECURITY_WORK_ACTIONS.has(action)
				? { role: WorkerRole.ImplementFix, subjectKind: 'security', actionable: true, family: TriggerFamily.Security }
				: undefined;

		default:
			return undefined;
	}
}

/** True when this event type belongs to a trigger family (i.e. is representable in Settings). */
export function triggerFamilyFor(type: string): TriggerFamily | undefined {
	switch (type) {
		case 'pull_request': case 'pull_request_target': case 'pull_request_review': case 'pull_request_review_comment':
			return TriggerFamily.PullRequests;
		case 'issues': case 'issue_comment':
			return TriggerFamily.Issues;
		case 'check_run': case 'check_suite': case 'workflow_run': case 'workflow_job': case 'status':
			return TriggerFamily.Checks;
		case 'code_scanning_alert': case 'secret_scanning_alert': case 'dependabot_alert': case 'repository_vulnerability_alert':
			return TriggerFamily.Security;
		case 'deployment': case 'deployment_status':
			return TriggerFamily.Deployments;
		case 'task_finished': case 'needs_input': case 'idle': case 'failed': case 'progress':
			return TriggerFamily.AgentSessions;
		default:
			return undefined;
	}
}
