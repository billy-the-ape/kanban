# AR-6: Bind review results to the current turn and change set

Status: planned. One implementation PR into `main`. Dependencies: none.
Read [README.md](./README.md) and [EVIDENCE.md](./EVIDENCE.md).

## Outcome

A repair waits for its own terminal outcome and consumes its own result. An older
ready/terminal summary cannot dispatch the same finding again or mark a newer turn
complete. Reviewers receive the actual candidate change set rather than guessing from
a clean worktree or a single latest commit.

## Current integration points

- `src/cline-sdk/cline-review-session-service.ts`: `awaitTurn`, terminal waiting,
  repair loop, `extractResult`, handoff/evidence construction and tree-bound results.
- `src/cline-sdk/cline-task-session-service.ts`: send queue and terminal events.
- `src/workspace/task-review-handoff.ts`: stored starting revision, change-set evidence,
  plan-document fingerprints, and durable outcomes.
- `src/cline-sdk/review-prompt.ts`, handoff types in `src/core/api-contract.ts`,
  `test/cline-sdk/cline-review-session-service.test.ts`, and
  `test/workspace/task-review-handoff.test.ts`.

Historical DIAG-0 repeated a resolved finding, but the export does not prove a parser
or event-race cause. Reproduce with controlled event ordering before selecting a fix.

## Required implementation

1. Capture a turn receipt/watermark before dispatch, tied to the actual accepted input
   and native turn/session identity. Reject unsuccessful dispatch explicitly. Wait for
   terminal state belonging to that turn; an already-terminal prior summary is not
   completion evidence. Handle a new turn that starts and finishes before subscription.
   Reuse existing identity/generation primitives where available; do not poll inference
   with a new arbitrary timer or treat a quiet model as crashed.
2. Extract the authoritative structured review result from that turn only. Do not fall
   back to an inherited earlier result if the new turn lacks one or has malformed output.
   Preserve the existing schema's failure semantics; multiple conflicting final result
   blocks in one turn produce an explicit parse failure rather than an arbitrary choice.
3. Schedule another repair only from that completed turn's unresolved findings. Preserve
   existing severity policy, max repair rounds, verification gate, and tree identity.
   Do not use this fix to suppress non-blocking findings or weaken acceptance criteria.
4. Build the handoff from a trusted task starting/base commit and candidate tree, including
   committed changes and untracked relevant paths and referenced plan documents. Handle
   multiple task commits and merges. Never assume `HEAD^` is the whole change set.
   If required base evidence is unavailable and cannot be recovered from stored task/PR
   metadata, surface an actionable review failure/uncertainty; do not silently pass an
   empty diff or guess a base. A proven empty change set is a separate valid condition.
5. Preserve the no-publication review policy, scoped writes, cancellation, bounded repair
   budget, and candidate-tree revalidation. Update runtime review docs with outcome
   correlation and incomplete-handoff behavior. Avoid unrelated lifecycle refactors.

## Acceptance and verification

- Regression: prior terminal summary arrives after dispatch; no second repair is queued
  before the accepted repair completes. A clean current-turn result stops the loop.
- Cover instant completion, queued input, restarted native session, inherited result,
  absent/malformed/conflicting current result, rejected send, cancellation, timeout,
  and task isolation. Do not rely on long sleeps or only happy-path fake summaries.
- A DIAG-0-shaped scripted sequence has one finding, one successful repair, and no
  duplicate round. A genuinely unresolved finding still uses the existing bounded loop.
- Committed multi-commit task, dirty/untracked task, merge case, proven empty diff,
  missing base, and unchanged/tree-changed verdict cases have explicit tests.
- Run focused review-session/handoff/task-send suites, relevant integration tests and
  backend typecheck; format changed files. Preserve existing deterministic gate tests.

## Deployment and exclusions

No new review model, broad review prompt rewrite, reduced checks, or PR posting behavior.
Normal rebuild/redeploy; no new environment variables or storage migration. Do not
restart/retarget in-flight reviews silently; verify using new reviews after deployment.
