/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { IActionPayloads } from '../common/actionCatalog.js';
import { ActionType, ILogicalTask, LogicalTaskState } from '../common/inboxOneTypes.js';

export const enum InboxOneAttentionGroup {
	NeedsAttention = 'needsAttention',
	InProgress = 'inProgress',
	CompleteUnread = 'completeUnread',
}

export function getTaskAttentionGroup(task: ILogicalTask): InboxOneAttentionGroup | undefined {
	switch (task.state) {
		case LogicalTaskState.Decision:
		case LogicalTaskState.Blocked:
			return InboxOneAttentionGroup.NeedsAttention;
		case LogicalTaskState.Cooking:
		case LogicalTaskState.Confirming:
			return InboxOneAttentionGroup.InProgress;
		case LogicalTaskState.Completed:
			return InboxOneAttentionGroup.CompleteUnread;
		case LogicalTaskState.Archived:
			return undefined;
	}
}

export function getTaskStateLabel(task: ILogicalTask): string {
	switch (task.state) {
		case LogicalTaskState.Decision:
			return task.evidence?.customAsk
				? localize('inboxOne.stateReadyForResponse', "Ready for response")
				: localize('inboxOne.stateReadyForApproval', "Ready for approval");
		case LogicalTaskState.Blocked:
			return localize('inboxOne.stateNeedsInput', "Needs input");
		case LogicalTaskState.Cooking:
			return localize('inboxOne.stateWorking', "Working");
		case LogicalTaskState.Confirming:
			return localize('inboxOne.stateApplyingChanges', "Applying changes");
		case LogicalTaskState.Completed:
			return localize('inboxOne.stateCompleteUnread', "Complete · unread");
		case LogicalTaskState.Archived:
			return localize('inboxOne.stateArchived', "Archived");
	}
}

export function getTaskSessionStatus(task: ILogicalTask): SessionStatus {
	switch (task.state) {
		case LogicalTaskState.Decision:
		case LogicalTaskState.Blocked:
			return SessionStatus.NeedsInput;
		case LogicalTaskState.Cooking:
		case LogicalTaskState.Confirming:
			return SessionStatus.InProgress;
		case LogicalTaskState.Completed:
		case LogicalTaskState.Archived:
			return SessionStatus.Completed;
	}
}

export function getTaskConsequence(task: ILogicalTask): string | undefined {
	const action = task.evidence?.primaryAction;
	if (!action) {
		return task.recoveryStep;
	}

	switch (action.actionType) {
		case ActionType.MergePr: {
			const payload = action.payload as IActionPayloads[ActionType.MergePr];
			return localize('inboxOne.consequence.mergePr', "Merges PR #{0} into {1}", payload.prNumber, payload.base);
		}
		case ActionType.ApprovePr: {
			const payload = action.payload as IActionPayloads[ActionType.ApprovePr];
			return localize('inboxOne.consequence.approvePr', "Approves PR #{0}", payload.prNumber);
		}
		case ActionType.Comment: {
			const payload = action.payload as IActionPayloads[ActionType.Comment];
			return localize('inboxOne.consequence.comment', "Posts a comment on #{0}", payload.targetNumber);
		}
		case ActionType.AddLabels: {
			const payload = action.payload as IActionPayloads[ActionType.AddLabels];
			return localize('inboxOne.consequence.labels', "Updates labels on #{0}", payload.targetNumber);
		}
		case ActionType.CreateIssues: {
			const payload = action.payload as IActionPayloads[ActionType.CreateIssues];
			return payload.issues.length === 1
				? localize('inboxOne.consequence.createOneIssue', "Creates 1 meta-issue")
				: localize('inboxOne.consequence.createIssues', "Creates {0} meta-issues", payload.issues.length);
		}
		case ActionType.DispatchFix:
			return localize('inboxOne.consequence.dispatchFix', "Starts a fix agent");
		case ActionType.Deploy: {
			const payload = action.payload as IActionPayloads[ActionType.Deploy];
			return localize('inboxOne.consequence.deploy', "Deploys {0} to {1}", payload.ref, payload.env);
		}
		case ActionType.GrantScope: {
			const payload = action.payload as IActionPayloads[ActionType.GrantScope];
			return localize('inboxOne.consequence.grantScope', "Grants {0} access", payload.scope);
		}
	}
}

export function getApprovalButtonLabel(task: ILogicalTask): string {
	switch (task.evidence?.primaryAction?.actionType) {
		case ActionType.MergePr:
			return localize('inboxOne.approveAndMerge', "Approve and Merge");
		case ActionType.CreateIssues:
			return localize('inboxOne.approveAndCreate', "Approve and Create");
		case ActionType.Deploy:
			return localize('inboxOne.approveAndDeploy', "Approve and Deploy");
		default:
			return localize('inboxOne.approve', "Approve");
	}
}

export function getApprovalDialogTitle(task: ILogicalTask): string {
	switch (task.evidence?.primaryAction?.actionType) {
		case ActionType.MergePr:
			return localize('inboxOne.approveMergeTitle', "Approve and merge this pull request?");
		case ActionType.CreateIssues: {
			const payload = task.evidence.primaryAction.payload as IActionPayloads[ActionType.CreateIssues];
			return payload.issues.length === 1
				? localize('inboxOne.approveCreateIssueTitle', "Approve and create this issue?")
				: localize('inboxOne.approveCreateIssuesTitle', "Approve and create these issues?");
		}
		case ActionType.Deploy:
			return localize('inboxOne.approveDeployTitle', "Approve this deployment?");
		default:
			return localize('inboxOne.approveActionTitle', "Approve this action?");
	}
}

export function matchesTaskFilter(task: ILogicalTask, filter: string, title: string): boolean {
	const normalized = filter.trim().toLocaleLowerCase();
	if (!normalized) {
		return true;
	}

	return [
		title,
		task.repo,
		getTaskStateLabel(task),
		getTaskConsequence(task),
		task.rankReason,
	].some(value => value?.toLocaleLowerCase().includes(normalized));
}
