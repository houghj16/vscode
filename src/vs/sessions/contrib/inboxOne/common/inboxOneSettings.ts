/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IBudgetCaps } from './admissionControl.js';
import { TriggerFamily } from './eventTaxonomy.js';

export const IInboxOneSettings = createDecorator<IInboxOneSettings>('inboxOneSettings');

/** Autonomy level: what Diffy may execute without asking (design 7.3, wireframes 11). */
export const enum AutonomyLevel {
	/** Acts on its own: nothing. Everything surfaces for approval. */
	Nothing = 'nothing',
	/** Safe & reversible auto-handled; everything else surfaces. */
	SafeReversible = 'safe_reversible',
	/** Safe & reversible plus medium-risk auto-handled. */
	PlusMedium = 'plus_medium',
}

/** Per-repo enrollment + overrides (design 11). */
export interface IRepoEnrollment {
	readonly repo: string;
	readonly active: boolean;
	/** Enabled trigger families; a family absent here is disabled for this repo. */
	readonly enabledFamilies?: readonly TriggerFamily[];
	readonly budgets?: Partial<IBudgetCaps>;
	readonly autonomy?: AutonomyLevel;
}

/** Which tiers push to mobile (design 7.5). */
export interface INotificationPreferences {
	readonly pushCritical: boolean;
	readonly pushUrgent: boolean;
	readonly pushFyi: boolean;
}

/**
 * Settings for the coordinator (design 11). Surfaced as Settings > Coordinator.
 * Provides the mandate checks (enrolled repos + enabled triggers), autonomy,
 * budgets, and notification preferences the coordinator loop consults.
 */
export interface IInboxOneSettings {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	/** Loads durable settings before first use. Idempotent. */
	initialize(): Promise<void>;

	listEnrollments(): readonly IRepoEnrollment[];
	getEnrollment(repo: string): IRepoEnrollment | undefined;
	enrollRepo(enrollment: IRepoEnrollment): Promise<void>;
	updateEnrollment(repo: string, patch: Partial<IRepoEnrollment>): Promise<void>;
	removeEnrollment(repo: string): Promise<void>;

	/** Mandate check: the repo is enrolled and active. */
	isRepoEnrolled(repo: string): boolean;
	/** Mandate check: the trigger family for this event type is enabled for the repo. */
	isTriggerEnabled(repo: string, family: TriggerFamily): boolean;

	/** Effective budget caps for a repo (repo overrides merged over the defaults). */
	getBudgetCaps(repo: string | undefined): IBudgetCaps;
	getAutonomy(repo: string | undefined): AutonomyLevel;

	getNotificationPreferences(): INotificationPreferences;
	setNotificationPreferences(prefs: INotificationPreferences): Promise<void>;

	getDefaultAutonomy(): AutonomyLevel;
	setDefaultAutonomy(level: AutonomyLevel): Promise<void>;
	getDefaultBudgets(): IBudgetCaps;
	setDefaultBudgets(caps: IBudgetCaps): Promise<void>;
}
