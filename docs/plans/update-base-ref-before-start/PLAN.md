# Update task base ref before starting

Status: Proposed; this PR contains the plan only.
Target: `billy-the-ape/kanban`, `main`.
Code baseline inspected: `ba3b7151f44f9ed5d1cb4d83590e98388ae2cac7`.

## Problem and outcome

Tasks currently create a detached worktree from the locally resolved base ref. When several PRs build on a feature
branch, the remote branch can advance while the local branch remains stale. Starting another task then uses old code
unless someone manually fetches and updates the base first.

Add a per-task checkbox, **Update base ref before starting**, directly below **Worktree base ref** when editing a
backlog task. It defaults to checked. Before the first task prompt is sent and before its fresh detached worktree is
created, fetch origin, safely fast-forward the selected local base branch, resolve its updated commit, and create the
task worktree at that exact SHA. The same policy applies to automated initial starts.

This folder owns the feature's master plan. The feature is split into one file per task
(`UPDBASE-0.md` through `UPDBASE-9.md`) in this directory so a coding agent only needs to load
the task it is executing plus the shared context in this file. UPDBASE-0 through UPDBASE-6
form the first implementation PR (runtime); UPDBASE-7 through UPDBASE-9 form the second (UI).
Do not renumber tasks once work starts; record later additions under a new UPDBASE number.

## Scope

- Persist a per-task boolean named `updateBaseRefBeforeStart`; absent values normalize to `true`.
- Expose the checkbox in backlog editing and corresponding creation forms that already expose the base selector.
  Use the same default for inline creation, multi-create, CLI/API creation, and automatically created tasks.
- Implement refresh in runtime-owned initial-start preparation, shared by native Cline and terminal agents.
- Preserve an explicit unchecked value across save, reload, board serialization, and all start paths.
- Report refresh progress and actionable failures in the existing task-start UI.
- Do not change PR delivery, merge policy, dependency dispatch, or existing task recovery behavior.
- No implementation, configuration changes, or runtime behavior changes belong in this planning PR.

## Current code and integration points

| Area | Relevant files and behavior |
| --- | --- |
| Task editing | `web-ui/src/hooks/use-task-editor.ts` loads and saves `baseRef`, and closes the editor outside backlog. |
| Task forms | `web-ui/src/components/task-create-dialog.tsx` and `task-inline-create-card.tsx` expose task options. Trace the backlog edit rendering before adding the checkbox. |
| Board data | `src/core/api-contract.ts`, `src/core/task-board-mutations.ts`, `web-ui/src/types/board.ts`, and `web-ui/src/state/board-state.ts` carry task fields and validation. Audit workspace persistence and CLI inputs too. |
| Browser start | `web-ui/src/hooks/use-task-sessions.ts` sends `baseRef` through both `workspace.ensureWorktree` and `runtime.startTaskSession`. |
| Runtime start | `src/trpc/runtime-api.ts` resolves task cwd, including a fallback that ensures a missing worktree. Audit shell, automated dispatch, and resume callers separately. |
| Worktree API | `src/trpc/workspace-api.ts` delegates ensure requests to `ensureTaskWorktreeIfDoesntExist`; `src/trpc/app-router.ts` validates requests. |
| Worktree setup | `src/workspace/task-worktree.ts` reuses existing worktrees, then rechecks inside `withTaskWorktreeSetupLock`. It resolves the base commit locally before creating a detached worktree, with preservation and saved-patch restoration paths. |
| Existing Git sync | `src/workspace/git-sync.ts` uses `fetch --all --prune` and `pull --ff-only` for the current checkout. Reuse Git execution/error conventions, but do not blindly invoke this current-checkout pull for a different selected base. |
| Regression coverage | `test/runtime/task-worktree.test.ts`, `test/integration/task-worktree.integration.test.ts`, task session/start tests, and `web-ui/src/hooks/use-task-editor.test.tsx`. |

