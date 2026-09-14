/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GitHub repository webhook registration (technical spec 3, A.2). Idempotently
 * ensures the enrolled repo has a webhook pointing at the current dev-tunnel URL
 * with our secret and the trigger-family event list. Re-registers (PATCH) when
 * the tunnel URL rotates; creates when absent; no-ops when already correct.
 *
 * Transport-neutral: it takes an injectable {@link RegistrarRequest} so it reuses
 * the workbench GitHubApiClient (auth + REST) in production and a fake in tests.
 * All request shaping and the idempotency decision live here, purely testable.
 */

/** The webhook path our receiver serves; used to recognize "our" hook on the repo. */
export const INBOX_ONE_WEBHOOK_PATH = '/inbox-one/webhook';

export interface IRegistrarResponse<T> {
	readonly data: T | undefined;
	readonly statusCode: number;
}

/** A minimal GitHub REST request function (method, path, optional JSON body). */
export type RegistrarRequest = <T>(method: string, path: string, body?: unknown) => Promise<IRegistrarResponse<T>>;

/** The subset of a GitHub repo webhook we care about. */
interface IRepoHook {
	readonly id: number;
	readonly active?: boolean;
	readonly events?: readonly string[];
	readonly config?: { readonly url?: string; readonly content_type?: string };
}

export interface IEnsureWebhookRequest {
	/** `{owner}/{repo}`. */
	readonly repo: string;
	/** The public tunnel URL of the receiver (including {@link INBOX_ONE_WEBHOOK_PATH}). */
	readonly webhookUrl: string;
	/** The shared secret used for HMAC-SHA256 signing. */
	readonly secret: string;
	/** The GitHub event names to subscribe to (trigger families). */
	readonly events: readonly string[];
}

export const enum WebhookRegistrationOutcome {
	Created = 'created',
	Updated = 'updated',
	Unchanged = 'unchanged',
	Failed = 'failed',
}

export interface IWebhookRegistrationResult {
	readonly outcome: WebhookRegistrationOutcome;
	/** The GitHub hook id, when known. */
	readonly hookId?: number;
	readonly reason?: string;
}

function splitRepo(repo: string): { owner: string; name: string } | undefined {
	const slash = repo.indexOf('/');
	if (slash <= 0 || slash === repo.length - 1) {
		return undefined;
	}
	return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

/** True when `hook` is the inbox-one webhook (recognized by its path suffix). */
function isOurs(hook: IRepoHook): boolean {
	const url = hook.config?.url ?? '';
	try {
		return new URL(url).pathname.endsWith(INBOX_ONE_WEBHOOK_PATH);
	} catch {
		return url.endsWith(INBOX_ONE_WEBHOOK_PATH);
	}
}

function eventsSuperset(have: readonly string[] | undefined, want: readonly string[]): boolean {
	const set = new Set(have ?? []);
	return want.every(e => set.has(e));
}

function hookConfig(req: IEnsureWebhookRequest) {
	return { url: req.webhookUrl, content_type: 'json', secret: req.secret, insecure_ssl: '0' };
}

/**
 * Ensures exactly one inbox-one webhook exists on the repo, pointing at
 * `webhookUrl` with our secret + events. Idempotent: safe to call on every
 * startup and on every tunnel-URL change.
 */
export async function ensureRepoWebhook(request: RegistrarRequest, req: IEnsureWebhookRequest): Promise<IWebhookRegistrationResult> {
	const parts = splitRepo(req.repo);
	if (!parts) {
		return { outcome: WebhookRegistrationOutcome.Failed, reason: `invalid repo '${req.repo}'` };
	}
	const base = `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/hooks`;

	let existing: IRepoHook | undefined;
	try {
		const list = await request<readonly IRepoHook[]>('GET', `${base}?per_page=100`);
		if (list.statusCode >= 400) {
			return { outcome: WebhookRegistrationOutcome.Failed, reason: `list hooks failed (${list.statusCode})` };
		}
		existing = (list.data ?? []).find(isOurs);
	} catch (err) {
		return { outcome: WebhookRegistrationOutcome.Failed, reason: err instanceof Error ? err.message : String(err) };
	}

	// Already correct: same URL, active, and events already covered.
	if (existing
		&& existing.config?.url === req.webhookUrl
		&& existing.active !== false
		&& eventsSuperset(existing.events, req.events)) {
		return { outcome: WebhookRegistrationOutcome.Unchanged, hookId: existing.id };
	}

	const payload = { name: 'web', active: true, events: req.events, config: hookConfig(req) };

	try {
		if (existing) {
			const patch = await request<IRepoHook>('PATCH', `${base}/${existing.id}`, payload);
			if (patch.statusCode >= 400) {
				return { outcome: WebhookRegistrationOutcome.Failed, hookId: existing.id, reason: `update failed (${patch.statusCode})` };
			}
			return { outcome: WebhookRegistrationOutcome.Updated, hookId: existing.id };
		}
		const created = await request<IRepoHook>('POST', base, payload);
		if (created.statusCode >= 400) {
			return { outcome: WebhookRegistrationOutcome.Failed, reason: `create failed (${created.statusCode})` };
		}
		return { outcome: WebhookRegistrationOutcome.Created, hookId: created.data?.id };
	} catch (err) {
		return { outcome: WebhookRegistrationOutcome.Failed, reason: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * The distinct GitHub event names the coordinator subscribes to, derived from the
 * trigger families (design 11). Kept here so registration and the taxonomy agree.
 */
export const INBOX_ONE_WEBHOOK_EVENTS: readonly string[] = [
	'issues', 'issue_comment',
	'pull_request', 'pull_request_review', 'pull_request_review_comment',
	'check_run', 'check_suite', 'workflow_run', 'status',
	'code_scanning_alert', 'secret_scanning_alert', 'dependabot_alert', 'repository_vulnerability_alert',
	'deployment', 'deployment_status',
];
