/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InboxOneTier } from './inboxOneTypes.js';

/**
 * Host-authoritative ranking and tiering (design 7.1, technical spec I5).
 *
 * Tiering (which section) is a POLICY separate from rank, so a score can never
 * erase lifecycle semantics. Rank within a tier is a host-computed, explainable
 * score over normalized inputs. Model-authored numbers are inputs, never
 * authoritative. The UI shows a plain-language reason, not the math.
 */

/** Normalized signals a worker/evidence contributes. Model numbers are clamped to [0,1] and treated as hints. */
export interface IRankSignals {
	/** Active incident / on-fire. Forces Critical. */
	readonly incident?: boolean;
	/** Exploitable/reachable security exposure. Forces Critical. */
	readonly reachableSecurityExposure?: boolean;
	/** A rollback decision or rapidly-expiring high-blast-radius action. Forces Critical. */
	readonly expiringHighBlastRadius?: boolean;
	/** Blocks or is time-boxed and materially affects delivery/users/health. Implies at least Urgent. */
	readonly blocking?: boolean;
	/** How many people this blocks (0 if none). */
	readonly blocksPeople?: number;
	/** A safe action auto-handled and logged. Lands as FYI. */
	readonly autoHandledDone?: boolean;
	/** Urgency in [0,1] after time decay. */
	readonly urgency?: number;
	/** Impact / blast radius in [0,1]. */
	readonly impact?: number;
	/** Evidence confidence in [0,1] (host-derived from claim rungs). */
	readonly evidenceConfidence?: number;
	/** Learned recipient affinity: the user owns/has authority in this area, in [0,1]. */
	readonly recipientAffinity?: number;
	/** Estimated decision effort in [0,1] (subtracted). */
	readonly decisionEffort?: number;
	/** More perishable items win ties; higher = more perishable. */
	readonly perishability?: number;
}

export interface IRankResult {
	readonly tier: InboxOneTier;
	/** Higher sorts first within a tier. */
	readonly rank: number;
	/** Plain-language reason (design 7.1). No score chrome. */
	readonly reason: string;
	/** Tie-breaker; exposed so the caller can order deterministically. */
	readonly perishability: number;
}

function clamp01(v: number | undefined): number {
	if (typeof v !== 'number' || !Number.isFinite(v)) { return 0; }
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Decides the tier from lifecycle policy, independent of the numeric rank. */
export function decideTier(signals: IRankSignals): InboxOneTier {
	if (signals.incident || signals.reachableSecurityExposure || signals.expiringHighBlastRadius) {
		return InboxOneTier.Critical;
	}
	if (signals.blocking || (signals.blocksPeople ?? 0) > 0) {
		return InboxOneTier.Urgent;
	}
	// Everything else -- valuable completed analysis or an auto-handled action --
	// is FYI. FYI never blocks a person and is never on fire.
	return InboxOneTier.Fyi;
}

/**
 * Computes an explainable rank score over normalized inputs. Weights are fixed
 * and host-owned; model-authored numbers enter only as clamped hints.
 */
export function computeRank(signals: IRankSignals): number {
	const urgency = clamp01(signals.urgency);
	const impact = clamp01(signals.impact);
	const confidence = clamp01(signals.evidenceConfidence);
	const affinity = clamp01(signals.recipientAffinity);
	const effort = clamp01(signals.decisionEffort);
	const blocksPeople = Math.max(0, signals.blocksPeople ?? 0);
	// Normalize "blocks N people" with diminishing returns.
	const blockingSignal = blocksPeople > 0 ? Math.min(1, blocksPeople / 5) : 0;

	const score =
		0.30 * urgency +
		0.25 * impact +
		0.20 * blockingSignal +
		0.15 * confidence +
		0.20 * affinity -
		0.15 * effort;

	// Round to a stable, comparable integer scale.
	return Math.round(score * 1000);
}

/** Builds a plain-language reason for the tier + rank (never score math). */
export function explainRank(signals: IRankSignals, tier: InboxOneTier): string {
	const parts: string[] = [];
	if (tier === InboxOneTier.Critical) {
		if (signals.incident) { parts.push('an incident is active'); }
		if (signals.reachableSecurityExposure) { parts.push('a reachable security exposure'); }
		if (signals.expiringHighBlastRadius) { parts.push('a rapidly-expiring high-impact action'); }
	}
	const blocks = signals.blocksPeople ?? 0;
	if (blocks > 0) { parts.push(`blocks ${blocks} ${blocks === 1 ? 'person' : 'people'}`); }
	else if (signals.blocking) { parts.push('blocks delivery'); }
	if ((signals.recipientAffinity ?? 0) >= 0.6) { parts.push('you own this area'); }
	if (signals.autoHandledDone) { parts.push('auto-handled and logged'); }
	if (parts.length === 0) { parts.push('a completed analysis for your awareness'); }
	return capitalize(joinReasons(parts)) + '.';
}

/** Full ranking pass: tier (policy) + rank (score) + reason (plain language). */
export function rank(signals: IRankSignals): IRankResult {
	const tier = decideTier(signals);
	return {
		tier,
		rank: computeRank(signals),
		reason: explainRank(signals, tier),
		perishability: clamp01(signals.perishability),
	};
}

/**
 * Deterministic comparator for two ranked items in the same tier: higher rank
 * first; ties break toward the more perishable item (design 7.1).
 */
export function compareRanked(a: IRankResult, b: IRankResult): number {
	if (a.rank !== b.rank) { return b.rank - a.rank; }
	return b.perishability - a.perishability;
}

function joinReasons(parts: string[]): string {
	if (parts.length === 1) { return parts[0]; }
	if (parts.length === 2) { return `${parts[0]} and ${parts[1]}`; }
	return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function capitalize(s: string): string {
	return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
