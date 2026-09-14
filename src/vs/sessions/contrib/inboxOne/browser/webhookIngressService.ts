/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEventIngress } from '../common/eventIngress.js';
import { IInboxOneSettings } from '../common/inboxOneSettings.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { IDropLedgerEntry, IIngressEvent } from '../common/inboxOneTypes.js';
import { IBackfillFetcher, IBackfillPage, IReceiverAdapter, IWebhookIngressHost, WebhookIngress } from '../common/webhookIngress.js';

/**
 * The web/no-host receiver adapter. The steady-state webhook transport is a
 * localhost HTTP receiver exposed over a dev tunnel, which requires the desktop
 * (electron/node) host; in web mode there is no such server, so this adapter
 * never reports connected and forwards no deliveries. It is the drop-in seam an
 * electron adapter replaces -- no polling fallback is introduced here, matching
 * the "webhooks steady-state; backfill only on downtime recovery" mandate.
 */
class InertReceiverAdapter implements IReceiverAdapter {
	readonly onConnectivityChange = Event.None;
	readonly onDelivery = Event.None;
	async computeSignature(): Promise<string | undefined> { return undefined; }
	async start(): Promise<void> { }
	dispose(): void { }
}

/** The no-op backfill fetcher used until a GitHub-REST-backed fetcher is wired. */
class InertBackfillFetcher implements IBackfillFetcher {
	async fetchSince(): Promise<IBackfillPage> { return { events: [] }; }
}

/**
 * Integrates {@link WebhookIngress} into the workbench: implements the
 * {@link IWebhookIngressHost} surface over the real store/ingress/settings, and
 * (in web) wires the inert receiver seam. On a desktop host, the InertReceiver /
 * InertBackfill are replaced by the localhost-receiver + GitHub-REST fetcher; the
 * verified orchestration in {@link WebhookIngress} is unchanged.
 */
export class WebhookIngressService extends Disposable {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IEventIngress ingress: IEventIngress,
		@IInboxOneStore store: IInboxOneStore,
		@IInboxOneSettings settings: IInboxOneSettings,
		@ILogService logService: ILogService,
	) {
		super();
		const host: IWebhookIngressHost = {
			submit: (event: IIngressEvent) => ingress.submit(event),
			recordDrop: (entry: IDropLedgerEntry) => store.recordDrop(entry),
			getCursor: (repo: string) => store.getCursor(repo),
			setCursor: (repo: string, cursor: string) => store.setCursor(repo, cursor),
			enrolledRepos: () => settings.listEnrollments().filter(e => e.active).map(e => e.repo),
		};
		const webhook = this._register(new WebhookIngress(new InertReceiverAdapter(), new InertBackfillFetcher(), host, logService));
		webhook.start().catch(err => logService.error('[inboxOne] webhook receiver start failed', err));
		logService.trace('[inboxOne] webhook ingress ready (steady-state webhooks; backfill only on downtime recovery)');
	}
}
