/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/inboxOneView.css';
import { $, clearNode } from '../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { constObservable, IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { IInboxOneFileStore, IStoredSkill } from '../common/inboxOneFileStore.js';

type BodyView = 'rendered' | 'raw';

/**
 * Skills & roles (design 6, wireframes 13). Read-mostly: learning evolves skills
 * silently; this view is how you pull transparency. Shows emergent roles (from
 * role_list) -- each clickable to the skills it composes -- and the skills
 * themselves with a rendered/raw markdown toggle, provenance, and per-version
 * rollback.
 */
export class InboxOneSkillsView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('inboxOne.skillsTitle', 'Skills & Roles'));
	override readonly description: IObservable<string | undefined> = constObservable(localize('inboxOne.skillsDesc', 'Learning evolves these silently. Inspect roles, skills, and roll back a version.'));

	private root: HTMLElement | undefined;
	private detailContainer: HTMLElement | undefined;
	private selectedSkillId: string | undefined;
	private selectedRoleId: string | undefined;
	private bodyView: BodyView = 'rendered';

	constructor(
		@IInboxOneFileStore private readonly fileStore: IInboxOneFileStore,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		container.classList.add('inbox-one-view');
		this.root = container.appendChild($('.inbox-one-panes'));
		void this.rerender();
	}

	private async rerender(): Promise<void> {
		const root = this.root;
		if (!root) {
			return;
		}
		await this.fileStore.initialize();
		const skills = await this.fileStore.listSkills();
		const roles = this.fileStore.roleList.get();
		clearNode(root);

		const left = root.appendChild($('.inbox-one-left'));

		// Emergent roles (from role_list.md; regex, no LLM).
		const rolesHeader = left.appendChild($('.inbox-one-section-header'));
		rolesHeader.appendChild($('.inbox-one-section-label', undefined, localize('inboxOne.rolesEmergent', 'ROLES (EMERGENT)')));
		for (const [role, ids] of roles) {
			const row = left.appendChild($('.inbox-one-item'));
			if (role === this.selectedRoleId) {
				row.classList.add('selected');
			}
			row.appendChild($('.inbox-one-item-title', undefined, role));
			row.appendChild($('.inbox-one-item-meta', undefined, localize('inboxOne.roleCount', '{0} skill(s)', ids.length)));
			this._register(addClick(row, () => {
				this.selectedRoleId = role;
				this.selectedSkillId = undefined;
				void this.rerender();
			}));
		}

		// Skills.
		const skillsHeader = left.appendChild($('.inbox-one-section-header'));
		skillsHeader.appendChild($('.inbox-one-section-label', undefined, localize('inboxOne.skills', 'SKILLS')));
		for (const skill of skills.slice().sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id))) {
			const row = left.appendChild($('.inbox-one-item'));
			if (skill.frontmatter.id === this.selectedSkillId) {
				row.classList.add('selected');
			}
			const title = row.appendChild($('.inbox-one-item-title'));
			title.textContent = skill.frontmatter.id;
			title.appendChild($('span.inbox-one-skill-version', undefined, ` v${skill.frontmatter.version ?? 1}`));
			const meta = row.appendChild($('.inbox-one-item-meta'));
			meta.appendChild($('span.inbox-one-item-reason', undefined, [
				skill.isFramework ? localize('inboxOne.framework', 'framework') : (skill.frontmatter.roles.join(', ') || localize('inboxOne.noRole', 'no role')),
				skill.frontmatter.transferScope ? `transfer: ${skill.frontmatter.transferScope}` : undefined,
			].filter(Boolean).join(' - ')));
			this._register(addClick(row, () => { this.selectSkill(skill.frontmatter.id); }));
		}

		const detail = root.appendChild($('.inbox-one-detail'));
		this.detailContainer = detail;

		const selectedSkill = this.selectedSkillId ? skills.find(s => s.frontmatter.id === this.selectedSkillId) : undefined;
		if (this.selectedRoleId && roles.has(this.selectedRoleId)) {
			this.renderRoleDetail(this.selectedRoleId, roles.get(this.selectedRoleId) ?? [], skills);
		} else if (selectedSkill) {
			void this.renderSkillDetail(selectedSkill);
		} else {
			detail.appendChild($('.inbox-one-detail-empty', undefined, localize('inboxOne.selectSkill', 'Select a role or skill to inspect it.')));
		}
	}

	private selectSkill(id: string): void {
		this.selectedSkillId = id;
		this.selectedRoleId = undefined;
		void this.rerender();
	}

	private renderRoleDetail(role: string, skillIds: readonly string[], skills: readonly IStoredSkill[]): void {
		const detail = this.detailContainer;
		if (!detail) {
			return;
		}
		clearNode(detail);
		detail.appendChild($('.inbox-one-detail-tier', undefined, localize('inboxOne.roleEmergent', 'emergent role')));
		detail.appendChild($('h2.inbox-one-detail-title', undefined, role));
		detail.appendChild($('.inbox-one-detail-sub', undefined, localize('inboxOne.roleComposed', 'Mounting this role composes these skills plus the framework emit-result contract.')));
		detail.appendChild($('.inbox-one-detail-claims-header', undefined, localize('inboxOne.roleSkills', 'Skills in this role')));
		for (const id of skillIds.slice().sort((a, b) => a.localeCompare(b))) {
			const skill = skills.find(s => s.frontmatter.id === id);
			const row = detail.appendChild($('.inbox-one-item'));
			const title = row.appendChild($('.inbox-one-item-title'));
			title.textContent = id;
			if (skill) {
				title.appendChild($('span.inbox-one-skill-version', undefined, ` v${skill.frontmatter.version ?? 1}`));
			}
			this._register(addClick(row, () => this.selectSkill(id)));
		}
	}

	private async renderSkillDetail(skill: IStoredSkill): Promise<void> {
		const detail = this.detailContainer;
		if (!detail) {
			return;
		}
		clearNode(detail);
		detail.appendChild($('.inbox-one-detail-tier', undefined, [skill.frontmatter.roles.join(' - ') || localize('inboxOne.noRole', 'no role'), `v${skill.frontmatter.version ?? 1}`].join(' - ')));
		detail.appendChild($('h2.inbox-one-detail-title', undefined, skill.frontmatter.id));

		// Rendered / Raw toggle (full content, no truncation).
		const toggle = detail.appendChild($('.inbox-one-skill-toggle'));
		const renderedBtn = toggle.appendChild($(`button.inbox-one-toggle-btn${this.bodyView === 'rendered' ? '.on' : ''}`, undefined, localize('inboxOne.rendered', 'Rendered')));
		const rawBtn = toggle.appendChild($(`button.inbox-one-toggle-btn${this.bodyView === 'raw' ? '.on' : ''}`, undefined, localize('inboxOne.raw', 'Raw')));
		this._register(addClick(renderedBtn, () => { this.bodyView = 'rendered'; void this.renderSkillDetail(skill); }));
		this._register(addClick(rawBtn, () => { this.bodyView = 'raw'; void this.renderSkillDetail(skill); }));

		const bodyContainer = detail.appendChild($('.inbox-one-skill-body'));
		if (this.bodyView === 'raw') {
			const pre = bodyContainer.appendChild($('pre.inbox-one-skill-raw'));
			pre.textContent = this.reconstructRaw(skill);
		} else {
			const rendered = this._register(renderMarkdown(new MarkdownString(skill.body)));
			bodyContainer.appendChild(rendered.element);
		}

		if (skill.frontmatter.provenance?.length) {
			detail.appendChild($('.inbox-one-detail-claims-header', undefined, localize('inboxOne.evolvedFrom', 'Evolved from')));
			detail.appendChild($('.inbox-one-item-meta', undefined, skill.frontmatter.provenance.join(', ')));
		}

		const history = await this.fileStore.getSkillHistory(skill.frontmatter.id);
		if (!skill.isFramework && history.length) {
			const actions = detail.appendChild($('.inbox-one-detail-actions'));
			for (const version of history.slice().sort((a, b) => b.version - a.version)) {
				const btn = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.rollback', 'Roll back to v{0}', version.version)));
				this._register(addClick(btn, () => this.rollback(skill.frontmatter.id, version.version)));
			}
		} else if (!skill.isFramework) {
			detail.appendChild($('.inbox-one-detail-done', undefined, localize('inboxOne.noHistory', 'No prior versions yet. Learning will produce them.')));
		} else {
			detail.appendChild($('.inbox-one-detail-done', undefined, localize('inboxOne.frameworkNote', 'Framework skill - never modified by learning.')));
		}
	}

	/** Reconstructs the on-disk SKILL.md (frontmatter + body) for the raw view. */
	private reconstructRaw(skill: IStoredSkill): string {
		const fm = skill.frontmatter;
		const lines = ['---', `id: ${fm.id}`];
		if (fm.roles.length) { lines.push(`roles: [${fm.roles.join(', ')}]`); }
		if (fm.transferScope) { lines.push(`transfer_scope: ${fm.transferScope}`); }
		if (fm.version !== undefined) { lines.push(`version: ${fm.version}`); }
		if (fm.provenance?.length) { lines.push(`provenance: [${fm.provenance.join(', ')}]`); }
		if (fm.triggers?.length) { lines.push(`triggers: [${fm.triggers.join(', ')}]`); }
		lines.push('---', '', skill.body);
		return lines.join('\n');
	}

	private async rollback(id: string, version: number): Promise<void> {
		try {
			await this.fileStore.rollbackSkill(id, version);
			this.notificationService.info(localize('inboxOne.rolledBack', 'Rolled {0} back to v{1}.', id, version));
			void this.rerender();
		} catch (err) {
			this.notificationService.warn(localize('inboxOne.rollbackFailed', 'Could not roll back: {0}', String(err)));
		}
	}

	layout(_width: number, _height: number): void { }
}

function addClick(el: HTMLElement, handler: () => void): { dispose(): void } {
	const listener = (e: Event) => { e.preventDefault(); e.stopPropagation(); handler(); };
	el.addEventListener('click', listener);
	return { dispose: () => el.removeEventListener('click', listener) };
}
