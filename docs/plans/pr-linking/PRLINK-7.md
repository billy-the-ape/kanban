# PRLINK-7 — Mobile PR access and management

**Status: READY FOR IMPLEMENTATION. Depends on v1 and PRLINK-6.**
Master plan: [v1](../complete/pr-linking/PR_LINKING_PLAN.md). Shared context: [follow-ups](PRLINK-FOLLOWUPS.md).
Deliver as one UI PR; no new server route or mobile navigation architecture.

## Fixed layout and interaction

Use the trailing area of MobileDetailTabBar in `web-ui/src/components/card-detail-view.tsx`.
Keep Chat/Diff as the two top-level tabs and leave the narrow title bar unchanged.
For a task with links, show a compact anchor for the primary display PR and a separate
GitPullRequest management button. The anchor opens the provider URL in one tap. The management
button always opens the same manager, irrespective of link count; never switch its meaning from
external navigation to popover when a second PR arrives.

For zero links and a workspaceId, show **Link PR** as the management trigger. With no workspaceId,
existing links remain readable/openable; omit management actions. Use the selected card's
pullRequests as the source. Reset pending/form/popover state on workspace/task change so a late
response from task A cannot update task B.

Reuse TaskPullRequestLink and TaskPullRequestManager, including primary order/actions from 6.
Make the manager's trigger/presentation configurable rather than duplicating mutation logic.
Include Add, Remove, Make primary for display, clear primary and the existing task-wide Refresh.
Until PRLINK-9, that Refresh retains its current branch-discovery behavior; do not claim it updates
every manually linked PR. Primary remains separate from Automation PR.

## Accessibility and layout

All mobile interactive hit areas, including each PR anchor and row action, are at least 44 x 44 px.
Use a Radix Portal, collision-aware placement, viewport-bounded width and scrollable content.
At 320/360 px, long titles/repositories and all 20 links must wrap/truncate without horizontal
overflow. Do not rely on a hover tooltip for names or state; provide accessible labels and visible
repository information in manager rows. Focus returns to trigger on close; Escape/dismiss works.
Links retain target="_blank" and rel="noopener noreferrer". Anchor touch/click must not switch tabs,
open task selection or begin dragging. Desktop remains unchanged.

## Implementation order

1. Adapt existing manager trigger/mobile sizing and primary anchor hit area.
2. Render the trailing controls in MobileDetailTabBar using current task/workspace scope.
3. Add pending/error feedback and task-change reset without creating a second PR state cache.
4. Verify the phone layouts and desktop regressions.

## Verification and acceptance

- Mobile tests: zero/one/multiple PRs, primary link, no workspaceId, Add/Remove/set/clear/Refresh.
- Anchor is an external link; management remains a button for every count; touch/click does not
  trigger navigation/drag/tab changes.
- Pending mutation double-tap prevention, error feedback, task switch during an in-flight request.
- Keyboard/focus and phone-width checks at 320/360/390 px with long names and 20 entries.
- Desktop top bar/manager still render and behave normally.

A user can open the displayed PR directly and manage all links from either mobile panel,
without changing the title layout or losing Chat/Diff access.
Follow the shared verification/deployment rules in PRLINK-FOLLOWUPS.md.
