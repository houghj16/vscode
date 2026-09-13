/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { IAutomationStorageService } from '../../automations/common/automationStorageService.js';
import { IInboxOneFileStore } from '../common/inboxOneFileStore.js';
import { applyToSkillImpact, formatSkillImpact, IExperienceRecord, ISkillImpact, LearningTarget, parseSkillImpact, routeGesture, skillScore } from '../common/learningLoop.js';
import { GestureKind } from '../common/inboxOneTypes.js';

const WATERMARK_KEY = 'inboxOne.distillerWatermark';
/** Promote candidates score at/above this; prune candidates at/below the negative. */
const PROMOTE_THRESHOLD = 0.6;
const PRUNE_THRESHOLD = -0.5;
/** Minimum uses before promote/prune is considered (avoid acting on noise). */
const MIN_USES_FOR_JUDGEMENT = 3;

export interface IDistillResult {
	/** Resolution ids consumed in this pass. */
	readonly consumed: readonly string[];
	/** Wiki log entries appended. */
	readonly wikiEntries: number;
	/** The new watermark (count of experience records consumed overall). */
	readonly watermark: number;
}

export interface ICurateResult {
	readonly promote: readonly string[];
	readonly prune: readonly string[];
}

/**
 * Deterministic learning orchestration (design 6, technical spec 2.5, 10).
 *
 * The distiller consolidates experience into the wiki FIRST, then updates the
 * skill-impact ledger, routed by gesture. It is idempotent by resolution id +
 * a persisted watermark (gotcha G6) so replays never double-process. The curator
 * computes promote/prune candidates from skill-impact scores.
 *
 * The heavy semantic work (writing lessons, proposing skill diffs) runs as a
 * stock session; THIS is the host scaffolding that keeps the loop idempotent,
 * correctly routed, and durable. The `distillOne` hook is where a session-backed
 * consolidation plugs in per record.
 */
export class LearningOrchestrator {

	constructor(
		private readonly store: IInboxOneFileStore,
		private readonly storage: IAutomationStorageService,
		private readonly logService: ILogService,
		/** Optional per-record semantic consolidation (session-backed in production). */
		private readonly distillOne?: (record: IExperienceRecord, target: LearningTarget) => Promise<void>,
	) { }

	/**
	 * Runs one distiller pass over experience records not yet consumed. Idempotent:
	 * records already behind the watermark are skipped, and the watermark advances
	 * only after each record is consolidated.
	 */
	async distill(records: readonly IExperienceRecord[]): Promise<IDistillResult> {
		const watermark = await this.readWatermark();
		const consumedSet = new Set(watermark.consumed);
		const consumed: string[] = [];
		let wikiEntries = 0;

		// Consolidate experience into the wiki FIRST (design 6.2), in order.
		for (const record of records) {
			if (consumedSet.has(record.resolutionId)) {
				continue; // idempotent: already processed (G6)
			}
			const target = routeGesture(record.gesture);
			await this.store.appendWikiLog(this.formatLogEntry(record, target));
			wikiEntries++;

			// Update the skill-impact ledger for the role skill that ran.
			if (record.role) {
				await this.updateSkillImpact(record.role, record.gesture);
			}

			if (this.distillOne) {
				await this.distillOne(record, target);
			}
			consumedSet.add(record.resolutionId);
			consumed.push(record.resolutionId);
		}

		const next = { consumed: [...consumedSet], count: watermark.count + consumed.length };
		await this.writeWatermark(next);
		this.logService.trace(`[inboxOne] distiller consumed ${consumed.length} record(s)`);
		return { consumed, wikiEntries, watermark: next.count };
	}

	/**
	 * Runs a curator pass: reads the skill-impact ledger and computes promote/prune
	 * candidates from running scores. Rewrites `index.md` as a simple catalog of
	 * current patterns. Promotion/pruning of the actual skills is applied by the
	 * caller (or a session) using these candidates.
	 */
	async curate(): Promise<ICurateResult> {
		const rows = parseSkillImpact(await this.store.readSkillImpact());
		const promote: string[] = [];
		const prune: string[] = [];
		for (const row of rows) {
			if (row.used < MIN_USES_FOR_JUDGEMENT) {
				continue;
			}
			const score = skillScore(row);
			if (score >= PROMOTE_THRESHOLD) {
				promote.push(row.skillId);
			} else if (score <= PRUNE_THRESHOLD) {
				prune.push(row.skillId);
			}
		}
		await this.rewriteIndex();
		this.logService.trace(`[inboxOne] curator promote=${promote.length} prune=${prune.length}`);
		return { promote, prune };
	}

	private async updateSkillImpact(skillId: string, gesture: GestureKind): Promise<void> {
		const rows: readonly ISkillImpact[] = parseSkillImpact(await this.store.readSkillImpact());
		const updated = applyToSkillImpact(rows, skillId, gesture);
		await this.store.writeSkillImpact(formatSkillImpact(updated));
	}

	private async rewriteIndex(): Promise<void> {
		const patterns = await this.store.listWikiPatterns();
		const lines = ['# Wiki index'];
		for (const p of patterns.slice().sort((a, b) => a.slug.localeCompare(b.slug))) {
			const oneLiner = p.body.split('\n').find(l => l.trim().length > 0) ?? '';
			lines.push(`- ${p.slug} - ${oneLiner.trim()}`);
		}
		await this.store.writeWikiIndex(lines.join('\n') + '\n');
	}

	private formatLogEntry(record: IExperienceRecord, target: LearningTarget): string {
		const parts = [
			`task=${record.taskId} gesture=${record.gesture} target=${target}`,
			record.role ? `role=${record.role}` : undefined,
			record.outcome ? `outcome: ${record.outcome}` : undefined,
			record.steeringTranscript ? `steering:\n${record.steeringTranscript.trim()}` : undefined,
		].filter(Boolean);
		return parts.join('\n');
	}

	// --- durable watermark (idempotency, G6) ---

	private async readWatermark(): Promise<{ consumed: string[]; count: number }> {
		const raw = await this.storage.read(WATERMARK_KEY);
		if (!raw) {
			return { consumed: [], count: 0 };
		}
		try {
			const parsed = JSON.parse(raw) as { consumed?: string[]; count?: number };
			return { consumed: parsed.consumed ?? [], count: parsed.count ?? 0 };
		} catch {
			return { consumed: [], count: 0 };
		}
	}

	private async writeWatermark(next: { consumed: string[]; count: number }): Promise<void> {
		const expected = await this.storage.read(WATERMARK_KEY);
		await this.storage.compareAndSwap(WATERMARK_KEY, expected, JSON.stringify(next));
	}
}
