# Automatic PR comment execution

Comment handling remains opt-in, native-Cline-only, and restricted to one linked
`github.com` PR with one repair owner. It uses the existing observer, task chat,
and shared Cline model-capacity scheduler.

## Eligibility and approvals

Approval review bodies never trigger a repair, including approvals containing text.
A reviewer's later submitted approval supersedes their earlier change-request review
body. It does not erase other reviewers' requests, conversation feedback, or unresolved
inline comments, including inline comments attached to an approving review. Approvals
are not a mergeability verdict; auto-merge and merge-candidate UI are outside this change.

## Queuing and execution

1. Polling collects feedback about every 60 seconds. The existing 120-second quiet
   window (600-second maximum from first pending feedback) schedules one repair intent.
2. Task chat accepts a placeholder. Dispatch status `waiting` means the turn has not
   acquired model capacity. Its feedback is not yet marked dispatched.
3. After both the task queue and shared model queue, an internal preparation callback
   validates ownership, task/link/settings, and authentication. A complete PR snapshot
   younger than 30 seconds is reused; otherwise PR status and all feedback are refreshed.
   Closed/merged PRs or an empty eligible batch skip the model call.
4. Git is verified/refreshed in the actual task worktree. The final prompt replaces the
   placeholder in task chat and contains the pending feedback bodies, IDs, authors,
   timestamps, URLs, and inline file/line/diff context when available (inline or via
   the complete local snapshot described below). The dispatched
   fingerprint advances only at this execution boundary.

Git verification always runs on admission, even when the PR snapshot is fresh. It
requires a clean worktree, the PR head branch, no in-progress Git operation, and a
configured GitHub remote matching the PR head repository (including fork identity).
It fetches that branch into a temporary private ref, verifies its SHA against the PR
snapshot, and only fast-forwards a behind branch. An ahead/divergent branch, detached
HEAD, dirty worktree, missing/mismatched remote, fetch failure, or racing head change
blocks the turn. No reset, stash, rebase, branch checkout, force push, or merge commit
is performed. A successful fast-forward is retained if a later preparation check fails.

A Git blocker is stored as a failed dispatch with `errorCode: git_refresh_blocked`,
shown with its reason and Resume action. Preserve/reconcile the worktree manually,
then Resume; feedback remains eligible. Incomplete GitHub snapshots and local snapshot
write/read failures also fail visibly before a model call. No new configuration/environment variables are
required. Existing Git/gh authentication and network access remain prerequisites.

## Bounded feedback and later changes

The prompt tells the agent to assess only the supplied feedback versions, inspect
local code, run focused checks, and publish replies using supplied identities. It
must not discover new comments/reviews or pull/rebase mid-turn. It must stop on a
publication conflict rather than force push, and leave thread resolution to reviewers
because newer comments may have arrived. This is a prompt-level instruction; terminal
access is unchanged, not a command-enforcement sandbox.

The complete rendered prompt is capped at 32,000 characters, including instructions
and JSON formatting. Small batches remain inline. When a batch exceeds that limit,
preparation atomically writes the complete captured batch to a task context artifact
and reads it back to verify the contents before touching Git or advancing the dispatch
boundary. The short prompt supplies its absolute path and feedback count. No comments
or long bodies are truncated, summarized, or silently omitted.

The JSON snapshot includes the PR URL, capture timestamp, verified head SHA, and each
item's ID, kind, body digest, full body, author, timestamp, URL, and inline context when
available. It lives outside the checkout at
`<task worktrees home>/<taskId>/context-artifacts/pr-feedback-<dispatchId>-<timestamp>-<random>.txt`,
using the existing atomic artifact writer and diagnostic index. The agent reads all
items in bounded sections (character slices for long JSON lines), accounts for each,
and stops with an error if it cannot read the entire batch. It must not modify or commit
the artifact or fetch live feedback as a substitute.

Artifacts persist across runtime restarts and are removed with the owning task state
directory, following existing context-artifact retention. A Resume captures a fresh
batch and, if still oversized, creates a new artifact rather than overwriting the old
snapshot. Preparation failures leave feedback undispatched and require Resume; failures
after admission retain the existing previous-boundary restoration behavior.

Raw feedback appears in task chat/SDK history for inline batches and in local artifacts
and subsequent tool reads for oversized batches. The separate workflow record continues
to store only fingerprints and attribution metadata. The runtime user must be able to
write and read its existing task context-artifact directory; no new settings, environment
variables, dependencies, or migrations are required. After deployment, use Resume once
on repairs already paused by the old size-limit error.

Polling continues while waiting and running. Feedback observed before admission is
included in the refreshed batch; feedback added/edited after capture remains pending
for a subsequent turn, without injecting chat messages into the running turn. Resolved
or deleted feedback is re-evaluated from GitHub. Exact event-version tokens detect
edits even when their timestamps are older than the batch watermark. Legacy records
without those tokens use their existing timestamp boundary until the next dispatch.

Failed admitted turns restore their previous feedback boundary for explicit Resume.
A runtime restart never replays an accepted waiting turn automatically: it fails
visibly for Resume, since the scheduler's in-memory queue no longer exists.

## Source map

- `src/pr-tracking/github-pr-client.ts`: eligibility and feedback metadata.
- `src/pr-tracking/comment-automation-service.ts`: debounce, dispatch, preparation and lifecycle.
- `src/pr-tracking/comment-git-refresh.ts`: safe Git refresh.
- `src/pr-tracking/comment-handling-prompt.ts`: bounded batch rendering and verified snapshot fallback.
- `src/workspace/task-artifacts.ts`: existing task artifact storage and lifecycle.
- `src/cline-sdk/cline-turn-preparation.ts`: internal admission callback contract.
- `src/cline-sdk/cline-session-runtime.ts`: hook after scheduler admission for live/restarted sessions.
