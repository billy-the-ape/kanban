# PRLINK-6 — PR metadata: first/last seen and a "primary" PR

**Status: PROPOSED (draft for refinement; execute only after PR-linking v1 has merged).**

Master plan: `PR_LINKING_PLAN.md`. Index of follow-ups: `PRLINK-FOLLOWUPS.md`.
Depends on: **PRLINK-0** (data model), **PRLINK-4** (card and top-bar display), **PRLINK-5** (manual management UI).
Unblocks: **PRLINK-7** (mobile link) and **PRLINK-10** (PRs tab) both want a stable "primary" PR.

## Purpose

v1 has no notion of a "main" PR. The card shows the **last element** of `pullRequests` (the most recently *first-recorded* PR), and the top bar shows all of them in recorded order. That is wrong when a task opens PR A, then a follow-up PR B, and A is the live one. This milestone:

1. Adds `firstSeenAt` / `lastSeenAt` timestamps to each stored PR.
2. Adds a user-settable **primary** flag so one PR is the one shown first in the board card and the task detail.
3. Defines a deterministic fallback when the user has not chosen one.

## Data model

Each PR is already one object: `runtimeTaskPullRequestSchema` in `src/core/api-contract.ts` (provider, host, repository, number, url, source, `createdAt`, optional title/state/stateCheckedAt). Add, all **optional** so existing `board.json` files and uncast web-ui mocks keep working (AGENTS.md "required field" trap):

```ts
firstSeenAt: z.number().optional(), // first time Kanban observed this PR
lastSeenAt: z.number().optional(),  // last time a capture/lookup path observed it again
isPrimary: z.boolean().optional(),  // user-chosen; at most one true per task
```

Rules:

- `createdAt` already means "first time Kanban recorded it". Do not rename it. Treat `firstSeenAt` as an alias populated from `createdAt` on read when missing (migration is read-time only; do not rewrite every card on load). Decide during implementation whether to keep both or fold `firstSeenAt` into `createdAt`; prefer **not** adding a duplicate field if `createdAt` is enough, and only add `lastSeenAt`.
- **`lastSeenAt` semantics**: updated when a capture path (Cline tool call, hook, delivery, branch lookup/refresh, manual re-add of an existing link) observes an already-stored PR. v1 deliberately does `save: false` on duplicate detections to avoid revision churn, so this needs a **throttle** (for example only write when the stored value is older than 10 minutes, or only on refresh and delivery). Pick one and document it; never bump the revision on every tool call.
- **`isPrimary` invariants**: at most one entry per task has `isPrimary: true`. Enforced in the mutation, not by the client. Removing the primary PR clears the flag (no automatic promotion of another entry to `isPrimary`; the fallback below handles display).
- Stays **server-owned**: `mergeServerOwnedPullRequests` in `src/state/workspace-state.ts` already restores the persisted array wholesale, so the new fields are protected for free. Do not add client-writable paths.

## Selection logic (single shared helper)

Add `getPrimaryPullRequest(pullRequests)` next to the identity helpers in `src/core/pull-request-links.ts` and expose it to web-ui through the same alias used for the shared identity key (see the PRLINK-4/5 review follow-up about replacing the duplicated `getPullRequestKey`). Resolution order:

1. The entry with `isPrimary === true`.
2. Otherwise the most relevant by state: prefer `open` (or `draft`), then the most recently first-recorded among the rest. State comes from the snapshot; entries without a snapshot sort as unknown, after `open`.
3. Otherwise the last element (today's v1 behavior).

`getLatestPullRequest` in `web-ui/src/utils/task-pull-requests.ts` becomes a thin caller of this helper (or is replaced by it). The card must **not** reimplement the order.

## API

- New board mutation in `src/core/task-board-mutations.ts`: `setPrimaryTaskPullRequest(board, taskId, identityKey | null, now)` returning `{ board, task, updated }`. `null` clears the flag. Unknown identity key returns `updated: false`.
- New tRPC route `workspace.setPrimaryTaskPullRequest` mirroring `addTaskPullRequest` / `removeTaskPullRequest` (request: `{ taskId, url }` re-parsed with `parsePullRequestUrl`, or `null` to clear; response: the existing link response schema). Broadcast only when the board changed.
- `addTaskPullRequests` gains no flag parameter; a manual add does not become primary automatically (see open question 2).

## UI

- **Board card** (`web-ui/src/components/board-card.tsx`): the compact `#123` link shows `getPrimaryPullRequest(card)`. Optionally show a tiny "+N" suffix when the task has more than one PR so the card hints there are others (tooltip lists them).
- **Task detail top bar** (`top-bar.tsx`): render the primary PR first, then the rest in recorded order. The overflow rule (3 inline, then "+N" popover) keeps the primary visible by always pulling it into the inline set.
- **Manager popover** (`task-pull-request-manager.tsx`): each row gets a "Make primary" action (Lucide `Star`, filled when primary) and the row for the primary is visually marked. Clearing returns to the fallback.
- Tooltip gains "first seen / last seen <relative time>" lines using the existing `formatApproximateAge` helper, labelled as approximate.

## Tests

- Contract: new optional fields round-trip; old cards without them still parse.
- `task-board-mutations.test.ts`: set/clear primary, single-primary invariant when setting a second, removing the primary clears it, unknown key is a no-op.
- `lastSeenAt` throttle: repeated detection inside the window does not bump the revision; outside the window it does.
- `getPrimaryPullRequest`: explicit primary wins; open beats merged/closed; unknown state falls back to last recorded; empty list returns null.
- `workspace-state.integration.test.ts`: a stale client save cannot flip `isPrimary` (server-owned).
- web-ui: card shows the primary, not the last; top bar orders primary first and keeps it inline when overflowing; manager action calls the route.
- Tests that touch workspace state redirect `HOME`/`USERPROFILE` (AGENTS.md).

## Acceptance

- A user can mark any PR as primary and the board card and task detail both show it first, after a reload and across column moves.
- With no explicit choice, a task with an open PR and an older merged PR shows the open one.
- Repeated tool calls do not churn the workspace revision.

## Open questions (refine before starting)

1. One field (`createdAt`) or two (`firstSeenAt` + `createdAt`)? Leaning one.
2. Should a newly detected PR from a **PR-creating tool call** auto-become primary when the task has no explicit primary, or only via the fallback ordering? Leaning fallback-only, so the user's explicit choice is never overridden.
3. Should merged/closed PRs ever be preferred over open ones when the user has not chosen? Leaning no.
