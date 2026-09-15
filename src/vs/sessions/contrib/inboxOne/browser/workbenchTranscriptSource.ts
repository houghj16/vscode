/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ILogicalTask } from '../common/inboxOneTypes.js';
import { ITranscriptSource } from '../common/workerResult.js';

/**
 * Reads a finished worker session's final assistant message from the live chat
 * model (technical spec 2.3). The worker follows the baked-in emit-result
 * contract and, as its last step, emits the fenced `inbox-one-result` block; this
 * source returns that final message text so {@link parseWorkerResult} can extract
 * it. This is the host-specific half of the transcript reader -- with a real
 * worker session, `task_finished` produces real evidence; without one it returns
 * `undefined` (a safe no-op).
 *
 * The stored `sessionRef` is a SESSION resource; the transcript lives on the
 * session's chat model, keyed by the CHAT resource. We resolve session -> main
 * chat -> chat model, matching how the rest of the sessions UI reads a
 * transcript, so it works for any session type (local, agent host, cloud).
 */
export class WorkbenchTranscriptSource implements ITranscriptSource {

	constructor(
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IChatService private readonly chatService: IChatService,
		@ILogService private readonly logService: ILogService,
	) { }

	async readFinalMessage(_task: ILogicalTask, sessionRef: string): Promise<string | undefined> {
		let uri: URI;
		try {
			uri = URI.parse(sessionRef);
		} catch {
			return undefined;
		}
		const session = this.sessions.getSession(uri);
		if (!session) {
			this.logService.trace(`[inboxOne] transcript: no session for ${sessionRef}`);
			return undefined;
		}
		const model = this.chatService.getSession(session.mainChat.get().resource);
		if (!model) {
			this.logService.trace(`[inboxOne] transcript: no chat model for ${sessionRef}`);
			return undefined;
		}
		// The emit-result block is in the last turn's response; scan from the end in
		// case the final turn has no response yet.
		const requests = model.getRequests();
		for (let i = requests.length - 1; i >= 0; i--) {
			const response = requests[i].response;
			if (response) {
				const text = response.entireResponse.getFinalResponse();
				if (text && text.trim().length > 0) {
					return text;
				}
			}
		}
		return undefined;
	}
}
