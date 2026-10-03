# UPDBASE-5 — Caller audit, start-failure semantics, and observability

Master plan: `PLAN.md`, sections "Current code and integration points", "Failure reporting and
observability". First implementation PR group (with UPDBASE-0 … UPDBASE-6).
Depends on: UPDBASE-4 (refresh integrated on the start path).
Blocks: UPDBASE-6 (final runtime test gate) and UPDBASE-8 (UI failure UX consumes the failure
shape defined here).

## Purpose

Close the integration surface: (1) audit **every** worktree-creation caller so generic ensures
neither trigger nor consume the initial-start refresh, (2) surface blocked updates through the
existing start-failure result shape with an actionable remedy, and (3) add redacted,
timestamped preparation logs.

## Implementation

1. Caller audit — classify each caller **start-owned** (honors the refresh) vs **generic**
   (must not trigger the refresh, must not consume the preparation record, and must not create
   a stale worktree that bypasses the start refresh), and document the table in the PR
   description:
	- Start-owned: `startTaskSession` cwd resolution (`src/trpc/runtime-api.ts`), automated
	  dispatch (`src/task-dispatch/task-dispatch-service.ts`), and any other path that sends the
	  first prompt.
	- Generic: the `workspace.ensureWorktree` route (`src/trpc/workspace-api.ts`), shell
	  opening, `workspace-metadata-monitor` inspection, review sessions, and resume.
	- The key PLAN.md hazard: an early `workspace.ensureWorktree` on a genuine initial start
	  (the browser sends it before `runtime.startTaskSession`) must not create a stale worktree
	  before the refresh runs. Pick and document one resolution, then prove it with tests:
	  (a) a generic ensure for a fresh enabled task resolves the base **without** refresh and the
	  start path re-pins/reconciles the worktree at the post-refresh SHA before the first prompt
	  (legal only if the worktree is still empty); or (b) a generic ensure for a fresh enabled
	  task is a no-op until the start-prep path has run.
2. Failure semantics:
	- A blocked update returns through the **existing** start-failure result shape carrying
	  `{ selectedRef, category, reason, remedy }` (UPDBASE-1 types). The task stays in backlog —
	  if the flow moved the card optimistically, the established start-failure rollback applies —
	  and no prompt is sent.
	- Base update succeeded but later preparation failed → report the preparation failure with
	  the legitimate fast-forward left in place; never roll the branch back.
3. Observability:
	- Timestamped preparation-stage logs (fetch start/end, branch update, SHA resolution,
	  worktree creation, record persistence) carrying task ID, selected ref, remote target,
	  old/new SHA, duration, and outcome — via the existing runtime logging conventions.
	- Redact tokens and credential-bearing URLs from every log/error line.
	- A fetch/pull status is preparation progress only: it must never mark the task running or
	  completed.

## Tests

- Shell-open and task inspection for a fresh enabled task → no refresh runs, no record
  consumed, and no stale worktree left that bypasses the start refresh (assert per the
  chosen ensure resolution from step 1).
- Blocked update (dirty-checkout fixture) → the start-failure shape carries ref/category/
  reason/remedy; the task remains in backlog; no prompt; retry after cleaning succeeds and
  uses the refreshed SHA.
- Log redaction: a fixture remote URL containing a token → the token appears in no log or
  error output.
- Preparation progress (fetch running) never flips the task's running/complete state.

## Verification

```sh
npx @biomejs/biome check src test
npm run typecheck
npm run test:fast
npx vitest run test/workspace test/runtime
```

## Acceptance criteria

- Every worktree-creation caller is classified in the PR description, and each caller's
  behavior matches its class in tests.
- No path can bypass fresh-start preparation with a stale worktree; no generic path triggers
  a refresh or consumes the preparation record.
- Blocked updates are actionable (selected ref + reason + remedy), leave the task in backlog,
  and send no prompt.
- Logs are redacted, timestamped, per-stage, and never misrepresented as task status.

## Stop conditions

- A caller cannot be cleanly classified without a contract change — stop and record it; do not
  paper over the ambiguity.
- The existing start-failure shape cannot carry the structured fields — extend the contract
  deliberately (and document it) rather than stuffing them into a free-form message string.
- The chosen early-ensure resolution would require discarding or re-creating a non-empty
  worktree — that violates the pinning invariant; stop and reconsider the resolution.
