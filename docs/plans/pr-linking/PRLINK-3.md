# PRLINK-3 — Delivery capture (B-8)

**Status: Implemented.** See "Final state" below for what shipped.

Master plan: `PR_LINKING_PLAN.md`.
Depends on: **PRLINK-1** (`recordTaskPullRequests` write path; parser from PRLINK-0).
Note: this milestone is fork-specific (B-8 deterministic delivery does not exist upstream).

## Purpose

Record the PR that Kanban's own deterministic delivery (`src/workspace/git-delivery.ts`, B-8) opens or finds, with `source: "delivery"` and the title snapshot where available.

## Re-verify before starting (code moves)

- `finishPr` at `src/workspace/git-delivery.ts:1362`: sets `receipt.pr` to `not_required` / `skipped` / or the result of `openPullRequest` (`:1379`). `receipt.stage = "pr"` then `persistDeliveryReceipt(receipt)` (`:1387-1389`).
- `openPullRequest` at `:1393`:
  - `existing` path: `gh pr list --head <head> [--base] --state open --json number,url --limit 1` (`:1402-1405`); returns `{ status: "existing", number, url, error: null }` (`:1411-1417`).
  - `created` path: `gh pr create --head <head> [--base] --title <prTitle> --body <body>` (`:1430-1433`); the PR title is `prTitle` built at `:1420` (`<task title> (kanban <taskId>)` or `kanban task <taskId>`); URL scraped from stdout at `:1444`.
- `StartGitDeliveryInput` (`:134`): `{ taskId, workspaceId, repoPath, worktreePath, baseRef, policy, ... }` — `repoPath` is the main repository checkout, i.e. the workspace path used for workspace state (verify against the delivery call sites in `src/trpc/runtime-api.ts` if in doubt).
- `recordTaskPullRequests` from PRLINK-1 (`src/workspace/task-pull-requests.ts`) takes `workspacePath` — pass `input.repoPath`.
- The PRLINK-0 parser swap already made `parsePullRequestUrl` available here.
- `RuntimeTaskPullRequest["state"]` is `"open" | "closed" | "merged" | "draft"`.

## Implementation

### 1. Title on the `existing` path

Extend the dedupe query at `git-delivery.ts:1403` to also fetch the title:

```ts
["pr", "list", "--head", head, ...baseArgs, "--state", "open", "--json", "number,url,title", "--limit", "1"]
```

and thread the title to the recording call (keep the receipt contract `RuntimeGitDeliveryReceipt` unchanged — the title is for the card snapshot, not the receipt).

### 2. Record after `openPullRequest`

In `finishPr` (`:1362`), after `receipt.pr = await this.openPullRequest(...)` and **only** when `receipt.pr.status === "created" || receipt.pr.status === "existing"` and `receipt.pr.url` is non-null:

```ts
const link = parsePullRequestUrl(receipt.pr.url);
if (link) {
	await recordTaskPullRequests({
		workspacePath: input.repoPath,
		taskId: input.taskId,
		links: [link],
		source: "delivery",
		now: receipt.updatedAt,
	});
}
```

- Snapshot title: `created` → the `prTitle` used for `gh pr create`; `existing` → the `title` from the `gh pr list` result. Since `openPullRequest` currently returns only the receipt-shaped tuple, extend its private return with an optional `title` field (preferred) or read it back in `finishPr`.
- `state`: the `existing` query filters `--state open`, so a `state: "open"` snapshot is accurate for that path; for `created` set no state (leave it to refresh in PRLINK-5). Pass `stateCheckedAt` only together with `state`. Write the snapshot via `updateTaskPullRequestSnapshot` after the record (or extend `recordTaskPullRequests` with an optional per-link snapshot override — whichever is smaller; keep the single-write-path property: all writes still go through `task-pull-requests.ts` helpers).
- **Best-effort**: `recordTaskPullRequests` already never throws; additionally wrap in try/catch so a state-write failure cannot affect the `receipt.stage = "pr"` / `persistDeliveryReceipt` flow or the returned response.
- `not_required`, `skipped`, and `failed` record nothing.

### 3. UI refresh

Verify how the UI learns about the new card field after delivery completes: the B-8 flow already broadcasts workspace state updates at delivery completion (check `src/trpc/runtime-api.ts` delivery routes for `broadcastRuntimeWorkspaceStateUpdated`). If a broadcast already fires after `finishPr`, no change is needed. If not, add one (fire-and-forget) after a successful record with `changed: true`.

## Tests

Extend `test/workspace/git-delivery.test.ts` (existing suite uses injected `gh` runners; **redirect `HOME`/`USERPROFILE` to a temp dir** — delivery receipts and workspace state resolve `os.homedir()` at call time):

