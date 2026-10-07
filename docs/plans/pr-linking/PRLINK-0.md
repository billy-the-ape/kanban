# PRLINK-0 — Contract, parser, detection, board mutations

Master plan: `PR_LINKING_PLAN.md`.
Depends on: nothing. This is the first milestone and must land before any runtime writer (PRLINK-1 through PRLINK-3).

## Status: implemented

All of the above landed as specified:

- `src/core/api-contract.ts` — PR schemas + optional `pullRequests` card field (kept optional; no web-ui mock changes needed).
- `src/core/pull-request-links.ts` (new) — `parsePullRequestUrl`, `extractPullRequestLinks`, `getPullRequestIdentityKey`.
- `src/core/pull-request-detection.ts` (new) — `detectCreatedPullRequests` gate; `extractCommandStrings` is now exported from `src/cline-sdk/review-tool-policy.ts` and reused.
- `src/core/task-board-mutations.ts` — `addTaskPullRequests`, `removeTaskPullRequest`, `updateTaskPullRequestSnapshot` (identity-key based, per section 4).
- `src/state/workspace-state.ts` — server-owned merge in `saveWorkspaceState` (section 5).
- `src/workspace/git-delivery.ts` — private `parsePullRequestNumberFromUrl` removed; receipt number comes from `parsePullRequestUrl(url)?.number ?? null`.
- Tests: new `test/runtime/core/pull-request-links.test.ts`, new `test/runtime/core/pull-request-detection.test.ts`; extended `test/runtime/task-board-mutations.test.ts` and `test/integration/workspace-state.integration.test.ts`; `test/workspace/git-delivery.test.ts` stays green.

Verification results: Biome check clean, `npm run typecheck` clean, `npm run test:fast` green, `npm run test:integration` green (except two **pre-existing, unrelated** base-branch failures also present without this change: `test/runtime/server/middleware.test.ts` socket-upgrade test and `test/integration/task-worktree.integration.test.ts` "resumes a trashed task … invalid patch"), `npx vitest run test/workspace` green, web-ui `tsc` + `vitest` green.

## Purpose

Lay the foundation for task ↔ pull request linking, with **no user-visible behavior**:

