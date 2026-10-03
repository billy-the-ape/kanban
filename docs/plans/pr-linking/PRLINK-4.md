# PRLINK-4 — UI: PR links in top bar and board card

Master plan: `PR_LINKING_PLAN.md` (this is milestone **PL-5**).
Depends on: **PRLINK-0** (contract field + helpers). Can land in parallel with PRLINK-1…PRLINK-3 — seed `pullRequests` in test data; no capture path is required to render.

## Purpose

Render recorded PRs in the two places the user looks:

1. **Task detail top bar** — right after the branch name and before the `(N files +A -D)` diff summary: `PR #123` links (all of them, overflow-collapsed beyond 3) that open in a new tab.
2. **Board card** — any card in any column (including Done/trash) with ≥1 PR shows the most recent one as a compact `#123` link in the card's top-right area.

## Stack and conventions (web-ui)

- Tailwind v4 design tokens only (`bg-surface-*`, `text-accent`, `text-status-*`, …); no `dark:` prefixes, no inline styles except truly dynamic values.
- Primitives: `@/components/ui/button`, `@/components/ui/tooltip`, `cn` from `@/components/ui/cn`; Radix for headless behavior; `lucide-react` icons (12–14px here); `sonner`/`showAppToast` for toasts (not needed in this milestone).
- Pure helpers in `web-ui/src/utils/` get a colocated `.test.ts`; components get a colocated `.test.tsx` (vitest + testing-library, see existing `board-card.test.tsx` / `top-bar.test.tsx`).
- Types: `RuntimeTaskPullRequest` and `RuntimeBoardCard` are available via `@/runtime/types` (re-exports `src/core/api-contract.ts` via `@runtime-contract`).

## Re-verify before starting (code moves)

- `GitBranchStatusControl` at `web-ui/src/components/top-bar.tsx:113` — two variants:
  - with `onToggleGitHistory` (`:128`): `<div className="flex items-center min-w-0 overflow-hidden">` → branch `Button` (`GitBranch` icon, `font-mono text-xs`) → diff summary `<span className="font-mono text-xs text-text-tertiary ml-1.5 shrink-0 whitespace-nowrap">`.
  - static (`:153`): single `<span className="font-mono text-xs text-text-secondary mr-1 whitespace-nowrap">` with branch + diff.
- `TopBarGitStatusSection` at `:169` renders the home-branch control (`:209`, pass **no** PRs) and the task-branch control (`:264`, this is where PRs go).
- `TopBar` props at `:281` (`selectedTaskId`, `selectedTaskBaseRef`, …). `App.tsx` renders `<TopBar …>` at `:841` with `selectedCard` from `useDetailTaskNavigation` (`:230`) — `selectedCard.card` is the `RuntimeBoardCard` (`selectedTaskId={selectedCard?.card.id ?? null}` at `:848`).
- Board card header row: `web-ui/src/components/board-card.tsx:566` `<div className="flex items-center gap-2" style={{ minHeight: 24 }}>` → status marker → title block (`flex-1 min-w-0`) → `TaskPhaseBadge` (`:619`, only when `columnId !== "trash"`) → column action buttons (backlog `Play` `:622`, review `Check` `:634`, …). `stopEvent` helper at `:341` stops propagation for interactive children; trash cards strike through the title (`:612`, `:586`).
- Anchors must **not** be nested inside a `<button>` (invalid HTML) — in the top bar the links are siblings of the branch Button.

## Implementation

### 1. Pure helpers — new `web-ui/src/utils/task-pull-requests.ts`

```ts
import type { RuntimeBoardCard, RuntimeTaskPullRequest } from "@/runtime/types";

/** The card's most recent PR (last recorded), or null. */
export function getLatestPullRequest(card: RuntimeBoardCard): RuntimeTaskPullRequest | null;

/** "PR #123" / "MR !123" (full) or "#123" / "!123" (compact). */
export function formatPullRequestLabel(
	pr: RuntimeTaskPullRequest,
	variant: "full" | "compact",
): string;

/** Tooltip lines: "owner/repo#123", snapshot title (if any), "state as of …" (if any). */
export function getPullRequestTooltipLines(pr: RuntimeTaskPullRequest): string[];
```

- GitLab → `!` prefix (`MR !123` / `!123`); github and bitbucket → `#` (`PR #123` / `#123`).
- Tooltip state line: only when `state` **and** `stateCheckedAt` are present — `state as of <relative time>` (check `web-ui/src/utils/` for an existing relative-time helper before writing one; if none exists, a small local formatter is fine — label it as an approximate age, e.g. "2h ago"; never block on the network).
- Colocated `task-pull-requests.test.ts`: label formats per provider/variant, latest-of-many, null for empty/undefined `pullRequests`, tooltip lines with and without snapshot.

### 2. Link component — new `web-ui/src/components/task-pull-request-link.tsx`

```tsx
export function TaskPullRequestLink({
	pullRequest,
	variant, // "full" | "compact"
	className,
}: {
	pullRequest: RuntimeTaskPullRequest;
	variant: "full" | "compact";
	className?: string;
}): React.ReactElement
```

- Renders `<a href={pullRequest.url} target="_blank" rel="noopener noreferrer">`.
- `full`: `GitPullRequest` icon (Lucide, 12px) + `formatPullRequestLabel(pr, "full")`; `compact`: label only.
- Wrapped in `Tooltip` from `@/components/ui/tooltip` with `getPullRequestTooltipLines` (multi-line: join lines, or render a `<div>` per line in the tooltip content).
- `onMouseDown` and `onClick` both call `event.stopPropagation()` so card drag, card selection, and the branch-history toggle never fire.
- Styling (tokens only, via `cn`): base `font-mono text-xs text-accent hover:text-accent-hover hover:underline inline-flex items-center gap-1 shrink-0`; optional state tint — `merged` → `text-status-purple`, `closed` → `text-status-red` (tint replaces the accent text color only, keep hover behavior; `open`/`draft`/no state stay `text-accent`).

