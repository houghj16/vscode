/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

/**
 * Inbox One companion webhook receiver (dev).
 *
 * The sessions renderer is sandboxed and cannot bind a socket, so this small node
 * companion is the physical GitHub webhook receiver. It:
 *   1. binds a loopback HTTP receiver at 127.0.0.1 (path /inbox-one/webhook),
 *   2. runs `gh webhook forward` per enrolled repo so GitHub deliveries are relayed
 *      to that receiver (no public tunnel required -- GitHub's own relay), and
 *   3. writes each delivery atomically as one JSON file into the drop directory the
 *      in-product FileDropReceiverAdapter watches.
 *
 * Config is read from `<dropDir>/../config.json` (written by the app from the live
 * enrollment list, so nothing is hardcoded) and re-read when it changes. Args may
 * override for standalone use.
 *
 * Usage:
 *   node scripts/inbox-one-webhook.mjs --user-data-dir <dir> [--repos a/b,c/d] [--events '*'] [--port 0]
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

function parseArgs(argv) {
	/** @type {Record<string,string>} */
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const key = a.slice(2);
			const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
			out[key] = val;
		}
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const userDataDir = args['user-data-dir'];
const explicitDropDir = args['drop-dir'];
if (!userDataDir && !explicitDropDir) {
	console.error('[inbox-one-webhook] --user-data-dir (or --drop-dir) is required');
	process.exit(1);
}
const dropDir = explicitDropDir || path.join(userDataDir, 'User', 'inboxOneWebhook', 'incoming');
const configPath = path.join(path.dirname(dropDir), 'config.json');
const events = args.events || '*';
const port = Number(args.port || 0);

fs.mkdirSync(dropDir, { recursive: true });

/** Atomically drop one delivery as a JSON file the app's FileDropReceiverAdapter consumes. */
function writeDelivery(delivery) {
	const id = delivery.headers.delivery || randomUUID();
	const finalPath = path.join(dropDir, `${id}.json`);
	const tmpPath = path.join(dropDir, `.${id}.${process.pid}.tmp`);
	fs.writeFileSync(tmpPath, JSON.stringify(delivery), 'utf8');
	fs.renameSync(tmpPath, finalPath);
	console.log(`[inbox-one-webhook] delivered ${delivery.headers.event} (${id})`);
}

const server = http.createServer((req, res) => {
	if (req.method === 'GET') {
		res.statusCode = 200;
		res.end('inbox-one webhook companion');
		return;
	}
	if (req.method !== 'POST') {
		res.statusCode = 405;
		res.end();
		return;
	}
	const chunks = [];
	req.on('data', c => chunks.push(c));
	req.on('end', () => {
		const rawBody = Buffer.concat(chunks).toString('utf8');
		let payload;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			payload = undefined;
		}
		const headers = {
			event: String(req.headers['x-github-event'] || ''),
			delivery: String(req.headers['x-github-delivery'] || ''),
			signature256: req.headers['x-hub-signature-256'] ? String(req.headers['x-hub-signature-256']) : undefined,
		};
		if (headers.event && payload !== undefined) {
			try {
				writeDelivery({ headers, rawBody, payload });
			} catch (err) {
				console.error(`[inbox-one-webhook] drop write failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		res.statusCode = 204;
		res.end();
	});
});

/** @type {Map<string, import('child_process').ChildProcess>} */
const forwarders = new Map();

function reconcileForwarders(config) {
	const repos = config.repos;
	const activeEvents = config.events || events;
	const wanted = new Set(repos);
	for (const [repo, child] of forwarders) {
		if (!wanted.has(repo)) {
			child.kill();
			forwarders.delete(repo);
		}
	}
	const url = `http://127.0.0.1:${server.address().port}/inbox-one/webhook`;
	for (const repo of wanted) {
		if (forwarders.has(repo)) {
			continue;
		}
		console.log(`[inbox-one-webhook] forwarding ${repo} (events=${activeEvents}) -> ${url}`);
		const child = spawn('gh', ['webhook', 'forward', `--repo=${repo}`, `--events=${activeEvents}`, `--url=${url}`], {
			stdio: ['ignore', 'inherit', 'inherit'],
			env: process.env,
		});
		child.on('exit', code => {
			console.log(`[inbox-one-webhook] forwarder for ${repo} exited (${code})`);
			forwarders.delete(repo);
		});
		forwarders.set(repo, child);
	}
}

function readConfig() {
	const cfg = { repos: [], events };
	if (args.repos) {
		cfg.repos = args.repos.split(',').map(r => r.trim()).filter(Boolean);
		return cfg;
	}
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
		if (Array.isArray(parsed.repos)) {
			cfg.repos = parsed.repos;
		}
		if (Array.isArray(parsed.events) && parsed.events.length) {
			cfg.events = parsed.events.join(',');
		}
	} catch {
		/* config not written yet */
	}
	return cfg;
}

server.listen(port, '127.0.0.1', () => {
	console.log(`[inbox-one-webhook] receiver on http://127.0.0.1:${server.address().port}/inbox-one/webhook`);
	console.log(`[inbox-one-webhook] drop dir: ${dropDir}`);
	reconcileForwarders(readConfig());
	// React to enrollment changes the app writes into config.json (no polling of GitHub).
	if (!args.repos) {
		try {
			fs.watch(path.dirname(configPath), (_e, file) => {
				if (file === 'config.json') {
					reconcileForwarders(readConfig());
				}
			});
		} catch { /* ignore */ }
	}
});

function shutdown() {
	for (const child of forwarders.values()) {
		child.kill();
	}
	server.close();
	process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
