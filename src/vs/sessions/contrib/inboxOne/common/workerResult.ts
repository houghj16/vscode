/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRawWorkerResult } from './emitResult.js';
import { ILogicalTask } from './inboxOneTypes.js';
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
