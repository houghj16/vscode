/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import product from '../../../../platform/product/common/product.js';
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
import { ITranscriptSource, TranscriptWorkerResultReader } from '../common/workerResult.js';
import { LiveAdmissionManager } from './liveAdmissionManager.js';
import { isPendingRef, SessionsManagementWorkerDispatcher } from './sessionsManagementWorkerDispatcher.js';
import { CompositeTranscriptSource, FallbackWorkerDispatcher, SimulatedWorkerDispatcher, SimulatedWorkerRuntime } from './simulatedWorkerDispatcher.js';
import { WorkbenchTranscriptSource } from './workbenchTranscriptSource.js';

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
		const isDevBuild = product.quality !== 'stable';
		// In dev builds the real dispatcher does NOT fall back to the (flakier)
		// cloud path when the window has no local folder -- it defers, and the
		// in-window simulator below takes over, so the dev loop is fast and
		// deterministic. Stable builds keep the real cloud fallback.
		const realDispatcher = instantiationService.createInstance(SessionsManagementWorkerDispatcher, !isDevBuild);
		// Reads a finished worker session's final message from the chat model, so
		// `task_finished` produces real evidence with a connected host.
		const workbenchSource = instantiationService.createInstance(WorkbenchTranscriptSource);

		let dispatcher: IWorkerDispatcher = realDispatcher;
		let transcriptSource: ITranscriptSource = workbenchSource;
		// Dev builds fall back to an in-window worker simulator when no agent host
		// is connected, so the full production loop (dispatch -> run -> emit-result
		// -> host-validate -> host-rank -> land) is exercised headless with real,
		// non-hardcoded evidence. Never wired in stable builds (see the gate), so
		// simulated evidence can never reach production.
		if (isDevBuild) {
			const runtime = this._register(new SimulatedWorkerRuntime(this.ingress, this.logService));
			const simulated = new SimulatedWorkerDispatcher(runtime);
			dispatcher = new FallbackWorkerDispatcher(realDispatcher, simulated, this.logService, isPendingRef);
			transcriptSource = new CompositeTranscriptSource([runtime, workbenchSource]);
		}

		const resultReader = new TranscriptWorkerResultReader(transcriptSource);
		this.engine = new CoordinatorEngine(this.inboxId, this.store, this.settings, admission, dispatcher, this.logService, undefined, resultReader);

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
