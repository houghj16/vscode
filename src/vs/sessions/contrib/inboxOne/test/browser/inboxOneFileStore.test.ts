/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InboxOneFileStore } from '../../browser/inboxOneFileStore.js';

const ROOT = URI.from({ scheme: Schemas.inMemory, path: '/inbox-one' });

suite('Inbox One - file-backed store', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function createStore(): Promise<InboxOneFileStore> {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		const store = disposables.add(new InboxOneFileStore(ROOT, undefined, fileService, new NullLogService()));
		await store.initialize();
		return store;
	}

	test('initialize seeds the bundled skills and generates role_list', async () => {
		const store = await createStore();
		const skills = await store.listSkills();
		const ids = skills.map(s => s.frontmatter.id).sort();
		assert.ok(ids.includes('group-issues-by-theme'));
		assert.ok(ids.includes('flaky-test-repro'));
		assert.ok(ids.includes('behavioral-delta'));
		assert.ok(ids.includes('emit-result'));
		assert.ok(ids.includes('coordinator-routing'));

		const roles = store.roleList.get();
		assert.deepStrictEqual(roles.get('issue-triage'), ['group-issues-by-theme']);
		assert.deepStrictEqual(roles.get('code-review'), ['behavioral-delta']);
	});

	test('framework skill is excluded from role_list', async () => {
		const store = await createStore();
		const roles = store.roleList.get();
		for (const ids of roles.values()) {
			assert.ok(!ids.includes('emit-result'), 'emit-result must not appear in role_list');
		}
	});

	test('initialize is idempotent and does not clobber evolved skills', async () => {
		const store = await createStore();
		const evolved = `---\nid: behavioral-delta\nroles: [code-review]\nversion: 7\n---\nEvolved behavior.`;
		await store.writeSkill('behavioral-delta', evolved);

		// Re-initialize (simulating a restart): the evolved v7 must survive.
		await store.initialize();
		const skill = await store.getSkill('behavioral-delta');
		assert.strictEqual(skill!.frontmatter.version, 7);
		assert.ok(skill!.body.includes('Evolved behavior'));
	});

	test('writeSkill archives the prior version and enables rollback', async () => {
		const store = await createStore();
		const v2 = `---\nid: behavioral-delta\nroles: [code-review]\nversion: 2\n---\nVersion two body.`;
		await store.writeSkill('behavioral-delta', v2);

		const history = await store.getSkillHistory('behavioral-delta');
		assert.ok(history.some(h => h.version === 1), 'v1 should be archived');

		await store.rollbackSkill('behavioral-delta', 1);
		const rolled = await store.getSkill('behavioral-delta');
		assert.strictEqual(rolled!.frontmatter.version, 1);
	});

	test('framework skill is immutable', async () => {
		const store = await createStore();
		await assert.rejects(() => store.writeSkill('emit-result', '---\nid: emit-result\nversion: 2\n---\nhacked'));
	});

	test('writing a new skill adds it to role_list', async () => {
		const store = await createStore();
		await store.writeSkill('group-by-customer', `---\nid: group-by-customer\nroles: [issue-triage]\nversion: 1\n---\nGroup by customer.`);
		const roles = await store.regenerateRoleList();
		assert.deepStrictEqual(roles.get('issue-triage')!.slice().sort(), ['group-by-customer', 'group-issues-by-theme']);
	});

	test('mountRoles composes role skills plus the framework contract from disk', async () => {
		const store = await createStore();
		const result = await store.mountRoles(['code-review']);
		assert.ok(result.skillIds.includes('behavioral-delta'));
		assert.ok(result.skillIds.includes('emit-result'));
		assert.ok(!result.skillIds.includes('coordinator-routing'), 'coordinator skills are not mounted onto workers');
	});

	test('wiki log, patterns, index, and skill-impact round-trip', async () => {
		const store = await createStore();
		await store.appendWikiLog('learned: group by customer, not file');

		await store.upsertWikiPattern('group-by-customer', `---\nid: group-by-customer\ntags: [issue-triage]\n---\nPrefer customer grouping.`);
		const patterns = await store.listWikiPatterns();
		assert.strictEqual(patterns.length, 1);
		assert.strictEqual(patterns[0].slug, 'group-by-customer');

		await store.writeWikiIndex('# index\n- group-by-customer');
		assert.ok((await store.readWikiIndex()).includes('group-by-customer'));

		await store.writeSkillImpact('behavioral-delta | 12 | 10 | 1 | 1 | 0.8');
		assert.ok((await store.readSkillImpact()).includes('behavioral-delta'));
	});

	test('mountRoles includes wiki patterns tagged for the role', async () => {
		const store = await createStore();
		await store.upsertWikiPattern('group-by-customer', `---\nid: group-by-customer\nroles: [issue-triage]\n---\nPrefer customer grouping.`);
		const result = await store.mountRoles(['issue-triage']);
		assert.ok(result.patternIds.includes('group-by-customer'));
		assert.ok(result.personaText.includes('Prefer customer grouping'));
	});

	test('experience records are written and listed', async () => {
		const store = await createStore();
		await store.writeExperience('session-abc', { gesture: 'accept', outcome: 'merged' });
		const ids = await store.listExperienceIds();
		assert.deepStrictEqual(ids, ['session-abc']);
		const record = await store.readExperience('session-abc') as { gesture: string };
		assert.strictEqual(record.gesture, 'accept');
	});
});
