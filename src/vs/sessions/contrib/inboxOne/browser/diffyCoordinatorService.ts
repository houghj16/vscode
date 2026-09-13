/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDiffyCoordinatorService } from '../common/diffyCoordinator.js';
import { IEventIngress } from '../common/eventIngress.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { IIngressEvent } from '../common/inboxOneTypes.js';

/** MVP: a single personal inbox per user (design 7.7). Multi-inbox/team routing is deferred. */
const PERSONAL_INBOX_ID = 'my';

/**
 * Phase-0 coordinator skeleton. It subscribes to the single ambient event stream
 * and owns the intake seam. The deterministic dispatch gate, role selection,
 * admission control, and worker dispatch are layered on top of this in the
 * coordinator workstream; for now intake is observed and recorded so the
 * ingress -> coordinator loop is verifiable end to end.
 */
export class DiffyCoordinatorService extends Disposable implements IDiffyCoordinatorService {

	declare readonly _serviceBrand: undefined;

	readonly inboxId = PERSONAL_INBOX_ID;

	constructor(
		@IEventIngress private readonly ingress: IEventIngress,
		@IInboxOneStore private readonly store: IInboxOneStore,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.ingress.onDidReceiveEvent(event => {
			// Fire-and-forget: intake failures must never crash the coordinator loop.
			this.handleEvent(event).catch(err => this.logService.error('[inboxOne] coordinator intake failed', err));
		}));
	}

	async handleEvent(event: IIngressEvent): Promise<void> {
		// The dispatch gate (design 4) and worker dispatch are implemented in the
		// coordinator workstream. This skeleton records that the event reached the
		// coordinator so the wiring can be verified; it never mints a task yet.
		this.logService.trace(`[inboxOne] Diffy received ${event.type}${event.action ? '.' + event.action : ''} for ${event.repo ?? event.sessionId ?? 'unknown'} (inbox ${this.inboxId}, ${this.store.tasks.get().length} tasks)`);
	}
}