The implementation must trace every worktree creation caller. A generic ensure call from opening a shell or inspecting a
task must not silently consume or trigger the initial-start refresh. Conversely, an early ensure on a genuine initial
start must not create a stale worktree before the runtime refresh gets a chance to run.

## User experience and persistence

1. Place an accessible checkbox directly below the base ref selector: **Update base ref before starting**.
2. Optional helper text: “Fetch origin and fast-forward the base branch before creating this task's worktree.”
3. Default new tasks and legacy tasks without the field to `true`; retain explicit `false`.
   Do not implement this as a browser-only preference or use truthy fallback that overwrites false.
4. Save the value with the task. Backlog editing loads the saved value; changing the selected branch does not reset it.
5. Show “Updating base ref…” while the runtime prepares a fresh start. Disable duplicate start submissions.
6. A blocked update keeps the task in backlog, does not send its prompt, and shows the selected ref, reason, and remedy.
   If the existing flow moves the card optimistically, restore it through the established start-failure handling.
7. Existing started tasks, including those returned to backlog, do not receive another base update. Hide or disable this
   initial-start setting for them with a short explanation if they are editable.

## Start lifecycle and once-only behavior

Refresh is a prerequisite of the first real start, not a reaction to a column change alone.

Under a lock scoped to the canonical Git common directory (shared by linked worktrees):

1. Re-read the persisted task policy and lifecycle state. Reject stale or mismatched task/base requests.
2. Recheck for a valid existing task worktree and durable preservation/saved-patch history.
3. For a fresh task with the option enabled, perform the refresh described below.
4. Resolve the post-refresh base commit once and pass that immutable SHA into detached worktree creation.
5. Prepare its environment and durably record the initial base SHA/start preparation before sending the first prompt.
6. Launch the requested agent only after preparation succeeds. Finish the normal transition to In Progress.

Use a durable preparation record or existing durable metadata extended for this purpose; a browser flag or in-memory
“already fetched” set is insufficient. Record the selected ref, option, resolved SHA, and successful preparation state.
Persist before launching the agent so a server restart does not cause a second refresh or lose the chosen baseline.

Failures before successful worktree preparation are retryable and may fetch again. An existing valid worktree after
partial setup must be reconciled and pinned, not recreated from a newer base. If a successfully prepared task later has
no live worktree, restore its recorded baseline or preserved work; never silently refresh and choose a different SHA.
If required recovery state is unavailable, block with an actionable error.

Preservation refs, saved patches, trash restore, restarts, review follow-ups, and subsequent prompts always retain their
existing baseline and work. Inspect restoration before refresh, rather than retaining the current base-resolution-first
ordering. Existing historical tasks without the new record must be recognized using current durable session,
preservation, patch, and delivery records; do not classify “directory missing” as “never started.”

An unchecked fresh task follows current local base resolution with no refresh-related network operation.

## Git update semantics

The desired effect is `git fetch origin` plus a pull of the **selected base**, with fast-forward-only behavior.
Do not run an unrestricted `git pull`, switch the primary checkout, rebase, reset, force-update, or auto-stash.

### Supported ref policy

| Selected ref | Checked behavior |
| --- | --- |
| Local branch tracking an origin branch | Fetch origin, then fast-forward that local branch to its configured origin tracking target. Respect differing local/remote names. |
| Local branch without upstream | If a same-name origin branch exists after fetch, use it explicitly without changing upstream configuration. Otherwise block and explain how to configure tracking or uncheck. |
| Local branch tracking another remote | Block with a clear explanation; this feature is explicitly origin-based. User can uncheck to use local state. |
| Explicit origin remote-tracking ref | Fetch origin and resolve that refreshed remote ref; no local branch pull is applicable. |
| Tag, commit SHA, or another non-branch ref | Block with an explanation that this option needs an origin-backed branch; unchecking allows current supported local ref behavior. |
| Missing origin or missing remote branch | Block. Do not use stale cached refs or silently substitute the repository default branch. |

Ref classification must be unambiguous. Validate refs and pass arguments as arrays through the existing Git runner;
never interpolate selected refs into a shell command. Ensure the specific target remote ref was refreshed even with
restricted/custom fetch refspecs; report a missing target rather than accepting a cached ref.

