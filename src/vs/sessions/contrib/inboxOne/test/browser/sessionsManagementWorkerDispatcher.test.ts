/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISession } from '../../../../services/sessions/common/session.js';
import { WorkerRole } from '../../common/eventTaxonomy.js';
import { IInboxOneFileStore } from '../../common/inboxOneFileStore.js';
import { IMountResult } from '../../common/roleMount.js';
import { EventSource, ILogicalTask, LogicalTaskState } from '../../common/inboxOneTypes.js';
import { IWorkerDispatchRequest } from '../../common/workerDispatcher.js';
import { WORKER_OPERATING_ENVELOPE } from '../../common/workerBrief.js';
import { ILaunchOptions, IInboxOneSessionLauncher } from '../../browser/inboxOneSessionLauncher.js';
import { INBOX_ONE_SESSION_META, SessionsManagementWorkerDispatcher } from '../../browser/sessionsManagementWorkerDispatcher.js';

function fakeSession(ref: string): ISession {
	return { resource: URI.parse(ref), mainChat: constObservable({} as never) } as unknown as ISession;
}

/** Central launcher stand-in: records launches/relays so the test asserts what the dispatcher routes through it. */
class FakeLauncher {
	readonly launched: Array<{ firstMessage: string; options: ILaunchOptions }> = [];
	readonly relayed: Array<{ sessionRef: string; message: string }> = [];
	launchResult: ISession | undefined;
	relayResult = false;
	canLaunch(): boolean { return this.launchResult !== undefined; }
	async launch(firstMessage: string, options: ILaunchOptions): Promise<ISession | undefined> {
		this.launched.push({ firstMessage, options });
		return this.launchResult;
	}
	async relay(sessionRef: string, message: string): Promise<boolean> {
		this.relayed.push({ sessionRef, message });
		return this.relayResult;
	}
	asService(): IInboxOneSessionLauncher { return this as unknown as IInboxOneSessionLauncher; }
}

/** Fake file store whose `mountRoles` returns a recognizable persona so the test can assert the harness mounts it. */
class FakeFileStore {
	readonly mountedRoles: string[][] = [];
	persona = '## skill: review-consequence\nReview consequence, not formatting.';
	failMount = false;
	async mountRoles(roleNames: readonly string[]): Promise<IMountResult> {
		this.mountedRoles.push([...roleNames]);
		if (this.failMount) {
			throw new Error('file store unavailable');
		}
		return { personaText: this.persona, skillIds: ['review-consequence', 'emit-result'], patternIds: [] };
	}
	asService(): IInboxOneFileStore { return this as unknown as IInboxOneFileStore; }
}

function task(): ILogicalTask {
	return {
		id: 'task-1', inboxId: 'my', groupKey: 'acme/api:pr:842', type: 'code-review', state: LogicalTaskState.Cooking,
		sourceEvent: { deliveryId: 'd', source: EventSource.World, type: 'pull_request', subject: { kind: 'pr', id: '842' }, receivedAt: 0 },
		attempts: [], currentAttempt: 0, route: 'r', createdAt: 0, updatedAt: 0,
	};
}

function request(overrides: Partial<IWorkerDispatchRequest> = {}): IWorkerDispatchRequest {
	return { task: task(), attemptIndex: 0, role: WorkerRole.CodeReview, groupKey: 'acme/api:pr:842', brief: 'Review PR #842. Emit a decision-ready result.', ...overrides };
}

