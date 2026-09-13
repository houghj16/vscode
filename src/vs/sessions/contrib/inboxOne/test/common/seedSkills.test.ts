/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ALL_SEED_SKILLS, SEED_FRAMEWORK_SKILL, SEED_ROLE_SKILLS } from '../../common/seedSkills.js';
import { mountRoles } from '../../common/roleMount.js';
import { generateRoleList, IParsedSkill, parseRoleList, parseSkill } from '../../common/skillModel.js';

function parseAll(files: readonly { content: string }[]): IParsedSkill[] {
	const parsed: IParsedSkill[] = [];
	for (const f of files) {
		const p = parseSkill(f.content);
		assert.ok(p, 'seed skill should parse');
		parsed.push(p!);
	}
	return parsed;
}

suite('Inbox One - seed skills', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every seed skill parses with an id', () => {
		for (const f of ALL_SEED_SKILLS) {
			const parsed = parseSkill(f.content);
			assert.ok(parsed, `failed to parse ${f.path}`);
			assert.ok(parsed!.frontmatter.id.length > 0, `${f.path} missing id`);
		}
	});

	test('the framework emit-result skill declares no roles (excluded from role_list)', () => {
		const parsed = parseSkill(SEED_FRAMEWORK_SKILL.content)!;
		assert.strictEqual(parsed.frontmatter.id, 'emit-result');
		assert.deepStrictEqual(parsed.frontmatter.roles, []);
	});

	test('the three role clusters generate the expected role_list', () => {
		const map = parseRoleList(generateRoleList(parseAll(SEED_ROLE_SKILLS)));
		assert.deepStrictEqual(map.get('issue-triage'), ['group-issues-by-theme']);
		assert.deepStrictEqual(map.get('implement-fix'), ['flaky-test-repro']);
		assert.deepStrictEqual(map.get('code-review'), ['behavioral-delta']);
	});

	test('mounting a role composes its seed skill plus the framework contract', () => {
		const roleSkills = parseAll(SEED_ROLE_SKILLS);
		const framework = [parseSkill(SEED_FRAMEWORK_SKILL.content)!];
		const result = mountRoles(['code-review'], roleSkills, { frameworkSkills: framework });
		assert.ok(result.skillIds.includes('behavioral-delta'));
		assert.ok(result.skillIds.includes('emit-result'));
		assert.ok(result.personaText.includes('Behavioral-delta review'));
		assert.ok(result.personaText.includes('Emit result'));
	});

	test('seed skills declare stable, unique ids', () => {
		const ids = ALL_SEED_SKILLS.map(f => parseSkill(f.content)!.frontmatter.id);
		assert.strictEqual(new Set(ids).size, ids.length, 'seed skill ids must be unique');
	});
});
