# UPD-0 — Runtime base-ref refresh preparation and Git integration

Part of the **Update task base ref before starting** feature. The master plan lives in [PLAN.md](./PLAN.md). This document is a self-contained execution brief for the first implementation PR.

| Field | Value |
| --- | --- |
| Document revision | 2 |
| Prepared | 2026-10-03 (revision 2: 2026-10-03) |
| Status | Proposed; not started |
| Source baseline | ba3b7151f44f9ed5d1cb4d83590e98388ae2cac7 |
| Fork | https://github.com/billy-the-ape/kanban |
| Prerequisites | PLAN.md reviewed and approved |
| Follow-on | UPD-1 (checkbox, start progress, end-to-end verification) must not start until this PR is merged |

## Objective

Give the runtime a single, lock-protected initial-start preparation path that, for fresh tasks whose
persisted `updateBaseRefBeforeStart` policy is enabled, fetches origin, safely fast-forwards the selected
local base branch, resolves the post-refresh base commit once, and creates the task worktree at that exact
SHA before any agent prompt is sent. Persist a durable preparation/baseline record so restarts, retries,
and recovery never refresh twice or silently move the baseline. No rendered user-visible UI ships in this
PR (the browser start-orchestration change is behavioral only).

## Scope

Allowed:

- `src/core/api-contract.ts`, `src/core/api-validation.ts`, `src/core/task-board-mutations.ts` (policy field,
  normalization, and preparation-state response fields)
- `src/workspace/` (new base-refresh module, worktree preparation integration, durable baseline record)
- `src/trpc/runtime-api.ts`, `src/trpc/workspace-api.ts`, `src/trpc/app-router.ts` (start-path wiring and
  preparation-state exposure; no public behavior change for generic ensure calls)
- `src/task-dispatch/task-dispatch-service.ts` and other automated start paths (policy honored identically)
- `src/commands/task.ts` CLI create/input defaults
- `web-ui/src/hooks/use-board-interactions.ts`, `web-ui/src/hooks/use-task-sessions.ts`, and their existing
  tests (minimal start orchestration only: the browser ensure-then-start sequence must not materialize a
  stale worktree ahead of the refresh; no rendered checkbox, progress, or failure-UX copy — UPD-1)
- Tests under `test/` (runtime, trpc, integration)
- `web-ui/src/types/board.ts` and `web-ui/src/state/board-state.ts` only as far as contract type/normalization
  parity requires (no rendered UI)

Explicit non-goals:

- No checkbox, no "Updating base ref…" progress surface, no start-failure UX copy (UPD-1)
- No changes to PR delivery, merge policy, dependency dispatch, trash/cleanup, or task recovery behavior
- No new configuration, environment variables, credentials, or migrations
- No force-push, merge, rebase, reset, auto-stash, or switching of the primary checkout

## Current code and integration points (verified against the baseline)

- `src/core/api-contract.ts` carries `baseRef` across task create/edit/session schemas; task create and
  update inputs are validated in `src/core/task-board-mutations.ts` (`baseRef` is required and trimmed).
  The persisted boolean `updateBaseRefBeforeStart` joins these schemas; absent values normalize to `true`,
  and explicit `false` must survive round-trips (no truthy fallback that overwrites `false`).
- `src/workspace/task-worktree.ts`: `ensureTaskWorktreeIfDoesntExist` reuses existing worktrees, then
  rechecks inside `withTaskWorktreeSetupLock`, resolves the requested base commit locally before
  `git worktree add --detach`, and afterwards runs its preservation and saved-patch restore paths. That
  base-resolution-first ordering is the status quo, not the target: per PLAN.md, the start-owned path must
  inspect restoration before refresh, so task content and recovery precedence are preserved by moving
  existing-worktree, preservation/saved-patch, and historical-task detection *ahead of* fresh-base
  resolution/refresh (see UPD-0.4).
- `web-ui/src/hooks/use-board-interactions.ts`: `kickoffTaskInProgress` awaits `ensureTaskWorkspace(task)`
  (`workspace.ensureWorktree`) before `startTaskSession(task)`; the ensure creates a detached worktree from
  the local base, so for a fresh enabled task it lands ahead of the refresh and defeats it.
  `web-ui/src/hooks/use-task-sessions.ts` maps the start response to `{ ok, message }`; the runtime start
  response today is `{ ok, summary, error }` with no preparation stage or baseline-fixed fact for the UI to
  consume.
