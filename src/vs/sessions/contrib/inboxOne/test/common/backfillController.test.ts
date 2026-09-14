/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BackfillController } from '../../common/backfillController.js';

suite('Inbox One - backfill controller', () => {

	const store = new DisposableStore();
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => store.clear());

	function make(runBackfill: () => Promise<void>): BackfillController {
		return new BackfillController(runBackfill, store.add(new NullLogService()));
	}

	test('no backfill until the receiver first connects (no periodic polling)', async () => {
		let runs = 0;
		const c = make(async () => { runs++; });
		// Never connected -> nothing runs. There is no timer that could fire.
		assert.strictEqual(runs, 0);
		assert.strictEqual(c.backfillRuns, 0);
	});

	test('first connect after startup runs exactly one backfill', async () => {
		let runs = 0;
		const c = make(async () => { runs++; });
		c.setConnected(true);
		await Promise.resolve();
		await Promise.resolve();
		assert.strictEqual(runs, 1);
		assert.strictEqual(c.backfillRuns, 1);
	});

	test('staying connected does not backfill again', async () => {
		let runs = 0;
		const c = make(async () => { runs++; });
		c.setConnected(true);
		await drain();
		c.setConnected(true); // idempotent duplicate signal
		c.setConnected(true);
		await drain();
		assert.strictEqual(runs, 1, 'webhooks-only while up: no repeated backfill');
	});

	test('each down->up recovery runs exactly one backfill', async () => {
		let runs = 0;
		const c = make(async () => { runs++; });
		c.setConnected(true); await drain();   // startup recovery
		c.setConnected(false); await drain();   // drop
		c.setConnected(true); await drain();    // recovery 1
		c.setConnected(false); await drain();
		c.setConnected(true); await drain();    // recovery 2
		assert.strictEqual(runs, 3);
		assert.strictEqual(c.backfillRuns, 3);
	});

	test('coalesces a flap during an in-flight backfill into one trailing pass', async () => {
		let runs = 0;
		let release!: () => void;
		const gate = new Promise<void>(r => { release = r; });
		const c = make(async () => { runs++; await gate; });
		c.setConnected(true);          // starts run #1 (awaits gate)
		await Promise.resolve();
		assert.strictEqual(runs, 1);
		// Flap while the first backfill is still running.
		c.setConnected(false);
		c.setConnected(true);
		c.setConnected(false);
		c.setConnected(true);
		release();
		await drain();
		// Exactly one trailing catch-up, not one per flap.
		assert.strictEqual(runs, 2);
		assert.strictEqual(c.backfillRuns, 2);
	});

	test('a failing backfill does not wedge future recoveries', async () => {
		let runs = 0;
		const c = make(async () => { runs++; if (runs === 1) { throw new Error('boom'); } });
		c.setConnected(true); await drain();     // fails
		c.setConnected(false); await drain();
		c.setConnected(true); await drain();     // recovers
		assert.strictEqual(runs, 2);
		assert.strictEqual(c.backfillRuns, 1, 'only the successful pass is counted');
	});
});

async function drain(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve();
	}
}
