# Sidebar Tasks tab: cross-project task list

Status: implementation-ready plan. Target: `billy-the-ape/kanban` `main`. Source baseline: `879a3a1`.

Order: **2 of 2** in `docs/plans/sidebar-updates/`. It **depends on `paused-pill.md`**, which must be merged first. That plan provides `src/core/task-display-state.ts` (`RuntimeTaskDisplayState`, `resolveTaskDisplayState`, `mergeSessionSummaries`), the `@runtime-task-display-state` alias, `loadProjectTaskSnapshot` in the workspace registry, and `web-ui/src/components/project-task-count-badges.ts` (`TASK_DISPLAY_STATE_ORDER`, `TASK_DISPLAY_STATE_BADGE_META`). One PR / one squash commit.

All product decisions are made below. The implementer makes no product decisions.

## Problem and required outcome

Today the sidebar has two tabs, **Projects** and **Kanban Agent**. There is no way to see what is happening across all projects without opening each one. Add a **Tasks** tab that shows a vertical list of task cards from every project. The list can be filtered by display state and is sorted by last activity, newest first. By default it shows only In Progress tasks, so it answers "what is running right now".

## Decisions

1. **Tab order:** `Projects | Tasks | Kanban Agent`. The segmented control becomes `grid-cols-3`. Tasks is always enabled, including when there are no projects (it then shows the empty state). The selected tab is not persisted, matching today's behavior (`App.tsx:91`, default `"projects"`).
2. **States and filter:** the six display states from `paused-pill.md`: Backlog, In Progress, Paused, Review, Done, Trash. The filter is a row of **multi-select** chips. Each chip toggles on its own. The default selection is `["in_progress"]`. The selection is stored in localStorage under the new key `LocalStorageKey.SidebarTasksFilter = "kanban.sidebar-tasks-filter"` as a JSON array of state ids. On read, unknown ids are dropped. A missing, unparsable or non-array value falls back to the default. An empty array is a valid stored value (the user turned everything off). The key is **not** added to `LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS`.
3. **Chip content:** the full title from `TASK_DISPLAY_STATE_BADGE_META` (e.g. `In Progress`) and the count of tasks in that state across all projects, rendered `In Progress · 3`. Selected chips use the state's `toneClassName` plus `border border-transparent`. Unselected chips use `border border-border bg-transparent text-text-tertiary hover:text-text-secondary`. Every chip has `rounded-full px-2 py-0.5 text-[11px] font-medium cursor-pointer`. The chips wrap (`flex flex-wrap gap-1`).
4. **Sort:** `lastActivityAt` descending, then `title` ascending (`localeCompare`), then `taskId` ascending.
5. **Last activity:** `max(card.updatedAt, summary.updatedAt, summary.lastOutputAt ?? 0, summary.lastHookAt ?? 0)`. Without a summary, it is `card.updatedAt`. `moveTaskToColumn` already bumps `card.updatedAt` (`src/core/task-board-mutations.ts:589-592`).
6. **List item content**, top to bottom:
   - The task title (`text-sm font-medium text-text-primary kb-line-clamp-2`).
   - A meta row (`flex items-center gap-1.5 mt-1`) holding:
     - a state pill (`rounded-full text-[10px] px-1.5 py-px font-medium` with the state's tone class, showing its `shortLabel`, with `title` set to the state title);
     - the project name (`text-[11px] text-text-secondary truncate min-w-0 flex-1`);
     - the relative age (`text-[11px] text-text-tertiary shrink-0`, format from `formatApproximateAge`, e.g. `5m ago`).
   - The whole item is a `<button type="button">` styled like a project row: `kb-project-row w-full text-left rounded-md`, `padding: 6px 8px`.
   - No action menu and no agent activity text.
7. **Click:** opens the task's detail view. If the task is in the open project, select it directly. Otherwise, switch to its project and select it once that project's board has loaded (see the pending-open hook). On mobile, also close the sidebar, the same way project selection does.
8. **Data source:** a new tRPC query `projects.listTasks` returns every task of every indexed project. The browser fetches it only while the Tasks tab is visible: the home view (no task selected), the sidebar expanded, and `activeSection === "tasks"`. It refetches whenever the `projects` array from the runtime stream changes identity. That stream message (`projects_updated`) already fires after every session-summary batch and every board save in any tracked workspace (`src/server/runtime-state-hub.ts:150-167`, `src/trpc/workspace-api.ts:437,456`). At most one request runs at a time. A change that arrives during a request triggers exactly one more request after it finishes. There are no timers.
9. **Open-project overlay:** for the open project (`canPersistWorkspaceState && currentProjectId`), replace the server's items with items built in the browser from the local `board` and `sessions`, using the same shared builder. This is the same rule `useProjectUiState` uses for counts, so the list never lags behind the board you are looking at.
10. **States while loading:**
    - Before the first response: three skeleton rows using the existing `kb-skeleton` class.
    - On a failed request with no previous data: `Couldn't load tasks.` plus a ghost `Retry` button. A failed refetch keeps showing the previous data silently.
    - No chip selected: `Select a state to show tasks.`
    - Chips selected but nothing matches: `No matching tasks.`
    - All messages: `text-xs text-text-secondary px-2 py-3`.
11. **Ages refresh** once a minute while the tab is visible (`useInterval` from `@/utils/react-use`, 60_000 ms, `null` when not visible).
12. **Footer:** the Projects tab footer (`ShortcutsCard` and `ProjectSupportFooter`) is not shown on the Tasks tab, matching the Kanban Agent tab.

## Existing implementation map

- `web-ui/src/components/project-navigation-panel.tsx`:
  - props `activeSection: "projects" | "agent"` and `onActiveSectionChange` (`:70-71`);
  - the segmented control (`:316-347`);
  - section switch (`:350-420`);
  - mobile collapse-on-select pattern (`:369-374`);
  - `ProjectRowSkeleton` (`:633`).
- `web-ui/src/App.tsx`:
  - `homeSidebarSection` state (`:91`);
  - `ProjectNavigationPanel` usage (`:861-884`), which renders only when `!selectedCard`;
  - `sessions` (`:87`), `board`, `projects`, `currentProjectId`, `canPersistWorkspaceState`, `handleSelectProject`, `setSelectedTaskId` (`:236`).
- `web-ui/src/hooks/use-detail-task-navigation.ts`: closes the detail view whenever `currentProjectId` changes and when the selected card is missing after loading (`:58-80`). Selecting a task in another project therefore has to wait until after the switch.
- `web-ui/src/hooks/use-project-navigation.ts:100-109`: `handleSelectProject` (no-op for the current project).
- `web-ui/src/utils/task-pull-requests.ts:70-89`: private `formatApproximateAge`.
- `web-ui/src/storage/local-storage-store.ts`: `LocalStorageKey` enum.
- `web-ui/src/runtime/trpc-client.ts:13`: `getRuntimeTrpcClient(workspaceId)`.
- `src/core/api-contract.ts`: `runtimeProjectsResponseSchema` (`:629`), `runtimeBoardColumnIdSchema` (`:82`); `src/trpc/app-router.ts`: `projectsApi` context type (`:545`), `projects` router (`:1153`); `src/trpc/projects-api.ts`: `CreateProjectsApiDependencies`, `createProjectsApi`; `src/server/runtime-server.ts:610-620`: projects API wiring (`buildProjectsPayload: deps.workspaceRegistry.buildProjectsPayload`).
- `src/server/workspace-registry.ts`: `buildProjectsPayload`, `toProjectSummary` (project name derivation), and `loadProjectTaskSnapshot` (added by `paused-pill.md`).

## Implementation

### 1. Shared builder in `src/core/task-display-state.ts`

Add:

```ts
export function resolveTaskLastActivityAt(
	card: RuntimeBoardCard,
	summary: RuntimeTaskSessionSummary | null | undefined,
): number; // decision 5

export function buildProjectTaskListItems(
	project: { id: string; name: string },
	board: RuntimeBoardData,
	sessionsByTaskId: Readonly<Record<string, RuntimeTaskSessionSummary>>,
): RuntimeProjectTaskListItem[]; // one item per card in every column, unsorted

export function compareProjectTaskListItems(a: RuntimeProjectTaskListItem, b: RuntimeProjectTaskListItem): number; // decision 4
```

`title` is `card.title`. The board schema's transform already resolves it to a non-empty string through `resolveTaskTitle`.

### 2. Contract (`src/core/api-contract.ts`)

```ts
export const runtimeTaskDisplayStateSchema = z.enum(["backlog", "in_progress", "paused", "review", "done", "trash"]);
export const runtimeProjectTaskListItemSchema = z.object({
	projectId: z.string(),
	projectName: z.string(),
	taskId: z.string(),
	title: z.string(),
	displayState: runtimeTaskDisplayStateSchema,
	lastActivityAt: z.number(),
});
export const runtimeProjectTasksResponseSchema = z.object({ tasks: z.array(runtimeProjectTaskListItemSchema) });
```

Export the inferred types `RuntimeProjectTaskListItem` and `RuntimeProjectTasksResponse`. In `task-display-state.ts`, change `RuntimeTaskDisplayState` to `z.infer<typeof runtimeTaskDisplayStateSchema>` (re-exported under the same name) so there is one source of truth.

### 3. Server

- **Registry:** add `buildProjectTasksPayload(): Promise<RuntimeProjectTasksResponse>` to `WorkspaceRegistry`.
  - It calls `listWorkspaceIndexEntries()` and, for every entry in parallel, runs `loadProjectTaskSnapshot(workspaceId)` and `buildProjectTaskListItems({ id: workspaceId, name: toProjectSummary(entry).name }, board, sessions)`.
  - A project whose snapshot throws is skipped (its items are omitted). The rest still return.
  - Flatten, sort with `compareProjectTaskListItems`, and return `{ tasks }`.
  - To reuse the name logic, extract `toProjectSummary`'s name derivation into `function deriveProjectName(repoPath: string): string` in the same file, used by both.
- **Projects API:** add `buildProjectTasksPayload` to `CreateProjectsApiDependencies` and `listTasks: () => Promise<RuntimeProjectTasksResponse>` to `projectsApi`, implemented as `async () => await deps.buildProjectTasksPayload()`. Wire it in `runtime-server.ts` next to `buildProjectsPayload`.
- **Router:** add `listTasks: t.procedure.output(runtimeProjectTasksResponseSchema).query(async ({ ctx }) => await ctx.projectsApi.listTasks())` under `projects`.

### 4. Web UI utilities

- Move `formatApproximateAge` to the new `web-ui/src/utils/format-approximate-age.ts` (exported, same body and constants). Import it in `task-pull-requests.ts` and leave that file's behavior unchanged.
- Add `LocalStorageKey.SidebarTasksFilter`.
- Add `web-ui/src/hooks/use-sidebar-tasks-filter.ts`, returning `{ selectedStates: ReadonlySet<RuntimeTaskDisplayState>; toggleState(state): void }`. It implements decision 2's read/validate/write. Use `readLocalStorageItem`/`writeLocalStorageItem`, not the raw `localStorage`.

### 5. `web-ui/src/hooks/use-cross-project-tasks.ts` (new)

Input: `{ enabled: boolean; projects: RuntimeProjectSummary[]; currentProjectId: string | null; canPersistWorkspaceState: boolean; board: BoardData; sessions: Record<string, RuntimeTaskSessionSummary> }`.

Output: `{ tasks: RuntimeProjectTaskListItem[] | null; isLoading: boolean; error: string | null; retry: () => void }`.

- When `enabled` turns true, fetch with `getRuntimeTrpcClient(currentProjectId).projects.listTasks.query()`.
- While `enabled`, a change in `projects` identity requests a refetch under the single-flight-plus-one-trailing rule from decision 8, tracked with refs (`inFlightRef`, `pendingRefetchRef`).
- When `enabled` turns false, mark pending work as cancelled (ignore late responses) and keep the last data for instant display on return.
- `tasks` output: the server items with the open-project overlay from decision 9 applied (filter out `projectId === currentProjectId`, then append `buildProjectTaskListItems({ id: currentProjectId, name }, board, sessions)`, where `name` comes from the matching `projects` entry or the first server item for that project), sorted with `compareProjectTaskListItems`. Memoize on `[serverTasks, board, sessions, currentProjectId, canPersistWorkspaceState, projects]`.
- `error` is set only when a fetch fails and there is no previous data.

### 6. `web-ui/src/hooks/use-pending-task-open.ts` (new)

Input: `{ currentProjectId; board; isProjectSwitching; isAwaitingWorkspaceSnapshot; isWorkspaceMetadataPending; handleSelectProject; setSelectedTaskId }`.

Output: `openTask(projectId: string, taskId: string): void`.

- `openTask` with `projectId === currentProjectId`: `setSelectedTaskId(taskId)` and clear any pending open.
- Otherwise: store `{ projectId, taskId }` in state and call `handleSelectProject(projectId)`.
- An effect resolves the pending open when `currentProjectId === pending.projectId` and none of the three loading flags is true:
  - if `findCardSelection(board, pending.taskId)` finds it, call `setSelectedTaskId(pending.taskId)`;
  - otherwise show `showAppToast({ intent: "warning", icon: "warning-sign", message: "That task no longer exists.", timeout: 5000 })`.
  - Clear the pending open in both cases.
- If `currentProjectId` changes to a project that is neither the pending one nor the one active when `openTask` ran (the user picked another project meanwhile), clear the pending open.

Wire it in `App.tsx` after `useDetailTaskNavigation` and `useProjectNavigation`, using the same loading flags `useDetailTaskNavigation` receives.

### 7. Components

- `web-ui/src/components/sidebar-tasks/sidebar-task-filter-chips.tsx`: props `{ counts: Record<RuntimeTaskDisplayState, number>; selectedStates; onToggle }`. Renders the chips in `TASK_DISPLAY_STATE_ORDER` (decision 3). Each chip is a `<button type="button" aria-pressed={selected}>`.
- `web-ui/src/components/sidebar-tasks/sidebar-task-list-item.tsx`: props `{ item: RuntimeProjectTaskListItem; now: number; onSelect: (item) => void }` (decision 6).
- `web-ui/src/components/sidebar-tasks/sidebar-tasks-panel.tsx`: props `{ tasks; isLoading; error; onRetry; onSelectTask: (item) => void }`.
  - It owns `useSidebarTasksFilter` and the 60 s `now` ticker (decision 11).
  - It computes per-state counts from `tasks` and filters.
  - Layout: chips in a `shrink-0` block (`padding: 4px 12px 8px`), then the list as `flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-1` (`padding: 4px 12px`), with the decision 10 states.
- `project-navigation-panel.tsx`:
  - `activeSection`/`onActiveSectionChange` become `"projects" | "tasks" | "agent"`. Add the required prop `renderTasksSection: (options: { closeOnMobile: () => void }) => ReactNode`, so the panel can supply the same mobile collapse behavior `onSelect` uses (`if (isMobile) setCollapsed(true)`).
  - Add the Tasks button between Projects and Agent with the same class logic as Projects.
  - The section switch renders `renderTasksSection({ closeOnMobile })` for `"tasks"`.
- `App.tsx`:
  - `homeSidebarSection` state type becomes the three-way union.
  - Call `useCrossProjectTasks({ enabled: !selectedCard && !sidebarLayout.isCollapsed && homeSidebarSection === "tasks", ... })`.
  - Pass `renderTasksSection={({ closeOnMobile }) => <SidebarTasksPanel ... onSelectTask={(item) => { closeOnMobile(); openTask(item.projectId, item.taskId); }} />}`.

## Tests

- `test/runtime/core/task-display-state.test.ts`: `resolveTaskLastActivityAt` with and without a summary and with null `lastOutputAt`/`lastHookAt`. `buildProjectTaskListItems` emits one item per card with the right `displayState`. `compareProjectTaskListItems` covers all three tie-break levels.
- `test/runtime/server/workspace-registry.test.ts`: `buildProjectTasksPayload` over two projects returns merged, sorted items. A project whose board load throws is omitted while the other still returns.
- `test/runtime/trpc/projects-api.test.ts`: `listTasks` delegates to `buildProjectTasksPayload`.
- `web-ui/src/hooks/use-sidebar-tasks-filter.test.tsx`: default, persisted round trip, unknown ids dropped, corrupt JSON falls back, empty array is respected.
- `web-ui/src/hooks/use-cross-project-tasks.test.tsx`: no fetch while disabled. Fetches once on enable. A `projects` change during a request yields exactly one trailing request. The open-project overlay replaces server items. A refetch error keeps the previous data.
- `web-ui/src/hooks/use-pending-task-open.test.tsx`: same-project open selects immediately. A cross-project open selects after the loading flags clear. A missing task toasts and clears. Switching to a third project clears the pending open.
- `web-ui/src/components/sidebar-tasks/sidebar-tasks-panel.test.tsx`: the default shows only In Progress items. Toggling Paused adds paused items. Chip counts. Ordering by `lastActivityAt`. The four decision 10 messages. Clicking an item calls `onSelectTask` with it.
- `web-ui/src/components/project-navigation-panel.test.tsx`: three tabs in order. Selecting Tasks calls `onActiveSectionChange("tasks")` and renders `renderTasksSection` output. The Projects footer is not rendered on the Tasks tab.

Run `npm run typecheck`, `npm run web:typecheck`, `npm run test:fast`, `npm run web:test`, and `npx @biomejs/biome check` on the touched files before pushing.

## Acceptance criteria

- The sidebar shows `Projects | Tasks | Kanban Agent`. Opening Tasks lists every running task across all projects, newest activity first.
- Pausing a task removes it from the default list within one projects broadcast. Selecting the Paused chip shows it.
- The filter selection survives a reload.
- Clicking a task in another project switches to that project and opens the task. Clicking one in the open project opens it immediately. On mobile the sidebar closes.
- No `projects.listTasks` requests are made while the Tasks tab is not visible.

## Out of scope

- Search, grouping by project, pagination or virtualization.
- Actions on list items (start, stop, trash).
- Persisting the selected sidebar tab.
