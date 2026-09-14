/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BackfillController } from './backfillController.js';
import { IWebhookHeaders, normalizeWebhook, verifyWebhookSignature } from './githubWebhook.js';
import { IDropLedgerEntry, IIngressEvent } from './inboxOneTypes.js';

/**
 * Webhook ingress orchestration (technical spec 3, workstream A). Ties the pure
 * webhook normalization/verification and the {@link BackfillController} to the
 * event ingress behind a narrow platform seam:
 *
 *  - {@link IReceiverAdapter} is the platform-specific localhost HTTP receiver +
 *    dev-tunnel + configured secret (Node/electron). It emits verified-or-not
 *    deliveries and connectivity transitions and can compute the local HMAC.
 *  - {@link IBackfillFetcher} is the cursor-based GitHub catch-up used ONLY on a
 *    downtime recovery (never periodically).
 *  - {@link IWebhookIngressHost} is the store/ingress/settings surface.
 *
 * This class contains all the receiver behavior that must be correct
 * (signature-closed-by-default, drop accounting, one backfill per recovery,
 * cursor advance) and is fully unit-testable without a live tunnel or GitHub app.
 */

/** A single delivered webhook forwarded by the receiver adapter. */
export interface IWebhookDelivery {
	readonly headers: IWebhookHeaders;
	/** The exact bytes the signature was computed over. */
	readonly rawBody: string;
	/** The parsed JSON payload. */
	readonly payload: unknown;
}

/** Platform receiver: localhost HTTP server exposed via a dev tunnel (A.2). */
export interface IReceiverAdapter extends IDisposable {
	/** Fires `true` when the receiver+tunnel are up, `false` when down. */
	readonly onConnectivityChange: Event<boolean>;
	/** Fires for each delivered webhook. */
	readonly onDelivery: Event<IWebhookDelivery>;
	/**
	 * HMAC-SHA256 hex of `rawBody` under the configured secret, or `undefined`
	 * when no secret is configured (verification then skipped). Deliberately async
	 * so a WebCrypto/Node adapter can back it.
	 */
	computeSignature(rawBody: string): Promise<string | undefined>;
	/** Bring the receiver + tunnel up and (re)register the repo webhooks. */
	start(): Promise<void>;
}

/** One cursor-delimited page of catch-up events for a repo. */
export interface IBackfillPage {
	readonly events: readonly IIngressEvent[];
	/** The advanced cursor to persist, or `undefined` to leave it unchanged. */
	readonly cursor?: string;
}

/** Cursor-based GitHub catch-up, used only on downtime recovery (A.3). */
export interface IBackfillFetcher {
	fetchSince(repo: string, cursor: string | undefined): Promise<IBackfillPage>;
}

/** The store/ingress/settings surface the webhook ingress needs. */
export interface IWebhookIngressHost {
	/** Submit a normalized event (dedupes on delivery id). */
	submit(event: IIngressEvent): Promise<boolean>;
	/** Record a dropped delivery in the ledger (the only place a drop is logged). */
	recordDrop(entry: IDropLedgerEntry): Promise<void>;
	getCursor(repo: string): string | undefined;
	setCursor(repo: string, cursor: string): Promise<void>;
	/** The currently enrolled+active repos to backfill. */
	enrolledRepos(): readonly string[];
}

export class WebhookIngress extends Disposable {

	private readonly controller: BackfillController;

	constructor(
		private readonly adapter: IReceiverAdapter,
		private readonly fetcher: IBackfillFetcher,
		private readonly host: IWebhookIngressHost,
		private readonly logService: ILogService,
	) {
		super();
		this.controller = new BackfillController(() => this.backfill(), this.logService);
		this._register(this.adapter);
		this._register(this.adapter.onDelivery(d => {
			this.onDelivery(d).catch(err => this.logService.error('[inboxOne] webhook delivery failed', err));
		}));
		this._register(this.adapter.onConnectivityChange(up => this.controller.setConnected(up)));
	}

	/** Bring the receiver up. While up, ingest is webhooks-only. */
	async start(): Promise<void> {
		await this.adapter.start();
	}

	/** Backfill passes completed since construction (diagnostics/tests). */
	get backfillRuns(): number { return this.controller.backfillRuns; }

	private async onDelivery(delivery: IWebhookDelivery): Promise<void> {
		const deliveryId = delivery.headers.delivery || 'unknown';

		// Signature is closed-by-default: when a secret is configured, a missing or
		// mismatched signature is quarantined, never ingested (poison-event guard).
		const computed = await this.adapter.computeSignature(delivery.rawBody);
		if (computed !== undefined && !verifyWebhookSignature(computed, delivery.headers.signature256)) {
			await this.host.recordDrop({ deliveryId, reason: 'invalid_signature', droppedAt: Date.now() });
			this.logService.warn(`[inboxOne] webhook ${deliveryId} rejected: invalid signature`);
			return;
		}

		const event = normalizeWebhook(delivery.headers, delivery.payload, Date.now());
		if (!event) {
			await this.host.recordDrop({ deliveryId, reason: 'unnormalizable', droppedAt: Date.now() });
			return;
		}
		await this.host.submit(event);
	}

	private async backfill(): Promise<void> {
		for (const repo of this.host.enrolledRepos()) {
			const page = await this.fetcher.fetchSince(repo, this.host.getCursor(repo));
			for (const event of page.events) {
				// Duplicates of deliveries the webhook already ingested are dropped by
				// the ingress dedupe (I2), so backfill is safe to overlap webhooks.
				await this.host.submit(event);
			}
			if (page.cursor) {
				await this.host.setCursor(repo, page.cursor);
			}
		}
	}
}
