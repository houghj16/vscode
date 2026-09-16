/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/inboxOneView.css';
import { $, addDisposableListener, clearNode } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { fromNow } from '../../../../base/common/date.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, IObservable, ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import Severity from '../../../../base/common/severity.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { SessionStatusIcon } from '../../../browser/sessionStatusIcon.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { buildConfirmation } from '../common/actionConfirmation.js';
import { IActionPayloads } from '../common/actionCatalog.js';
import { IInboxOneStore, TransitionOutcome } from '../common/inboxOneStore.js';
import { TaskTrigger } from '../common/inboxOneStateMachine.js';
import { GestureKind, ILogicalTask, InboxOneTier, LogicalTaskState } from '../common/inboxOneTypes.js';
import { composeSteerRelay } from '../common/workerBrief.js';
import { getApprovalButtonLabel, getApprovalDialogTitle, getTaskAttentionGroup, getTaskConsequence, getTaskSessionStatus, getTaskStateLabel, InboxOneAttentionGroup, matchesTaskFilter } from './inboxOnePresentation.js';
import { IInboxOneSessionLauncher } from './inboxOneSessionLauncher.js';
import { IInboxOneNavigator } from './inboxOneNavigator.js';

interface ITierSpec {
	readonly key: InboxOneAttentionGroup;
	readonly label: string;
	readonly match: (task: ILogicalTask) => boolean;
}

/** Sentinel selection value for the pinned Diffy coordinator entry. */
const DIFFY_SELECTION = '__diffy__';

/** Storage key for the persisted set of collapsed section keys. */
const COLLAPSED_SECTIONS_KEY = 'inboxOne.collapsedSections';

