/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GestureKind, InboxOneTier } from './inboxOneTypes.js';

/**
 * Learning-loop records and routing (design 6, technical spec 10).
 *
 * On every resolution the host writes a raw experience record; the distiller
 * consolidates experience into the wiki first, then proposes skill diffs, routed
 * by the gesture. This module defines the durable record shapes and the pure
 * routing decisions (which learning target a gesture updates). The actual
 * consolidation runs as a stock session; this is the deterministic scaffolding
 * that keeps it idempotent and correctly routed.
 */

/** A raw experience record, written on every resolution (append-only, design 6.4). */
export interface IExperienceRecord {
	/** Unique per resolution; the distiller's idempotency key (G6). */
	readonly resolutionId: string;
	readonly taskId: string;
	readonly sessionId?: string;
	readonly repo?: string;
	/** The role the worker ran under, for skill-impact attribution. */
	readonly role?: string;
	readonly tier?: InboxOneTier;
	readonly gesture: GestureKind;
	/** The full worker transcript reference (stored separately if large). */
	readonly transcriptRef?: string;
	/** The full steering conversation -- the primary learning signal (design 6.2). */
	readonly steeringTranscript?: string;
	/** Execution receipts captured at resolution. */
	readonly receipts?: readonly string[];
	/** Free-form outcome summary. */
	readonly outcome?: string;
	readonly resolvedAt: number;
}

/** Which learning artifact a gesture primarily updates (design 6.2). */
export const enum LearningTarget {
	/** Accept -> reinforce the role skill path that produced the result. */
	ReinforceRoleSkill = 'reinforce_role_skill',
	/** Steer -> the steering conversation becomes a lesson + role skill update. */
	RoleSkillLesson = 'role_skill_lesson',
	/** Dismiss/rerank -> update Diffy's own coordinator (priority/dispatch) skill. */
	CoordinatorSkill = 'coordinator_skill',
}

/**
 * Routes a gesture to its primary learning target (design 6.2):
 *  - Accept  -> reinforce the role skill path.
 *  - Steer   -> the correction becomes a lesson + role skill update.
 *  - Dismiss -> "surfacing was wrong": update a coordinator priority/dispatch skill.
 *  - Rerank  -> also a coordinator signal.
 *  - Snooze  -> a weak coordinator timing signal.
 */
export function routeGesture(gesture: GestureKind): LearningTarget {
	switch (gesture) {
		case GestureKind.Accept:
			return LearningTarget.ReinforceRoleSkill;
		case GestureKind.Steer:
			return LearningTarget.RoleSkillLesson;
		case GestureKind.Dismiss:
		case GestureKind.Rerank:
		case GestureKind.Snooze:
			return LearningTarget.CoordinatorSkill;
	}
}

/** A skill-impact tally row (design 6.1, `skill-impact.md`). */
export interface ISkillImpact {
	readonly skillId: string;
	readonly used: number;
	readonly accepted: number;
	readonly steered: number;
	readonly dismissed: number;
}

/** Running score for a skill from its outcomes; drives promote/prune (design 6). */
export function skillScore(impact: ISkillImpact): number {
	if (impact.used === 0) {
		return 0;
	}
	// Accepts reinforce; steers are mild negatives (work was wrong, not surfacing);
	// dismisses are strong negatives (surfacing was wrong).
	const raw = (impact.accepted - 0.5 * impact.steered - impact.dismissed) / impact.used;
	return Math.round(raw * 100) / 100;
}

/** Serializes a skill-impact table to the `skill-impact.md` line format. */
export function formatSkillImpact(rows: readonly ISkillImpact[]): string {
	const header = 'skill | used | accepted | steered | dismissed | score';
	const lines = rows
		.slice()
		.sort((a, b) => a.skillId.localeCompare(b.skillId))
		.map(r => `${r.skillId} | ${r.used} | ${r.accepted} | ${r.steered} | ${r.dismissed} | ${skillScore(r)}`);
	return [header, ...lines].join('\n') + '\n';
}

/** Parses a `skill-impact.md` table back into rows (curator input). */
export function parseSkillImpact(content: string): ISkillImpact[] {
	const rows: ISkillImpact[] = [];
	for (const raw of content.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('skill |') || line.startsWith('#')) {
			continue;
		}
		const parts = line.split('|').map(p => p.trim());
		if (parts.length < 5) {
			continue;
		}
		const [skillId, used, accepted, steered, dismissed] = parts;
		rows.push({
			skillId,
			used: toInt(used),
			accepted: toInt(accepted),
			steered: toInt(steered),
			dismissed: toInt(dismissed),
		});
	}
	return rows;
}

/** Applies one experience record to a skill-impact table (curator tally). */
export function applyToSkillImpact(rows: readonly ISkillImpact[], skillId: string, gesture: GestureKind): ISkillImpact[] {
	const next = rows.map(r => ({ ...r }));
	let row = next.find(r => r.skillId === skillId);
	if (!row) {
		row = { skillId, used: 0, accepted: 0, steered: 0, dismissed: 0 };
		next.push(row);
	}
	row.used += 1;
	if (gesture === GestureKind.Accept) { row.accepted += 1; }
	else if (gesture === GestureKind.Steer) { row.steered += 1; }
	else if (gesture === GestureKind.Dismiss) { row.dismissed += 1; }
	return next;
}

function toInt(s: string): number {
	const n = parseInt(s, 10);
	return Number.isFinite(n) ? n : 0;
}
