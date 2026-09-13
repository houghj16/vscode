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
import { IAutomationStorageCompareAndSwapResult, IAutomationStorageService } from '../../../automations/common/automationStorageService.js';
import { InboxOneFileStore } from '../../browser/inboxOneFileStore.js';
import { LearningOrchestrator } from '../../browser/learningOrchestrator.js';
import { IExperienceRecord } from '../../common/learningLoop.js';
import { GestureKind } from '../../common/inboxOneTypes.js';
import { parseSkillImpact } from '../../common/learningLoop.js';

class InMemoryCasStorage implements IAutomationStorageService {
	declare readonly _serviceBrand: undefined;
	private readonly map = new Map<string, string>();
	async read(key: string): Promise<string | undefined> { return this.map.get(key); }
	async compareAndSwap(key: string, expected: string | undefined, next: string): Promise<IAutomationStorageCompareAndSwapResult> {
		const current = this.map.get(key);
		if (current === expected) { this.map.set(key, next); return { swapped: true, currentValue: next }; }
		return { swapped: false, currentValue: current };
	}
}

const ROOT = URI.from({ scheme: Schemas.inMemory, path: '/inbox-one-learn' });

function rec(resolutionId: string, gesture: GestureKind, role = 'behavioral-delta', overrides: Partial<IExperienceRecord> = {}): IExperienceRecord {
	return { resolutionId, taskId: `task-${resolutionId}`, role, gesture, resolvedAt: 0, ...overrides };
}

suite('Inbox One - learning orchestrator', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup() {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		const store = disposables.add(new InboxOneFileStore(ROOT, fileService, new NullLogService()));
		await store.initialize();
		const storage = new InMemoryCasStorage();
		const orchestrator = new LearningOrchestrator(store, storage, new NullLogService());
		return { store, storage, orchestrator };
	}

	test('distill consolidates experience into the wiki and advances the watermark', async () => {
		const { store, orchestrator } = await setup();
		const result = await orchestrator.distill([rec('r1', GestureKind.Accept), rec('r2', GestureKind.Steer)]);
		assert.strictEqual(result.consumed.length, 2);
		assert.strictEqual(result.wikiEntries, 2);
		assert.strictEqual(result.watermark, 2);
		const impact = parseSkillImpact(await store.readSkillImpact());
		const row = impact.find(r => r.skillId === 'behavioral-delta')!;
		assert.strictEqual(row.used, 2);
		assert.strictEqual(row.accepted, 1);
		assert.strictEqual(row.steered, 1);
	});

	test('distill is idempotent by resolution id (G6)', async () => {
		const { store, orchestrator } = await setup();
		await orchestrator.distill([rec('r1', GestureKind.Accept)]);
		// Re-run with the same record plus a new one: only the new one is consumed.
		const second = await orchestrator.distill([rec('r1', GestureKind.Accept), rec('r2', GestureKind.Accept)]);
		assert.deepStrictEqual(second.consumed, ['r2']);
		const impact = parseSkillImpact(await store.readSkillImpact());
		assert.strictEqual(impact.find(r => r.skillId === 'behavioral-delta')!.used, 2); // not 3
	});

	test('the steering conversation is captured in the wiki log', async () => {
		const { store, orchestrator } = await setup();
		await orchestrator.distill([rec('r1', GestureKind.Steer, 'group-issues-by-theme', { steeringTranscript: 'group by customer, not file' })]);
		const log = await store.readWikiLog();
		assert.ok(log.includes('group by customer, not file'));
		assert.ok(log.includes('gesture=steer'));
	});

	test('a per-record distill hook runs for each new record', async () => {
		const { store, storage } = await setup();
		const seen: string[] = [];
		const orchestrator = new LearningOrchestrator(store, storage, new NullLogService(), async (record) => { seen.push(record.resolutionId); });
		await orchestrator.distill([rec('r1', GestureKind.Accept), rec('r2', GestureKind.Dismiss)]);
		assert.deepStrictEqual(seen, ['r1', 'r2']);
	});

	test('curate promotes high-scoring and prunes low-scoring skills past the min-use threshold', async () => {
		const { orchestrator } = await setup();
		// Winner: many accepts. Loser: many dismisses. Noise: below min uses.
		const records: IExperienceRecord[] = [];
		for (let i = 0; i < 5; i++) { records.push(rec(`win-${i}`, GestureKind.Accept, 'behavioral-delta')); }
		for (let i = 0; i < 5; i++) { records.push(rec(`lose-${i}`, GestureKind.Dismiss, 'flaky-test-repro')); }
		records.push(rec('noise-0', GestureKind.Accept, 'group-issues-by-theme'));
		await orchestrator.distill(records);

		const { promote, prune } = await orchestrator.curate();
		assert.ok(promote.includes('behavioral-delta'));
		assert.ok(prune.includes('flaky-test-repro'));
		assert.ok(!promote.includes('group-issues-by-theme'), 'below min uses is not judged');
	});

	test('curate rewrites the wiki index from current patterns', async () => {
		const { store, orchestrator } = await setup();
		await store.upsertWikiPattern('group-by-customer', `---\nid: group-by-customer\n---\nPrefer customer grouping over file grouping.`);
		await orchestrator.curate();
		const index = await store.readWikiIndex();
		assert.ok(index.includes('group-by-customer'));
	});

	test('the watermark persists across orchestrator instances', async () => {
		const { store, storage } = await setup();
		const first = new LearningOrchestrator(store, storage, new NullLogService());
		await first.distill([rec('r1', GestureKind.Accept)]);
		const second = new LearningOrchestrator(store, storage, new NullLogService());
		const result = await second.distill([rec('r1', GestureKind.Accept), rec('r2', GestureKind.Accept)]);
		assert.deepStrictEqual(result.consumed, ['r2']);
	});
});
