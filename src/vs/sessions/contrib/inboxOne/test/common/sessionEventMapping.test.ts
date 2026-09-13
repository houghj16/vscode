/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionStatus } from '../../../../services/sessions/common/session.js';
import { mapSessionStatusToEventType, NON_DISPATCHING_SESSION_EVENTS, SessionEventType, shouldEmitOnTransition } from '../../common/sessionEventMapping.js';

suite('Inbox One - session event mapping', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps each meaningful status to its event type', () => {
		assert.strictEqual(mapSessionStatusToEventType(SessionStatus.Completed), SessionEventType.TaskFinished);
		assert.strictEqual(mapSessionStatusToEventType(SessionStatus.NeedsInput), SessionEventType.NeedsInput);
		assert.strictEqual(mapSessionStatusToEventType(SessionStatus.Error), SessionEventType.Failed);
		assert.strictEqual(mapSessionStatusToEventType(SessionStatus.InProgress), SessionEventType.Progress);
	});

	test('Untitled is not an event', () => {
		assert.strictEqual(mapSessionStatusToEventType(SessionStatus.Untitled), undefined);
	});

	test('progress is the only non-dispatching session event', () => {
		assert.ok(NON_DISPATCHING_SESSION_EVENTS.has(SessionEventType.Progress));
		assert.ok(!NON_DISPATCHING_SESSION_EVENTS.has(SessionEventType.TaskFinished));
		assert.ok(!NON_DISPATCHING_SESSION_EVENTS.has(SessionEventType.NeedsInput));
		assert.ok(!NON_DISPATCHING_SESSION_EVENTS.has(SessionEventType.Failed));
	});

	test('emits on a transition into a meaningful state', () => {
		assert.strictEqual(shouldEmitOnTransition(SessionStatus.InProgress, SessionStatus.Completed), true);
		assert.strictEqual(shouldEmitOnTransition(undefined, SessionStatus.NeedsInput), true);
	});

	test('does not emit when the status is unchanged (dedupe)', () => {
		assert.strictEqual(shouldEmitOnTransition(SessionStatus.InProgress, SessionStatus.InProgress), false);
		assert.strictEqual(shouldEmitOnTransition(SessionStatus.Completed, SessionStatus.Completed), false);
	});

	test('does not emit on a transition into Untitled', () => {
		assert.strictEqual(shouldEmitOnTransition(SessionStatus.InProgress, SessionStatus.Untitled), false);
	});
});
