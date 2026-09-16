/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionStatus } from '../../../../services/sessions/common/session.js';
import { getApprovalButtonLabel, getApprovalDialogTitle, getTaskAttentionGroup, getTaskConsequence, getTaskSessionStatus, getTaskStateLabel, InboxOneAttentionGroup, matchesTaskFilter } from '../../browser/inboxOnePresentation.js';
import { ActionType, AttemptStatus, AttemptTrigger, EvidenceRung, EventSource, ILogicalTask, LogicalTaskState } from '../../common/inboxOneTypes.js';

function task(state: LogicalTaskState, actionType: ActionType = ActionType.CreateIssues): ILogicalTask {
	const payload = actionType === ActionType.CreateIssues
		? { repo: 'microsoft/vscode', issues: [{ title: 'Track retry failures' }] }
		: { repo: 'microsoft/vscode', prNumber: 42 };
	return {
		id: 'task-1',
		inboxId: 'inbox',
		repo: 'microsoft/vscode',
		groupKey: 'microsoft/vscode:issue-cluster:retry',
		sourceEvent: {
			deliveryId: 'delivery-1',
			source: EventSource.World,
			repo: 'microsoft/vscode',
			type: 'issues',
			subject: { kind: 'issue-cluster', id: 'retry' },
			receivedAt: 1,
		},
		type: 'issue-triage',
		state,
		attempts: [{ id: 'attempt-1', index: 0, trigger: AttemptTrigger.Hook, status: AttemptStatus.Done, startedAt: 1 }],
		currentAttempt: 0,
		evidence: {
			revision: 0,
			title: 'Triage retry failures',
			decisionSentence: 'The reports describe the same underlying failure.',
			claims: [{ text: 'Three reports share a stack trace.', rung: EvidenceRung.SingleRun }],
			gapLine: 'Production load is not verified.',
			freshness: { computedAt: 1 },
			primaryAction: { label: 'Create meta-issue', actionType, payload },
		},
		route: 'agents://inbox/inbox/items/task-1',
		createdAt: 1,
		updatedAt: 2,
	};
}

suite('Inbox One - presentation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps lifecycle states to attention groups and shared session statuses', () => {
		assert.deepStrictEqual([
			[LogicalTaskState.Decision, getTaskAttentionGroup(task(LogicalTaskState.Decision)), getTaskSessionStatus(task(LogicalTaskState.Decision))],
			[LogicalTaskState.Cooking, getTaskAttentionGroup(task(LogicalTaskState.Cooking)), getTaskSessionStatus(task(LogicalTaskState.Cooking))],
			[LogicalTaskState.Completed, getTaskAttentionGroup(task(LogicalTaskState.Completed)), getTaskSessionStatus(task(LogicalTaskState.Completed))],
			[LogicalTaskState.Archived, getTaskAttentionGroup(task(LogicalTaskState.Archived)), getTaskSessionStatus(task(LogicalTaskState.Archived))],
		], [
			[LogicalTaskState.Decision, InboxOneAttentionGroup.NeedsAttention, SessionStatus.NeedsInput],
			[LogicalTaskState.Cooking, InboxOneAttentionGroup.InProgress, SessionStatus.InProgress],
			[LogicalTaskState.Completed, InboxOneAttentionGroup.CompleteUnread, SessionStatus.Completed],
			[LogicalTaskState.Archived, undefined, SessionStatus.Completed],
		]);
	});

	test('describes the current state and concrete action consequence', () => {
		const value = task(LogicalTaskState.Decision);
		assert.deepStrictEqual({
			state: getTaskStateLabel(value),
			consequence: getTaskConsequence(value),
			approval: getApprovalButtonLabel(value),
			dialogTitle: getApprovalDialogTitle(value),
		}, {
			state: 'Ready for approval',
			consequence: 'Creates 1 meta-issue',
			approval: 'Approve and Create',
			dialogTitle: 'Approve and create this issue?',
		});
	});

	test('filters across title, repository, state, and consequence', () => {
		const value = task(LogicalTaskState.Decision);
		assert.deepStrictEqual([
			matchesTaskFilter(value, 'retry failures', 'Triage retry failures'),
			matchesTaskFilter(value, 'microsoft/vscode', 'Triage retry failures'),
			matchesTaskFilter(value, 'ready for approval', 'Triage retry failures'),
			matchesTaskFilter(value, 'meta-issue', 'Triage retry failures'),
			matchesTaskFilter(value, 'unrelated', 'Triage retry failures'),
		], [true, true, true, true, false]);
	});
});
