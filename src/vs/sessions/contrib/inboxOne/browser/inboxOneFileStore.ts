/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInboxOneFileStore, IStoredSkill, IStoredWikiPattern, ISkillVersion } from '../common/inboxOneFileStore.js';
import { IMountResult, IWikiPatternSnippet, mountRoles } from '../common/roleMount.js';
import { ALL_SEED_SKILLS } from '../common/seedSkills.js';
import { COORDINATOR_SKILL_DIR, FRAMEWORK_SKILL_DIR, generateRoleList, IParsedSkill, parseRoleList, parseSkill } from '../common/skillModel.js';

const ROLE_LIST_FILE = 'role_list.md';
const WIKI_INDEX = 'index.md';
const WIKI_LOG = 'log.md';
const WIKI_SKILL_IMPACT = 'skill-impact.md';

/**
 * {@link IInboxOneFileStore} backed by {@link IFileService}. The store lives under
 * a per-inbox root with `/skills`, `/wiki`, and `/experience` subtrees. On first
 * run it seeds the bundled defaults and generates `role_list.md`. Skill writes
 * archive prior versions for rollback and regenerate the registry (gotcha G5).
 */
export class InboxOneFileStore extends Disposable implements IInboxOneFileStore {

	declare readonly _serviceBrand: undefined;

	readonly root: URI;
	private readonly skillsRoot: URI;
	private readonly wikiRoot: URI;
	private readonly patternsRoot: URI;
	private readonly experienceRoot: URI;
	private readonly historyRoot: URI;

	private readonly _roleList: ISettableObservable<ReadonlyMap<string, readonly string[]>>;
	private _initialized: Promise<void> | undefined;

	constructor(
		root: URI,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.root = root;
		this.skillsRoot = joinPath(root, 'skills');
		this.wikiRoot = joinPath(root, 'wiki');
		this.patternsRoot = joinPath(this.wikiRoot, 'patterns');
		this.experienceRoot = joinPath(root, 'experience');
		this.historyRoot = joinPath(root, '.history');
		this._roleList = observableValue<ReadonlyMap<string, readonly string[]>>('inboxOneRoleList', new Map());
	}

	get roleList(): IObservable<ReadonlyMap<string, readonly string[]>> {
		return this._roleList;
	}

	initialize(): Promise<void> {
		if (!this._initialized) {
			this._initialized = this.doInitialize();
		}
		return this._initialized;
	}

	private async doInitialize(): Promise<void> {
		for (const dir of [this.skillsRoot, this.wikiRoot, this.patternsRoot, this.experienceRoot, this.historyRoot]) {
			await this.ensureDir(dir);
		}
		// Seed bundled defaults only for skills that do not already exist, so the
		// learning loop's evolved versions are never clobbered on restart.
		for (const seed of ALL_SEED_SKILLS) {
			const target = joinPath(this.skillsRoot, seed.path);
			if (!(await this.fileService.exists(target))) {
				await this.ensureDir(dirOf(target));
				await this.writeText(target, seed.content);
			}
		}
		// Seed empty wiki scaffolding.
		for (const [uri, initial] of [
			[joinPath(this.wikiRoot, WIKI_INDEX), '# Wiki index\n'],
			[joinPath(this.wikiRoot, WIKI_LOG), '# Learning log\n'],
			[joinPath(this.wikiRoot, WIKI_SKILL_IMPACT), 'skill | used | accepted | steered | dismissed | score\n'],
		] as const) {
			if (!(await this.fileService.exists(uri))) {
				await this.writeText(uri, initial);
			}
		}
		await this.regenerateRoleList();
		this.logService.trace(`[inboxOne] file store initialized at ${this.root.toString()}`);
	}

	// --- skills ---

	async listSkills(): Promise<readonly IStoredSkill[]> {
		return this.readAllSkills();
	}

	async getSkill(id: string): Promise<IStoredSkill | undefined> {
		return (await this.readAllSkills()).find(s => s.frontmatter.id === id);
	}

