# Task pull request linking — master plan

Document revision: 1  
Prepared: 2026-10-03  
Status: planned; no milestone started.  
Source baseline: ba3b715 (main, after billy-the-ape/kanban#28).  
Fork: https://github.com/billy-the-ape/kanban

This is the master plan. It will be split into one file per milestone (`PL-1.md`, `PL-2.md`, …) in this directory so a coding agent only needs to load the milestone it is executing plus the shared context it carries. Do not renumber milestones once work starts; record later additions under a new PL number.

## Purpose

Kanban tasks routinely end with the agent opening a pull request, and the agent usually prints the full `https://github.com/<owner>/<repo>/pull/<n>` link. After a long back-and-forth that link is buried in the chat thread. This feature records every pull request a task creates on the task itself, and shows it in two places:

1. **Task detail top bar.** Right after the branch name and before the `(N files +A -D)` diff summary, show `PR #123` as a link that opens in a new browser tab. If a task has several PRs, show all of them.
2. **Board card.** Any card that has a PR, in any column, shows the most recent one as a compact `#123` link in the card's top-right area.

GitHub must work in the first release. The design must also allow other providers (GitLab merge requests, Bitbucket pull requests, GitHub Enterprise hosts) without changing the stored shape or the UI.

## Requirements

1. Capture PR links from the **act of creating a PR**, not by scanning assistant prose for anything that looks like a URL. Prose mentions ("see #205", links to other repos' PRs, review comments quoting a PR) must not attach PRs to the task.
2. Work for the native Cline agent (`@clinebot/core`, `run_commands`) and for terminal agents that report tool use through Kanban hooks (Claude Code first; Codex, Droid, Kiro, and Cline CLI where their hook payloads allow it).
3. Record PRs that Kanban's own deterministic delivery (B-8, `src/workspace/git-delivery.ts`) opens or finds.
4. A task can have several PRs. Store all of them, deduplicated and in order of first appearance.
5. Persist links with the card so they survive restarts, column moves (including Review → Done), and session resets.
6. Store the identifier (provider, host, repo, number, URL) as durable truth. Treat title and state as an optional snapshot that may be stale and is labelled as such. Never block the UI on a network call.
7. Let the user add a PR link by hand and remove a wrong one. Detection will never be perfect.
8. No new runtime dependencies for parsing. URL parsing is a small, pure, well-tested module.
9. Follow AGENTS.md: no `any`, no inline imports, Biome formatting, Tailwind tokens, Lucide icons, `@/components/ui` primitives, and `HOME` isolation in tests that touch workspace state.

## Non-goals (first release)

- Live PR status sync (checks, review state, merge state) or webhooks.
- Creating PRs from the Kanban UI.
- Auto-moving cards based on PR state, such as moving a card to Done when its PR merges. This is a reasonable follow-up once state refresh exists. Track it as a future PL number, not inside this plan.

## Findings from the current codebase

These are the facts the design depends on. Re-verify them at the start of each milestone because the code moves.

- **There is no dedicated "create PR" tool.** Agents open PRs by running shell commands, usually `gh pr create`. Cline reports this as a `run_commands` tool call. Claude Code reports it as `Bash`, or as an MCP tool such as `mcp__github__create_pull_request` when a GitHub MCP server is configured. Detection must therefore look at the **command plus its output**, gated on the command being PR-creating. `src/config/runtime-config.ts:141` already tells agents to use `gh pr create --body-file`.
- **Cline tool results are observable in one place.** `src/cline-sdk/cline-event-adapter.ts` handles `tool-finished` with `toolName`, the original input (`entry.toolInputByToolCallId`), and `readToolResult(...).output`. `src/cline-sdk/review-tool-policy.ts` already normalizes `run_commands` input to raw command strings (`COMMAND_TOOL_NAMES`). Reuse that normalizer instead of writing a second one.
- **Terminal agents report through `kanban hooks`.** `src/commands/hooks.ts` parses the agent's hook payload (it already extracts `toolName` and `toolInput`), then posts `runtimeHookIngestRequestSchema` (`src/core/api-contract.ts`) to `src/trpc/hooks-api.ts`. Claude Code's `PostToolUse` hook is already wired (`src/terminal/agent-session-adapters.ts`), and Claude's payload includes `tool_response`. Today the response is not forwarded. Only `runtimeTaskHookActivitySchema` metadata is sent.
- **B-8 delivery already knows the PR.** `GitDeliveryService.openPullRequest` returns `{ status, number, url }` into the delivery receipt (`receipt.pr`). `parsePullRequestNumberFromUrl` lives privately in `git-delivery.ts`. It should move into the new shared parser.
- **Cards are the right home.** `runtimeBoardCardSchema` (`src/core/api-contract.ts`) is the persisted card shape in `board.json`. Session summaries (`RuntimeTaskSessionSummary`) are transient per-run state and are the wrong place.
- **The web UI saves the whole board.** `saveWorkspaceState` (`src/state/workspace-state.ts`) writes the client-supplied board wholesale. The revision check only applies when `expectedRevision` is sent. A runtime-side write of PR links can therefore be overwritten by a client save built from a board that predates it. **PR links must be a server-owned card field** (see Data model).
- **Server-side board writes** go through `mutateWorkspaceState` and are followed by `broadcastRuntimeWorkspaceStateUpdated` so open UIs refresh. `src/trpc/hooks-api.ts` shows the pattern. Note the AGENTS.md trap: `mutateWorkspaceState` returns a response object, not a board.
- **UI insertion points.**
  - Top bar: `GitBranchStatusControl` in `web-ui/src/components/top-bar.tsx` renders the branch `Button` and then the `(N files +A -D)` span inside one flex row. The PR links go between them as siblings of the button, not inside it, because an anchor inside a button is invalid HTML.
  - Board card: in `web-ui/src/components/board-card.tsx`, the header row (`flex items-center gap-2`) holds the status marker, the title, `TaskPhaseBadge`, and the column action buttons. The `#123` link goes just before the phase badge and action buttons on the right. The card root is draggable and clickable, so the link must stop `mousedown` and `click` propagation, the way the existing title-edit button does with `stopEvent`.
- `web-ui/src/runtime/types.ts` re-exports the contract. Adding an **optional** card field avoids the AGENTS.md "required field crashes uncast mocks" trap. Keep it optional.

## Data model

Add to `src/core/api-contract.ts`:

```ts
export const runtimeTaskPullRequestProviderSchema = z.enum(["github", "gitlab", "bitbucket"]);

export const runtimeTaskPullRequestSourceSchema = z.enum([
	"agent_tool",   // detected from a PR-creating tool call (Cline run_commands, hook PostToolUse, MCP tool)
	"delivery",     // recorded by B-8 deterministic delivery
	"manual",       // added by the user in the UI
	"branch_lookup" // found by querying the provider for the task branch (PL-6)
]);

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

// on runtimeBoardCardSchema:
pullRequests: z.array(runtimeTaskPullRequestSchema).optional(),
```

Rules:

- **Identity** is `provider + host + repository (case-insensitive) + number`. Re-detecting the same PR updates nothing except a missing snapshot. It never reorders.
- **Order** is order of first record. "Latest" for the card means the last element.
- **Cap** at 20 entries per task. When the cap is exceeded, drop the oldest non-manual entry. This guards against a runaway loop that creates PRs.
- **Server-owned field.** `saveWorkspaceState` ignores the client's `pullRequests` for a card that already exists on disk and carries the persisted value forward. All writes go through dedicated mutations:
  - `addTaskPullRequests` (runtime detection, delivery, manual add)
  - `removeTaskPullRequest` (manual remove)
  - `updateTaskPullRequestSnapshot` (PL-6)

  This is the one exception to "the client owns the board". Document it next to the merge code.
- New cards never accept `pullRequests` from create input.

## Parsing and detection

### Pure parser: `src/core/pull-request-links.ts`

- `parsePullRequestUrl(raw: string): ParsedPullRequestLink | null` uses one matcher per provider:
  - GitHub and GHE: `https://<host>/<owner>/<repo>/pull/<n>`, with an optional trailing path, query, or fragment such as `/files` or `#discussion…`.
  - GitLab: `https://<host>/<group…>/<repo>/-/merge_requests/<n>`.
  - Bitbucket Cloud: `https://bitbucket.org/<ws>/<repo>/pull-requests/<n>`.
  - The matcher returns a canonical URL with no trailing path, query, or fragment, and a lowercase host.
  - Must reject: `/pull/new/<branch>` (printed by `git push` for new branches), `/compare/…`, `/issues/<n>`, non-http(s) schemes, and missing or zero numbers.
- `extractPullRequestLinks(text: string): ParsedPullRequestLink[]` finds candidate URLs in arbitrary output and parses them. The result is deduplicated and keeps order.
- Provider detection by host: `github.com` → github, `gitlab.com` → gitlab, `bitbucket.org` → bitbucket. Unknown hosts are classified by URL shape (`/pull/` → github, `/-/merge_requests/` → gitlab). This keeps GHE and self-hosted GitLab working with no configuration.
- Move `parsePullRequestNumberFromUrl` out of `git-delivery.ts` and replace it with this module.

### Detection gate: `src/core/pull-request-detection.ts`

`detectCreatedPullRequests({ toolName, commands, output }): ParsedPullRequestLink[]` returns links only when the call is PR-creating:

| Signal | Rule |
| --- | --- |
| Shell command (`run_commands`, `bash`, `Bash`, Codex `shell`, …) | Some command segment matches `gh pr create`, `glab mr create`, `hub pull-request`, or `git push … -o merge_request.create`. Split `&&`, `;`, `\|`, and newlines first, and tolerate `cd x &&` prefixes and env assignments. Parse links from **output only**, not from the command text. |
| `gh pr create` that fails because a PR already exists | gh prints the existing PR URL in stderr. If that output is part of the tool result, accept it. This is the same PR, so recording it is correct. |
| MCP tool | Tool name ends in `create_pull_request` or `create_merge_request`. Parse `html_url` / `web_url` from structured output, or fall back to `extractPullRequestLinks` over the serialized output. |
| Anything else | Return `[]`. In particular `gh pr view`, `gh pr list`, `gh pr comment`, and plain `git push` do not attach PRs. A review task that reads PR #205 must not adopt it. |

The gate is deliberately narrow. A PR the gate misses can still be found by delivery, by branch lookup (PL-6), or by manual add.

## Recording flow

```text
Cline tool-finished ─┐
hook PostToolUse  ───┼─► detectCreatedPullRequests ─► recordTaskPullRequests(workspacePath, taskId, links, source)
B-8 receipt.pr ──────┤                                     │  mutateWorkspaceState → addTaskPullRequests
manual add (tRPC) ───┘                                     │  (no-op + save:false when nothing new)
                                                           └─► broadcastRuntimeWorkspaceStateUpdated
```

- `recordTaskPullRequests` lives in a new `src/workspace/task-pull-requests.ts` and is the single write path. It must be best-effort. A failure is logged and never fails the tool call, the hook ingest, or delivery.
- Use `save: false` when nothing changed, so repeated detections do not bump the revision or trigger a broadcast.
- **Cline** (`cline-event-adapter.ts`): the adapter is protocol translation. It should not do I/O. Have it surface `{ toolName, toolInput, output }` for finished tools through an injected callback, such as `onToolFinished`, on `ApplyClineSessionEventInput`. The task-session service wires that callback to detection and recording. This keeps the adapter pure and testable.
- **Hooks** (`src/commands/hooks.ts` → `hooks-api.ts`): run detection **in the hook CLI process**, which already has the full payload including `tool_response`, and send only the resulting `pullRequestUrls: string[]` (max 10) on the ingest request. This avoids shipping large tool output to the runtime. `hooks-api.ts` re-parses those URLs with the strict parser, so the hook is not trusted to send canonical data, and then records them. Recording happens whether or not the hook event causes a column transition.
- **Delivery** (`git-delivery.ts`): after `openPullRequest` returns `created` or `existing` with a URL, call `recordTaskPullRequests` with `source: "delivery"`, and add the gh `title` to the snapshot where it is available.
- **Agent coverage matrix.** PL-3 fills in the real payload shapes per agent and records them in its milestone file. Expected coverage: Claude Code `PostToolUse` has `tool_input.command` and `tool_response`. Cline CLI has a PostToolUse script. Codex, Droid, and Kiro must be verified. Where an agent's hook carries no tool output, document the gap and rely on PL-6 branch lookup.

## UI

### Shared component: `web-ui/src/components/task-pull-request-link.tsx`

- `TaskPullRequestLink({ pullRequest, variant: "full" | "compact" })` renders an `<a href target="_blank" rel="noopener noreferrer">`.
  - `full` shows a `GitPullRequest` icon (Lucide, 12px) and `PR #123`. GitLab shows `MR !123`.
  - `compact` shows `#123` (GitLab: `!123`).
- Tooltip (`@/components/ui/tooltip`) shows `owner/repo#123`, the snapshot title if present, and "state as of <relative time>" when a snapshot exists.
- `onMouseDown` and `onClick` stop propagation so card drag, selection, and the branch history toggle do not fire.
- Styling: `font-mono text-xs text-accent hover:text-accent-hover hover:underline`. Optional state tint: merged `text-status-purple`, closed `text-status-red`. Use only design tokens.
- Put label and selection logic in a pure helper, `web-ui/src/utils/task-pull-requests.ts`, with `getLatestPullRequest(card)` and `formatPullRequestLabel(pr, variant)`, and unit-test it.

### Task detail top bar

- In `GitBranchStatusControl`, add an optional `pullRequests` prop. Render the links between the branch `Button` (or the static branch span) and the `(N files …)` span: `ml-1.5 flex items-center gap-1.5 shrink-0`. Show all of them.
- If there are more than 3, show the latest 2 plus a `+N` popover (Radix popover) that lists the rest, so the bar never overflows. Thread `pullRequests` from the selected card where `TopBarGitStatusSection` renders the task branch control. The home (non-task) branch control passes nothing.

### Board card

- In the header row of `board-card.tsx`, render `TaskPullRequestLink variant="compact"` for `getLatestPullRequest(card)` before `TaskPhaseBadge` and the column action buttons, as `shrink-0`. It appears in every column, including Done (`trash`).
- In Done cards, which render the title struck through, keep the link un-struck so it stays usable.

### Manual add and remove

- Add a small "Pull requests" affordance in the task detail view: a `+` button next to the top-bar PR links (or `Link PR` when there are none, shown only for tasks with a worktree). It opens a popover with a URL input that validates live with `parsePullRequestUrl` (shared through `@runtime-contract`-adjacent code, or re-validated server-side; the server is authoritative).
- Each listed PR in the popover has a remove (`X`) button that calls `removeTaskPullRequest`.
- Add tRPC mutations in `src/trpc/workspace-api.ts`: `addTaskPullRequest({ taskId, url })` and `removeTaskPullRequest({ taskId, url })`.

## Milestones

Each milestone is one PR against `main`, independently reviewable, with tests. Later milestones depend only on the ones listed.

| ID | Title | Depends on | Scope |
| --- | --- | --- | --- |
| PL-1 | Contract, parser, and board mutations | — | `runtimeTaskPullRequestSchema` and the optional `pullRequests` card field. `pull-request-links.ts` and `pull-request-detection.ts` with exhaustive unit tests. `addTaskPullRequests`, `removeTaskPullRequest`, and `updateTaskPullRequestSnapshot` in `task-board-mutations.ts`. The server-owned merge in `saveWorkspaceState`. Swap `git-delivery.ts` to the shared parser. No behavior visible to users. |
| PL-2 | Cline capture | PL-1 | `recordTaskPullRequests` write path and broadcast. `onToolFinished` callback from `cline-event-adapter.ts`, wired in the Cline task-session service. Tests: `run_commands` with `gh pr create` records a PR. `gh pr view` does not. Repeated detection does not bump the revision. |
| PL-3 | Hook capture for terminal agents | PL-2 | Detection in `src/commands/hooks.ts`, `pullRequestUrls` on `runtimeHookIngestRequestSchema`, and recording in `hooks-api.ts`. Verify and document the per-agent payload matrix (Claude Code first). Wire `PostToolUse` for agents that have it but do not yet send it. |
| PL-4 | Delivery capture | PL-2 | Record `receipt.pr` from B-8 with `source: "delivery"` and the title snapshot. |
| PL-5 | UI: links in top bar and board card | PL-1 | `TaskPullRequestLink`, helpers, top-bar placement with overflow popover, and board-card compact link. Component tests: placement, `target="_blank"` with `rel`, propagation stopped, latest-only on the card, all on the detail view. Can land in parallel with PL-2 through PL-4, because data can be seeded in tests. |
| PL-6 | Manual add/remove and optional refresh | PL-5 | tRPC add/remove plus the popover UI. Optional "Refresh" action and a best-effort branch lookup on transition to Review when the card has no PR: `gh pr list --head <branch> --state all --json number,url,title,state --limit 5`, run in the task worktree with a short timeout. It never runs on a hot path, never runs through an interactive shell (AGENTS.md), and is skipped silently when `gh` is missing or unauthenticated. Writes the snapshot (`title`, `state`, `stateCheckedAt`). |

PL-1 through PL-5 meet the user-visible goal for GitHub. PL-6 adds the safety nets and an opt-in way to refresh staleness.

## Testing strategy

- **Parser:** table-driven tests covering github.com, GHE hosts, `/files` and `#fragment` suffixes, `/pull/new/branch` (reject), `/compare` (reject), GitLab nested groups, Bitbucket, trailing punctuation from prose (`…/pull/12).`), and uppercase owner normalization for identity.
- **Detection:** the `gh pr create` success output, the "a pull request for branch … already exists" stderr form, chained commands (`cd repo && gh pr create --body-file x`), `gh pr view 205` (none), plain `git push` output that contains `/pull/new/` (none), and MCP structured output.
- **Mutations:** dedupe, ordering, the cap, manual entries surviving the cap, and **a client save with stale `pullRequests` not erasing server-recorded links.**
- **Workspace and delivery tests** redirect `HOME` and `USERPROFILE` to a temp dir (AGENTS.md).
- **Web UI:** component tests next to `board-card.test.tsx` and `top-bar.test.tsx`. Update any `RuntimeBoardCard` mock factories. The field is optional, so existing mocks keep compiling.
- **Manual verification per milestone:** run a Cline task that opens a PR on a scratch repo, confirm the link appears on the card and in the top bar without a page reload, restart Kanban, and confirm it persists.

## Risks and open questions

1. **Client overwrite race.** This is mitigated by the server-owned merge in PL-1. It must land before any runtime writer (PL-2 through PL-4).
2. **Hook payload size and shape.** Some agents may truncate or omit tool output. Coverage gaps fall back to PL-6. Do not grow the ingest payload with raw output.
3. **Cross-repo PRs.** An agent in task A could legitimately open a PR in another repo. That is accepted and recorded, because the detection gate is "this task's agent created it", not "it matches the worktree remote". Revisit only if it causes noise.
4. **Snapshot staleness.** Title and state are labelled as of `stateCheckedAt`. No background polling in this plan.
5. **Upstream suitability.** PL-1, PL-2, PL-3, and PL-5 are generic and upstreamable to cline/kanban. PL-4 depends on fork-only B-8 delivery.
6. **Open question for the owner:** should a merged PR state, once PL-6 refresh exists, offer moving the card to Done? This plan leaves it out. Decide before it is split into a follow-up PL.
