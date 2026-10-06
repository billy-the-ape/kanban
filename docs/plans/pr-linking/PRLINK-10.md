# PRLINK-10 — "Pull requests" tab in the task detail

**Status: EXPLORATORY (vision; refine before it is scheduled).**

Master plan: `PR_LINKING_PLAN.md`. Index: `PRLINK-FOLLOWUPS.md`.
Depends on: **PRLINK-6** (primary flag, first/last seen), **PRLINK-7** (mobile entry point), and ideally **PRLINK-9** (state/title lookups across providers).

## Purpose

Promote PRs from "a few links in the top bar" to a first-class view in the task detail, a tab alongside **All Changes** and **Last Turn** in the diff panel. The top-bar link and the board-card link remain as quick entry points that open or deep-link to this tab.

## Where it lives

- The diff panel toolbar is `DiffToolbar` in `web-ui/src/components/card-detail-view.tsx` (the `All Changes` / `Last Turn` `DiffModeButton`s, mode values `working_copy` and `last_turn`). A third mode, `pull_requests`, adds the tab.
- Mobile uses `MobileDetailTabBar` with `chat` and `diff` panels. A PR tab there means either a third top-level mobile tab or a segment inside the diff panel; decide with PRLINK-7.
- Note the diff-mode state currently drives data loading for git diffs. The PR tab must not trigger diff fetches (no worktree reads, no `gh`) just by being selected.

## Proposed content

One row per stored PR, primary first (PRLINK-6), each showing:

- Label and repository (`owner/repo#123`, `MR !12` for GitLab), title, and the state chip (open / draft / merged / closed) with "as of <age>" from the snapshot.
- Source badge (agent, delivery, manual, branch lookup) and first/last seen.
- Actions: Open in new tab, Make primary, Remove, and a per-row Refresh that updates the snapshot.
- Footer actions that already exist in the manager popover: Link PR by URL and Refresh all. The popover can either stay as a compact version or be replaced by deep-linking to this tab.
- Empty state explaining how PRs get linked (agent creates one, paste a URL in chat per PRLINK-8, or add by URL).

Later, deliberately not in scope for the first cut: checks/CI status, review state, comments, and per-PR diff. Those need a provider API integration and are the real reason to have a tab, so keep the row component extensible.

## Implementation notes

- Reuse `TaskPullRequestLink`, `getPrimaryPullRequest` and the provider-aware label helpers. The row is a new component under `web-ui/src/components/`; keep the manager's mutation calls in a shared hook (`useTaskPullRequestActions`) so the popover, the tab and the mobile affordance share one implementation (AGENTS.md: extract domain logic, avoid presentation-only wrappers).
- Data comes from the card (`card.pullRequests`), which is already server-owned and broadcast; the tab adds no new read route. Per-row refresh needs a small server route (`refreshTaskPullRequest` by identity key) distinct from the whole-task refresh.
- Respect "never block the UI on a network call": snapshots render from stored data; refresh is explicit and shows progress.
- Tab visibility: always shown, or only when the task has ≥1 PR? Leaning always shown on desktop so "Link PR" is discoverable, with a count badge when non-empty.
- Persist the selected tab per task in the same way diff mode is persisted today (check `diffMode` handling in `card-detail-view.tsx` before choosing).

## Tests

- `card-detail-view.test.tsx`: tab appears, switching to it does not call diff loaders, rows render in primary-first order, empty state renders.
- Row actions call the shared hook; per-row refresh updates only that row's snapshot.
- Mobile layout test at phone width.
- Server: per-row refresh route test with `HOME`/`USERPROFILE` isolation.

## Acceptance

- A task with several PRs shows them all in one tab with the primary first and a clear state per PR.
- Selecting the tab never triggers a git diff load or a network call.
- Top-bar and card links still work and can deep-link to the tab.

## Open questions

1. Third tab in the diff toolbar, or a separate panel next to Chat/Diff?
2. Does this tab replace the top-bar popover on desktop, or coexist with it?
3. How much PR detail (CI, reviews) is worth pulling in, and does that justify an API client instead of CLI shell-outs?
