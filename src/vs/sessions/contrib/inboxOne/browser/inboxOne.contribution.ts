/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { IDiffyCoordinatorService } from '../common/diffyCoordinator.js';
import { IEventIngress } from '../common/eventIngress.js';
import { IInboxOneFileStore } from '../common/inboxOneFileStore.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { IInboxOneSettings } from '../common/inboxOneSettings.js';
import { DiffyCoordinatorService, INBOX_ONE_SIMULATE_WORKERS_SETTING } from './diffyCoordinatorService.js';
import { EventIngress } from './eventIngress.js';
import { INBOX_ONE_ACTIONS, INBOX_ONE_DEV_ACTIONS } from './inboxOneCommands.js';
import { InboxOneSettingsService } from './inboxOneSettingsService.js';
import { InboxOneStore } from './inboxOneStore.js';
import { InboxOneView } from './inboxOneView.js';
import { ChatTriageService } from './chatTriageService.js';
import { LearningOrchestratorService } from './learningOrchestratorService.js';
import { NotificationOrchestrator } from './notificationOrchestrator.js';
import { SessionEventAdapterService } from './sessionEventAdapterService.js';
import { WebhookIngressService } from './webhookIngressService.js';
import { InboxOneSettingsView } from './inboxOneSettingsView.js';
import { InboxOneSkillsView } from './inboxOneSkillsView.js';
import { WorkbenchInboxOneFileStore } from './workbenchInboxOneFileStore.js';

export const INBOX_ONE_ENABLED_SETTING = 'inboxOne.enabled';
const INBOX_ONE_VIEW_ID = 'sessions.inboxOne.view';
const INBOX_ONE_SETTINGS_VIEW_ID = 'sessions.inboxOne.settings';
const INBOX_ONE_SKILLS_VIEW_ID = 'sessions.inboxOne.skills';

// --- shared services ---
registerSingleton(IInboxOneStore, InboxOneStore, InstantiationType.Delayed);
registerSingleton(IInboxOneSettings, InboxOneSettingsService, InstantiationType.Delayed);
registerSingleton(IInboxOneFileStore, WorkbenchInboxOneFileStore, InstantiationType.Delayed);
registerSingleton(IEventIngress, EventIngress, InstantiationType.Delayed);
registerSingleton(IDiffyCoordinatorService, DiffyCoordinatorService, InstantiationType.Delayed);

// --- commands (command palette) ---
for (const action of INBOX_ONE_ACTIONS) {
	registerAction2(action);
}
// Dev-only simulator commands: never registered in stable builds, so their
// synthetic (hardcoded) evidence can never be triggered in production.
if (product.quality !== 'stable') {
	for (const action of INBOX_ONE_DEV_ACTIONS) {
		registerAction2(action);
	}
}

/** Registers the tiered inbox custom view. */
class InboxOneViewContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.inboxOneView';
	constructor(
		@ICustomViewService customViewService: ICustomViewService,
	) {
		super();
		this._register(customViewService.registerCustomView({
			id: INBOX_ONE_VIEW_ID,
			ctor: new SyncDescriptor(InboxOneView),
		}));
		this._register(customViewService.registerCustomView({
			id: INBOX_ONE_SETTINGS_VIEW_ID,
			ctor: new SyncDescriptor(InboxOneSettingsView),
		}));
		this._register(customViewService.registerCustomView({
			id: INBOX_ONE_SKILLS_VIEW_ID,
			ctor: new SyncDescriptor(InboxOneSkillsView),
		}));
	}
}
registerWorkbenchContribution2(InboxOneViewContribution.ID, InboxOneViewContribution, WorkbenchPhase.BlockRestore);

/** Opens the tiered inbox view. */
class ShowInboxAction extends Action2 {
	constructor() {
		super({
			id: 'inboxOne.showInbox',
			title: localize2('inboxOne.showInbox', 'Show Inbox'),
			category: localize2('inboxOne.category', 'Inbox'),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(INBOX_ONE_VIEW_ID);
	}
}
registerAction2(ShowInboxAction);

/** Opens Settings > Coordinator. */
class ShowSettingsAction extends Action2 {
	constructor() {
		super({
			id: 'inboxOne.showSettings',
			title: localize2('inboxOne.showSettings', 'Coordinator Settings'),
			category: localize2('inboxOne.category', 'Inbox'),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(INBOX_ONE_SETTINGS_VIEW_ID);
	}
}
registerAction2(ShowSettingsAction);

/** Opens the Skills & Roles view. */
class ShowSkillsAction extends Action2 {
	constructor() {
		super({
			id: 'inboxOne.showSkills',
			title: localize2('inboxOne.showSkills', 'Skills & Roles'),
			category: localize2('inboxOne.category', 'Inbox'),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(INBOX_ONE_SKILLS_VIEW_ID);
	}
}
registerAction2(ShowSkillsAction);

/**
 * Boots the always-on coordinator so it begins observing the ambient event
 * stream as soon as the window is ready. The coordinator is inert until ingress
 * transports are registered; enabling/disabling gates transport + UI activation.
 */
class InboxOneContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.inboxOne';

	constructor(
		@IDiffyCoordinatorService _coordinator: IDiffyCoordinatorService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// Resolving the coordinator eagerly wires ingress -> coordinator intake.
		// The notification orchestrator turns pushable decisions into OS notifications.
		this._register(instantiationService.createInstance(NotificationOrchestrator));
		// The webhook ingress wires the steady-state transport seam (backfill on
		// downtime recovery only; no periodic polling).
		this._register(instantiationService.createInstance(WebhookIngressService));
		// The learning loop runs the distiller/curator on every task resolution.
		this._register(instantiationService.createInstance(LearningOrchestratorService));
		// Route Diffy's dispatched worker-session lifecycle back into the inbox (G15).
		this._register(instantiationService.createInstance(SessionEventAdapterService));
		// Surface conversation threads that need the human (ask_user) in the inbox.
		this._register(instantiationService.createInstance(ChatTriageService));
	}
}

registerWorkbenchContribution2(InboxOneContribution.ID, InboxOneContribution, WorkbenchPhase.Eventually);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'inboxOne',
	order: 100,
	type: 'object',
	title: localize('inboxOne.title', "Inbox"),
	properties: {
		[INBOX_ONE_ENABLED_SETTING]: {
			type: 'boolean',
			default: product.quality !== 'stable',
			scope: ConfigurationScope.MACHINE,
			tags: ['experimental', 'advanced'],
			description: localize('inboxOne.enabled', "Enables Inbox One: an always-on coordinator (Diffy) that watches enrolled repositories, dispatches ambient worker sessions, and surfaces evidence-backed decisions in a single prioritized inbox."),
		},
		[INBOX_ONE_SIMULATE_WORKERS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.MACHINE,
			tags: ['experimental', 'advanced'],
			description: localize('inboxOne.simulateWorkers', "Dev builds only: run in-window simulated workers when no agent host is connected, so the full coordinator loop is testable headless. Turn this off to drive the real agent host / cloud path instead (open a repo folder for the local host). Ignored in stable builds, which never simulate. Takes effect on window reload."),
		},
	},
});