suite('Inbox One - SessionsManagementWorkerDispatcher', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function make(launcher: FakeLauncher, fileStore: FakeFileStore = new FakeFileStore()) {
		return new SessionsManagementWorkerDispatcher(launcher.asService(), fileStore.asService(), disposables.add(new NullLogService()));
	}

	test('routes the composed first message + metadata through the central launcher', async () => {
		const launcher = new FakeLauncher();
		launcher.launchResult = fakeSession('agent-host-session://acme/worker-1');
		const fileStore = new FakeFileStore();
		const dispatcher = make(launcher, fileStore);

		const result = await dispatcher.dispatch(request());

		assert.strictEqual(result.reused, false);
		assert.strictEqual(result.sessionRef, 'agent-host-session://acme/worker-1');
		assert.strictEqual(launcher.launched.length, 1);
		// The harness composes the first message from the operating envelope, the
		// mounted skills persona (mountRoles for the role), and the brief.
		const message = launcher.launched[0].firstMessage;
		assert.ok(message.includes(WORKER_OPERATING_ENVELOPE), 'includes the operating envelope');
		assert.ok(message.includes('Review consequence, not formatting.'), 'includes the mounted role persona');
		assert.ok(message.includes('Review PR #842. Emit a decision-ready result.'), 'includes the task brief');
		assert.deepStrictEqual(fileStore.mountedRoles, [[WorkerRole.CodeReview]], 'mounts skills for the dispatched role');
		// Task-routing metadata so lifecycle events resolve back (G15).
		assert.strictEqual(launcher.launched[0].options.metadata![INBOX_ONE_SESSION_META.role], WorkerRole.CodeReview);
		assert.strictEqual(launcher.launched[0].options.metadata![INBOX_ONE_SESSION_META.taskId], 'task-1');
	});

	test('degrades to a persona-less first message when the file store fails', async () => {
		const launcher = new FakeLauncher();
		launcher.launchResult = fakeSession('agent-host-session://acme/worker-1');
		const fileStore = new FakeFileStore();
		fileStore.failMount = true;
		const dispatcher = make(launcher, fileStore);

		await dispatcher.dispatch(request());

		const message = launcher.launched[0].firstMessage;
		assert.ok(message.includes(WORKER_OPERATING_ENVELOPE), 'still includes the operating envelope');
		assert.ok(message.includes('Review PR #842. Emit a decision-ready result.'), 'the self-contained brief still stands');
		assert.ok(!message.includes('Review consequence, not formatting.'), 'no persona when mounting fails');
	});

	test('defers gracefully when the launcher has no session target', async () => {
		const launcher = new FakeLauncher(); // launchResult undefined -> no target
		const dispatcher = make(launcher);

		const result = await dispatcher.dispatch(request());

		assert.strictEqual(launcher.launched.length, 1, 'the launch was attempted');
		assert.ok(result.sessionRef.startsWith('inboxone-pending://'), 'returns a pending ref so the loop continues');
		assert.strictEqual(result.deferred, true, 'marks the dispatch deferred so admission is released');
		assert.strictEqual(result.reused, false);
	});

	test('reuses a warm session by relaying the new brief through the launcher', async () => {
		const launcher = new FakeLauncher();
		launcher.relayResult = true;
		const ref = 'agent-host-session://acme/worker-1';
		const dispatcher = make(launcher);

		const result = await dispatcher.dispatch(request({ reuseSessionRef: ref, brief: 'Also address the flaky test.' }));

		assert.strictEqual(result.reused, true);
		assert.strictEqual(result.sessionRef, ref);
		assert.strictEqual(launcher.launched.length, 0, 'reuse does not launch a new session');
		assert.deepStrictEqual(launcher.relayed, [{ sessionRef: ref, message: 'Also address the flaky test.' }]);
	});

	test('falls back to a fresh launch when the warm session relay fails', async () => {
		const launcher = new FakeLauncher();
		launcher.relayResult = false; // warm session gone
		launcher.launchResult = fakeSession('agent-host-session://acme/worker-2');
		const dispatcher = make(launcher);

		const result = await dispatcher.dispatch(request({ reuseSessionRef: 'agent-host-session://acme/missing' }));

		assert.strictEqual(result.reused, false);
		assert.strictEqual(result.sessionRef, 'agent-host-session://acme/worker-2');
		assert.strictEqual(launcher.launched.length, 1);
	});

	test('relay delegates to the launcher', async () => {
		const launcher = new FakeLauncher();
		launcher.relayResult = true;
		const dispatcher = make(launcher);

		await dispatcher.relay('agent-host-session://acme/worker-1', 'Please also update the changelog.');

		assert.deepStrictEqual(launcher.relayed, [{ sessionRef: 'agent-host-session://acme/worker-1', message: 'Please also update the changelog.' }]);
	});
});
