# PRLINK-10 — Pull requests view in task detail

**Status: PARTIALLY IMPLEMENTED ON MAIN; remaining work depends on PRLINK-6, PRLINK-7 and PRLINK-9.**
Master plan: [v1](../complete/pr-linking/PR_LINKING_PLAN.md). Shared context: [follow-ups](PRLINK-FOLLOWUPS.md).
Deliver the remaining work as one task-detail UI PR using the settled metadata/mutation routes.

## Landed baseline and remaining scope

Reviewed main on 2026-10-13 at `ced5894b46e628de5fe39fb88a38c55d2409235c`.
The manual changes in `0015d40` and `65291b1` already added **PRs (0)** beside All Changes / Last Turn
and moved `TaskPrTrackingPanel` into that segment in desktop and mobile task detail. The toolbar's
`pull_requests` value is UI-only; the server diff enum still contains only working_copy/last_turn.
Preserve this placement and build on it. Do not add a second PR tab or restore the settings panel
to its old location. This plan supersedes its earlier instruction not to move tracking settings.

The tab shell is not completion of PRLINK-10. Main still has a hard-coded count, no linked-PR rows
in this view, a combined toolbar/diff state that loses the previous diff mode, and an ungated diff
hook that substitutes working_copy while viewing PRs. The toolbar also depends on diff availability,
and CSS-hidden mobile panels stay mounted. Address these gaps under the requirements below.
The current tracking panel returns early while tracking data is unavailable or consumers are absent;
stored links must render independently of those branches.

### Existing TODOs owned by this task

- `web-ui/src/components/card-detail-view.tsx`, `DiffToolbar`: replace **PRs (0)** with **PRs (N)**,
  where N is `(selection.card.pullRequests ?? []).length`. Count all stored associations, including
  unknown, unsupported, closed and merged PRs; do not count only automation candidates or fetch a
  provider to compute it. Both toolbar call sites receive the same selected-card count, and normal
  authoritative board updates change it after add/remove/capture. Zero links still show **PRs (0)**.
- `web-ui/src/components/detail-panels/task-pr-tracking-panel.tsx`: the list/link/details and
  "MAIN" selection TODO means the rows and **Make primary for display** actions specified below.
  It does not mean a second Automation PR selector or an automation eligibility change. Keep the
  existing separately labelled **Automation PR** control and its validated mutation route.

Remove these TODOs when their requirements and acceptance checks are complete. Use these symbol
anchors rather than historical line numbers when rebasing onto current main.

## Fixed navigation

Desktop: finish the existing always-visible **PRs (N)** segment alongside All Changes / Last Turn in
the right-hand panel toolbar. Mobile: retain the existing Chat/Diff/Files top-level tabs and put the
same three segments inside Diff. The mobile primary anchor and management affordance from 7 remain
available. Do not add a top-level PR panel or remove Files to match an older plan's tab count.
PR navigation and stored rows remain available with no workspaceId or when the diff query fails;
do not gate the toolbar on `isRuntimeAvailable` from the diff hook.

Use local UI state for changes versus pull_requests, separate from RuntimeWorkspaceChangesMode
(working_copy/last_turn). Never send pull_requests to git-diff APIs or widen that server enum.
Selecting PRs changes only the view; retain the last diff mode. Selecting All Changes or Last Turn
sets its corresponding diff mode and returns to the changes view. Reset to All Changes and mobile
Chat on task/workspace change or remount. Main resets the combined diff state on task change but
does not reset mobileTab; implement the full reset explicitly. No localStorage preference or
persistent deep link.

Gate the diff hook/effects with an enabled flag or mount diff data logic only for a visible changes
view. Opening PRs must schedule no git/worktree/provider fetch and cancel/ignore late diff responses
without losing the last diff-mode choice. Hidden mobile panels must not add new diff requests.
Gate initial queries, state-version/view-key refetches, explicit refresh and interval effects;
setting pollIntervalMs to null alone is insufficient. On mobile, Diff showing changes and Files
may load the remembered diff mode; Chat and Diff showing PRs must not. Document-hidden, trash and
git-history views must not start detail-diff reads either. Already-started reads may finish, but
their late results must not overwrite a different task/workspace/view.

External board/top-bar/row PR anchors keep opening the provider URL; do not silently repurpose them
to select an internal tab. Desktop manager popover coexists as a compact quick action.

## Content and actions

Render from the selected card's stored links immediately; do not wait for network metadata.
Render the list/empty state even with no installed tracking consumers, while the tracking query
is loading or failed, or with no workspaceId. Stored rows and external Open links do not require
automation eligibility. Provide a full-width, scrollable PR view in both existing layout branches.
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

Keep one instance of the existing tracking settings/status section inside the PRs view, as main now
does. Preserve its checkbox behavior, feature-unavailable/native-Cline hints, Automation PR selector,
blockers, repair-owner information, lifecycle messages and explicit Resume PR tracking action.
Opening a tab, rendering links or changing the display primary never enables or resumes automation.
Reuse the panel's existing read-only tracking-state refresh; do not create another provider poller
or a second tracking-state timer for the list. Mount/enable its reads only for a visible PRs view
with workspace scope and installed consumers; CSS-hidden mobile panels must not keep polling.
No CI/checks, reviews/comments, PR diffs, merge button, PR creation, remote deletion or new provider
support in this view. **Remove link** removes association only, never closes the remote PR.

## Verification and acceptance

- Existing PRs tab with zero/nonzero count from all stored links; count updates after board broadcasts;
  empty state and all 20 entries in correct order, including with no workspace or tracking consumers,
  pending/failed tracking state and failed diff query. No duplicate tab/settings section.
- Opening/switching PRs does not invoke diff loaders, resolve/create worktree or refresh provider;
  Last Turn → PRs preserves last_turn; selecting Last Turn restores it, while All Changes explicitly
  selects working_copy. Task/workspace switches reset All Changes/Chat.
  Exercise initial query, timer, state-version update and late-response paths. Mobile Chat/hidden
  PRs schedule no diff/tracking reads; Files still loads the remembered diff without a PR panel.
- Existing external anchors remain external; desktop popover and mobile controls still work.
- Add/remove/primary/single refresh/all refresh/discovery use shared hook and distinct routes;
  pending, partial failure, unsupported and task-switch response isolation.
- Primary A / Automation PR B clearly labelled; display changes cause no lifecycle effect.
- 320/360/390px phone widths, long names, keyboard/focus, no horizontal overflow.
- No tracking data reads resume a stopped subscription; existing settings panel behavior preserved.
- Both TODOs are removed after their behavior is covered; display primary A and Automation PR B
  remain distinct after add/remove/refresh and task switching.

A user can inspect/manage all linked PRs in one view while Chat and git changes retain their behavior.
Follow the shared verification/deployment rules in PRLINK-FOLLOWUPS.md.
