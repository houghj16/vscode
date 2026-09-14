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
import { spawn, execFile } from 'child_process';
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

// Singleton guard: two companions on the same drop dir would fight over the
// `gh webhook forward` hooks. Claim a lock; exit if a live companion holds it.
const lockPath = path.join(path.dirname(dropDir), 'companion.lock');
try {
	const existing = Number(fs.readFileSync(lockPath, 'utf8'));
	if (existing && existing !== process.pid) {
		let alive = false;
		try { process.kill(existing, 0); alive = true; } catch { alive = false; }
		if (alive) {
			console.log(`[inbox-one-webhook] another companion (pid ${existing}) is running; exiting`);
			process.exit(0);
		}
	}
} catch { /* no lock yet */ }
fs.writeFileSync(lockPath, String(process.pid));
function releaseLock() {
	try {
		if (Number(fs.readFileSync(lockPath, 'utf8')) === process.pid) {
			fs.unlinkSync(lockPath);
		}
	} catch { /* already gone */ }
}


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

/** The event set gh subscribes to ('*'); the coordinator filters by trigger family. */
const GH_EVENTS = '*';

/** Runs `gh api ...`, resolving parsed JSON (or undefined on failure). */
function ghApi(apiArgs) {
	return new Promise(resolve => {
		execFile('gh', ['api', ...apiArgs], { env: process.env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
			if (err) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(stdout));
			} catch {
				resolve(undefined);
			}
		});
	});
}

/**
 * `gh webhook forward` leaves a dev webhook (name `cli`, url on
 * `webhook-forwarder.github.com`) if a prior run exited uncleanly, which makes the
 * next `forward` fail with "Hook already exists". Delete only those so startup
 * self-heals. Never touches the user's own webhooks.
 */
async function cleanupStaleForwardHooks(repo) {
	const hooks = await ghApi([`repos/${repo}/hooks`, '--paginate']);
	if (!Array.isArray(hooks)) {
		return;
	}
	for (const h of hooks) {
		const url = h && h.config && h.config.url;
		if (h && h.name === 'cli' && typeof url === 'string' && url.startsWith('https://webhook-forwarder.github.com')) {
			await ghApi(['-X', 'DELETE', `repos/${repo}/hooks/${h.id}`]);
			console.log(`[inbox-one-webhook] cleaned stale dev webhook ${h.id} on ${repo}`);
		}
	}
}

/** Cleans stale hooks then starts one `gh webhook forward` for the repo. */
async function startForwarder(repo, url, activeEvents) {
	await cleanupStaleForwardHooks(repo);
	if (!forwarders.has(repo)) {
		return; // repo was removed from the config while we cleaned up
	}
	console.log(`[inbox-one-webhook] forwarding ${repo} (events=${GH_EVENTS}, coordinator filters to ${activeEvents}) -> ${url}`);
	const child = spawn('gh', ['webhook', 'forward', `--repo=${repo}`, `--events=${GH_EVENTS}`, `--url=${url}`], {
		stdio: ['ignore', 'inherit', 'inherit'],
		env: process.env,
	});
	child.on('exit', code => {
		console.log(`[inbox-one-webhook] forwarder for ${repo} exited (${code})`);
		forwarders.delete(repo);
	});
	forwarders.set(repo, child);
}

function reconcileForwarders(config) {
	const repos = config.repos;
	const activeEvents = config.events || events;
	const wanted = new Set(repos);
	for (const [repo, child] of forwarders) {
		if (!wanted.has(repo)) {
			if (child) {
				child.kill();
			}
			forwarders.delete(repo);
		}
	}
	const url = `http://127.0.0.1:${server.address().port}/inbox-one/webhook`;
	for (const repo of wanted) {
		if (forwarders.has(repo)) {
			continue;
		}
		// Reserve the slot so a concurrent reconcile does not double-start while the
		// async stale-hook cleanup runs.
		forwarders.set(repo, null);
		void startForwarder(repo, url, activeEvents);
	}
}

function readConfig() {
	if (args.repos) {
		return { repos: args.repos.split(',').map(r => r.trim()).filter(Boolean), events };
	}
	// Returns null when the config cannot be read (missing yet, or a partial write
	// observed mid-rename): callers keep the current forwarders rather than tearing
	// them down on a transient read.
	let raw;
	try {
		raw = fs.readFileSync(configPath, 'utf8');
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.repos)) {
			return null;
		}
		const cfg = { repos: parsed.repos, events };
		if (Array.isArray(parsed.events) && parsed.events.length) {
			cfg.events = parsed.events.join(',');
		}
		return cfg;
	} catch {
		return null;
	}
}

server.listen(port, '127.0.0.1', () => {
	console.log(`[inbox-one-webhook] receiver on http://127.0.0.1:${server.address().port}/inbox-one/webhook`);
	console.log(`[inbox-one-webhook] drop dir: ${dropDir}`);
	const initial = readConfig();
	if (initial) {
		reconcileForwarders(initial);
	}
	// React to enrollment changes the app writes into config.json (no polling of GitHub).
	if (!args.repos) {
		try {
			fs.watch(path.dirname(configPath), (_e, file) => {
				if (file === 'config.json' || (file && file.startsWith('config.json'))) {
					const cfg = readConfig();
					if (cfg) {
						reconcileForwarders(cfg);
					}
				}
			});
		} catch { /* ignore */ }
	}
});

function shutdown() {
	for (const child of forwarders.values()) {
		if (child) {
			child.kill();
		}
	}
	releaseLock();
	server.close();
	process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', releaseLock);
