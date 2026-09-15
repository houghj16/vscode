/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildDistillerBrief, DISTILLER_SKILL_FENCE, parseProposedSkill } from '../../common/distillerBrief.js';
import { GestureKind } from '../../common/inboxOneTypes.js';
import { IExperienceRecord, LearningTarget } from '../../common/learningLoop.js';

function record(overrides: Partial<IExperienceRecord> = {}): IExperienceRecord {
	return { resolutionId: 't1:0', taskId: 't1', role: 'code-review', repo: 'acme/api', gesture: GestureKind.Steer, resolvedAt: 0, ...overrides };
}

suite('Inbox One - distiller brief', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('brief includes the resolution, target guidance, and the output contract', () => {
		const brief = buildDistillerBrief(record(), LearningTarget.RoleSkillLesson, undefined);
		assert.ok(brief.includes('gesture=steer'));
		assert.ok(brief.includes('role=code-review'));
		assert.ok(brief.toLowerCase().includes('steered'));
		assert.ok(brief.includes(DISTILLER_SKILL_FENCE));
		assert.ok(brief.includes('no existing skill'));
	});

	test('brief embeds the current skill and the steering transcript when present', () => {
		const current = '---\nid: behavioral-delta\nroles: [code-review]\n---\n# Behavioral delta\nDo X.';
		const brief = buildDistillerBrief(record({ steeringTranscript: 'Actually prefer squash merges.' }), LearningTarget.RoleSkillLesson, current);
		assert.ok(brief.includes('behavioral-delta'));
		assert.ok(brief.includes('Actually prefer squash merges.'));
	});

	test('target guidance differs per learning target', () => {
		assert.ok(buildDistillerBrief(record(), LearningTarget.ReinforceRoleSkill, undefined).toLowerCase().includes('accepted'));
		assert.ok(buildDistillerBrief(record(), LearningTarget.CoordinatorSkill, undefined).toLowerCase().includes('coordinator'));
	});

	test('parses the proposed SKILL.md from the fenced block', () => {
		const proposed = '---\nid: behavioral-delta\nroles: [code-review]\nversion: 2\n---\n# Behavioral delta\nPrefer squash merges when the branch is linear.';
		const text = `I folded the steer into the skill.\n\n\`\`\`${DISTILLER_SKILL_FENCE}\n${proposed}\n\`\`\``;
		const result = parseProposedSkill(text);
		assert.strictEqual(result, proposed);
	});

	test('takes the last block and rejects malformed/absent proposals', () => {
		const good = '---\nid: x\n---\nbody';
		assert.strictEqual(parseProposedSkill(`\`\`\`${DISTILLER_SKILL_FENCE}\n---\nid: old\n---\na\n\`\`\`\n\`\`\`${DISTILLER_SKILL_FENCE}\n${good}\n\`\`\``), good);
		assert.strictEqual(parseProposedSkill('no block, no change'), undefined);
		assert.strictEqual(parseProposedSkill(`\`\`\`${DISTILLER_SKILL_FENCE}\nnot frontmatter\n\`\`\``), undefined, 'body without frontmatter rejected');
		assert.strictEqual(parseProposedSkill(''), undefined);
	});
});
