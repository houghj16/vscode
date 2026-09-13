/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyToSkillImpact, formatSkillImpact, LearningTarget, parseSkillImpact, routeGesture, skillScore } from '../../common/learningLoop.js';
import { applyGestureToAuthority, areaKey, authorityAffinity, AuthorityMap, isOwnedArea, parseAuthority, serializeAuthority } from '../../common/authoritySignal.js';
import { GestureKind } from '../../common/inboxOneTypes.js';

suite('Inbox One - learning loop routing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('routeGesture sends Accept to reinforce the role skill', () => {
		assert.strictEqual(routeGesture(GestureKind.Accept), LearningTarget.ReinforceRoleSkill);
	});

	test('routeGesture sends Steer to a role skill lesson', () => {
		assert.strictEqual(routeGesture(GestureKind.Steer), LearningTarget.RoleSkillLesson);
	});

	test('routeGesture sends Dismiss/Rerank/Snooze to the coordinator skill', () => {
		assert.strictEqual(routeGesture(GestureKind.Dismiss), LearningTarget.CoordinatorSkill);
		assert.strictEqual(routeGesture(GestureKind.Rerank), LearningTarget.CoordinatorSkill);
		assert.strictEqual(routeGesture(GestureKind.Snooze), LearningTarget.CoordinatorSkill);
	});

	test('skillScore reflects accepts positively and dismisses negatively', () => {
		assert.strictEqual(skillScore({ skillId: 's', used: 10, accepted: 10, steered: 0, dismissed: 0 }), 1);
		assert.strictEqual(skillScore({ skillId: 's', used: 10, accepted: 0, steered: 0, dismissed: 10 }), -1);
		assert.strictEqual(skillScore({ skillId: 's', used: 0, accepted: 0, steered: 0, dismissed: 0 }), 0);
	});

	test('applyToSkillImpact tallies gestures and creates missing rows', () => {
		let rows = applyToSkillImpact([], 'behavioral-delta', GestureKind.Accept);
		rows = applyToSkillImpact(rows, 'behavioral-delta', GestureKind.Steer);
		rows = applyToSkillImpact(rows, 'behavioral-delta', GestureKind.Dismiss);
		const row = rows.find(r => r.skillId === 'behavioral-delta')!;
		assert.strictEqual(row.used, 3);
		assert.strictEqual(row.accepted, 1);
		assert.strictEqual(row.steered, 1);
		assert.strictEqual(row.dismissed, 1);
	});

	test('skill-impact table round-trips through format/parse', () => {
		const rows = applyToSkillImpact(applyToSkillImpact([], 'a', GestureKind.Accept), 'b', GestureKind.Dismiss);
		const parsed = parseSkillImpact(formatSkillImpact(rows));
		assert.strictEqual(parsed.length, 2);
		assert.deepStrictEqual(parsed.find(r => r.skillId === 'a'), { skillId: 'a', used: 1, accepted: 1, steered: 0, dismissed: 0 });
	});
});

suite('Inbox One - cross-role authority signal', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const AREA = areaKey('acme/api', 'auth');

	test('an unseen area is neutral affinity (0.5), not owned', () => {
		const map = new Map();
		assert.strictEqual(authorityAffinity(map, AREA), 0.5);
		assert.strictEqual(isOwnedArea(map, AREA), false);
	});

	test('repeated accepts/steers build ownership toward 1', () => {
		let map: AuthorityMap = new Map();
		for (let i = 0; i < 6; i++) {
			map = applyGestureToAuthority(map, AREA, i % 2 === 0 ? GestureKind.Accept : GestureKind.Steer);
		}
		assert.strictEqual(authorityAffinity(map, AREA), 1);
		assert.strictEqual(isOwnedArea(map, AREA), true);
	});

	test('an explicit "not my area" strongly reduces ownership', () => {
		let map = applyGestureToAuthority(new Map(), AREA, GestureKind.Accept);
		map = applyGestureToAuthority(map, AREA, GestureKind.Accept, true); // not my area
		assert.ok(authorityAffinity(map, AREA) < 0.5);
		assert.strictEqual(isOwnedArea(map, AREA), false);
	});

	test('dismisses erode ownership more mildly than not-my-area', () => {
		let owned: AuthorityMap = new Map();
		for (let i = 0; i < 4; i++) { owned = applyGestureToAuthority(owned, AREA, GestureKind.Accept); }
		const beforeAffinity = authorityAffinity(owned, AREA);
		const afterDismiss = applyGestureToAuthority(owned, AREA, GestureKind.Dismiss);
		assert.ok(authorityAffinity(afterDismiss, AREA) < beforeAffinity);
		assert.ok(authorityAffinity(afterDismiss, AREA) > 0.5, 'still mostly owned after one dismiss');
	});

	test('rerank/snooze are neutral for ownership', () => {
		let map = applyGestureToAuthority(new Map(), AREA, GestureKind.Accept);
		const before = authorityAffinity(map, AREA);
		map = applyGestureToAuthority(map, AREA, GestureKind.Rerank);
		map = applyGestureToAuthority(map, AREA, GestureKind.Snooze);
		assert.strictEqual(authorityAffinity(map, AREA), before);
	});

	test('authority map round-trips through serialize/parse', () => {
		let map = applyGestureToAuthority(new Map(), AREA, GestureKind.Accept);
		map = applyGestureToAuthority(map, areaKey('acme/web', 'export'), GestureKind.Dismiss);
		const parsed = parseAuthority(serializeAuthority(map));
		assert.strictEqual(authorityAffinity(parsed, AREA), 1);
		assert.deepStrictEqual(parsed.get(areaKey('acme/web', 'export')), { area: 'acme/web#export', positive: 0, negative: 1 });
	});

	test('insufficient evidence is never treated as owned', () => {
		const map = applyGestureToAuthority(new Map(), AREA, GestureKind.Accept); // only 1 signal
		assert.strictEqual(isOwnedArea(map, AREA), false);
	});
});
