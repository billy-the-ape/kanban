# Sidebar project pills: Paused state and the stale Review count fix

Status: implemented. Target: `billy-the-ape/kanban` `main`. Source baseline: `879a3a1`.

Order: **1 of 2** in `docs/plans/complete/sidebar-updates/`. Implement `paused-pill.md` before `tasks-tab.md`. This plan has no dependencies. `tasks-tab.md` depends on the shared module and the registry refactor introduced here. One implementation PR / one squash commit. Desktop collapse is being handled separately by the user.

The behavior and boundaries are defined below. Symbol names are the navigation anchors; line numbers describe the source baseline and may shift. Before coding, read `AGENTS.md` and inspect these symbols on the implementation branch. Preserve changes that have landed since the baseline. If current behavior conflicts with a decision here, report that specific conflict before changing scope.

## Problem and required outcome

The sidebar shows per-project task pills under each project name (`B | 7`, `IP | 2`, `R | 1`, `D | 21`, `T | 1`). There are two gaps:

1. **No Paused state.** An In Progress card whose agent stopped working (the task is queued waiting for a slot, the user pressed the pause/cancel button in the chat composer, the session was interrupted, or the agent failed) still counts as `IP`. The user wants `IP` to mean "an agent is working on this right now" and wants stopped cards shown as a separate yellow `P | n` pill.
2. **Bug: wrong purple `R` pill for projects that are not open.** A card that went from In Review back to In Progress (the user sent a follow-up message, which moves it back automatically) keeps showing as `R` in another project's pills.

Required outcome:

- A new display state, **Paused**, shown as a yellow pill `P | n` between `IP` and `R`.
- Paused is a **display state only**. No new board column, lane or persisted session-state value, and no change to card movement or board UI. Paused cards stay in the In Progress column. The persistence changes below prevent stale summaries from overwriting current ones.
- `IP + P` always equals the number of cards in the In Progress column minus the cards counted as `R` because their agent finished (see the classification table below).
- For identical board and effective-session inputs, browser and server counts are identical. The open project can temporarily be ahead because its board has unsaved changes.
- The stale-`R` bug is fixed at its cause, with a regression test.

## Root cause of the stale `R` bug (verified by reading the code)

- For the **open** project, `useProjectUiState` (`web-ui/src/hooks/use-project-ui-state.ts:46-59`) replaces the server counts with `countTasksByColumn(board)` from the local board. That path counts columns only, so it is correct.
- For **every other** project, counts come from the server: `summarizeProjectTaskCounts` (`src/server/workspace-registry.ts:279-301`) loads the persisted board and then runs `applyLiveSessionStateToProjectTaskCounts` (`:128-152`). That function moves an In Progress card into the Review count when its session summary says `awaiting_review`. This exists because nobody moves cards on the board for a project that is not open in a browser.
- The session summaries come **only** from `terminalManager.listSummaries()`. The terminal session manager for a workspace is filled once from the persisted `sessions.json` by `hydrateFromRecord` (`src/terminal/session-manager.ts:245-259`, called from `workspace-registry.ts:228`). Native Cline tasks never run through the terminal manager. Their live summaries live in `ClineTaskSessionService`, which the runtime state hub tracks per workspace in `clinePreviousSummaryByWorkspaceId` (`src/server/runtime-state-hub.ts:67, 497-506`). So for Cline tasks the terminal manager holds a **frozen copy from when the workspace was first loaded**.
- Sequence that produces the bug: the task is in Review (`awaiting_review`) when the workspace's terminal manager is hydrated → the user sends a follow-up → the Cline session goes `running` and the browser moves the card to In Progress → the user switches to another project → the server counts that card with the frozen `awaiting_review` copy → purple `R`.
- The frozen copy also spreads. `workspace.saveState` (`src/trpc/workspace-api.ts:448-450`) overwrites every session summary the browser sends with the terminal manager's copy before writing `sessions.json`. So the fresh `running` summary the browser sends is replaced by the frozen `awaiting_review` one on every save, and the stale state survives runtime restarts. `buildWorkspaceStateSnapshot` (`workspace-registry.ts:303-313`) does the same overlay when a project is loaded.

The fix has two parts:

- (a) Summaries from the terminal manager, the Cline service, the browser and disk are merged with a **newest `updatedAt` wins** rule, never a blind overwrite.
- (b) Server-side counts read the Cline service's live summaries.

## Decisions