- `src/trpc/runtime-api.ts` `startTaskSession` resolves task cwd (including a fallback that ensures a
  missing worktree) before launching the agent; `src/trpc/workspace-api.ts` `ensureWorktree` delegates to
  `ensureTaskWorktreeIfDoesntExist`. Audit shell-open, `workspace-metadata-monitor`, review-session, and
  dispatch callers so generic ensure calls neither trigger nor consume the initial-start refresh, while an
  early ensure on a genuine initial start cannot create a stale worktree ahead of the refresh.
- `src/workspace/git-sync.ts` uses `fetch --all --prune` / `pull --ff-only` via `runGit`
  (`src/workspace/git-utils.ts`, argument arrays, `RunGitOptions`, `getGitCommandErrorMessage`). Reuse that
  execution and error convention; do not reuse its current-checkout pull for a different selected base.
- `src/workspace/task-preservation.ts` shows the durable per-task record convention (per-task directory
  under the home path, read/write JSON records). The new preparation/baseline record follows the same
  durable, restart-surviving pattern. Do not reuse `refs/kanban/tasks/<id>` (owned by the B-5 preservation
  ref); if a Git ref is needed at all, use a distinct namespace.
- Existing regression coverage: `test/runtime/task-worktree.test.ts`,
  `test/integration/task-worktree.integration.test.ts`, `test/runtime/trpc/runtime-api.test.ts`,
  `test/runtime/trpc/workspace-api.test.ts`. Git fixtures follow the local bare origin + second clone
  pattern from `test/integration/task-worktree-delivery.integration.test.ts`; tests that touch
  worktree/workspace state must isolate `process.env.HOME`/`USERPROFILE` per AGENTS.md.

## Implementation tasks

- [ ] UPD-0.1 Add `updateBaseRefBeforeStart` to the task model: contract schemas (create, edit, session
      start, board serialization), `task-board-mutations.ts` create/update paths, CLI/API input defaults,
      and automated task creation (`task-dispatch-service.ts`, review follow-ups, child creation). Absent
      field normalizes to `true`; explicit `false` is preserved through save, reload, and serialization.
      Update `web-ui/src/types/board.ts` and `board-state.ts` normalization for type parity.
- [ ] UPD-0.2 Add a focused base-refresh module under `src/workspace/` (e.g. `task-base-refresh.ts`) with:
  - Unambiguous ref classification for the full policy table in PLAN.md ("Supported ref policy"): local
    branch tracking origin (respecting differing local/remote names), local branch without upstream (use a
    same-name origin ref explicitly, never rewrite upstream config), local branch tracking another remote
    (block), explicit `origin/...` remote-tracking ref (resolve after fetch), tag/SHA/other pinned refs
    (block), missing origin or missing remote branch (block).
  - `git fetch origin` with bounded command/network time, noninteractive credentials only, and
    credential scrubbing in errors/logs. Verify the specific target remote ref actually refreshed
    (handle restricted/custom fetch refspecs); never accept a stale cached ref.
  - Safe local-branch update: inspect `git worktree list --porcelain`; if the branch is checked out,
    require a clean tree with no active merge/rebase, recheck state immediately before mutation, and
    fast-forward in place (equivalent to `pull --ff-only` post-fetch); if unoccupied, verify the old tip
    is an ancestor of the fetched target and move the ref with compare-and-swap
    `git update-ref <ref> <new> <old>`. Never `update-ref` a checked-out branch; never checkout the base
    in an unrelated workspace. Equal tips are a success no-op; local-ahead or diverged history blocks with
    the PLAN.md remedy message. Detect concurrent external ref/checkout changes and fail safely.
  - Structured failure categories (missing origin/target, unsupported ref, dirty checkout,
    local-ahead/divergence, auth/network timeout, concurrent change, worktree setup failure), each
    carrying safe Git diagnostics and a specific remedy. No silent stale-base fallback.
  All Git arguments passed as arrays through `runGit`; never interpolate refs into a shell string.
- [ ] UPD-0.3 Add the durable initial-start preparation/baseline record (per task, restart-surviving,
  backward-compatible): selected ref, option value, resolved baseline SHA, and preparation state.
  Persist it before launching the agent. A server restart must neither re-refresh nor lose the chosen
  baseline. Design the record so a prepared task whose worktree later disappears is restored at its
  recorded SHA (or blocked), never re-resolved against a newer base.
