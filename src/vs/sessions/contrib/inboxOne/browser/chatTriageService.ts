/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { deriveGroupKey } from '../common/groupKey.js';
import { AttemptTrigger, EventSource, IIngressEvent, InboxOneTier } from '../common/inboxOneTypes.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { TaskTrigger } from '../common/inboxOneStateMachine.js';
import { IInboxOneSessionLauncher } from './inboxOneSessionLauncher.js';

/** MVP: a single personal inbox per user (design 7.7). */
const PERSONAL_INBOX_ID = 'my';

/**
 * Routes conversation threads into the inbox (the user's first-principles ask:
 * "conversation threads in the existing chat feature ... piped through the
 * coordinator Diffy for triage", and the Settings default-on agent-session
 * triggers "task done" + "needs input", wireframes 12). Any agent session that
 * Diffy did NOT dispatch is surfaced when it either:
 *   - reaches `NeedsInput` (an `ask_user`) -> a Blocked item in URGENT with one
 *     recovery step, so a chat waiting on you shows up alongside GitHub work; or
 *   - finishes a turn (`Completed`) while we are watching -> an FYI item, so a
 *     conversation you had that just wrapped up is logged for your awareness.
 *
 * Excluded are (a) sessions Diffy dispatched -- they route to their owning task
 * via the SessionEventAdapter (G15) -- and (b) any session this window's launcher
 * created (the learning distiller and workers before they are task-bound), which
 * is Diffy's own machinery, not a user conversation. Finish surfacing is
 * edge-triggered (only a session that transitions to `Completed` while observed,
 * never one already Completed when first seen) so reopening the inbox does not
 * resurface every historical chat. Minting is direct-to-store rather than through
 * the dispatch gate: a live conversation is existing work to triage, not new work
 * to dispatch. Idempotent -- once minted the session is owned, so it is not
 * re-surfaced.
 */
export class ChatTriageService extends Disposable {

	declare readonly _serviceBrand: undefined;

	private readonly statusWatchers = this._register(new DisposableStore());
	/** Last status observed per session ref, so finish surfacing can edge-trigger. */
	private readonly lastStatus = new Map<string, SessionStatus>();

	constructor(
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IInboxOneStore private readonly store: IInboxOneStore,
		@IInboxOneSessionLauncher private readonly launcher: IInboxOneSessionLauncher,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.sessions.onDidChangeSessions(() => this.rewatch()));
		this.rewatch();
	}

	private rewatch(): void {
		this.statusWatchers.clear();
		for (const session of this.sessions.getSessions()) {
			this.statusWatchers.add(autorun(reader => {
				const status = session.status.read(reader);
				const ref = session.resource.toString();
				const prev = this.lastStatus.get(ref);
				this.lastStatus.set(ref, status);
				if (status === SessionStatus.NeedsInput) {
					void this.surface(session, 'needs_input');
				} else if (status === SessionStatus.Completed && prev !== undefined && prev !== SessionStatus.Completed) {
					void this.surface(session, 'finished');
				}
			}));
		}
	}

	private async surface(session: ISession, kind: 'needs_input' | 'finished'): Promise<void> {
		const sessionRef = session.resource.toString();
		// Diffy's own dispatched workers route to their owning task elsewhere (G15);
		// the learning distiller (and any worker not yet task-bound) is inbox-internal
		// machinery this window's launcher created, never a user conversation.
		if (this.store.getTaskBySession(sessionRef) || this.launcher.isManaged(sessionRef)) {
			return;
		}
		const sessionId = session.sessionId;
		const event: IIngressEvent = {
			deliveryId: `chat:${sessionId}:${kind}`,
			source: EventSource.Session,
			sessionId,
			type: kind === 'needs_input' ? 'needs_input' : 'task_finished',
			subject: { kind: 'session', id: sessionId },
			receivedAt: Date.now(),
		};
		const groupKey = deriveGroupKey(event);
		if (!groupKey) {
			return;
		}
		try {
			const { task, created } = await this.store.upsertByGroupKey({
				inboxId: PERSONAL_INBOX_ID,
				groupKey,
				sourceEvent: event,
				type: 'conversation',
				firstAttemptTrigger: AttemptTrigger.Hook,
			});
			if (!created) {
				return; // already surfaced
			}
			// Bind the session so lifecycle + Open resolve, then land it with a
			// readable headline (the chat's title).
			await this.store.updateTask(task.id, { sessionRef });
			const title = session.title.get();
			if (kind === 'needs_input') {
				await this.store.setEvidence(task.id, {
					decisionSentence: `${title} is waiting for your input`,
					claims: [],
					gapLine: '',
					freshness: { computedAt: Date.now() },
				});
				await this.store.transition(task.id, TaskTrigger.Blocker, {
					recoveryStep: `Open the conversation and reply to continue.`,
				});
				this.logService.info(`[inboxOne] surfaced conversation ${sessionId} needing input`);
			} else {
				await this.store.setEvidence(task.id, {
					decisionSentence: `${title} finished`,
					claims: [],
					gapLine: '',
					freshness: { computedAt: Date.now() },
				});
				await this.store.transition(task.id, TaskTrigger.EvidenceAssembled, {
					tier: InboxOneTier.Fyi,
					rank: 0,
					rankReason: 'A conversation you had finished.',
				});
				this.logService.info(`[inboxOne] surfaced finished conversation ${sessionId}`);
			}
		} catch (err) {
			this.logService.warn(`[inboxOne] chat triage failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
