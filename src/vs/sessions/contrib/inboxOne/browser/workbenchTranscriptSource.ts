/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatProgress } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ILogicalTask } from '../common/inboxOneTypes.js';
import { ITranscriptSource } from '../common/workerResult.js';

/**
 * Reads a finished worker session's transcript and returns the assistant text
 * that carries the emit-result block (technical spec 2.3). The worker follows the
 * baked-in emit-result contract and emits the fenced `inbox-one-result` block;
 * this source returns the response text so {@link parseWorkerResult} can extract
 * it. With a real worker session, `task_finished` produces real evidence; without
 * one it returns `undefined` (a safe no-op).
 *
 * A dispatched worker is a background agent-host session that is never opened in a
 * chat editor, so its transcript is NOT registered with the workbench
 * `IChatService`. We read it through {@link IChatSessionsService.getChatSessionHistory},
 * which reads a session's history by resource without retaining/opening it -- the
 * same provider-neutral path the sessions UI uses for agent-host and cloud
 * sessions.
 */
export class WorkbenchTranscriptSource implements ITranscriptSource {

	constructor(
		@IChatSessionsService private readonly chatSessions: IChatSessionsService,
		@ILogService private readonly logService: ILogService,
	) { }

	async readFinalMessage(_task: ILogicalTask, sessionRef: string): Promise<string | undefined> {
		let uri: URI;
		try {
			uri = URI.parse(sessionRef);
		} catch {
			return undefined;
		}

		let history;
		try {
			history = await this.chatSessions.getChatSessionHistory(uri, CancellationToken.None);
		} catch (err) {
			this.logService.trace(`[inboxOne] transcript: history read failed for ${sessionRef}: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
		if (!history || history.length === 0) {
			this.logService.trace(`[inboxOne] transcript: no history for ${sessionRef}`);
			return undefined;
		}

		// The worker emits the fenced `inbox-one-result` block and then usually
		// calls a tool (e.g. task_complete), so the block may be in an earlier
		// response than the last one (a later turn can be just a summary). Scan
		// responses newest-first for the one that actually carries the block; fall
		// back to the newest non-empty response so parsing still runs (and fails
		// cleanly) when no worker emitted a block.
		let newestNonEmpty: string | undefined;
		for (let i = history.length - 1; i >= 0; i--) {
			const item = history[i];
			if (item.type !== 'response') {
				continue;
			}
			const text = responseText(item.parts);
			if (text.trim().length === 0) {
				continue;
			}
			if (newestNonEmpty === undefined) {
				newestNonEmpty = text;
			}
			if (text.includes('```inbox-one-result')) {
				this.logService.trace(`[inboxOne] transcript: result block found for ${sessionRef} (len=${text.length})`);
				return text;
			}
		}
		this.logService.trace(`[inboxOne] transcript: no result block across ${history.length} history item(s) for ${sessionRef}`);
		return newestNonEmpty;
	}
}

/** Concatenates the markdown text of a response's progress parts. */
function responseText(parts: readonly IChatProgress[]): string {
	let text = '';
	for (const part of parts) {
		if (part.kind === 'markdownContent') {
			text += part.content.value;
		}
	}
	return text;
}
