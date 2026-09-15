/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { WorkerRole } from '../common/eventTaxonomy.js';
import { IInboxOneFileStore } from '../common/inboxOneFileStore.js';
import { GroupKey } from '../common/inboxOneTypes.js';
import { IWorkerDispatcher, IWorkerDispatchRequest, IWorkerDispatchResult } from '../common/workerDispatcher.js';
import { composeWorkerFirstMessage } from '../common/workerBrief.js';
import { IInboxOneSessionLauncher } from './inboxOneSessionLauncher.js';

/** URI scheme for a deferred dispatch when no session target is available yet. */
export const PENDING_SCHEME = 'inboxone-pending';

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
 * The production {@link IWorkerDispatcher}. It owns only what is worker-specific
 * -- composing the first message (operating envelope + mounted role skills +
 * brief) and stamping task-routing metadata -- and delegates ALL session
 * creation and messaging to the central {@link IInboxOneSessionLauncher}, which
 * reuses the same harness the New Session composer uses. There is no bespoke
 * folder resolution here.
 *
 * When no session target is available yet, dispatch degrades gracefully: it
 * records intent and returns an `inboxone-pending://` ref (marked `deferred`) so
 * the coordinator loop still advances and its admission slot is released; a later
 * dispatch supersedes it once a target exists.
 */
export class SessionsManagementWorkerDispatcher implements IWorkerDispatcher {

	constructor(
		@IInboxOneSessionLauncher private readonly launcher: IInboxOneSessionLauncher,
		@IInboxOneFileStore private readonly fileStore: IInboxOneFileStore,
		@ILogService private readonly logService: ILogService,
	) { }

	async dispatch(request: IWorkerDispatchRequest): Promise<IWorkerDispatchResult> {
		// Warm reuse: relay the new brief into the existing session (re-scoped by
		// the coordinator's brief, gotcha G7). Fall through to a fresh session if
		// the prior session is gone.
		if (request.reuseSessionRef && await this.launcher.relay(request.reuseSessionRef, request.brief)) {
			return { sessionRef: request.reuseSessionRef, reused: true };
		}

		const firstMessage = await this.composeFirstMessage(request);
		const session = await this.launcher.launch(firstMessage, {
			title: workerTitle(request.role, request.groupKey),
			activity: `worker ${request.role}`,
			metadata: {
				[INBOX_ONE_SESSION_META.role]: request.role,
				[INBOX_ONE_SESSION_META.groupKey]: request.groupKey,
				[INBOX_ONE_SESSION_META.taskId]: request.task.id,
				[INBOX_ONE_SESSION_META.attempt]: request.attemptIndex,
			},
		});
		if (!session) {
			return this.deferred(request);
		}
		return { sessionRef: session.resource.toString(), reused: false };
	}

	async relay(sessionRef: string, message: string): Promise<void> {
		if (!await this.launcher.relay(sessionRef, message)) {
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

	private deferred(request: IWorkerDispatchRequest): IWorkerDispatchResult {
		const sessionRef = `${PENDING_SCHEME}://worker/${generateUuid()}`;
		this.logService.info(`[inboxOne] deferring ${request.role} dispatch for ${request.groupKey}: no session target available (${sessionRef})`);
		return { sessionRef, reused: false, deferred: true };
	}
}
