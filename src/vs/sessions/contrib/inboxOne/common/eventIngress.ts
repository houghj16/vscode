/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IIngressEvent } from './inboxOneTypes.js';

export const IEventIngress = createDecorator<IEventIngress>('inboxOneEventIngress');

/**
 * A source of normalized ambient events (technical spec 3). Both GitHub world
 * monitoring and agent-session lifecycle observation are transports: they
 * normalize their raw signals to {@link IIngressEvent} and call
 * {@link IEventIngress.submit}. The thread is the central primitive, so a worker
 * finishing is not a special path -- it is an ambient event like a new PR.
 */
export interface IEventTransport extends IDisposable {
	readonly id: string;
	/**
	 * Whether this transport is currently connected/healthy. Used by the ingress
	 * to trigger a one-time backfill on a down->up transition (webhook receiver).
	 */
	readonly connected?: Event<boolean>;
}

/**
 * The single, transport-agnostic entry point for ambient events. Dedupes on
 * `delivery_id` (at-least-once + idempotent, I2) and fans accepted events out to
 * the coordinator. The webhook receiver, backfill poller, and session-status
 * adapter all feed this one stream.
 */
export interface IEventIngress {
	readonly _serviceBrand: undefined;

	/** Fires for every newly-accepted (non-duplicate) event. */
	readonly onDidReceiveEvent: Event<IIngressEvent>;

	/**
	 * Submit a normalized event. Returns `true` when newly accepted, `false` when
	 * it duplicates a delivery id already seen (safe to replay).
	 */
	submit(event: IIngressEvent): Promise<boolean>;

	/** Register a transport so the ingress can observe its health for backfill coordination. */
	registerTransport(transport: IEventTransport): IDisposable;
}
