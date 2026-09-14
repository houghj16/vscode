/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/inboxOneView.css';
import { $, clearNode } from '../../../../base/browser/dom.js';
import { constObservable, IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { IInboxOneFileStore, IStoredSkill } from '../common/inboxOneFileStore.js';

/**
 * Skills & roles (design 6, wireframes 13). Read-mostly: learning evolves skills
 * silently; this view is how you pull transparency. Shows emergent roles (from
 * role_list), the skills with versions and impact, and per-skill rollback. Wiki
 * peek renders the learning catalog.
 */
export class InboxOneSkillsView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('inboxOne.skillsTitle', 'Skills & Roles'));
	override readonly description: IObservable<string | undefined> = constObservable(localize('inboxOne.skillsDesc', 'Learning evolves these silently. Inspect roles, skills, and roll back a version.'));

	private root: HTMLElement | undefined;
	private detailContainer: HTMLElement | undefined;
	private selectedSkillId: string | undefined;

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
			row.appendChild($('.inbox-one-item-title', undefined, role));
			row.appendChild($('.inbox-one-item-meta', undefined, localize('inboxOne.roleCount', '{0} skill(s)', ids.length)));
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
			this._register(addClick(row, () => { this.selectedSkillId = skill.frontmatter.id; void this.renderDetail(skill); void this.rerender(); }));
		}

		const detail = root.appendChild($('.inbox-one-detail'));
		detail.appendChild($('.inbox-one-detail-empty', undefined, localize('inboxOne.selectSkill', 'Select a skill to inspect it.')));
		this.detailContainer = detail;
		const selected = skills.find(s => s.frontmatter.id === this.selectedSkillId);
		if (selected) {
			void this.renderDetail(selected);
		}
	}

	private async renderDetail(skill: IStoredSkill): Promise<void> {
		const detail = this.detailContainer;
		if (!detail) {
			return;
		}
		clearNode(detail);
		detail.appendChild($('.inbox-one-detail-tier', undefined, [skill.frontmatter.roles.join(' - ') || localize('inboxOne.noRole', 'no role'), `v${skill.frontmatter.version ?? 1}`].join(' - ')));
		detail.appendChild($('h2.inbox-one-detail-title', undefined, skill.frontmatter.id));

		detail.appendChild($('.inbox-one-detail-claims-header', undefined, localize('inboxOne.whatItDoes', 'What it does')));
		detail.appendChild($('.inbox-one-skill-body', undefined, skill.body.split('\n').slice(0, 12).join('\n')));

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
