# PRLINK-7 — Primary PR link in the mobile task detail

**Status: PROPOSED (draft for refinement; execute only after PR-linking v1 has merged).**

Master plan: `PR_LINKING_PLAN.md`. Index: `PRLINK-FOLLOWUPS.md`.
Depends on: **PRLINK-4**. Benefits from **PRLINK-6** (primary PR) but can ship first using the v1 "latest" PR.

## Purpose

Make the task's main PR reachable from the task detail on mobile.

## Current state (verified against `feat/task-pr-links` at `0e4f3ec`)

- **Board card: yes, on all viewports.** `board-card.tsx` renders `TaskPullRequestLink variant="compact"` for `getLatestPullRequest(card)` in the card header, in every column including Done and Trash. Nothing in that path is desktop-only. (It is only visible on mobile while the board is showing; once a task is opened in detail, the card is not on screen.)
- **Task detail top bar: no, not on mobile.** The PR links, the "Link PR" / manage popover and the refresh action all live inside `TopBarGitStatusSection`, which `TopBar` renders only in the `!isMobile` branch ("Desktop-only: open-workspace button, hints, git status", `top-bar.tsx` around line 551). On mobile the task detail therefore has no PR link at all.
- Mobile task detail is `card-detail-view.tsx` with `MobileDetailTabBar` and `chat` / `diff` panels (`isMobile` branch around line 734). The top bar on mobile is a compact title area (`max-w-[180px]`).

## Proposed behavior

Surface the primary PR (or latest, until PRLINK-6) as a compact, tappable affordance in the mobile task detail. Candidate placements, pick one during refinement:

1. **Next to the title in the mobile top bar**: a compact `#123` link after the task title, reusing `TaskPullRequestLink variant="compact"`. Cheapest; competes for the narrow title space.
2. **In `MobileDetailTabBar`**: a trailing icon button (`GitPullRequest`, 44px touch target via `MOBILE_TOUCH_TARGET`) that opens the PR in a new tab when there is one PR, or a small popover listing all PRs when there are several. Same popover can host the "Link PR" and Refresh actions so mobile gets the PRLINK-5 manual management too.
3. **A header strip above the chat panel** when the task has PRs: one line with the primary PR and a "+N" for the rest. Most discoverable; uses vertical space in a chat-first layout.

Recommendation: option 2 for the link and management popover, so the title area is untouched and the touch target is correct.

## Implementation notes

- Reuse `TaskPullRequestLink` and `TaskPullRequestManager`; do not fork them. The manager's popover must be checked at phone width (it is `w-72`) and in a Radix Portal so it is not clipped by the tab bar.
- Touch targets: follow `MOBILE_TOUCH_TARGET` (`min-w-[44px] min-h-[44px]`) from `top-bar.tsx`. Links need adequate hit areas, since the desktop link is a 12px text link.
- The anchor already stops `mousedown`/`click` propagation; confirm that touch events (`onTouchStart`) do not trigger card drag or a tab switch.
- `workspaceId` and `selectedTaskPullRequests` are already threaded from `App.tsx` into `TopBar`; the mobile placement needs the same two values in `CardDetailView`. Prefer passing the `RuntimeBoardCard`'s `pullRequests` rather than adding another prop chain.
- No server change.

## Tests

- `card-detail-view.test.tsx` (mobile via the existing `useIsMobile` mock): PR affordance renders when the card has PRs; absent when it has none and no `workspaceId`; link opens with `target="_blank" rel="noopener noreferrer"`.
- Popover lists all PRs with the primary first once PRLINK-6 lands.
- Manual add from the mobile popover calls `addTaskPullRequest`.
- Desktop rendering is unchanged (regression assertion in `top-bar.test.tsx`).

## Acceptance

- On a phone-width viewport, opening a task with a recorded PR shows a one-tap path to the PR, and a task with none shows a way to link one.
- No horizontal overflow at 360px wide.

## Open questions

1. Placement (1, 2 or 3 above)?
2. Should the mobile popover include Refresh, or is manual add/remove enough on mobile?