- [ ] UPD-0.4 Integrate refresh into runtime-owned fresh-start worktree preparation, shared by native
  Cline and terminal agents, under a lock scoped to the canonical Git common directory (shared by linked
  worktrees), following the PLAN.md "Start lifecycle" six steps: re-read persisted policy/lifecycle and
  reject stale requests; recheck existing worktree, preservation/saved-patch history, and historical-task
  records *before* resolving or refreshing a fresh base (recovery must not depend on resolving or fetching
  the selected ref); refresh only for a fresh enabled task; resolve the post-refresh SHA once and pass it
  into detached worktree creation; persist the baseline before sending the first prompt; transition to
  In Progress only after preparation succeeds.
- [ ] UPD-0.5 Audit and wire every worktree-creation caller: browser start (`runtime.startTaskSession`
  cwd resolution), the `workspace.ensureWorktree` trpc route, shell opening, workspace inspection
  (`workspace-metadata-monitor`), automated dispatch, review sessions, and resume. Generic ensure calls
  must neither trigger the refresh nor consume its record; an early ensure on a genuine initial start
  must not create a stale worktree before the refresh runs. Unchecked fresh tasks follow current local
  base resolution with zero refresh-related network activity.
- [ ] UPD-0.6 Minimal browser start orchestration (start-specific preparation contract): in
  `web-ui/src/hooks/use-board-interactions.ts` `kickoffTaskInProgress`, skip the eager
  `ensureTaskWorkspace` for fresh, unstarted tasks (no existing worktree and no fixed initial baseline)
  so that `runtime.startTaskSession` — whose cwd resolution already falls back to worktree setup — owns
  worktree creation at the post-refresh SHA; keep the pre-start ensure for tasks that resume from an
  existing worktree. Selected-task workspace info is already refreshed after start through the existing
  `fetchTaskWorkspaceInfo` path, so the ensure is not load-bearing for the detail pane.
  `web-ui/src/hooks/use-task-sessions.ts` changes only as far as needed to pass the UPD-0 start
  response/failure shape through unchanged. No rendered UI changes; checkbox/progress/failure-UX remain
  UPD-1. Regression: a trpc-level test replaying the actual browser ensure-then-start sequence (call
  `workspace.ensureWorktree`, then `runtime.startTaskSession`, for a fresh enabled task with a remotely
  advanced base) proves no stale worktree survives and the first prompt runs afterward; a hook-level test
  proves kickoff skips the eager ensure for fresh tasks.
- [ ] UPD-0.7 Preparation-state contract for the UI (consumed by UPD-1):
  - Server-computed `initialStartBaselineFixed` per task: true when the durable preparation record holds a
    resolved baseline SHA or when historical-task detection (durable session, preservation, saved-patch,
    or delivery records) shows the task already started. This is the same signal that gates the refresh —
    a single source of truth — and it is derived server-side; a browser flag or in-memory "already
    fetched" set never establishes historical start eligibility.
  - Expose it in the existing board serialization and/or task workspace-info response so a UI reconnect
    or reload re-derives eligibility from durable state, including tasks started by automated dispatch.
  - Extend the start response (today `{ ok, summary, error }`) so a caller can distinguish preparation
    outcome: the fixed baseline SHA and final stage on success, and the UPD-0.8 structured failure on
    block, without parsing logs. If in-flight stage progress (refreshing, creating worktree) is needed by
    UPD-1's progress surface, broadcast it through the existing runtime event plumbing; the contract must
    make that possible, rendering stays in UPD-1.
  - Minimum behavior: automated starts perform the same preparation, persist the same record, and honor
    the same stage semantics; no new configuration. Add contract tests for the new response fields.
- [ ] UPD-0.8 Failure semantics: a blocked update surfaces through the start-failure result shape
  (extended per UPD-0.7): task stays in backlog, no prompt sent, with the selected ref, category, reason,
  and remedy. If a base
  update succeeded but later preparation failed, leave the legitimate fast-forward in place and report
  the preparation failure; never roll the branch back.
- [ ] UPD-0.9 Observability: timestamped preparation stage logs (task ID, selected ref, remote target,
  old/new SHA, duration, outcome) via existing runtime logging, with token/credential-bearing URLs
  redacted. A fetch/pull status is preparation progress only — it must not mark the task running or done.
