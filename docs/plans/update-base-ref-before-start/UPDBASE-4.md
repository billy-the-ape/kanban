# UPDBASE-4 — Runtime fresh-start preparation integration

Master plan: `PLAN.md`, section "Start lifecycle and once-only behavior". First implementation
PR group (with UPDBASE-0 … UPDBASE-6).
Depends on: UPDBASE-0 (policy), UPDBASE-1 (fetch + classifier), UPDBASE-2 (branch update),
UPDBASE-3 (durable record + fresh classification).
Blocks: UPDBASE-5, and UPDBASE-7 (the UI may not promise refresh before this exists).

## Purpose

Wire the refresh into runtime-owned initial-start preparation, shared by native Cline and
terminal agents: under a lock scoped to the canonical Git common directory, execute the six
PLAN.md lifecycle steps and pin the fresh detached worktree at the post-refresh SHA before any
agent prompt is sent.

## Re-verify before starting (code moves)

- `ensureTaskWorktreeIfDoesntExist` in `src/workspace/task-worktree.ts`: reuses existing
  worktrees, rechecks inside `withTaskWorktreeSetupLock`, resolves the base commit locally
  before `git worktree add --detach`, and carries preservation/saved-patch restoration paths.
  Preservation/restore inspection must stay **before** any refresh (PLAN.md ordering).
- `startTaskSession` in `src/trpc/runtime-api.ts`: resolves task cwd, including a fallback
  that ensures a missing worktree before launch.
- Check the current scope of `withTaskWorktreeSetupLock`; the refresh needs serialization
  scoped to the canonical Git common directory (shared by linked worktrees), e.g. via
  `git rev-parse --git-common-dir` resolved through `runGit`.

## Implementation — the six lifecycle steps (PLAN.md)

1. Re-read the persisted task policy and lifecycle state; reject stale or mismatched
   task/base requests (task id, column, and baseRef must match the persisted task).
2. Recheck for a valid existing task worktree and durable preservation/saved-patch history
   (UPDBASE-3 classification) — **before** any refresh.
3. For a fresh task with `updateBaseRefBeforeStart === true`: run the refresh
   (UPDBASE-1 fetch → UPDBASE-2 safe branch update). For an unchecked fresh task: follow the
   current local base resolution with **zero** refresh-related network activity.
4. Resolve the post-refresh base commit exactly once and pass that immutable SHA into the
   detached worktree creation.
5. Prepare the environment and durably record the baseline (UPDBASE-3 record) **before the
   first prompt is sent**; document the exact write point for crash recovery.
6. Launch the requested agent only after preparation succeeds; finish the normal transition
   to In Progress.

Locking: steps 2–5 run under the common-directory lock so a double start and two tasks sharing
one repository serialize; each task consumes its own resolved immutable SHA.

Crash and partial-failure semantics:

- Any failure before successful worktree preparation is retryable — a later attempt may fetch
  again (preparation never succeeded).
- An existing valid worktree found after partial setup is reconciled and pinned to the record,
  never recreated from a newer base.
- If the base fast-forward succeeded but a later preparation step failed, the legitimate
  fast-forward stays in place; report the preparation failure; never roll the branch back.

## Tests

- Runtime start (native and terminal-agent paths): fresh checked task → first worktree HEAD
  equals the new origin SHA, the local base fast-forwarded, record persisted, first prompt sent
  only after preparation; fresh unchecked task → no fetch, worktree at the existing local SHA.
- Existing worktree / preservation ref / saved-patch task with the remote advanced → no
  refresh, no recreation; task HEAD and work unchanged.
- Simulated restart between preparation and launch → no second fetch, baseline preserved.
- Concurrency: two concurrent `startTaskSession` calls for one task, and two tasks sharing one
  repo → serialized by the common-directory lock; each pinned at its own SHA.

## Verification

```sh
npx @biomejs/biome check src test
npm run typecheck
npm run test:fast
npx vitest run test/workspace test/runtime
```

All workspace-state tests isolate `HOME`/`USERPROFILE` per AGENTS.md; unit-style suites must
not boot real SDK hosts.

## Acceptance criteria

- The refresh runs exactly on the runtime-owned fresh-start path, once, under the
  common-directory lock, and is shared by native Cline and terminal agents.
- The worktree is created detached at the resolved post-refresh SHA; the prompt is never sent
  before the baseline record is persisted.
- Unchecked fresh tasks produce zero refresh-related network activity.
- Crash/retry behavior matches the semantics above, proven by tests.

## Stop conditions

- The existing lock cannot be scoped to the Git common directory without a broader redesign —
  flag the design decision in the PR; do not silently fall back to a per-worktree lock.
- `startTaskSession` cwd resolution cannot distinguish “fresh initial start” from “ensure a
  missing worktree for an already-started task” without a contract change — stop and record it;
  that caller audit is UPDBASE-5's scope.
