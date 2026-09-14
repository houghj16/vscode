/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IInboxOneSettings } from '../common/inboxOneSettings.js';
import { IInboxOneStore } from '../common/inboxOneStore.js';
import { GroupKey, ILogicalTask, InboxOneTier, LogicalTaskState } from '../common/inboxOneTypes.js';
import { decideNotification, INotificationLedgerEntry } from '../common/notificationPolicy.js';

/**
 * Drives the human-attention push surface (design 7.5, E.5). Subscribes to the
 * live task projection and, when a decision or blocked task lands at a pushable
 * tier, fires a single OS-level notification with an "Open Inbox" affordance.
 *
 * Push decisions are governed by {@link decideNotification}: one push per
 * task-cycle keyed by group_key, and a re-notify only when a reactivation raises
 * the tier. FYI never pushes. A suppressed push is still visible in the inbox --
 * this orchestrator governs only the push, never inbox visibility.
 *
 * The ledger is per-session in-memory: after a reload the coordinator re-hydrates
 * tasks and may re-notify once for an already-open decision, which is acceptable
 * (the inbox is the source of truth; the push is a courtesy nudge).
 */
export class NotificationOrchestrator extends Disposable {

	private readonly ledger = new Map<GroupKey, INotificationLedgerEntry>();
	/** group_keys already reconciled once, so initial hydration does not push a backlog. */
	private primed = false;
	private ready = false;

	constructor(
		@IInboxOneStore private readonly store: IInboxOneStore,
		@IInboxOneSettings private readonly settings: IInboxOneSettings,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.settings.initialize().then(() => { this.ready = true; }).catch(err => this.logService.error('[inboxOne] notification settings init failed', err));

		this._register(autorun(reader => {
			const tasks = this.store.tasks.read(reader);
			this.evaluate(tasks);
		}));
	}

	private evaluate(tasks: readonly ILogicalTask[]): void {
		if (!this.ready) {
			return;
		}
		const prefs = this.settings.getNotificationPreferences();

		// First pass after hydration seeds the ledger without pushing, so restoring
		// a session does not replay a pile of notifications for decisions the user
		// has already seen. New decisions after priming push normally.
		const priming = !this.primed;
		this.primed = true;

		for (const task of tasks) {
			if (task.state !== LogicalTaskState.Decision && task.state !== LogicalTaskState.Blocked) {
				continue;
			}
			if (!task.tier) {
				continue;
			}
			const previous = this.ledger.get(task.groupKey);
			const decision = decideNotification(task.tier, task.currentAttempt, prefs, previous, task.groupKey);
			this.ledger.set(task.groupKey, decision.nextEntry);
			if (decision.push && !priming) {
				this.fire(task);
			}
		}
	}

	private fire(task: ILogicalTask): void {
		const headline = task.evidence?.decisionSentence ?? this.fallbackTitle(task);
		const severity = task.tier === InboxOneTier.Critical ? Severity.Error : Severity.Warning;
		const scope = task.repo ? localize('inboxOne.notify.scope', '{0} - {1}', task.repo, headline) : headline;

		this.notificationService.prompt(
			severity,
			scope,
			[{
				label: localize('inboxOne.notify.open', 'Open Inbox'),
				run: () => { void this.commandService.executeCommand('inboxOne.showInbox'); },
			}],
			{ sticky: task.tier === InboxOneTier.Critical },
		);
	}

	private fallbackTitle(task: ILogicalTask): string {
		const subject = task.sourceEvent.subject;
		return localize('inboxOne.notify.itemTitle', '{0} {1} ({2})', task.type, subject.kind, subject.id);
	}
}