### 3. Task detail top bar — `web-ui/src/components/top-bar.tsx`

- `GitBranchStatusControl`: new optional prop `pullRequests?: RuntimeTaskPullRequest[]`.
  - Button variant (`:128`): between the branch `Button` and the diff-summary `<span>`, insert:

    ```tsx
    {pullRequests && pullRequests.length > 0 ? (
      <div className="ml-1.5 flex items-center gap-1.5 shrink-0">
        {visible.map((pr) => (
          <TaskPullRequestLink key={identityOf(pr)} pullRequest={pr} variant="full" />
        ))}
        {overflowCount > 0 ? (/* +N popover, below */) : null}
      </div>
    ) : null}
    ```

  - Static variant (`:153`): the home branch control never receives `pullRequests` (see wiring), so it may be left unchanged; if you do render links there, restructure the outer `<span>` to `inline-flex items-center` only when the prop is present.
  - **Overflow**: show at most 3 links; when there are more than 3, render the **latest 2** plus a `+N` affordance (small ghost `Button` or span, `text-text-tertiary`) opening a Radix popover (`@radix-ui/react-popover`, pattern already used in this file — see the shortcut picker at the top of `top-bar.tsx`) listing the remaining links as `full` `TaskPullRequestLink`s.
  - "Latest" = end of the array (order of first record, per PRLINK-0).
- `TopBarGitStatusSection` (`:169`): new optional prop `pullRequests?: RuntimeTaskPullRequest[]`; pass it to the **task** branch control (`:264`) only; the home branch control (`:209`) passes nothing.
- `TopBar` (`:281`): new optional prop `selectedTaskPullRequests?: RuntimeTaskPullRequest[] | null`, threaded into `TopBarGitStatusSection` at its call site (`:504`).
- `web-ui/src/App.tsx` (`:841`): add `selectedTaskPullRequests={selectedCard?.card.pullRequests ?? null}` next to `selectedTaskId`/`selectedTaskBaseRef`.

### 4. Board card — `web-ui/src/components/board-card.tsx`

In the header row (`:566`), immediately **before** `TaskPhaseBadge` (`:619`) and the column action buttons:

```tsx
{latestPullRequest ? (
  <TaskPullRequestLink
    pullRequest={latestPullRequest}
    variant="compact"
    className="shrink-0"
  />
) : null}
```

where `latestPullRequest = getLatestPullRequest(card)` is computed once near the top of the component body.

- Appears in **every** column, including Done/trash (`trash` renders no `TaskPhaseBadge`, so the link sits where the badge would be — that is correct).
- In trash cards the title is struck through (`:612`); the link must **not** inherit `line-through` (it does not — the class is on the title `<p>` only; assert in tests).
- The component stops its own `mousedown`/`click` propagation (PRLINK-4 §2), so no `stopEvent` wrapper is needed; verify the card drag-start handler (root `onMouseDownCapture` area, `:499`) does not fire when starting a drag from the link.

## Tests

- **`web-ui/src/utils/task-pull-requests.test.ts`** (new) — see §1.
- **`web-ui/src/components/board-card.test.tsx`** (extend; existing file seeds cards locally — add `pullRequests` to the test card factory or a dedicated card):
  - Card with PRs in `in_progress` (or any non-trash column) shows the compact `#123` anchor, positioned before the phase badge in the DOM order.
  - With multiple PRs, only the **latest** (last element) is shown.
  - In `trash`, the link renders without `line-through`; anchor has `target="_blank"` and `rel="noopener noreferrer"`.
  - `mousedown`/`click` on the link do not trigger card selection/handlers (assert the card's onClick/onMouseDown spy was not called).
  - Card without `pullRequests` renders exactly as before (no anchor, no layout shift classes).
- **`web-ui/src/components/top-bar.test.tsx`** (extend):
  - Task branch control with 1–3 PRs renders all `PR #n` links between the branch button and the `(N files …)` span, each an `<a target="_blank" rel="noopener noreferrer">`.
  - With 5 PRs: exactly 2 links + a `+3` control; opening the popover lists the remaining 3.
  - GitLab PR renders `MR !123`.
  - Home branch summary (no task selected) renders no PR links.
  - Merged snapshot state applies `text-status-purple`.

## Verification

```sh
npm run web:typecheck
npm run web:test
npx @biomejs/biome check web-ui/src
npm run typecheck   # contract ripple
```

Manual: seed a scratch workspace's `board.json` with 1, 3, and 6 `pullRequests` on three cards (mix github/github/GitLab, one with `title`/`state: "merged"`/`stateCheckedAt`). In the UI: board shows compact `#n` in every column including trash; task detail top bar shows the links between branch and diff summary with correct overflow; clicking opens a new tab (or at least the anchor has correct `href`/`target`); no drag/selection fires when clicking a card link.

## Acceptance criteria

- All PRs visible in the task detail top bar (overflow beyond 3 collapsed into a `+N` popover); latest-only on board cards.
- Links open in a new tab with `rel="noopener noreferrer"`; propagation stopped on cards.
- Only design tokens used; no inline styles; no new runtime dependencies (Radix popover + Lucide already in use).
- Existing mock card factories still compile (field optional) — `npm run web:typecheck` green without touching unrelated mocks.