- `created`: fake `gh pr create` prints a PR URL → board card has one `pullRequests` entry: source `delivery`, canonical url, title snapshot equals the composed `prTitle`, receipt unchanged in shape.
- `existing`: fake `gh pr list` returns `number,url,title` (extend the existing fakes — the `--json` field list now includes `title`; update any fake that matches on args) → card entry with source `delivery`, title from the list result, `state: "open"` + `stateCheckedAt` set.
- `skipped` / `failed` / `not_required` → no `pullRequests` written.
- Recording failure (e.g. corrupted workspace state) → delivery still returns `ok: true` with `receipt.stage === "pr"` (assert best-effort isolation).
- Running delivery twice for the same PR → single entry, no revision churn.

## Verification

```sh
npx @biomejs/biome check src test
npm run typecheck
npm run test:fast
npm run test:integration   # task-dispatch integration touches delivery
npx vitest run test/workspace   # git-delivery.test.ts; not covered by test:fast or test:integration
```

Manual: scratch repo with GitHub remote and delivery policy `requirePullRequest` enabled. Move a task through Review → Done (or trigger delivery) so B-8 opens a PR. Confirm `board.json` shows the PR on the card with source `delivery` and the gh title; re-run delivery (PR now pre-existing) and confirm the entry is not duplicated and the title/state snapshot is present.

## Acceptance criteria

- Every PR opened or found by B-8 lands on the task card with `source: "delivery"`.
- Title snapshot populated on both `created` and `existing` paths where gh provides it.
- Delivery outcome, receipt, and error handling are unaffected by PR recording (best-effort, verified by test).
- Delivery receipts contract unchanged.

## Final state

Implemented per the plan; all acceptance criteria met. What shipped:

- **`src/workspace/task-pull-requests.ts`** — `RecordTaskPullRequestsInput` gained an optional `snapshot: RuntimeTaskPullRequestSnapshotUpdate` (title/state/stateCheckedAt) merged into each recorded link in `toRuntimePullRequests`. The single-write-path property is preserved: the snapshot rides on the existing record call; `addTaskPullRequests` still dedupes and backfills missing snapshot fields on re-record.
- **`src/workspace/git-delivery.ts`**
  - The `gh pr list` dedupe query now fetches `number,url,title`; `openPullRequest` returns an `OpenPullRequestResult` (receipt-shaped PR tuple + `title: string | null`). Title sources: `created` → the composed `prTitle`; `existing` → `title` from the list result; `skipped`/`failed` → null. The `RuntimeGitDeliveryReceipt` contract is unchanged.
  - New `recordDeliveredPullRequest` step in `finishPr`, run only when `receipt.pr.status` is `created` or `existing` (and a URL parses): records the link with `source: "delivery"` and `now: receipt.updatedAt`; the `existing` path also snapshots `state: "open"` + `stateCheckedAt: receipt.updatedAt` (the dedupe query filters `--state open`); the `created` path snapshots title only (state comes from the PRLINK-5 refresh). Wrapped in try/catch on top of `recordTaskPullRequests`' best-effort contract, so a state-write failure can never affect the delivery outcome, receipt, or response.
  - New optional `StartGitDeliveryInput.onPullRequestRecorded(workspaceId, workspacePath)` seam, fired only when the board actually changed.
- **`src/trpc/runtime-api.ts`** — `startTaskDelivery` wires `onPullRequestRecorded` to a fire-and-forget `deps.broadcastRuntimeWorkspaceStateUpdated?.(...)`, so connected clients see the PR link without a reload.
- **`test/workspace/git-delivery.test.ts`** — new "PRLINK-3: delivery PR capture" suite (5 tests, HOME-redirected fixtures):
  - created path → one card entry, source `delivery`, composed title snapshot, no state fields, broadcast fired once;
  - existing path → one card entry with the gh-listed title, `state: "open"`, `stateCheckedAt === receipt.updatedAt`, and the `--json number,url,title` query asserted;
  - `not_required`/`skipped` → no gh calls, no card entry;
  - corrupted `board.json` → delivery still `ok: true` with `stage: "pr"` and the created PR receipt (best-effort isolation, no broadcast);
  - three deliveries for the same PR → single entry, one revision bump for the state backfill, then steady-state no-churn (no further revision bumps, no extra broadcasts).

Verification run: `npx @biomejs/biome check src test` clean, `npm run typecheck` clean, `npx vitest run test/workspace` (39 tests) plus the PRLINK-0/2 PR suites (`pull-request-links`, `pull-request-detection`, `hooks-pull-request-detection`, 36 tests) all pass.

