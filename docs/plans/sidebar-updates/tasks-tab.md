# Sidebar Tasks tab: cross-project task list

Status: implementation-ready plan. Target: `billy-the-ape/kanban` `main`. Source baseline: `879a3a1`.

Order: **2 of 2** in `docs/plans/sidebar-updates/`. It **depends on `paused-pill.md`**, which must be merged first. That plan provides `src/core/task-display-state.ts` (`RuntimeTaskDisplayState`, `resolveTaskDisplayState`, `mergeSessionSummaries`), the `@runtime-task-display-state` alias, `loadProjectTaskSnapshot` in the workspace registry, and `web-ui/src/components/project-task-count-badges.ts` (`TASK_DISPLAY_STATE_ORDER`, `TASK_DISPLAY_STATE_BADGE_META`). One implementation PR / one squash commit. Desktop collapse is being handled separately by the user.

The behavior and boundaries are defined below. Before coding, read `AGENTS.md` and the merged paused-pill implementation. Use symbols as navigation anchors; baseline line numbers may shift. Preserve later changes on the implementation branch. If current behavior conflicts with a decision here, report that specific conflict before changing scope.

## Problem and required outcome

Today the sidebar has two tabs, **Projects** and **Kanban Agent**. There is no way to see what is happening across all projects without opening each one. Add a **Tasks** tab that shows a vertical list of task cards from every project. The list can be filtered by display state and is sorted by last activity, newest first. By default it shows only In Progress tasks, so it answers "what is running right now".

## Decisions

