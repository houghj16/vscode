/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IParsedSkill, ISkillFrontmatter } from './skillModel.js';
import { IMountResult } from './roleMount.js';

export const IInboxOneFileStore = createDecorator<IInboxOneFileStore>('inboxOneFileStore');

/** A skill record as read from the file store. */
export interface IStoredSkill extends IParsedSkill {
	/** The store-relative path, e.g. `group-issues-by-theme/SKILL.md`. */
	readonly path: string;
	/** True for framework skills (excluded from role_list, never learned). */
	readonly isFramework: boolean;
	/** True for coordinator skills (drive Diffy, not workers). */
	readonly isCoordinator: boolean;
}

/** A wiki pattern read from `/wiki/patterns/{slug}.md`. */
export interface IStoredWikiPattern {
	readonly slug: string;
	readonly frontmatter: Record<string, unknown>;
	readonly body: string;
}

/** A prior version of a skill, for history/rollback (design 6.4). */
export interface ISkillVersion {
	readonly version: number;
	readonly content: string;
	readonly provenance: readonly string[];
	readonly savedAt: number;
}

/**
 * File-backed store for the learning loop's three tiers (design 6.1): the
 * executable `/skills`, the curated `/wiki`, and the raw `/experience`. Seeded
 * from the bundled defaults on first run; thereafter the distiller and curator
 * evolve it. Keyed per inbox so multiple inboxes/tenants stay isolated.
 *
 * `role_list.md` is regenerated deterministically (regex over skill frontmatter)
 * on any skill create/modify and as a pre-dispatch safety pass (gotcha G5).
 */
export interface IInboxOneFileStore {
	readonly _serviceBrand: undefined;

	/** Root of this inbox's file-backed store. */
	readonly root: URI;

	/** Live view of the current role registry (role -> skill ids). */
	readonly roleList: IObservable<ReadonlyMap<string, readonly string[]>>;

	/** Ensures the store exists and is seeded from bundled defaults (idempotent). */
	initialize(): Promise<void>;

	// --- skills ---

	/** All role/coordinator/framework skills currently in the store. */
	listSkills(): Promise<readonly IStoredSkill[]>;
	getSkill(id: string): Promise<IStoredSkill | undefined>;
	/**
	 * Writes a new version of a skill (distiller/curator). Bumps the on-disk
	 * version, archives the prior content for rollback, then regenerates
	 * `role_list.md`. Framework skills are immutable and rejected.
	 */
	writeSkill(id: string, content: string): Promise<void>;
	/** Rolls a skill back to a prior version and regenerates `role_list.md` (design 6.4). */
	rollbackSkill(id: string, toVersion: number): Promise<void>;
	getSkillHistory(id: string): Promise<readonly ISkillVersion[]>;

	/** Regenerates `role_list.md` from current skills (regex, no LLM). Returns the new map. */
	regenerateRoleList(): Promise<ReadonlyMap<string, readonly string[]>>;

	/** Composes the persona for the given roles (mount_roles), always mounting framework skills. */
	mountRoles(roleNames: readonly string[]): Promise<IMountResult>;

	// --- wiki ---

	/** Appends a dated entry to `/wiki/log.md` (fast tempo; distiller). */
	appendWikiLog(entry: string): Promise<void>;
	/** Reads the full `/wiki/log.md` (append-only evolution log). */
	readWikiLog(): Promise<string>;
	/** Upserts a pattern at `/wiki/patterns/{slug}.md`. */
	upsertWikiPattern(slug: string, content: string): Promise<void>;
	listWikiPatterns(): Promise<readonly IStoredWikiPattern[]>;
	/** Reads the wiki router `/wiki/index.md` (curated catalog). */
	readWikiIndex(): Promise<string>;
	writeWikiIndex(content: string): Promise<void>;
	/** Reads/writes the outcome ledger `/wiki/skill-impact.md`. */
	readSkillImpact(): Promise<string>;
	writeSkillImpact(content: string): Promise<void>;

	// --- experience ---

	/** Writes a raw experience record under `/experience/{id}/` (append-only). */
	writeExperience(id: string, record: unknown): Promise<void>;
	readExperience(id: string): Promise<unknown | undefined>;
	listExperienceIds(): Promise<readonly string[]>;
}

/** Frontmatter helper: whether a skill's frontmatter marks it framework-owned. */
export function isFrameworkFrontmatter(frontmatter: ISkillFrontmatter): boolean {
	return frontmatter.id === 'emit-result';
}
