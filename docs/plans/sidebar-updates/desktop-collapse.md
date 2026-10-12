# Sidebar: manual collapse and expand on desktop

Status: implementation-ready plan. Target: `billy-the-ape/kanban` `main`. Source baseline: `879a3a1`.

Order: **3 of 3** in `docs/plans/sidebar-updates/`. It is independent of `paused-pill.md` and `tasks-tab.md` and can land in any order. When it lands after `tasks-tab.md`, the header's three-tab control is unaffected. One PR / one squash commit.

All product decisions are made below. The implementer makes no product decisions.

## Problem and required outcome

On desktop, the sidebar collapses into a 48px rail of project letters only when its resize edge is dragged below 120px, or, since `879a3a1` ("Collapsed button for all"), through the header's `X` button. The collapsed rail has **no way back** except dragging the edge wider. The `X` icon, the `Close sidebar` label and the `!isCollapsed` toggle were written for the mobile drawer and are misleading on desktop.

Required outcome: a clear, discoverable collapse/expand control on desktop, a keyboard shortcut, and a collapsed state that persists across reloads. Mobile behavior stays as it is today.

## Current behavior (verified in code)

- `web-ui/src/components/project-navigation-panel.tsx`:
  - `setCollapsed` (`:116-125`) persists only when not mobile.
  - Drag-to-collapse threshold is `SIDEBAR_COLLAPSE_THRESHOLD = 120` (`:35`, `:150-160`).
  - Collapsed desktop rail (`:206-264`): resize handle, one letter button per project, `+` add-project button at the bottom.
  - The header button (`:306-313`) renders a `Plus` rotated 45° (an `X`) with `aria-label="Close sidebar"` and `onClick={() => setCollapsed(!isCollapsed)}`, on both mobile and desktop.
  - On mobile, a collapsed sidebar renders nothing (`:200-202`), and the TopBar `Menu` button (`web-ui/src/components/top-bar.tsx:494-503`, mobile only) opens it.
- `web-ui/src/resize/use-project-navigation-layout.ts`: `isCollapsed` is loaded from `LocalStorageKey.ProjectNavigationPanelCollapsed` (default `false`). `setSidebarCollapsed(collapsed, persist = true)`.
- The `useEffect` on `isMobile` (`project-navigation-panel.tsx:107-113`) force-collapses without persisting when entering mobile width. When the window widens back to desktop, nothing restores the persisted preference, so the sidebar stays collapsed even if the user had it expanded.
- App hotkeys live in `web-ui/src/hooks/use-app-hotkeys.ts` (react-hotkeys-hook `^5.2.4`). `mod+b` is already taken (start backlog tasks). `App.tsx:730-733` already defines `handleToggleSidebar`. The sidebar renders only on the home view (`App.tsx:861`, `!selectedCard`).
- The shortcut list is `MORE_SHORTCUTS` in `project-navigation-panel.tsx:556-567`.

## Decisions

