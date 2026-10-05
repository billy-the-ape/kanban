# PRLINK-1 — Cline capture (record path + `onToolFinished`)

> **Status: DONE.** Implemented as sketched; final-state notes are under
> "Final-state notes" at the bottom. Typecheck, `test:fast`, `test/workspace`,
> and `test/integration` verified (the only failures are two pre-existing,
> unrelated ones that also fail on the base branch).

Master plan: `PR_LINKING_PLAN.md` (this is milestone **PL-2**).
Depends on: **PRLINK-0** (contract, parser, detection, board mutations).

## Purpose

Record PRs created by the native Cline agent (`@clinebot/core`, `run_commands`) onto the task card, and make the board refresh in open UIs without a reload:

1. New `src/workspace/task-pull-requests.ts` — the **single server-side write path** `recordTaskPullRequests`, used by every later capture milestone (hooks, delivery, manual, branch lookup).
2. `cline-event-adapter.ts` surfaces finished tools through an injected `onToolFinished` callback (the adapter stays pure — no I/O in protocol translation).
3. The Cline task-session service wires the callback to detection → recording → broadcast.

## Re-verify before starting (code moves)

- `ApplyClineSessionEventInput` at `src/cline-sdk/cline-event-adapter.ts:44`; the `tool-finished` branch at `:568` already has everything needed: `toolName` (from `agentEvent.toolCall`), `toolInput` (from `entry.toolInputByToolCallId.get(toolCallId)`), and `{ output, error }` from `readToolResult(agentEvent.message)`.
- `InMemoryClineTaskSessionService.handleTaskEvent` at `src/cline-sdk/cline-task-session-service.ts:1343` calls `applyClineSessionEvent` at `:1350`. `CreateInMemoryClineTaskSessionServiceOptions` at `:152`.
- Production construction sites: `src/server/runtime-server.ts:161` (task session service — **wire the broadcast here**) and `:197` (review session service — **leave unwired**; the B-6 review tool policy already denies `gh pr create`).
- `mutateWorkspaceState(cwd, mutate)` at `src/state/workspace-state.ts:739` supports `save: false` (no revision bump, no file write) and returns `{ value, state, saved }` — a response object, **not** a board (AGENTS.md trap).
- `RuntimeTaskSessionSummary.workspacePath` (api-contract.ts ~line 288) is nullable — the session summary carries the workspace path for each task.
- `broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath)` is available on `deps.runtimeStateHub` in `runtime-server.ts`.

## Implementation

### 1. Write path — new `src/workspace/task-pull-requests.ts`

```ts
export interface RecordTaskPullRequestsInput {
	workspacePath: string;
	taskId: string;
	links: ParsedPullRequestLink[];
	source: RuntimeTaskPullRequestSource;
	now?: number;
}

export interface RecordTaskPullRequestsResult {
	/** False when nothing was written (duplicate, unknown task, or error). */
	recorded: boolean;
	/** True only when the board actually changed (caller broadcasts only then). */
	changed: boolean;
}

export async function recordTaskPullRequests(input: RecordTaskPullRequestsInput): Promise<RecordTaskPullRequestsResult>
```

Behavior:

- Map `ParsedPullRequestLink[]` → `RuntimeTaskPullRequest[]` (`createdAt: now`, `source`, canonical `url`).
- Use `mutateWorkspaceState(workspacePath, (state) => { const result = addTaskPullRequests(state.board, input.taskId, prs, now); return { board: result.board, value: result.added, save: result.added }; })`. When nothing new: `save: false` so repeated detections do not bump the revision or trigger a broadcast.
- **Best-effort, never throws**: wrap the whole body in try/catch; on error log with a `[task-pull-requests]` prefix and return `{ recorded: false, changed: false }`. A failure must never fail a tool call, hook ingest, or delivery.
- Unknown workspace context (bad `cwd`) → same no-op result.
- Keep this the *only* place that writes card `pullRequests` outside the dedicated tRPC mutations (added in PRLINK-5, which will call this same function).

### 2. Adapter callback — `src/cline-sdk/cline-event-adapter.ts`

- Add to `ApplyClineSessionEventInput`:

```ts
	/** Optional observer for finished tool calls (detection only; the adapter does no I/O). */
	onToolFinished?: (tool: ClineToolFinishedInfo) => void;
```

  with (exported from this file)

```ts
export interface ClineToolFinishedInfo {
	toolName: string | null;
	toolInput: unknown;
	output: string | null;
	error: string | null;
}
```

- In the `agentEvent?.type === "tool-finished"` branch (`:568`), after the existing message/summary handling, invoke:

```ts
	input.onToolFinished?.({ toolName, toolInput, output: toolOutput, error: toolError });
```

  using the values already extracted in that branch. Do not add other call sites (the separate `content_end` tool branch is a different SDK event shape; `tool-finished` is the one that carries the `readToolResult` output).

### 3. Service wiring — `src/cline-sdk/cline-task-session-service.ts`

- Add an optional field to `CreateInMemoryClineTaskSessionServiceOptions` (`:152`):

```ts
	/** Broadcast board state to open UIs after server-side card writes (e.g. PR recording). */
	broadcastWorkspaceStateUpdated?: (workspacePath: string) => void;
```

- In `handleTaskEvent` (`:1343`), extend the `applyClineSessionEvent` call with:

```ts
onToolFinished: (tool) => {
	const commands = extractCommandStrings(tool.toolInput);
	const links = detectCreatedPullRequests({
		toolName: tool.toolName,
		commands,
		output: [tool.output, tool.error].filter((part): part is string => Boolean(part)).join("\n") || null,
	});
	if (links.length === 0) {
		return;
	}
	const workspacePath = entry.summary.workspacePath;
	if (!workspacePath) {
		return;
	}
	void recordTaskPullRequests({ workspacePath, taskId, links, source: "agent_tool" })
		.then((result) => {
			if (result.changed) {
				this.options.broadcastWorkspaceStateUpdated?.(workspacePath);
			}
		})
		.catch(() => {
			// recordTaskPullRequests is best-effort by contract; nothing to escalate.
		});
},
```

  (store the options on the instance if not already; `entry` is in scope). stderr is folded into `output` because `gh pr create` prints the "already exists" PR URL to stderr.
- Detection + recording runs for every tool-finished event but produces no work for non-PR tools (the gate returns `[]`); keep it cheap — `detectCreatedPullRequests` is pure string scanning.

### 4. Production wiring — `src/server/runtime-server.ts`

At the task service construction (`:161`) pass:

```ts
broadcastWorkspaceStateUpdated: (workspacePath) =>
	void deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated(scope.workspaceId, workspacePath),
```

(scope is captured per-workspace by the existing closure). Leave the review service construction (`:197`) without the option.


## Tests

- **New `test/workspace/task-pull-requests.test.ts`** — redirect `HOME`/`USERPROFILE` to a temp dir (AGENTS.md):
  - Records a link onto the card (source `agent_tool`, canonical url, `createdAt`), bumps the revision once.
  - Repeated call with the same link → `changed: false`, **revision unchanged**, no extra board write.
  - Unknown taskId / unknown workspace path → `{ recorded: false, changed: false }`, no throw.
  - Multiple links in one call keep first-appearance order.
- **Extend `test/runtime/cline-sdk/cline-event-adapter.test.ts`**:
  - `tool-finished` for `run_commands` invokes `onToolFinished` with toolName, original input (via `entry.toolInputByToolCallId`), and the `readToolResult` output/error.
  - Other agent events (chunk, tool_call, status) do not invoke it; absence of the callback never throws.
- **Extend `test/runtime/cline-sdk/cline-task-session-service.test.ts`** (unit-style with fakes — **do not boot the real Cline SDK host**; see AGENTS.md Node-22 CI trap):
  - `run_commands` with `gh pr create` + output URL → `recordTaskPullRequests` invoked with source `agent_tool` and the parsed link (mock/spy the module).
  - `run_commands` with `gh pr view 205` + PR URL in output → **not** invoked.
  - Recording result `changed: true` → `broadcastWorkspaceStateUpdated` called with the session's workspacePath; `changed: false` → not called.
  - Missing `workspacePath` on the summary → no recording attempt.

## Verification

```sh
npx @biomejs/biome check src test
npm run typecheck
npm run test:fast
npx vitest run test/workspace   # task-pull-requests.test.ts; not covered by test:fast or test:integration
```

Manual: on a scratch repo with a GitHub remote, run a Cline task that ends by running `gh pr create`. Without reloading the page, the PR appears in the workspace state (`board.json` gains `pullRequests`; the state broadcast reaches the UI — with PRLINK-4 not yet landed, verify via `board.json`/network rather than pixels). Restart Kanban and confirm the link persists. A second run of `gh pr create` for the same branch (gh "already exists" stderr) must not duplicate the entry or bump the revision.

## Acceptance criteria

- `recordTaskPullRequests` is the single write path, best-effort, `save: false` on no-op.
- The adapter performs no I/O; detection/recording lives in the service.
- Cline-created PRs (fresh or "already exists") are recorded exactly once; non-creating commands record nothing.
- Open UIs receive a state broadcast only when the card actually changed.
- All Cline unit tests stay fake-based (no live SDK host).

## Final-state notes

Deviations from the sketch above, discovered during implementation:

- **Error logging:** the biome `grit/no-console.grit` rule forbids `console.*`
  in `src/` (except `src/cli.ts`), so the best-effort catch logs via
  `process.stderr.write("[task-pull-requests] ...")` — the same pattern as
  `src/commands/hooks.ts` — instead of `console.error`.
- **Mutation generic:** `mutateWorkspaceState<boolean>` with `value:
  result.added` (not `{ added: boolean }`), because
  `RuntimeWorkspaceAtomicMutationResult<T>` must match the returned value's
  type; `response.saved && response.value` is the "recorded and changed" check.
- **Adapter output text:** a small `toToolOutputText(output)` helper
  (string passthrough, `JSON.stringify` fallback, `null` otherwise) reduces
  the tool-result payload to text before it reaches `onToolFinished`, so URL
  scanning works for structured results too.
- **Service:** the options object is stored on the instance
  (`private readonly options`); `extractCommandStrings` is imported from
  `./review-tool-policy` (same module the review tool policy uses).
- **Workspace tests:** revision assertions account for the initial
  `saveWorkspaceState` bump (`loadWorkspaceState` auto-creates state at
  revision 0): recorded → `initial.revision + 2`, repeated no-op → still
  `+ 2`, pure no-op paths → `+ 1`.
- **Service "missing workspacePath" test:** built via
  `rebindPersistedTaskSession` with a persisted record whose `cwd`/
  `workspaceRoot` are empty strings (both are *required* fields on
  `SessionHistoryRecord`); rebind trims them to `null`. The fake runtime is
  then bound with `runtime.bindTaskSession` because the rebind path never
  binds a live session.
- **Pre-existing, unrelated failures** (verified to fail on the base branch
  too, with these changes stashed):
  - `test/runtime/server/middleware.test.ts` → "passes through upgrades whose
    Host and Origin are both allowed"
  - `test/integration/task-worktree.integration.test.ts` → "resumes a trashed
    task from the preserved snapshot when the saved patch is invalid"

