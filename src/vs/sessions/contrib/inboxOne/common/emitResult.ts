/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { validateAction } from './actionCatalog.js';
import { EvidenceRung, IEvidenceClaim, IEvidenceFreshness, IEvidencePack, IPrimaryAction } from './inboxOneTypes.js';

/**
 * Host-side validation of a worker's emitted result (technical spec 2.3, 7.1).
 *
 * The worker follows the baked-in emit-result contract and produces a structured
 * candidate: a typed action (action_type + payload), a short worker-authored
 * label, and an evidence pack (consequence + claims + gap). The HOST -- not the
 * model -- validates the action against the catalog and normalizes the evidence.
 * An out-of-catalog action, malformed payload, or missing mandatory evidence is
 * rejected so it surfaces as a failed attempt, never executed.
 *
 * The maximum label length keeps the worker-authored button label to a few words
 * (design 3.4). The label is display-only and never affects execution.
 */

/** Maximum words allowed in a worker-authored action label (design 3.4: <= 3-4 words). */
export const MAX_LABEL_WORDS = 4;
/** Maximum words in the worker-authored list title (a short headline, a few words). */
export const MAX_TITLE_WORDS = 6;
/** Evidence packs lead with a consequence and carry 2-3 grounded claims (design 3.3). */
export const MIN_EVIDENCE_CLAIMS = 1;
export const MAX_EVIDENCE_CLAIMS = 4;

/** The raw, untrusted result a worker emits (as parsed from its structured output). */
export interface IRawWorkerResult {
	readonly actionType?: string;
	readonly payload?: unknown;
	readonly label?: string;
	/** A short headline (a few words) for the inbox list title, distinct from the full decisionSentence. */
	readonly title?: string;
	readonly decisionSentence?: string;
	readonly claims?: readonly IRawClaim[];
	readonly gapLine?: string;
	readonly freshness?: IEvidenceFreshness;
}

export interface IRawClaim {
	readonly text?: string;
	readonly receiptLink?: string;
	readonly rung?: number;
}

export interface IEmitResultAccepted {
	readonly ok: true;
	readonly evidence: Omit<IEvidencePack, 'revision'>;
}

export interface IEmitResultRejected {
	readonly ok: false;
	readonly problems: readonly string[];
}

export type IEmitResultOutcome = IEmitResultAccepted | IEmitResultRejected;

function countWords(s: string): number {
	return s.trim().split(/\s+/).filter(Boolean).length;
}

function coerceRung(rung: number | undefined): EvidenceRung {
	// The rung is host-authoritative; a model-supplied number is clamped to a
	// known rung and defaults to the lowest (illustrative) when absent/invalid.
	const valid = [
		EvidenceRung.Illustrative, EvidenceRung.SingleRun, EvidenceRung.ReproducibleTest,
		EvidenceRung.Invariant, EvidenceRung.SourceLineage, EvidenceRung.ExecutableModel, EvidenceRung.Formal,
	];
	return typeof rung === 'number' && valid.includes(rung) ? rung : EvidenceRung.Illustrative;
}

/**
 * Validates and normalizes a raw worker result into a store-ready evidence pack,
 * or rejects it with a list of problems. Does not execute anything.
 */
export function validateWorkerResult(raw: IRawWorkerResult): IEmitResultOutcome {
	const problems: string[] = [];

	// --- evidence pack (mandatory) ---
	if (typeof raw.decisionSentence !== 'string' || raw.decisionSentence.trim().length === 0) {
		problems.push('decisionSentence must be a non-empty string');
	}
	if (typeof raw.gapLine !== 'string' || raw.gapLine.trim().length === 0) {
		problems.push('gapLine (the mandatory "Not verified" line) must be a non-empty string');
	}
	const rawClaims = Array.isArray(raw.claims) ? raw.claims : [];
	if (rawClaims.length < MIN_EVIDENCE_CLAIMS || rawClaims.length > MAX_EVIDENCE_CLAIMS) {
		problems.push(`evidence must have between ${MIN_EVIDENCE_CLAIMS} and ${MAX_EVIDENCE_CLAIMS} claims`);
	}
	const claims: IEvidenceClaim[] = [];
	rawClaims.forEach((c, i) => {
		if (typeof c.text !== 'string' || c.text.trim().length === 0) {
			problems.push(`claims[${i}].text must be a non-empty string`);
			return;
		}
		claims.push({ text: c.text.trim(), receiptLink: c.receiptLink, rung: coerceRung(c.rung) });
	});

	// --- primary action (optional, but if present must be valid) ---
	let primaryAction: IPrimaryAction | undefined;
	if (raw.actionType !== undefined || raw.payload !== undefined || raw.label !== undefined) {
		if (typeof raw.label !== 'string' || raw.label.trim().length === 0) {
			problems.push('label must be a non-empty string when an action is proposed');
		} else if (countWords(raw.label) > MAX_LABEL_WORDS) {
			problems.push(`label must be at most ${MAX_LABEL_WORDS} words`);
		}
		const actionType = typeof raw.actionType === 'string' ? raw.actionType : '';
		const validation = validateAction(actionType, raw.payload);
		if (!validation.valid) {
			problems.push(...validation.problems);
		}
		if (validation.valid && typeof raw.label === 'string' && countWords(raw.label) <= MAX_LABEL_WORDS && raw.label.trim().length > 0) {
			// Safe: validateAction confirmed actionType is a known ActionType.
			primaryAction = { label: raw.label.trim(), actionType: actionType as IPrimaryAction['actionType'], payload: raw.payload };
		}
	}

	if (problems.length > 0) {
		return { ok: false, problems };
	}

	const evidence: Omit<IEvidencePack, 'revision'> = {
		title: shortTitle(raw.title),
		decisionSentence: raw.decisionSentence!.trim(),
		claims,
		gapLine: raw.gapLine!.trim(),
		freshness: raw.freshness ?? { computedAt: Date.now() },
		primaryAction,
	};
	return { ok: true, evidence };
}

/**
 * Normalizes a worker-authored list title to a short headline: trims it and, if
 * it runs long, keeps the first {@link MAX_TITLE_WORDS} words so the inbox list
 * title stays a few words (the fuller recommendation lives in decisionSentence).
 * Returns `undefined` when absent so the host falls back to the decisionSentence.
 */
function shortTitle(raw: string | undefined): string | undefined {
	if (typeof raw !== 'string') {
		return undefined;
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	const words = trimmed.split(/\s+/).filter(Boolean);
	return words.length <= MAX_TITLE_WORDS ? trimmed : words.slice(0, MAX_TITLE_WORDS).join(' ') + '...';
}