	async writeSkill(id: string, content: string): Promise<void> {
		const existing = await this.getSkill(id);
		if (existing?.isFramework) {
			throw new Error(`Cannot modify framework skill '${id}' (immutable, excluded from learning).`);
		}
		const parsed = parseSkill(content);
		if (!parsed || parsed.frontmatter.id !== id) {
			throw new Error(`Skill content must parse with id '${id}'.`);
		}
		// Archive the prior version for rollback before overwriting.
		if (existing) {
			await this.archiveVersion(existing);
		}
		const target = existing?.path
			? joinPath(this.skillsRoot, existing.path)
			: joinPath(this.skillsRoot, `${id}/SKILL.md`);
		await this.ensureDir(dirOf(target));
		await this.writeText(target, content);
		await this.regenerateRoleList();
	}

	async rollbackSkill(id: string, toVersion: number): Promise<void> {
		const history = await this.getSkillHistory(id);
		const target = history.find(v => v.version === toVersion);
		if (!target) {
			throw new Error(`No archived version ${toVersion} for skill '${id}'.`);
		}
		await this.writeSkill(id, target.content);
	}

	async getSkillHistory(id: string): Promise<readonly ISkillVersion[]> {
		const dir = joinPath(this.historyRoot, id);
		if (!(await this.fileService.exists(dir))) {
			return [];
		}
		const entries = await this.fileService.resolve(dir);
		const versions: ISkillVersion[] = [];
		for (const child of entries.children ?? []) {
			if (child.isDirectory || !child.name.endsWith('.md')) {
				continue;
			}
			const content = await this.readText(child.resource);
			const parsed = parseSkill(content);
			const stat = await this.fileService.stat(child.resource);
			versions.push({
				version: parsed?.frontmatter.version ?? 0,
				content,
				provenance: parsed?.frontmatter.provenance ?? [],
				savedAt: stat.mtime ?? 0,
			});
		}
		return versions.sort((a, b) => a.version - b.version);
	}

	async regenerateRoleList(): Promise<ReadonlyMap<string, readonly string[]>> {
		const skills = await this.readAllSkills();
		// Framework skills are excluded from the role registry (design 5.1).
		const registrySkills = skills.filter(s => !s.isFramework);
		const content = generateRoleList(registrySkills);
		await this.writeText(joinPath(this.skillsRoot, ROLE_LIST_FILE), content);
		const map = parseRoleList(content);
		this._roleList.set(map, undefined);
		return map;
	}

	async mountRoles(roleNames: readonly string[]): Promise<IMountResult> {
		const skills = await this.readAllSkills();
		const roleSkills = skills.filter(s => !s.isFramework && !s.isCoordinator);
		const framework = skills.filter(s => s.isFramework);
		const patterns: IWikiPatternSnippet[] = (await this.listWikiPatterns())
			.filter(p => patternMatchesRoles(p, roleNames))
			.map(p => ({ id: p.slug, body: p.body }));
		return mountRoles(roleNames, roleSkills, { frameworkSkills: framework, wikiPatterns: patterns });
	}

	// --- wiki ---

	async appendWikiLog(entry: string): Promise<void> {
		const uri = joinPath(this.wikiRoot, WIKI_LOG);
		const existing = (await this.fileService.exists(uri)) ? await this.readText(uri) : '';
		const dated = `\n## ${new Date().toISOString()}\n${entry.trim()}\n`;
		await this.writeText(uri, existing + dated);
	}

	async upsertWikiPattern(slug: string, content: string): Promise<void> {
		await this.ensureDir(this.patternsRoot);
		await this.writeText(joinPath(this.patternsRoot, `${slug}.md`), content);
	}

	async listWikiPatterns(): Promise<readonly IStoredWikiPattern[]> {
		if (!(await this.fileService.exists(this.patternsRoot))) {
			return [];
		}
		const entries = await this.fileService.resolve(this.patternsRoot);
		const patterns: IStoredWikiPattern[] = [];
		for (const child of entries.children ?? []) {
			if (child.isDirectory || !child.name.endsWith('.md')) {
				continue;
			}
			const content = await this.readText(child.resource);
			const parsed = parseSkill(content);
			patterns.push({
				slug: child.name.replace(/\.md$/, ''),
				frontmatter: (parsed?.frontmatter as unknown as Record<string, unknown>) ?? {},
				body: parsed?.body ?? content,
			});
		}
		return patterns;
	}

