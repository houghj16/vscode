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
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { IDiffyCoordinatorService } from '../common/diffyCoordinator.js';
import { IEventIngress } from '../common/eventIngress.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { IInboxOneSettings } from '../common/inboxOneSettings.js';
import { DiffyCoordinatorService } from './diffyCoordinatorService.js';
import { EventIngress } from './eventIngress.js';
import { INBOX_ONE_ACTIONS } from './inboxOneCommands.js';
import { InboxOneSettingsService } from './inboxOneSettingsService.js';
import { InboxOneStore } from './inboxOneStore.js';
import { InboxOneView } from './inboxOneView.js';
import { InboxOneSettingsView } from './inboxOneSettingsView.js';

export const INBOX_ONE_ENABLED_SETTING = 'inboxOne.enabled';
const INBOX_ONE_VIEW_ID = 'sessions.inboxOne.view';
const INBOX_ONE_SETTINGS_VIEW_ID = 'sessions.inboxOne.settings';

// --- shared services ---
registerSingleton(IInboxOneStore, InboxOneStore, InstantiationType.Delayed);
registerSingleton(IInboxOneSettings, InboxOneSettingsService, InstantiationType.Delayed);
registerSingleton(IEventIngress, EventIngress, InstantiationType.Delayed);
registerSingleton(IDiffyCoordinatorService, DiffyCoordinatorService, InstantiationType.Delayed);

// --- commands (command palette) ---
for (const action of INBOX_ONE_ACTIONS) {
	registerAction2(action);
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
	}
}
registerWorkbenchContribution2(InboxOneViewContribution.ID, InboxOneViewContribution, WorkbenchPhase.BlockRestore);

/** Opens the tiered inbox view. */
class ShowInboxAction extends Action2 {
	constructor() {
		super({
			id: 'inboxOne.showInbox',
			title: localize2('inboxOne.showInbox', 'Show Inbox'),
			category: localize2('inboxOne.category', 'Inbox One'),
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
			category: localize2('inboxOne.category', 'Inbox One'),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(INBOX_ONE_SETTINGS_VIEW_ID);
	}
}
registerAction2(ShowSettingsAction);

/**
 * Boots the always-on coordinator so it begins observing the ambient event
 * stream as soon as the window is ready. The coordinator is inert until ingress
 * transports are registered; enabling/disabling gates transport + UI activation.
 */
class InboxOneContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.inboxOne';

	constructor(
		@IDiffyCoordinatorService _coordinator: IDiffyCoordinatorService,
	) {
		super();
		// Resolving the coordinator eagerly wires ingress -> coordinator intake.
	}
}

registerWorkbenchContribution2(InboxOneContribution.ID, InboxOneContribution, WorkbenchPhase.Eventually);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'inboxOne',
	order: 100,
	type: 'object',
	title: localize('inboxOne.title', "Inbox One"),
	properties: {
		[INBOX_ONE_ENABLED_SETTING]: {
			type: 'boolean',
			default: product.quality !== 'stable',
			scope: ConfigurationScope.MACHINE,
			tags: ['experimental', 'advanced'],
			description: localize('inboxOne.enabled', "Enables Inbox One: an always-on coordinator (Diffy) that watches enrolled repositories, dispatches ambient worker sessions, and surfaces evidence-backed decisions in a single prioritized inbox."),
		},
	},
});
