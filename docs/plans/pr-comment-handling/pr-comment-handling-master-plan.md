# PR comment handling — master plan

Updated: 2026-10-09. Status: COMMENT-0 implemented (see "Implementation status" below). Repository: `billy-the-ape/kanban`.

## Goal and dependencies

Automate the existing instruction “Address comments on the PR.” When Auto address comments
is enabled, wait for feedback to settle, then send one short follow-up through the task's
normal agent workflow. The agent reads GitHub, assesses the feedback, makes appropriate changes
and updates the same PR as it does when instructed manually.

Require both FOUNDATION-0 and FOUNDATION-1 in the
[GitHub tracking foundation](../github-pr-tracking/github-pr-tracking-master-plan.md).
After that, this feature and [merge tracking](../pr-merge-tracking/pr-merge-tracking-master-plan.md)
can be implemented in parallel and ship independently. Terminal cancellation and owner exclusion
come from the foundation; no merge consumer is required.

This replaces the earlier fresh-repair pipeline/per-comment ledger proposal in this plan and
overlapping scope in [PR #21](https://github.com/billy-the-ape/kanban/pull/21).
GitHub is the source of truth for comments, reviews, discussions and fix commits. Do not add
a separate reviewer engine, structured per-comment result format, repair disposition database,
new deterministic publication pipeline or lifecycle repair-budget subsystem.

## Minimal persistence in the PR tracking record

The foundation's canonical PR record contains the comment automation block below. It is shared
by all linked tasks; only the chosen repair owner may mutate/dispatch it. Nothing in this workflow
creates a task-sidecar comment ledger.

| Field | Purpose |
| --- | --- |
| repairOwner | Existing foundation workspace/task identity and ownership revision |
| pendingFeedbackFingerprint | Aggregate digest/watermark of eligible new/edited feedback waiting for dispatch |
| debounceDeadline / firstPendingAt | Two-minute quiet time and ten-minute maximum wait |
| lastDispatchedFeedbackFingerprint | Suppress dispatch of the same feedback after polling, toggle or restart |
| dispatch | queued/running/completed/failed status, dispatched fingerprint, existing session/turn reference, ownership revision and concise error |

Record status describes instruction execution, not proof that every comment was fixed.
GitHub and the existing task transcript/check/delivery history hold the substantive outcome.
Reuse normal session/queue references; do not copy transcripts, comment bodies, candidate trees,
per-item addressed/rejected flags or verification/publication stages into this block.
Schema version and record revision are supplied by the foundation, not a separate workflow store.

Disabling/re-enabling comments, transferring ownership or reopening a card preserves the last
dispatched fingerprint. Transfer does not silently replay an instruction already sent.
Uncertain execution is failed with a visible resume requirement; there is no automatic repair
budget to reset.

## Collection and debounce

Use the foundation observer and eligibility table: metadata and eligible published feedback
only for active task-derived subscriptions. No separate poller or repository-wide scan.
Read submitted review bodies, inline review threads and PR conversation comments with complete
pagination. Ignore unpublished reviews, resolved/deleted threads, empty approval-only feedback,
known bot/status noise and recognized output from the repair itself. Human comments are eligible;
apply the foundation's fixed bot policy (bot review/inline feedback included, bot conversation
chatter excluded). Do not add a bot configuration decision here. No model call is needed to classify each
comment before dispatch: the agent evaluates actual advice during its normal turn.

Fingerprint eligible additions/edits using a deterministic sorted aggregate of provider IDs,
updated timestamps and body digests. The aggregate includes a latest-update watermark for
detecting new/edited feedback; do not use PR head changes as new feedback. Raw comments are fetched
from GitHub and may be held in transient snapshots, not duplicated in durable workflow storage.
Duplicate polls, resolution/deletion alone, own pushes and unrelated status updates do not
trigger another instruction. Drop removed feedback from a pending aggregate; if none remains,
cancel the pending dispatch. Preserve the dispatched watermark when previously dispatched
feedback disappears so surviving old comments do not look new after restart.

On first enable, currently published eligible feedback can form a batch; an already dispatched
aggregate does not replay. New/edited eligible feedback sets a deadline **120 seconds after its
last change**, with **600 seconds maximum wait** from firstPendingAt. Persist only the aggregate
and those times. A running writer/model capacity wait may postpone actual execution beyond
that deadline. Feedback arriving after a dispatch forms the next pending aggregate.

