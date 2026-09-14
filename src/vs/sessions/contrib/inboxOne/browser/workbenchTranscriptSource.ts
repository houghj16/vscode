/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ILogicalTask } from '../common/inboxOneTypes.js';
import { ITranscriptSource } from '../common/workerResult.js';

/**
 * Reads a finished worker session's final assistant message from the live chat
 * model (technical spec 2.3). The worker follows the baked-in emit-result
 * contract and, as its last step, emits the fenced `inbox-one-result` block; this
 * source returns that final message text so {@link parseWorkerResult} can extract
 * it. This is the host-specific half of the transcript reader -- with a connected
 * agent host and a real worker session, `task_finished` produces real evidence;
 * without a session it returns `undefined` (a safe no-op).
 */
export class WorkbenchTranscriptSource implements ITranscriptSource {

	constructor(
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
		const model = this.chatService.getSession(uri);
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
