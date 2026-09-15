/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IInboxOneNavigator = createDecorator<IInboxOneNavigator>('inboxOneNavigator');

/**
 * A tiny shared channel to focus a specific inbox item from outside the view
 * (e.g. an OS notification's "Open" affordance). The view opens via the normal
 * command; this only carries WHICH task to reveal. A reveal requested before the
 * view exists is held as pending, so the view picks it up on its first render --
 * no polling, no view-runtime coupling in the notification orchestrator.
 */
export interface IInboxOneNavigator {
	readonly _serviceBrand: undefined;

	/** Fires with a task id when something asks the inbox to open and focus that item. */
	readonly onDidRequestReveal: Event<string>;

	/** Ask the inbox to open and focus `taskId` (fires {@link onDidRequestReveal} and holds it pending). */
	reveal(taskId: string): void;

	/** Returns a reveal requested before the view could handle it, clearing it (consumed once). */
	consumePendingReveal(): string | undefined;
}

export class InboxOneNavigator extends Disposable implements IInboxOneNavigator {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidRequestReveal = this._register(new Emitter<string>());
	readonly onDidRequestReveal = this._onDidRequestReveal.event;

	private pending: string | undefined;

	reveal(taskId: string): void {
		this.pending = taskId;
		this._onDidRequestReveal.fire(taskId);
	}

	consumePendingReveal(): string | undefined {
		const taskId = this.pending;
		this.pending = undefined;
		return taskId;
	}
}
