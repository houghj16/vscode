/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IDiffyCoordinatorService } from '../common/diffyCoordinator.js';
import { IEventIngress } from '../common/eventIngress.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { IInboxOneSettings } from '../common/inboxOneSettings.js';
import { DiffyCoordinatorService } from './diffyCoordinatorService.js';
import { EventIngress } from './eventIngress.js';
import { InboxOneSettingsService } from './inboxOneSettingsService.js';
import { InboxOneStore } from './inboxOneStore.js';

export const INBOX_ONE_ENABLED_SETTING = 'inboxOne.enabled';

// --- shared services ---
registerSingleton(IInboxOneStore, InboxOneStore, InstantiationType.Delayed);
registerSingleton(IInboxOneSettings, InboxOneSettingsService, InstantiationType.Delayed);
registerSingleton(IEventIngress, EventIngress, InstantiationType.Delayed);
registerSingleton(IDiffyCoordinatorService, DiffyCoordinatorService, InstantiationType.Delayed);

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
