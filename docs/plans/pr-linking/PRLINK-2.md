# PRLINK-2 — Hook capture for terminal agents

Master plan: `PR_LINKING_PLAN.md` (this is milestone **PL-3**).
Depends on: **PRLINK-1** (`recordTaskPullRequests` write path; detection/parser from PRLINK-0).

## Purpose

Capture PRs created by terminal agents that report tool use through `kanban hooks` (Claude Code first; Codex, Droid, Kiro, and Cline CLI where their hook payloads allow it):

1. Detection runs **in the hook CLI process** (`src/commands/hooks.ts`), which already has the full payload including `tool_response` — only resulting canonical URLs cross the wire, never raw tool output (master plan Risk #2: do not grow the ingest payload).
2. `pullRequestUrls: string[]` (max 10) joins `runtimeHookIngestRequestSchema`.
3. `hooks-api.ts` **re-parses** those URLs with the strict parser (the hook is not trusted to send canonical data) and records them — whether or not the hook event causes a column transition.

## Re-verify before starting (code moves)

- Hook CLI: `src/commands/hooks.ts` — `HooksIngestArgs` (`:30`), `extractToolInput` (`:136`, reads `tool_input`/`toolInput`/nested forms), `normalizeHookMetadata` (`:290`, the existing `toolName` extraction at `:314`), `parseHooksIngestArgs` (`:356`, merges stdin/base64/arg payloads), `ingestHookEvent` (`:378`, posts `{ taskId, workspaceId, event, metadata }` via tRPC with a 3s timeout, best-effort). `runHooksNotify` (`:493`) is the foreground path that sees the agent's JSON payload on stdin.
- Ingest request schema: `runtimeHookIngestRequestSchema` at `src/core/api-contract.ts:2022` (fields: `taskId`, `workspaceId`, `event`, `metadata?`); parser `parseHookIngestRequest` at `src/core/api-validation.ts:692`.
- Ingest API: `src/trpc/hooks-api.ts` `ingest` (`:44`). Note the flow: unknown task → early `ok: false`; `canTransitionTaskForHookEvent` false → early `ok: true` (`:69-76`). **PR recording must happen before the transition early return** (after the summary lookup) so it is independent of transitions. `deps.broadcastRuntimeWorkspaceStateUpdated` is available (`:16`).
- Claude Code hook wiring: `src/terminal/agent-session-adapters.ts:656` — `PostToolUse` (matcher `*`) already posts `to_in_progress` with `source: claude`, and Claude's `PostToolUse` payload includes `tool_input` and `tool_response` (for `Bash`: `{ stdout, stderr, ... }`).
- Other agents: Cline CLI PostToolUse script at `agent-session-adapters.ts:1399` (`buildClinePostToolUseHookScriptContent`); Codex via `src/commands/hook-events/codex-hook-events.ts`; Droid via `droid-hook-events.ts`; Kiro via `kiro-hook-events.ts`.
- The background re-spawn path (`spawnBackgroundKanban` + `appendMetadataFlags`, `hooks.ts:406-443`) carries only metadata flags — no payload, so no PR detection happens there. That is fine; do not extend it.

## Implementation

### 1. Contract — `src/core/api-contract.ts`

Add to `runtimeHookIngestRequestSchema` (`:2022`):

```ts
	/** Canonical PR URLs detected by the hook CLI (re-parsed server-side; max 10). */
	pullRequestUrls: z.array(z.string().min(1).max(2048)).max(10).optional(),
```

### 2. Hook CLI — `src/commands/hooks.ts`

- Extend `HooksIngestArgs` (`:30`) with `pullRequestUrls?: string[]`.
- In `parseHooksIngestArgs` (`:356`), after `payload` is resolved, compute:

```ts
const pullRequestUrls = extractHookPullRequestUrls(payload);
```

  and include it in the returned args. Implement a local (exported for tests) helper:

```ts
export function extractHookPullRequestUrls(payload: Record<string, unknown> | null): string[] | undefined
```

  - `toolName` — reuse the exact extraction chain already in `normalizeHookMetadata` (`:314`, `tool_name`/`toolName`/`preToolUse`/`postToolUse`/`input` nested forms); factor that chain into a small shared local function rather than duplicating it.
  - `toolInput` — `extractToolInput(payload)` (`:136`); normalize to command strings with `extractCommandStrings` (exported from `review-tool-policy.ts` by PRLINK-0).
  - `output` — read `tool_response` from the payload: string → as-is; record → join string values of `stdout`, `stderr`, `output`, `error` (when none of those exist, `JSON.stringify` the record and let `extractPullRequestLinks` scan it). Absent → `null`.
  - Run `detectCreatedPullRequests({ toolName, commands, output })`, map to `.url`, cap at 10; return `undefined` for an empty result (keeps the wire payload unchanged when there is nothing).

- In `ingestHookEvent` (`:378`), pass `pullRequestUrls: args.pullRequestUrls` in the `hooks.ingest.mutate` call (zod tolerates `undefined`).

### 3. Ingest API — `src/trpc/hooks-api.ts`

In `ingest`, after the summary lookup (so an unknown task still errors as today) and **before** the `canTransitionTaskForHookEvent` early return:

```ts
if (body.pullRequestUrls && body.pullRequestUrls.length > 0) {
	await recordHookPullRequests(body.pullRequestUrls, workspacePath, taskId, deps);
}
```

where `recordHookPullRequests` (local helper in this file or in `task-pull-requests.ts`):

- Re-parses each URL with `parsePullRequestUrl`; drops `null` results (the hook is not trusted — never store raw agent text).
- Calls `recordTaskPullRequests({ workspacePath, taskId, links, source: "agent_tool" })`.
- On `changed: true`: `void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath)`.
- try/catch around the whole thing — recording never fails the ingest (the rest of the flow returns `ok: true` regardless).

### 4. Agent coverage matrix (verify and document)

For each agent, check what its hook payload actually carries and whether `PostToolUse` (or equivalent) is wired. Record the findings **in the "Agent coverage findings" section at the bottom of this file** as part of the PR (fill in real observations, including exact payload fields seen):

| Agent | Hook event wired? | Carries tool input? | Carries tool output? | PR capture works? |
| --- | --- | --- | --- | --- |
| Claude Code | `PostToolUse` → `to_in_progress` (`agent-session-adapters.ts:656`) | `tool_input.command` (Bash) | `tool_response.{stdout,stderr}` | expected yes — verify |
| Cline CLI | PostToolUse script (`agent-session-adapters.ts:1399`) | check script content | check | verify |
| Codex | watcher + `agent-turn-complete` (`codex-hook-events.ts`) | check | check (likely only final message) | document gap if no |
| Droid | `enrichDroidReviewMetadata` (`droid-hook-events.ts`) | check | check | document gap if no |
| Kiro | `normalizeKiroHookMetadata` (`kiro-hook-events.ts`) | check | check | document gap if no |

Where an agent's hook carries no tool output, document the gap — the fallback is delivery (PRLINK-3), branch lookup, or manual add (PRLINK-5). Also verify MCP tool names (`mcp__github__create_pull_request`) pass through Claude's `tool_name` field so the MCP gate in the detection module applies.

If an agent is missing a `PostToolUse` hook entirely (not just missing output), wire it following the Claude Code pattern in `agent-session-adapters.ts` (event `to_in_progress`, agent `source`).

## Tests

- **New `test/runtime/hooks-pull-request-detection.test.ts`** (or extend an existing `test/runtime/hooks-*` suite) for `extractHookPullRequestUrls`:
  - Claude-style payload `{ tool_name: "Bash", tool_input: { command: "gh pr create ..." }, tool_response: { stdout: "https://github.com/o/r/pull/7", stderr: "" } }` → `["https://github.com/o/r/pull/7"]` (canonical).
  - Same but `tool_response` as a plain string.
  - `gh pr view` command with a PR URL in the response → `undefined`.
  - Payload with no `tool_response` → `undefined` (never throws).
  - MCP payload: `tool_name: "mcp__github__create_pull_request"` with structured response containing `html_url`.
  - More than 10 links → capped at 10.
  - `null` payload → `undefined`.
- **Extend `test/runtime/trpc/hooks-api.test.ts`** (redirect `HOME`/`USERPROFILE`; the suite already fakes the terminal manager):
  - Ingest with `pullRequestUrls` records onto the card with source `agent_tool` and broadcasts on change.
  - Invalid/garbage URLs in `pullRequestUrls` are dropped (nothing recorded, ingest still `ok: true`).
  - Recording happens even when the event does not transition the task (e.g. `activity` event) — assert on the board file, not the transition.
  - Duplicate URLs (already recorded by a previous ingest) → no revision bump.

## Verification

```sh
npx @biomejs/biome check src test
npm run typecheck
npm run test:fast
```

Manual: on a scratch repo, run a **Claude Code** task that creates a PR via Bash (`gh pr create`). Confirm `board.json` gains the PR (source `agent_tool`) and the UI refreshes via broadcast without a reload. Run a task whose agent only *reads* a PR (`gh pr view`) and confirm nothing is attached. Repeat for every agent listed in the matrix that is installed locally; update the findings table with what you observe.

## Acceptance criteria

- Hook payloads never ship raw tool output; only ≤10 URL strings cross the wire.
- Server re-parses every URL; raw agent text is never stored.
- Recording is independent of column transitions and never fails the ingest.
- The agent coverage matrix in this file is filled in with real observations, gaps included.

## Agent coverage findings (fill in during implementation)

- Claude Code:
- Cline CLI:
- Codex:
- Droid:
- Kiro:

