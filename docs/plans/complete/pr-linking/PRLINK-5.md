# PRLINK-5 — Manual add/remove and optional refresh

Master plan: `PR_LINKING_PLAN.md`.
Depends on: **PRLINK-4** (top-bar PR link UI to hang the affordance on) and **PRLINK-1** (`recordTaskPullRequests`).

## Purpose

Detection will never be perfect, so give the user the safety net (master plan Requirement 7):

1. Add a PR link by hand and remove a wrong one (tRPC + popover UI in the task detail).
2. Optional best-effort **branch lookup** when a task moves to Review with no PR, plus an opt-in **Refresh** action — writing the snapshot (`title`, `state`, `stateCheckedAt`).

## Re-verify before starting (code moves)

- tRPC workspace API: `src/trpc/workspace-api.ts` — `CreateWorkspaceApiDependencies` at the top (`broadcastRuntimeWorkspaceStateUpdated` already a dep); `saveState` implementation around `:430` (catches `WorkspaceStateConflictError` → `TRPCError CONFLICT`); router wiring in `src/trpc/app-router.ts` (`workspace` router at `:765`, `saveState` procedure at `:852` — follow that exact shape for new procedures).
- Request validation convention: zod request/response schemas in `src/core/api-contract.ts` + `parse*Request` functions in `src/core/api-validation.ts` (pattern: `parseHookIngestRequest` at `:692`).
- Board mutations from PRLINK-0 in `src/core/task-board-mutations.ts`: `addTaskPullRequests`, `removeTaskPullRequest`, `updateTaskPullRequestSnapshot`; `getPullRequestIdentityKey` from `src/core/pull-request-links.ts`.
- `recordTaskPullRequests` from PRLINK-1 (`src/workspace/task-pull-requests.ts`) — single write path; manual adds go through it with `source: "manual"`.
- Task worktree resolution: `resolveTaskCwd` from `src/workspace/task-worktree.ts` (used by `workspace-api.ts` git log/refs routes with `{ ensure: false }`).
- gh execution: use direct `execFile("gh", [...])` (see how `git-delivery.ts` runs gh — `GhCommandResult` with `missingBinary` flag) — **never** an interactive shell (AGENTS.md).
- Top-bar PR links from PRLINK-4 live in `GitBranchStatusControl` (`web-ui/src/components/top-bar.tsx`); `TaskPullRequestLink` supports propagation-stopping anchors.
- Toasts: `showAppToast` from `@/components/app-toaster` (sonner).

## Implementation

### 1. Contract + validation

In `src/core/api-contract.ts`:

```ts
export const runtimeTaskPullRequestLinkRequestSchema = z.object({
	taskId: z.string(),
	url: z.string().min(1).max(2048),
});
export const runtimeTaskPullRequestLinkResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
	pullRequest: runtimeTaskPullRequestSchema.nullable(), // for add; null for remove / not-found
});
```

Plus a `refreshTaskPullRequests` request (`{ taskId }`) and response (`{ ok, updated: number, error? }`). Add matching `parse*` functions in `src/core/api-validation.ts`.

### 2. tRPC mutations — `src/trpc/workspace-api.ts` + `src/trpc/app-router.ts`

- `addTaskPullRequest(workspaceScope, input)`:
  - `parseTaskPullRequestLinkRequest`; `parsePullRequestUrl(input.url)` — the **server is authoritative**; invalid URL → `ok: false` with a clear message (never store raw text).
  - `recordTaskPullRequests({ workspacePath: scope.workspacePath, taskId, links: [parsed], source: "manual" })`; if `changed` broadcast via `deps.broadcastRuntimeWorkspaceStateUpdated`; return the recorded entry (re-read from the board) or the existing identical one.
- `removeTaskPullRequest(workspaceScope, input)`: parse the URL to an identity key, `mutateWorkspaceState` + `removeTaskPullRequest` board mutation (`save: result.removed`), broadcast on change. (This mutation has no "add" counterpart in `recordTaskPullRequests`, so it is the one direct `mutateWorkspaceState` call outside the record path — keep it here and documented.)
- `refreshTaskPullRequests(workspaceScope, input)`: runs the branch lookup (below) for the task's current branch and returns how many entries changed.
- Wire all three as `workspaceProcedure` mutations in `src/trpc/app-router.ts` next to `saveState` (`:852`).
- Unknown task → `ok: false` (no throw), matching the neighboring routes' error style.

