/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { WorkerRole } from '../../common/eventTaxonomy.js';
import { EventSource, ILogicalTask, LogicalTaskState } from '../../common/inboxOneTypes.js';
import { IWorkerDispatchRequest } from '../../common/workerDispatcher.js';
import { INBOX_ONE_SESSION_META, SessionsManagementWorkerDispatcher } from '../../browser/sessionsManagementWorkerDispatcher.js';

function fakeSession(ref: string): ISession {
	return { resource: URI.parse(ref), mainChat: constObservable({} as never) } as unknown as ISession;
}

interface IRecordedCreate {
	folder: URI;
	query: string;
	title?: string;
	metadata?: Record<string, unknown>;
}

class FakeSessions {
	targetAvailable = true;
	created: IRecordedCreate[] = [];
	relayed: Array<{ ref: string; query: string }> = [];
	sessionsByRef = new Map<string, ISession>();
	createResult: ISession | undefined;

	isNewSessionTargetAvailable(): boolean { return this.targetAvailable; }
	async createAndSendNewChatRequest(folder: URI, options: { query: string; title?: string }, createOptions?: { metadata?: Record<string, unknown> }): Promise<ISession | undefined> {
		this.created.push({ folder, query: options.query, title: options.title, metadata: createOptions?.metadata });
		return this.createResult;
	}
	getSession(uri: URI): ISession | undefined { return this.sessionsByRef.get(uri.toString()); }
	async sendRequest(session: ISession, _chat: unknown, options: { query: string }): Promise<void> {
		this.relayed.push({ ref: session.resource.toString(), query: options.query });
	}
	asService(): ISessionsManagementService { return this as unknown as ISessionsManagementService; }
}

function fakeWorkspace(folder: URI | undefined): IWorkspaceContextService {
	return { getWorkspace: () => ({ folders: folder ? [{ uri: folder }] : [] }) } as unknown as IWorkspaceContextService;
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

	function make(sessions: FakeSessions, folder: URI | undefined) {
		return new SessionsManagementWorkerDispatcher(sessions.asService(), fakeWorkspace(folder), disposables.add(new NullLogService()));
	}

	test('creates a real worker session and returns its resource ref', async () => {
		const sessions = new FakeSessions();
		sessions.createResult = fakeSession('agent-host-session://acme/worker-1');
		const dispatcher = make(sessions, URI.file('/repo'));

		const result = await dispatcher.dispatch(request());

		assert.strictEqual(result.reused, false);
		assert.strictEqual(result.sessionRef, 'agent-host-session://acme/worker-1');
		assert.strictEqual(sessions.created.length, 1);
		assert.strictEqual(sessions.created[0].query, 'Review PR #842. Emit a decision-ready result.');
		// Metadata stamps the task/role so lifecycle events resolve back (G15).
		assert.strictEqual(sessions.created[0].metadata![INBOX_ONE_SESSION_META.role], WorkerRole.CodeReview);
		assert.strictEqual(sessions.created[0].metadata![INBOX_ONE_SESSION_META.taskId], 'task-1');
	});

	test('defers gracefully when no session target is available (no host)', async () => {
		const sessions = new FakeSessions();
		sessions.targetAvailable = false;
		const dispatcher = make(sessions, URI.file('/repo'));

		const result = await dispatcher.dispatch(request());

		assert.strictEqual(sessions.created.length, 0, 'no session is created without a host');
		assert.ok(result.sessionRef.startsWith('inboxone-pending://'), 'returns a pending ref so the loop continues');
		assert.strictEqual(result.reused, false);
	});

	test('defers when there is no workspace folder', async () => {
		const sessions = new FakeSessions();
		const dispatcher = make(sessions, undefined);
		const result = await dispatcher.dispatch(request());
		assert.strictEqual(sessions.created.length, 0);
		assert.ok(result.sessionRef.startsWith('inboxone-pending://'));
	});

	test('reuses a warm session by relaying the new brief', async () => {
		const sessions = new FakeSessions();
		const ref = 'agent-host-session://acme/worker-1';
		sessions.sessionsByRef.set(ref, fakeSession(ref));
		const dispatcher = make(sessions, URI.file('/repo'));

		const result = await dispatcher.dispatch(request({ reuseSessionRef: ref, brief: 'Also address the flaky test.' }));

		assert.strictEqual(result.reused, true);
		assert.strictEqual(result.sessionRef, ref);
		assert.strictEqual(sessions.created.length, 0, 'reuse does not create a new session');
		assert.deepStrictEqual(sessions.relayed, [{ ref, query: 'Also address the flaky test.' }]);
	});

	test('falls back to a fresh session when the warm session is gone', async () => {
		const sessions = new FakeSessions();
		sessions.createResult = fakeSession('agent-host-session://acme/worker-2');
		const dispatcher = make(sessions, URI.file('/repo'));

		const result = await dispatcher.dispatch(request({ reuseSessionRef: 'agent-host-session://acme/missing' }));

		assert.strictEqual(result.reused, false);
		assert.strictEqual(result.sessionRef, 'agent-host-session://acme/worker-2');
		assert.strictEqual(sessions.created.length, 1);
	});

	test('relay sends a request into the existing session', async () => {
		const sessions = new FakeSessions();
		const ref = 'agent-host-session://acme/worker-1';
		sessions.sessionsByRef.set(ref, fakeSession(ref));
		const dispatcher = make(sessions, URI.file('/repo'));

		await dispatcher.relay(ref, 'Please also update the changelog.');

		assert.deepStrictEqual(sessions.relayed, [{ ref, query: 'Please also update the changelog.' }]);
	});

	test('relay to a pending ref is a safe no-op', async () => {
		const sessions = new FakeSessions();
		const dispatcher = make(sessions, URI.file('/repo'));
		await dispatcher.relay('inboxone-pending://worker/abc', 'hi');
		assert.strictEqual(sessions.relayed.length, 0);
	});
});