At due time, perform a successful fresh read and revalidate owner, task/link/settings, PR open
state and eligible feedback. A partial API failure cannot dispatch. The collection module exposes pending
count/deadline from the current GitHub snapshot;
the dispatch module below owns instruction submission.

### Fingerprint and dispatch contract (settled)

Fingerprint is a structured dedupe descriptor, not a bare string: SHA-256 of sorted eligible
event-version tokens, latest updatedAt watermark, and sorted version tokens at that exact
watermark timestamp. Tokens are kind + provider ID + updatedAt + body digest. Preserve the
last-dispatched boundary tokens when events are deleted; a new token at the same timestamp
still triggers, while surviving old tokens/deletion alone do not. This is compact transport
dedupe data, not per-comment fix state. Versions before the watermark are already dispatched;
GitHub edit timestamps advance versions. Freeze deterministic numeric/timestamp ordering in tests.

The aggregate captured at instruction submission is the dispatched one; later observed versions
remain pending regardless of whether the agent happens to see them. Never replace that captured
aggregate with the newest snapshot merely because the turn completes. Failures and API partial
results do not advance the consumed watermark.

Dispatch adds only dispatchId, attemptedAt, captured fingerprint, owner revision, status,
turn reference and error. attemptedAt is null while provably unsent; persist it immediately
before invoking normal chat send. Attach dispatchId to existing chat message metadata as an
optional automation correlation ID (no separate transcript store). Hook normal message acceptance
to record its turn reference promptly; do not wait for the async send promise to resolve.
If restart finds attemptedAt but no trustworthy message/turn evidence, fail for explicit resume.
No send-idempotency system or blind replay is required.

## Exact instruction and agent workflow

Use this template, substituting the validated selected PR URL:

> Address comments on the linked PR: {url}. Check the feedback against the current code and
> original task requirements. Fix valid issues, explain any disagreements, and update the
> same PR. Explain changes and disagreements in task chat; do not post PR comments.

Send this as a normal task follow-up. Reuse the existing conversation/session, original task
context, repository instructions, model/provider settings, tool permissions and compaction.
If the session needs recovery, use the existing task continuation path; do not introduce a
mandatory fresh repair session. If original task context cannot be recovered, fail visibly.
Do not attach the full master plan or prescribe a machine-readable response.

Allow the normal agent workflow to inspect comments, edit, run checks, commit and push the
same PR under existing permissions. There is no new “backend owns all commits/pushes” split,
no requirement to reply publicly to each item and no mandatory disposition vocabulary.
The expected response is the usual concise explanation of changes, disagreements and checks.
Existing verification/delivery behavior remains in force; do not weaken it or invent results.

1. Require the selected foundation repair owner and validate this task's writable PR/head
   mapping. Acquire the existing task/PR/head reservation. Wait while any conflicting writer,
   review or manual operation is active; do not inject feedback mid-turn.
2. Persist queued dispatch intent, fingerprint and owner revision before sending. Use the
   existing model admission queue and q #N visibility. Recheck cancellation and linkage at
   admission. Automatic follow-ups with prior history cannot use untouched-task Backlog reset.
3. Submit exactly one instruction and capture its normal session/turn reference. Preserve
   lastDispatchedFeedbackFingerprint as soon as acceptance is confirmed. An unknown send
   outcome is failed/needs-resume, never blindly retried.
4. Use existing running-turn lifecycle for Review → In Progress and completion → In Review.
   A normal agent turn completion marks this dispatch completed; it does not mark every review
   item addressed or move the card to Done. Existing prompt receipts prevent duplicate Auto PR.
5. New eligible feedback waits for a later debounced follow-up. Unchanged unresolved comments
   do not retrigger merely because the agent declined them or GitHub threads remain open.

### Code path and execution rules

Route automated follow-ups through the same backend sendTaskChatMessage implementation in
`src/trpc/runtime-api.ts`, including sendTaskSessionInput and rebindPersistedTaskSession recovery.
Extract a reusable backend function if needed; do not call a browser hook or loopback HTTP.
Set the existing runtimeTaskSessionMode to `act` for this instruction, preserving provider/model/
reasoning/rules/permissions.
Do not refresh/recreate a task worktree during a follow-up. If continuation fails, expose the
existing error and require manual recovery rather than starting a contextless replacement task.
Normal SDK turn events drive status/board transitions; preserve the in-flight task guard.