### Safely updating a local branch

- Inspect `git worktree list --porcelain` to locate any checkout of the selected branch.
- If checked out, require that checkout to have no tracked changes, staged changes, untracked files, or merge/rebase
  operation in progress. Fast-forward there using the fetched target SHA, equivalent to `pull --ff-only` after fetch.
  Recheck state and branch identity immediately before mutation.
- If not checked out, update only its branch ref using a compare-and-swap `git update-ref` with the old SHA.
  Verify the old local commit is an ancestor of the fetched target before moving it.
- Equal tips are a successful no-op. A strictly local-ahead branch or diverged history blocks when checked:
  “The base branch has local commits not on origin. Push or reconcile it, or disable the update option.”
  This avoids pretending a checked task started from the current origin tip.
- Never update a branch through `update-ref` while it is checked out. Never checkout the selected branch in an unrelated
  workspace simply to run pull. A dirty unrelated checkout does not block updating a clean, unoccupied base branch.
- Detect concurrent external changes and fail safely rather than overwrite them. The application lock serializes Kanban
  operations, but Git ref compare-and-swap and checkout checks are still required.
- Bound network/command time and use existing noninteractive credentials. Do not open a hidden credential prompt.
  Scrub credentials from errors and logs.

Fetch can change remote-tracking refs even when a later step fails; it must not change local file contents on failure.
If a base branch update succeeds but later worktree preparation fails, leave that legitimate fast-forward in place and
report the preparation failure. Never roll the base branch back automatically.

## Failure reporting and observability

Use structured failure categories for missing origin/target, unsupported ref, dirty checkout, local-ahead/divergence,
authentication/network timeout, concurrent ref changes, and worktree setup failure. Include safe Git diagnostics and a
specific remedy. There is no silent stale-base fallback; users can explicitly uncheck and retry.

Log timestamped preparation stages with task ID, selected ref, remote target, old/new SHA, duration, and outcome.
Use existing runtime logging conventions and redact tokens/credential-bearing URLs. A fetch/pull status is preparation
progress, not evidence that an agent is running or that a task has completed.

## Implementation slices

Expected size: two focused implementation PRs after this plan is reviewed. Keep both under this folder when creating
execution documents; no generic repository-management redesign is required.

Task-level breakdown (one file per task in this folder):

| Task | Title | Depends on |
| --- | --- | --- |
| [UPDBASE-0](./UPDBASE-0.md) | Persist the `updateBaseRefBeforeStart` task policy | — |
| [UPDBASE-1](./UPDBASE-1.md) | Base-refresh module: ref classification and bounded fetch | — |
| [UPDBASE-2](./UPDBASE-2.md) | Base-refresh module: safe local-branch update | UPDBASE-1 |
| [UPDBASE-3](./UPDBASE-3.md) | Durable initial-start preparation/baseline record | — |
| [UPDBASE-4](./UPDBASE-4.md) | Runtime fresh-start preparation integration | UPDBASE-0, UPDBASE-1, UPDBASE-2, UPDBASE-3 |
| [UPDBASE-5](./UPDBASE-5.md) | Caller audit, start-failure semantics, and observability | UPDBASE-4 |
| [UPDBASE-6](./UPDBASE-6.md) | Runtime and Git integration test coverage (first-PR gate) | UPDBASE-0 through UPDBASE-5 |
| [UPDBASE-7](./UPDBASE-7.md) | Checkbox in backlog editing and creation surfaces | UPDBASE-0 + merged runtime PR |
| [UPDBASE-8](./UPDBASE-8.md) | Start progress and failure UX | UPDBASE-5, UPDBASE-7 |
| [UPDBASE-9](./UPDBASE-9.md) | End-to-end verification, documentation, and plan consistency | UPDBASE-7, UPDBASE-8 |

### 1. Runtime preparation, policy, and Git integration