### 3. UI — "Pull requests" affordance in the task detail top bar

- In `GitBranchStatusControl` (`top-bar.tsx`), next to the PR links add a `+` icon button (ghost, 12–14px `Plus`); when the task has no PRs, render a compact `Link PR` ghost button (Lucide `Link` icon + text) instead. Only for the **task** branch control (home passes nothing, as in PRLINK-4). Thread a new optional `onManagePullRequests`-style callback or, simpler, render the popover **inside** `GitBranchStatusControl` given `pullRequests` + the task id + tRPC client access already available in the web-ui runtime layer (follow how other top-bar controls invoke runtime mutations).
- Popover (Radix, same pattern as PRLINK-4 overflow popover):
  - URL input with **live client-side validation** (cheap shape check: http(s) + contains `/pull/`, `/pull-requests/`, or `/-/merge_requests/`; show inline error text). The server re-validates with the strict parser — it is authoritative; on server error, surface it in the popover and via `showAppToast`.
  - Submit calls `addTaskPullRequest`; on success the new link appears (state refresh comes from the broadcast; also optimistically close the popover).
  - List of all current PRs (`full` `TaskPullRequestLink`s) each with an `X` button (`X` Lucide, ghost) calling `removeTaskPullRequest`.
  - A `Refresh` row/button (see §4) with a `Spinner` while in flight.
- New component file `web-ui/src/components/task-pull-request-manager.tsx` (single-responsibility: the popover + input + list); keep `top-bar.tsx` to threading.

### 4. Branch lookup + refresh — new `src/workspace/task-pull-request-lookup.ts`

```ts
export interface TaskPullRequestLookupInput {
	workspacePath: string;
	taskId: string;
	/** Branch to query. When omitted, resolved inside the helper (see below). */
	branch?: string;
	/** Injectable gh runner (defaults to execFile — tests pass fakes). */
	gh?: (args: string[], cwd: string) => Promise<GhCommandResult>;
}

export async function lookupTaskPullRequests(input: TaskPullRequestLookupInput): Promise<{ recorded: number }>
```

