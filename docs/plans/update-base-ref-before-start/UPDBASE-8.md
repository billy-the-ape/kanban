# UPDBASE-8 — Start progress and failure UX

Master plan: `PLAN.md`, section "User experience and persistence" (items 5–6). Second
implementation PR (with UPDBASE-7 … UPDBASE-9).
Depends on: UPDBASE-5 (structured failure shape: ref, category, reason, remedy) and
UPDBASE-7 (checkbox exists).
Blocks: UPDBASE-9.

## Purpose

Wire the user-visible state of a refresh preparation into the existing task-start handling:
an "Updating base ref…" progress state with duplicate-submit protection, and blocked-update
feedback that rolls the card back to backlog and shows the actionable remedy.

## Re-verify before starting (code moves)

- `web-ui/src/hooks/use-task-sessions.ts` sends `baseRef` through both
  `workspace.ensureWorktree` and `runtime.startTaskSession`.
- Start-failure handling and the optimistic column movement live around
  `web-ui/src/hooks/use-task-start-actions.ts` and `web-ui/src/hooks/use-board-interactions.ts`.
- Toasts use `sonner` / `showAppToast` from `@/components/app-toaster` — follow whatever
  convention the existing start-failure path already uses; do not introduce a new alert
  convention.

## Implementation

1. Progress: while the runtime is preparing a fresh start for an enabled task, show
   “Updating base ref…” (or the equivalent within the existing start affordance), and disable
   duplicate start submissions for that task during preparation. Preparation progress must
   never present the task as already running.
2. Failure: on a blocked update, keep the task in backlog — if the flow moved the card
   optimistically, restore it through the established start-failure handling — and display the
   selected ref, reason, and remedy from the UPDBASE-5 structured failure. No agent prompt is
   sent on failure.
3. Retry: no client-side "already fetched" state exists or may be added. After the user removes
   the blocker and starts again, the runtime may fetch again (preparation had not succeeded);
   the UI simply re-enters the same progress state.

## Tests

- Stubbed slow preparation → the progress indicator is shown, a second start attempt for the
  same task is suppressed, and the prompt is sent only after preparation completes.
- Stubbed blocked update (each failure category) → the card stays in / returns to backlog and
  the message contains the selected ref, reason, and remedy; no prompt sent.
- Unchecked task → no progress indicator appears; the existing start UX is unchanged.

## Verification

```sh
npx @biomejs/biome check web-ui/src
npm run web:typecheck && npm run web:test
```

## Acceptance criteria

- UX matches PLAN.md items 5 and 6 exactly: progress while preparing, duplicate submits
  disabled, blocked updates roll back to backlog with ref + reason + remedy.
- The client never decides "already refreshed"; all once-only behavior stays runtime-owned.
- No new toast/dialog conventions; existing start-failure handling is reused.

## Stop conditions

- A start path has no established failure/rollback hook that can display the blocked-update
  details — stop and flag the UX design decision; do not invent a convention.
- The preparation duration cannot be observed from the client without a new contract surface —
  prefer degrading to the existing "starting" affordance and record the limitation; do not add
  a polling loop.
