/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { IEventIngress } from '../common/eventIngress.js';
import { EventSource, IIngressEvent } from '../common/inboxOneTypes.js';
import { mapSessionStatusToEventType, shouldEmitOnTransition } from '../common/sessionEventMapping.js';

/**
 * A worker session observed by the adapter: a stable ref and its current status.
 * Abstracted so the adapter's transition logic is testable without the session
 * runtime; a thin glue implements this from `ISessionsManagementService`.
 */
export interface IWorkerSessionSnapshot {
	/** The provider-neutral session ref stored on the owning task's attempt. */
	readonly sessionRef: string;
	readonly status: SessionStatus;
}

/** Source of worker-session snapshots; the adapter subscribes to changes. */
export interface IWorkerSessionSource {
	/** Current snapshots of the sessions Diffy dispatched. */
	current(): readonly IWorkerSessionSnapshot[];
	/** Fires whenever any observed worker session's status may have changed. */
	onDidChange(listener: () => void): { dispose(): void };
}

/**
 * Turns agent-session lifecycle into ambient events (technical spec 3, 2.3).
 *
 * The thread is the central primitive: a worker finishing / needing input /
 * failing is an ambient event, submitted to the SAME ingress as GitHub events and
 * routed by the coordinator to the owning task (G15). This adapter tracks the
 * last seen status per worker session and emits a normalized event on each
 * meaningful transition (edge-triggered, de-duplicated).
 */
export class SessionEventAdapter extends Disposable {

	private readonly lastStatus = new Map<string, SessionStatus>();

	constructor(
		private readonly source: IWorkerSessionSource,
		private readonly ingress: IEventIngress,
		private readonly logService: ILogService,
	) {
		super();
		this._register(this.source.onDidChange(() => this.reconcile()));
		this.reconcile();
	}

	private reconcile(): void {
		for (const snapshot of this.source.current()) {
			const previous = this.lastStatus.get(snapshot.sessionRef);
			if (!shouldEmitOnTransition(previous, snapshot.status)) {
				this.lastStatus.set(snapshot.sessionRef, snapshot.status);
				continue;
			}
			this.lastStatus.set(snapshot.sessionRef, snapshot.status);
			const type = mapSessionStatusToEventType(snapshot.status);
			if (!type) {
				continue;
			}
			const event = this.buildEvent(snapshot.sessionRef, type);
			this.ingress.submit(event).catch(err => this.logService.error('[inboxOne] session event submit failed', err));
		}
	}

	private buildEvent(sessionRef: string, type: string): IIngressEvent {
		const sessionId = sessionRefToId(sessionRef);
		return {
			// A fresh delivery id per transition; the store dedupes replays and the
			// coordinator dedupes by owning task + group_key.
			deliveryId: `session:${sessionId}:${type}:${generateUuid()}`,
			source: EventSource.Session,
			sessionId: sessionRef,
			type,
			subject: { kind: 'session', id: sessionId },
			receivedAt: Date.now(),
		};
	}
}

/** Extracts a display id from a session ref for the event subject. */
function sessionRefToId(sessionRef: string): string {
	const slash = sessionRef.lastIndexOf('/');
	return slash === -1 ? sessionRef : sessionRef.slice(slash + 1);
}