1. **Display states.** `backlog | in_progress | paused | review | done | trash`. The board column decides the state except in In Progress. For In Progress, the state comes from the card's effective session summary:

   | Column | Effective session summary | Display state |
   | --- | --- | --- |
   | `in_progress` | none, or a placeholder (see below) | `in_progress` (avoids a flash of Paused before a just-started session reports) |
   | `in_progress` | `state === "running"` and queued for a concurrency slot (`latestHookActivity?.hookEventName === "concurrency_waiting"`) | `paused` |
   | `in_progress` | `state === "running"`, not queued | `in_progress` |
   | `in_progress` | `state === "awaiting_review"` | `review` (keeps today's behavior for projects that are not open) |
   | `in_progress` | `state` is `"idle"`, `"interrupted"` or `"failed"` | `paused` |
   | any other column | any | the column id |

   A **placeholder** summary is one with `state === "idle" && startedAt === null && agentId === null`. `TerminalSessionManager` creates one through `createDefaultSummary` (`src/terminal/session-manager.ts:109-127`, stamped `updatedAt: now()`) when a terminal is attached for a task with no entry (`:977`). It describes no session, so it never classifies a card as Paused.

   `idle` is what the composer's pause button produces (`cancelTaskTurn`, `src/cline-sdk/cline-task-session-service.ts:1004-1033`). `interrupted` comes from stop/abort and runtime shutdown. `failed` counts as Paused because the agent is not working. A queued task (waiting for a concurrency slot) counts as Paused because no agent is working on it yet. The queued check precedes the general running check and only applies while `state === "running"`.
2. **Counts shape.** `RuntimeProjectTaskCounts` gains a required `paused: number`. `in_progress` now means display state `in_progress` only. Paused cards are **not** also counted in `in_progress`.
3. **Pill.** Order `B, IP, P, R, D, T`. Paused pill: `id: "paused"`, `title: "Paused"`, `shortLabel: "P"`, `toneClassName: "bg-status-gold/20 text-status-gold"`. Like the other pills, it is hidden when its count is 0, and the selected project row uses its existing `bg-accent-fg/20 text-accent-fg` override.
4. **Merge rule.** For one task, a real summary always beats a placeholder, regardless of timestamp or source order. If both are real, or both are placeholders, keep the one with the larger `updatedAt`; on a tie, keep the **later-listed source**. With no current summary, keep the candidate. Select the complete winning object, without merging individual fields, changing its timestamp, or mutating either source. This preserves session identity and checkpoint fields. Use the shared helper in the count, snapshot, save and browser-summary paths listed below.
5. **Server effective sessions** for a workspace, merged in this order (later wins ties): persisted `sessions.json` → terminal manager `listSummaries()` (if a manager exists) → the hub's latest Cline summaries for that workspace (if tracked).
6. **No board-card visual change.** The card's status marker (`web-ui/src/components/board-card.tsx:449-462`) is out of scope.
7. **Meaning and limits.** Cards without a real summary remain `IP`; this is the existing optimistic behavior, so the pill is not proof of an active process. Queued tasks count as Paused, as specified above. An explicit Review column still wins over a running summary. Failed tasks display as Paused without clearing their error details. This plan fixes future stale-summary overwrites; it does not invent missing history, repair already-corrupted timestamps, or change startup recovery after an unclean shutdown.

## Existing implementation map

- `src/core/api-contract.ts:481-488`: `runtimeProjectTaskCountsSchema`.
- `src/server/workspace-registry.ts`: `createEmptyProjectTaskCounts` (`:80`), `countTasksByColumn` (`:90`), `applyLiveSessionStateToProjectTaskCounts` (`:128`), `summarizeProjectTaskCounts` (`:279`), `buildWorkspaceStateSnapshot` (`:303`), dependency interface `CreateWorkspaceRegistryDependencies` (`:23`).
- `src/state/workspace-state.ts:346-350`: private `readWorkspaceSessions(workspaceId)`. `loadWorkspaceBoardById` at `:343` is the public pattern to copy.
- `src/server/runtime-state-hub.ts`: `trackClineTaskSessionService`, `clinePreviousSummaryByWorkspaceId` (`:67`), `RuntimeStateHub` interface (`:44-62`), `disposeWorkspace`, `close`.
- `src/cli.ts:409-422`: `runtimeStateHub` is a `let` assigned after `createWorkspaceRegistry`. Registry dependencies that need the hub must be late-bound closures, like `onTerminalManagerReady`.
- `src/trpc/workspace-api.ts:443-450`: `saveState` overwrite; dependency wiring is in `createWorkspaceApi` in `src/server/runtime-server.ts`.
- `src/state/workspace-state.ts`: `saveWorkspaceState` writes sessions inside the workspace directory lock. Preserve the revision-conflict check and server-owned card-field merges.
- Browser summary merges: `web-ui/src/runtime/use-runtime-state-stream.ts` (`mergeTaskSessionSummaries`), `web-ui/src/hooks/home-sidebar-agent-panel-session-summary.ts` (`selectNewestTaskSessionSummary`, used by `use-workspace-sync.ts` and `use-task-sessions.ts`). Their tie rules currently differ.
- `web-ui/src/hooks/app-utils.tsx:23-59`: browser `countTasksByColumn`. Its only caller is `use-project-ui-state.ts:50`.
- `web-ui/src/hooks/use-project-ui-state.ts`: open-project count override. Called from `web-ui/src/App.tsx:265`, where `sessions` (`App.tsx:87`) is in scope.
- `web-ui/src/components/project-navigation-panel.tsx`: `TaskCountBadge` (`:40`), pill array in `ProjectRow` (`:700-736`), removal-dialog total (`:96-103`).
- Shared runtime modules reach the web UI through aliases. Each alias needs three entries: `web-ui/vite.config.ts:81-91`, `web-ui/vitest.config.ts`, `web-ui/tsconfig.json` `paths` (see `@runtime-task-title`).

## Implementation

### 1. Shared module `src/core/task-display-state.ts` (new)

Imports types only from `./api-contract`. No Node imports, because the web UI imports it.

```ts
export type RuntimeTaskDisplayState = "backlog" | "in_progress" | "paused" | "review" | "done" | "trash";

export const PAUSED_TASK_SESSION_STATES: ReadonlySet<RuntimeTaskSessionState> = new Set([
	"idle",
	"interrupted",
	"failed",
]);

export function resolveTaskDisplayState(
	columnId: RuntimeBoardColumnId,
	summary: RuntimeTaskSessionSummary | null | undefined,
): RuntimeTaskDisplayState;

export function createEmptyTaskCounts(): RuntimeProjectTaskCounts; // all six keys = 0

export function countTasksByDisplayState(
	board: RuntimeBoardData,
	sessionsByTaskId: Readonly<Record<string, RuntimeTaskSessionSummary>>,
): RuntimeProjectTaskCounts;

export function isPlaceholderSessionSummary(summary: RuntimeTaskSessionSummary): boolean; // decision 1 definition

export function pickNewerSessionSummary(
	current: RuntimeTaskSessionSummary | undefined,
	candidate: RuntimeTaskSessionSummary,
): RuntimeTaskSessionSummary; // decision 4: real beats placeholder, then newer wins, then candidate wins ties

export function mergeSessionSummaries(
	...sources: ReadonlyArray<Iterable<RuntimeTaskSessionSummary>>
): Record<string, RuntimeTaskSessionSummary>; // folds sources in order with pickNewerSessionSummary, keyed by taskId
```

`resolveTaskDisplayState` implements the decision 1 table exactly. `countTasksByDisplayState` iterates every card of every column and increments the key named by its display state.

Add the alias `@runtime-task-display-state` → `../src/core/task-display-state.ts` to all three web-UI config files.

### 2. Contract

In `runtimeProjectTaskCountsSchema`, add `paused: z.number()` between `in_progress` and `review`. Update every fixture that builds task counts. tsc finds the typed ones. Also grep `test/` and `web-ui/src` for `trash: 0` and `in_progress:` to find untyped ones. Known files: `test/runtime/server/workspace-registry.test.ts`, `test/runtime/trpc/projects-api.test.ts`, `test/integration/runtime-state-stream.integration.test.ts`, `web-ui/src/components/project-navigation-panel.test.tsx`, `web-ui/src/hooks/use-project-ui-state.test.tsx`.

### 3. Persisted sessions reader

In `src/state/workspace-state.ts`, export `loadWorkspaceSessionsById(workspaceId: string): Promise<Record<string, RuntimeTaskSessionSummary>>`, which returns `readWorkspaceSessions(workspaceId)`.

### 4. Hub exposes latest Cline summaries

In `RuntimeStateHub`, add `listClineTaskSessionSummaries(workspaceId: string): RuntimeTaskSessionSummary[]`. Keep a workspace-keyed map of the services already registered by `trackClineTaskSessionService`, and return the registered service's `listSummaries()` or `[]`. Reading this accessor must not instantiate a service or hydrate task transcripts. Clear the service reference in `disposeWorkspace` and `close`.

Do not use `clinePreviousSummaryByWorkspaceId` as the read source: it is an event-comparison cache, and `rebindPersistedTaskSession` can change the service's summaries without emitting `onSummary`. Keep that cache for its existing transition detection.

### 5. Workspace registry

- Add an optional dependency `getClineTaskSessionSummaries?: (workspaceId: string) => RuntimeTaskSessionSummary[]` to `CreateWorkspaceRegistryDependencies`. In `src/cli.ts`, pass `(workspaceId) => runtimeStateHub?.listClineTaskSessionSummaries(workspaceId) ?? []`.
- Add a private `loadEffectiveTaskSessions(workspaceId): Promise<Record<string, RuntimeTaskSessionSummary>>`. It calls `mergeSessionSummaries` with these sources, in order:
  1. `Object.values(await loadWorkspaceSessionsById(workspaceId))`
  2. `getTerminalManagerForWorkspace(workspaceId)?.listSummaries() ?? []`
  3. `deps.getClineTaskSessionSummaries?.(workspaceId) ?? []`
- Add a private `loadProjectTaskSnapshot(workspaceId): Promise<{ board: RuntimeBoardData; sessions: Record<string, RuntimeTaskSessionSummary> }>`, loading the board and `loadEffectiveTaskSessions` in parallel. It must not create a terminal manager or Cline service. `tasks-tab.md` reuses it, so keep it a named function inside `createWorkspaceRegistry`.
- `summarizeProjectTaskCounts`: replace the body with `countTasksByDisplayState(snapshot.board, snapshot.sessions)`. Keep the existing cache-on-success and fallback-on-throw behavior (`projectTaskCountsByWorkspaceId`). Use `createEmptyTaskCounts()` from the shared module.
- Delete the local `createEmptyProjectTaskCounts`, `countTasksByColumn` and `applyLiveSessionStateToProjectTaskCounts`. They are fully replaced.
- `buildWorkspaceStateSnapshot`: after the existing manager initialization, merge `response.sessions` → terminal manager summaries → the registered Cline service summaries. Reuse the same source order as counts; keep the rest of the workspace response unchanged.

### 6. `saveState` overwrite fix

- Add an optional `getClineTaskSessionSummaries` dependency to `CreateWorkspaceApiDependencies`, matching the registry callback. Wire it to `deps.runtimeStateHub.listClineTaskSessionSummaries` in `src/server/runtime-server.ts`. This reads tracked services only; do not call `getScopedClineTaskSessionService` just to save a board.
- Replace the blind loop with a new sessions record merged in this order: browser input → terminal manager → registered Cline service. Pass a copied input object to `saveWorkspaceState`; do not mutate the request. A newer paused/running Cline summary must beat an older browser or hydrated-manager copy, even if the browser has not received the stream event yet.
- In `saveWorkspaceState`, **inside the existing directory lock**, read the current persisted sessions and merge them → the supplied sessions record before writing. This closes the remaining disk-overwrite gap, including callers outside tRPC. A disk-only summary (its task id is absent from the supplied sessions record) is kept only when that task id is a card on the board being saved; otherwise it is dropped. This rule only keeps the new disk merge from retaining more than today's save does. It does **not** make Clear Trash prune `sessions.json`: today the terminal manager and the Cline service still hold trashed ids (the manager has no per-task delete; `ClineTaskSessionService.clearTaskSession` resets rather than deletes), and `saveState` copies them back in, both before and after this change. That leak is pre-existing and out of scope here. Ids present in the supplied record (including non-card home/shell terminal sessions) are never dropped by this rule. Keep the existing revision-conflict behavior and atomic writes.
- Tie order for the complete save path is therefore disk → browser → terminal → Cline. Terminal and Cline live copies win ties over browser input. Do not claim terminal state is always newer: compare timestamps, and retain the placeholder exception.

### 7. Browser counts for the open project

- Delete `countTasksByColumn` from `web-ui/src/hooks/app-utils.tsx` and its test cases in `app-utils.test.tsx`, if any.
- `useProjectUiState` takes a new required input `sessions: Record<string, RuntimeTaskSessionSummary>` and computes `countTasksByDisplayState(board, sessions)` (imported from `@runtime-task-display-state`). Add `sessions` to the `useMemo` dependencies. Pass `sessions` from `App.tsx`.
- Replace the runtime stream's private timestamp comparison with `pickNewerSessionSummary`, and make `selectNewestTaskSessionSummary` a null-aware wrapper around the same helper (`left` is current, `right` is candidate). Preserve its callers and the no-change return optimization in `useTaskSessions`. Workspace hydration and stream deltas must follow the same real/placeholder and tie rules as server counts. Preserve existing workspace-boundary resets; never merge summaries across projects.

### 8. Pill rendering

- Move the pill definition out of `ProjectRow` into a new `web-ui/src/components/project-task-count-badges.ts`, which exports:
  - `TASK_DISPLAY_STATE_ORDER: readonly RuntimeTaskDisplayState[]` = `["backlog", "in_progress", "paused", "review", "done", "trash"]`.
  - `TASK_DISPLAY_STATE_BADGE_META: Record<RuntimeTaskDisplayState, { title: string; shortLabel: string; toneClassName: string }>`. It holds today's five entries verbatim (Backlog/B, In Progress/IP, Review/R with `accent-2`, Done/D, Trash/T) plus the Paused entry from decision 3.
  - `buildProjectTaskCountBadges(counts: RuntimeProjectTaskCounts): TaskCountBadge[]`. It maps `TASK_DISPLAY_STATE_ORDER` through the meta, takes `count` from `counts[state]`, and drops zero counts. The `TaskCountBadge` interface moves here.
  - `ProjectRow` calls `buildProjectTaskCountBadges(project.taskCounts)`. `tasks-tab.md` reuses the order and meta.
- Removal dialog total (`project-navigation-panel.tsx:96-103`): add `taskCounts.paused` to the sum.

## Final implementation notes (deviations from this plan)

- The landed live-owner resolver `resolveWorkspaceSessionSummaries` (`src/core/workspace-session-summaries.ts`) is the single server-side merge used by `summarizeProjectTaskCounts`, `buildWorkspaceStateSnapshot`, and `saveState`, instead of calling `mergeSessionSummaries` directly. It preserves the landed behaviors: a live terminal process always wins for its task, orphaned `running` summaries (no active process) are reconciled to `interrupted`, and tracked live Cline summaries always win (they own the runtime).
- The decision 4 real-beats-placeholder rule was added to that helper, so placeholder handling is identical across counts, snapshots, saves, and browser merges.
- The helper's persisted-vs-terminal timestamp comparison was tightened from strict `>` to `>=` so equal-`updatedAt` ties follow decision 5's "later-listed source wins" rule (the live terminal copy wins). The strict `>` was pre-existing, but it was the one server-side spot where the unified tie rule did not hold.
- `saveWorkspaceState` performs the disk merge (`mergeSessionsForSave`) inside the existing workspace directory lock: disk -> supplied, with the board-card retention rule from section 6.
- Consequence of the landed reconciliation: a persisted `running` summary with no live process classifies as Paused (interrupted), so the placeholder regression test exercises the live-process case for `in_progress` and the no-process case for `paused`.
- The navigation-panel pill tone assertion uses a non-current project, because the selected project row intentionally overrides badge tones with `bg-accent-fg/20 text-accent-fg` (decision 3).

## Tests

- `test/runtime/core/task-display-state.test.ts` (new):
  - The full decision 1 table, one case per row, including queued `running` (`concurrency_waiting`) → `paused`, other `running` → `in_progress`, and `failed`/`idle`/`interrupted` → `paused`. A running task with null hook activity is not queued.
  - `countTasksByDisplayState` over a mixed board: `in_progress + paused + review-from-in_progress` equals the In Progress column length.
  - `pickNewerSessionSummary` tie and older/newer cases; a newer placeholder loses to an older real summary **in either source order**; two placeholders use timestamps/ties; no current summary keeps the candidate. Inputs are unchanged and the complete winning object's identity/checkpoints are retained.
  - An In Progress card whose only summary is a placeholder classifies as `in_progress`, not `paused`.
  - `mergeSessionSummaries` with three sources.
- `test/runtime/server/workspace-registry.test.ts`:
  - Add `loadWorkspaceSessionsById` to the `workspace-state` mock.
  - **Regression test for the bug:** the terminal manager's `listSummaries` returns a Cline summary `{ taskId: "task", agentId: "cline", state: "awaiting_review", updatedAt: 100 }`, the board has `task` in `in_progress`, and `getClineTaskSessionSummaries` returns `{ state: "running", updatedAt: 200 }`. Expected counts: `in_progress: 1, review: 0`.
  - The same setup with the Cline summary `state: "idle"`: expected `paused: 1, in_progress: 0`.
  - A live queued running summary counts as Paused; a newer running summary with the waiting hook replaced counts as In Progress. Exercise both snapshot and counts to catch stale queue metadata.
  - A terminal-agent task whose terminal summary is newer than disk is classified from the terminal summary.
  - A just-attached terminal placeholder (`createDefaultSummary` shape, newest `updatedAt`) over an older persisted `running` summary still counts as `in_progress`.
  - `buildWorkspaceStateSnapshot` keeps a newer disk summary over an older terminal-manager one; a still-newer live Cline summary wins in both snapshot and counts. A counts read for an untracked project creates no manager/service.
- `test/integration/runtime-state-stream.integration.test.ts`: the new hub accessor sees registered service changes without an `onSummary` event, returns `[]` for an untracked/disposed workspace, and does not start services. Update hub mocks where needed.
- `test/runtime/trpc/workspace-api.test.ts`: `saveState` with browser `running` at 200 and manager `awaiting_review` at 100 persists the browser's; reverse timestamps and the manager wins. A live Cline `idle` at 300 beats both. The request's sessions object is unchanged, and no scoped Cline service is created for this read.
- `test/integration/workspace-state.integration.test.ts`: use isolated temporary workspace storage. Saving an older supplied summary cannot replace newer disk state; a newer supplied summary wins; absent ids preserve disk summaries only for cards still on the saved board, and a disk-only id that is neither supplied nor on the board is dropped; a supplied non-card id (home terminal) is kept; revision-conflicting saves still reject without writing. Exercise `saveWorkspaceState` directly so this test proves the locked persistence path.
- `web-ui/src/hooks/use-workspace-sync.test.tsx` and `use-task-sessions.test.tsx`: older real state cannot regress, newer real state beats a placeholder, and incoming real summaries win equal-timestamp ties. Cover the runtime-stream merge in its integration suite as well.
- `web-ui/src/hooks/use-project-ui-state.test.tsx`: the open project's counts reflect `paused` from local `sessions`. The other projects' server counts pass through unchanged.
- `web-ui/src/components/project-navigation-panel.test.tsx`: a project with `paused: 2` renders a `P` pill with text `2`, title `Paused`, the `text-status-gold` class, positioned after `IP` and before `R`. `paused: 0` renders no `P` pill.

Run `npm run typecheck`, `npm run web:typecheck`, `npm run test:fast`, `npm run web:test`, and `npx @biomejs/biome check` on the touched files before pushing.

Also run `npx vitest run test/integration/workspace-state.integration.test.ts test/integration/runtime-state-stream.integration.test.ts`: these regression suites are outside `test:fast`. During implementation, run the affected tests first, then the required broader checks once the change is complete. Follow the repository's Biome settings; do not apply Prettier or reformat unrelated files.

## Acceptance criteria

- Pausing a running Cline task in project A and switching to project B: A's row shows `P | 1` in yellow, and `IP` drops by 1.
- Sending a message resumes that task; while queued it remains `P`, then becomes `IP` within one projects broadcast after model capacity is granted and the waiting hook is cleared/replaced.
- A task taken from Review back to In Progress by a follow-up message shows as `IP` in its project's pills while another project is open, including after a runtime restart.
- Open-project and other-project counts for the same board and sessions are identical.
- Snapshot, browser stream and save paths cannot restore an older real state or let a terminal placeholder mask real state. Verify counts after save/reload with the live service unavailable, not only through an injected live-summary mock.
- No board column, lane, drag rule or card visual changes.

## Deployment and implementation handoff

No new environment variables or configuration. Rebuild both runtime and web UI together (`npm run build`) and restart the normal Kanban service; reload existing browser tabs so the counts contract and UI match. No device changes are part of this implementation PR.

The implementation PR description must list the behavior changes, validation results, and manual acceptance steps above, with these deployment actions prominently stated. Mark the PR ready for review after checks pass. If a check is blocked or fails, report the exact result instead of claiming it passed. Keep this plan as the source of scope; do not turn the numbered implementation sections into additional PRs.

## Out of scope

- Board card markers for paused cards.
- A Paused column or filter on the board.
- Changing which session states the browser uses to move cards (`use-board-interactions.ts:584-635`).
- Pruning trashed tasks' summaries from `sessions.json` after Clear Trash. Live terminal-manager and Cline-service entries survive Clear Trash today and are copied back on save; fixing that needs per-task delete APIs on both and is a separate change.
