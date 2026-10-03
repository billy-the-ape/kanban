# UPDBASE-3 — Durable initial-start preparation/baseline record

Master plan: `PLAN.md`, section "Start lifecycle and once-only behavior". First implementation
PR group (with UPDBASE-0 … UPDBASE-6).
Depends on: nothing for the record itself (designed here, integrated in UPDBASE-4).
Blocks: UPDBASE-4.

## Purpose

Add the per-task, restart-surviving, backward-compatible record that is the "already prepared"
truth for initial starts: the selected ref, the option value, the resolved baseline SHA, and
the preparation state. Consequences: a server restart never re-refreshes or loses the chosen
baseline; a prepared task whose worktree later disappears is restored at its recorded SHA (or
blocked) — never re-resolved against a newer base; and legacy tasks without the record are
classified using current durable session, preservation, saved-patch, and delivery records.

## Re-verify before starting (code moves)

- `src/workspace/task-preservation.ts` is the durable per-task record convention (per-task
  directory under the home path, JSON read/write). The new record follows the same pattern.
- `refs/kanban/tasks/<id>` is owned by the B-5 preservation ref (kept current while a worktree
  lives) — **do not reuse it** and do not add refs under `refs/kanban/tasks/<id>/`. This task
  needs no Git ref at all: a file record under the home path is sufficient.

## Implementation

1. Record shape (JSON, per task, under the same home-path area as preservation):

```jsonc
{
  "schemaVersion": 1,
  "taskId": "...",
  "selectedRef": "feature/x",     // exactly as chosen at start
  "updateBaseRefBeforeStart": true, // policy value at preparation time
  "baselineSha": "<40-hex>",       // the resolved immutable base commit
  "preparedAt": 1234567890,
  "state": "prepared"              // terminal for the initial start
}
```

	- Written (or finalized with `baselineSha` + `state: "prepared"`) **before the agent is
	  launched**; the exact crash-recovery write point (before vs immediately after worktree
	  creation) is chosen in UPDBASE-4 and must be documented in its PR.
	- Read on every start/resume/recovery decision that asks "has this task's initial start
	  already been prepared?"
2. Recovery classification (shared helper, used by UPDBASE-4): a task is **fresh** only when it
   has no preparation record **and** the current durable session, preservation-ref, saved-patch,
   and delivery records all indicate no work ever existed. “Directory missing” alone never means
   “never started”: an existing valid worktree, preservation ref, saved patch, or delivery
   receipt keeps the task out of the refresh path.
3. Prepared-but-missing-worktree: restore the pinned state from `baselineSha` / preserved work
   through the existing restoration paths; if the required recovery state is unavailable →
   block with an actionable error. Never silently refresh to a newer base.
4. Legacy tasks (no record): classified by rule 2 only. No migration or backfill; the record is
   forward-only and its absence must always be legal. Readers tolerate the file being absent,
   and the writer is the only writer.

## Tests

- Record write/read round-trip; survives a simulated restart (fresh module/process state);
  a second read never mutates the record.
- Classification: task with a preservation ref but no record → not fresh; task with a saved
  patch → not fresh; task with a delivery receipt → not fresh; a genuinely new task → fresh.
- Prepared + worktree directory deleted → the restore path targets the recorded `baselineSha`
  (or blocks with an actionable error); assert the resolver is **not** re-run against a newer
  remote tip (advance the remote in the fixture and show the result is unchanged).

## Verification

```sh
npx @biomejs/biome check src test
npm run typecheck
npx vitest run test/workspace  # targeted record/classification suite
```

All tests redirect `process.env.HOME`/`USERPROFILE` to a temp dir in `beforeEach` and restore
in `afterEach` (AGENTS.md workspace-state isolation).

## Acceptance criteria

- A restart between preparation and agent launch causes neither a second fetch nor a re-
  resolved base.
- The record format is documented in the PR description; backward-compatible (absence legal,
  `schemaVersion` present); no migration required for legacy boards.
- “Directory missing” is never classified as “never started” when any durable prior-work
  record exists.

## Stop conditions

- Distinguishing “never started” from “started but state lost” requires a signal that no
  existing durable record carries — stop, record the gap, and make the affected recovery path
  block with an actionable error per PLAN.md; do not guess the baseline.
- The preservation/persistence home paths are not available in a test context without writing
  to the real `~/.cline` — rework the fixture (HOME redirect), never the assertion.
