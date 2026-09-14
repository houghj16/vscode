/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildDistillerBrief, DISTILLER_SKILL_FENCE, parseProposedSkill, simulateDistillerProposal } from '../../common/distillerBrief.js';
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

	suite('simulateDistillerProposal (dev headless learning)', () => {
		const current = '---\nid: review-consequence\nroles: [code-review]\nversion: 1\n---\n# Review consequence\nReview consequence, not formatting.';

		test('folds a steer lesson into the skill and stays a valid SKILL.md', () => {
			const proposed = simulateDistillerProposal(record({ steeringTranscript: 'Prefer squash merges. Keep history linear.' }), LearningTarget.RoleSkillLesson, current);
			assert.ok(proposed, 'a steer proposes an update');
			assert.ok(proposed!.startsWith('---'), 'keeps frontmatter so writeSkill/parseProposedSkill accept it');
			assert.ok(parseProposedSkill('```' + DISTILLER_SKILL_FENCE + '\n' + proposed + '\n```') === proposed, 'round-trips through the proposal parser');
			assert.ok(proposed!.includes('## Learned'));
			assert.ok(proposed!.includes('Prefer squash merges.'), 'includes the steering signal');
		});

		test('reinforces on accept, and is idempotent for the same lesson', () => {
			const once = simulateDistillerProposal(record({ gesture: GestureKind.Accept }), LearningTarget.ReinforceRoleSkill, current);
			assert.ok(once && once.includes('keep leading with the approach that worked'));
			// Feeding the already-updated skill back in must not append the same lesson again.
			assert.strictEqual(simulateDistillerProposal(record({ gesture: GestureKind.Accept }), LearningTarget.ReinforceRoleSkill, once), undefined);
		});

		test('proposes nothing for a coordinator-skill target or when there is no skill', () => {
			assert.strictEqual(simulateDistillerProposal(record(), LearningTarget.CoordinatorSkill, current), undefined);
			assert.strictEqual(simulateDistillerProposal(record(), LearningTarget.RoleSkillLesson, undefined), undefined);
			assert.strictEqual(simulateDistillerProposal(record(), LearningTarget.RoleSkillLesson, 'not a skill'), undefined);
		});
	});
});
