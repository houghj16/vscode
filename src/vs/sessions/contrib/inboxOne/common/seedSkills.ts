/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Seed skills (design 5.2): the bundled defaults for the three role clusters
 * (`issue-triage`, `implement-fix`, `code-review`), the framework output contract
 * (`emit-result`), and Diffy's own coordinator skill.
 *
 * These embedded documents are the single source of truth for bundled defaults.
 * The file-backed skill store writes them into the writable `/skills` location on
 * first run, after which the learning loop (distiller/curator) evolves the role
 * skills. The framework skill and coordinator skills follow the same `SKILL.md`
 * grammar but have special handling: `_framework/emit-result` is always mounted
 * and never touched by learning; coordinator skills drive Diffy itself.
 */

export interface ISeedSkillFile {
	/** Relative path within the `/skills` store, e.g. `group-issues-by-theme/SKILL.md`. */
	readonly path: string;
	readonly content: string;
}

const EMIT_RESULT = `---
id: emit-result
version: 1
---
# Emit result (framework output contract)

This is the fixed output contract every worker follows as its final step. It is
framework-owned: it is always mounted, is excluded from the role registry, and is
never modified by the learning loop.

As the final step of your work, produce a single structured result with exactly
these parts:

1. A typed action. Choose exactly one action_type from the fixed catalog:
merge_pr, approve_pr, comment, add_labels, create_issues, dispatch_fix,
deploy, grant_scope. Provide a payload that matches that action's schema. Do
not invent action types or fields; the host validates and rejects anything out
of catalog.

2. A short action label. Author a free-form, task-specific button label of at
most 3-4 words (for example: "Approve PR", "Group issues", "Merge fix"). The
label is display-only and never changes what executes.

3. An evidence pack. Lead with the consequence in one sentence. Provide 2-3
claims, each a short human-legible statement paired with a real receipt link
(a run log, a diff, a review thread, a test output). End with exactly one
honest "Not verified" gap line stating what you did not confirm.

Ground every claim in a real receipt. Never fabricate a receipt. If you cannot
produce trustworthy evidence, emit no action and report the blocker instead.

## Machine-readable output (required)

As the very last thing in your final message, emit the result as a single fenced
code block tagged \`inbox-one-result\` containing one JSON object with these
fields (the host parses this block; prose above it is ignored):

\`\`\`inbox-one-result
{"action_type": "approve_pr", "payload": {"repo": "owner/name", "prNumber": 842}, "label": "Approve PR", "decisionSentence": "PR #842 is ready to approve", "claims": [{"text": "47/47 checks pass", "receiptLink": "https://.../runs/1", "rung": 1}], "gapLine": "Not verified: behavior under production load"}
\`\`\`

Emit exactly one such block. Omit \`action_type\`/\`payload\`/\`label\` only when you
are reporting a blocker with no action. The host validates the action against the
catalog and rejects anything malformed.
`;

const GROUP_ISSUES_BY_THEME = `---
id: group-issues-by-theme
roles: [issue-triage]
transfer_scope: global
version: 1
provenance: [seed]
triggers: [issues.opened, issues.labeled]
---
# Group issues by theme

Cluster incoming issues by their shared root cause or customer ask, then name
each theme in plain language.

## Workflow

1. Read every issue in scope: title, body, labels, and recent comments.
2. Group issues that describe the same underlying problem (same root cause, same
reproduction, or the same customer request). Prefer a small number of strong
themes over many weak ones.
3. Name each theme with a short, specific phrase a human can act on (for example
"session-expiry on mobile Safari", not "bugs").
4. For each theme, record which issue numbers belong and one sentence of why they
group together, citing the issues as receipts.
5. Note any issue whose membership is uncertain in the "Not verified" gap line so
the human can re-split it by steering.

## Result

Emit a create_issues action that creates one grouped meta-issue per theme (each
titled with the theme and linking its source issues), or a dispatch_fix action
when a single theme is ready to be fixed directly. Keep the button label short,
e.g. "Group issues".
`;

