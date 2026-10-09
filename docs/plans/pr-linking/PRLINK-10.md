# PRLINK-10 — Pull requests view in task detail

**Status: READY FOR IMPLEMENTATION. Depends on PRLINK-6, PRLINK-7 and PRLINK-9.**
Master plan: [v1](../complete/pr-linking/PR_LINKING_PLAN.md). Shared context: [follow-ups](PRLINK-FOLLOWUPS.md).
Deliver as one task-detail UI PR using the settled metadata/mutation routes.

## Fixed navigation

Desktop: add an always-visible **Pull requests (N)** segment alongside All Changes / Last Turn in
the right-hand panel toolbar. Mobile: retain Chat/Diff as top-level tabs and put the same three
segments inside Diff. The mobile primary anchor and management affordance from 7 remain available.
Do not add a third top-level mobile panel.

Use local UI state for changes versus pull_requests, separate from RuntimeWorkspaceChangesMode
(working_copy/last_turn). Never send pull_requests to git-diff APIs or widen that server enum.
Remember the last diff mode while viewing PRs; reset to All Changes/Chat on task change or remount,
matching the current local state behavior. No localStorage preference or persistent deep link.

Gate the diff hook/effects with an enabled flag or mount diff data logic only for a visible changes
view. Opening PRs must schedule no git/worktree/provider fetch and cancel/ignore late diff responses
without losing the last diff-mode choice. Hidden mobile panels must not add new diff requests.

External board/top-bar/row PR anchors keep opening the provider URL; do not silently repurpose them
to select an internal tab. Desktop manager popover coexists as a compact quick action.

## Content and actions

Render from the selected card's stored links immediately; do not wait for network metadata.
Order primary first, then retained original order. Each row shows repository + number, optional title,
state (unknown if absent), State checked as of an approximate age, source, First recorded and Last
observed. Distinguish Primary for display, Shown by default and Automation PR when selected;
primary is not an automation control.

Per row: external Open, Make primary for display (or clear explicit primary), Remove link, Refresh.
Footer: Link PR by URL, Refresh linked PRs, Find PRs for branch.
These last two have separate meanings from 9. Empty state explains agent capture, manual URL add
and native-chat shortcut, with an enabled Link action when workspace scope permits.
With no workspaceId show stored information/anchors only. Unsupported provider refresh is disabled
with a visible explanation, while manual/link actions remain available.

Extract `useTaskPullRequestActions` for add/remove/primary/refresh orchestration shared with the
manager and mobile controls. Keep pending state per action/identity and task scope; guard stale
responses and show errors without removing the stored row. Render long values with wrap/truncation,
scroll 20 rows, retain accessible labels/focus and 44px touch targets on mobile.
Read authorized tracking data through the existing tracking surfaces; no new polling timer.
Card snapshot fallback remains labelled historical, never proof of automation eligibility.

Do not move or duplicate existing tracking settings, repair-owner controls or lifecycle messages.
No CI/checks, reviews/comments, PR diffs, merge button, PR creation, remote deletion or new provider
support in this view. **Remove link** removes association only, never closes the remote PR.

## Verification and acceptance

- Always-visible tab with zero/nonzero count; empty state; all 20 entries in correct order.
- Opening/switching PRs does not invoke diff loaders, resolve/create worktree or refresh provider;
  returning to changes restores the remembered working_copy/last_turn mode.
- Existing external anchors remain external; desktop popover and mobile controls still work.
- Add/remove/primary/single refresh/all refresh/discovery use shared hook and distinct routes;
  pending, partial failure, unsupported and task-switch response isolation.
- Primary A / Automation PR B clearly labelled; display changes cause no lifecycle effect.
- 320/360/390px phone widths, long names, keyboard/focus, no horizontal overflow.
- No tracking data reads resume a stopped subscription; existing settings panel behavior preserved.

A user can inspect/manage all linked PRs in one view while Chat and git changes retain their behavior.
Follow the shared verification/deployment rules in PRLINK-FOLLOWUPS.md.