1. **Tab order:** `Projects | Tasks | Kanban Agent`. The segmented control becomes `grid-cols-3`. Tasks is always enabled, including when there are no projects (it then shows the empty state). The selected tab is not persisted, matching today's behavior (`App.tsx:91`, default `"projects"`).
2. **States and filter:** the six display states from `paused-pill.md`: Backlog, In Progress, Paused, Review, Done, Trash. The filter is a row of **multi-select** chips. Each chip toggles on its own. The default selection is `["in_progress"]`. The selection is stored in localStorage under the new key `LocalStorageKey.SidebarTasksFilter = "kanban.sidebar-tasks-filter"` as a JSON array of state ids. On read, unknown ids are dropped. A missing, unparsable or non-array value falls back to the default. An empty array is a valid stored value (the user turned everything off). The key is **not** added to `LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS`.
3. **Chip content:** the full title from `TASK_DISPLAY_STATE_BADGE_META` (e.g. `In Progress`) and the count of tasks in that state across all projects, rendered `In Progress · 3`. Selected chips use the state's `toneClassName` plus `border border-transparent`. Unselected chips use `border border-border bg-transparent text-text-tertiary hover:text-text-secondary`. Every chip has `rounded-full px-2 py-0.5 text-[11px] font-medium cursor-pointer`. The chips wrap (`flex flex-wrap gap-1`).
4. **Sort and identity:** `lastActivityAt` descending, then `title` ascending (`localeCompare`), then `taskId` ascending, then `projectId` ascending. Use `(projectId, taskId)` as item identity and React key, because task ids need not be globally unique. Use the same comparator on server and browser.
5. **Last activity:** `max(card.updatedAt, summary.updatedAt, summary.lastOutputAt ?? 0, summary.lastHookAt ?? 0)` for a real summary. Without a summary, or with a terminal placeholder as defined in `paused-pill.md`, use only `card.updatedAt`; attaching a terminal must not reorder an untouched task. `moveTaskToColumn` already bumps `card.updatedAt` (`src/core/task-board-mutations.ts:589-592`).
6. **List item content**, top to bottom:
   - The task title (`text-sm font-medium text-text-primary kb-line-clamp-2`).
   - A meta row (`flex items-center gap-1.5 mt-1`) holding:
     - a state pill (`rounded-full text-[10px] px-1.5 py-px font-medium` with the state's tone class, showing its `shortLabel`, with `title` set to the state title);
     - the project name (`text-[11px] text-text-secondary truncate min-w-0 flex-1`);
     - the relative age (`text-[11px] text-text-tertiary shrink-0`, format from `formatApproximateAge`, e.g. `5m ago`).
   - The whole item is a `<button type="button">` styled like a project row: `kb-project-row w-full text-left rounded-md`, `padding: 6px 8px`.
   - No action menu and no agent activity text.
7. **Click:** opens the task's detail view. If the task is in the open project, select it directly. Otherwise, switch to its project and select it once that project's board has loaded (see the pending-open hook). On mobile, also close the sidebar, the same way project selection does.
8. **Data source and refresh budget:** a new global tRPC query `projects.listTasks` returns tasks from indexed projects without starting agents or creating terminal managers. Query it with `getRuntimeTrpcClient(null)`; it is independent of the selected project's request header. Fetch only while the home Tasks tab is expanded and the browser document is visible. A change in the **raw** runtime-stream `projects` array marks the data dirty; do not use `displayedProjects`, whose local overlay would cause unnecessary requests.

   Session batches arrive as often as every 150 ms. Single-flight alone does not prevent continuous all-project disk reads. Fetch immediately on first enable/re-enable and manual Retry; otherwise permit automatic request starts at most once per **1,000 ms**. Use one in-flight request, one dirty flag, and at most one event-triggered trailing timeout. Changes during a request coalesce into one trailing refresh, scheduled after settlement and the remaining rate-limit interval. If there is no new event, do not repeat a request. This is coalescing, not periodic polling; continuous updates must not postpone refreshes indefinitely.
9. **Open-project overlay:** for the open project (`canPersistWorkspaceState && currentProjectId`), replace the server's items with items built in the browser from the local `board` and `sessions`, using the same shared builder. This is the same rule `useProjectUiState` uses for counts, so the list never lags behind the board you are looking at.
10. **States while loading:**
    - Before the first response: three skeleton rows using the existing `kb-skeleton` class.
    - On a failed request with no previous data: `Couldn't load tasks.` plus a ghost `Retry` button. A failed refetch keeps previous data and shows `Couldn't refresh tasks. Showing the last loaded tasks.` with Retry.
    - A response with unavailable project ids keeps successful projects visible and shows `Some projects couldn't be loaded.` with Retry. Do not silently report a partial result as all projects, or retain older rows for failed projects as though they were current. Chip counts describe the rows currently available.
    - No chip selected: `Select a state to show tasks.`
    - Chips selected but nothing matches: `No matching tasks.`
    - All messages: `text-xs text-text-secondary px-2 py-3`.
11. **Ages refresh** once a minute while the tab and document are visible (`useInterval` from `@/utils/react-use`, 60_000 ms, `null` otherwise). This ticker only updates labels; it never fetches data or resorts the list.
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
- `web-ui/src/hooks/use-project-navigation.ts:100-109`: `handleSelectProject` (today a no-op when the target equals `currentProjectId`, even while a switch elsewhere is in flight; this plan changes the guard, see section 6).
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

export function compareProjectTaskListItems(
	a: RuntimeProjectTaskListItem,
	b: RuntimeProjectTaskListItem,
): number; // decision 4
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
export const runtimeProjectTasksResponseSchema = z.object({
	tasks: z.array(runtimeProjectTaskListItemSchema),
	unavailableProjectIds: z.array(z.string()),
});
```

Export the inferred types `RuntimeTaskDisplayState`, `RuntimeProjectTaskListItem` and `RuntimeProjectTasksResponse` from `api-contract.ts`. Replace the shared module's handwritten display-state union with a type-only import/re-export of that inferred type, retaining existing imports through `@runtime-task-display-state`. Do not import Zod or the schema as runtime values into the shared helper.

### 3. Server

- **Registry:** add `buildProjectTasksPayload(): Promise<RuntimeProjectTasksResponse>` to `WorkspaceRegistry`.
  - It calls `listWorkspaceIndexEntries()` once and processes snapshots with at most **4 concurrent projects per request**. Reuse an existing concurrency helper if available; otherwise use a small worker loop. Load only board and summary records through `loadProjectTaskSnapshot`, without worktrees, transcripts, Git probes or service initialization.
  - Build items with `{ id: entry.workspaceId, name: deriveProjectName(entry.repoPath) }`. `toProjectSummary(entry)` is invalid: that function requires task counts, which the index entry does not contain.
  - A project whose snapshot throws contributes its id to `unavailableProjectIds` and no rows; the rest still return. Failure of the index read fails the query. An empty index returns both arrays empty.
  - Flatten, sort with `compareProjectTaskListItems`, sort unavailable ids for deterministic output, and return `{ tasks, unavailableProjectIds }`.
  - To reuse the name logic, extract `toProjectSummary`'s name derivation into `function deriveProjectName(repoPath: string): string` in the same file, used by both.
- **Projects API:** add `buildProjectTasksPayload` to `CreateProjectsApiDependencies` and `listTasks: () => Promise<RuntimeProjectTasksResponse>` to `projectsApi`, implemented as `async () => await deps.buildProjectTasksPayload()`. Wire it in `runtime-server.ts` next to `buildProjectsPayload`.
- **Router:** add `listTasks: t.procedure.output(runtimeProjectTasksResponseSchema).query(async ({ ctx }) => await ctx.projectsApi.listTasks())` under `projects`.
- Update typed and cast fixtures for `WorkspaceRegistry`, projects API context/dependencies, and the response. Add a router contract test using the unscoped client; don't test delegation only.

### 4. Web UI utilities

- Move `formatApproximateAge` to the new `web-ui/src/utils/format-approximate-age.ts` (exported, same body and constants). Import it in `task-pull-requests.ts` and leave that file's behavior unchanged.
- Add `LocalStorageKey.SidebarTasksFilter`.
- Add `web-ui/src/hooks/use-sidebar-tasks-filter.ts`, returning `{ selectedStates: ReadonlySet<RuntimeTaskDisplayState>; toggleState(state): void }`. It implements decision 2's read/validate/write. Use `readLocalStorageItem`/`writeLocalStorageItem`, not the raw `localStorage`.

### 5. `web-ui/src/hooks/use-cross-project-tasks.ts` (new)

Input: `{ enabled: boolean; projects: RuntimeProjectSummary[]; hasReceivedSnapshot: boolean; currentProjectId: string | null; canPersistWorkspaceState: boolean; board: BoardData; sessions: Record<string, RuntimeTaskSessionSummary> }`.

Output: `{ tasks: RuntimeProjectTaskListItem[] | null; isLoading: boolean; error: string | null; unavailableProjectIds: string[]; retry: () => void }`.

- Enable, Retry and raw-projects changes all feed the same scheduler defined in decision 8. Retry is a no-op while disabled and coalesces into one refresh if a request is already in flight. Avoid duplicate initial requests from separate enable and projects effects.
- Explicit enable/Retry refreshes bypass the automatic 1,000-ms interval, but never the in-flight guard. If queued behind a request, remember that immediate intent and start once the existing promise settles. Automatic dirty events must not erase it.
- A request captures the visibility generation. Disabling increments that generation, clears the dirty flag and trailing timeout, and ignores late success/error results. Keep last data for instant display on return. **Do not release the in-flight slot until the promise settles**: a quick disable/re-enable must not overlap the old network request. Re-enabling while an obsolete request is still running queues one current-generation request after settlement. Unmount performs the same cleanup without scheduling more work. An obsolete completion may release only its own request slot, never newer state.
- `tasks` stays `null` until the first successful response (including an empty response). Afterward apply decision 9 only when the current project exists in the latest raw `projects` array and `canPersistWorkspaceState` is true. Otherwise keep server rows unchanged. Use that project's name; there is no undefined-name fallback. Remove server rows for that project and append the local builder's rows, then sort. If this overlay provides a project reported unavailable by the server, remove that id from the displayed unavailable list.
- Once `hasReceivedSnapshot` is true, filter cached server rows and unavailable ids by the latest known project ids, so removing a project doesn't leave clickable stale rows. Before a known project list arrives, do not discard rows merely because the initial array is empty. Memoize on `[serverTasks, board, sessions, currentProjectId, canPersistWorkspaceState, projects, hasReceivedSnapshot]`. A project switch only changes the overlay; it does not invalidate this global query merely because `currentProjectId` changed.
- Expose initial/refetch errors according to decision 10. `isLoading` describes a running request; show skeletons only when `tasks === null`. Clear an old error on a successful response. Test with controllable promises and fake timers rather than real delays.

### 6. `web-ui/src/hooks/use-pending-task-open.ts` (new)

Input: `{ currentProjectId; requestedProjectId; projects; hasReceivedSnapshot; board; canPersistWorkspaceState; isInitialRuntimeLoad; isProjectSwitching; isAwaitingWorkspaceSnapshot; isWorkspaceMetadataPending; streamError; handleSelectProject; setSelectedTaskId }`.

Output: `openTask(projectId: string, taskId: string): void`.

- Every click replaces any earlier pending open. If a known project list no longer contains the target, warn `That project is no longer available.` and stop. For a fully hydrated current project, check `findCardSelection` before selecting; a missing card warns `That task no longer exists.` rather than opening and immediately closing detail.
- Otherwise store `{ projectId, taskId }` in state. "Another project" is judged against `requestedProjectId ?? currentProjectId` (the same value as `navigationCurrentProjectId`, `use-project-navigation.ts:98`): call `handleSelectProject(projectId)` whenever `projectId` differs from it. This includes clicking a task in the loaded project A while a switch to B is still in flight. For that call to cancel the in-flight switch, change the guard in `handleSelectProject` (`use-project-navigation.ts:102-104`) from `projectId === currentProjectId` to `projectId === navigationCurrentProjectId`, so `handleSelectProject(A)` sets `requestedProjectId` back to A instead of being a no-op. Project-row clicks get the same fix. A same-project click during hydration waits for the same readiness conditions rather than searching the old board.
- An effect resolves the pending open when `currentProjectId === pending.projectId`, `canPersistWorkspaceState` is true, and none of the four loading flags (including initial runtime load) is true:
  - if `findCardSelection(board, pending.taskId)` finds it, call `setSelectedTaskId(pending.taskId)`;
  - otherwise show `showAppToast({ intent: "warning", icon: "warning-sign", message: "That task no longer exists.", timeout: 5000 })`.
  - Clear the pending open in both cases.
- Cancel pending selection as soon as the user requests a different project (observe a change in `requestedProjectId`, not only the eventually loaded `currentProjectId`). A known project removal also clears it with the project warning. If the pending switch reports a new stream error, clear it and let the existing navigation error UI explain the failure; do not mistake a pre-existing error from the origin project for failure of the new switch. Never open the pending task on a later unrelated reconnect. An unavailable project retained in the index is not a missing task.
- Same-project warning toasts use the same 5-second warning format as the effect above. There is no arbitrary navigation timeout. Waiting for hydration must survive a sidebar unmount, so keep this hook in `App.tsx`.

Wire it in `App.tsx` after `useDetailTaskNavigation` and `useProjectNavigation`, using all the loading flags `useDetailTaskNavigation` receives. Preserve that hook's detail-close-on-project-change behavior. Add a combined-hook regression test: the new selection must survive its project-change effect rather than being cleared by it.

### 7. Components

- `web-ui/src/components/sidebar-tasks/sidebar-task-filter-chips.tsx`: props `{ counts: Record<RuntimeTaskDisplayState, number>; selectedStates; onToggle }`. Renders the chips in `TASK_DISPLAY_STATE_ORDER` (decision 3). Each chip is a `<button type="button" aria-pressed={selected}>`.
- `web-ui/src/components/sidebar-tasks/sidebar-task-list-item.tsx`: props `{ item: RuntimeProjectTaskListItem; now: number; onSelect: (item) => void }` (decision 6).
- `web-ui/src/components/sidebar-tasks/sidebar-tasks-panel.tsx`: props `{ tasks; isLoading; error; unavailableProjectIds; isVisible; onRetry; onSelectTask: (item) => void }`.
  - It owns `useSidebarTasksFilter` and the 60 s `now` ticker (decision 11).
  - It computes per-state counts from `tasks` and filters.
  - Layout: chips in a `shrink-0` block (`px-3 pt-1 pb-2`), then the list as `flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-1 px-3 py-1`, with decision 10's loading/error/partial states above filter-empty messages. Keep rows visible during refetch. Use Tailwind spacing utilities rather than static inline styles; item padding is `px-2 py-1.5`.
- `project-navigation-panel.tsx`:
  - `activeSection`/`onActiveSectionChange` become `"projects" | "tasks" | "agent"`. Add the required prop `renderTasksSection: (options: { closeOnMobile: () => void }) => ReactNode`, so the panel can supply the same mobile collapse behavior `onSelect` uses (`if (isMobile) setCollapsed(true)`).
  - Add the Tasks button between Projects and Agent with the same class logic as Projects. Give section buttons `aria-pressed` for their selected state, preserving keyboard access and the Agent tab's existing disabled behavior. Task buttons and chips retain visible focus styling.
  - The section switch renders `renderTasksSection({ closeOnMobile })` for `"tasks"`.
- `App.tsx`:
  - `homeSidebarSection` state type becomes the three-way union.
  - Compute `areSidebarTasksVisible = !selectedCard && !sidebarLayout.isCollapsed && homeSidebarSection === "tasks" && isDocumentVisible`; pass it as `enabled` to `useCrossProjectTasks` and `isVisible` to the panel. The hook must also receive raw `projects` and `hasReceivedSnapshot`.
  - Pass `renderTasksSection={({ closeOnMobile }) => <SidebarTasksPanel ... onSelectTask={(item) => { closeOnMobile(); openTask(item.projectId, item.taskId); }} />}`.

## Tests

- `test/runtime/core/task-display-state.test.ts`: last activity with/without summaries, null output/hook timestamps, and a newer placeholder that must not change activity. The builder emits one item per card in every column. Cover all four comparator levels and duplicate task ids in different projects.
- `test/runtime/server/workspace-registry.test.ts`: merged sorted items over multiple projects, empty index, partial failure with the failed project's id, and index-read failure. Use controllable loads to assert the maximum of four concurrent project snapshots. Assert no manager/service initialization.
- `test/runtime/trpc/projects-api.test.ts`: `listTasks` delegates to `buildProjectTasksPayload`. Add an integration/router test that the unscoped `projects.listTasks` query validates and returns tasks plus unavailable ids.
- `web-ui/src/hooks/use-sidebar-tasks-filter.test.tsx`: default, persisted round trip, unknown ids dropped, corrupt JSON falls back, empty array is respected.
- `web-ui/src/hooks/use-cross-project-tasks.test.tsx`: no fetch while disabled; exactly one enable request; bursts produce one trailing refresh at the 1,000-ms automatic budget; sustained events refresh without starvation. Disable during a request, re-enable before it settles, and prove there are no overlapping requests and no obsolete success/error writes. Test timeout/unmount cleanup, explicit Retry, initial versus refetch failure, partial results, hydrated local overlay (including an empty board), no overlay during switching, project removal, and a global fetch that does not restart merely on `currentProjectId` change.
- `web-ui/src/hooks/use-pending-task-open.test.tsx`: same-project valid/missing task; cross-project selection after all readiness flags clear; same-project hydration waits; rapid task clicks use the latest click; with a switch from A to B in flight, clicking a task in A sets `requestedProjectId` back to A, opens that task once A is ready, and never leaves a pending open behind for a later visit to A. Assert that `canPersistWorkspaceState` returns to `true` after that cancel-back (`handleProjectSwitchStart` sets it to `false`, and the re-subscribed stream's snapshot must re-hydrate A). Add the guard change's own case to `use-project-navigation` tests: selecting the loaded project during an in-flight switch resets `requestedProjectId`. A third-project **request before it finishes loading**, project removal or failed switch clears the pending open. Use a harness with `useDetailTaskNavigation` to prove a successful pending selection remains open and the URL contains the selected project/task.
- `web-ui/src/components/sidebar-tasks/sidebar-tasks-panel.test.tsx`: default In Progress filter, Paused toggle, chip counts, order, every decision 10 message, cached rows during refetch, partial warning plus Retry, and click payload. Verify duplicate task ids in different projects still render distinct buttons and correct project ids. The age ticker stops while hidden and never calls the query.
- `web-ui/src/components/project-navigation-panel.test.tsx`: three tabs in order. Selecting Tasks calls `onActiveSectionChange("tasks")` and renders `renderTasksSection` output. The Projects footer is not rendered on the Tasks tab.

Run `npm run typecheck`, `npm run web:typecheck`, `npm run test:fast`, `npm run web:test`, and `npx @biomejs/biome check` on the touched files before pushing.

Run the integration/router suite containing the new unscoped-query test as well; `test:fast` excludes integration tests. During implementation, run affected tests first and the broader required checks once the change is complete. Follow the repository's Biome settings; do not apply Prettier or reformat unrelated files.

## Acceptance criteria

- The sidebar shows `Projects | Tasks | Kanban Agent`. Opening Tasks defaults to display-state `in_progress` across successfully loaded projects, newest activity first. Queued tasks appear under Paused. Cards without a real session summary retain the optimistic `in_progress` fallback defined in `paused-pill.md`; it is not an active-process monitor.
- Pausing a task removes it from the default list after the next projects event and coalesced refresh: once any existing request settles, at most 1,000 ms scheduling delay plus the next request's latency while visible. Selecting Paused shows it. Local hydrated-board changes appear through the overlay immediately.
- The filter selection survives a reload.
- Clicking a task in another project switches to that project and opens the task. Clicking one in the open project opens it immediately. On mobile the sidebar closes.
- No new `projects.listTasks` requests start while the Tasks tab or document is hidden; previously started responses are ignored. Automatic starts are rate-limited, event bursts coalesce, and no request overlaps another within the hook.
- Partial/unavailable project data and failed refreshes are visible; Retry recovers without clearing successfully loaded rows unnecessarily.

## Deployment and implementation handoff

No new environment variables or configuration. Merge the paused-pill implementation first. Rebuild runtime and web UI together (`npm run build`), restart the normal Kanban service, and reload browser tabs so the query contract and UI match. No device changes are part of this implementation PR.

The implementation PR description must list behavior changes, validation results and manual acceptance steps, with these deployment actions prominently stated. Mark it ready for review after checks pass. Report blocked or failing checks accurately. Keep this as one implementation PR; do not split its numbered sections into additional cards/PRs.

## Out of scope

- Search, grouping by project, pagination or virtualization.
- Actions on list items (start, stop, trash).
- Persisting the selected sidebar tab.
