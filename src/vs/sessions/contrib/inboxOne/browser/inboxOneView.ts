/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/inboxOneView.css';
import { $, clearNode } from '../../../../base/browser/dom.js';
import { autorun, constObservable, IObservable, ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { buildConfirmation } from '../common/actionConfirmation.js';
import { IActionPayloads } from '../common/actionCatalog.js';
import { IInboxOneStore, TransitionOutcome } from '../common/inboxOneStore.js';
import { TaskTrigger } from '../common/inboxOneStateMachine.js';
import { ActionType, ILogicalTask, InboxOneTier, LogicalTaskState } from '../common/inboxOneTypes.js';

interface ITierSpec {
	readonly key: string;
	readonly label: string;
	readonly match: (task: ILogicalTask) => boolean;
}

/** Sentinel selection value for the pinned Diffy coordinator entry. */
const DIFFY_SELECTION = '__diffy__';

/** Storage key for the persisted set of collapsed section keys. */
const COLLAPSED_SECTIONS_KEY = 'inboxOne.collapsedSections';

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
 * The tiered decisions inbox (design 3.1, wireframes 2). Two panes: the tiered
 * list on the left; the selected item's evidence pack on the right. Diffy is the
 * pinned first entry. Accept passes through a host-generated typed confirmation
 * (design 7.3, wireframes 16) before the transition runs.
 */
export class InboxOneView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('inboxOne.title', 'Inbox'));
	override readonly description: IObservable<string | undefined>;

	private readonly selectedTaskId: ISettableObservable<string | undefined> = observableValue('inboxOneSelected', undefined);
	/** A task referenced into the Diffy thread (steer/reopen), with the intent verb. */
	private readonly diffyReference: ISettableObservable<{ readonly taskId: string; readonly intent: 'steer' | 'reopen' } | undefined> = observableValue('inboxOneDiffyRef', undefined);
	private listEl: HTMLElement | undefined;
	private detailEl: HTMLElement | undefined;
	private confirmPanel: HTMLElement | undefined;
	/** Sections the user has collapsed (design/wireframes 6: the caret collapses a section). */
	private readonly collapsedSections = new Set<string>();

	constructor(
		@IInboxOneStore private readonly store: IInboxOneStore,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		for (const key of this.loadCollapsedSections()) {
			this.collapsedSections.add(key);
		}
		this.description = this.store.tasks.map(tasks => {
			const cooking = tasks.filter(t => t.state === LogicalTaskState.Cooking || t.state === LogicalTaskState.Confirming).length;
			const decisions = tasks.filter(t => t.state === LogicalTaskState.Decision || t.state === LogicalTaskState.Blocked).length;
			return localize('inboxOne.desc', 'Diffy - {0} need you, {1} cooking', decisions, cooking);
		});
	}

	private loadCollapsedSections(): readonly string[] {
		try {
			const raw = this.storageService.get(COLLAPSED_SECTIONS_KEY, StorageScope.APPLICATION);
			const parsed = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
		} catch {
			return [];
		}
	}

	private persistCollapsedSections(): void {
		this.storageService.store(COLLAPSED_SECTIONS_KEY, JSON.stringify([...this.collapsedSections]), StorageScope.APPLICATION, StorageTarget.USER);
	}

	render(container: HTMLElement): void {
		container.classList.add('inbox-one-view');
		const panes = container.appendChild($('.inbox-one-panes'));

		const left = panes.appendChild($('.inbox-one-left'));
		const diffy = left.appendChild($('.inbox-one-diffy'));
		diffy.appendChild($('.inbox-one-diffy-badge', undefined, '\u2726'));
		diffy.appendChild($('.inbox-one-diffy-label', undefined, localize('inboxOne.diffy', 'Diffy')));
		this._register(addClick(diffy, () => this.selectedTaskId.set(DIFFY_SELECTION, undefined)));
		this._register(autorun(reader => {
			diffy.classList.toggle('selected', this.selectedTaskId.read(reader) === DIFFY_SELECTION);
		}));
		this.listEl = left.appendChild($('.inbox-one-list'));

		this.detailEl = panes.appendChild($('.inbox-one-detail'));

		this._register(autorun(reader => {
			const tasks = this.store.tasks.read(reader);
			const selected = this.selectedTaskId.read(reader);
			this.diffyReference.read(reader);
			this.renderList(tasks, selected);
			if (selected === DIFFY_SELECTION) {
				this.renderDiffyDetail(tasks);
			} else {
				this.renderDetail(tasks.find(t => t.id === selected));
			}
		}));
	}

	/** The Diffy coordinator thread (design 3.2): watching status, on-demand brief, composer. */
	private renderDiffyDetail(tasks: readonly ILogicalTask[]): void {
		const detail = this.detailEl;
		if (!detail) {
			return;
		}
		clearNode(detail);
		this.confirmPanel = undefined;

		const repos = new Set(tasks.map(t => t.repo).filter(Boolean));
		detail.appendChild($('.inbox-one-detail-tier', undefined, localize('inboxOne.coordinator', 'COORDINATOR')));
		detail.appendChild($('h2.inbox-one-detail-title', undefined, localize('inboxOne.diffyWatching', 'Diffy - watching {0} repo(s)', repos.size)));

		const decisions = tasks.filter(t => t.state === LogicalTaskState.Decision || t.state === LogicalTaskState.Blocked);
		const cooking = tasks.filter(t => t.state === LogicalTaskState.Cooking || t.state === LogicalTaskState.Confirming);
		const autoHandled = tasks.filter(t => t.tier === InboxOneTier.Fyi && t.state === LogicalTaskState.Completed);

		const brief = detail.appendChild($('.inbox-one-diffy-brief'));
		brief.appendChild($('.inbox-one-diffy-brief-line', undefined, localize('inboxOne.briefNeed', '{0} need you: {1}', decisions.length, decisions.map(t => t.evidence?.decisionSentence ?? t.type).join('; ') || '-')));
		brief.appendChild($('.inbox-one-diffy-brief-line', undefined, localize('inboxOne.briefCooking', '{0} cooking', cooking.length)));
		brief.appendChild($('.inbox-one-diffy-brief-line', undefined, localize('inboxOne.briefAuto', '{0} auto-handled and logged', autoHandled.length)));

		const settingsLink = brief.appendChild($('a.inbox-one-claim-receipt', undefined, localize('inboxOne.openSettings', 'Coordinator settings')));
		this._register(addClick(settingsLink, () => void this.commandService.executeCommand('inboxOne.showSettings')));
		brief.appendChild($('span', undefined, '  '));
		const skillsLink = brief.appendChild($('a.inbox-one-claim-receipt', undefined, localize('inboxOne.openSkills', 'Skills & roles')));
		this._register(addClick(skillsLink, () => void this.commandService.executeCommand('inboxOne.showSkills')));

		const reference = this.diffyReference.get();
		const referencedTask = reference ? tasks.find(t => t.id === reference.taskId) : undefined;
		const composer = detail.appendChild($('.inbox-one-diffy-composer-wrap'));
		if (reference && referencedTask) {
			const chip = composer.appendChild($('.inbox-one-ref-chip'));
			chip.appendChild($('span.inbox-one-ref-chip-label', undefined, `\u27e6 ${referencedTask.evidence?.decisionSentence ?? referencedTask.type} \u27e7`));
			const remove = chip.appendChild($('span.inbox-one-ref-chip-remove', undefined, '\u2715'));
			this._register(addClick(remove, () => this.diffyReference.set(undefined, undefined)));
		}
		const composerRow = composer.appendChild($('.inbox-one-diffy-composer'));
		const input = composerRow.appendChild($('input.inbox-one-diffy-input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = reference
			? (reference.intent === 'reopen' ? localize('inboxOne.reopenPrompt', 'Reopen this and ...') : localize('inboxOne.steerPrompt', "Here's how you can make it better..."))
			: localize('inboxOne.talkToDiffy', 'Talk to Diffy...');
		if (reference?.intent === 'reopen') {
			input.value = localize('inboxOne.reopenDraft', 'Reopen this and ');
		}
		const send = composerRow.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, localize('inboxOne.send', 'Send')));
		const submit = () => {
			const text = input.value.trim();
			if (!text) {
				return;
			}
			input.value = '';
			if (reference && referencedTask) {
				this.diffyReference.set(undefined, undefined);
				void this.continueTask(referencedTask, reference.intent, text);
			} else {
				this.notificationService.info(localize('inboxOne.diffyReply', 'Diffy: {0}', this.diffyReply(text, decisions.length, cooking.length, repos.size)));
			}
		};
		this._register(addClick(send, submit));
		this._register(addKeydown(input, 'Enter', submit));
	}

	/** The reference-into-Diffy continuation (design 3.6): steer/reopen -> back to Cooking, same task. */
	private async continueTask(task: ILogicalTask, intent: 'steer' | 'reopen', message: string): Promise<void> {
		const continuationKey = `${task.id}:${intent}:${Date.now()}`;
		const trigger = intent === 'reopen' ? TaskTrigger.Reopen : TaskTrigger.Steer;
		const res = await this.store.openContinuation(task.id, trigger, continuationKey);
		if (res.outcome === TransitionOutcome.Applied && !res.fencedNoop) {
			this.selectedTaskId.set(task.id, undefined);
			this.notificationService.info(intent === 'reopen'
				? localize('inboxOne.reopened', 'Diffy reopened this - now Cooking. ({0})', message)
				: localize('inboxOne.steered', 'Diffy is re-working this with your steer - now Cooking.'));
		} else {
			this.notificationService.warn(localize('inboxOne.continueFailed', 'Could not continue this task from its current state.'));
		}
	}

	private diffyReply(prompt: string, needYou: number, cooking: number, repos: number): string {
		const lower = prompt.toLowerCase();
		if (lower.includes('brief') || lower.includes('status')) {
			return localize('inboxOne.diffyBrief', 'Across {0} repo(s): {1} need you, {2} cooking. Nothing else cleared the bar.', repos, needYou, cooking);
		}
		return localize('inboxOne.diffyAck', "Got it. I'll factor that into how I triage and dispatch.");
	}

	private renderList(tasks: readonly ILogicalTask[], selectedId: string | undefined): void {
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
			const collapsed = this.collapsedSections.has(section.key);
			const header = list.appendChild($('button.inbox-one-section-header'));
			header.classList.toggle('collapsed', collapsed);
			header.appendChild($('span.inbox-one-section-caret', undefined, collapsed ? '\u203a' : '\u2304'));
			header.appendChild($('.inbox-one-section-label', undefined, section.label));
			header.appendChild($('.inbox-one-section-count', undefined, String(items.length)));
			this._register(addClick(header, () => {
				if (this.collapsedSections.has(section.key)) {
					this.collapsedSections.delete(section.key);
				} else {
					this.collapsedSections.add(section.key);
				}
				this.persistCollapsedSections();
				this.renderList(this.store.tasks.get(), this.selectedTaskId.get());
			}));
			if (collapsed) {
				continue;
			}
			for (const task of items) {
				list.appendChild(this.renderListItem(task, section.key, task.id === selectedId));
			}
		}
	}

	private renderListItem(task: ILogicalTask, sectionKey: string, selected: boolean): HTMLElement {
		const row = $('.inbox-one-item');
		row.classList.add(`inbox-one-item-${sectionKey}`);
		if (selected) {
			row.classList.add('selected');
		}
		row.appendChild($('.inbox-one-item-title', undefined, task.evidence?.decisionSentence ?? this.fallbackTitle(task)));
		const meta = row.appendChild($('.inbox-one-item-meta'));
		if (task.repo) {
			meta.appendChild($('span.inbox-one-item-repo', undefined, task.repo));
		}
		meta.appendChild($('span.inbox-one-item-reason', undefined, task.rankReason ?? this.stateLabel(task.state)));
		if (task.state === LogicalTaskState.Cooking || task.state === LogicalTaskState.Confirming) {
			row.appendChild(this.renderCookingStages(task, true));
		}
		this._register(addClick(row, () => this.selectedTaskId.set(task.id, undefined)));
		return row;
	}

	private renderDetail(task: ILogicalTask | undefined): void {
		const detail = this.detailEl;
		if (!detail) {
			return;
		}
		clearNode(detail);

		if (!task) {
			detail.appendChild($('.inbox-one-detail-empty', undefined, localize('inboxOne.selectItem', 'Select an item to see its evidence.')));
			return;
		}

		const pack = task.evidence;
		detail.appendChild($('.inbox-one-detail-tier', undefined, `${(task.tier ?? '').toUpperCase()} - ${task.type}`));
		detail.appendChild($('h2.inbox-one-detail-title', undefined, pack?.decisionSentence ?? this.fallbackTitle(task)));
		if (task.repo) {
			detail.appendChild($('.inbox-one-detail-sub', undefined, `${task.repo}${pack?.freshness.headSha ? ' - head ' + pack.freshness.headSha : ''}`));
		}

		if (pack?.primaryAction) {
			detail.appendChild($('.inbox-one-detail-accepting', undefined, this.acceptingLine(pack.primaryAction.actionType)));
		}

		if (pack && pack.claims.length) {
			const why = detail.appendChild($('.inbox-one-detail-claims'));
			why.appendChild($('.inbox-one-detail-claims-header', undefined, localize('inboxOne.whyReady', "Why it's ready")));
			for (const claim of pack.claims) {
				const claimEl = why.appendChild($('.inbox-one-claim'));
				claimEl.appendChild($('span.inbox-one-claim-bullet', undefined, '\u2022'));
				claimEl.appendChild($('span.inbox-one-claim-text', undefined, claim.text));
				if (claim.receiptLink) {
					const link = claimEl.appendChild($('a.inbox-one-claim-receipt', undefined, localize('inboxOne.receipt', 'receipt')));
					this._register(addClick(link, () => this.openReceipt(claim.receiptLink!)));
				}
			}
		}

		if (pack?.gapLine) {
			detail.appendChild($('.inbox-one-detail-gap', undefined, pack.gapLine));
		}

		if (task.state === LogicalTaskState.Decision || task.state === LogicalTaskState.Blocked) {
			detail.appendChild(this.renderDetailActions(task));
		} else if (task.state === LogicalTaskState.Completed) {
			detail.appendChild($('.inbox-one-detail-done', undefined, localize('inboxOne.completedNote', 'Completed. History preserved.')));
			const actions = detail.appendChild($('.inbox-one-detail-actions'));
			const reopen = actions.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, localize('inboxOne.reopen', 'Reopen with Diffy')));
			this._register(addClick(reopen, () => this.referenceIntoDiffy(task, 'reopen')));
			const archive = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.archiveBtn', 'Archive')));
			this._register(addClick(archive, () => this.dismiss(task)));
		} else if (task.state === LogicalTaskState.Cooking || task.state === LogicalTaskState.Confirming) {
			detail.appendChild($('.inbox-one-detail-done', undefined, localize('inboxOne.cookingNote', 'Diffy is working on this. Evidence will land here when ready.')));
			const actions = detail.appendChild($('.inbox-one-detail-actions'));
			const open = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.openWork', 'Open')));
			this._register(addClick(open, () => this.openWorkerSession(task)));
			const cancel = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.cancelWork', 'Cancel work')));
			this._register(addClick(cancel, () => this.cancelWork(task)));
		}
	}

	/**
	 * The three cooking stages (wireframes 6): Triggered -> Doing work ->
	 * Assembling evidence. Shown in the left list preview; `compact` drops the
	 * role/elapsed meta line for the tighter row layout.
	 */
	private renderCookingStages(task: ILogicalTask, compact = false): HTMLElement {
		const wrap = $('.inbox-one-cooking');
		if (compact) {
			wrap.classList.add('compact');
		}
		const active = task.state === LogicalTaskState.Confirming ? 2 : 1;
		const labels = [
			localize('inboxOne.stageTriggered', 'Triggered'),
			localize('inboxOne.stageDoing', 'Doing work'),
			localize('inboxOne.stageAssembling', 'Assembling evidence'),
		];
		const stages = wrap.appendChild($('.inbox-one-cooking-stages'));
		labels.forEach((label, i) => {
			if (i > 0) {
				stages.appendChild($(`.inbox-one-cooking-rail${i <= active ? '.filled' : ''}`));
			}
			const state = i < active ? 'done' : i === active ? 'active' : 'pending';
			const stage = stages.appendChild($(`.inbox-one-cooking-stage.${state}`));
			stage.appendChild($('span.inbox-one-cooking-dot', undefined, state === 'pending' ? '\u25cb' : '\u25cf'));
			stage.appendChild($('span', undefined, label));
		});
		if (!compact) {
			const attempt = task.attempts[task.currentAttempt];
			const elapsed = formatElapsed(Date.now() - (attempt?.startedAt ?? task.createdAt));
			wrap.appendChild($('.inbox-one-cooking-meta', undefined, `\u25b2 ${task.type} \u00b7 ${elapsed}`));
		}
		return wrap;
	}

	/** Opens the live worker session backing the current attempt (wireframes 6: [ Open ]). */
	private openWorkerSession(task: ILogicalTask): void {
		const ref = task.attempts[task.currentAttempt]?.sessionRef;
		if (!ref || ref.startsWith('inboxone-pending:') || ref.startsWith('inboxone-stub:')) {
			this.notificationService.info(localize('inboxOne.noWorkerYet', 'The worker session is still starting - no host connected yet.'));
			return;
		}
		try {
			void this.openerService.open(URI.parse(ref));
		} catch {
			this.notificationService.info(localize('inboxOne.noWorkerYet', 'The worker session is still starting - no host connected yet.'));
		}
	}

	/** Steer (design 3.4): item-initiated, Diffy-mediated -> open Diffy scoped to this item. */
	private steer(task: ILogicalTask): void {
		this.referenceIntoDiffy(task, 'steer');
	}

	/** The reference-into-Diffy transition (design 3.6): select Diffy with the item attached. */
	private referenceIntoDiffy(task: ILogicalTask, intent: 'steer' | 'reopen'): void {
		this.diffyReference.set({ taskId: task.id, intent }, undefined);
		this.selectedTaskId.set(DIFFY_SELECTION, undefined);
	}

	private async cancelWork(task: ILogicalTask): Promise<void> {
		await this.store.transition(task.id, TaskTrigger.CancelWork, { archiveReason: 'cancelled from inbox' });
	}

	private renderDetailActions(task: ILogicalTask): HTMLElement {
		const actions = $('.inbox-one-detail-actions');
		const primaryLabel = task.evidence?.primaryAction?.label ?? localize('inboxOne.accept', 'Accept');
		const accept = actions.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, `${primaryLabel} \u25b8`));
		this._register(addClick(accept, () => this.confirmAndAccept(task)));

		const steer = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.steer', 'Steer')));
		this._register(addClick(steer, () => this.steer(task)));

		const dismiss = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.dismiss', 'Dismiss')));
		this._register(addClick(dismiss, () => this.dismiss(task)));
		return actions;
	}

	/** Renders the host-generated typed confirmation inline, then executes on confirm (design 7.3). */
	private confirmAndAccept(task: ILogicalTask): void {
		const detail = this.detailEl;
		const action = task.evidence?.primaryAction;
		if (!detail || !action) {
			void this.accept(task);
			return;
		}
		this.confirmPanel?.remove();
		const confirmation = buildConfirmation(action.actionType, action.payload as IActionPayloads[typeof action.actionType]);
		const panel = detail.appendChild($('.inbox-one-confirm'));
		this.confirmPanel = panel;
		if (confirmation.highlight) {
			panel.classList.add('irreversible');
		}
		panel.appendChild($('.inbox-one-confirm-title', undefined, localize('inboxOne.confirmTitle', 'Confirm - {0}', action.label)));
		const effects = panel.appendChild($('.inbox-one-confirm-effects'));
		effects.appendChild($('.inbox-one-confirm-effects-label', undefined, localize('inboxOne.thisWill', 'This will:')));
		for (const line of confirmation.effectLines) {
			effects.appendChild($('.inbox-one-confirm-effect', undefined, `\u2022 ${line}`));
		}
		panel.appendChild($('.inbox-one-confirm-reversibility', undefined, confirmation.reversibilityLine));
		if (task.evidence?.gapLine) {
			panel.appendChild($('.inbox-one-confirm-gap', undefined, task.evidence.gapLine));
		}
		const buttons = panel.appendChild($('.inbox-one-confirm-buttons'));
		const cancel = buttons.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.cancel', 'Cancel')));
		this._register(addClick(cancel, () => panel.remove()));
		const go = buttons.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, action.label));
		this._register(addClick(go, () => { panel.remove(); void this.accept(task); }));
	}

	private acceptingLine(actionType: ActionType): string {
		switch (actionType) {
			case ActionType.ApprovePr: return localize('inboxOne.acceptingApprove', 'Accepting: approves the PR (you still control the merge).');
			case ActionType.MergePr: return localize('inboxOne.acceptingMerge', 'Accepting: merges the PR and reruns checks.');
			case ActionType.CreateIssues: return localize('inboxOne.acceptingIssues', 'Accepting: creates the grouped meta-issues.');
			default: return localize('inboxOne.acceptingGeneric', 'Accepting runs the typed action.');
		}
	}

	private async accept(task: ILogicalTask): Promise<void> {
		const attemptIndex = task.attempts[task.currentAttempt]?.index ?? 0;
		const revision = task.evidence?.revision;
		const res = await this.store.transition(task.id, TaskTrigger.Accept, undefined, { expected: { attemptIndex, evidenceRevision: revision } });
		if (res.task) {
			await this.store.transition(task.id, TaskTrigger.ConfirmSucceeded);
			this.notificationService.info(localize('inboxOne.accepted', 'Accepted: {0}', task.evidence?.primaryAction?.label ?? task.type));
		} else {
			this.notificationService.warn(localize('inboxOne.staleAccept', 'This decision changed - re-verify before accepting.'));
		}
	}

	private async dismiss(task: ILogicalTask): Promise<void> {
		await this.store.transition(task.id, TaskTrigger.Dismiss, { archiveReason: 'dismissed from inbox' });
	}

	private openReceipt(link: string): void {
		try {
			this.openerService.open(URI.parse(link));
		} catch {
			this.notificationService.info(localize('inboxOne.receiptLink', 'Receipt: {0}', link));
		}
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

/** Human-legible elapsed time (no telemetry chrome): "just now", "6m", "2h". */
function formatElapsed(ms: number): string {
	const mins = Math.floor(ms / 60000);
	if (mins < 1) { return localize('inboxOne.justNow', 'just now'); }
	if (mins < 60) { return localize('inboxOne.minutes', '{0}m', mins); }
	return localize('inboxOne.hours', '{0}h', Math.floor(mins / 60));
}

function addKeydown(el: HTMLElement, key: string, handler: () => void): { dispose(): void } {
	const listener = (e: KeyboardEvent) => { if (e.key === key) { e.preventDefault(); handler(); } };
	el.addEventListener('keydown', listener);
	return { dispose: () => el.removeEventListener('keydown', listener) };
}
