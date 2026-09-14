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
import { AttemptTrigger, EventSource, IIngressEvent } from '../common/inboxOneTypes.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { TaskTrigger } from '../common/inboxOneStateMachine.js';

/** MVP: a single personal inbox per user (design 7.7). */
const PERSONAL_INBOX_ID = 'my';

/**
 * Routes conversation threads into the inbox (the user's first-principles ask:
 * "conversation threads in the existing chat feature ... piped through the
 * coordinator Diffy for triage"). When any agent session that Diffy did NOT
 * dispatch reaches `NeedsInput` (an `ask_user`), it is surfaced as a Blocked
 * inbox item with one recovery step, so a chat waiting on you shows up alongside
 * GitHub-triggered work.
 *
 * Sessions Diffy dispatched are excluded (they route to their owning task via the
 * SessionEventAdapter, G15). Minting is direct-to-store rather than through the
 * dispatch gate: a live conversation is existing work to triage, not new work to
 * dispatch. Idempotent -- once minted the session is owned, so it is not
 * re-surfaced.
 */
export class ChatTriageService extends Disposable {

	declare readonly _serviceBrand: undefined;

	private readonly statusWatchers = this._register(new DisposableStore());

	constructor(
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IInboxOneStore private readonly store: IInboxOneStore,
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
				if (status === SessionStatus.NeedsInput) {
					void this.surface(session);
				}
			}));
		}
	}

	private async surface(session: ISession): Promise<void> {
		const sessionRef = session.resource.toString();
		// Diffy's own dispatched workers route to their owning task elsewhere (G15).
		if (this.store.getTaskBySession(sessionRef)) {
			return;
		}
		const sessionId = session.sessionId;
		const event: IIngressEvent = {
			deliveryId: `chat:${sessionId}:needs_input`,
			source: EventSource.Session,
			sessionId,
			type: 'needs_input',
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
			// Bind the session so lifecycle + Open resolve, then land it as Blocked
			// with a readable headline (the chat's title).
			await this.store.updateTask(task.id, { sessionRef });
			await this.store.setEvidence(task.id, {
				decisionSentence: `${session.title.get()} is waiting for your input`,
				claims: [],
				gapLine: '',
				freshness: { computedAt: Date.now() },
			});
			await this.store.transition(task.id, TaskTrigger.Blocker, {
				recoveryStep: `Open the conversation and reply to continue.`,
			});
			this.logService.info(`[inboxOne] surfaced conversation ${sessionId} needing input`);
		} catch (err) {
			this.logService.warn(`[inboxOne] chat triage failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
