/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkerDispatcher, IWorkerDispatchRequest, IWorkerDispatchResult } from '../common/workerDispatcher.js';

/**
 * A placeholder {@link IWorkerDispatcher} used until the session-harness-backed
 * dispatcher lands. It records dispatch intent and returns a synthetic session
 * ref so the full ingress -> gate -> admission -> store loop runs and is
 * observable, without a real worker session. The real dispatcher will create a
 * session via the session management service, mount roles, and send the brief.
 */
export class StubWorkerDispatcher implements IWorkerDispatcher {

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	async dispatch(request: IWorkerDispatchRequest): Promise<IWorkerDispatchResult> {
		const sessionRef = request.reuseSessionRef ?? `inboxone-stub://worker/${generateUuid()}`;
		this.logService.info(`[inboxOne] (stub) dispatch ${request.role} for ${request.groupKey} -> ${sessionRef}`);
		return { sessionRef, reused: !!request.reuseSessionRef };
	}

	async relay(sessionRef: string, message: string): Promise<boolean> {
		this.logService.info(`[inboxOne] (stub) relay to ${sessionRef}: ${message.slice(0, 80)}`);
		return true;
	}
}
