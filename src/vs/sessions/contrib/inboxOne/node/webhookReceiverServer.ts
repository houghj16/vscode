/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AddressInfo } from 'net';
import type * as http from 'http';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * Local GitHub webhook receiver (technical spec 3, workstream A.2). The physical,
 * node-side half of the webhook transport: a loopback HTTP server that GitHub
 * (via a dev tunnel) POSTs deliveries to. It parses each delivery into the
 * transport-neutral {@link IWebhookRequest} and hands it to the caller, which
 * runs the already-tested webhook orchestration (HMAC verify -> normalize ->
 * ingress). Keeping the server this thin means the security- and
 * correctness-critical logic stays in the pure, unit-tested common layer.
 *
 * Modeled on the OTLP loopback receiver (`localOtlpReceiver.ts`): binds
 * `127.0.0.1` at an OS-assigned ephemeral port, caps the body, and never lets a
 * handler error escape into the HTTP response.
 */

/** Default request body cap. GitHub webhook payloads are well under 25 MB. */
const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

/** A single delivered webhook, parsed from the HTTP request. */
export interface IWebhookRequest {
	/** `X-GitHub-Event`, e.g. `pull_request`. */
	readonly event: string;
	/** `X-GitHub-Delivery` GUID; the dedupe key. */
	readonly delivery: string;
	/** `X-Hub-Signature-256` (`sha256=<hex>`), present when a secret is configured. */
	readonly signature256?: string;
	/** The exact request bytes the signature was computed over. */
	readonly rawBody: string;
}

export interface IWebhookReceiverHandlers {
	/**
	 * Invoked for each accepted `POST` to the webhook path. Must not throw; any
	 * error is logged and isolated from the HTTP response (GitHub only needs a
	 * 2xx to consider the delivery successful).
	 */
	onWebhook(request: IWebhookRequest): void;
}

export interface IWebhookReceiverOptions {
	/** Path GitHub posts to. Defaults to `/inbox-one/webhook`. */
	readonly path?: string;
	/** Preferred port; `0` (default) lets the OS choose an ephemeral port. */
	readonly port?: number;
	/** Body size cap; larger requests get HTTP 413. */
	readonly maxBodyBytes?: number;
}

export interface ILocalWebhookReceiver extends IDisposable {
	/** Loopback base URL (no path), e.g. `http://127.0.0.1:53421`. */
	readonly baseUrl: string;
	/** The bound port. */
	readonly port: number;
	/** The webhook path deliveries must target. */
	readonly path: string;
}

/**
 * Starts the loopback webhook receiver. Accepts `POST {path}` and forwards each
 * parsed delivery to {@link IWebhookReceiverHandlers.onWebhook}. Responds `204`
 * on accept, `404`/`405` for the wrong path/method, `413` when oversized.
 */
export async function startLocalWebhookReceiver(
	handlers: IWebhookReceiverHandlers,
	logService: ILogService,
	options: IWebhookReceiverOptions = {},
): Promise<ILocalWebhookReceiver> {
	const path = options.path ?? '/inbox-one/webhook';
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const httpModule = await import('http');
	const server = httpModule.createServer();

	server.on('request', (req, res) => {
		handleRequest(req, res, path, handlers, logService, maxBodyBytes).catch(err => {
			logService.error(`[inboxOne] webhook receiver: unhandled error: ${err instanceof Error ? err.message : String(err)}`);
			if (!res.headersSent) {
				writePlain(res, 500, 'internal error');
			} else if (!res.writableEnded) {
				try { res.end(); } catch { /* ignore */ }
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => reject(err);
		server.once('error', onError);
		server.listen(options.port ?? 0, '127.0.0.1', () => {
			server.removeListener('error', onError);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error(`webhook receiver failed to bind: unexpected address ${String(address)}`);
	}
	const port = (address as AddressInfo).port;
	const baseUrl = `http://127.0.0.1:${port}`;
	logService.info(`[inboxOne] webhook receiver listening on ${baseUrl}${path}`);

	const disposable = toDisposable(() => {
		server.closeAllConnections();
		server.close(err => {
			if (err) {
				logService.warn(`[inboxOne] webhook receiver close error: ${err.message}`);
			}
		});
	});

	return Object.assign(disposable, { baseUrl, port, path });
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	path: string,
	handlers: IWebhookReceiverHandlers,
	logService: ILogService,
	maxBodyBytes: number,
): Promise<void> {
	const url = req.url ?? '';
	const pathname = url.split('?', 1)[0];
	// A GET to any path is a cheap liveness probe (used to confirm the tunnel).
	if (req.method === 'GET') {
		writePlain(res, 200, 'inbox-one webhook receiver');
		return;
	}
	if (pathname !== path) {
		writePlain(res, 404, 'not found');
		return;
	}
	if (req.method !== 'POST') {
		res.setHeader('allow', 'POST');
		writePlain(res, 405, 'method not allowed');
		return;
	}

	let body: Buffer;
	try {
		body = await readBody(req, maxBodyBytes);
	} catch (err) {
		if (err instanceof PayloadTooLargeError) {
			writePlain(res, 413, 'payload too large');
		} else {
			writePlain(res, 400, 'failed to read body');
		}
		return;
	}

	const request: IWebhookRequest = {
		event: header(req, 'x-github-event'),
		delivery: header(req, 'x-github-delivery'),
		signature256: header(req, 'x-hub-signature-256') || undefined,
		rawBody: body.toString('utf8'),
	};

	// Handler failures must never fail the delivery: GitHub would retry a 5xx and
	// the ingress already dedupes on the delivery id, but a clean 204 is correct.
	try {
		handlers.onWebhook(request);
	} catch (err) {
		logService.warn(`[inboxOne] webhook onWebhook handler threw: ${err instanceof Error ? err.message : String(err)}`);
	}

	res.statusCode = 204;
	res.end();
}

function header(req: http.IncomingMessage, name: string): string {
	const value = req.headers[name];
	if (Array.isArray(value)) {
		return value[0] ?? '';
	}
	return value ?? '';
}

class PayloadTooLargeError extends Error { }

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let received = 0;
		const onData = (chunk: Buffer) => {
			received += chunk.length;
			if (received > maxBytes) {
				cleanup();
				reject(new PayloadTooLargeError(`body exceeds ${maxBytes} bytes`));
				return;
			}
			chunks.push(chunk);
		};
		const onEnd = () => {
			cleanup();
			resolve(Buffer.concat(chunks));
		};
		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};
		const cleanup = () => {
			req.removeListener('data', onData);
			req.removeListener('end', onEnd);
			req.removeListener('error', onError);
		};
		req.on('data', onData);
		req.on('end', onEnd);
		req.on('error', onError);
	});
}

function writePlain(res: http.ServerResponse, status: number, message: string): void {
	res.statusCode = status;
	res.setHeader('content-type', 'text/plain; charset=utf-8');
	res.end(message);
}
