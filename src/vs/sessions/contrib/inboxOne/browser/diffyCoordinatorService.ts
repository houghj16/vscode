/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAutomationStorageService } from '../../automations/common/automationStorageService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CoordinatorEngine } from '../common/coordinatorEngine.js';
import { IDiffyCoordinatorService } from '../common/diffyCoordinator.js';
import { IEventIngress } from '../common/eventIngress.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { IInboxOneSettings } from '../common/inboxOneSettings.js';
import { IIngressEvent } from '../common/inboxOneTypes.js';
import { IWorkerDispatcher } from '../common/workerDispatcher.js';
import { LiveAdmissionManager } from './liveAdmissionManager.js';
import { SessionsManagementWorkerDispatcher } from './sessionsManagementWorkerDispatcher.js';

/** MVP: a single personal inbox per user (design 7.7). Multi-inbox/team routing is deferred. */
const PERSONAL_INBOX_ID = 'my';

/**
 * The always-on coordinator ("Diffy"). Bootstraps the durable services, builds
 * the deterministic {@link CoordinatorEngine}, and drives it from the single
 * ambient event stream. Worker dispatch is delegated to an
 * {@link IWorkerDispatcher}; until the session-harness-backed dispatcher lands, a
 * stub records intent so the ingress -> gate -> admission -> store loop runs
 * end to end.
 */
export class DiffyCoordinatorService extends Disposable implements IDiffyCoordinatorService {

	declare readonly _serviceBrand: undefined;

	readonly inboxId = PERSONAL_INBOX_ID;

	private readonly engine: CoordinatorEngine;
	private readonly ready: Promise<void>;

	constructor(
		@IEventIngress private readonly ingress: IEventIngress,
		@IInboxOneStore private readonly store: IInboxOneStore,
		@IInboxOneSettings private readonly settings: IInboxOneSettings,
		@IAutomationStorageService storage: IAutomationStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const admission = new LiveAdmissionManager(this.store, this.settings, storage);
		const dispatcher: IWorkerDispatcher = instantiationService.createInstance(SessionsManagementWorkerDispatcher);
		this.engine = new CoordinatorEngine(this.inboxId, this.store, this.settings, admission, dispatcher, this.logService);

		this.ready = this.settings.initialize();

		this._register(this.ingress.onDidReceiveEvent(event => {
			// Fire-and-forget: intake failures must never crash the coordinator loop.
			this.handleEvent(event).catch(err => this.logService.error('[inboxOne] coordinator intake failed', err));
		}));
	}

	async handleEvent(event: IIngressEvent): Promise<void> {
		await this.ready;
		await this.engine.handleEvent(event);
	}
}
