# PRLINK-6 — Observation timestamps and a primary display PR

**Status: READY FOR IMPLEMENTATION; depends on landed PR-linking v1.**
Master plan: [v1](../complete/pr-linking/PR_LINKING_PLAN.md). Shared context: [follow-ups](PRLINK-FOLLOWUPS.md).
Deliver as one implementation PR. No higher-level product decisions remain open.

## Fixed behavior

Primary means **display preference**, never automation authority. Do not read or write
`selectedAutomationPrKey`, checkbox settings, tracking generations, repair ownership or completion
markers when choosing/clearing a primary. Label the action **Make primary for display**; explain
that Automation PR is selected separately. Preserve the foundation's validated selection rules.

Keep `createdAt` as first recorded time; show it as **First recorded**. Do not add `firstSeenAt`.
Add only optional `lastSeenAt: number` and `isPrimary: boolean` fields to
`runtimeTaskPullRequestSchema`. Timestamps are server epoch milliseconds, finite and nonnegative.
Missing `lastSeenAt` displays `createdAt`; old cards require no bulk migration.

A new record sets lastSeenAt = createdAt = now. Successful capture, delivery, branch discovery,
manual re-add and successful provider metadata observation may advance lastSeenAt. Merely rendering,
loading a board, choosing primary, or a failed provider read never advances it.
Coalesce duplicate observations: advance only when now - (lastSeenAt ?? createdAt) >= 600,000 ms;
never move backward if the clock regresses. If other fields already require a save, include the
newer observation time in that same write. Throttled duplicate observations remain save:false.
This is an observation timestamp, **not** proof of state freshness; stateCheckedAt remains separate.
Polling must not add a timestamp-only write every minute.

Use one pure shared getPrimaryPullRequest(list) helper in `src/core/pull-request-links.ts`.
Resolve by these rules, with no sorting/mutation of stored order:

1. Explicit isPrimary:true wins, even if closed, merged or unknown.
2. Otherwise pick the newest first-recorded open or draft entry (same priority).
3. Otherwise pick the newest first-recorded unknown-state entry.
4. Otherwise pick the newest first-recorded merged or closed entry.
5. Empty list returns null.

Newest compares createdAt descending, then later original array index for equal timestamps.
For malformed older data with several true flags, select the same newest winner deterministically;
the next successful primary mutation clears the other flags. Add ordered display helper returning
the winner first and all other entries in original order, without mutating the input.

## Mutation and integration

Add setPrimaryTaskPullRequest(board, taskId, identityKey | null, now), returning board/task/updated.
Expose workspace.setPrimaryTaskPullRequest({ taskId, url: string | null }) using the existing
link-response style: strict server URL parse, missing task/unknown link gives ok:false and no save;
null clears all flags; selecting the same sole primary or clearing an already clear task succeeds
without revision/broadcast. The response returns the selected link, or null when cleared.
Set/clear under mutateWorkspaceState, preserving concurrent links and unrelated card fields.
Incoming capture/manual-add inputs may not set primary. Keep the server-owned board merge protection.

Removal leaves no explicit primary; fallback handles display. Cap remains 20, but implicit eviction
must protect both explicit primary and the selected Automation PR. Evict the oldest unprotected
non-manual entry first, otherwise oldest unprotected manual entry. Keep retained entries ordered.
With at most one display primary and one selected Automation PR there is always an eviction candidate.
Do not alter automation selection to make room; test both protected identities.
Explicit unlink still uses the foundation's existing invalidation/reconciliation behavior.

Update recordTaskPullRequests and lookup snapshot writes in one transaction per observation batch;
the current recorder returns changed:false for both duplicate and failure, so do not infer successful
recording from that boolean alone. Snapshot updates preserve all display/observation fields.
Successful metadata reads from tracking may project these display fields through the existing board
mutation path; an authorized read updates stateCheckedAt even when title/state are unchanged.
No capture/delivery event may overwrite a newer authoritative state snapshot.

## UI

Board compact link uses the shared winner. Desktop top bar shows winner first, then remaining links
in recorded order; keep the winner inline under the existing overflow limit. Manager rows use that
order, distinguish explicit **Primary for display** from **Shown by default**, and offer **Use automatic
display order** to clear. Use pending/error states and authoritative broadcasts, not optimistic flags.
Show First recorded, Last observed (approximate), and State checked as distinct tooltip lines.
No extra board-card count badge in this milestone.

## Verification and acceptance

- Contract: old cards parse; new fields round-trip; stale client saves cannot forge/drop flags.
- Pure selection: all four state groups, equal timestamps, explicit terminal primary, duplicate flags,
  empty array, stable remaining order, no mutation.
- Mutation: set second/clear/remove/no-op/unknown task and key; primary and Automation PR cap protection.
- Observation: 599,999 ms no save, 600,000 ms save once, clock regression, snapshot change inside window,
  failed lookup, unchanged successful metadata refresh, batch one revision; preserve primary/source.
- Integration: primary A with Automation PR B changes display only; no settings/generation/polling/
  completion/repair effect. Removing A leaves B selected.
- UI: card/top bar/manager agree after restart, moves and overflow; mutation failure leaves old choice.

Follow the shared verification/deployment rules in PRLINK-FOLLOWUPS.md.
