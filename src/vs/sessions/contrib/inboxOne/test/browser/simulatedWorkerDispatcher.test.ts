/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { WorkerRole } from '../../common/eventTaxonomy.js';
import { IEventIngress } from '../../common/eventIngress.js';
import { validateWorkerResult } from '../../common/emitResult.js';
import { EventSource, ILogicalTask, LogicalTaskState } from '../../common/inboxOneTypes.js';
import { parseWorkerResult } from '../../common/parseWorkerResult.js';
import { IWorkerDispatcher, IWorkerDispatchRequest, IWorkerDispatchResult } from '../../common/workerDispatcher.js';
import { ITranscriptSource } from '../../common/workerResult.js';
import { CompositeTranscriptSource, FallbackWorkerDispatcher, isSimulatedRef, resolveDispatchWiring, simulateWorkerFinalMessage, SimulatedWorkerDispatcher, SimulatedWorkerRuntime } from '../../browser/simulatedWorkerDispatcher.js';

function task(kind: string, id: string, attachedTo?: { kind: 'pr' | 'branch'; id: string }): ILogicalTask {
	return {
		id: 'task-1', inboxId: 'my', groupKey: `acme/api:${kind}:${id}`, type: 'x', state: LogicalTaskState.Cooking,
		sourceEvent: { deliveryId: 'd', source: EventSource.World, repo: 'acme/api', type: 't', subject: { kind: kind as never, id, attachedTo }, receivedAt: 0 },
		attempts: [], currentAttempt: 0, route: 'r', createdAt: 0, updatedAt: 0, repo: 'acme/api',
	} as ILogicalTask;
}

class FakeIngress {
	readonly submitted: Array<{ type: string; sessionId?: string }> = [];
	async submit(event: { type: string; sessionId?: string }): Promise<void> { this.submitted.push({ type: event.type, sessionId: event.sessionId }); }
	asService(): IEventIngress { return this as unknown as IEventIngress; }
}

function request(role: WorkerRole, overrides: Partial<IWorkerDispatchRequest> = {}): IWorkerDispatchRequest {
	return { task: task('pr', '842'), attemptIndex: 0, role, groupKey: 'acme/api:pr:842', brief: 'b', ...overrides };
}

suite('Inbox One - simulated worker', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('every role emits a parseable, HOST-valid emit-result', () => {
		for (const role of [WorkerRole.CodeReview, WorkerRole.IssueTriage, WorkerRole.ImplementFix]) {
			const message = simulateWorkerFinalMessage(role, task('pr', '842', { kind: 'pr', id: '842' }));
			const raw = parseWorkerResult(message);
			assert.ok(raw, `role ${role} produced a parseable result`);
			const validated = validateWorkerResult(raw!);
			assert.ok(validated.ok, `role ${role} result is host-valid: ${validated.ok ? '' : validated.problems.join('; ')}`);
		}
	});

	test('a security subject yields an evidence-only decision (no one-click action)', () => {
		const message = simulateWorkerFinalMessage(WorkerRole.ImplementFix, task('security', 'CVE-1'));
		const raw = parseWorkerResult(message);
		const validated = validateWorkerResult(raw!);
		assert.ok(validated.ok);
		assert.ok(validated.ok && validated.evidence.primaryAction === undefined, 'no action proposed for an unconfirmed alert');
	});

	test('the result is derived from the task, not a fixed placeholder', () => {
		const message = simulateWorkerFinalMessage(WorkerRole.CodeReview, task('pr', '999', { kind: 'pr', id: '999' }));
		assert.ok(message.includes('#999'), 'names the actual subject');
		assert.ok(!message.includes('behavior under production load'), 'not the flagged placeholder gap');
	});

	test('runtime serves the transcript immediately and finishes after the delay', async () => {
		const ingress = new FakeIngress();
		const runtime = disposables.add(new SimulatedWorkerRuntime(ingress.asService(), new NullLogService(), 0));
		const ref = runtime.run(WorkerRole.CodeReview, task('pr', '842'));
		assert.ok(isSimulatedRef(ref));
		assert.ok(await runtime.readFinalMessage(task('pr', '842'), ref), 'transcript available before completion');
		await timeout(5);
		assert.deepStrictEqual(ingress.submitted, [{ type: 'task_finished', sessionId: ref }], 'emits a task_finished for its own ref');
	});

	test('fallback uses the simulator only when the real dispatch defers', async () => {
		const ingress = new FakeIngress();
		const runtime = disposables.add(new SimulatedWorkerRuntime(ingress.asService(), new NullLogService(), 0));
		const simulated = new SimulatedWorkerDispatcher(runtime);

		const realResults: IWorkerDispatchResult[] = [
			{ sessionRef: 'inboxone-pending://worker/x', reused: false }, // deferred -> simulate
			{ sessionRef: 'agent-host-session://real/1', reused: false }, // real host -> keep
		];
		let i = 0;
		const real: IWorkerDispatcher = {
			async dispatch(): Promise<IWorkerDispatchResult> { return realResults[i++]; },
			async relay(): Promise<void> { },
		};
		const fallback = new FallbackWorkerDispatcher(real, simulated, new NullLogService(), ref => ref.startsWith('inboxone-pending:'));

		const deferred = await fallback.dispatch(request(WorkerRole.CodeReview));
		assert.ok(isSimulatedRef(deferred.sessionRef), 'deferred real dispatch falls back to the simulator');

		const withHost = await fallback.dispatch(request(WorkerRole.CodeReview));
		assert.strictEqual(withHost.sessionRef, 'agent-host-session://real/1', 'a real host result is kept as-is');
	});

	test('composite transcript source returns the first non-undefined match', async () => {
		const a: ITranscriptSource = { async readFinalMessage() { return undefined; } };
		const b: ITranscriptSource = { async readFinalMessage() { return 'from-b'; } };
		const composite = new CompositeTranscriptSource([a, b]);
		assert.strictEqual(await composite.readFinalMessage(task('pr', '1'), 'ref'), 'from-b');
	});

	test('resolveDispatchWiring: stable never simulates; dev simulates unless turned off', () => {
		// Stable builds: always the real dispatcher with cloud fallback, never simulate.
		assert.deepStrictEqual(resolveDispatchWiring(false, true), { useSimulator: false, allowCloudFallback: true });
		assert.deepStrictEqual(resolveDispatchWiring(false, false), { useSimulator: false, allowCloudFallback: true });
		// Dev default (simulate=true): simulator on, cloud fallback off (defer -> simulate).
		assert.deepStrictEqual(resolveDispatchWiring(true, true), { useSimulator: true, allowCloudFallback: false });
		// Dev with the setting off: simulator off, cloud fallback on (drive the real host).
		assert.deepStrictEqual(resolveDispatchWiring(true, false), { useSimulator: false, allowCloudFallback: true });
	});
});
