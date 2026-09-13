/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAutomationStorageService } from '../../automations/common/automationStorageService.js';
import { DEFAULT_BUDGET_CAPS, IBudgetCaps } from '../common/admissionControl.js';
import { TriggerFamily } from '../common/eventTaxonomy.js';
import { AutonomyLevel, IInboxOneSettings, INotificationPreferences, IRepoEnrollment } from '../common/inboxOneSettings.js';

const SETTINGS_KEY = 'inboxOne.settings';

const DEFAULT_NOTIFICATIONS: INotificationPreferences = { pushCritical: true, pushUrgent: true, pushFyi: false };

interface ISettingsState {
	readonly enrollments: IRepoEnrollment[];
	readonly defaultAutonomy: AutonomyLevel;
	readonly defaultBudgets: IBudgetCaps;
	readonly notifications: INotificationPreferences;
}

const DEFAULT_STATE: ISettingsState = {
	enrollments: [],
	defaultAutonomy: AutonomyLevel.SafeReversible,
	defaultBudgets: DEFAULT_BUDGET_CAPS,
	notifications: DEFAULT_NOTIFICATIONS,
};

/**
 * CAS-storage-backed {@link IInboxOneSettings} (design 11). Holds per-repo
 * enrollments, autonomy, budgets, and notification preferences durably. Provides
 * the mandate checks (enrolled repo + enabled trigger family) and effective
 * per-repo budget/autonomy the coordinator loop consults.
 */
export class InboxOneSettingsService extends Disposable implements IInboxOneSettings {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _state: ISettingsState = DEFAULT_STATE;
	private _hydrated = false;

	constructor(
		@IAutomationStorageService private readonly storage: IAutomationStorageService,
	) {
		super();
	}

	private async hydrate(): Promise<void> {
		if (this._hydrated) {
			return;
		}
		const raw = await this.storage.read(SETTINGS_KEY);
		if (raw) {
			this._state = parseState(raw);
		}
		this._hydrated = true;
	}

	private async persist(next: ISettingsState): Promise<void> {
		const expected = await this.storage.read(SETTINGS_KEY);
		await this.storage.compareAndSwap(SETTINGS_KEY, expected, JSON.stringify(next));
		this._state = next;
		this._onDidChange.fire();
	}

	/** Loads durable settings before first use. Idempotent. */
	initialize(): Promise<void> {
		return this.hydrate();
	}

	listEnrollments(): readonly IRepoEnrollment[] {
		return this._state.enrollments;
	}

	getEnrollment(repo: string): IRepoEnrollment | undefined {
		return this._state.enrollments.find(e => e.repo === repo);
	}

	async enrollRepo(enrollment: IRepoEnrollment): Promise<void> {
		await this.hydrate();
		const enrollments = [...this._state.enrollments.filter(e => e.repo !== enrollment.repo), enrollment];
		await this.persist({ ...this._state, enrollments });
	}

	async updateEnrollment(repo: string, patch: Partial<IRepoEnrollment>): Promise<void> {
		await this.hydrate();
		const enrollments = this._state.enrollments.map(e => (e.repo === repo ? { ...e, ...patch, repo } : e));
		await this.persist({ ...this._state, enrollments });
	}

	async removeEnrollment(repo: string): Promise<void> {
		await this.hydrate();
		await this.persist({ ...this._state, enrollments: this._state.enrollments.filter(e => e.repo !== repo) });
	}

	isRepoEnrolled(repo: string): boolean {
		return this.getEnrollment(repo)?.active === true;
	}

	isTriggerEnabled(repo: string, family: TriggerFamily): boolean {
		const enrollment = this.getEnrollment(repo);
		if (!enrollment || !enrollment.active) {
			return false;
		}
		// Absent enabledFamilies means "all families enabled" for that repo.
		return !enrollment.enabledFamilies || enrollment.enabledFamilies.includes(family);
	}

	getBudgetCaps(repo: string | undefined): IBudgetCaps {
		const overrides = repo ? this.getEnrollment(repo)?.budgets : undefined;
		return { ...this._state.defaultBudgets, ...(overrides ?? {}) };
	}

	getAutonomy(repo: string | undefined): AutonomyLevel {
		return (repo ? this.getEnrollment(repo)?.autonomy : undefined) ?? this._state.defaultAutonomy;
	}

	getNotificationPreferences(): INotificationPreferences {
		return this._state.notifications;
	}

	async setNotificationPreferences(prefs: INotificationPreferences): Promise<void> {
		await this.hydrate();
		await this.persist({ ...this._state, notifications: prefs });
	}

	getDefaultAutonomy(): AutonomyLevel {
		return this._state.defaultAutonomy;
	}

	async setDefaultAutonomy(level: AutonomyLevel): Promise<void> {
		await this.hydrate();
		await this.persist({ ...this._state, defaultAutonomy: level });
	}

	getDefaultBudgets(): IBudgetCaps {
		return this._state.defaultBudgets;
	}

	async setDefaultBudgets(caps: IBudgetCaps): Promise<void> {
		await this.hydrate();
		await this.persist({ ...this._state, defaultBudgets: caps });
	}
}

function parseState(raw: string): ISettingsState {
	try {
		const parsed = JSON.parse(raw) as Partial<ISettingsState>;
		return {
			enrollments: parsed.enrollments ?? [],
			defaultAutonomy: parsed.defaultAutonomy ?? DEFAULT_STATE.defaultAutonomy,
			defaultBudgets: { ...DEFAULT_BUDGET_CAPS, ...(parsed.defaultBudgets ?? {}) },
			notifications: { ...DEFAULT_NOTIFICATIONS, ...(parsed.notifications ?? {}) },
		};
	} catch {
		return DEFAULT_STATE;
	}
}
