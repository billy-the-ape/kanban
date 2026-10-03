# UPD-1 — Checkbox, start progress, and end-to-end verification

Part of the **Update task base ref before starting** feature. The master plan lives in [PLAN.md](./PLAN.md).
This document is a self-contained execution brief for the second implementation PR.

| Field | Value |
| --- | --- |
| Document revision | 2 |
| Prepared | 2026-10-03 (revision 2: 2026-10-03) |
| Status | Proposed; not started |
| Source baseline | ba3b7151f44f9ed5d1cb4d83590e98388ae2cac7 (re-verify at start; UPD-0's merged head is the true base) |
| Fork | https://github.com/billy-the-ape/kanban |
| Prerequisites | UPD-0 merged (persisted policy, runtime refresh, durable baseline, failure shape, preparation-state contract) |
| Follow-on | None; final acceptance rows in PLAN.md close with this PR |

## Objective

Expose the persisted `updateBaseRefBeforeStart` policy in every UI surface that already exposes the base
ref selector, wire refresh progress and actionable failure feedback through the existing task-start
handling, and close the remaining PLAN.md end-to-end acceptance rows (UI save/create paths, backlog
rollback, refresh retries, automated starts, resume, manual validation).

## Scope

Allowed:

- `web-ui/src/hooks/use-task-editor.ts` and its test (load/save the policy; hide/disable for started tasks)
- `web-ui/src/components/task-create-dialog.tsx`, `task-inline-create-card.tsx`, multi-create, and any
  other create surfaces exposing the base selector
- `web-ui/src/hooks/use-task-sessions.ts`, `use-task-start-actions.ts`, `use-board-interactions.ts`
  (progress state, duplicate-submit guard, start-failure rollback and messaging — on top of UPD-0's
  minimal start-orchestration change, which this PR does not rework)
- `web-ui/src/types/board.ts`, `web-ui/src/state/board-state.ts` (any parity gaps left by UPD-0)
- `docs/` user documentation for the new checkbox; `docs/plans/update-base-ref-before-start/PLAN.md`
  consistency updates only (no re-planning)
- Tests under `web-ui/` and `test/` for the end-to-end rows below

Explicit non-goals:

- No runtime Git/refresh logic changes (that is UPD-0; if a defect is found there, record it and fix it in
  a follow-up or a scoped amendment to UPD-0, not opportunistically in the UI PR)
- No changes to PR delivery, merge policy, dependency dispatch, or task recovery behavior
- No new configuration, environment variables, or migrations

## Current code and integration points (verified against the baseline)

- `web-ui/src/hooks/use-task-editor.ts` loads and saves `baseRef`; the editor closes when the task leaves
  backlog. Adding the policy load/save here is the pattern for backlog editing.
- `web-ui/src/hooks/use-task-sessions.ts` sends `baseRef` through both `workspace.ensureWorktree` and
  `runtime.startTaskSession`; `use-board-interactions.ts` `kickoffTaskInProgress` currently awaits the
  ensure before start. UPD-0 changes that sequence (fresh tasks skip the eager ensure; runtime start owns
  worktree creation after the refresh) and adds the preparation-state contract (server-computed
  baseline-fixed signal, extended start response); this PR's start-failure handling, optimistic column
  movement, and progress state build on that contract. The UPD-0 failure shape (ref, category, reason,
  remedy) plugs into the existing start-failure path.
- Creation surfaces: `web-ui/src/components/task-create-dialog.tsx` and `task-inline-create-card.tsx`
  expose task options including the base selector; multi-create and child creation follow the same board
  mutation inputs. CLI/API creation defaults were set in UPD-0 and need only regression coverage here.
- UPD-0 delivers the durable baseline/preparation record and the runtime-owned refresh; this PR's UI
  never performs Git operations and never treats a browser flag as "already fetched".

## Implementation tasks

- [ ] UPD-1.1 Add an accessible checkbox **Update base ref before starting** directly below the Worktree
  base ref selector in backlog task editing, with the optional helper text: “Fetch origin and fast-forward
  the base branch before creating this task's worktree.” Use Radix `Checkbox` styled per the repo's
  `src/components/ui/` conventions (tabs, Tailwind, dark tokens). Load the persisted value; changing the
  selected branch must not reset it. For already-started tasks (including those returned to backlog),
  hide or disable the control with a short explanation that the initial start baseline is fixed; drive
  that decision from the UPD-0 server-computed baseline-fixed signal (durable and reload-safe, and covers
  automated dispatch starts), never from a local flag.
- [ ] UPD-1.2 Persist the value through every save/create path: backlog edit save, inline creation,
  multi-create, and child creation. Explicit `false` must reach the server unchanged (regression: an
  unchecked box is `false`, not absent). New tasks default to checked via the shared default.
- [ ] UPD-1.3 Wire start UX: show “Updating base ref…” (or equivalent in the existing start affordance)
  while the runtime prepares a fresh start for an enabled task; drive it from the UPD-0 preparation-state
  contract (start response stage/event), not a local heuristic; disable duplicate start submissions for
  that task during preparation.
- [ ] UPD-1.4 Wire failure UX: on a blocked update, keep the task in backlog (restore it through the
  established start-failure handling if the flow moved the card optimistically), and show the selected
  ref, reason, and remedy from the UPD-0 structured failure. No prompt is sent on failure.
- [ ] UPD-1.5 End-to-end regression coverage for the remaining PLAN.md rows: checked and unchecked starts
  from the UI, backlog rollback after a blocked update, refresh retry after fault removal, automated
  (dispatch) starts honoring the persisted policy, resume of an existing task after remote advancement
  leaving its worktree unchanged, and legacy/unstarted task defaults.
- [ ] UPD-1.6 Update relevant user documentation (settings/task documentation) for the checkbox, its
  default, the blocked cases, and the uncheck-and-retry remedy. Keep PLAN.md consistent with the final
  implementation (field names, record format, file paths) without rewriting the plan.

## Acceptance and tests (UPD-1 rows)

UPD-0 covers the runtime/Git rows of the PLAN.md matrix; this PR must at minimum prove:

| Scenario | Required result |
| --- | --- |
| Save/edit, inline, multi-create, child creation (UI) | Correct policy persisted and honored by the runtime; explicit false survives every path |
| New and legacy task defaults in the UI | Checked; legacy tasks without the field read as checked |
| Start with option enabled | Progress indicator shown during preparation; duplicate starts suppressed; prompt sent only after preparation |
| Blocked update | Card stays in (or returns to) backlog; UI shows selected ref, reason, and remedy; no agent prompt sent |
| Refresh retry | After the fault (network/dirty/diverged) is removed, starting again succeeds and uses the refreshed SHA |
| Automated starts | Dispatched tasks honor their persisted policy identically to UI starts |
| Resume after remote advance | An existing started task's worktree and work are unchanged; no refresh runs |
| Started task editing | Checkbox hidden/disabled with explanation; saved value untouched |
| UI reload/reconnect or automated (dispatch) start | Checkbox state re-derived from the UPD-0 server-computed baseline-fixed signal after reload; no client flag drives refresh eligibility, progress, or control visibility |

Run: targeted web-ui tests (`use-task-editor`, `use-task-sessions`, board interactions, create dialogs),
the targeted runtime/integration suites touched, backend and web typechecks, and the repository's
required checks (`biome check`, `test:precommit`). Markdown is excluded from Biome; review
headings/tables manually and keep a final newline.

Manual validation (per PLAN.md): advance a feature branch remotely, edit a backlog task to select its
stale local branch, leave the checkbox checked, and start it. Confirm the base and detached worktree
match the fetched tip. Repeat unchecked, then resume the first task after another remote advance and
confirm its worktree is unchanged. Exercise a blocked dirty or diverged base and confirm no agent prompt
was sent.

## Settings and deployment

None. No environment variables, secrets, migrations, or deployment actions. The per-task default is
enabled, including unstarted legacy tasks; no operator action is required on rollout.

## Handoff

Record: changed files, checkbox placement per surface, progress/failure wording, test commands and
results, manual-validation results, and documentation pages updated. With this PR merged, the feature's
full PLAN.md acceptance matrix is closed; update the plan folder status if the implementation diverged.

## Stop conditions

- A required behavior turns out to live on the runtime side (UPD-0 scope) — do not smuggle runtime Git
  changes into this UI PR; open a scoped follow-up and record it here.
- A start path has no established failure/rollback hook to display the blocked-update details — stop and
  flag the UX design decision rather than inventing a new toast/alert convention.
- Any test requires external network or writes to the real `~/.cline` — rework the fixture instead.