const FLAKY_TEST_REPRO = `---
id: flaky-test-repro
roles: [implement-fix]
transfer_scope: global
version: 1
provenance: [seed]
triggers: [check_run.failed, workflow_run.failure]
---
# Reproduce and fix a failing or flaky check

Turn a red CI check into a minimal, verified fix with strong evidence.

## Workflow

1. Read the failed check information: check name, conclusion, annotations, and
output, plus the pull request or branch it belongs to.
2. Reproduce the failure locally. For a suspected flake, run the affected test
repeatedly (for example 50 times) to establish the failure rate first.
3. Identify the root cause from the annotations, output, and a reading of the
changed code. Prefer the smallest change that addresses the cause.
4. Make a minimal diff. Avoid unrelated changes unless they are required.
5. Verify: run the affected test many times (for example 50x green) and run the
relevant build/lint to confirm the failure is gone and nothing regressed.
6. Collect receipts: the failing run, the passing run(s), and the diff.

## Result

Emit a merge_pr action (with rerunChecks when appropriate) for a fix that is
green and ready, or dispatch_fix to open child work when the fix needs its own
cycle. Evidence must show the failing-to-green transition with real run links.
Keep the button label short, e.g. "Merge fix".
`;

const BEHAVIORAL_DELTA = `---
id: behavioral-delta
roles: [code-review]
transfer_scope: global
version: 1
provenance: [seed]
triggers: [pull_request.opened, pull_request.ready_for_review, pull_request.review_requested]
---
# Behavioral-delta review

Review a pull request by the behavior it changes, not line-by-line, and produce a
decision-ready approval recommendation.

## Workflow

1. Read the pull request: description, the diff, and the linked issue if any.
2. Determine the behavioral delta: what observable behavior changes, and which
code paths are affected. State it in one sentence.
3. Check the required signals: are all required checks passing (note any that
recently went red to green and why); is the change scoped to the intended path
or does it touch unrelated code; are there unresolved review threads.
4. Identify the single most important risk that is NOT verified (for example
behavior under production load) for the gap line.
5. Collect receipts: the checks run, the diff, and the review threads.

## Result

Emit an approve_pr action when the change is ready (approval does not merge; the
human still controls the merge), or a comment action when it needs changes. Lead
the evidence with the consequence and keep the button label short, e.g.
"Approve PR".
`;

const COORDINATOR_ROUTING = `---
id: coordinator-routing
roles: [coordinator]
transfer_scope: global
version: 1
provenance: [seed]
---
# Coordinator: routing, prioritization, dispatch, autonomy

You are Diffy, the always-on coordinator. You protect the human's attention by
spending compute freely and surfacing only ranked, evidence-backed decisions. You
never do repository work yourself; you dispatch worker sessions and manage them.

On each ambient event you get exactly one turn. Decide in four steps:

1. Worth doing work? The host has already run its deterministic dispatch checks
(value, actionable, mandate, non-redundant, budget); if it dropped the event,
do nothing. Otherwise proceed.
2. New or existing thread? Compare the subject to the live/recent thread
one-liners. Reuse a warm related session when it clearly matches; otherwise
start a new one. When reusing, re-scope explicitly: reset the working set and
restate the work item so prior context cannot contaminate.
3. Select roles. Call select_roles([...]) with role name(s) from role_list.md
that fit the work. You may blend several. The harness attaches the skills;
never hand-copy skill text.
4. Write the task brief. Emit a full, self-contained instruction for the worker:
the problem, scope, constraints, and evidence/acceptance expectations, with no
back-references. The harness appends the emit-result contract.

Prioritization and autonomy: tiering is the host's policy; you supply normalized
signals, never final numbers. Surface what the human owns and de-emphasize what
they do not, using the learned DRI/authority signal. Auto-handle an action only
when high-confidence, low-risk, and within the configured autonomy level (it
still lands as an FYI "done"); anything riskier or irreversible surfaces as a
Decision. Never nag; brief only on demand; learning is silent.
`;

/** The framework output contract, always mounted onto every worker (design 5.1). */
export const SEED_FRAMEWORK_SKILL: ISeedSkillFile = { path: '_framework/emit-result.md', content: EMIT_RESULT };

/** Diffy's own coordinator skills (design 5.3). */
export const SEED_COORDINATOR_SKILLS: readonly ISeedSkillFile[] = [
	{ path: 'coordinator/coordinator-routing.md', content: COORDINATOR_ROUTING },
];

/** The three seeded role-skill clusters (design 5.2). */
export const SEED_ROLE_SKILLS: readonly ISeedSkillFile[] = [
	{ path: 'group-issues-by-theme/SKILL.md', content: GROUP_ISSUES_BY_THEME },
	{ path: 'flaky-test-repro/SKILL.md', content: FLAKY_TEST_REPRO },
	{ path: 'behavioral-delta/SKILL.md', content: BEHAVIORAL_DELTA },
];

/** Every bundled seed file, for first-run seeding of the writable skill store. */
export const ALL_SEED_SKILLS: readonly ISeedSkillFile[] = [
	SEED_FRAMEWORK_SKILL,
	...SEED_COORDINATOR_SKILLS,
	...SEED_ROLE_SKILLS,
];
