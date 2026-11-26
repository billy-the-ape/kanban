# Automatic PR comment execution

Comment handling remains opt-in and restricted to one linked `github.com` PR
with one repair owner. Native Cline uses its task chat and shared model-capacity
scheduler; Pi uses the same durable observer/feedback preparation with a
task-scoped interactive terminal session. Other terminal agents remain blocked.

## Pi repair execution

Pi feedback is dispatched using the same persisted queued intent, GitHub
snapshot, worktree refresh, deduplication, owner check, and rate limit as Cline.
The difference is the final execution transport: Cline prepares its prompt
inside SDK model admission; Pi prepares just before pasting it as one turn into
its idle task-owned PTY. A real Pi `agent_start` followed by the **`agent_settled`** hook is
required to mark the repair as completed. A temporary `ui_prompt_start`
dialog is an attention pause, **not completion**, and Pi does not accept
new repair messages while waiting on that dialog. A failed or interrupted
terminal turn marks the durable dispatch failed and requires explicit Resume.

When the Pi process is missing, the repair dispatcher first uses the exact
saved-session reattachment from #146. If the original Pi session JSONL,
worktree, or approval is missing, it fails closed; it never resubmits the old
coding task. A server restart during an in-flight Pi repair makes the dispatch
uncertain. The operator must inspect the PR and worktree before clicking
**Resume comment handling**; no automatic replay is attempted.

Pi command result hooks capture PR comment/review publications *after* the
tool finishes so the implementation agent's own replies are excluded from the
next review feedback window. This is less strong than the native Cline
pre-publication capture: a PR update racing the immediate polling window can
still be ambiguous. Keep the existing publication uncertainty and safety cap
enabled, and do not use auto-merge as evidence that every comment was fixed.

## Eligibility and approvals

An approval is a verdict, never a request for work, so nothing an approval published ever
triggers a repair: neither its review body (including approvals containing text) nor the
inline comments submitted inside it (`gh pr review --approve -b`, the submit-review
mutation, or an **Approve** submission that carried review comments).

A reviewer's later submitted approval also retires the review bodies that same reviewer
submitted earlier, whether they requested changes or only commented. It retires nothing
else: a body submitted at or after their own approval stays eligible, and so does another
reviewer's request, human conversation feedback, or an unresolved inline comment attached
to a change-request or plain-comment review, the approving reviewer's own included.
Resolving a thread remains the reviewer's call.

Approvals are not a mergeability verdict; auto-merge and merge-candidate UI are outside
this change.

## Queuing and execution

Feedback reads use a 30-second timeout and an explicit **8 MiB stdout/stderr
buffer per `gh api` page**, including inline comments and their diff context.
Other GitHub operations retain their existing 1 MiB default. A response beyond
the comment-fetch bound is rejected, never truncated into a usable snapshot.

Polling failures (including buffer overflow, authentication, malformed responses,
and incomplete pagination) appear in the comment-handling status and the task's
`prCommentHandling` diagnostics, even before any feedback has been queued. The
status includes a bounded source/page error and indicates automatic retries.
The server logs a warning when the failure reason changes. Polling retains its
existing backoff; failures neither consume feedback nor create a failed repair
requiring Resume. The live warning clears after the next complete snapshot is
persisted. It is re-derived on the next failed poll after a server restart.

No environment variables, settings, dependencies, or record migrations are needed.
Deploy the updated server and let tracking retry; tasks stuck at "Watching for
review comments" because of the old output limit need no manual Resume.

An unsent intent has status `queued` and `attemptedAt: null`. Once its deadline
passes, it waits only for actual runtime or provider prerequisites; it is not in
the model-capacity queue yet. Terminal summaries restored from disk count as
writers only when `hasActiveProcess(taskId)` is true. A native Cline `running`
session still blocks delivery, as does a running terminal agent with a process.
An `awaiting_review` Cline session alone does not block delivery.

Pre-send holds persist a `dispatchHold` containing `kind`, `message`, `since`,
`lastCheckedAt`, and `retryAt` (epoch milliseconds). The original `since` survives
rechecks and restarts while the same reason remains. Reasons cover active writers,
unreadable session services, unavailable GitHub authentication, incomplete fresh
snapshots, unresolved publications, and dispatch-check errors. The UI shows the
reason and elapsed wait; its tooltip includes the check and retry timestamps.
These holds retry automatically on the existing cadence and never consume feedback
or require Resume. Missing task subscriptions are reported separately with a
lane/workspace diagnostic. An overdue intent without a recorded reason is shown
as overdue rather than promising execution "shortly".

Existing records need no migration. Unsent overdue intents are revalidated after
runtime restart and send once their real blocker clears. Running, failed, and
ambiguous previously attempted intents retain their existing safety semantics.
Dirty worktrees still block preparation; preserve or complete partial edits before
using automatic Resume. Failed repair messages include the session's recorded error
when available, so a tool failure is not hidden behind the generic lifecycle error.

1. Polling collects feedback about every 60 seconds. The existing 120-second quiet
   window (600-second maximum from first pending feedback) schedules one repair intent.
