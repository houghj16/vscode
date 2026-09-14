/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { buildDistillerBrief, parseProposedSkill } from '../common/distillerBrief.js';
import { IInboxOneFileStore, IStoredSkill } from '../common/inboxOneFileStore.js';
import { IExperienceRecord, LearningTarget } from '../common/learningLoop.js';
import { mapSessionStatusToEventType } from '../common/sessionEventMapping.js';

/** Reconstructs an on-disk SKILL.md (frontmatter + body) so the distiller sees the full skill. */
function reconstructSkill(skill: IStoredSkill): string {
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

/**
 * The real semantic half of the learning loop (design 6.2): the `distillOne` hook
 * that dispatches a stock distiller AGENT session per resolution. It briefs the
 * session with the experience + current role skill, and when the session
 * completes reads its proposed SKILL.md from the chat model and applies it as a
 * new, versioned, rollbackable skill on the host. Deterministic consolidation
 * (wiki log + skill-impact) already ran in the orchestrator; this adds the model
 * authorship.
 *
 * Degrades gracefully with no connected host: dispatch defers (no session), so
 * nothing is written -- the deterministic ledger still advances.
 */
export class DistillerSessionDispatcher extends Disposable {

	constructor(
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IInboxOneFileStore private readonly fileStore: IInboxOneFileStore,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IChatService private readonly chatService: IChatService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/** Wire this as {@link LearningOrchestrator}'s `distillOne`. */
	readonly distill = async (record: IExperienceRecord, target: LearningTarget): Promise<void> => {
		const folder = this.workspaceContext.getWorkspace().folders[0]?.uri;
		if (!folder || !this.sessions.isNewSessionTargetAvailable(folder)) {
			this.logService.trace('[inboxOne] distiller deferred (no connected agent host)');
			return;
		}
		// The role's own (non-framework) skill is the update target.
		const skill = record.role ? (await this.fileStore.listSkills()).find(s => !s.isFramework && s.frontmatter.roles.includes(record.role!)) : undefined;
		const brief = buildDistillerBrief(record, target, skill ? reconstructSkill(skill) : undefined);
		try {
			const session = await this.sessions.createAndSendNewChatRequest(
				folder,
				{ query: brief, title: 'Diffy distiller', background: true },
				{ metadata: { inboxOneDistiller: record.resolutionId } },
			);
			if (session && skill) {
				this.applyOnComplete(session, skill.frontmatter.id);
			}
		} catch (err) {
			this.logService.warn(`[inboxOne] distiller dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	/** One-shot: when the distiller session finishes, read + apply its proposed skill. */
	private applyOnComplete(session: ISession, skillId: string): void {
		const watcher = new DisposableStore();
		watcher.add(autorun(reader => {
			const status = session.status.read(reader);
			if (mapSessionStatusToEventType(status) === 'task_finished') {
				watcher.dispose();
				this.apply(session, skillId).catch(err => this.logService.warn(`[inboxOne] distiller apply failed: ${err instanceof Error ? err.message : String(err)}`));
			}
		}));
		this._register(watcher);
	}

	private async apply(session: ISession, skillId: string): Promise<void> {
		const model = this.chatService.getSession(session.resource);
		if (!model) {
			return;
		}
		const requests = model.getRequests();
		let text: string | undefined;
		for (let i = requests.length - 1; i >= 0 && !text; i--) {
			const response = requests[i].response;
			const value = response?.entireResponse.getFinalResponse();
			if (value && value.trim()) {
				text = value;
			}
		}
		const proposed = text ? parseProposedSkill(text) : undefined;
		if (!proposed) {
			this.logService.trace(`[inboxOne] distiller proposed no change to ${skillId}`);
			return;
		}
		await this.fileStore.writeSkill(skillId, proposed);
		this.logService.info(`[inboxOne] distiller updated skill ${skillId} (new version)`);
	}
}
