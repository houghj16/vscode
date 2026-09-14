/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * Backfill recovery controller (technical spec 3, workstream A.3).
 *
 * Enforces the transport policy the user mandated: **while the webhook receiver
 * is up, ingest is webhooks-only -- never periodic polling.** A one-time,
 * cursor-based backfill runs only to catch up events missed while the receiver
 * was down: exactly once on each `down -> up` transition (the first connect after
 * startup is the startup recovery). Concurrent connectivity flaps are coalesced
 * so a recovery never stacks more than one trailing catch-up.
 *
 * This class owns only the *when* (timing + coalescing) and is pure/testable; the
 * actual per-repo fetch + normalize + submit is the injected {@link runBackfill}.
 */
export class BackfillController {

	private connected = false;
	private running = false;
	/** A connectivity recovery arrived while a backfill was running; run one more. */
	private pendingRecovery = false;
	private _backfillRuns = 0;

	constructor(
		private readonly runBackfill: () => Promise<void>,
		private readonly logService: ILogService,
	) { }

	/** Number of completed backfill passes (for tests + diagnostics). */
	get backfillRuns(): number { return this._backfillRuns; }
	get isConnected(): boolean { return this.connected; }

	/**
	 * Report the webhook receiver/tunnel connectivity. A `false -> true`
	 * transition (including the very first connect after startup) triggers a
	 * single catch-up backfill; while connected, nothing here polls.
	 */
	setConnected(connected: boolean): void {
		if (connected === this.connected) {
			return;
		}
		this.connected = connected;
		if (connected) {
			this.logService.trace('[inboxOne] backfill: receiver up -> one-time catch-up');
			void this.recover();
		} else {
			this.logService.trace('[inboxOne] backfill: receiver down -> awaiting recovery');
		}
	}

	private async recover(): Promise<void> {
		if (this.running) {
			// Coalesce: a single trailing pass covers any flap during this run.
			this.pendingRecovery = true;
			return;
		}
		this.running = true;
		try {
			do {
				this.pendingRecovery = false;
				try {
					await this.runBackfill();
					this._backfillRuns++;
				} catch (err) {
					this.logService.error('[inboxOne] backfill pass failed', err);
				}
			} while (this.pendingRecovery);
		} finally {
			this.running = false;
		}
	}
}
