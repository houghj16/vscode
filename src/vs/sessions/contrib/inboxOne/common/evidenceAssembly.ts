/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EvidenceRung, IEvidenceClaim, IEvidenceFreshness } from './inboxOneTypes.js';

/**
 * Host-authoritative evidence assembly (design 7.2, invariant I5/I6).
 *
 * The worker gathers real receipts (Actions runs, check statuses, diffs, test
 * outputs, review threads); the HOST computes each claim's verifiability rung
 * FROM THE RECEIPT TYPE -- the model never sets its own rung. Rungs are internal
 * (weight/order only); the human sees the plain claim + click-through. Freshness
 * stamps the exact inputs a pack was computed from so a later material change can
 * be detected and stale evidence can never authorize an action.
 */

/** The kind of ground-truth a receipt points at; determines its rung. */
export const enum ReceiptKind {
	/** An illustrative example or narrative, not independently checkable. */
	Illustrative = 'illustrative',
	/** A single CI/Actions run or check status. */
	CheckRun = 'check_run',
	/** A reproducible test (e.g. run 50x green). */
	ReproducibleTest = 'reproducible_test',
	/** A source diff establishing what changed (lineage). */
	Diff = 'diff',
	/** A resolved/unresolved review thread. */
	ReviewThread = 'review_thread',
	/** An invariant/property that holds by construction. */
	Invariant = 'invariant',
}

/** Maps a receipt kind to its host-authoritative rung (I5). */
export function rungForReceipt(kind: ReceiptKind): EvidenceRung {
	switch (kind) {
		case ReceiptKind.Illustrative: return EvidenceRung.Illustrative;
		case ReceiptKind.CheckRun: return EvidenceRung.SingleRun;
		case ReceiptKind.ReviewThread: return EvidenceRung.SingleRun;
		case ReceiptKind.ReproducibleTest: return EvidenceRung.ReproducibleTest;
		case ReceiptKind.Diff: return EvidenceRung.SourceLineage;
		case ReceiptKind.Invariant: return EvidenceRung.Invariant;
	}
}

/** A raw receipt the worker gathered; the host derives the rung from its kind. */
export interface IReceipt {
	readonly kind: ReceiptKind;
	readonly text: string;
	readonly link?: string;
}

/** Builds a host-rung-weighted claim from a receipt (the model cannot set the rung). */
export function claimFromReceipt(receipt: IReceipt): IEvidenceClaim {
	return { text: receipt.text, receiptLink: receipt.link, rung: rungForReceipt(receipt.kind) };
}

/**
 * Orders claims by descending rung (strongest evidence first) so the pack leads
 * with the most verifiable claim. Stable for equal rungs.
 */
export function orderClaims(claims: readonly IEvidenceClaim[]): IEvidenceClaim[] {
	return claims.map((c, i) => ({ c, i }))
		.sort((a, b) => (b.c.rung - a.c.rung) || (a.i - b.i))
		.map(x => x.c);
}

/**
 * Derives an evidence-confidence score in [0,1] from the claims' rungs, for the
 * ranking `evidenceConfidence` input. Higher rungs -> higher confidence; an empty
 * or purely-illustrative pack is low confidence.
 */
export function evidenceConfidence(claims: readonly IEvidenceClaim[]): number {
	if (claims.length === 0) {
		return 0;
	}
	// Normalize the mean rung against the formal ceiling (8).
	const mean = claims.reduce((sum, c) => sum + c.rung, 0) / claims.length;
	return Math.min(1, mean / EvidenceRung.Formal);
}

/** Stamps freshness from the current authoritative inputs (design 7.2). */
export function stampFreshness(inputs: { headSha?: string; checkIds?: readonly string[]; eventCursor?: string }, now: number): IEvidenceFreshness {
	return {
		headSha: inputs.headSha,
		checkIds: inputs.checkIds ? [...inputs.checkIds] : undefined,
		eventCursor: inputs.eventCursor,
		computedAt: now,
	};
}

/**
 * Whether a stamped pack is STALE relative to the current authoritative state
 * (design 7.2, I6). A mismatch on any stamped input means the pack can no longer
 * authorize an action; the primary action must be disabled and re-verified.
 */
export function isStale(stamped: IEvidenceFreshness, current: { headSha?: string; checkIds?: readonly string[]; eventCursor?: string }): boolean {
	if (stamped.headSha !== undefined && current.headSha !== undefined && stamped.headSha !== current.headSha) {
		return true;
	}
	if (stamped.eventCursor !== undefined && current.eventCursor !== undefined && stamped.eventCursor !== current.eventCursor) {
		return true;
	}
	if (stamped.checkIds && current.checkIds) {
		const stampedSet = new Set(stamped.checkIds);
		const currentSet = new Set(current.checkIds);
		if (stampedSet.size !== currentSet.size || [...currentSet].some(id => !stampedSet.has(id))) {
			return true;
		}
	}
	return false;
}
