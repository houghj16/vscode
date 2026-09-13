/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IParsedSkill } from './skillModel.js';

/**
 * Role mounting / persona composition (design 5.2, technical spec 2.2 step 3).
 *
 * `mount_roles([...])` reads every skill tagged with the requested roles,
 * concatenates their bodies (plus any wiki patterns tagged for them), and returns
 * the composed persona context. Deterministic; the harness -- not the model --
 * attaches the skills. The worker's baked-in framework skills are mounted
 * unconditionally and are NOT governed by role selection (design 5.1).
 *
 * This module is the pure composition core; the file-backed store supplies the
 * parsed skills and wiki patterns.
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

	for (const skill of selected) {
		sections.push(renderSkillSection(skill));
		skillIds.push(skill.frontmatter.id);
	}

	if (patterns.length) {
		const patternText = patterns.map(p => `### pattern: ${p.id}\n${p.body.trim()}`).join('\n\n');
		sections.push(`## Learned patterns\n${patternText}`);
	}

	// Framework skills are mounted last so their output contract is the final,
	// authoritative instruction the worker reads (design 5.1 / 2.3).
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

function renderSkillSection(skill: IParsedSkill): string {
	return `## skill: ${skill.frontmatter.id}\n${skill.body.trim()}`;
}
