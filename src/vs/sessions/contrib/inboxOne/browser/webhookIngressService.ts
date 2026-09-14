/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { IEventIngress } from '../common/eventIngress.js';
import { fetchBackfillPage } from '../common/githubBackfillFetcher.js';
import { IInboxOneSettings } from '../common/inboxOneSettings.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { IDropLedgerEntry, IIngressEvent } from '../common/inboxOneTypes.js';
import { IBackfillFetcher, IBackfillPage, IReceiverAdapter, IWebhookIngressHost, WebhookIngress } from '../common/webhookIngress.js';

/**
 * The receiver adapter for the client MVP. The steady-state webhook transport is
 * a localhost HTTP receiver exposed over a dev tunnel, which requires the desktop
 * host + a registered GitHub webhook; that physical assembly is not wired here.
 *
 * What IS wired: app startup is treated as a downtime recovery, so this adapter
 * reports connected once on {@link start}. That single `false -> true` transition
 * drives exactly one backfill (the spec's "poll once on recovery, never
 * periodically"), catching up on repo activity created while the app was closed.
 * No deliveries are forwarded (no live receiver yet), and it never reports
 * connected again, so there is no steady-state polling.
 */
class StartupRecoveryReceiverAdapter extends Disposable implements IReceiverAdapter {
	private readonly _onConnectivityChange = this._register(new Emitter<boolean>());
	readonly onConnectivityChange = this._onConnectivityChange.event;
	readonly onDelivery = Event.None;
	async computeSignature(): Promise<string | undefined> { return undefined; }
	async start(): Promise<void> {
		// One-time startup recovery -> triggers exactly one catch-up backfill.
		this._onConnectivityChange.fire(true);
	}
}

/**
 * The one-time downtime-recovery backfill, backed by the viewer's GitHub session.
 * Reuses the pure {@link fetchBackfillPage} (issues + PRs updated since the
 * cursor) via {@link IGitHubService.requestRest}. Auth/errors degrade to an empty
 * page, so this is a safe no-op when signed out (e.g. the web harness).
 */
class GitHubBackfillFetcher implements IBackfillFetcher {
	constructor(
		private readonly github: IGitHubService,
		private readonly logService: ILogService,
	) { }

	async fetchSince(repo: string, cursor: string | undefined): Promise<IBackfillPage> {
		try {
			const page = await fetchBackfillPage((method, path) => this.github.requestRest(method, path), repo, cursor);
			if (page.events.length) {
				this.logService.info(`[inboxOne] backfill: ${page.events.length} change(s) for ${repo} since ${cursor ?? 'startup window'}`);
			}
			return page;
		} catch (err) {
			this.logService.warn(`[inboxOne] backfill fetch failed for ${repo}: ${err instanceof Error ? err.message : String(err)}`);
			return { events: [] };
		}
	}
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
		@IGitHubService github: IGitHubService,
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
		const webhook = this._register(new WebhookIngress(
			this._register(new StartupRecoveryReceiverAdapter()),
			new GitHubBackfillFetcher(github, logService),
			host,
			logService,
		));
		// Load enrollments before the startup backfill fires, so it has repos to catch up.
		settings.initialize()
			.then(() => webhook.start())
			.catch(err => logService.error('[inboxOne] webhook ingress start failed', err));
		logService.trace('[inboxOne] webhook ingress ready (startup backfill + steady-state webhooks; no periodic polling)');
	}
}