For initial queued intent, enabling/PR association alone never interrupts a writer. Before send,
refresh metadata/feedback and ownership. While model capacity is queued, new eligible feedback
is pending for the next instruction; do not mutate the accepted chat message. An active human
follow-up can clear the automatic failure only when explicitly marked as Resume comment handling,
not merely because another message happened to succeed. The button resumes once, rechecking PR/
scope and retaining fingerprint history; no generic checkbox toggle resets failure.

## Failure, cancellation and restart

Keep existing turn/tool retry/time limits; introduce no new three-round/two-no-progress counters,
per-comment receipts or separate repair stage machine. A failed dispatch stops automatic comment
instructions for this PR until explicit Resume comment handling or a manual follow-up resolves it.
New comments, checkbox toggles and owner transfer cannot silently bypass that failure.

At restart, use the recorded normal turn reference to reconcile known live/completed execution.
A pending aggregate or provably unsent queued intent can resume after eligibility checks.
If a running turn or send/push outcome cannot be established, show an error requiring user
resume rather than rerunning the prompt. Resume uses the same normal instruction path and
current GitHub state; it does not wipe the last dispatched fingerprint or silently resend old
work. An explicit operator choice can retry interrupted feedback after inspecting GitHub/worktree.

Disable, pause, trash, unlink, owner transfer or terminal PR observation cancels queued dispatch.
Stop active work through existing safe cancellation, retaining edits/history. A merged/closed PR
never receives another automatic comment follow-up, including after Done → Review history access.
An installed merge consumer waits for shared quiescence; comments alone return to In Review.

## Implementation PR boundary

One implementation PR: **COMMENT-0 — debounced normal PR-comment follow-up**. Combine collection,
debounce, prompt submission, normal continuation, queueing, ownership and restart/error handling.
Depends on FOUNDATION-0 and FOUNDATION-1 only; no MERGE dependency. Earlier separate COMMENT-1
is folded into this PR and must not be scheduled as a second card.

Implement in this order: consume foundation snapshots → compute aggregate/deadline → persist
queued intent → dispatch through normal chat continuation → record turn acceptance/outcome →
wire task detail diagnostics/resume → run the tests below. No task breakout documents are
created here; the user's agent will create them using this boundary.

## Implementation status (COMMENT-0)

Implemented in this repository, all green under `vitest run`, `tsc --noEmit` (root and web-ui)
and Biome checks:

- `src/pr-tracking/feedback-fingerprint.ts` — normalizes eligible feedback events and computes
  the deterministic aggregate (SHA-256 digest, newest-watermark ms, sorted provider-id token
  set). A dispatch watermark removes its own token set from later aggregates, so deletion or
  resolution of already-dispatched feedback never requeues it.
- `src/pr-tracking/github-pr-client.ts` — read-only `gh` client: PR metadata plus complete
  pagination (`per_page=100`, capped at 20 pages per source) of reviews, inline review comments
  and PR conversation comments, plus GraphQL resolved-thread filtering. Eligibility applies the
  fixed policy: published, non-empty, unresolved, non-bot conversation chatter. Per-source
  pagination failure marks the snapshot incomplete (dispatch waits); non-`github.com` hosts and
  missing/failed credential resolution surface visible errors without partial dispatch.
- `src/pr-tracking/pr-record-store.ts` — durable PR tracking records under
  `~/.cline/kanban/pr-tracking/prs/<sha256(canonicalKey)>.json` with atomic writes, load-time
  identity validation, exactly-one revision advancement per accepted update and no-op writes
  that never touch the file.
- `src/pr-tracking/comment-automation-service.ts` — `applyPrPollOutcome` (task bindings,
  owner selection/blocking, 120s quiet deadline capped at 600s, pending tracking, sticky failed
  dispatch, queued-intent cancellation on disable/terminal observation while in-flight and
  failed dispatches survive), `getTaskPrTrackingState` (neutral / enabled / blocked /
  unsupported), `resumeCommentHandling` (one-shot resume of a failed dispatch; clears the
  failure without sending when no eligible feedback remains), and dispatch through the normal
  backend `sendTaskChatMessage` in `act` mode with the exact fixed instruction.
  `reconcileRestartedDispatches` runs at service startup and resolves recorded in-flight
  dispatches from their normal turn reference without re-running the prompt.
- Contract and mutations: `autoAddressComments` (optional, default false) on
  `runtimeTaskCardSchema`; `runtimeTaskPullRequestSchema` with `lastSyncedAt`/`stateCheckedAt`;
  `RuntimePrTrackingRecord`, `RuntimePrCommentAutomation`, `RuntimePrCommentDispatch`,
  `RuntimePrFeedbackFingerprint`, `RuntimeTaskPrTrackingState` and
  `RuntimePrCommentDispatchResult`. `validateTaskCardMutation` and
  `applyTaskBoardMutation` preserve the flag and PR links.