- Add the backward-compatible persisted boolean and carry it through board mutations, API contracts, serialization,
  CLI/API defaults, and automated task creation.
- Introduce a small base-refresh helper with the explicit ref policy, command bounds, safe errors, and branch updates.
- Integrate the helper into runtime-owned fresh-start worktree preparation and cover all agent/dispatch entry points.
- Add durable baseline/preparation tracking and skip refresh for existing or recoverable task work.
- Ensure generic workspace inspection, shell opening, and non-start ensure calls cannot bypass fresh-start preparation.
- Add real local-Git integration coverage and runtime start/failure tests.

### 2. Checkbox, start progress, and end-to-end verification

- Add the checkbox and editor/create state; preserve false across every UI save/create path.
- Wire progress and failure feedback through existing task-start handling.
- Verify checked and unchecked starts, backlog rollback, refresh retries, automated starts, and resume behavior.
- Update relevant user documentation and keep this master plan consistent with the implementation.

If task breakdown later favors a single PR, these remain two reviewable sections within it. Do not merge a UI that
promises refresh before runtime support exists.

## Acceptance and test matrix

Use temporary repositories with a local bare origin and a second clone to advance remote branches. Integration tests
must not depend on external networking. Follow AGENTS.md's isolation requirements for workspace/preservation state.

| Scenario | Required result |
| --- | --- |
| Origin advances a stale local feature base | First task worktree HEAD equals the new origin SHA; local base fast-forwards; first prompt runs afterward. |
| Checkbox unchecked | No refresh fetch/update; worktree starts at the existing local SHA. |
| New and legacy task defaults | Checked; explicit false survives schema normalization, persistence, and reload. |
| Save/edit, inline, multi-create, CLI/API, child creation | Correct policy is persisted and honored by the runtime. |
| Checked-out clean base versus an unoccupied base | Both update safely without switching an unrelated checkout. |
| Dirty selected checkout, staged/untracked files, active operation | Start blocked; files and local base remain intact. |
| Different tracking branch name, no upstream with same-name origin | Intended origin target is used; no upstream settings are rewritten. |
| Local-ahead, diverged, other remote, missing origin/branch, pinned ref | Clear block and remedy; no stale fallback, forced reset, merge, or agent prompt. |
| Explicit origin ref and restricted fetch refspec | Correct remote target is refreshed or start blocks. |
| Existing worktree, review retry, restart, trash restore, saved patch | No refresh/recreation; task HEAD and work survive remote advancement. |
| Prepared baseline but missing worktree | Recover pinned task state or block; never switch to a newer base. |
| Double start and two tasks sharing a repo | Lock serializes refresh/create; each uses its own resolved immutable SHA. |
| Network failure or timeout | No task worktree/prompt; task remains backlog; retry succeeds after fault removal. |
| Crash after worktree creation or preparation persistence | Retry reconciles worktree and durable baseline without discarding work. |
| Shell/inspection before initial start | No premature stale worktree creation that bypasses the start refresh. |
| Ref or checkout changes outside Kanban during preparation | Detect and block without overwriting the external change. |

For implementation PRs run targeted runtime and web tests, Git integration tests, typechecks, and the repository's
required checks. Match Biome configuration for all supported source files; do not use Prettier to rewrite the repo.
Markdown is excluded by the current Biome include list; review headings, tables, links, whitespace, and final newline.

Manual validation: advance a feature branch remotely, edit a backlog task to select its stale local branch, leave the
checkbox checked, and start it. Confirm the base and detached worktree match the fetched tip. Repeat unchecked, then
resume the first task after another remote advance and confirm its worktree is unchanged. Exercise a blocked dirty or
diverged base and confirm no agent prompt was sent.

## Deployment and settings

This plan-only PR requires no environment variables, secrets, migrations, or deployment actions.
The future implementation uses existing Git origin credentials and connectivity; it introduces no new credentials.
Its per-task default is enabled, including unstarted legacy tasks. Any added durable preparation state must migrate
backward-compatibly and survive runtime restarts. Document the final state format and rollout behavior in the
implementation PR.