/** Attention-oriented inbox sections in scanning order. */
const SECTIONS: readonly ITierSpec[] = [
	{ key: InboxOneAttentionGroup.NeedsAttention, label: localize('inboxOne.needsAttention', "Needs attention"), match: t => getTaskAttentionGroup(t) === InboxOneAttentionGroup.NeedsAttention },
	{ key: InboxOneAttentionGroup.InProgress, label: localize('inboxOne.inProgress', "In progress"), match: t => getTaskAttentionGroup(t) === InboxOneAttentionGroup.InProgress },
	{ key: InboxOneAttentionGroup.CompleteUnread, label: localize('inboxOne.completeUnread', "Complete · unread"), match: t => getTaskAttentionGroup(t) === InboxOneAttentionGroup.CompleteUnread },
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
	/** The task whose inline steer/reopen composer is open in the detail pane, with the intent verb. */
	private readonly inlineCompose: ISettableObservable<{ readonly taskId: string; readonly intent: 'steer' | 'reopen' } | undefined> = observableValue('inboxOneInlineCompose', undefined);
	/** Draft text for the inline composer, kept off the observable so re-renders don't wipe it. */
	private inlineComposeDraft = '';
	private listEl: HTMLElement | undefined;
	private detailEl: HTMLElement | undefined;
	/** A task whose list row should be scrolled into view on the next render (deep-link reveal). */
	private pendingScrollTaskId: string | undefined;
	/** Sections the user has collapsed. */
	private readonly collapsedSections = new Set<string>();
	private readonly collapsedSectionsVersion = observableValue('inboxOneCollapsedSectionsVersion', 0);
	private readonly filterText = observableValue('inboxOneFilterText', '');
	private readonly scopeRepo: ISettableObservable<string | undefined> = observableValue('inboxOneScope', undefined);
	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		@IInboxOneStore private readonly store: IInboxOneStore,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IInboxOneSessionLauncher private readonly sessionLauncher: IInboxOneSessionLauncher,
		@IInboxOneNavigator private readonly navigator: IInboxOneNavigator,
		@IDialogService private readonly dialogService: IDialogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		for (const key of this.loadCollapsedSections()) {
			this.collapsedSections.add(key);
		}
		// A notification (or any caller) can ask us to open + focus a specific item.
		this._register(this.navigator.onDidRequestReveal(() => {
			const taskId = this.navigator.consumePendingReveal();
			if (taskId) {
				this.selectAndReveal(taskId);
			}
		}));
		this.description = this.store.tasks.map(tasks => {
			const needsAttention = tasks.filter(t => getTaskAttentionGroup(t) === InboxOneAttentionGroup.NeedsAttention).length;
			const inProgress = tasks.filter(t => getTaskAttentionGroup(t) === InboxOneAttentionGroup.InProgress).length;
			const completeUnread = tasks.filter(t => getTaskAttentionGroup(t) === InboxOneAttentionGroup.CompleteUnread).length;
			return localize('inboxOne.desc', '{0} needs attention · {1} in progress · {2} complete · unread', needsAttention, inProgress, completeUnread);
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
		const filterContainer = left.appendChild($('.inbox-one-filter'));
		const filterInput = this._register(new InputBox(filterContainer, undefined, {
			ariaLabel: localize('inboxOne.filterAriaLabel', "Filter Inbox tasks"),
			placeholder: localize('inboxOne.filterPlaceholder', "Filter tasks"),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this._register(filterInput.onDidChange(value => this.filterText.set(value, undefined)));
		const scopeEl = left.appendChild($('.inbox-one-scope'));
		const diffy = left.appendChild($('.inbox-one-diffy'));
		diffy.appendChild($('.inbox-one-diffy-badge', undefined, '\u2726'));
		diffy.appendChild($('.inbox-one-diffy-label', undefined, localize('inboxOne.diffy', 'Diffy')));
		this._register(addClick(diffy, () => this.selectedTaskId.set(DIFFY_SELECTION, undefined)));
		this._register(autorun(reader => {
			diffy.classList.toggle('selected', this.selectedTaskId.read(reader) === DIFFY_SELECTION);
		}));
		this.listEl = left.appendChild($('.inbox-one-list'));
		this.listEl.setAttribute('role', 'region');
		this.listEl.setAttribute('aria-label', localize('inboxOne.taskListAriaLabel', "Inbox tasks"));

		this.detailEl = panes.appendChild($('.inbox-one-detail'));
		this.detailEl.setAttribute('aria-live', 'polite');

		this._register(autorun(reader => {
			this.renderDisposables.clear();
			const tasks = this.store.tasks.read(reader);
			const selected = this.selectedTaskId.read(reader);
			const scope = this.scopeRepo.read(reader);
			const filter = this.filterText.read(reader);
			this.collapsedSectionsVersion.read(reader);
			this.inlineCompose.read(reader);
			this.renderScope(scopeEl, tasks, scope);
			const scoped = tasks.filter(t => (!scope || t.repo === scope) && matchesTaskFilter(t, filter, this.listTitle(t)));
			if (selected === DIFFY_SELECTION) {
				this.renderList(scoped, selected);
				this.renderDiffyDetail(tasks);
			} else {
				const selectedTask = scoped.find(t => t.id === selected)
					?? scoped.find(t => getTaskAttentionGroup(t) === InboxOneAttentionGroup.NeedsAttention)
					?? scoped[0];
				this.renderList(scoped, selectedTask?.id);
				this.renderDetail(selectedTask);
			}
		}));

		// Apply a reveal requested before this view rendered (e.g. a notification's
		// "Open" that created the view), so it focuses the linked item on first show.
		const pending = this.navigator.consumePendingReveal();
		if (pending) {
			this.selectAndReveal(pending);
		}
	}

	/**
	 * Opens and focuses a specific task: expands its (possibly collapsed) section,
	 * selects it so its evidence shows on the right, and scrolls the row into view.
	 * Used by the notification "Open" deep-link.
	 */
	private selectAndReveal(taskId: string): void {
		const task = this.store.getTask(taskId);
		if (task) {
			const section = SECTIONS.find(s => s.match(task));
			if (section && this.collapsedSections.has(section.key)) {
				this.collapsedSections.delete(section.key);
				this.persistCollapsedSections();
			}
		}
		this.pendingScrollTaskId = taskId;
		this.selectedTaskId.set(taskId, undefined);
	}

	/** Scopes the inbox to one enrolled repository or all repositories. */
	private renderScope(container: HTMLElement, tasks: readonly ILogicalTask[], scope: string | undefined): void {
		clearNode(container);
		const repos = Array.from(new Set(tasks.map(t => t.repo).filter((r): r is string => !!r))).sort();
		if (repos.length < 2) {
			container.style.display = 'none';
			return;
		}
		container.style.display = '';
		container.appendChild($('span.inbox-one-scope-label', undefined, localize('inboxOne.scopeLabel', 'Showing')));
		const select = container.appendChild($('select.inbox-one-scope-select')) as HTMLSelectElement;
		const allOpt = select.appendChild($('option')) as HTMLOptionElement;
		allOpt.value = '';
		allOpt.textContent = localize('inboxOne.scopeAll', 'all repos');
		allOpt.selected = !scope;
		for (const repo of repos) {
			const opt = select.appendChild($('option')) as HTMLOptionElement;
			opt.value = repo;
			opt.textContent = repo;
			opt.selected = scope === repo;
		}
		this.renderDisposables.add(addDisposableListener(select, 'change', () => {
			this.scopeRepo.set(select.value || undefined, undefined);
		}));
	}

	/** The Diffy coordinator thread (design 3.2): watching status, on-demand brief, composer. */
	private renderDiffyDetail(tasks: readonly ILogicalTask[]): void {
		const detail = this.detailEl;
		if (!detail) {
			return;
		}
		clearNode(detail);

		const repos = new Set(tasks.map(t => t.repo).filter(Boolean));
		detail.appendChild($('.inbox-one-detail-state', undefined, localize('inboxOne.coordinator', "Coordinator")));
		detail.appendChild($('h2.inbox-one-detail-title', undefined, localize('inboxOne.diffyWatching', 'Diffy - watching {0} repo(s)', repos.size)));

		const decisions = tasks.filter(t => t.state === LogicalTaskState.Decision || t.state === LogicalTaskState.Blocked);
		const cooking = tasks.filter(t => t.state === LogicalTaskState.Cooking || t.state === LogicalTaskState.Confirming);
		const autoHandled = tasks.filter(t => t.tier === InboxOneTier.Fyi && t.state === LogicalTaskState.Completed);

		const brief = detail.appendChild($('.inbox-one-diffy-brief'));
		brief.appendChild($('.inbox-one-diffy-brief-line', undefined, localize('inboxOne.briefNeed', '{0} need you', decisions.length)));
		brief.appendChild($('.inbox-one-diffy-brief-line', undefined, localize('inboxOne.briefCooking', '{0} cooking', cooking.length)));
		brief.appendChild($('.inbox-one-diffy-brief-line', undefined, localize('inboxOne.briefAuto', '{0} auto-handled and logged', autoHandled.length)));

		const settingsLink = brief.appendChild($('a.inbox-one-claim-receipt', { href: '#' }, localize('inboxOne.openSettings', 'Coordinator settings')));
		this.renderDisposables.add(addClick(settingsLink, () => void this.commandService.executeCommand('inboxOne.showSettings')));
		brief.appendChild($('span', undefined, '  '));
		const skillsLink = brief.appendChild($('a.inbox-one-claim-receipt', { href: '#' }, localize('inboxOne.openSkills', 'Skills & roles')));
		this.renderDisposables.add(addClick(skillsLink, () => void this.commandService.executeCommand('inboxOne.showSkills')));

		const composer = detail.appendChild($('.inbox-one-diffy-composer-wrap'));
		const composerRow = composer.appendChild($('.inbox-one-diffy-composer'));
		const input = composerRow.appendChild($('input.inbox-one-diffy-input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = localize('inboxOne.talkToDiffy', 'Talk to Diffy...');
		const submit = () => {
			const text = input.value.trim();
			if (!text) {
				return;
			}
			input.value = '';
			this.notificationService.info(localize('inboxOne.diffyReply', 'Diffy: {0}', this.diffyReply(text, decisions.length, cooking.length, repos.size)));
		};
		this.createButton(composerRow, localize('inboxOne.send', "Send"), true, submit);
		this.renderDisposables.add(addKeydown(input, 'Enter', submit));
	}

	/** The reference-into-Diffy continuation (design 3.6, 2.4): steer/reopen -> relay the
	 * user's instruction into the warm worker session and re-open the task (same session). */
	private async continueTask(task: ILogicalTask, intent: 'steer' | 'reopen', message: string): Promise<void> {
		const continuationKey = `${task.id}:${intent}:${Date.now()}`;
		const trigger = intent === 'reopen' ? TaskTrigger.Reopen : TaskTrigger.Steer;
		// Record the user's steering/correction verbatim as a gesture, so the full
		// steering history (not just the gesture kind) reaches the distiller when the
		// task later resolves (design 6.2). Reopen is a steer on a completed result.
		void this.store.recordGesture({ taskId: task.id, kind: GestureKind.Steer, note: message, timestamp: Date.now() });
		// Diffy relays the instruction into the SAME worker session (warm context,
		// technical spec 2.4). Carry the ref into the new attempt so the session
		// stays owned by the task (Open works, and its next finish re-lands here).
		const ref = task.attempts[task.currentAttempt]?.sessionRef;
		const relayable = !!ref && !ref.startsWith('inboxone-pending:') && !ref.startsWith('inboxone-stub:');
		// Relay the user's instruction plus an explicit "emit a fresh result" reminder,
		// so the worker always re-emits an updated card instead of answering in prose
		// (which would leave the stale previous block to be re-landed).
		const relayed = relayable ? await this.sessionLauncher.relay(ref!, composeSteerRelay(message)) : false;
		const res = await this.store.openContinuation(task.id, trigger, continuationKey, undefined, relayed ? { attemptSessionRef: ref } : undefined);
		if (res.outcome === TransitionOutcome.Applied && !res.fencedNoop) {
			this.selectedTaskId.set(task.id, undefined);
			this.notificationService.info(!relayed
				? localize('inboxOne.continuedNoWorker', 'Diffy re-opened this - now Cooking. (No live worker session to relay into; it will re-dispatch.)')
				: intent === 'reopen'
					? localize('inboxOne.reopened', 'Diffy reopened this and sent the worker your note - now Cooking.')
					: localize('inboxOne.steered', 'Diffy sent your steer to the worker - now Cooking.'));
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
			const sectionId = `inbox-one-section-${section.key}`;
			const header = list.appendChild($('button.inbox-one-section-header'));
			header.classList.toggle('collapsed', collapsed);
			header.setAttribute('type', 'button');
			header.setAttribute('aria-expanded', String(!collapsed));
			header.setAttribute('aria-controls', sectionId);
			const chevron = header.appendChild(renderIcon(collapsed ? Codicon.chevronRight : Codicon.chevronDown));
			chevron.classList.add('inbox-one-section-caret');
			chevron.setAttribute('aria-hidden', 'true');
			header.appendChild($('.inbox-one-section-label', undefined, section.label));
			header.appendChild($('.inbox-one-section-count', undefined, String(items.length)));
			this.renderDisposables.add(addClick(header, () => {
				if (this.collapsedSections.has(section.key)) {
					this.collapsedSections.delete(section.key);
				} else {
					this.collapsedSections.add(section.key);
				}
				this.persistCollapsedSections();
				this.collapsedSectionsVersion.set(this.collapsedSectionsVersion.get() + 1, undefined);
			}));
			if (collapsed) {
				continue;
			}
			const sectionItems = list.appendChild($('.inbox-one-section-items'));
			sectionItems.id = sectionId;
			sectionItems.setAttribute('role', 'list');
			sectionItems.setAttribute('aria-label', section.label);
			for (const task of items) {
				sectionItems.appendChild(this.renderListItem(task, task.id === selectedId));
			}
		}
	}

	private renderListItem(task: ILogicalTask, selected: boolean): HTMLElement {
		const row = $('.inbox-one-item');
		row.setAttribute('role', 'listitem');
		row.tabIndex = 0;
		row.setAttribute('aria-current', selected ? 'true' : 'false');
		if (selected) {
			row.classList.add('selected');
		}
		const titleText = this.listTitle(task);
		const title = row.appendChild($('.inbox-one-item-title', undefined, titleText));
		this.renderDisposables.add(this.hoverService.setupDelayedHover(title, { content: titleText }));

		const context = row.appendChild($('.inbox-one-item-context'));
		if (task.repo) {
			context.appendChild($('span.inbox-one-item-repo', undefined, task.repo));
		}
		if (task.repo) {
			context.appendChild($('span.inbox-one-item-separator', { 'aria-hidden': 'true' }, '\u00b7'));
		}
		context.appendChild($('span.inbox-one-item-recency', undefined, fromNow(task.updatedAt, true)));

		const statusRow = row.appendChild($('.inbox-one-item-status'));
		const statusIconContainer = statusRow.appendChild($('.inbox-one-item-status-icon'));
		statusIconContainer.setAttribute('aria-hidden', 'true');
		const statusIcon = this.renderDisposables.add(this.instantiationService.createInstance(SessionStatusIcon, statusIconContainer));
		statusIcon.setStatus(getTaskSessionStatus(task), task.state !== LogicalTaskState.Completed, task.state === LogicalTaskState.Archived);
		const state = getTaskStateLabel(task);
		statusRow.appendChild($('span.inbox-one-item-state', undefined, state));
		const consequence = getTaskConsequence(task);
		if (consequence) {
			statusRow.appendChild($('span.inbox-one-item-separator', { 'aria-hidden': 'true' }, '\u00b7'));
			statusRow.appendChild($('span.inbox-one-item-consequence', undefined, consequence));
		}

		if (getTaskAttentionGroup(task) === InboxOneAttentionGroup.NeedsAttention) {
			const actions = row.appendChild($('.inbox-one-item-actions'));
			this.renderDisposables.add(addDisposableListener(actions, 'click', event => event.stopPropagation()));
			this.renderDisposables.add(addDisposableListener(actions, 'keydown', event => event.stopPropagation()));
			this.createButton(actions, localize('inboxOne.skip', "Skip"), false, () => void this.skip(task));
			if (task.evidence?.primaryAction) {
				this.createButton(actions, localize('inboxOne.approve', "Approve"), true, () => void this.confirmAndAccept(task));
			} else {
				this.createButton(actions, localize('inboxOne.review', "Review"), true, () => this.selectedTaskId.set(task.id, undefined));
			}
		}

		row.setAttribute('aria-label', [titleText, task.repo, fromNow(task.updatedAt, true), state, consequence].filter(Boolean).join(', '));
		this.renderDisposables.add(addActivation(row, () => this.selectedTaskId.set(task.id, undefined)));
		if (this.pendingScrollTaskId === task.id) {
			this.pendingScrollTaskId = undefined;
			queueMicrotask(() => row.scrollIntoView({ block: 'nearest' }));
		}
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
		const header = detail.appendChild($('.inbox-one-detail-header'));
		const heading = header.appendChild($('.inbox-one-detail-heading'));
		heading.appendChild($('.inbox-one-detail-state', undefined, this.detailStateLabel(task)));
		const titleText = this.listTitle(task);
		const title = heading.appendChild($('h2.inbox-one-detail-title', undefined, titleText));
		this.renderDisposables.add(this.hoverService.setupDelayedHover(title, { content: titleText }));
		const openSession = header.appendChild($('a.inbox-one-open-session', { href: '#' }, localize('inboxOne.openFullSession', "Open full session")));
		this.renderDisposables.add(addClick(openSession, () => this.openWorkerSession(task)));

		const meta = detail.appendChild($('.inbox-one-detail-meta'));
		if (task.repo) {
			meta.appendChild($('span.inbox-one-detail-repo', undefined, task.repo));
			meta.appendChild($('span.inbox-one-detail-separator', { 'aria-hidden': 'true' }, '\u00b7'));
		}
		meta.appendChild($('span', undefined, localize('inboxOne.updated', "Updated {0}", fromNow(task.updatedAt, true))));

		const brief = detail.appendChild($('section.inbox-one-decision-brief'));
		brief.setAttribute('aria-label', localize('inboxOne.decisionBrief', "Decision brief"));
		const proposal = getTaskConsequence(task) ?? pack?.customAsk ?? pack?.decisionSentence ?? getTaskStateLabel(task);
		brief.appendChild($('h3.inbox-one-decision-title', undefined, proposal));

		if (pack?.decisionSentence) {
			brief.appendChild($('p.inbox-one-decision-summary', undefined, pack.decisionSentence));
		} else if (task.state === LogicalTaskState.Cooking || task.state === LogicalTaskState.Confirming) {
			brief.appendChild($('p.inbox-one-decision-summary', undefined, localize('inboxOne.cookingNote', "The agent is working on this task. Evidence will appear here when it is ready.")));
		} else if (task.state === LogicalTaskState.Blocked) {
			brief.appendChild($('p.inbox-one-decision-summary', undefined, task.recoveryStep ?? localize('inboxOne.blockedGeneric', "The agent needs a human-only fact or permission to continue.")));
		}

		if (pack?.gapLine) {
			const fyi = brief.appendChild($('.inbox-one-decision-fyi'));
			fyi.appendChild($('span.inbox-one-decision-fyi-label', undefined, localize('inboxOne.fyiLabel', "FYI:")));
			fyi.appendChild($('span', undefined, pack.gapLine));
		}

		if (pack && pack.claims.length) {
			const review = brief.appendChild($('details.inbox-one-review'));
			const reviewSummary = review.appendChild($('summary.inbox-one-review-summary', undefined, localize('inboxOne.review', "Review")));
			reviewSummary.setAttribute('aria-label', localize('inboxOne.reviewAriaLabel', "Review decisions and evidence"));
			const decisions = review.appendChild($('.inbox-one-review-section'));
			decisions.appendChild($('h4.inbox-one-review-heading', undefined, localize('inboxOne.decisions', "Decisions")));
			const decisionList = decisions.appendChild($('ul.inbox-one-review-list'));
			for (const claim of pack.claims) {
				decisionList.appendChild($('li', undefined, claim.text));
			}

			const evidenceClaims = pack.claims.filter(claim => !!claim.receiptLink);
			if (evidenceClaims.length) {
				const evidence = review.appendChild($('.inbox-one-review-section'));
				evidence.appendChild($('h4.inbox-one-review-heading', undefined, localize('inboxOne.evidence', "Evidence")));
				const evidenceList = evidence.appendChild($('ul.inbox-one-review-list'));
				evidenceClaims.forEach(claim => {
					const item = evidenceList.appendChild($('li'));
					const link = item.appendChild($('a.inbox-one-claim-receipt', { href: '#' }, claim.text));
					this.renderDisposables.add(addClick(link, () => this.openReceipt(claim.receiptLink!)));
				});
			}
		}

		if (task.state === LogicalTaskState.Decision || task.state === LogicalTaskState.Blocked) {
			brief.appendChild(this.renderDetailActions(task));
		} else if (task.state === LogicalTaskState.Completed) {
			const footer = brief.appendChild($('.inbox-one-decision-footer'));
			footer.appendChild($('.inbox-one-decision-outcome', undefined, localize('inboxOne.completedNote', "Complete · history preserved")));
			const actions = footer.appendChild($('.inbox-one-detail-actions'));
			this.createButton(actions, localize('inboxOne.reopen', "Reopen with Diffy"), true, () => this.openInlineComposer(task, 'reopen'));
		} else {
			const footer = brief.appendChild($('.inbox-one-decision-footer'));
			footer.appendChild($('.inbox-one-decision-outcome', undefined, getTaskStateLabel(task)));
			const actions = footer.appendChild($('.inbox-one-detail-actions'));
			this.createButton(actions, localize('inboxOne.cancelWork', "Cancel Work"), false, () => void this.cancelWork(task));
		}

		this.renderInlineComposer(detail, task);
	}

	/**
	 * The inline steer/reopen composer (design 3.4/3.6): opened in place under the item's
	 * actions when the user clicks Steer or Reopen, so the item's evidence stays in view.
	 * Diffy still mediates - `continueTask` relays the note into the warm worker session.
	 */
	private renderInlineComposer(detail: HTMLElement, task: ILogicalTask): void {
		const open = this.inlineCompose.get();
		if (!open || open.taskId !== task.id) {
			return;
		}
		const wrap = detail.appendChild($('.inbox-one-steer-inline'));
		const input = wrap.appendChild($('input.inbox-one-diffy-input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = open.intent === 'reopen'
			? localize('inboxOne.reopenPrompt', 'Reopen this and ...')
			: localize('inboxOne.steerPrompt', "Here's how you can make it better...");
		input.value = this.inlineComposeDraft;
		this.renderDisposables.add(addDisposableListener(input, 'input', () => { this.inlineComposeDraft = input.value; }));
		const submit = () => {
			const text = input.value.trim();
			if (!text) {
				return;
			}
			this.inlineComposeDraft = '';
			this.inlineCompose.set(undefined, undefined);
			void this.continueTask(task, open.intent, text);
		};
		this.createButton(wrap, localize('inboxOne.send', "Send"), true, submit);
		this.renderDisposables.add(addKeydown(input, 'Enter', submit));
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	}

	/** Human supplied the blocker's fact/permission: retry (Blocked -> Cooking). */
	private async recoverySupplied(task: ILogicalTask): Promise<void> {
		const res = await this.store.transition(task.id, TaskTrigger.RecoverySupplied);
		if (res.task) {
			this.notificationService.info(localize('inboxOne.unblocked', "Thanks - I'll retry now with that unblocked."));
		}
	}

	/** Opens the live worker session backing the current attempt. */
	private openWorkerSession(task: ILogicalTask): void {
		const ref = task.attempts[task.currentAttempt]?.sessionRef;
		if (!ref || ref.startsWith('inboxone-pending:') || ref.startsWith('inboxone-stub:')) {
			this.notificationService.info(localize('inboxOne.noWorkerYet', "No worker session is available to open yet. If no workspace can host a session here, open one as you would for a New Session and re-run."));
			return;
		}
		let uri: URI;
		try {
			uri = URI.parse(ref);
		} catch {
			this.notificationService.info(localize('inboxOne.openFailed', "Could not open the worker session."));
			return;
		}
		// Navigate to the session through the sessions service (the same primitive
		// clicking a session in the list uses), not a generic URI open.
		void this.sessionsService.openSession(uri).catch(() => {
			this.notificationService.info(localize('inboxOne.openFailed', "Could not open the worker session."));
		});
	}

	/** Steer (design 3.4): item-initiated -> open an inline composer under the item's actions,
	 * so the user keeps the item's evidence in view while writing the steer. */
	private steer(task: ILogicalTask): void {
		this.openInlineComposer(task, 'steer');
	}

	/** Opens (or toggles closed) the inline steer/reopen composer for this item in place,
	 * without leaving the item's detail. Diffy still mediates the relay in `continueTask`. */
	private openInlineComposer(task: ILogicalTask, intent: 'steer' | 'reopen'): void {
		const open = this.inlineCompose.get();
		if (open && open.taskId === task.id && open.intent === intent) {
			this.inlineCompose.set(undefined, undefined);
			return;
		}
		this.inlineComposeDraft = '';
		this.selectedTaskId.set(task.id, undefined);
		this.inlineCompose.set({ taskId: task.id, intent }, undefined);
	}

	private async cancelWork(task: ILogicalTask): Promise<void> {
		await this.store.transition(task.id, TaskTrigger.CancelWork, { archiveReason: 'cancelled from inbox' });
	}

	private renderDetailActions(task: ILogicalTask): HTMLElement {
		const footer = $('.inbox-one-decision-footer');
		const action = task.evidence?.primaryAction;
		if (action) {
			const confirmation = buildConfirmation(action.actionType, action.payload as IActionPayloads[typeof action.actionType]);
			footer.appendChild($('.inbox-one-decision-outcome', undefined, confirmation.reversibilityLine));
		} else {
			footer.appendChild($('.inbox-one-decision-outcome'));
		}

		const actions = footer.appendChild($('.inbox-one-detail-actions'));
		this.createButton(actions, localize('inboxOne.notNow', "Not Now"), false, () => this.selectedTaskId.set(undefined, undefined));

		if (task.state === LogicalTaskState.Blocked) {
			this.createButton(actions, localize('inboxOne.requestChanges', "Request Changes"), false, () => this.steer(task));
			this.createButton(actions, localize('inboxOne.provideAndRetry', "I've Unblocked This"), true, () => void this.recoverySupplied(task));
			return footer;
		}

		if (task.evidence?.customAsk) {
			this.createButton(actions, localize('inboxOne.requestChanges', "Request Changes"), true, () => this.steer(task));
			return footer;
		}

		this.createButton(actions, localize('inboxOne.requestChanges', "Request Changes"), false, () => this.steer(task));
		this.createButton(actions, getApprovalButtonLabel(task), true, () => void this.confirmAndAccept(task));
		return footer;
	}

	/** Shows the host-generated typed confirmation in the standard modal, then executes on confirm. */
	private async confirmAndAccept(task: ILogicalTask): Promise<void> {
		const action = task.evidence?.primaryAction;
		if (!action) {
			return;
		}

		const confirmation = buildConfirmation(action.actionType, action.payload as IActionPayloads[typeof action.actionType]);
		const detailLines = [
			localize('inboxOne.confirmExplanation', "The task narrative, decisions, and evidence remain attached to the resulting action."),
			'',
			...confirmation.effectLines.map(line => `\u2022 ${line}`),
			`\u2022 ${confirmation.reversibilityLine}`,
		];
		if (task.evidence?.gapLine) {
			detailLines.push(`\u2022 ${localize('inboxOne.fyiLabel', "FYI:")} ${task.evidence.gapLine}`);
		}
		const { confirmed } = await this.dialogService.confirm({
			type: confirmation.highlight ? Severity.Warning : Severity.Info,
			title: getApprovalDialogTitle(task),
			message: getTaskConsequence(task) ?? action.label,
			detail: detailLines.join('\n'),
			primaryButton: getApprovalButtonLabel(task),
			cancelButton: localize('inboxOne.cancel', "Cancel"),
			custom: true,
		});
		if (confirmed) {
			await this.accept(task);
		}
	}

	private async skip(task: ILogicalTask): Promise<void> {
		await this.continueTask(task, 'steer', localize('inboxOne.skipInstruction', "Use your judgment and continue without waiting for my decision."));
	}

	private createButton(container: HTMLElement, label: string, primary: boolean, run: () => void): Button {
		const button = this.renderDisposables.add(new Button(container, {
			...defaultButtonStyles,
			secondary: !primary,
		}));
		button.label = label;
		this.renderDisposables.add(button.onDidClick(run));
		return button;
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

	/**
	 * The inbox list title: the worker-authored, self-contained headline when
	 * present, else the generic subject fallback. We never derive it by truncating
	 * decisionSentence -- a prefix of the recommendation is not a real title.
	 */
	private listTitle(task: ILogicalTask): string {
		return task.evidence?.title?.trim() || this.fallbackTitle(task);
	}

	private detailStateLabel(task: ILogicalTask): string {
		switch (getTaskAttentionGroup(task)) {
			case InboxOneAttentionGroup.NeedsAttention:
				return localize('inboxOne.detailNeedsAttention', "Needs attention · {0}", getTaskStateLabel(task));
			case InboxOneAttentionGroup.InProgress:
				return localize('inboxOne.detailInProgress', "In progress · {0}", getTaskStateLabel(task));
			case InboxOneAttentionGroup.CompleteUnread:
				return getTaskStateLabel(task);
			default:
				return getTaskStateLabel(task);
		}
	}

	layout(_width: number, _height: number): void { }
}

function addClick(el: HTMLElement, handler: () => void): { dispose(): void } {
	const listener = (e: Event) => { e.preventDefault(); e.stopPropagation(); handler(); };
	el.addEventListener('click', listener);
	return { dispose: () => el.removeEventListener('click', listener) };
}

function addActivation(element: HTMLElement, handler: () => void): { dispose(): void } {
	const disposables = new DisposableStore();
	disposables.add(addClick(element, handler));
	disposables.add(addDisposableListener(element, 'keydown', event => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			event.stopPropagation();
			handler();
		}
	}));
	return disposables;
}

function addKeydown(el: HTMLElement, key: string, handler: () => void): { dispose(): void } {
	const listener = (e: KeyboardEvent) => { if (e.key === key) { e.preventDefault(); handler(); } };
	el.addEventListener('keydown', listener);
	return { dispose: () => el.removeEventListener('keydown', listener) };
}
