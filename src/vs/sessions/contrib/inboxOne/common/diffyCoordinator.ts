/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IIngressEvent } from './inboxOneTypes.js';

export const IDiffyCoordinatorService = createDecorator<IDiffyCoordinatorService>('diffyCoordinatorService');

/**
 * The always-on coordinator ("Diffy"). It is a durable, pinned coordinator
 * session per inbox (design 7.7). It consumes the single ambient event stream,
 * runs the deterministic dispatch gate (design 4), and dispatches worker
 * sessions whose results land in the tiered inbox.
 *
 * This Phase-0 contract exposes the event intake seam. The dispatch gate, role
 * selection, admission control, and worker dispatch are layered on in the
 * coordinator workstream.
 */
export interface IDiffyCoordinatorService {
	readonly _serviceBrand: undefined;

	/** The inbox this coordinator serves. MVP: a single personal inbox per user. */
	readonly inboxId: string;

	/**
	 * Process one normalized ambient event. Both GitHub world events and agent
	 * session lifecycle events flow through here identically (gate -> group_key
	 * -> dispatch/land). Idempotent with respect to the event's delivery id.
	 */
	handleEvent(event: IIngressEvent): Promise<void>;
}
