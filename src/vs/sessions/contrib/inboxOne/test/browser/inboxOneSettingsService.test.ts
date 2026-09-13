/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAutomationStorageCompareAndSwapResult, IAutomationStorageService } from '../../../automations/common/automationStorageService.js';
import { InboxOneSettingsService } from '../../browser/inboxOneSettingsService.js';
import { AutonomyLevel } from '../../common/inboxOneSettings.js';
import { TriggerFamily } from '../../common/eventTaxonomy.js';

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

suite('Inbox One - settings service', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(storage = new InMemoryCasStorage()): { service: InboxOneSettingsService; storage: InMemoryCasStorage } {
		const service = disposables.add(new InboxOneSettingsService(storage));
		return { service, storage };
	}

	test('defaults: nothing enrolled, safe-reversible autonomy', async () => {
		const { service } = createService();
		await service.initialize();
		assert.strictEqual(service.listEnrollments().length, 0);
		assert.strictEqual(service.getDefaultAutonomy(), AutonomyLevel.SafeReversible);
		assert.strictEqual(service.isRepoEnrolled('acme/api'), false);
	});

	test('enroll makes a repo active and its triggers enabled by default', async () => {
		const { service } = createService();
		await service.enrollRepo({ repo: 'acme/api', active: true });
		assert.strictEqual(service.isRepoEnrolled('acme/api'), true);
		assert.strictEqual(service.isTriggerEnabled('acme/api', TriggerFamily.PullRequests), true);
		assert.strictEqual(service.isTriggerEnabled('acme/api', TriggerFamily.Security), true);
	});

	test('a paused repo is not enrolled', async () => {
		const { service } = createService();
		await service.enrollRepo({ repo: 'acme/api', active: false });
		assert.strictEqual(service.isRepoEnrolled('acme/api'), false);
		assert.strictEqual(service.isTriggerEnabled('acme/api', TriggerFamily.PullRequests), false);
	});

	test('restricting enabled families disables the others', async () => {
		const { service } = createService();
		await service.enrollRepo({ repo: 'acme/api', active: true, enabledFamilies: [TriggerFamily.Issues] });
		assert.strictEqual(service.isTriggerEnabled('acme/api', TriggerFamily.Issues), true);
		assert.strictEqual(service.isTriggerEnabled('acme/api', TriggerFamily.PullRequests), false);
	});

	test('per-repo budget overrides merge over defaults', async () => {
		const { service } = createService();
		await service.enrollRepo({ repo: 'acme/api', active: true, budgets: { repoConcurrency: 8 } });
		const caps = service.getBudgetCaps('acme/api');
		assert.strictEqual(caps.repoConcurrency, 8);
		assert.strictEqual(caps.globalConcurrency, service.getDefaultBudgets().globalConcurrency);
	});

	test('per-repo autonomy overrides the default', async () => {
		const { service } = createService();
		await service.enrollRepo({ repo: 'acme/api', active: true, autonomy: AutonomyLevel.Nothing });
		assert.strictEqual(service.getAutonomy('acme/api'), AutonomyLevel.Nothing);
		assert.strictEqual(service.getAutonomy('other/repo'), service.getDefaultAutonomy());
	});

	test('updateEnrollment patches without losing repo identity', async () => {
		const { service } = createService();
		await service.enrollRepo({ repo: 'acme/api', active: true });
		await service.updateEnrollment('acme/api', { active: false });
		assert.strictEqual(service.getEnrollment('acme/api')!.active, false);
	});

	test('removeEnrollment stops watching the repo', async () => {
		const { service } = createService();
		await service.enrollRepo({ repo: 'acme/api', active: true });
		await service.removeEnrollment('acme/api');
		assert.strictEqual(service.getEnrollment('acme/api'), undefined);
	});

	test('notification preferences round-trip', async () => {
		const { service } = createService();
		await service.setNotificationPreferences({ pushCritical: true, pushUrgent: false, pushFyi: true });
		const prefs = service.getNotificationPreferences();
		assert.strictEqual(prefs.pushUrgent, false);
		assert.strictEqual(prefs.pushFyi, true);
	});

	test('onDidChange fires on mutation', async () => {
		const { service } = createService();
		const store = disposables.add(new DisposableStore());
		let fired = 0;
		store.add(service.onDidChange(() => fired++));
		await service.enrollRepo({ repo: 'acme/api', active: true });
		assert.strictEqual(fired, 1);
	});

	test('settings persist across a fresh service instance', async () => {
		const storage = new InMemoryCasStorage();
		const first = disposables.add(new InboxOneSettingsService(storage));
		await first.enrollRepo({ repo: 'acme/api', active: true, autonomy: AutonomyLevel.PlusMedium });

		const second = disposables.add(new InboxOneSettingsService(storage));
		await second.initialize();
		assert.strictEqual(second.isRepoEnrolled('acme/api'), true);
		assert.strictEqual(second.getAutonomy('acme/api'), AutonomyLevel.PlusMedium);
	});
});