- Server: `workspaceStateCache.getTaskPrTrackingState`,
  `workspaceStateMutations.setTaskAutoAddressComments` (triggers a 30s post-commit PR poll),
  `workspaceStateMutations.resumePrCommentHandling`; runtime TRPC endpoints
  `getTaskPrTrackingState`, `setTaskAutoAddressComments`, `resumePrCommentHandling`; the
  runtime server injects the service with an `updateTaskRecord` hook that persists card
  changes, syncs the board and refreshes the PR record after every accepted poll outcome.
- UI: `web-ui/src/hooks/use-task-pr-tracking-state.ts` (polls state, exposes toggle/resume
  actions) and `web-ui/src/components/task-pr-comment-handling-panel.tsx` (toggle with
  enabled/neutral/blocked/unsupported state, pending count and quiet-time countdown, dispatch
  status, failed state with the concise error, Resume button, incomplete-snapshot and auth
  blockers), wired into the task detail's PR manager.
- Tests: `test/runtime/pr-tracking/` — `feedback-fingerprint.test.ts`,
  `pr-record-store.test.ts`, `comment-automation-service.test.ts`
  (`applyPrPollOutcome` semantics plus service state/resume/dispatch behavior with injected
  dependencies) and `github-pr-client.test.ts` (eligibility, completeness, pagination and
  access-scope errors via an injected command runner).

Documented v1 deviations: a terminal PR observation cancels queued dispatch but keeps the owner
held until its candidate is no longer enabled; dispatch waits for conflicting writers before
sending (the normal send path provides model-queue admission) but does not yet gate on
repository-wide merge quiescence (merge consumer is a separate plan); restart reconciliation
covers recorded running dispatches via their turn reference, and unknown outcomes stay failed
with the visible Resume requirement.

## Verification and rollout

- Multiple new/edited comments reset quiet time; duplicate polls do not; max wait and partial
  pagination failure; deletion/resolution alone and own push cannot requeue old comments.
- Two tasks/workspaces linked to one PR share reads but only one sends the prompt; transfer,
  toggles and restart preserve the dispatched fingerprint.
- Exact prompt is sent through normal continuation with task settings/rules and transcript
  intact; running task waits; model saturation shows q #N; cancellation prevents late launch.
- Accepted prompt with lost response or unknown running state fails visibly without resend;
  known unsent intent can resume; failed state blocks even if new comments arrive.
- Completed instruction returns to In Review without requiring structured output or all GitHub
  threads resolved; no early Done or additional PR. Merge/close stops dispatch with merge absent.
- Disposable pilot: leave several comments within two minutes, observe one ordinary follow-up,
  same-PR update and normal explanation. New comments during that turn wait for the next batch.
  Restart with an ambiguous interrupted turn and verify a visible resume requirement.

Use focused backend/UI tests, typechecks and repository Biome checks for supported files.
Isolate HOME/USERPROFILE and Git subprocess environments. Planning changes no runtime settings,
environment variables or deployment. Proposed timing stays 120/600 seconds; only the PR record
gains this minimal comment block. Document actual storage/schema changes and auth read/push
permissions in implementation PRs; pilot one task before expanding.

After actual service/device changes, update `billy-the-ape/homelab-documentation` through a
Ready for Review PR with deployed configuration, storage, permissions and rollback.


## PR 71 conflict reconciliation

PR 71 originally branched before PRTRACK-0, PRTRACK-1, and MERGE-1 reached
`main`. Its independently implemented COMMENT-0 record schema is incompatible
with the shared tracking foundation record. This conflict resolution preserves
both implementations: shared records remain in `pr-tracking/prs`, while COMMENT-0
records use `pr-tracking/comments` through `pr-comment-record-store.ts`. Neither
consumer may overwrite the other's record for the same canonical PR identity.
The COMMENT-0 settings endpoint delegates to the shared PR settings mutation,
including its revision; board-change broadcasts refresh both subscription paths.

This is coexistence, not migration to a single coordinator: COMMENT-0 retains its
existing observer and detail panel. Integrating that observer with the shared
consumer registry, record schema, and reservation lifecycle remains separate work.
No new environment variables or manual data migration are required for this PR.