1. **Collapsed form:** keep the existing 48px rail with project letters (no fully hidden mode on desktop).
2. **Expanded header control (desktop):**
   - Lucide `PanelLeftClose` icon (size 16) as a ghost `Button`, `aria-label="Collapse sidebar"`, wrapped in `Tooltip` with content `Collapse sidebar (⌘\)` on macOS and `Collapse sidebar (Ctrl+\)` elsewhere.
   - Build the label from the existing `MOD` constant and `\`, as `` `Collapse sidebar (${MOD}${isMacPlatform ? "" : "+"}\\)` ``.
   - `onClick={() => setCollapsed(true)}`.
   - Use `className="-mr-1"` and drop the 44px touch-target classes on desktop.
3. **Expanded header control (mobile):** unchanged from before `879a3a1`: the `X` (`Plus` rotated 45°), `aria-label="Close sidebar"`, `min-w-[44px] min-h-[44px] -mr-2`, `onClick={() => setCollapsed(true)}`.
4. **Collapsed rail expand control (desktop only):**
   - The rail's first child is a ghost button with the Lucide `PanelLeftOpen` icon (size 16): `w-8 h-8`, `aria-label="Expand sidebar"`.
   - It is wrapped in `Tooltip` with content `` `Expand sidebar (${shortcutLabel})` ``, using the same shortcut label as decision 2.
   - `onClick={() => setCollapsed(false)}`. Classes match the rail's add-project button (`rounded-md bg-transparent text-text-tertiary hover:text-text-secondary hover:bg-surface-2 flex items-center justify-center border-0 cursor-pointer shrink-0`).
   - Below it, a divider `<div className="w-6 h-px bg-border shrink-0" aria-hidden />`, then the project letters as today.
5. **Keyboard shortcut:**
   - `mod+backslash` toggles the sidebar.
   - Active only on the home view (`!selectedCard`) and only on desktop (`!isMobile`). On mobile and in the task detail view it does nothing and does **not** `preventDefault`.
   - It also works inside form fields and contenteditable (`enableOnFormTags: true`, `enableOnContentEditable: true`), like `mod+g`.
   - Toggling persists (`setSidebarCollapsed(next)` with the default `persist = true`).
6. **Shortcut list:** add `{ keys: [MOD, "\\"], label: "Toggle sidebar" }` to `MORE_SHORTCUTS`, directly after `New task`.
7. **Mobile → desktop restore:** when `isMobile` changes from `true` to `false`, restore the persisted collapsed preference (the non-persisted mobile auto-collapse must not leak into desktop).
8. **Unchanged:** drag-to-collapse/expand, widths and their persistence, the TopBar `Menu` button (mobile only), mobile slide animations, and the layout-reset behavior.

## Implementation

### 1. `web-ui/src/resize/use-project-navigation-layout.ts`

Add `restorePersistedSidebarCollapsed: () => void` to the hook's return. It runs `setIsCollapsedState(loadBooleanResizePreference(SIDEBAR_COLLAPSED_PREFERENCE))`. Wrap it in `useCallback` with no dependencies.

### 2. `web-ui/src/components/project-navigation-panel.tsx`

- New prop `restorePersistedSidebarCollapsed: () => void`, passed from `App.tsx` (`sidebarLayout.restorePersistedSidebarCollapsed`).
- Replace the `isMobile` effect with one that tracks the previous value in a ref:
  - on `true`: `setSidebarCollapsed(true, false)` (today's behavior);
  - on a transition from `true` to `false`: `restorePersistedSidebarCollapsed()`;
  - on initial mount with `false`: do nothing.
- Header button: render decision 2 when `!isMobile`, decision 3 when `isMobile`.
- Collapsed rail: when `!isMobile`, insert decision 4's expand button and divider before `sortedProjects.map(...)`. Mobile returns early before the rail renders, so no mobile branch is needed.
- `MORE_SHORTCUTS`: decision 6.
- Export a small helper `formatSidebarToggleShortcutLabel(): string` from the same file for the two tooltips. It returns `⌘\` on macOS and `Ctrl+\` elsewhere, built from the existing `MOD`/`isMacPlatform` constants. Do not create a new file for it.

### 3. `web-ui/src/hooks/use-app-hotkeys.ts`

- Add inputs `canToggleSidebar: boolean` and `handleToggleSidebar: () => void`.
- Register:

  ```ts
  useHotkeys(
  	"mod+backslash",
  	() => {
  		handleToggleSidebar();
  	},
  	{ enabled: canToggleSidebar, enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true },
  	[handleToggleSidebar],
  );
  ```

- Verify in the hook test that a `keydown` with `code: "Backslash"`, `key: "\\"`, and `metaKey: true` (and separately `ctrlKey: true`) fires the handler.
- If react-hotkeys-hook 5 does not match `"backslash"` in that test, register through `useWindowEvent("keydown", canToggleSidebar ? handler : null)` instead. The handler checks `event.code === "Backslash" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey`, then calls `event.preventDefault()` and `handleToggleSidebar()`.

### 4. `web-ui/src/App.tsx`

Pass `canToggleSidebar: !selectedCard && !isMobile` and `handleToggleSidebar` (the existing callback at `:730`) into `useAppHotkeys`. `App.tsx` does not call `useIsMobile()` today, so add `const isMobile = useIsMobile();` (import from `@/hooks/use-is-mobile`). Pass `restorePersistedSidebarCollapsed` to `ProjectNavigationPanel`.

## Tests

- `web-ui/src/components/project-navigation-panel.test.tsx`, desktop. Mock `@/hooks/use-is-mobile` with a controllable return value (`vi.mock` plus a mutable variable), set to `false`:
  - The expanded header has a `Collapse sidebar` button. Clicking it calls `setSidebarCollapsed(true, true)`.
  - The collapsed rail renders an `Expand sidebar` button before the first project letter. Clicking it calls `setSidebarCollapsed(false, true)`.
  - No `Close sidebar` button on desktop.
  - The shortcuts list contains `Toggle sidebar`.
- The same file, mobile (the mocked `useIsMobile` returns `true`; rerender after flipping it for the transition case):
  - The expanded header has `Close sidebar` (`X`).
  - Going mobile → desktop calls `restorePersistedSidebarCollapsed` once. Mounting on desktop does not call it.
- `web-ui/src/resize/use-project-navigation-layout.test.ts` (new if absent): `restorePersistedSidebarCollapsed` reads the stored value after a non-persisted `setSidebarCollapsed(true, false)`.
- `web-ui/src/hooks/use-app-hotkeys.test.tsx`:
  - The shortcut fires with Meta and with Ctrl when `canToggleSidebar` is true.
  - It does not fire (and does not prevent default) when `canToggleSidebar` is false.
  - It fires while focus is in an `<input>`.

Run `npm run web:typecheck`, `npm run web:test`, and `npx @biomejs/biome check` on the touched files before pushing.

## Acceptance criteria

- Desktop: the header shows a panel-collapse icon. Clicking it collapses to the letter rail, and the rail's top icon expands it again. Both states survive a reload.
- `⌘\` / `Ctrl+\` toggles the sidebar on the home view, including while typing in a field. It does nothing in the task detail view or on mobile.
- Mobile: unchanged (`X` closes the drawer, the TopBar menu opens it).
- Narrowing the window to mobile and widening it back restores the sidebar to its persisted collapsed or expanded state.

## Out of scope

- A fully hidden desktop mode or a TopBar toggle on desktop.
- Showing task pills or activity indicators on the collapsed rail.
- Making the sidebar available in the task detail view.