2. Task chat accepts a placeholder. Dispatch status `waiting` means the turn has not
   completed preparation after acquiring model capacity. Its feedback is not yet marked
   dispatched. The task service tracks the exact accepted repair through task queuing,
   capacity waiting, preparation, and completion. An idle, interrupted, or completed
   task summary alone does not prove this queued repair was canceled.
3. After both the task queue and shared model queue, an internal preparation callback
   validates ownership, task/link/settings, and authentication. A complete PR snapshot
   younger than 30 seconds is reused; otherwise PR status and all feedback are refreshed.
   Closed/merged PRs or an empty eligible batch skip the model call.
4. Git is verified/refreshed in the actual task worktree. The final prompt replaces the
   placeholder in task chat and contains the pending feedback bodies, IDs, authors,
   timestamps, URLs, and inline file/line/diff context when available (inline or via
   the complete local snapshot described below). The dispatched
   fingerprint advances only at this execution boundary.

Accepted repairs settle from their own completion/failure/cancellation callback, bound
to the dispatch ID. Earlier task turns and late callbacks from a previous repair cannot
settle a newer repair. Failures before preparation retain the undispatched feedback
boundary and expose the actual error for explicit Resume; preparation blockers keep
their more specific error. Restart recovery still pauses attempted repairs whose
outcome cannot be verified and never automatically replays them.

Deploy the updated server; no new configuration or migration is required. For cards
already showing the old cancellation error, use Resume beside **Handle PR comments**
once after deployment. A general task-chat Resume does not retry the failed repair.

Git verification always runs on admission, even when the PR snapshot is fresh. It
requires a clean worktree, no in-progress Git operation, and a configured GitHub remote
matching the PR head repository (including fork identity). The checkout may be either
attached to the PR head branch or on a detached HEAD, which is how Kanban normally
creates task worktrees (a task can publish its detached HEAD to the PR branch without
attaching to it). Any other attached branch blocks. Verification fetches the PR branch
into a temporary private ref, verifies its SHA against the PR snapshot, then rechecks
that HEAD still has its original commit and attachment state: a detach/attach
transition counts as a concurrent change even at the same commit. HEAD that already
equals the PR head proceeds unchanged; HEAD that is an ancestor is fast-forwarded with
`merge --ff-only` (hooks disabled), which updates the checkout and index and leaves a
detached HEAD detached. The final HEAD must equal the captured PR head with the same
attachment state.

An ahead/divergent HEAD, other attached branch, dirty worktree, missing/mismatched
remote, fetch failure, `symbolic-ref` failure, or racing head/attachment change blocks
the turn. No reset, stash, rebase, checkout, branch attach/creation, force push, or
merge commit is performed, so a detached repair never moves a local PR branch, including
one checked out in another worktree. The temporary ref is removed on success and
failure. A successful fast-forward is retained if a later preparation check fails.

A Git blocker is stored as a failed dispatch with `errorCode: git_refresh_blocked`,
shown with its reason and Resume action. Preserve/reconcile the worktree manually,
then Resume; feedback remains eligible. Incomplete GitHub snapshots and local snapshot
write/read failures also fail visibly before a model call. No new configuration/environment variables are
required. Existing Git/gh authentication and network access remain prerequisites.
Repairs paused by the former `Task worktree is on a detached HEAD` blocker need no
manual reconciliation: Resume once after deployment. Feedback handled manually while
paused may be reassessed, since that failed batch was never dispatched.

## Publication identity capture

In addition to full API responses and GitHub comment/review web URLs, capture
recognizes a filtered REST response such as `--jq '{id, url}'`:

```json
{"id": 123, "url": "https://api.github.com/repos/owner/repo/issues/comments/123"}
```

This fallback requires one detected `gh api` write that explicitly names the
linked repository and PR number, one response object from that write's output,
and an HTTPS `api.github.com` URL whose repository, feedback kind and database id
match the write and response. Conversation comments, inline replies/comments,
and reviews are supported; review URLs must also match the PR number. Additional
filtered fields such as `in_reply_to_id` or `user` do not prevent capture. Numeric
output preceding the single JSON object (for example, a printed body length) is
not mistaken for the published id.

Multiple writes sharing a response, multiple response objects, mismatched ids,
repositories or feedback kinds, and command text/read-only output remain
insufficient evidence. Full responses with contradictory target fields cannot
use the reduced-response fallback. Captured identities retain the existing
durable exclusion from later feedback; this does not exclude every comment by
the same account.

Deploy the updated server using the normal release process; there are no new
settings, environment variables, dependencies or record migrations. On startup,
existing unresolved captures can be recovered from their original saved tool
input/output without re-running a publication. If the original result is absent,
or Resume already acknowledged and cleared the capture, this change does not
guess ownership or retroactively scan all historical comments. Such earlier
unrecorded comments may still appear in a feedback batch.

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
- `src/pr-tracking/comment-git-refresh.ts`: safe Git refresh for detached or PR-branch checkouts.
- `src/pr-tracking/comment-handling-prompt.ts`: bounded batch rendering and verified snapshot fallback.
- `src/workspace/task-artifacts.ts`: existing task artifact storage and lifecycle.
- `src/cline-sdk/cline-turn-preparation.ts`: internal admission callback contract.
- `src/cline-sdk/cline-session-runtime.ts`: hook after scheduler admission for live/restarted sessions.
