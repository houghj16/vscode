/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRawWorkerResult } from './emitResult.js';
import { ILogicalTask } from './inboxOneTypes.js';
import { parseWorkerResult, deriveRankSignals } from './parseWorkerResult.js';
import { IRankSignals } from './ranking.js';

/**
 * Reads the structured result a finished worker session emitted (technical spec
 * 2.3, 7.1). The worker follows the baked-in emit-result contract and, as its
 * final step, produces the raw {@link IRawWorkerResult} (typed action + label +
 * evidence pack). Parsing that structured output from a real session transcript /
 * tool call is provider-specific, so it lives behind this seam; the coordinator
 * engine consumes {@link IWorkerOutput} without any session-runtime coupling.
 *
 * The host -- not the model -- also derives the ranking {@link IRankSignals} from
 * real world/session state (who is blocked, ownership, freshness), so the tier
 * and the plain-language rank reason are computed, never authored by the worker.
 */
export interface IWorkerOutput {
	/** The untrusted raw result the worker emitted; the host validates it. */
	readonly result: IRawWorkerResult;
	/** Host-derived ranking signals from real world/session state. */
	readonly signals: IRankSignals;
}

export interface IWorkerResultReader {
	/**
	 * Reads the emitted result for a finished worker session, or `undefined` when
	 * none is available yet or it cannot be parsed (the engine then treats the
	 * attempt as failed). Never throws for a missing result.
	 */
	read(task: ILogicalTask, sessionRef: string): Promise<IWorkerOutput | undefined>;
}

/**
 * Provides the final assistant message of a worker session (its transcript tail),
 * from which the emit-result block is parsed. Reading a real session transcript is
 * provider-specific, so it lives behind this seam; the reader logic is pure.
 */
export interface ITranscriptSource {
	readFinalMessage(task: ILogicalTask, sessionRef: string): Promise<string | undefined>;
}

/**
 * The {@link IWorkerResultReader} that turns a worker's final message into a
 * validated-upstream {@link IWorkerOutput}: it reads the transcript tail via an
 * {@link ITranscriptSource}, parses the emit-result block, and derives the
 * host-authoritative ranking signals. Pure and unit-testable; only the transcript
 * source is host-specific.
 */
export class TranscriptWorkerResultReader implements IWorkerResultReader {
	constructor(private readonly source: ITranscriptSource) { }

	async read(task: ILogicalTask, sessionRef: string): Promise<IWorkerOutput | undefined> {
		const text = await this.source.readFinalMessage(task, sessionRef);
		if (!text) {
			return undefined;
		}
		const result = parseWorkerResult(text);
		if (!result) {
			return undefined;
		}
		return { result, signals: deriveRankSignals(result, task) };
	}
}
