/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IParsedSkill } from './skillModel.js';

/**
 * Role mounting / persona composition (design 5.2, technical spec 2.2 step 3).
 *
 * `mount_roles([...])` selects the skills tagged with the requested roles and
 * composes the worker persona. Role skills are ATTACHED to the session through
 * the harness Skills integration (directory discovery), so this references them
 * by name + purpose rather than inlining their full bodies -- the worker loads a
 * skill's methodology on demand by name, and the first message stays small as
 * skills accumulate. Learned wiki patterns (not discoverable skills) and the
 * small, mandatory framework output contract are inlined in full. Deterministic;
 * the harness -- not the model -- selects/attaches the skills. Framework skills
 * are mounted unconditionally, independent of role selection (design 5.1).
 *
 * This module is the pure composition core; the file-backed store supplies the
 * parsed skills and wiki patterns and projects the role skills into the harness
 * discovery directory.
 */

export interface IWikiPatternSnippet {
	readonly id: string;
	readonly body: string;
}

export interface IMountResult {
	/** The composed persona text (system-prompt fragment). */
	readonly personaText: string;
	/** Skill ids that were mounted, in order. */
	readonly skillIds: readonly string[];
	/** Wiki pattern ids that were included. */
	readonly patternIds: readonly string[];
}

export interface IMountOptions {
	/** Framework skills mounted onto EVERY worker regardless of role (e.g. emit-result). */
	readonly frameworkSkills?: readonly IParsedSkill[];
	/** Wiki patterns tagged for the selected roles (design 5.3, retrieved via index.md). */
	readonly wikiPatterns?: readonly IWikiPatternSnippet[];
}

/**
 * Composes persona text for the requested roles from the available skills.
 *
 * Selection is deterministic: skills whose declared roles intersect the requested
 * set, ordered by skill id for stability; then any framework skills (always), then
 * tagged wiki patterns. A requested role with no skills contributes nothing (the
 * caller may still dispatch -- the brief carries the work item).
 */
export function mountRoles(roleNames: readonly string[], skills: readonly IParsedSkill[], options: IMountOptions = {}): IMountResult {
	const requested = new Set(roleNames);
	const selected = skills
		.filter(s => s.frontmatter.roles.some(r => requested.has(r)))
		.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));

	const framework = (options.frameworkSkills ?? []).slice();
	const patterns = (options.wikiPatterns ?? []).slice();

	const sections: string[] = [];
	const skillIds: string[] = [];

	// Role skills are ATTACHED to the worker session through the harness Skills
	// integration (discovered from the skills directory), so reference them by name
	// and purpose here instead of inlining their full bodies -- the worker loads a
	// skill's full methodology on demand by name. This keeps the first message from
	// ballooning as skills accumulate; only the (small, mandatory) framework output
	// contract below is inlined in full.
	if (selected.length) {
		const refs = selected.map(s => `- ${s.frontmatter.id}: ${skillPurpose(s.body)}`).join('\n');
		sections.push(`## Your skills for this task\nFocus on these role skills, attached to your session via your Skills -- open them by name for their full methodology:\n${refs}`);
		for (const skill of selected) {
			skillIds.push(skill.frontmatter.id);
		}
	}

	if (patterns.length) {
		const patternText = patterns.map(p => `### pattern: ${p.id}\n${p.body.trim()}`).join('\n\n');
		sections.push(`## Learned patterns\n${patternText}`);
	}

	// The framework output contract is inlined in full (small, authoritative, and
	// followed exactly), mounted last so it is the final instruction the worker
	// reads (design 5.1 / 2.3).
	for (const skill of framework) {
		sections.push(renderSkillSection(skill));
		skillIds.push(skill.frontmatter.id);
	}

	return {
		personaText: sections.join('\n\n').trim(),
		skillIds,
		patternIds: patterns.map(p => p.id),
	};
}

/** The first meaningful line of a skill body (its heading), used as a one-line reference purpose. */
function skillPurpose(body: string): string {
	for (const raw of body.split('\n')) {
		const line = raw.trim();
		if (line.length === 0) {
			continue;
		}
		return line.startsWith('# ') ? line.slice(2).trim() : line;
	}
	return '';
}

function renderSkillSection(skill: IParsedSkill): string {
	return `## skill: ${skill.frontmatter.id}\n${skill.body.trim()}`;
}
