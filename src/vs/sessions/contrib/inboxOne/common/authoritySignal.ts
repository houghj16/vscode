/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GestureKind } from './inboxOneTypes.js';

/**
 * Cross-role DRI / authority signal (design 6.3). Diffy learns WHERE the user is
 * the DRI / has authority from behavior across ALL scenarios (they take
 * initiative on some review areas; they own some issue areas), stores it as a
 * repo-tagged pattern, and uses it as a learned prioritization/routing signal --
 * surfacing what they own, de-emphasizing what they don't.
 *
 * This is the pure accumulation model. An "area" is a repo-scoped tag
 * (`{repo}#{area}`, e.g. an owned subsystem or issue theme). Gestures across
 * roles feed one authority score per area, exposed as the `recipientAffinity`
 * input to ranking (design 7.1). The map is persisted as a wiki pattern and read
 * back at rank time.
 */

/** A single area's accumulated authority evidence. */
export interface IAuthorityEntry {
	/** Repo-scoped area key, e.g. `acme/api#auth`. */
	readonly area: string;
	/** Positive engagements (accept/steer/approve) that imply ownership. */
	readonly positive: number;
	/** Negative signals ("not my area", repeated dismiss) that imply non-ownership. */
	readonly negative: number;
}

export type AuthorityMap = ReadonlyMap<string, IAuthorityEntry>;

/** Builds a repo-scoped area key. */
export function areaKey(repo: string, area: string): string {
	return `${repo}#${area}`;
}

/**
 * Folds a gesture on an area into the authority map. Accept/Steer are ownership
 * signals (the user engaged and took initiative); Dismiss is a mild non-ownership
 * signal; an explicit "not my area" is a strong non-ownership signal.
 */
export function applyGestureToAuthority(
	map: AuthorityMap,
	area: string,
	gesture: GestureKind,
	notMyArea = false,
): AuthorityMap {
	const next = new Map(map);
	const entry = next.get(area) ?? { area, positive: 0, negative: 0 };
	let positive = entry.positive;
	let negative = entry.negative;

	if (notMyArea) {
		negative += 2; // explicit strong non-ownership
	} else {
		switch (gesture) {
			case GestureKind.Accept:
			case GestureKind.Steer:
				positive += 1;
				break;
			case GestureKind.NotMyArea:
				negative += 2; // explicit strong non-ownership (Why-this-rank popover)
				break;
			case GestureKind.Dismiss:
				negative += 1;
				break;
			case GestureKind.Rerank:
			case GestureKind.Snooze:
				break; // neutral for ownership
		}
	}
	next.set(area, { area, positive, negative });
	return next;
}

/**
 * The recipient-affinity in [0,1] for an area, used as the `recipientAffinity`
 * ranking input. Returns 0.5 (neutral) for an unseen area so ranking is not
 * biased before any evidence exists.
 */
export function authorityAffinity(map: AuthorityMap, area: string): number {
	const entry = map.get(area);
	if (!entry || (entry.positive === 0 && entry.negative === 0)) {
		return 0.5;
	}
	const total = entry.positive + entry.negative;
	return entry.positive / total;
}

/** Whether the user is considered the DRI of an area (affinity above a confident threshold). */
export function isOwnedArea(map: AuthorityMap, area: string, threshold = 0.6): boolean {
	const entry = map.get(area);
	if (!entry || entry.positive + entry.negative < 2) {
		return false; // insufficient evidence
	}
	return authorityAffinity(map, area) >= threshold;
}

/** Serializes the authority map to a stable wiki-pattern body. */
export function serializeAuthority(map: AuthorityMap): string {
	const rows = [...map.values()].sort((a, b) => a.area.localeCompare(b.area));
	return rows.map(r => `${r.area} | ${r.positive} | ${r.negative}`).join('\n') + (rows.length ? '\n' : '');
}

/** Parses a serialized authority map back into memory. */
export function parseAuthority(content: string): AuthorityMap {
	const map = new Map<string, IAuthorityEntry>();
	for (const raw of content.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const parts = line.split('|').map(p => p.trim());
		if (parts.length < 3) {
			continue;
		}
		const [area, positive, negative] = parts;
		map.set(area, { area, positive: toInt(positive), negative: toInt(negative) });
	}
	return map;
}

function toInt(s: string): number {
	const n = parseInt(s, 10);
	return Number.isFinite(n) ? n : 0;
}