	readWikiIndex(): Promise<string> {
		return this.readTextOr(joinPath(this.wikiRoot, WIKI_INDEX), '# Wiki index\n');
	}
	writeWikiIndex(content: string): Promise<void> {
		return this.writeText(joinPath(this.wikiRoot, WIKI_INDEX), content);
	}
	readSkillImpact(): Promise<string> {
		return this.readTextOr(joinPath(this.wikiRoot, WIKI_SKILL_IMPACT), 'skill | used | accepted | steered | dismissed | score\n');
	}
	writeSkillImpact(content: string): Promise<void> {
		return this.writeText(joinPath(this.wikiRoot, WIKI_SKILL_IMPACT), content);
	}

	// --- experience ---

	async writeExperience(id: string, record: unknown): Promise<void> {
		const dir = joinPath(this.experienceRoot, id);
		await this.ensureDir(dir);
		await this.writeText(joinPath(dir, 'record.json'), JSON.stringify(record, null, 2));
	}

	async readExperience(id: string): Promise<unknown | undefined> {
		const uri = joinPath(this.experienceRoot, id, 'record.json');
		if (!(await this.fileService.exists(uri))) {
			return undefined;
		}
		try {
			return JSON.parse(await this.readText(uri));
		} catch {
			return undefined;
		}
	}

	async listExperienceIds(): Promise<readonly string[]> {
		if (!(await this.fileService.exists(this.experienceRoot))) {
			return [];
		}
		const entries = await this.fileService.resolve(this.experienceRoot);
		return (entries.children ?? []).filter(c => c.isDirectory).map(c => c.name);
	}

	// --- internals ---

	private async readAllSkills(): Promise<IStoredSkill[]> {
		const skills: IStoredSkill[] = [];
		await this.collectSkills(this.skillsRoot, skills);
		return skills;
	}

	private async collectSkills(dir: URI, out: IStoredSkill[]): Promise<void> {
		if (!(await this.fileService.exists(dir))) {
			return;
		}
		const entries = await this.fileService.resolve(dir);
		for (const child of entries.children ?? []) {
			if (child.isDirectory) {
				await this.collectSkills(child.resource, out);
			} else if (child.name.endsWith('.md') && child.name !== ROLE_LIST_FILE) {
				const content = await this.readText(child.resource);
				const parsed = parseSkill(content);
				if (!parsed) {
					continue;
				}
				const rel = relativePath(this.skillsRoot, child.resource);
				out.push({
					...parsed,
					path: rel,
					isFramework: rel.startsWith(`${FRAMEWORK_SKILL_DIR}/`),
					isCoordinator: rel.startsWith(`${COORDINATOR_SKILL_DIR}/`),
				});
			}
		}
	}

	private async archiveVersion(skill: IStoredSkill): Promise<void> {
		const version = skill.frontmatter.version ?? 0;
		const dir = joinPath(this.historyRoot, skill.frontmatter.id);
		await this.ensureDir(dir);
		const current = await this.readText(joinPath(this.skillsRoot, skill.path));
		await this.writeText(joinPath(dir, `v${version}.md`), current);
	}

	private async ensureDir(dir: URI): Promise<void> {
		if (!(await this.fileService.exists(dir))) {
			await this.fileService.createFolder(dir);
		}
	}

	private async writeText(uri: URI, content: string): Promise<void> {
		await this.fileService.writeFile(uri, VSBuffer.fromString(content));
	}

	private async readText(uri: URI): Promise<string> {
		const content = await this.fileService.readFile(uri);
		return content.value.toString();
	}

	private async readTextOr(uri: URI, fallback: string): Promise<string> {
		return (await this.fileService.exists(uri)) ? this.readText(uri) : fallback;
	}
}

function dirOf(uri: URI): URI {
	return joinPath(uri, '..');
}

function relativePath(root: URI, child: URI): string {
	const rootPath = root.path.endsWith('/') ? root.path : root.path + '/';
	return child.path.startsWith(rootPath) ? child.path.slice(rootPath.length) : basename(child);
}

function patternMatchesRoles(pattern: IStoredWikiPattern, roleNames: readonly string[]): boolean {
	const tags = pattern.frontmatter['roles'] ?? pattern.frontmatter['tags'];
	if (Array.isArray(tags)) {
		return tags.some(t => typeof t === 'string' && roleNames.includes(t));
	}
	return false;
}

/** Standalone helper mirroring the parsed-skill shape for tests. */
export function toParsedSkill(skill: IStoredSkill): IParsedSkill {
	return { frontmatter: skill.frontmatter, body: skill.body };
}
