/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/inboxOneView.css';
import { $, clearNode } from '../../../../base/browser/dom.js';
import { autorun, constObservable, IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { TaskTrigger } from '../common/inboxOneStateMachine.js';
import { ILogicalTask, InboxOneTier, LogicalTaskState } from '../common/inboxOneTypes.js';

interface ITierSpec {
	readonly key: string;
	readonly label: string;
	readonly match: (task: ILogicalTask) => boolean;
}

/** The inbox sections in display order (design 3.1). */
const SECTIONS: readonly ITierSpec[] = [
	{ key: 'critical', label: localize('inboxOne.critical', 'CRITICAL'), match: t => t.state === LogicalTaskState.Decision && t.tier === InboxOneTier.Critical },
	{ key: 'urgent', label: localize('inboxOne.urgent', 'URGENT'), match: t => (t.state === LogicalTaskState.Decision && t.tier === InboxOneTier.Urgent) || t.state === LogicalTaskState.Blocked },
	{ key: 'fyi', label: localize('inboxOne.fyi', 'FYI'), match: t => t.state === LogicalTaskState.Decision && (t.tier === InboxOneTier.Fyi || t.tier === undefined) },
	{ key: 'cooking', label: localize('inboxOne.cooking', 'COOKING'), match: t => t.state === LogicalTaskState.Cooking || t.state === LogicalTaskState.Confirming },
	{ key: 'completed', label: localize('inboxOne.completed', 'COMPLETED'), match: t => t.state === LogicalTaskState.Completed },
	{ key: 'archive', label: localize('inboxOne.archive', 'ARCHIVE'), match: t => t.state === LogicalTaskState.Archived },
];

/**
 * The tiered decisions inbox (design 3.1, wireframes 2). Renders LogicalTasks
 * grouped into decision tiers plus Cooking/Completed/Archive, live from the
 * store. Diffy is the pinned first entry. Decision items expose the
 * worker-authored primary action plus Steer/Dismiss.
 */
export class InboxOneView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('inboxOne.title', 'Inbox One'));
	override readonly description: IObservable<string | undefined>;

	private listEl: HTMLElement | undefined;

	constructor(
		@IInboxOneStore private readonly store: IInboxOneStore,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.description = this.store.tasks.map(tasks => {
			const cooking = tasks.filter(t => t.state === LogicalTaskState.Cooking || t.state === LogicalTaskState.Confirming).length;
			const decisions = tasks.filter(t => t.state === LogicalTaskState.Decision || t.state === LogicalTaskState.Blocked).length;
			return localize('inboxOne.desc', 'Diffy - {0} need you, {1} cooking', decisions, cooking);
		});
	}

	render(container: HTMLElement): void {
		container.classList.add('inbox-one-view');
		const diffy = container.appendChild($('.inbox-one-diffy'));
		diffy.appendChild($('.inbox-one-diffy-badge', undefined, '\u2726'));
		diffy.appendChild($('.inbox-one-diffy-label', undefined, localize('inboxOne.diffy', 'Diffy')));

		this.listEl = container.appendChild($('.inbox-one-list'));
		this._register(autorun(reader => {
			const tasks = this.store.tasks.read(reader);
			this.renderList(tasks);
		}));
	}

	private renderList(tasks: readonly ILogicalTask[]): void {
		const list = this.listEl;
		if (!list) {
			return;
		}
		clearNode(list);

		if (tasks.length === 0) {
			const empty = list.appendChild($('.inbox-one-empty'));
			empty.appendChild($('.inbox-one-empty-title', undefined, localize('inboxOne.allClear', "You're all clear.")));
			empty.appendChild($('.inbox-one-empty-sub', undefined, localize('inboxOne.watching', 'Diffy is watching; new decisions land here.')));
			return;
		}

		for (const section of SECTIONS) {
			const items = tasks.filter(section.match);
			if (items.length === 0) {
				continue;
			}
			const header = list.appendChild($('.inbox-one-section-header'));
			header.appendChild($('.inbox-one-section-label', undefined, section.label));
			header.appendChild($('.inbox-one-section-count', undefined, String(items.length)));
			for (const task of items) {
				list.appendChild(this.renderItem(task, section.key));
			}
		}
	}

	private renderItem(task: ILogicalTask, sectionKey: string): HTMLElement {
		const row = $('.inbox-one-item');
		row.classList.add(`inbox-one-item-${sectionKey}`);

		const title = task.evidence?.decisionSentence ?? this.fallbackTitle(task);
		row.appendChild($('.inbox-one-item-title', undefined, title));

		const meta = row.appendChild($('.inbox-one-item-meta'));
		if (task.repo) {
			meta.appendChild($('span.inbox-one-item-repo', undefined, task.repo));
		}
		if (task.rankReason) {
			meta.appendChild($('span.inbox-one-item-reason', undefined, task.rankReason));
		} else {
			meta.appendChild($('span.inbox-one-item-reason', undefined, this.stateLabel(task.state)));
		}

		if (task.state === LogicalTaskState.Decision || task.state === LogicalTaskState.Blocked) {
			row.appendChild(this.renderActions(task));
		} else if (task.state === LogicalTaskState.Cooking) {
			row.appendChild($('.inbox-one-item-stage', undefined, localize('inboxOne.cookingStage', 'Working...')));
		}
		return row;
	}

	private renderActions(task: ILogicalTask): HTMLElement {
		const actions = $('.inbox-one-item-actions');
		const primaryLabel = task.evidence?.primaryAction?.label ?? localize('inboxOne.accept', 'Accept');
		const accept = actions.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, primaryLabel));
		this._register(addClick(accept, () => this.accept(task)));

		const steer = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.steer', 'Steer')));
		this._register(addClick(steer, () => this.notificationService.info(localize('inboxOne.steerTodo', 'Steer opens Diffy scoped to this item (coming next).'))));

		const dismiss = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.dismiss', 'Dismiss')));
		this._register(addClick(dismiss, () => this.dismiss(task)));
		return actions;
	}

	private async accept(task: ILogicalTask): Promise<void> {
		const res = await this.store.transition(task.id, TaskTrigger.Accept);
		if (res.task) {
			await this.store.transition(task.id, TaskTrigger.ConfirmSucceeded);
			this.notificationService.info(localize('inboxOne.accepted', 'Accepted: {0}', task.evidence?.primaryAction?.label ?? task.type));
		}
	}

	private async dismiss(task: ILogicalTask): Promise<void> {
		await this.store.transition(task.id, TaskTrigger.Dismiss, { archiveReason: 'dismissed from inbox' });
	}

	private fallbackTitle(task: ILogicalTask): string {
		const subject = task.sourceEvent.subject;
		return localize('inboxOne.itemTitle', '{0} {1} ({2})', task.type, subject.kind, subject.id);
	}

	private stateLabel(state: LogicalTaskState): string {
		switch (state) {
			case LogicalTaskState.Cooking: return localize('inboxOne.stateCooking', 'cooking');
			case LogicalTaskState.Confirming: return localize('inboxOne.stateConfirming', 'confirming');
			case LogicalTaskState.Completed: return localize('inboxOne.stateCompleted', 'completed');
			case LogicalTaskState.Archived: return localize('inboxOne.stateArchived', 'archived');
			default: return '';
		}
	}

	layout(_width: number, _height: number): void { }
}

function addClick(el: HTMLElement, handler: () => void): { dispose(): void } {
	const listener = (e: Event) => { e.preventDefault(); e.stopPropagation(); handler(); };
	el.addEventListener('click', listener);
	return { dispose: () => el.removeEventListener('click', listener) };
}
