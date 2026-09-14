/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventSource, IEventSubject, IIngressEvent } from './inboxOneTypes.js';

/**
 * GitHub webhook normalization + signature verification (technical spec 3, A.2).
 *
 * The webhook receiver is the steady-state transport: while it is up, ingest is
 * webhooks-only. This module is the pure, transport-free core of that receiver --
 * it turns a delivered webhook (event name + delivery id + JSON payload) into the
 * single normalized {@link IIngressEvent} shape, and verifies the HMAC-SHA256
 * signature. Keeping it pure lets the security-critical comparison and the
 * outcome normalization be unit-tested without a live tunnel or GitHub app.
 */

/** The webhook headers the receiver forwards, lower-cased. */
export interface IWebhookHeaders {
	/** `X-GitHub-Event`: the event name, e.g. `pull_request`. */
	readonly event: string;
	/** `X-GitHub-Delivery`: the delivery GUID, used as the dedupe key. */
	readonly delivery: string;
	/** `X-Hub-Signature-256`: `sha256=<hex>`, present when a secret is configured. */
	readonly signature256?: string;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
	return value && typeof value === 'object' ? value as Json : undefined;
}

function str(value: unknown): string | undefined {
	if (typeof value === 'string') { return value; }
	if (typeof value === 'number') { return String(value); }
	return undefined;
}

/** Extracts `{owner}/{repo}` from a webhook payload. */
function repoOf(payload: Json): string | undefined {
	const repo = asRecord(payload.repository);
	return repo ? str(repo.full_name) : undefined;
}

/**
 * GitHub sends check/workflow completion as `action: 'completed'` with the real
 * outcome in a `conclusion` field, and commit status as a top-level `state`. The
 * taxonomy classifier is a pure function of `(type, action)`, so we fold the
 * outcome into `action` here (e.g. a failed check arrives downstream as
 * `check_run` / `failure`). Non-completion actions pass through unchanged.
 */
function normalizeAction(type: string, payload: Json): string | undefined {
	switch (type) {
		case 'status':
			return str(payload.state);
		case 'check_run':
		case 'check_suite':
		case 'workflow_run': {
			const action = str(payload.action);
			if (action !== 'completed') {
				return action;
			}
			const node = asRecord(payload[type]);
			return node ? (str(node.conclusion) ?? 'completed') : 'completed';
		}
		default:
			return str(payload.action);
	}
}

/** Derives the group_key subject from the payload for a given event type. */
function subjectOf(type: string, payload: Json): IEventSubject | undefined {
	switch (type) {
		case 'pull_request':
		case 'pull_request_target': {
			const pr = asRecord(payload.pull_request);
			const id = pr && str(pr.number);
			return id ? { kind: 'pr', id } : undefined;
		}
		case 'issues': {
			const issue = asRecord(payload.issue);
			const id = issue && str(issue.number);
			return id ? { kind: 'issue', id } : undefined;
		}
		case 'check_run':
		case 'check_suite':
		case 'workflow_run': {
			const node = asRecord(payload[type]);
			if (!node) { return undefined; }
			const id = str(node.id) ?? str(node.head_sha);
			if (!id) { return undefined; }
			const attachedTo = checkAttachment(node);
			return { kind: 'check', id, attachedTo };
		}
		case 'status': {
			const sha = str(payload.sha);
			const branches = payload.branches;
			let branch: string | undefined;
			if (Array.isArray(branches) && branches.length) {
				branch = str(asRecord(branches[0])?.name);
			}
			if (!sha) { return undefined; }
			return { kind: 'check', id: sha, attachedTo: branch ? { kind: 'branch', id: branch } : undefined };
		}
		case 'code_scanning_alert':
		case 'secret_scanning_alert':
		case 'dependabot_alert':
		case 'repository_vulnerability_alert': {
			const alert = asRecord(payload.alert);
			const id = alert && (str(alert.number) ?? str(alert.ghsa_id));
			return id ? { kind: 'security', id } : undefined;
		}
		default:
			return undefined;
	}
}

/** Resolves the PR (preferred) or branch a check/workflow attaches to. */
function checkAttachment(node: Json): IEventSubject['attachedTo'] {
	const prs = node.pull_requests;
	if (Array.isArray(prs) && prs.length) {
		const num = str(asRecord(prs[0])?.number);
		if (num) { return { kind: 'pr', id: num }; }
	}
	const suite = asRecord(node.check_suite);
	const branch = str(node.head_branch) ?? (suite && str(suite.head_branch));
	return branch ? { kind: 'branch', id: branch } : undefined;
}

/**
 * Normalizes a delivered webhook into an {@link IIngressEvent}, or `undefined`
 * when the payload lacks the fields needed to derive a stable subject (such an
 * event cannot form a group_key and is not dispatchable). The returned event is
 * still subject to the dispatch gate; normalization never decides admission.
 */
export function normalizeWebhook(headers: IWebhookHeaders, payload: unknown, receivedAt: number): IIngressEvent | undefined {
	const body = asRecord(payload);
	if (!body || !headers.event || !headers.delivery) {
		return undefined;
	}
	const subject = subjectOf(headers.event, body);
	if (!subject) {
		return undefined;
	}
	return {
		deliveryId: headers.delivery,
		source: EventSource.World,
		repo: repoOf(body),
		type: headers.event,
		action: normalizeAction(headers.event, body),
		subject,
		payload: body,
		receivedAt,
	};
}

// --- signature verification (pure) ---

/** Parses `sha256=<hex>` from an `X-Hub-Signature-256` header; `undefined` if malformed. */
export function parseSignatureHeader(header: string | undefined): string | undefined {
	if (!header) { return undefined; }
	const prefix = 'sha256=';
	if (!header.startsWith(prefix)) { return undefined; }
	const hex = header.slice(prefix.length).trim().toLowerCase();
	return /^[0-9a-f]+$/.test(hex) && hex.length > 0 ? hex : undefined;
}

/**
 * Constant-time hex comparison. Length-independent early-out is avoided so the
 * comparison time does not leak how many leading characters matched (G-security).
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * Verifies a webhook signature against a locally-computed digest. The HMAC digest
 * itself is computed by a platform adapter (Node `crypto` / WebCrypto) and passed
 * in as `computedHex`; this function owns the header parsing and the
 * constant-time compare -- the parts that must be correct for security.
 */
export function verifyWebhookSignature(computedHex: string, signatureHeader: string | undefined): boolean {
	const provided = parseSignatureHeader(signatureHeader);
	if (!provided) { return false; }
	return timingSafeEqualHex(computedHex.toLowerCase(), provided);
}
