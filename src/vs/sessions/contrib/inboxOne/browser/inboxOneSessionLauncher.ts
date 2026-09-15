/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsRecentWorkspacesService } from '../../../services/sessions/browser/sessionsRecentWorkspacesService.js';

export const IInboxOneSessionLauncher = createDecorator<IInboxOneSessionLauncher>('inboxOneSessionLauncher');

export interface ILaunchOptions {
	/** Session title (shown in the list). */
	readonly title: string;
	/** Provider metadata stamped on the session (e.g. to route its lifecycle events back to an owning task). */
	readonly metadata?: Record<string, unknown>;
	/** Short activity label for diagnostics (e.g. `worker code-review`, `distiller`). */
	readonly activity: string;
}

/**
 * The single seam through which ALL Inbox One agent sessions are created and
 * messaged (worker dispatch, the learning distiller/curator, and any future
 * ambient session). It adds no runtime of its own: it reuses the exact session
 * harness the New Session composer uses ({@link ISessionsManagementService}),
 * targeting the SAME default workspace the composer would (the sessions window's
 * folder, else the most-recent workspace that can host a session). This keeps
 * every inbox agent call generic -- no per-feature folder resolution, no cloud
 * redirect, no simulation -- so wherever a human could start a New Session, Diffy
 * can start one too.
 */
export interface IInboxOneSessionLauncher {
	readonly _serviceBrand: undefined;

	/**
	 * Whether a session could be started right now (a servable workspace target
	 * exists), mirroring the New Session composer's availability.
	 */
	canLaunch(): boolean;

	/**
	 * Start a background agent session whose first message is {@link firstMessage},
	 * in the default workspace. Returns the committed session, or `undefined` when
	 * no session target is available yet (same as the composer showing an empty
	 * state) or the send failed.
	 */
	launch(firstMessage: string, options: ILaunchOptions): Promise<ISession | undefined>;

	/**
	 * Relay a follow-up message into an existing session (steering / warm reuse),
	 * fire-and-forget in the background. Returns `false` when the session is gone
	 * or the ref is not a real session.
	 */
	relay(sessionRef: string, message: string): Promise<boolean>;
}

export class InboxOneSessionLauncher implements IInboxOneSessionLauncher {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ISessionsRecentWorkspacesService private readonly recentWorkspaces: ISessionsRecentWorkspacesService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) { }

	canLaunch(): boolean {
		return !!this.resolveDefaultFolder();
	}

	async launch(firstMessage: string, options: ILaunchOptions): Promise<ISession | undefined> {
		const folder = this.resolveDefaultFolder();
		if (!folder) {
			this.logService.info(`[inboxOne] no session target available to launch ${options.activity} (open a workspace as you would for a New Session)`);
			return undefined;
		}
		try {
			const session = await this.sessions.createAndSendNewChatRequest(
				folder,
				{ query: firstMessage, title: options.title, background: true },
				options.metadata ? { metadata: options.metadata } : undefined,
			);
			if (session) {
				this.logService.info(`[inboxOne] launched ${options.activity} -> ${session.resource.toString()}`);
			}
			return session;
		} catch (err) {
			this.logService.error(`[inboxOne] launch ${options.activity} failed`, err);
			return undefined;
		}
	}

	async relay(sessionRef: string, message: string): Promise<boolean> {
		let uri: URI;
		try {
			uri = URI.parse(sessionRef);
		} catch {
			return false;
		}
		const session = this.sessions.getSession(uri);
		if (!session) {
			return false;
		}
		try {
			await this.sessions.sendRequest(session, session.mainChat.get(), { query: message, background: true });
			return true;
		} catch (err) {
			this.logService.warn(`[inboxOne] relay to ${sessionRef} failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/**
	 * The default workspace a New Session would target: the sessions window's open
	 * folder if there is one, otherwise the most-recent workspace that can host a
	 * session (the same recent-workspaces list the composer's workspace picker
	 * offers). Only servable targets are returned, so a stale/unservable entry is
	 * skipped rather than causing a failed dispatch.
	 */
	private resolveDefaultFolder(): URI | undefined {
		const local = this.workspaceContext.getWorkspace().folders[0]?.uri;
		if (local && this.sessions.isNewSessionTargetAvailable(local)) {
			return local;
		}
		for (const recent of this.recentWorkspaces.getRecentWorkspaces()) {
			const root = recent.workspace.folders[0]?.root;
			if (root && this.sessions.isNewSessionTargetAvailable(root)) {
				return root;
			}
		}
		return undefined;
	}
}