- [ ] UPD-0.10 Tests: real local-Git integration coverage (temporary repo, local bare origin, second clone
  advancing the remote) covering the acceptance rows below — including the browser ensure-then-start
  regression (UPD-0.6) and the recovery-with-unavailable-base row — plus runtime start/failure tests. Unit-style
  suites must not boot real SDK hosts; Git tests that create task refs must account for the B-5
  preservation ref, and all workspace-state tests must isolate `HOME`/`USERPROFILE`.

## Acceptance and tests (UPD-0 rows)

Use the acceptance matrix in PLAN.md; this PR must at minimum prove:

| Scenario | Required result |
| --- | --- |
| Origin advances a stale local feature base (checked) | First task worktree HEAD equals the new origin SHA; local base fast-forwards; first prompt runs afterward; durable record holds the resolved SHA |
| Checkbox unchecked (explicit false) | No fetch, no ref update, no network; worktree starts at the existing local SHA |
| New and legacy task defaults | Absent value reads as checked; explicit false survives schema normalization, persistence, and reload |
| Checked-out clean base versus unoccupied base | Both update safely without switching an unrelated checkout; unoccupied path uses CAS `update-ref` and ancestor check |
| Dirty selected checkout, staged/untracked files, active merge/rebase | Start blocked with category and remedy; files and local base intact |
| Different tracking names, no upstream with same-name origin | Intended origin target used; upstream config untouched |
| Local-ahead, diverged, other remote, missing origin/branch, pinned ref | Clear block + remedy; no stale fallback, reset, or prompt |
| Explicit origin ref and restricted fetch refspec | Correct target refreshed or start blocked (cached ref never accepted) |
| Existing worktree, review retry, restart, trash restore, saved patch | No refresh/recreation; task HEAD and work survive remote advancement; "directory missing" is never treated as "never started" |
| Original base ref deleted locally and on origin, but preservation/saved-patch state exists | Recovery runs before fresh-base resolution/refresh and succeeds without resolving or fetching that ref |
| Browser kickoff ensure-then-start, fresh enabled task, remotely advanced base | No stale worktree survives the early ensure; worktree created at the post-refresh SHA; first prompt sent only after preparation |
| UI reload/reconnect or automated (dispatch) start | Baseline-fixed eligibility re-derived from durable server state (including dispatch starts); a local pending flag is never authoritative; no second refresh |
| Prepared baseline but missing worktree | Restore recorded baseline SHA or block; never re-resolve to a newer base |
| Double start and two tasks sharing a repo | Common-directory lock serializes refresh/create; each task uses its own immutable resolved SHA |
| Network failure or timeout | No worktree, no prompt, task remains in backlog; retry after fault removal succeeds (a second fetch is allowed because preparation had not succeeded) |
| Crash after worktree creation or after baseline persistence | Retry reconciles the existing worktree and durable record without discarding work |
| Shell/inspection ensure before initial start | No premature stale worktree; refresh still runs at start |
| External ref/checkout change during preparation | Detected and blocked without overwriting the external change |

Run: targeted runtime/workspace/trpc test files, the Git integration suites, backend and web typechecks,
and the repository's required checks (`biome check`, `test:precommit`). Markdown is excluded from Biome;
review headings/tables manually and keep a final newline.

## Settings and deployment

None. No environment variables, secrets, migrations, or deployment actions. The durable record format and
its backward-compatible rollout (legacy boards without the field) must be documented in this PR's
description. Existing origin credentials and connectivity are the only prerequisites.

## Handoff

Record: changed files, the durable record location/format, the lock scope chosen, every caller audit
result (which paths are start-owned vs generic ensure), the browser start-orchestration decision (which
kickoff paths keep vs skip the pre-start ensure), the preparation-state contract (fields and where they
are exposed), test commands and results, and any baseline drift discovered against ba3b7151. UPD-1 then
adds the UI against the runtime behavior and contract verified here.

## Stop conditions

- PLAN.md policy is ambiguous for a real ref shape encountered in a fixture — stop and record the case rather than invent policy.
- A caller audit reveals a start path that cannot distinguish "fresh initial start" from "generic ensure" without a contract change — stop and flag the design decision.
- Any test requires external network, a real SDK host boot in a unit suite, or writes to the real `~/.cline` — rework the fixture instead.
- Required preservation/recovery state is missing for a legacy task shape — block with an actionable error per PLAN.md; do not guess.
