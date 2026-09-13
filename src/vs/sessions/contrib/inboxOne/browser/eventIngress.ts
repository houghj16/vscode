/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEventIngress, IEventTransport } from '../common/eventIngress.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { IIngressEvent } from '../common/inboxOneTypes.js';

/**
 * Transport-agnostic event ingress. Dedupes on `delivery_id` through the durable
 * store (I2) and fans accepted events out to the coordinator. Transports (webhook
 * receiver, backfill poller, session-status adapter) call {@link submit}.
 */
export class EventIngress extends Disposable implements IEventIngress {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidReceiveEvent = this._register(new Emitter<IIngressEvent>());
	readonly onDidReceiveEvent: Event<IIngressEvent> = this._onDidReceiveEvent.event;

	private readonly _transports = new Set<IEventTransport>();

	constructor(
		@IInboxOneStore private readonly store: IInboxOneStore,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async submit(event: IIngressEvent): Promise<boolean> {
		const fresh = await this.store.markDeliverySeen(event.deliveryId);
		if (!fresh) {
			this.logService.trace(`[inboxOne] ingress: duplicate delivery ${event.deliveryId} (${event.type}) ignored`);
			return false;
		}
		this.logService.trace(`[inboxOne] ingress: accepted ${event.type}${event.action ? '.' + event.action : ''} ${event.deliveryId}`);
		this._onDidReceiveEvent.fire(event);
		return true;
	}

	registerTransport(transport: IEventTransport): IDisposable {
		this._transports.add(transport);
		const store = new DisposableStore();
		store.add(transport);
		store.add(toDisposable(() => this._transports.delete(transport)));
		return store;
	}
}
