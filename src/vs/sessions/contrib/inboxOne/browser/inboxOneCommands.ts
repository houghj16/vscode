/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ActionType, EventSource, EvidenceRung, IIngressEvent, ILogicalTask, LogicalTaskState } from '../common/inboxOneTypes.js';
import { rank } from '../common/ranking.js';
import { TaskTrigger } from '../common/inboxOneStateMachine.js';
import { IEventIngress } from '../common/eventIngress.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { IInboxOneSettings } from '../common/inboxOneSettings.js';

const INBOX_ONE_CATEGORY = localize2('inboxOne.category', 'Inbox');

/** Enroll a repository so Diffy watches it (design 11). */
export class EnrollRepositoryAction extends Action2 {
	static readonly ID = 'inboxOne.enrollRepository';
	constructor() {
		super({
			id: EnrollRepositoryAction.ID,
			title: localize2('inboxOne.enrollRepository', 'Enroll Repository'),
			category: INBOX_ONE_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const settings = accessor.get(IInboxOneSettings);
		const notification = accessor.get(INotificationService);
		await settings.initialize();
		const repo = await quickInput.input({
			prompt: localize('inboxOne.enrollPrompt', 'Repository to enroll (owner/name)'),
			placeHolder: 'owner/name',
			validateInput: async value => (/^[^/\s]+\/[^/\s]+$/.test(value.trim()) ? undefined : localize('inboxOne.enrollInvalid', 'Enter a repository as owner/name')),
		});
		if (!repo) {
			return;
		}
		await settings.enrollRepo({ repo: repo.trim(), active: true });
		notification.info(localize('inboxOne.enrolled', 'Inbox One is now watching {0}.', repo.trim()));
	}
}

/** Show the current inbox status: task counts by state (design 3.1). */
export class ShowInboxStatusAction extends Action2 {
	static readonly ID = 'inboxOne.showStatus';
	constructor() {
		super({
			id: ShowInboxStatusAction.ID,
			title: localize2('inboxOne.showStatus', 'Show Inbox Status'),
			category: INBOX_ONE_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const store = accessor.get(IInboxOneStore);
		const settings = accessor.get(IInboxOneSettings);
		const notification = accessor.get(INotificationService);
		await settings.initialize();
		const tasks = store.tasks.get();
		const by = (state: LogicalTaskState) => tasks.filter(t => t.state === state).length;
		const repos = settings.listEnrollments().filter(e => e.active).map(e => e.repo);
		const message = localize(
			'inboxOne.status',
			'Inbox One: watching {0} repo(s). {1} cooking, {2} decisions, {3} completed, {4} archived.',
			repos.length,
			by(LogicalTaskState.Cooking) + by(LogicalTaskState.Confirming),
			by(LogicalTaskState.Decision) + by(LogicalTaskState.Blocked),
			by(LogicalTaskState.Completed),
			by(LogicalTaskState.Archived),
		);
		notification.notify({ severity: Severity.Info, message });
	}
}

/**
 * Dev tool: inject a synthetic GitHub event through the real ingress so the
 * whole coordinator loop (gate -> admission -> dispatch -> store) can be
 * exercised and observed live without a GitHub backend.
 */
export class SimulateEventAction extends Action2 {
	static readonly ID = 'inboxOne.simulateEvent';
	constructor() {
		super({
			id: SimulateEventAction.ID,
			title: localize2('inboxOne.simulateEvent', 'Simulate GitHub Event (Dev)'),
			category: INBOX_ONE_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const ingress = accessor.get(IEventIngress);
		const settings = accessor.get(IInboxOneSettings);
		const store = accessor.get(IInboxOneStore);
		const notification = accessor.get(INotificationService);
		await settings.initialize();

		const enrolled = settings.listEnrollments().filter(e => e.active).map(e => e.repo);
		const repo = enrolled.length === 1
			? enrolled[0]
			: await quickInput.pick(enrolled.map(r => ({ label: r })), { placeHolder: localize('inboxOne.pickRepo', 'Enrolled repository') }).then(p => p?.label);
		if (!repo) {
			notification.warn(localize('inboxOne.noRepo', 'Enroll a repository first (Inbox One: Enroll Repository).'));
			return;
		}

		const kind = await quickInput.pick([
			{ label: 'Pull request opened', id: 'pr' },
			{ label: 'Issue opened', id: 'issue' },
			{ label: 'Check run failed', id: 'check' },
		], { placeHolder: localize('inboxOne.pickEvent', 'Event to simulate') });
		if (!kind) {
			return;
		}

		const n = Math.floor(Math.random() * 900 + 100);
		const before = store.tasks.get().length;
		const event = buildSyntheticEvent(kind.id!, repo, n);
		await ingress.submit(event);

		// Give the async coordinator a tick to process.
		await new Promise(r => setTimeout(r, 50));
		const after = store.tasks.get().length;
		notification.info(after > before
			? localize('inboxOne.simDispatched', 'Diffy dispatched a worker for {0} ({1} task(s) now).', repo, after)
			: localize('inboxOne.simDropped', 'Event was gated out (no new task). Check triggers/budget.'));
	}
}

/**
 * Dev tool: advance a cooking task to a decision by attaching a synthetic
 * evidence pack + a host-ranked tier, so the full decision UX (tiers, evidence,
 * Accept/Steer/Dismiss) can be exercised live without a real worker.
 */
export class SimulateWorkerResultAction extends Action2 {
	static readonly ID = 'inboxOne.simulateWorkerResult';
	constructor() {
		super({
			id: SimulateWorkerResultAction.ID,
			title: localize2('inboxOne.simulateWorkerResult', 'Simulate Worker Result (Dev)'),
			category: INBOX_ONE_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const store = accessor.get(IInboxOneStore);
		const quickInput = accessor.get(IQuickInputService);
		const notification = accessor.get(INotificationService);

		const cooking = store.tasks.get().filter(t => t.state === LogicalTaskState.Cooking);
		if (cooking.length === 0) {
			notification.warn(localize('inboxOne.noCooking', 'No cooking tasks. Simulate a GitHub event first.'));
			return;
		}
		const task = cooking.length === 1
			? cooking[0]
			: await quickInput.pick(cooking.map(t => ({ label: t.type + ' ' + t.sourceEvent.subject.id, id: t.id })), { placeHolder: localize('inboxOne.pickTask', 'Cooking task to resolve') }).then(p => cooking.find(t => t.id === p?.id));
		if (!task) {
			return;
		}

		const shaped = buildSyntheticEvidence(task);
		await store.setEvidence(task.id, {
			decisionSentence: shaped.decisionSentence,
			claims: [
				{ text: localize('inboxOne.claim1', '47/47 checks pass, incl. 3 that were red an hour ago'), receiptLink: 'https://example/run/1', rung: EvidenceRung.SingleRun },
				{ text: localize('inboxOne.claim2', 'Change limited to the expired-session retry path'), receiptLink: 'https://example/diff/1', rung: EvidenceRung.SourceLineage },
			],
			gapLine: localize('inboxOne.gap', 'Not verified: behavior under production load.'),
			freshness: { headSha: '7a61d9e', computedAt: Date.now() },
			primaryAction: shaped.primaryAction,
		});
		const ranked = rank({ blocksPeople: 2, evidenceConfidence: 0.9, recipientAffinity: 0.8, urgency: 0.6, perishability: 0.5 });
		await store.transition(task.id, TaskTrigger.EvidenceAssembled, { tier: ranked.tier, rank: ranked.rank, rankReason: ranked.reason });
		notification.notify({ severity: Severity.Info, message: localize('inboxOne.resolved', 'Landed as a {0} decision.', ranked.tier) });
	}
}

/** Dev: turn a cooking task into a Blocked decision with one recovery step (wireframes 7). */
export class SimulateWorkerBlockedAction extends Action2 {
	static readonly ID = 'inboxOne.simulateWorkerBlocked';
	constructor() {
		super({
			id: SimulateWorkerBlockedAction.ID,
			title: localize2('inboxOne.simulateWorkerBlocked', 'Simulate Worker Blocked (Dev)'),
			category: INBOX_ONE_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const store = accessor.get(IInboxOneStore);
		const quickInput = accessor.get(IQuickInputService);
		const notification = accessor.get(INotificationService);

		const cooking = store.tasks.get().filter(t => t.state === LogicalTaskState.Cooking);
		if (cooking.length === 0) {
			notification.warn(localize('inboxOne.noCooking', 'No cooking tasks. Simulate a GitHub event first.'));
			return;
		}
		const task = cooking.length === 1
			? cooking[0]
			: await quickInput.pick(cooking.map(t => ({ label: t.type + ' ' + t.sourceEvent.subject.id, id: t.id })), { placeHolder: localize('inboxOne.pickTask', 'Cooking task to resolve') }).then(p => cooking.find(t => t.id === p?.id));
		if (!task) {
			return;
		}
		await store.setEvidence(task.id, {
			decisionSentence: localize('inboxOne.blockedSentence', "Can't verify CVE reachability without the prod dependency graph"),
			claims: [{ text: localize('inboxOne.blockedClaim', 'The alert is real but reachability needs the prod lockfile'), receiptLink: 'https://example/alert/77', rung: EvidenceRung.SingleRun }],
			gapLine: localize('inboxOne.blockedGap', 'Not verified: whether the vulnerable path is reachable in production.'),
			freshness: { computedAt: Date.now() },
		});
		await store.transition(task.id, TaskTrigger.Blocker, {
			recoveryStep: localize('inboxOne.blockedRecovery', 'read access to the prod lockfile (or confirm it matches the repo lockfile).'),
		});
		notification.notify({ severity: Severity.Info, message: localize('inboxOne.blockedNotify', 'Landed as a Blocked decision.') });
	}
}

function buildSyntheticEvent(kind: string, repo: string, n: number): IIngressEvent {
	const base = { deliveryId: `sim-${kind}-${repo}-${n}-${Date.now()}`, source: EventSource.World, repo, receivedAt: Date.now() };
	switch (kind) {
		case 'issue':
			return { ...base, type: 'issues', action: 'opened', subject: { kind: 'issue', id: String(n) } };
		case 'check':
			return { ...base, type: 'check_run', action: 'failed', subject: { kind: 'check', id: `run-${n}`, attachedTo: { kind: 'pr', id: String(n) } } };
		case 'pr':
		default:
			return { ...base, type: 'pull_request', action: 'opened', subject: { kind: 'pr', id: String(n) } };
	}
}

interface IShapedEvidence {
	readonly decisionSentence: string;
	readonly primaryAction: { readonly label: string; readonly actionType: ActionType; readonly payload: unknown };
}

/** Role-faithful synthetic evidence so the dev harness demonstrates each scenario distinctly. */
function buildSyntheticEvidence(task: ILogicalTask): IShapedEvidence {
	const subject = task.sourceEvent.subject;
	const repo = task.repo;
	// A fix targets the PR the failing check attaches to; other roles use the subject.
	const displayId = subject.id;
	const prNumber = Number(subject.attachedTo?.id ?? subject.id);
	switch (task.type) {
		case 'issue-triage':
			return {
				decisionSentence: localize('inboxOne.triageReady', '5 new issues cluster into 2 themes'),
				primaryAction: { label: localize('inboxOne.createIssues', 'Create issues'), actionType: ActionType.CreateIssues, payload: { repo, issues: [{ title: `Meta-issue for #${displayId}`, body: localize('inboxOne.metaBody', 'Groups the duplicate reports under one tracking issue.'), sourceIssues: [Number(displayId)] }] } },
			};
		case 'implement-fix':
			return {
				decisionSentence: localize('inboxOne.fixReady', 'Fix for PR #{0} is green and ready', String(prNumber)),
				primaryAction: { label: localize('inboxOne.merge', 'Merge fix'), actionType: ActionType.MergePr, payload: { repo, prNumber, base: 'main', strategy: 'squash', rerunChecks: true } },
			};
		case 'code-review':
		default:
			return {
				decisionSentence: localize('inboxOne.reviewReady', 'PR #{0} is ready to approve', displayId),
				primaryAction: { label: localize('inboxOne.approve', 'Approve PR'), actionType: ActionType.ApprovePr, payload: { repo, prNumber: Number(displayId) } },
			};
	}
}

export const INBOX_ONE_ACTIONS = [EnrollRepositoryAction, ShowInboxStatusAction];
/** Dev-only simulator commands: registered only in non-stable builds so their synthetic evidence can never run in production. */
export const INBOX_ONE_DEV_ACTIONS = [SimulateEventAction, SimulateWorkerResultAction, SimulateWorkerBlockedAction];
