/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/inboxOneView.css';
import { $, clearNode } from '../../../../base/browser/dom.js';
import { constObservable, IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { TriggerFamily } from '../common/eventTaxonomy.js';
import { AutonomyLevel, IInboxOneSettings } from '../common/inboxOneSettings.js';

const TRIGGER_FAMILIES: readonly { readonly family: TriggerFamily; readonly label: string }[] = [
	{ family: TriggerFamily.Issues, label: localize('inboxOne.trIssues', 'Issues') },
	{ family: TriggerFamily.PullRequests, label: localize('inboxOne.trPRs', 'Pull requests') },
	{ family: TriggerFamily.Checks, label: localize('inboxOne.trChecks', 'Checks / CI') },
	{ family: TriggerFamily.Security, label: localize('inboxOne.trSecurity', 'Security') },
	{ family: TriggerFamily.Deployments, label: localize('inboxOne.trDeploys', 'Deployments') },
	{ family: TriggerFamily.AgentSessions, label: localize('inboxOne.trSessions', 'Agent sessions') },
];

const AUTONOMY_LEVELS: readonly { readonly level: AutonomyLevel; readonly label: string; readonly desc: string }[] = [
	{
		level: AutonomyLevel.Nothing,
		label: localize('inboxOne.autoNothing', 'Ask me first'),
		desc: localize('inboxOne.autoNothingDesc', 'Diffy never acts on its own. Every action waits for your approval.'),
	},
	{
		level: AutonomyLevel.SafeReversible,
		label: localize('inboxOne.autoSafe', 'Safe, reversible actions'),
		desc: localize('inboxOne.autoSafeDesc', 'Diffy auto-does low-risk, undoable actions (add labels, comment). Anything else asks.'),
	},
	{
		level: AutonomyLevel.PlusMedium,
		label: localize('inboxOne.autoMedium', 'Safe + medium-risk actions'),
		desc: localize('inboxOne.autoMediumDesc', 'Also auto-does medium-risk actions (approve or merge a green PR). Irreversible actions still ask.'),
	},
];

/**
 * Settings > Coordinator (design 11, wireframes 11). Enrolled repositories, per-
 * family event triggers, autonomy, budgets, and notification tiers -- all backed
 * by the durable {@link IInboxOneSettings} the coordinator loop consults.
 */
export class InboxOneSettingsView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('inboxOne.settingsTitle', 'Settings - Coordinator'));
	override readonly description: IObservable<string | undefined> = constObservable(localize('inboxOne.settingsDesc', 'What Diffy watches, how autonomously it acts, and how it notifies you.'));

	private root: HTMLElement | undefined;

	constructor(
		@IInboxOneSettings private readonly settings: IInboxOneSettings,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		container.classList.add('inbox-one-view');
		this.root = container.appendChild($('.inbox-one-settings'));
		this.settings.initialize().then(() => this.rerender(), () => this.rerender());
		this._register(this.settings.onDidChange(() => this.rerender()));
		this.rerender();
	}

	private rerender(): void {
		const root = this.root;
		if (!root) {
			return;
		}
		clearNode(root);
		this.renderEnrollments(root);
		this.renderAutonomy(root);
		this.renderBudgets(root);
		this.renderNotifications(root);
	}

	private renderEnrollments(root: HTMLElement): void {
		const section = root.appendChild($('.inbox-one-settings-section'));
		const header = section.appendChild($('.inbox-one-settings-header'));
		header.appendChild($('span', undefined, localize('inboxOne.enrolledRepos', 'Enrolled repositories')));
		const add = header.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.addRepo', '+ Add')));
		this._register(addClick(add, () => this.addRepo()));

		const enrollments = this.settings.listEnrollments();
		if (enrollments.length === 0) {
			section.appendChild($('.inbox-one-settings-empty', undefined, localize('inboxOne.noRepos', 'No repositories enrolled yet.')));
		}
		for (const e of enrollments) {
			const row = section.appendChild($('.inbox-one-settings-repo'));
			row.appendChild($('span.inbox-one-settings-repo-name', undefined, e.repo));
			row.appendChild($('span.inbox-one-settings-repo-state', undefined, e.active ? localize('inboxOne.active', 'active') : localize('inboxOne.paused', 'paused')));
			const toggle = row.appendChild($('button.inbox-one-action', undefined, e.active ? localize('inboxOne.pause', 'Pause') : localize('inboxOne.resume', 'Resume')));
			this._register(addClick(toggle, () => void this.settings.updateEnrollment(e.repo, { active: !e.active })));
			const remove = row.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.remove', 'Remove')));
			this._register(addClick(remove, () => void this.settings.removeEnrollment(e.repo)));

			// Per-family trigger toggles for the repo.
			const triggers = section.appendChild($('.inbox-one-settings-triggers'));
			for (const t of TRIGGER_FAMILIES) {
				const enabled = this.settings.isTriggerEnabled(e.repo, t.family);
				const chip = triggers.appendChild($(`button.inbox-one-trigger${enabled ? '.on' : ''}`, undefined, `${enabled ? '\u2713 ' : ''}${t.label}`));
				this._register(addClick(chip, () => this.toggleTrigger(e.repo, t.family)));
			}
		}
	}

	private renderAutonomy(root: HTMLElement): void {
		const section = root.appendChild($('.inbox-one-settings-section'));
		section.appendChild($('.inbox-one-settings-header', undefined, localize('inboxOne.autonomySafety', 'Autonomy & safety')));
		section.appendChild($('.inbox-one-settings-hint', undefined, localize('inboxOne.autonomyHint', 'What Diffy may execute without asking. Anything riskier surfaces as a decision.')));
		const radios = section.appendChild($('.inbox-one-settings-radios'));
		const current = this.settings.getDefaultAutonomy();
		for (const a of AUTONOMY_LEVELS) {
			const selected = a.level === current;
			const option = radios.appendChild($(`button.inbox-one-autonomy-option${selected ? '.on' : ''}`));
			const head = option.appendChild($('.inbox-one-autonomy-label'));
			head.appendChild($('span.inbox-one-autonomy-mark', undefined, selected ? '\u25c9' : '\u25cb'));
			head.appendChild($('span', undefined, a.label));
			option.appendChild($('.inbox-one-autonomy-desc', undefined, a.desc));
			this._register(addClick(option, () => void this.settings.setDefaultAutonomy(a.level)));
		}
	}

	private renderBudgets(root: HTMLElement): void {
		const section = root.appendChild($('.inbox-one-settings-section'));
		section.appendChild($('.inbox-one-settings-header', undefined, localize('inboxOne.budgets', 'Budgets')));
		const caps = this.settings.getDefaultBudgets();
		const grid = section.appendChild($('.inbox-one-settings-budgets'));
		this.budgetField(grid, localize('inboxOne.dailyCredits', 'Daily AI credits'), caps.dailyCredits, v => void this.settings.setDefaultBudgets({ ...this.settings.getDefaultBudgets(), dailyCredits: v }));
		this.budgetField(grid, localize('inboxOne.workersPerTask', 'Workers / task'), caps.workersPerTask, v => void this.settings.setDefaultBudgets({ ...this.settings.getDefaultBudgets(), workersPerTask: v }));
		this.budgetField(grid, localize('inboxOne.repoConcurrency', 'Repo concurrency'), caps.repoConcurrency, v => void this.settings.setDefaultBudgets({ ...this.settings.getDefaultBudgets(), repoConcurrency: v }));
		this.budgetField(grid, localize('inboxOne.globalConcurrency', 'Global concurrency'), caps.globalConcurrency, v => void this.settings.setDefaultBudgets({ ...this.settings.getDefaultBudgets(), globalConcurrency: v }));
	}

	private renderNotifications(root: HTMLElement): void {
		const section = root.appendChild($('.inbox-one-settings-section'));
		section.appendChild($('.inbox-one-settings-header', undefined, localize('inboxOne.notifications', 'Notifications')));
		const prefs = this.settings.getNotificationPreferences();
		const row = section.appendChild($('.inbox-one-settings-triggers'));
		const tiers: readonly [string, keyof typeof prefs, boolean][] = [
			[localize('inboxOne.critical', 'Critical'), 'pushCritical', prefs.pushCritical],
			[localize('inboxOne.urgent', 'Urgent'), 'pushUrgent', prefs.pushUrgent],
			[localize('inboxOne.fyi', 'FYI'), 'pushFyi', prefs.pushFyi],
		];
		for (const [label, key, on] of tiers) {
			const chip = row.appendChild($(`button.inbox-one-trigger${on ? '.on' : ''}`, undefined, `${on ? '\u2713 ' : ''}${label}`));
			this._register(addClick(chip, () => void this.settings.setNotificationPreferences({ ...this.settings.getNotificationPreferences(), [key]: !on })));
		}
	}

	private budgetField(grid: HTMLElement, label: string, value: number, onChange: (v: number) => void): void {
		const field = grid.appendChild($('.inbox-one-settings-budget'));
		field.appendChild($('label', undefined, label));
		const input = field.appendChild($('input.inbox-one-settings-number')) as HTMLInputElement;
		input.type = 'number';
		input.min = '1';
		input.value = String(value);
		input.addEventListener('change', () => {
			const v = parseInt(input.value, 10);
			if (Number.isFinite(v) && v > 0) {
				onChange(v);
			}
		});
	}

	private async addRepo(): Promise<void> {
		const repo = await this.quickInput.input({
			prompt: localize('inboxOne.enrollPrompt', 'Repository to enroll (owner/name)'),
			placeHolder: 'owner/name',
			validateInput: async v => (/^[^/\s]+\/[^/\s]+$/.test(v.trim()) ? undefined : localize('inboxOne.enrollInvalid', 'Enter a repository as owner/name')),
		});
		if (repo) {
			await this.settings.enrollRepo({ repo: repo.trim(), active: true });
		}
	}

	private toggleTrigger(repo: string, family: TriggerFamily): void {
		const e = this.settings.getEnrollment(repo);
		if (!e) {
			return;
		}
		const all = TRIGGER_FAMILIES.map(t => t.family);
		const current = e.enabledFamilies ? [...e.enabledFamilies] : [...all];
		const next = current.includes(family) ? current.filter(f => f !== family) : [...current, family];
		void this.settings.updateEnrollment(repo, { enabledFamilies: next });
	}

	layout(_width: number, _height: number): void { }
}

function addClick(el: HTMLElement, handler: () => void): { dispose(): void } {
	const listener = (e: Event) => { e.preventDefault(); e.stopPropagation(); handler(); };
	el.addEventListener('click', listener);
	return { dispose: () => el.removeEventListener('click', listener) };
}
