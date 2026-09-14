/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IExperienceRecord, LearningTarget } from './learningLoop.js';

/**
 * The distiller brief + result parsing (design 6.2). The distiller is a stock
 * agent session: given the resolved experience and the current role skill, it
 * consolidates the lesson and proposes a versioned skill update. Because the
 * agent runs in a repo worktree (not the Inbox One file store), the current skill
 * is passed IN the brief and the proposed update comes BACK in a fenced block the
 * host applies -- keeping the semantic work in the agent and the durable write on
 * the host (idempotent, versioned, rollbackable).
 */

/** The fence tag the distiller emits its proposed SKILL.md in. */
export const DISTILLER_SKILL_FENCE = 'inbox-one-skill';

function targetGuidance(target: LearningTarget): string {
	switch (target) {
		case LearningTarget.ReinforceRoleSkill:
			return 'The human accepted the result. Reinforce what worked: make the winning approach more explicit/first-class in the skill.';
		case LearningTarget.RoleSkillLesson:
			return 'The human STEERED the result. Their steering is the primary signal -- turn the correction into a concrete lesson and fold it into the skill.';
		case LearningTarget.CoordinatorSkill:
			return 'The human dismissed/deprioritised this. Update the coordinator priority/dispatch skill so this kind of work is surfaced less or routed differently.';
	}
}

/**
 * Builds the self-contained distiller brief. Includes the resolved experience,
 * the target guidance, the current skill (when known), and the exact output
 * contract (emit the full proposed SKILL.md in an {@link DISTILLER_SKILL_FENCE}
 * block, or emit nothing to leave the skill unchanged).
 */
export function buildDistillerBrief(record: IExperienceRecord, target: LearningTarget, currentSkill: string | undefined): string {
	const lines: string[] = [
		'You are the Inbox One distiller. A task just resolved; distil the lesson and, only if warranted, propose a versioned update to the skill it ran on.',
		'',
		`Resolution: gesture=${record.gesture}, role=${record.role ?? 'unknown'}, repo=${record.repo ?? 'n/a'}, outcome=${record.outcome ?? 'n/a'}.`,
		targetGuidance(target),
	];
	if (record.steeringTranscript && record.steeringTranscript.trim()) {
		lines.push('', 'Steering conversation (the primary learning signal):', record.steeringTranscript.trim());
	}
	if (currentSkill && currentSkill.trim()) {
		lines.push('', 'Current skill (SKILL.md):', '```', currentSkill.trim(), '```');
	} else {
		lines.push('', 'There is no existing skill for this role yet; you may propose a new one.');
	}
	lines.push(
		'',
		'Output contract: if (and only if) an update is warranted, emit the FULL proposed SKILL.md as the last thing in your message, in a single fenced block tagged',
		'`' + DISTILLER_SKILL_FENCE + '` (keep the YAML frontmatter, bump nothing -- the host versions it). Do not modify framework skills. If no change is warranted, emit no such block.',
	);
	return lines.join('\n');
}

const FENCE_RE = new RegExp('```' + DISTILLER_SKILL_FENCE + '\\s*([\\s\\S]*?)```', 'g');

/**
 * Extracts the proposed SKILL.md from the distiller's final message, or
 * `undefined` when the distiller proposed no change. Takes the last block if
 * several are present. Rejects an empty/frontmatter-less body defensively.
 */
export function parseProposedSkill(text: string): string | undefined {
	if (!text) {
		return undefined;
	}
	let match: RegExpExecArray | null;
	let last: string | undefined;
	FENCE_RE.lastIndex = 0;
	while ((match = FENCE_RE.exec(text)) !== null) {
		last = match[1];
	}
	if (last === undefined) {
		return undefined;
	}
	const body = last.trim();
	// A valid SKILL.md leads with YAML frontmatter; reject anything else so a
	// malformed proposal never clobbers a good skill.
	if (!body.startsWith('---') || body.length < 8) {
		return undefined;
	}
	return body;
}

/**
 * Produces a simulated distiller proposal for the in-window learning loop (dev
 * builds only): when no agent host is connected, this stands in for the distiller
 * agent by folding the resolved lesson into the current skill, so the learning
 * loop is exercised headless and the skill visibly evolves (a new version through
 * the same host `writeSkill` path). Returns `undefined` when no update is
 * warranted (e.g. a dismiss, a coordinator-skill target, or a duplicate lesson),
 * mirroring the real distiller's "only if warranted" contract.
 */
export function simulateDistillerProposal(record: IExperienceRecord, target: LearningTarget, currentSkill: string | undefined): string | undefined {
	const base = currentSkill?.trim();
	if (!base || !base.startsWith('---')) {
		return undefined;
	}
	// Only the role-skill targets fold a lesson into this skill; a dismiss routes
	// to the coordinator skill (a different target) and warrants no change here.
	if (target === LearningTarget.CoordinatorSkill) {
		return undefined;
	}
	const where = record.repo ? ` in ${record.repo}` : '';
	const steer = record.steeringTranscript && record.steeringTranscript.trim() ? ` Signal: ${firstSentence(record.steeringTranscript)}` : '';
	const lesson = target === LearningTarget.RoleSkillLesson
		? `The human steered a ${record.role ?? 'worker'} result${where}; apply their correction before falling back to the default approach.${steer}`
		: `The human accepted a ${record.role ?? 'worker'} result${where}; keep leading with the approach that worked.`;
	// Idempotent: never append the same lesson twice.
	if (base.includes(lesson)) {
		return undefined;
	}
	const day = new Date().toISOString().slice(0, 10);
	return `${base}\n\n## Learned (${day})\n- ${lesson}`;
}

function firstSentence(text: string): string {
	const trimmed = text.trim().replace(/\s+/g, ' ');
	const end = trimmed.search(/[.!?]\s|[.!?]$/);
	const sentence = end === -1 ? trimmed : trimmed.slice(0, end + 1);
	return sentence.length > 160 ? sentence.slice(0, 157) + '...' : sentence;
}
