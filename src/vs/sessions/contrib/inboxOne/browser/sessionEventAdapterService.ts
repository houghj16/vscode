/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IEventIngress } from '../common/eventIngress.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { IWorkerSessionSnapshot, IWorkerSessionSource, SessionEventAdapter } from './sessionEventAdapter.js';

/**
 * Feeds live agent-session lifecycle to the {@link SessionEventAdapter} (design
 * 2, gotcha G15). The thread is the central primitive: a worker session Diffy
 * dispatched that finishes / needs input / fails is an ambient event, submitted
 * to the SAME ingress as GitHub events and routed by the coordinator back to the
 * owning task.
 *
 * A session is "ours" when its provider-neutral resource matches the
 * `sessionRef` recorded on a task's current attempt (the dispatcher stamps it via
 * {@link IInboxOneStore.updateTask}). We watch each owned session's status
 * observable and pulse the adapter, which edge-triggers a normalized event on
 * each meaningful transition.
 */
class WorkbenchWorkerSessionSource extends Disposable implements IWorkerSessionSource {

	private readonly _onDidChange = this._register(new Emitter<void>());
	private readonly statusWatchers = this._register(new DisposableStore());

	constructor(
		private readonly sessions: ISessionsManagementService,
		private readonly store: IInboxOneStore,
	) {
		super();
		this._register(this.sessions.onDidChangeSessions(() => this.rewatch()));
		this.rewatch();
	}

	current(): readonly IWorkerSessionSnapshot[] {
		const snapshots: IWorkerSessionSnapshot[] = [];
		for (const session of this.sessions.getSessions()) {
			const sessionRef = session.resource.toString();
			if (this.store.getTaskBySession(sessionRef)) {
				snapshots.push({ sessionRef, status: session.status.get() });
			}
		}
		return snapshots;
	}

	onDidChange(listener: () => void): { dispose(): void } {
		return this._onDidChange.event(listener);
	}

	/** Rebuild per-session status watchers over the currently-owned sessions. */
	private rewatch(): void {
		this.statusWatchers.clear();
		for (const session of this.sessions.getSessions()) {
			if (this.store.getTaskBySession(session.resource.toString())) {
				this.statusWatchers.add(autorun(reader => {
					session.status.read(reader);
					this._onDidChange.fire();
				}));
			}
		}
	}
}

/**
 * Boots the session-event adapter over the real sessions service, so Diffy's
 * dispatched worker sessions reactivate their owning tasks on lifecycle
 * transitions. Inert until a worker session exists (no host -> no owned sessions
 * -> no events), so it is safe to boot everywhere.
 */
export class SessionEventAdapterService extends Disposable {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ISessionsManagementService sessions: ISessionsManagementService,
		@IInboxOneStore store: IInboxOneStore,
		@IEventIngress ingress: IEventIngress,
		@ILogService logService: ILogService,
	) {
		super();
		const source = this._register(new WorkbenchWorkerSessionSource(sessions, store));
		this._register(new SessionEventAdapter(source, ingress, logService));
	}
}
