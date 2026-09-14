/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWebhookHeaders } from '../common/githubWebhook.js';
import { IReceiverAdapter, IWebhookDelivery } from '../common/webhookIngress.js';

/** The delivery file the companion receiver writes (one webhook per file). */
interface IDroppedDelivery {
	readonly headers: IWebhookHeaders;
	readonly rawBody: string;
	readonly payload: unknown;
}

/**
 * A {@link IReceiverAdapter} whose transport is a local drop directory watched via
 * {@link IFileService} (technical spec 3, workstream A.2). The sessions renderer
 * is sandboxed and cannot bind a socket, so the physical GitHub webhook receiver
 * runs in a companion node process (see `node/webhookReceiverServer.ts`); that
 * process HMAC-verifies each delivery and drops it here as one JSON file. This
 * adapter drains the directory -- via an OS file watch (instant) plus a short
 * local-directory poll as a robust fallback (OS watches on tmp/arbitrary paths
 * are not always reliable) -- and re-emits each delivery to the already-tested
 * {@link WebhookIngress} orchestration, so ingest is uniform whatever the physical
 * transport. The poll is a local-filesystem detail; it is NOT GitHub polling (the
 * spec forbids only periodic polling of GitHub).
 *
 * Signature verification already happened in the companion process (it holds the
 * shared secret), and the drop directory lives under the user's own data home --
 * a trust boundary equivalent to the app's own storage -- so this adapter reports
 * no local HMAC (`computeSignature` -> undefined) and the ingress does not
 * re-verify. Delivery files are written atomically (temp name then rename to
 * `.json`) by the companion, so a partially written file is never observed here.
 *
 * Startup is treated as a downtime recovery: connectivity fires `true` once on
 * {@link start}, driving exactly one catch-up backfill; it never fires again, so
 * there is no steady-state polling. Inert when no local disk provider is present
 * (e.g. the web harness): the watch simply yields no files.
 */
export class FileDropReceiverAdapter extends Disposable implements IReceiverAdapter {

	static dropDirectoryFor(userDataHome: URI): URI {
		return joinPath(userDataHome, 'inboxOneWebhook', 'incoming');
	}

	private readonly _onConnectivityChange = this._register(new Emitter<boolean>());
	readonly onConnectivityChange = this._onConnectivityChange.event;

	private readonly _onDelivery = this._register(new Emitter<IWebhookDelivery>());
	readonly onDelivery = this._onDelivery.event;

	private readonly processing = new Set<string>();

	constructor(
		private readonly dropDir: URI,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) {
		super();
	}

	async computeSignature(_rawBody: string): Promise<string | undefined> {
		// Verified upstream in the companion receiver; local drop dir is trusted.
		return undefined;
	}

	async start(): Promise<void> {
		try {
			await this.fileService.createFolder(this.dropDir);
			// Two delivery paths, both feeding the idempotent drain: an OS file watch
			// (instant when it fires) and a short local-directory poll (a robust
			// fallback -- OS watches on arbitrary/tmp paths are not always reliable).
			// This poll is a local-filesystem detail, NOT GitHub polling.
			this._register(this.fileService.watch(this.dropDir));
			this._register(this.fileService.onDidFilesChange(e => {
				for (const added of e.rawAdded) {
					if (added.path.endsWith('.json')) {
						void this.drain(added);
					}
				}
			}));
			const poll = this._register(new IntervalTimer());
			poll.cancelAndSet(() => void this.drainExisting(), 1000);
			await this.drainExisting();
			this.logService.info(`[inboxOne] webhook drop receiver watching ${this.dropDir.fsPath}`);
		} catch (err) {
			// No local disk provider (web) or the dir is unavailable: degrade to a
			// safe no-op, but still fire the one-time recovery so backfill runs.
			this.logService.trace(`[inboxOne] webhook drop receiver inactive: ${err instanceof Error ? err.message : String(err)}`);
		}
		// One-time startup recovery -> exactly one catch-up backfill.
		this._onConnectivityChange.fire(true);
	}

	private async drainExisting(): Promise<void> {
		if (!(await this.fileService.exists(this.dropDir))) {
			return;
		}
		const stat = await this.fileService.resolve(this.dropDir);
		for (const child of stat.children ?? []) {
			if (!child.isDirectory && child.resource.path.endsWith('.json')) {
				await this.drain(child.resource);
			}
		}
	}

	private async drain(file: URI): Promise<void> {
		const key = file.toString();
		if (this.processing.has(key)) {
			return;
		}
		this.processing.add(key);
		try {
			if (!(await this.fileService.exists(file))) {
				return; // Already consumed by another drain path (watch/poll or window).
			}
			const content = await this.fileService.readFile(file);
			const parsed = JSON.parse(content.value.toString()) as IDroppedDelivery;
			if (parsed && parsed.headers && typeof parsed.rawBody === 'string') {
				this._onDelivery.fire({ headers: parsed.headers, rawBody: parsed.rawBody, payload: parsed.payload });
			}
			await this.fileService.del(file);
		} catch (err) {
			if (err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return; // Raced with another drain path; the delivery is already handled.
			}
			this.logService.warn(`[inboxOne] webhook drop parse/del failed for ${file.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.processing.delete(key);
		}
	}
}
