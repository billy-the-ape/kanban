# Sidebar project pills: Paused state and the stale Review count fix

Status: implementation-ready plan. Target: `billy-the-ape/kanban` `main`. Source baseline: `879a3a1`.

Order: **1 of 3** in `docs/plans/sidebar-updates/`. Implement in this order: `paused-pill.md` → `tasks-tab.md` → `desktop-collapse.md`. This plan has no dependencies. `tasks-tab.md` depends on the shared module and the registry refactor introduced here. One PR / one squash commit.

All product decisions are made below. The implementer makes no product decisions.

## Problem and required outcome

The sidebar shows per-project task pills under each project name (`B | 7`, `IP | 2`, `R | 1`, `D | 21`, `T | 1`). There are two gaps:

1. **No Paused state.** An In Progress card whose agent stopped working (the user pressed the pause/cancel button in the chat composer, the session was interrupted, or the agent failed) still counts as `IP`. The user wants `IP` to mean "an agent is working on this right now" and wants stopped cards shown as a separate yellow `P | n` pill.
2. **Bug: wrong purple `R` pill for projects that are not open.** A card that went from In Review back to In Progress (the user sent a follow-up message, which moves it back automatically) keeps showing as `R` in another project's pills.

Required outcome:

- A new display state, **Paused**, shown as a yellow pill `P | n` between `IP` and `R`.
- Paused is a **display state only**. No new board column, no new lane, no change to card movement, persistence, or the board UI. Paused cards stay in the In Progress column.
- `IP + P` always equals the number of cards in the In Progress column minus the cards counted as `R` because their agent finished (see the classification table below).
- Counts are identical for the open project (computed in the browser) and for every other project (computed on the server), because both use the same function.
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
   | `in_progress` | `state === "running"`, including queued (`latestHookActivity.hookEventName === "concurrency_waiting"`) | `in_progress` |
   | `in_progress` | `state === "awaiting_review"` | `review` (keeps today's behavior for projects that are not open) |
   | `in_progress` | `state` is `"idle"`, `"interrupted"` or `"failed"` | `paused` |
   | any other column | any | the column id |

   A **placeholder** summary is one with `state === "idle" && startedAt === null && agentId === null`. `TerminalSessionManager` creates one through `createDefaultSummary` (`src/terminal/session-manager.ts:109-127`, stamped `updatedAt: now()`) when a terminal is attached for a task with no entry (`:977`). It describes no session, so it never classifies a card as Paused.

   `idle` is what the composer's pause button produces (`cancelTaskTurn`, `src/cline-sdk/cline-task-session-service.ts:1004-1033`). `interrupted` comes from stop/abort and runtime shutdown. `failed` counts as Paused because the agent is not working.
2. **Counts shape.** `RuntimeProjectTaskCounts` gains a required `paused: number`. `in_progress` now means display state `in_progress` only. Paused cards are **not** also counted in `in_progress`.
3. **Pill.** Order `B, IP, P, R, D, T`. Paused pill: `id: "paused"`, `title: "Paused"`, `shortLabel: "P"`, `toneClassName: "bg-status-gold/20 text-status-gold"`. Like the other pills, it is hidden when its count is 0, and the selected project row uses its existing `bg-accent-fg/20 text-accent-fg` override.
4. **Merge rule.** For one task, given two summaries, keep the one with the larger `updatedAt`. On a tie, keep the **later-listed source** in the merge order defined for that call site. Exception: a placeholder candidate never replaces an existing non-placeholder summary, whatever its `updatedAt`, because its fresh timestamp would otherwise mask real session state. This is one shared helper used everywhere summaries from two sources meet.
5. **Server effective sessions** for a workspace, merged in this order (later wins ties): persisted `sessions.json` → terminal manager `listSummaries()` (if a manager exists) → the hub's latest Cline summaries for that workspace (if tracked).
6. **No board-card visual change.** The card's status marker (`web-ui/src/components/board-card.tsx:449-462`) is out of scope.

## Existing implementation map

- `src/core/api-contract.ts:481-488`: `runtimeProjectTaskCountsSchema`.
- `src/server/workspace-registry.ts`: `createEmptyProjectTaskCounts` (`:80`), `countTasksByColumn` (`:90`), `applyLiveSessionStateToProjectTaskCounts` (`:128`), `summarizeProjectTaskCounts` (`:279`), `buildWorkspaceStateSnapshot` (`:303`), dependency interface `CreateWorkspaceRegistryDependencies` (`:23`).
- `src/state/workspace-state.ts:346-350`: private `readWorkspaceSessions(workspaceId)`. `loadWorkspaceBoardById` at `:343` is the public pattern to copy.
- `src/server/runtime-state-hub.ts`: `clinePreviousSummaryByWorkspaceId` (`:67`), `RuntimeStateHub` interface (`:44-62`).
- `src/cli.ts:409-422`: `runtimeStateHub` is a `let` assigned after `createWorkspaceRegistry`. Registry dependencies that need the hub must be late-bound closures, like `onTerminalManagerReady`.
- `src/trpc/workspace-api.ts:443-450`: `saveState` overwrite.
- `web-ui/src/hooks/app-utils.tsx:23-59`: browser `countTasksByColumn`. Its only caller is `use-project-ui-state.ts:50`.
- `web-ui/src/hooks/use-project-ui-state.ts`: open-project count override. Called from `web-ui/src/App.tsx:265`, where `sessions` (`App.tsx:87`) is in scope.
- `web-ui/src/components/project-navigation-panel.tsx`: `TaskCountBadge` (`:40`), pill array in `ProjectRow` (`:700-736`), removal-dialog total (`:96-103`).
- Shared runtime modules reach the web UI through aliases. Each alias needs three entries: `web-ui/vite.config.ts:81-91`, `web-ui/vitest.config.ts`, `web-ui/tsconfig.json` `paths` (see `@runtime-task-title`).

## Implementation

### 1. Shared module `src/core/task-display-state.ts` (new)

Imports types only from `./api-contract`. No Node imports, because the web UI imports it.

```ts
export type RuntimeTaskDisplayState = "backlog" | "in_progress" | "paused" | "review" | "done" | "trash";

export const PAUSED_TASK_SESSION_STATES: ReadonlySet<RuntimeTaskSessionState> = new Set(["idle", "interrupted", "failed"]);

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
): RuntimeTaskSessionSummary; // decision 4: candidate wins when candidate.updatedAt >= current.updatedAt, unless candidate is a placeholder and current is not

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

In `RuntimeStateHub`, add `listClineTaskSessionSummaries(workspaceId: string): RuntimeTaskSessionSummary[]`. It returns `Array.from(clinePreviousSummaryByWorkspaceId.get(workspaceId)?.values() ?? [])`.

### 5. Workspace registry

- Add an optional dependency `getClineTaskSessionSummaries?: (workspaceId: string) => RuntimeTaskSessionSummary[]` to `CreateWorkspaceRegistryDependencies`. In `src/cli.ts`, pass `(workspaceId) => runtimeStateHub?.listClineTaskSessionSummaries(workspaceId) ?? []`.
- Add a private `loadEffectiveTaskSessions(workspaceId): Promise<Record<string, RuntimeTaskSessionSummary>>`. It calls `mergeSessionSummaries` with these sources, in order:
  1. `Object.values(await loadWorkspaceSessionsById(workspaceId))`
  2. `getTerminalManagerForWorkspace(workspaceId)?.listSummaries() ?? []`
  3. `deps.getClineTaskSessionSummaries?.(workspaceId) ?? []`
- Add a private `loadProjectTaskSnapshot(workspaceId): Promise<{ board: RuntimeBoardData; sessions: Record<string, RuntimeTaskSessionSummary> }>`, which loads the board and `loadEffectiveTaskSessions`. `tasks-tab.md` reuses it, so keep it a named function inside `createWorkspaceRegistry`.
- `summarizeProjectTaskCounts`: replace the body with `countTasksByDisplayState(snapshot.board, snapshot.sessions)`. Keep the existing cache-on-success and fallback-on-throw behavior (`projectTaskCountsByWorkspaceId`). Use `createEmptyTaskCounts()` from the shared module.
- Delete the local `createEmptyProjectTaskCounts`, `countTasksByColumn` and `applyLiveSessionStateToProjectTaskCounts`. They are fully replaced.
- `buildWorkspaceStateSnapshot`: replace the blind overlay loop with `response.sessions = mergeSessionSummaries(Object.values(response.sessions), terminalManager.listSummaries())`.

### 6. `saveState` overwrite fix

In `src/trpc/workspace-api.ts` `saveState`, replace the overwrite loop with `input.sessions = mergeSessionSummaries(Object.values(input.sessions), terminalManager.listSummaries())`. For terminal agents, the terminal manager stays authoritative, because the browser's copy came from that manager and is never newer (ties go to the manager). A frozen hydrated Cline copy no longer replaces the browser's newer one.

### 7. Browser counts for the open project

- Delete `countTasksByColumn` from `web-ui/src/hooks/app-utils.tsx` and its test cases in `app-utils.test.tsx`, if any.
- `useProjectUiState` takes a new required input `sessions: Record<string, RuntimeTaskSessionSummary>` and computes `countTasksByDisplayState(board, sessions)` (imported from `@runtime-task-display-state`). Add `sessions` to the `useMemo` dependencies. Pass `sessions` from `App.tsx`.

### 8. Pill rendering

- Move the pill definition out of `ProjectRow` into a new `web-ui/src/components/project-task-count-badges.ts`, which exports:
  - `TASK_DISPLAY_STATE_ORDER: readonly RuntimeTaskDisplayState[]` = `["backlog", "in_progress", "paused", "review", "done", "trash"]`.
  - `TASK_DISPLAY_STATE_BADGE_META: Record<RuntimeTaskDisplayState, { title: string; shortLabel: string; toneClassName: string }>`. It holds today's five entries verbatim (Backlog/B, In Progress/IP, Review/R with `accent-2`, Done/D, Trash/T) plus the Paused entry from decision 3.
  - `buildProjectTaskCountBadges(counts: RuntimeProjectTaskCounts): TaskCountBadge[]`. It maps `TASK_DISPLAY_STATE_ORDER` through the meta, takes `count` from `counts[state]`, and drops zero counts. The `TaskCountBadge` interface moves here.
  - `ProjectRow` calls `buildProjectTaskCountBadges(project.taskCounts)`. `tasks-tab.md` reuses the order and meta.
- Removal dialog total (`project-navigation-panel.tsx:96-103`): add `taskCounts.paused` to the sum.

## Tests

- `test/runtime/core/task-display-state.test.ts` (new):
  - The full decision 1 table, one case per row, including queued `running` → `in_progress`, and `failed`/`idle`/`interrupted` → `paused`.
  - `countTasksByDisplayState` over a mixed board: `in_progress + paused + review-from-in_progress` equals the In Progress column length.
  - `pickNewerSessionSummary` tie and older/newer cases, plus a newer placeholder losing to an older real summary and a placeholder kept when there is no current summary.
  - An In Progress card whose only summary is a placeholder classifies as `in_progress`, not `paused`.
  - `mergeSessionSummaries` with three sources.
- `test/runtime/server/workspace-registry.test.ts`:
  - Add `loadWorkspaceSessionsById` to the `workspace-state` mock.
  - **Regression test for the bug:** the terminal manager's `listSummaries` returns a Cline summary `{ taskId: "task", agentId: "cline", state: "awaiting_review", updatedAt: 100 }`, the board has `task` in `in_progress`, and `getClineTaskSessionSummaries` returns `{ state: "running", updatedAt: 200 }`. Expected counts: `in_progress: 1, review: 0`.
  - The same setup with the Cline summary `state: "idle"`: expected `paused: 1, in_progress: 0`.
  - A terminal-agent task whose terminal summary is newer than disk is classified from the terminal summary.
  - A just-attached terminal placeholder (`createDefaultSummary` shape, newest `updatedAt`) over an older persisted `running` summary still counts as `in_progress`.
  - `buildWorkspaceStateSnapshot` keeps a newer disk summary over an older terminal-manager one.
- `test/runtime/trpc/workspace-api.test.ts`: `saveState` with a browser summary (`running`, `updatedAt: 200`) and a terminal-manager summary for the same task (`awaiting_review`, `updatedAt: 100`) persists the browser's. With the timestamps reversed, it persists the terminal manager's.
- `web-ui/src/hooks/use-project-ui-state.test.tsx`: the open project's counts reflect `paused` from local `sessions`. The other projects' server counts pass through unchanged.
- `web-ui/src/components/project-navigation-panel.test.tsx`: a project with `paused: 2` renders a `P` pill with text `2`, title `Paused`, the `text-status-gold` class, positioned after `IP` and before `R`. `paused: 0` renders no `P` pill.

Run `npm run typecheck`, `npm run web:typecheck`, `npm run test:fast`, `npm run web:test`, and `npx @biomejs/biome check` on the touched files before pushing.

## Acceptance criteria

- Pausing a running Cline task in project A and switching to project B: A's row shows `P | 1` in yellow, and `IP` drops by 1.
- Resuming that task (sending a message) turns it back into `IP` within one projects broadcast.
- A task taken from Review back to In Progress by a follow-up message shows as `IP` in its project's pills while another project is open, including after a runtime restart.
- Open-project and other-project counts for the same board and sessions are identical.
- No board column, lane, drag rule or card visual changes.

## Out of scope

- Board card markers for paused cards.
- A Paused column or filter on the board.
- Changing which session states the browser uses to move cards (`use-board-interactions.ts:584-635`).
