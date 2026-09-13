/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { SessionStatus } from '../../../../services/sessions/common/session.js';
import { IEventIngress, IEventTransport } from '../../common/eventIngress.js';
import { IIngressEvent } from '../../common/inboxOneTypes.js';
import { SessionEventType } from '../../common/sessionEventMapping.js';
import { IWorkerSessionSnapshot, IWorkerSessionSource, SessionEventAdapter } from '../../browser/sessionEventAdapter.js';

class FakeIngress implements IEventIngress {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidReceiveEvent = new Emitter<IIngressEvent>();
	readonly onDidReceiveEvent = this._onDidReceiveEvent.event;
	readonly submitted: IIngressEvent[] = [];
	async submit(event: IIngressEvent): Promise<boolean> { this.submitted.push(event); return true; }
	registerTransport(_t: IEventTransport): IDisposable { return { dispose() { } }; }
}

class FakeSource implements IWorkerSessionSource {
	private snapshots: IWorkerSessionSnapshot[] = [];
	private readonly emitter = new Emitter<void>();
	current(): readonly IWorkerSessionSnapshot[] { return this.snapshots; }
	onDidChange(listener: () => void): IDisposable { return this.emitter.event(listener); }
	set(snapshots: IWorkerSessionSnapshot[]): void { this.snapshots = snapshots; this.emitter.fire(); }
	dispose(): void { this.emitter.dispose(); }
}

suite('Inbox One - session event adapter', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const store = disposables.add(new DisposableStore());
		const source = new FakeSource();
		store.add({ dispose: () => source.dispose() });
		const ingress = new FakeIngress();
		const adapter = store.add(new SessionEventAdapter(source, ingress, new NullLogService()));
		return { source, ingress, adapter, store };
	}

	test('emits task_finished when a worker completes', () => {
		const { source, ingress, store } = setup();
		source.set([{ sessionRef: 'ref/a', status: SessionStatus.InProgress }]);
		source.set([{ sessionRef: 'ref/a', status: SessionStatus.Completed }]);
		const finished = ingress.submitted.filter(e => e.type === SessionEventType.TaskFinished);
		assert.strictEqual(finished.length, 1);
		assert.strictEqual(finished[0].sessionId, 'ref/a');
		store.dispose();
	});

	test('emits needs_input and failed on their transitions', () => {
		const { source, ingress, store } = setup();
		source.set([{ sessionRef: 'ref/a', status: SessionStatus.NeedsInput }]);
		source.set([{ sessionRef: 'ref/b', status: SessionStatus.Error }]);
		assert.ok(ingress.submitted.some(e => e.type === SessionEventType.NeedsInput && e.sessionId === 'ref/a'));
		assert.ok(ingress.submitted.some(e => e.type === SessionEventType.Failed && e.sessionId === 'ref/b'));
		store.dispose();
	});

	test('does not re-emit for an unchanged status (dedupe)', () => {
		const { source, ingress, store } = setup();
		source.set([{ sessionRef: 'ref/a', status: SessionStatus.Completed }]);
		source.set([{ sessionRef: 'ref/a', status: SessionStatus.Completed }]);
		source.set([{ sessionRef: 'ref/a', status: SessionStatus.Completed }]);
		assert.strictEqual(ingress.submitted.filter(e => e.type === SessionEventType.TaskFinished).length, 1);
		store.dispose();
	});

	test('re-emits when a session cycles back to work then finishes again', () => {
		const { source, ingress, store } = setup();
		source.set([{ sessionRef: 'ref/a', status: SessionStatus.Completed }]);
		source.set([{ sessionRef: 'ref/a', status: SessionStatus.InProgress }]);
		source.set([{ sessionRef: 'ref/a', status: SessionStatus.Completed }]);
		assert.strictEqual(ingress.submitted.filter(e => e.type === SessionEventType.TaskFinished).length, 2);
		store.dispose();
	});

	test('all emitted events are session-sourced', () => {
		const { source, ingress, store } = setup();
		source.set([{ sessionRef: 'ref/a', status: SessionStatus.NeedsInput }]);
		assert.ok(ingress.submitted.every(e => e.source === 'session'));
		store.dispose();
	});
});
