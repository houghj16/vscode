/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRawClaim, IRawWorkerResult } from './emitResult.js';
import { ILogicalTask } from './inboxOneTypes.js';
import { IRankSignals } from './ranking.js';

/**
 * Parses the machine-readable result a worker emits per the emit-result contract
 * (seedSkills EMIT_RESULT): the final message contains a single fenced code block
 * tagged `inbox-one-result` with JSON. This is the pure bridge from a real worker
 * transcript to the host-validated {@link IRawWorkerResult}; it never trusts the
 * content (the host still validates the action + evidence downstream).
 */

const FENCE = /```inbox-one-result\s*([\s\S]*?)```/g;

function str(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

function toClaims(v: unknown): readonly IRawClaim[] | undefined {
	if (!Array.isArray(v)) { return undefined; }
	return v.map(c => {
		const o = (c && typeof c === 'object') ? c as Record<string, unknown> : {};
		return {
			text: str(o.text),
			receiptLink: str(o.receiptLink) ?? str(o.receipt_link),
			rung: typeof o.rung === 'number' ? o.rung : undefined,
		};
	});
}

/**
 * Extracts and parses the last `inbox-one-result` block from a worker's final
 * message, mapping the on-wire snake_case action field to the internal shape.
 * Returns `undefined` when no block is present or the JSON is malformed.
 */
export function parseWorkerResult(text: string): IRawWorkerResult | undefined {
	if (!text) { return undefined; }
	let match: RegExpExecArray | null;
	let last: string | undefined;
	FENCE.lastIndex = 0;
	while ((match = FENCE.exec(text)) !== null) {
		last = match[1];
	}
	if (last === undefined) { return undefined; }

	let raw: Record<string, unknown>;
	try {
		const parsed = JSON.parse(last.trim());
		if (!parsed || typeof parsed !== 'object') { return undefined; }
		raw = parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}

	return {
		actionType: str(raw.action_type) ?? str(raw.actionType),
		payload: raw.payload,
		label: str(raw.label),
		title: str(raw.title),
		decisionSentence: str(raw.decisionSentence) ?? str(raw.decision_sentence),
		customAsk: str(raw.customAsk) ?? str(raw.custom_ask),
		claims: toClaims(raw.claims),
		gapLine: str(raw.gapLine) ?? str(raw.gap_line),
	};
}

/**
 * Derives host-authoritative ranking signals for a worker result. Ranking is
 * never authored by the worker (I5): the tier + plain-language reason are
 * computed here from the task's real event and the evidence strength. This MVP
 * derivation uses the signals available client-side (evidence rung, event kind);
 * a fuller host would also consult live GitHub state (blocked reviewers, code
 * ownership) to populate `blocksPeople`/`recipientAffinity` precisely.
 */
export function deriveRankSignals(result: IRawWorkerResult, task: ILogicalTask): IRankSignals {
	const maxRung = (result.claims ?? []).reduce((m, c) => Math.max(m, typeof c.rung === 'number' ? c.rung : 0), 0);
	const evidenceConfidence = maxRung >= 2 ? 0.9 : maxRung === 1 ? 0.75 : 0.5;

	const kind = task.sourceEvent.subject.kind;
	const signals: { -readonly [K in keyof IRankSignals]: IRankSignals[K] } = { evidenceConfidence };

	switch (kind) {
		case 'pr':
			// A ready PR blocks whoever is waiting to merge/land it.
			signals.blocking = true;
			signals.urgency = 0.5;
			break;
		case 'check':
			// A broken build blocks the branch/PR it attaches to.
			signals.blocking = true;
			signals.urgency = 0.6;
			break;
		case 'security':
			signals.reachableSecurityExposure = false; // reachability unknown without the prod graph
			signals.urgency = 0.7;
			break;
		case 'issue':
		case 'issue-cluster':
			signals.impact = 0.4;
			signals.urgency = 0.3;
			break;
		default:
			signals.urgency = 0.3;
			break;
	}
	return signals;
}
