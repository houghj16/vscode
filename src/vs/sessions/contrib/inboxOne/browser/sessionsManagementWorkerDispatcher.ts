/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { GITHUB_REMOTE_FILE_SCHEME } from '../../../services/sessions/common/session.js';
import { WorkerRole } from '../common/eventTaxonomy.js';
import { IInboxOneFileStore } from '../common/inboxOneFileStore.js';
import { GroupKey } from '../common/inboxOneTypes.js';
import { IWorkerDispatcher, IWorkerDispatchRequest, IWorkerDispatchResult } from '../common/workerDispatcher.js';
import { composeWorkerFirstMessage } from '../common/workerBrief.js';

/** URI scheme for a deferred dispatch when no agent host/target is available yet. */
export const PENDING_SCHEME = 'inboxone-pending';

/** Whether a dispatch result deferred for want of an agent host / session target. */
export function isPendingRef(sessionRef: string): boolean {
	return sessionRef.startsWith(`${PENDING_SCHEME}:`);
}

/** Metadata keys stamped on a dispatched worker session so it resolves back to its task (G15). */
export const INBOX_ONE_SESSION_META = {
	role: 'inboxOneRole',
	groupKey: 'inboxOneGroupKey',
	taskId: 'inboxOneTaskId',
	attempt: 'inboxOneAttempt',
} as const;

function workerTitle(role: WorkerRole, groupKey: GroupKey): string {
	const subject = groupKey.split(':').slice(1).join(' ');
	switch (role) {
		case WorkerRole.CodeReview: return `Review ${subject}`;
		case WorkerRole.IssueTriage: return `Triage ${subject}`;
		case WorkerRole.ImplementFix: return `Fix ${subject}`;
		default: return `Work ${subject}`;
	}
}

/**
 * The production {@link IWorkerDispatcher}: it creates real agent worker sessions
 * through {@link ISessionsManagementService} (the same harness the New Session
 * composer uses) and sends the self-contained brief as the first request, without
 * navigating away from the inbox (`background: true`). The committed session's
 * resource URI is the provider-neutral `sessionRef` stored on the task attempt,
 * so session lifecycle events route back to the owning task (G15).
 *
 * When no agent host / session target is available (e.g. the Agents Window has no
 * connected host), dispatch degrades gracefully: it records intent and returns a
 * `inboxone-pending://` ref so the coordinator loop still advances. A later
 * dispatch (once a host connects) supersedes it. This keeps the coordinator
 * host-independent while making the dispatch path real wherever a host exists.
 */
export class SessionsManagementWorkerDispatcher implements IWorkerDispatcher {

	constructor(
		/** Whether to target the task's repo as a cloud (github-remote) workspace when the window has no local folder. Off in dev builds so dispatch defers to the in-window simulator instead of the flakier cloud path. */
		private readonly allowCloudFallback: boolean,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IInboxOneFileStore private readonly fileStore: IInboxOneFileStore,
		@ILogService private readonly logService: ILogService,
	) { }

	async dispatch(request: IWorkerDispatchRequest): Promise<IWorkerDispatchResult> {
		// Warm reuse: relay the new brief into the existing session (re-scoped by
		// the coordinator's brief, gotcha G7). Fall through to a fresh session if
		// the prior session is gone.
		if (request.reuseSessionRef && await this.relaySafely(request.reuseSessionRef, request.brief)) {
			return { sessionRef: request.reuseSessionRef, reused: true };
		}

		const folder = this.resolveFolder(request);
		if (!folder) {
			return this.deferred(request, 'no workspace or repo to target');
		}
		if (!this.sessions.isNewSessionTargetAvailable(folder)) {
			const types = this.sessions.getSessionTypesForFolder(folder);
			this.logService.info(`[inboxOne] no session target for ${folder.toString()}: ${types.length} type(s) [${types.map(t => `${t.providerId}/${t.sessionType.id}`).join(', ')}]`);
			return this.deferred(request, 'no session target available for the repo');
		}

		const firstMessage = await this.composeFirstMessage(request);

		try {
			const session = await this.sessions.createAndSendNewChatRequest(
				folder,
				{ query: firstMessage, title: workerTitle(request.role, request.groupKey), background: true },
				{
					metadata: {
						[INBOX_ONE_SESSION_META.role]: request.role,
						[INBOX_ONE_SESSION_META.groupKey]: request.groupKey,
						[INBOX_ONE_SESSION_META.taskId]: request.task.id,
						[INBOX_ONE_SESSION_META.attempt]: request.attemptIndex,
					},
				},
			);
			if (!session) {
				return this.deferred(request, 'session service disposed mid-dispatch');
			}
			const sessionRef = session.resource.toString();
			this.logService.info(`[inboxOne] dispatched ${request.role} worker for ${request.groupKey} -> ${sessionRef}`);
			return { sessionRef, reused: false };
		} catch (err) {
			this.logService.error(`[inboxOne] worker dispatch failed for ${request.groupKey}`, err);
			return this.deferred(request, 'dispatch threw');
		}
	}

