/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ACTION_CATALOG, describeActionCatalog, isKnownActionType, Reversibility, validateAction } from '../../common/actionCatalog.js';
import { buildConfirmation } from '../../common/actionConfirmation.js';
import { ActionType } from '../../common/inboxOneTypes.js';

suite('Inbox One - action catalog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('all catalog entries are keyed by their own action type', () => {
		for (const key of Object.keys(ACTION_CATALOG) as ActionType[]) {
			assert.strictEqual(ACTION_CATALOG[key].actionType, key);
		}
	});

	test('isKnownActionType accepts catalog types and rejects others', () => {
		assert.strictEqual(isKnownActionType(ActionType.MergePr), true);
		assert.strictEqual(isKnownActionType('delete_repo'), false);
		assert.strictEqual(isKnownActionType(''), false);
	});

	test('out-of-catalog action type is rejected', () => {
		const r = validateAction('delete_repo', {});
		assert.strictEqual(r.valid, false);
		assert.ok(r.problems[0].includes('unknown action_type'));
	});

	test('merge_pr validates a well-formed payload', () => {
		const r = validateAction(ActionType.MergePr, { repo: 'acme/api', prNumber: 842, base: 'main', strategy: 'squash' });
		assert.strictEqual(r.valid, true);
		assert.strictEqual(r.problems.length, 0);
	});

	test('merge_pr rejects a bad strategy and missing fields', () => {
		const r = validateAction(ActionType.MergePr, { repo: 'acme/api', prNumber: 842, base: 'main', strategy: 'fast-forward' });
		assert.strictEqual(r.valid, false);
		assert.ok(r.problems.some(p => p.includes('strategy')));

		const r2 = validateAction(ActionType.MergePr, { repo: 'acme/api' });
		assert.strictEqual(r2.valid, false);
		assert.ok(r2.problems.length >= 2);
	});

	test('comment requires a non-empty body', () => {
		assert.strictEqual(validateAction(ActionType.Comment, { repo: 'r', targetNumber: 1, body: 'hi' }).valid, true);
		assert.strictEqual(validateAction(ActionType.Comment, { repo: 'r', targetNumber: 1, body: '' }).valid, false);
	});

	test('add_labels requires at least one label to add', () => {
		assert.strictEqual(validateAction(ActionType.AddLabels, { repo: 'r', targetNumber: 1, add: ['bug'] }).valid, true);
		assert.strictEqual(validateAction(ActionType.AddLabels, { repo: 'r', targetNumber: 1, add: [] }).valid, false);
	});

	test('create_issues requires each issue to have a title', () => {
		assert.strictEqual(validateAction(ActionType.CreateIssues, { repo: 'r', issues: [{ title: 'A' }, { title: 'B' }] }).valid, true);
		assert.strictEqual(validateAction(ActionType.CreateIssues, { repo: 'r', issues: [{ body: 'no title' }] }).valid, false);
		assert.strictEqual(validateAction(ActionType.CreateIssues, { repo: 'r', issues: [] }).valid, false);
	});

	test('deploy is the only irreversible, non-auto-handle action', () => {
		assert.strictEqual(ACTION_CATALOG[ActionType.Deploy].reversibility, Reversibility.Irreversible);
		for (const key of Object.keys(ACTION_CATALOG) as ActionType[]) {
			if (key !== ActionType.Deploy) {
				assert.strictEqual(ACTION_CATALOG[key].reversibility, Reversibility.Reversible, `${key} should be reversible`);
			}
		}
	});

	test('non-object payloads are rejected', () => {
		assert.strictEqual(validateAction(ActionType.MergePr, null).valid, false);
		assert.strictEqual(validateAction(ActionType.MergePr, 'string').valid, false);
	});

	test('describeActionCatalog lists every action and the finite value sets for the prompt', () => {
		const text = describeActionCatalog();
		for (const key of Object.keys(ACTION_CATALOG) as ActionType[]) {
			assert.ok(text.includes(key), `catalog description must mention ${key}`);
		}
		// The merge strategy is a finite value set and must be spelled out so the worker fills it correctly.
		assert.ok(text.includes('"merge" | "squash" | "rebase"'), 'lists the merge strategy enum');
		// Structured payload requirements the worker previously got wrong (add_labels).
		assert.ok(/add:\s*string\[\]/.test(text), 'lists add_labels.add as a string array');
		// The escape hatch for when no catalog action fits.
		assert.ok(text.includes('other') && text.includes('customAsk'), 'documents the other/customAsk escape hatch');
	});
});

suite('Inbox One - action confirmation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('merge_pr confirmation states the exact effect and reversibility', () => {
		const c = buildConfirmation(ActionType.MergePr, { repo: 'acme/api', prNumber: 842, base: 'main', strategy: 'squash', rerunChecks: true });
		assert.deepStrictEqual(c.effectLines, ['merge PR #842 into main (squash)', 'rerun the required checks']);
		assert.strictEqual(c.reversibility, Reversibility.Reversible);
		assert.strictEqual(c.highlight, false);
	});

	test('deploy confirmation is highlighted and honestly irreversible', () => {
		const c = buildConfirmation(ActionType.Deploy, { repo: 'acme/api', env: 'production', ref: 'abc123' });
		assert.deepStrictEqual(c.effectLines, ['deploy abc123 to production']);
		assert.strictEqual(c.reversibility, Reversibility.Irreversible);
		assert.strictEqual(c.highlight, true);
		assert.ok(c.reversibilityLine.includes('IRREVERSIBLE'));
	});

	test('approve_pr states that it does not merge', () => {
		const c = buildConfirmation(ActionType.ApprovePr, { repo: 'acme/api', prNumber: 842 });
		assert.ok(c.effectLines[0].includes('does not merge'));
	});

	test('create_issues lists each issue title', () => {
		const c = buildConfirmation(ActionType.CreateIssues, { repo: 'acme/web', issues: [{ title: 'Session expiry' }, { title: 'Export CSV' }] });
		assert.strictEqual(c.effectLines[0], 'create 2 issue(s):');
		assert.ok(c.effectLines.includes('- Session expiry'));
		assert.ok(c.effectLines.includes('- Export CSV'));
	});

	test('dispatch_fix notes it opens a child Cooking task with no repo write', () => {
		const c = buildConfirmation(ActionType.DispatchFix, { repo: 'acme/api', subject: 'flaky test on main' });
		assert.ok(c.effectLines.some(l => l.includes('child Cooking task')));
	});

	test('comment confirmation includes the full comment body', () => {
		const c = buildConfirmation(ActionType.Comment, { repo: 'r', targetNumber: 5, body: 'Please rebase.' });
		assert.ok(c.effectLines.some(l => l.includes('Please rebase.')));
	});
});