- Resolve the task worktree with `resolveTaskCwd({ cwd: workspacePath, taskId, baseRef: card.baseRef, ensure: false })` (`baseRef` is a required `string`; read it from the card). When there is no worktree, no-op (return `{ recorded: 0 }`).
- Run **directly** (never an interactive shell): `gh pr list --head <branch> --state all --json number,url,title,state --limit 5` in the worktree with a short timeout (~10s). Reuse the gh runner conventions from `git-delivery.ts` (`missingBinary` detection).
- Skip silently (log at debug, no error) when: `gh` missing (ENOENT/`missingBinary`), gh exits non-zero (unauthenticated, no remote), or the worktree is gone.
- Map results: `state` OPEN → `open`, MERGED → `merged`, CLOSED → `closed` (gh's `state` enum has no draft; leave `draft` unset). Record each URL via `parsePullRequestUrl` + `recordTaskPullRequests(..., source: "branch_lookup")` with snapshot `{ title, state, stateCheckedAt: Date.now() }`.
- **Never on a hot path, never blocking**: every caller uses fire-and-forget (`void …catch(log)`).

Wiring:

- **Transition to Review with no PR**:
  - `src/trpc/hooks-api.ts`: in the `to_review` branch, after the transition succeeds, read the card; if `(card.pullRequests ?? []).length === 0`, fire the lookup **without awaiting it** and without a `branch`. The helper then resolves the branch itself, inside the fire-and-forget work, with a direct `execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree })` (no shell). It skips the lookup on a detached `HEAD` or any git error. Because nothing awaits it, the transition and ingest response are never delayed.
  - `src/trpc/workspace-api.ts` `saveState`: diff the old and new board; for any card that moved **into** `review` and has no `pullRequests`, fire the lookup.
- **Refresh action**: the `refreshTaskPullRequests` tRPC mutation (§2) calls the same helper synchronously (it is user-initiated, so a bounded await with the 10s timeout is fine) and returns `recorded`.

## Tests

- **New `test/workspace/task-pull-request-lookup.test.ts`** (redirect `HOME`/`USERPROFILE`; fake `gh` runner):
  - `gh pr list` returning 2 PRs → 2 `branch_lookup` entries with title/state/`stateCheckedAt` snapshots; gh state mapping (OPEN/MERGED/CLOSED).
  - `missingBinary` / non-zero exit → `{ recorded: 0 }`, no throw, nothing recorded.
  - No task worktree → no-op.
  - Re-run with same PRs → dedupe (no new entries; snapshot refresh via `updateTaskPullRequestSnapshot` path only when provided).
- **Extend `test/runtime/trpc/workspace-api.test.ts`**:
  - `addTaskPullRequest` with a valid URL records `source: "manual"` and broadcasts; invalid URL (`https://github.com/o/r/issues/3`, `not a url`) → `ok: false`, board untouched.
  - Duplicate add → `ok: true`, no revision bump.
  - `removeTaskPullRequest` removes the matching entry (case-insensitive identity), unknown URL → `ok: false` or no-op per chosen semantics (document).
  - Unknown task → `ok: false`.
- **Extend `test/runtime/trpc/hooks-api.test.ts`**: `to_review` on a card without PRs triggers the lookup (spied); with existing PRs it does not.
- **web-ui** (new `task-pull-request-manager.test.tsx` + extend `top-bar.test.tsx`):
  - `+` / `Link PR` affordance renders in the task branch control; not in the home control.
  - Invalid URL input shows inline validation error and does not call the mutation.
  - Submit calls `addTaskPullRequest`; success shows the new link.
  - Each listed PR has a remove button that calls `removeTaskPullRequest`.
  - Refresh shows a spinner while the mutation is in flight.

## Verification

```sh
npx @biomejs/biome check src test web-ui/src
npm run typecheck
npm run test:fast
npx vitest run test/workspace   # task-pull-request-lookup.test.ts; not covered by test:fast or test:integration
npm run web:typecheck && npm run web:test
```

Manual (end-to-end, scratch repo with GitHub remote):

1. Task with a PR created by the agent (PRLINK-1) — open the `+` popover, add a second, *different* PR URL by hand, confirm it appears on the card/top bar and `board.json` shows `source: "manual"`.
2. Remove one with `X`; confirm it disappears from both surfaces and `board.json`.
3. Add a bogus URL → inline error, nothing stored.
4. Move a PR-less task to Review (worktree has an open PR pushed manually) → the lookup attaches it with `source: "branch_lookup"` and a title snapshot, without blocking the move.
5. Refresh with a stale snapshot → `state`/`stateCheckedAt` update (e.g. after merging the PR: shows merged with purple tint via PRLINK-4).
6. Unauthenticated `gh` (or no `gh`) → Review transition still works instantly; no errors surfaced.

## Acceptance criteria

- Users can add and remove PR links; the server strictly validates URLs; manual entries use `source: "manual"` and are evicted by the 20-entry cap only after every non-manual entry (PRLINK-0 rule).
- Branch lookup is best-effort, bounded (10s), runs outside interactive shells, never blocks transitions, and degrades silently without `gh`.
- Refresh is opt-in and writes snapshot fields only.
- All surfaces update via the standard state broadcast (no page reload needed).

## Future (explicitly out of scope here)

Auto-moving a card to Done when its PR merges — open question #6 in the master plan; tracked as a separate follow-up milestone, not this one.
## Future (explicitly out of scope here)

Auto-moving a card to Done when its PR merges — open question #6 in the master plan; tracked as a separate follow-up milestone, not this one.

## Final state (implemented)

Implemented as `feat/pr-link-5` against `feat/task-pr-links`. Final shape (differences from the sketch above are noted):

- **Contract/validation**: `runtimeTaskPullRequestLinkRequestSchema` / `runtimeTaskPullRequestLinkResponseSchema` / `runtimeTaskPullRequestsRefreshRequestSchema` / `runtimeTaskPullRequestsRefreshResponseSchema` in `src/core/api-contract.ts`; `parseTaskPullRequestLinkRequest` / `parseTaskPullRequestsRefreshRequest` in `src/core/api-validation.ts`.
- **tRPC (`src/trpc/workspace-api.ts`, wired in `src/trpc/app-router.ts`)**: `addTaskPullRequest`, `removeTaskPullRequest`, `refreshTaskPullRequests` as `workspaceProcedure` mutations. Add re-parses with the strict server parser, records via `recordTaskPullRequests(..., source: "manual")`, and returns the recorded (or pre-existing duplicate) entry re-read from the board. Remove is the documented direct `mutateWorkspaceState` + `removeTaskPullRequest` board mutation (`save: result.removed`). Unknown task / invalid URL / no match → `ok: false` with a message, never a throw; broadcast only on actual change.
- **Lookup (`src/workspace/task-pull-request-lookup.ts`)**: `lookupTaskPullRequests` (injectable `gh`, bounded 10s gh / 5s git, direct `execFile` only) records new entries via `addTaskPullRequests` (`source: "branch_lookup"`, snapshot `{ title, state, stateCheckedAt }`) and refreshes stale existing snapshots via `updateTaskPullRequestSnapshot` inside **one** atomic `mutateWorkspaceState` (`save: changed > 0`, so repeated lookups never bump the revision). This is a documented exception to the single-write-path rule in `task-pull-requests.ts`. `fireReviewPullRequestLookup` is the fire-and-forget wrapper: it reads the board, skips missing cards and cards that already have PRs, then runs the lookup; every failure path logs at debug and returns `{ recorded: 0 }`. `findTasksEnteringReviewWithoutPullRequests(previousBoard, nextBoard)` is the pure diff helper for the save trigger.
- **Triggers**: `src/trpc/hooks-api.ts` fires `fireReviewPullRequestLookup` on a successful `to_review` transition (injectable dep, defaulted to the real wrapper — the card/no-PR pre-check lives inside the wrapper rather than in the hook). `workspace-api.ts` `saveState` captures the pre-save board and fires the lookup for every task `findTasksEnteringReviewWithoutPullRequests` reports. Neither is awaited; both broadcasts still fire exactly as before.
- **UI**: `web-ui/src/components/task-pull-request-manager.tsx` holds the Radix popover (URL input with live shape validation via `validatePullRequestUrlShape`, recorded list with per-entry `X` remove, `Refresh` button with in-flight spinner); server errors surface inline plus `showAppToast`. `top-bar.tsx` renders the affordance in the task branch control only, and only when both the task id and workspace id are scoped (`App.tsx` threads `workspaceId`): `Link PR` button when the task has no PRs, ghost `+` "Manage pull requests" button when it does. PR links themselves (PRLINK-4) still render whenever present, even without the workspace scope.
- **Tests**: new `test/workspace/task-pull-request-lookup.test.ts` (temp `HOME`, fake gh, real workspace state files; covers recording/dedupe, snapshot refresh without revision churn, missing/failing gh, missing task/worktree, the review-entry diff, and the fire-and-forget pre-checks); extended `test/runtime/trpc/workspace-api.test.ts` (all three mutations incl. unknown task, invalid URL, duplicate no-broadcast, remove no-match, refresh, and both saveState trigger paths), `test/runtime/trpc/hooks-api.test.ts` (`to_review` fires the lookup exactly once, other events do not), new `web-ui/src/components/task-pull-request-manager.test.tsx` (add success/failure, client-side validation, remove + toast, refresh + warning toast), extended `web-ui/src/components/top-bar.test.tsx` (affordance shown/hidden by scoping, manage-vs-link variant).
- **Verification run**: server `tsc` clean; `vitest` green across `test/runtime/trpc`, `test/workspace` (172), `test/runtime` core/validation/board-mutation + workspace integration suites (87), and the full `web-ui` suite (579 tests / 74 files). `pnpm format` (Biome) applied.