	async relay(sessionRef: string, message: string): Promise<void> {
		if (!await this.relaySafely(sessionRef, message)) {
			this.logService.warn(`[inboxOne] relay target ${sessionRef} not found`);
		}
	}

	/**
	 * Composes the worker's first message: the fixed operating envelope, the
	 * mounted skills persona for the role (role skills + learned patterns + the
	 * emit-result contract, via `mountRoles`), and the task brief (technical spec
	 * 2.2-2.3). The harness -- not the model -- attaches the skills. A file-store
	 * failure degrades to an empty persona; the self-contained brief still stands.
	 */
	private async composeFirstMessage(request: IWorkerDispatchRequest): Promise<string> {
		let personaText = '';
		try {
			const mounted = await this.fileStore.mountRoles([request.role]);
			personaText = mounted.personaText;
			this.logService.trace(`[inboxOne] mounted ${mounted.skillIds.length} skill(s) for ${request.role}: [${mounted.skillIds.join(', ')}]`);
		} catch (err) {
			this.logService.warn(`[inboxOne] mounting skills for ${request.role} failed; sending brief without persona: ${err instanceof Error ? err.message : String(err)}`);
		}
		return composeWorkerFirstMessage(personaText, request.brief);
	}

	private deferred(request: IWorkerDispatchRequest, reason: string): IWorkerDispatchResult {
		const sessionRef = `${PENDING_SCHEME}://worker/${generateUuid()}`;
		this.logService.info(`[inboxOne] deferring ${request.role} dispatch for ${request.groupKey}: ${reason} (${sessionRef})`);
		return { sessionRef, reused: false, deferred: true };
	}

	private async relaySafely(sessionRef: string, message: string): Promise<boolean> {
		if (sessionRef.startsWith(`${PENDING_SCHEME}:`)) {
			return false;
		}
		let uri: URI;
		try {
			uri = URI.parse(sessionRef);
		} catch {
			return false;
		}
		const session = this.sessions.getSession(uri);
		if (!session) {
			return false;
		}
		try {
			await this.sessions.sendRequest(session, session.mainChat.get(), { query: message, background: true });
			return true;
		} catch (err) {
			this.logService.warn(`[inboxOne] relay to ${sessionRef} failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/**
	 * Resolve the workspace the worker session runs against. Prefer a local
	 * workspace folder if the sessions window has one; otherwise target the task's
	 * repo as a GitHub-remote (cloud) workspace -- generalizable to any enrolled
	 * repo with no local clone required, and the model the ambient cloud worker
	 * uses. Returns undefined only when there is neither a folder nor a repo.
	 */
	private resolveFolder(request: IWorkerDispatchRequest): URI | undefined {
		const local = this.workspaceContext.getWorkspace().folders[0]?.uri;
		if (local) {
			return local;
		}
		if (!this.allowCloudFallback) {
			return undefined;
		}
		const repo = request.task.repo ?? repoFromGroupKey(request.groupKey);
		if (repo && /^[^/\s]+\/[^/\s]+$/.test(repo)) {
			return URI.from({ scheme: GITHUB_REMOTE_FILE_SCHEME, authority: 'github', path: `/${repo}/HEAD` });
		}
		return undefined;
	}
}

/** Extracts `{owner}/{repo}` from a `owner/repo:kind:id` group key. */
function repoFromGroupKey(groupKey: GroupKey): string | undefined {
	const colon = groupKey.indexOf(':');
	return colon > 0 ? groupKey.slice(0, colon) : undefined;
}