1. The persisted data model (optional `pullRequests` card field in the API contract).
2. A pure URL parser and a narrow PR-creation detection gate.
3. Board mutations (`addTaskPullRequests`, `removeTaskPullRequest`, `updateTaskPullRequestSnapshot`).
4. The server-owned `pullRequests` merge in `saveWorkspaceState` (fixes the client-overwrite race — Risk #1 in the master plan).
5. Swap `git-delivery.ts`'s private PR-number parser to the shared parser (behavior-neutral).

## Re-verify before starting (code moves)

- `runtimeBoardCardSchema` is at `src/core/api-contract.ts:133` — it is a `z.object({...}).transform(...)`; the transform destructures legacy fields and spreads `...card`, so a new optional field passes through untouched.
- `saveWorkspaceState` is at `src/state/workspace-state.ts:686`; `mutateWorkspaceState` at `:739` (already read-modify-write under the workspace lock).
- `extractCommandStrings` at `src/cline-sdk/review-tool-policy.ts:50` is **module-private** (now exported — see Status above); `COMMAND_TOOL_NAMES = new Set(["run_commands", "bash"])` at `:33`.
- `parsePullRequestNumberFromUrl` (private) at `src/workspace/git-delivery.ts:395`, used once at `:1445`.
- Board mutation conventions: pure functions in `src/core/task-board-mutations.ts` returning result objects (`{ board, task, <verb>ed: boolean }`), e.g. `moveTaskToColumn` (`:510`), `updateTask` (`:610`).

## Conventions (AGENTS.md — must follow)

- Biome (tabs, 120 cols) via `npx @biomejs/biome check`; **no Prettier**. Pre-commit hook runs `biome check --staged` + typecheck + `test:precommit`.
- No `any`, no non-null assertions, no inline imports. Standard top-level imports only.
- Tests that touch workspace state must redirect `process.env.HOME` (and `USERPROFILE`) to a temp dir in `beforeEach`/restore in `afterEach` (state paths resolve `os.homedir()` at call time).
- `mutateWorkspaceState` returns `{ value, state, saved }` — **not** a board.

## Implementation

### 1. Contract — `src/core/api-contract.ts`

Add near the board card schema (before `runtimeBoardCardSchema`, ~line 133):

```ts
export const runtimeTaskPullRequestProviderSchema = z.enum(["github", "gitlab", "bitbucket"]);
export type RuntimeTaskPullRequestProvider = z.infer<typeof runtimeTaskPullRequestProviderSchema>;

export const runtimeTaskPullRequestSourceSchema = z.enum([
	"agent_tool",   // detected from a PR-creating tool call (Cline run_commands, hook PostToolUse, MCP tool)
	"delivery",     // recorded by B-8 deterministic delivery (PRLINK-3)
	"manual",       // added by the user in the UI (PRLINK-5)
	"branch_lookup", // found by querying the provider for the task branch (PRLINK-5)
]);
export type RuntimeTaskPullRequestSource = z.infer<typeof runtimeTaskPullRequestSourceSchema>;

export const runtimeTaskPullRequestSchema = z.object({
	provider: runtimeTaskPullRequestProviderSchema,
	host: z.string(),            // "github.com", or a GHE / self-hosted GitLab host
	repository: z.string(),      // "owner/repo" (GitLab may be "group/subgroup/repo")
	number: z.number().int().positive(),
	url: z.string(),             // canonical URL produced by the parser, never raw agent text
	source: runtimeTaskPullRequestSourceSchema,
	createdAt: z.number(),       // first time Kanban recorded it
	// Optional snapshot; may be stale. Populated by delivery/branch lookup/refresh only.
	title: z.string().optional(),
	state: z.enum(["open", "closed", "merged", "draft"]).optional(),
	stateCheckedAt: z.number().optional(),
});
export type RuntimeTaskPullRequest = z.infer<typeof runtimeTaskPullRequestSchema>;
```

Then add to the `runtimeBoardCardSchema` object:

```ts
	pullRequests: z.array(runtimeTaskPullRequestSchema).optional(),
```

**Keep the field optional.** `web-ui/src/runtime/types.ts` re-exports this contract; a required field would crash uncast test mocks (`as unknown as RuntimeBoardCard`) at render time instead of failing tsc. Grep the web-ui for mock card factories after the change.

### 2. Pure parser — new `src/core/pull-request-links.ts`

No runtime dependencies. Exports:

- `ParsedPullRequestLink` = `{ provider: RuntimeTaskPullRequestProvider; host: string; repository: string; number: number; url: string }` (use the contract provider type).
- `parsePullRequestUrl(raw: string): ParsedPullRequestLink | null` — one matcher per provider:
  - GitHub / GHE: `https://<host>/<owner>/<repo>/pull/<n>` — `<n>` is digits only (this inherently rejects `/pull/new/<branch>`). Optional trailing path/query/fragment (`/files`, `#discussion_...`) is accepted and stripped.
  - GitLab: `https://<host>/<group…>/<repo>/-/merge_requests/<n>` — repository may contain nested groups (`group/subgroup/repo`).
  - Bitbucket Cloud: `https://bitbucket.org/<ws>/<repo>/pull-requests/<n>`.
  - Returns a **canonical URL** (`https://<host>/<repo>/pull/<n>` etc.) with no trailing path/query/fragment and a lowercase host.
  - Must reject: non-http(s) schemes, `/issues/<n>`, `/compare/...`, missing or zero numbers, and anything without the provider's distinctive segment.
- `extractPullRequestLinks(text: string): ParsedPullRequestLink[]` — scan arbitrary text for candidate URLs (`/https?:\/\/\S+/g`-style), strip trailing prose punctuation (`.`, `,`, `)`, `]`, `"`, `'`, `;`, `:` — e.g. `.../pull/12).`), parse each, dedupe by identity, keep first-appearance order.
- `getPullRequestIdentityKey(pr: { provider; host; repository; number }): string` — `` `${provider}|${host.toLowerCase()}|${repository.toLowerCase()}|${number}` ``. Identity is case-insensitive on host/repository. Reused by the board mutations.

Provider detection: `github.com` → github, `gitlab.com` → gitlab, `bitbucket.org` → bitbucket; unknown hosts classified by URL shape (`/pull/<n>` → github, `/-/merge_requests/<n>` → gitlab). This keeps GHE and self-hosted GitLab working with no configuration.

### 3. Detection gate — new `src/core/pull-request-detection.ts`

```ts
export function detectCreatedPullRequests(input: {
	toolName: string | null;
	commands: string[];   // already-normalized raw command strings
	output: string | null;
}): ParsedPullRequestLink[]
```

Rules — return links **only** when the call is PR-creating:

| Signal | Rule |
| --- | --- |
| Shell command (`run_commands`, `bash`, `Bash`, Codex `shell`, …) | Some command segment matches `gh pr create`, `glab mr create`, `hub pull-request`, or `git push ... -o merge_request.create`. Split each command on `&&`, `;`, `\|`, and newlines first; tolerate leading `cd x &&` prefixes and env assignments (`FOO=bar cmd`). Parse links from **output only, never from command text**. |
| `gh pr create` failing because a PR already exists | gh prints the existing PR URL in stderr; when that output is part of the tool result, accept it (same PR — recording is correct). |
| MCP tool | `toolName` ends in `create_pull_request` or `create_merge_request`. Prefer `html_url` / `web_url` from structured output (output may be a JSON object or a string containing JSON); fall back to `extractPullRequestLinks` over the serialized output. |
| Anything else | Return `[]`. In particular `gh pr view`, `gh pr list`, `gh pr comment`, plain `git push` attach nothing. |

The gate is deliberately narrow; misses are recoverable via delivery, branch lookup (PRLINK-5), or manual add.

Command normalization: `extractCommandStrings` in `src/cline-sdk/review-tool-policy.ts:50` already reduces the SDK's string/array/`{commands}`/`{command,args}` variants to raw strings. **Export it from there** (add `export`) and import it here — do not write a second normalizer.

Result is deduplicated (identity key) and ordered by first appearance.

### 4. Board mutations — `src/core/task-board-mutations.ts`

Pure functions following the existing result-object convention:

- `addTaskPullRequests(board, taskId, pullRequests: RuntimeTaskPullRequest[], now = Date.now()): { board, task, added: boolean }`
  - Unknown task → `{ board, task: null, added: false }`.
  - Dedupe by `getPullRequestIdentityKey`: an existing entry keeps its position, `createdAt`, and `source`; a missing snapshot field (`title`/`state`/`stateCheckedAt`) is backfilled from the incoming entry, nothing else changes. Never reorders.
  - **Cap 20** per task. When exceeded, drop the oldest **non-manual** entry first; if all 20 are `manual`, drop the oldest manual entry (prevents unbounded manual growth).
  - `added: true` only if the stored array changed (callers use this to skip the save/broadcast).
- `removeTaskPullRequest(board, taskId, identityKey: string, now = Date.now()): { board, task, removed: boolean }`
- `updateTaskPullRequestSnapshot(board, taskId, identityKey: string, snapshot: { title?: string; state?: RuntimeTaskPullRequest["state"]; stateCheckedAt?: number }, now = Date.now()): { board, task, updated: boolean }`
  - Sets only the provided fields; if `title` or `state` is provided without `stateCheckedAt`, stamp `now`.



### 5. Server-owned merge — `src/state/workspace-state.ts` `saveWorkspaceState` (~line 686)

The web UI saves the whole board wholesale and the revision check only applies when `expectedRevision` is sent, so a client save built from a stale board would erase runtime-recorded PR links. Inside the existing workspace lock, after the revision check:

1. Read the persisted board (`readWorkspaceBoard(context.workspaceId)`).
2. Build a map `taskId → persisted pullRequests` (value may be `undefined`).
3. For every card in the client-supplied board: if the id exists on disk, **replace** its `pullRequests` with the persisted value (delete the property entirely when the persisted card has none); if the id is new, delete any client-supplied `pullRequests`.

New cards never accept `pullRequests` from create input. Add a doc comment at the merge site: *server-owned card field — the one documented exception to "the client owns the board"; all writes go through `mutateWorkspaceState` + the PR mutations.*

`mutateWorkspaceState` itself needs no change (it already reads current state under the lock).

### 6. `git-delivery.ts` parser swap — `src/workspace/git-delivery.ts`

Delete the private `parsePullRequestNumberFromUrl` (`:395`) and at `:1445` use the shared parser: `parsePullRequestUrl(url)?.number ?? null`. Behavior-neutral for the receipt (`{ status, number, url, error }`).

## Tests

- **New `test/runtime/core/pull-request-links.test.ts`** — table-driven:
  - github.com PR URL; GHE host (`https://ghe.corp.io/owner/repo/pull/42`); `/files` suffix; `#fragment` suffix; query string.
  - Reject: `/pull/new/feature-branch` (printed by `git push`), `/compare/main...head`, `/issues/12`, schemeless / `ftp://` URLs, `/pull/` with no number, `/pull/0`.
  - GitLab: `gitlab.com/group/subgroup/repo/-/merge_requests/7`; self-hosted GitLab host via shape.
  - Bitbucket: `bitbucket.org/ws/repo/pull-requests/9`.
  - `extractPullRequestLinks`: prose `See https://github.com/o/r/pull/12).` (trailing punctuation), two PRs deduped with order kept, mixed noise.
  - Uppercase host normalization for identity (`GITHUB.COM` and `github.com` share an identity key; canonical URL lowercases host).
- **New `test/runtime/core/pull-request-detection.test.ts`**:
  - `gh pr create` success output containing the PR URL → 1 link.
  - `gh pr create` "a pull request for branch … already exists" stderr form containing the URL → 1 link.
  - Chained command `cd repo && gh pr create --body-file x` → gated yes.
  - `ENV=1 gh pr create` → gated yes.
  - `gh pr view 205` with a PR URL in output → `[]` (review tasks must not adopt PRs they read).
  - Plain `git push` output containing `/pull/new/...` → `[]`.
  - `git push -o merge_request.create` with a GitLab MR URL in output → 1 link.
  - MCP: toolName `mcp__github__create_pull_request` with JSON output containing `html_url` → 1 link; same with output as a stringified JSON.
  - `toolName: null` + no commands → `[]`.
- **Extend `test/runtime/task-board-mutations.test.ts`** — new describe blocks:
  - Dedupe: adding the same identity twice (different-case host/repo) → one entry, original position/`createdAt` kept, snapshot backfilled.
  - Ordering: first-appearance order preserved across interleaved adds.
  - Cap: 20 mixed entries + new detection drops the oldest non-manual; manual entries survive; all-manual edge drops oldest manual.
  - `removeTaskPullRequest` removes by identity (case-insensitive), no-op for unknown task/identity.
  - `updateTaskPullRequestSnapshot` sets only provided fields and stamps `stateCheckedAt`.
  - Unknown taskId on `addTaskPullRequests` → `added: false`, board unchanged.
- **Server-owned merge**: extend `test/integration/workspace-state.integration.test.ts` (redirect `HOME`/`USERPROFILE` to a temp dir): seed a card with `pullRequests` via `mutateWorkspaceState` + `addTaskPullRequests`, then `saveWorkspaceState` with a board snapshot that (a) omits the field, (b) carries a stale/different list, and (c) adds `pullRequests` to a brand-new card — (a)/(b) must preserve the persisted list and (c) must drop it.
- **Delivery parser swap**: existing `test/workspace/git-delivery.test.ts` must stay green (it exercises `openPullRequest` with injected gh runners).

## Verification

```sh
npx @biomejs/biome check src test
npm run typecheck
npm run test:fast          # test/runtime + test/utilities
npm run test:integration   # workspace-state merge test
npx vitest run test/workspace   # git-delivery parser swap; not covered by test:fast or test:integration
npm run web:typecheck && npm run web:test   # contract ripple check (field is optional; expect no changes needed)
```

Manual (no visible UI change expected): start Kanban against a scratch workspace, create a task, confirm `board.json` round-trips through a normal UI save without error and no `pullRequests` key appears spontaneously.

## Acceptance criteria

- `RuntimeBoardCard` optionally carries `pullRequests`; contract parse/serialize round-trips.
- Parser + detection are pure, fully unit-tested, dependency-free.
- Mutations implement identity/order/cap rules exactly as specified.
- A stale client save can never erase or forge server-recorded PR links.
- `git-delivery.ts` uses the shared parser; no duplicated PR-URL regexes remain in the codebase (grep for `/pull/(\d+)` should hit only `pull-request-links.ts` and tests).
- No user-visible behavior change.
