/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatProgress } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';

/**
 * Reads a background agent session's transcript by resource and returns the
 * assistant response text that carries a fenced block marked by {@link marker}.
 *
 * Dispatched inbox sessions (workers, the distiller) are background agent-host
 * sessions that are never opened in a chat editor, so their transcript is NOT
 * registered with the workbench `IChatService`. This reads them through
 * {@link IChatSessionsService.getChatSessionHistory}, which resolves a session's
 * history by resource without retaining/opening it -- the provider-neutral path
 * the sessions UI uses for agent-host and cloud sessions. The block usually
 * precedes a trailing tool call (e.g. task_complete), and a later turn can be
 * just a summary, so we scan responses newest-first for the one that actually
 * carries the marker and fall back to the newest non-empty response.
 */
export async function readSessionResponseText(
	chatSessions: IChatSessionsService,
	sessionRef: string,
	marker: string,
	logService: ILogService,
): Promise<string | undefined> {
	let uri: URI;
	try {
		uri = URI.parse(sessionRef);
	} catch {
		return undefined;
	}

	let history;
	try {
		history = await chatSessions.getChatSessionHistory(uri, CancellationToken.None);
	} catch (err) {
		logService.trace(`[inboxOne] transcript: history read failed for ${sessionRef}: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
	if (!history || history.length === 0) {
		logService.trace(`[inboxOne] transcript: no history for ${sessionRef}`);
		return undefined;
	}

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
		if (text.includes(marker)) {
			logService.trace(`[inboxOne] transcript: '${marker}' found for ${sessionRef} (len=${text.length})`);
			return text;
		}
	}
	logService.trace(`[inboxOne] transcript: '${marker}' not found across ${history.length} history item(s) for ${sessionRef}`);
	return newestNonEmpty;
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
