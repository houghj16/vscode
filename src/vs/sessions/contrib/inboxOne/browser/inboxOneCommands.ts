/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EventSource, IIngressEvent, LogicalTaskState } from '../common/inboxOneTypes.js';
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

export const INBOX_ONE_ACTIONS = [EnrollRepositoryAction, ShowInboxStatusAction];
/** Dev-only simulator commands: registered only in non-stable builds so their synthetic evidence can never run in production. */
export const INBOX_ONE_DEV_ACTIONS = [SimulateEventAction];
