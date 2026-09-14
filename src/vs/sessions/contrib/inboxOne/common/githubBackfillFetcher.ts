/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventSource, IIngressEvent } from './inboxOneTypes.js';
import { IBackfillPage } from './webhookIngress.js';

/**
 * GitHub REST backfill fetcher (technical spec 3, workstream A.3). Used ONLY for
 * the one-time catch-up on a downtime recovery -- never for steady-state polling.
 * It reads repository state changed since the last cursor and normalizes each
 * change into a webhook-shaped {@link IIngressEvent}, so the coordinator handles
 * a backfilled change identically to a live webhook (and the ingress dedupes any
 * overlap by delivery id).
 *
 * Transport-neutral: it takes an injectable {@link BackfillRequest} so it reuses
 * the workbench GitHubApiClient (auth + REST) in production and a fake in tests.
 * The GitHub `/issues` list returns both issues and pull requests (a PR is an
 * issue with a `pull_request` field), so one page covers both families; checks
 * ride in on their PR/branch tasks via group_key and need no separate backfill.
 */

export interface IBackfillResponse<T> {
	readonly data: T | undefined;
	readonly statusCode: number;
}

export type BackfillRequest = <T>(method: string, path: string) => Promise<IBackfillResponse<T>>;

/** The subset of a GitHub issue/PR list item the backfill needs. */
interface IGitHubIssueListItem {
	readonly number: number;
	readonly updated_at?: string;
	readonly state?: string;
	/** Present only when the item is actually a pull request. */
	readonly pull_request?: { readonly url?: string };
}

/** ISO-8601 cursor of the newest `updated_at` seen; the next page resumes strictly after it. */
export type BackfillCursor = string;

function splitRepo(repo: string): { owner: string; name: string } | undefined {
	const slash = repo.indexOf('/');
	if (slash <= 0 || slash === repo.length - 1) {
		return undefined;
	}
	return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

/**
 * Fetches one catch-up page for a repo: every issue/PR updated since `cursor`,
 * normalized to ingress events. `cursor` is an ISO timestamp; on the first
 * recovery (no cursor) it fetches a bounded recent window. Returns the events and
 * the advanced cursor (the newest `updated_at`), or an empty page on error/empty.
 */
export async function fetchBackfillPage(request: BackfillRequest, repo: string, cursor: BackfillCursor | undefined): Promise<IBackfillPage> {
	const parts = splitRepo(repo);
	if (!parts) {
		return { events: [] };
	}
	// `since` bounds the window on recovery; `sort=updated&direction=asc` makes the
	// last item the newest so the cursor advances monotonically.
	const since = cursor ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const path = `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/issues`
		+ `?since=${encodeURIComponent(since)}&state=all&sort=updated&direction=asc&per_page=100`;

	let response: IBackfillResponse<readonly IGitHubIssueListItem[]>;
	try {
		response = await request<readonly IGitHubIssueListItem[]>('GET', path);
	} catch {
		return { events: [] };
	}
	if (response.statusCode >= 400 || !response.data) {
		return { events: [] };
	}

	const events: IIngressEvent[] = [];
	let newest = cursor;
	for (const item of response.data) {
		const updatedAt = item.updated_at;
		// The `since` filter is inclusive, so skip the item that equals the cursor
		// to avoid re-emitting the boundary on every recovery.
		if (cursor && updatedAt === cursor) {
			continue;
		}
		const event = normalizeIssueListItem(repo, item, updatedAt);
		if (event) {
			events.push(event);
		}
		if (updatedAt && (!newest || updatedAt > newest)) {
			newest = updatedAt;
		}
	}
	return { events, cursor: newest };
}

/** Maps a GitHub issue/PR list item to a webhook-shaped ingress event. */
function normalizeIssueListItem(repo: string, item: IGitHubIssueListItem, updatedAt: string | undefined): IIngressEvent | undefined {
	if (typeof item.number !== 'number') {
		return undefined;
	}
	const id = String(item.number);
	const stamp = updatedAt ?? String(Date.now());
	const isPr = !!item.pull_request;
	// A stable, backfill-scoped delivery id so re-runs dedupe and a live webhook for
	// the same change (different delivery id) is not blocked.
	const deliveryId = `backfill:${repo}:${isPr ? 'pr' : 'issue'}:${id}:${stamp}`;
	// Backfill catches up on OPEN work items missed during downtime: map open ->
	// `opened` (dispatchable) and closed -> `closed` (the gate drops it). Re-emitting
	// `opened` for an already-tracked item is safe: the ingress dedupes by delivery
	// id and the coordinator joins the existing task by group_key.
	const action = item.state === 'closed' ? 'closed' : 'opened';
	return {
		deliveryId,
		source: EventSource.World,
		repo,
		type: isPr ? 'pull_request' : 'issues',
		action,
		subject: isPr ? { kind: 'pr', id } : { kind: 'issue', id },
		cursor: updatedAt,
		receivedAt: Date.now(),
	};
}
