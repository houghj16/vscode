/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { WorkerRole } from '../../common/eventTaxonomy.js';
import { EventSource, ILogicalTask, LogicalTaskState } from '../../common/inboxOneTypes.js';
import { buildWorkerBrief, composeWorkerFirstMessage, WORKER_OPERATING_ENVELOPE } from '../../common/workerBrief.js';

function task(overrides: Partial<ILogicalTask> = {}): ILogicalTask {
	return {
		id: 'task-1', inboxId: 'my', groupKey: 'acme/api:pr:842', type: 'code-review', state: LogicalTaskState.Cooking,
		sourceEvent: { deliveryId: 'd', source: EventSource.World, repo: 'acme/api', type: 'pull_request', action: 'opened', subject: { kind: 'pr', id: '842' }, receivedAt: 0 },
		attempts: [], currentAttempt: 0, route: 'r', createdAt: 0, updatedAt: 0, repo: 'acme/api',
		...overrides,
	};
}

suite('Inbox One - workerBrief', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('brief is self-contained: names repo, subject, trigger, objective, and emit-result', () => {
		const brief = buildWorkerBrief(WorkerRole.CodeReview, task());
		assert.ok(brief.includes('acme/api'), 'names the repository');
		assert.ok(brief.includes('pull request #842'), 'names the subject');
		assert.ok(brief.includes('pull_request.opened'), 'names the trigger');
		assert.ok(/## Objective/.test(brief), 'has an objective section');
		assert.ok(/## Evidence and acceptance/.test(brief), 'has an evidence section');
		assert.ok(brief.includes('inbox-one-result'), 'ends with the emit-result standing instruction');
	});

	test('each role gets a distinct objective and constraints', () => {
		const review = buildWorkerBrief(WorkerRole.CodeReview, task());
		const triage = buildWorkerBrief(WorkerRole.IssueTriage, task({
			type: 'issue-triage',
			sourceEvent: { deliveryId: 'd', source: EventSource.World, repo: 'acme/api', type: 'issues', action: 'opened', subject: { kind: 'issue', id: '7' }, receivedAt: 0 },
		}));
		const fix = buildWorkerBrief(WorkerRole.ImplementFix, task({
			type: 'implement-fix',
			sourceEvent: { deliveryId: 'd', source: EventSource.World, repo: 'acme/api', type: 'check_run', action: 'failed', subject: { kind: 'check', id: 'run-9', attachedTo: { kind: 'pr', id: '842' } }, receivedAt: 0 },
		}));

		assert.ok(review.includes('safe to approve'), 'review objective');
		assert.ok(triage.includes('cluster'), 'triage objective');
		assert.ok(fix.includes('Reproduce the failure'), 'fix objective');
		// Role-faithful subject rendering.
		assert.ok(triage.includes('issue #7'));
		assert.ok(fix.includes('attached to pr #842'));
		assert.notStrictEqual(review, triage);
		assert.notStrictEqual(triage, fix);
	});

	test('brief tolerates a missing repo', () => {
		const brief = buildWorkerBrief(WorkerRole.CodeReview, task({ repo: undefined }));
		assert.ok(brief.includes('the target repository'));
	});

	test('composeWorkerFirstMessage layers envelope, persona, and brief in order', () => {
		const message = composeWorkerFirstMessage('## skill: review\nReview consequence.', 'BRIEF-BODY');
		const envIdx = message.indexOf(WORKER_OPERATING_ENVELOPE);
		const personaIdx = message.indexOf('Review consequence.');
		const briefIdx = message.indexOf('BRIEF-BODY');
		assert.ok(envIdx === 0, 'envelope first');
		assert.ok(personaIdx > envIdx, 'persona after envelope');
		assert.ok(briefIdx > personaIdx, 'brief after persona');
		assert.ok(message.includes('\n---\n'), 'brief is separated from the persona');
	});

	test('composeWorkerFirstMessage omits the persona when none is mounted', () => {
		const message = composeWorkerFirstMessage('   ', 'BRIEF-BODY');
		assert.ok(message.startsWith(WORKER_OPERATING_ENVELOPE));
		assert.ok(message.includes('BRIEF-BODY'));
		assert.ok(!message.includes('skill:'), 'no persona section');
	});

	test('the operating envelope forbids GitHub mutations and demands autonomy', () => {
		assert.ok(/never mutate GitHub/i.test(WORKER_OPERATING_ENVELOPE));
		assert.ok(/fully autonomously/i.test(WORKER_OPERATING_ENVELOPE));
		assert.ok(/emit-result/i.test(WORKER_OPERATING_ENVELOPE));
		assert.ok(/`gh` CLI/.test(WORKER_OPERATING_ENVELOPE), 'mandates the gh CLI for GitHub reads');
		assert.ok(/web-fetch/i.test(WORKER_OPERATING_ENVELOPE), 'forbids a web-fetch/URL tool');
	});
});
