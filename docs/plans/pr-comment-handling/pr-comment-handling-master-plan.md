# PR comment handling — master plan

Updated: 2026-10-13. Status: COMMENT-0 implemented, plus the second-, third-, and fourth-round review fixes (see "Implementation status" below). Repository: `billy-the-ape/kanban`.

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
| publication | Deduplicated exact identities of comments/reviews published by implementation work (plus the minimal pending/uncertain capture state) |
| autoSendAttempts / autoSendPaused | Bounded safety cap: five automatic send attempts per canonical PR in a rolling 60-minute window and its durable pause state |

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
> same PR. Explain changes and disagreements in PR comments and within task chat.

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
  owner selection/blocking, 120s quiet deadline capped at 600s, pending tracking,
  queued-intent creation on the first pending observation, sticky failed dispatch,
  queued-intent cancellation on disable/terminal observation while in-flight and
  failed dispatches survive), `getTaskPrTrackingState` (neutral / enabled / blocked /
  unsupported), `resumeCommentHandling` (one-shot resume of a failed dispatch; clears the
  failure without sending when no eligible feedback remains), and dispatch through the normal
  backend `sendTaskChatMessage` in `act` mode with the exact fixed instruction.
  `reconcileRestartedDispatches` runs at service startup and resolves recorded in-flight
  dispatches from their normal turn reference without re-running the prompt.
  `runTick` awaits polls before settles so settle always sees the freshest record, and
  per-subscription in-flight flags keep overlapping ticks from double-polling or
  double-sending; `settleDispatch` treats `null`/`completed` dispatches with a due
  deadline as dispatchable in addition to queued intents, and returns early when no
  deadline is scheduled (no pending feedback) so idle subscriptions never trigger gh
  API fetches from the settle path. `refreshWorkspace` cancels the pending schedule
  and provably-unsent queued intent only when a PR loses its last remaining
  candidate; while any candidate remains, the next `applyPrPollOutcome` re-derives
  bindings and ownership instead of resetting the quiet window.
  `recordPrPublicationToolEvent` observes implementation-task tool events through
  the same adapter path as PR-link capture (restricted to implementation task
  sessions, never reviewer sessions) and persists captured publication
  identities in the `commentAutomation.publication` block. Recorded identities
  are excluded before every eligibility computation (fingerprint, counts, quiet
  deadline, dispatched watermark), and recording a reply removes any pending
  scheduling caused solely by that reply while a reviewer's existing quiet-time
  deadline survives. Settle waits while a capture is unresolved and pauses with
  a visible blocker when an identity is unknowable (resume requires explicit
  acknowledgment); `reconcilePublicationCaptures` recovers interrupted captures
  at startup from the exact existing tool result in the task transcript
  (read-only, never a replayed publication). A bounded safety cap allows at
  most five automatic send attempts per canonical PR in a rolling 60-minute
  window: the sixth attempt durably pauses automation (no auto-resume when the
  window expires), and an explicit Resume resets the attempt history without
  bypassing an unresolved capture blocker. A dispatch whose `attemptedAt` was
  recorded is never re-sent automatically after a later record-write failure.
- `src/pr-tracking/pr-publication-attribution.ts` — pure publication-attribution
  logic: recognizes terminal publication commands (`gh pr comment` including
  `--edit-last --create-if-none`, `gh pr review --comment`, and `gh api` writes
  for PR conversation comments, inline comment replies, and review
  submissions), resolves the target against the task's linked PRs (explicit
  repository/selector arguments respected; implicit selectors resolved only
  when safe), and extracts exact identities — namespaced `conversation`,
  `inline`, and `review` — from attributable API responses or returned
  comment/review URLs (URL fragment anchors accepted only under their own
  kind and always validated against the canonical PR). Command text, quoted
  bodies, read-only output, and arbitrary URLs never contribute identities;
  ambiguous output becomes explicit uncertainty, never a guess.
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

Review fixes applied (second review round, same PR):

- Effective-agent gate: subscription (`refreshWorkspace`/`syncWorkspaceSubscriptions`) and the
  detail surface (`getTaskPrTrackingState`) now require the task's *effective* agent to be the
  native Cline agent — the live session's agent when one exists, else the workspace's selected
  agent — via a new optional `getEffectiveTaskAgentId` dependency on the service (injected in
  the runtime server with the same precedence as task start). A card with an unset `agentId`
  no longer counts as Cline when the workspace selects another agent.
- Publication capture no longer rides the PR-link gate: the session-service tool observer runs
  the COMMENT-0 capture before the `links.length === 0` early return, so `gh pr comment`
  publications are recorded for tasks that never created a PR link.
- Ambiguous captures pause visibly: an unresolvable write target (no/ambiguous selector with
  several linked PRs) now records an *uncertain* capture on every linked PR
  (`markAmbiguousCapture`), pausing automation with a visible reason instead of silently
  dropping it; only an explicit selector that demonstrably targets a non-linked PR
  (`explicitUnlinked`) stays ignored.
- Turn outcome via live evidence: settling a running dispatch resolves the session through the
  live owners (`resolveWorkspaceSessionSummaries` over terminal + Cline summaries) and accepts
  the outcome only when `lastOutputAt` postdates `dispatch.attemptedAt`; stale persisted
  pre-dispatch state never completes or fails the dispatch, and restart reconciliation applies
  the same evidence rule (completed when post-dispatch output is proven, otherwise failed with
  the visible Resume requirement).
- `tokenizeCommandFragment` is now quote-aware: quoted numbers/bodies collapse into single
  tokens and can never be mistaken for PR-number positionals in detection or attribution.
- Review feedback events use `submitted_at` (falling back to `updated_at`), matching the real
  review object shape from `GET /pulls/{n}/reviews`.

Review fixes applied (third review round, same PR):

- Resume stays reachable while feedback is pending: the panel renders the blocker/resume branch
  before the pending-countdown branch, so a rate-limit pause, capture uncertainty, or capture
  persistence failure keeps both the visible reason and the Resume button while feedback is
  still queued (a new web-ui component test pins both orderings).
- Startup reconciliation no longer fails work that is not yet loaded: the service resolves the
  repair owner's (and pending captures') workspace through a new optional
  `resolveWorkspacePathById` dependency (injected from the durable workspace index via
  `loadWorkspaceContextById`), covering workspaces that are indexed but have no terminal
  manager yet. A queued dispatch for such a workspace is left as-is at startup (re-validated
  when it loads) instead of being permanently failed, a running dispatch keeps its
  unknown-outcome semantics only when the workspace is genuinely unresolvable, and pending
  captures resolve from the transcript through the index-resolved scope.
- `gh api` publication writes: `parseApiWriteEndpoint` normalizes leading slashes and matches
  in-thread inline reply writes (`.../pulls/N/comments/<id>/replies`), and a submitted review
  is recognized from the real response shape (`state` + `pull_request_url` + id) without
  requiring a `comments` array (extracted when present).
- Repository identity is case-insensitive everywhere it is compared (`matchLinked`,
  `sameTarget`, API-response `hasTarget`, and returned-URL validation), matching
  `getPullRequestIdentityKey` semantics, so a case-differing `-R` selector or URL still
  attributes to the linked PR instead of becoming an uncertain capture.

Review fixes applied (fourth review round, same PR):

- `gh api` value flags: `-q` (short `--jq`) and `-p`/`--preview` take a value and are now in
  the value-consumption flag set, so their values can no longer be mistaken for the endpoint
  (the valueless-flag branch comment is corrected to match).
- Unparseable `gh api` write endpoints: a write-looking `gh api` call whose endpoint does not
  match a known PR-feedback shape is no longer silently dropped. It is recognized as an
  operation with `kind: null`, and `analyzePrPublication` returns an explicit uncertainty
  (never `none`) so the capture pauses visibly instead of vanishing.
- Identities tied to the write invocation: operations now carry the command fragment that
  produced them, and `resolvePublicationOutput` reduces a Cline structured per-fragment
  result (`{query, result, success}` entries) to the write fragment's own result(s) before
  scanning for identities, so a read fragment in the same tool call can never register
  identities. Cap: when the write's evidence contains more than one identity-bearing JSON
  object (a listing mixed into the output), nothing is registered and the capture is
  explicitly uncertain; the URL fallback is skipped for multi-object output.
- Stale pending captures: a start-phase capture whose tool result never arrived (turn
  cancelled, host interrupted, ...) is marked an explicit uncertainty after 10 minutes,
  persisted on settle and surfaced through the existing visible
  `blocker`/`resumable`/`resumeRequiresAcknowledgment` flow, cleared only by an explicit
  acknowledged Resume. It no longer blocks settle silently until a restart reconciles it.

Tests: new `test/runtime/pr-tracking/pr-publication-attribution.test.ts` (14 cases covering
the flag fixes, unparseable-endpoint uncertainty, write-fragment scoping, and the
multi-object guard) plus four new cases in `comment-automation-service.test.ts` (`-q`
end-to-end capture, unparseable-endpoint pause, structured multi-fragment scoping, and the
stale-capture blocker/acknowledged-resume cycle). These fixes postdate v0.2.31 and ship
with the next release; the restart caveat for already-recorded captures still applies.

Review fixes applied (fifth review round, same PR):

- `gh api graphql`: a read-only `graphql` call (reading/resolving review
  threads with `-f query=...` is the normal flow during a comment-handling
  turn) no longer surfaces as an unattributable write. A `graphql` call is
  recognized as a publication only when its inline query carries a
  comment-creating mutation (`addComment`, `addPullRequestReview`,
  `addPullRequestReviewComment`, `addCommentsToDraftReview`) or the query is
  not present in the command text (e.g. an `--input` file) and cannot be
  ruled out; in both cases it is a `kind: null` operation that yields an
  explicit uncertain capture, since a GraphQL response cannot attribute a
  REST comment identity. Inline reads stay ignored.
- Non-feedback REST write endpoints (labels, requested_reviewers, ...): the
  fourth-round `kind: null` fallback for unknown endpoints is reverted. A
  write to an endpoint that cannot create PR feedback is not a publication
  and stays ignored; the `kind: null` uncertain path remains only for
  `graphql` writes.
- Restart reconciliation watermark: when a restart reconcile settles an
  attempted dispatch (`queued` with a recorded `attemptedAt`) as `completed`
  from post-attempt session output, it now also advances
  `lastDispatchedFeedbackFingerprint` to the dispatch's captured fingerprint
  and clears the pending-tracking fields (as the post-send upsert does), so
  the same feedback batch cannot be requeued and re-sent after restart. A
  `failed` reconcile outcome does not advance the watermark (no evidence the
  prompt was accepted), so an explicit Resume can still re-send it.
- Inline comments inside a published review: the client now carries
  `pull_request_review_id` on inline feedback events, and
  `excludePublishedEvents` additionally excludes inline events whose review
  id is in the record's published set. A review submitted with inline
  `comments[]` through a payload no longer re-triggers a follow-up on its
  own inline comments.
- Command tokenizer and PR-number selection: `tokenizeCommandFragment` now
  honours backslash escapes (an escaped quote is a literal character and
  never opens or closes a quoted region), and `readPrSelection` accepts a
  bare number only directly after the action or as the sole positional, as
  its doc comment describes. A number inside a quoted body with escaped
  quotes is no longer read as an explicit PR selection.

Tests: new graphql, non-feedback-endpoint, and selection-strictness cases in
`pr-publication-attribution.test.ts` (22 cases total), plus additions to
`comment-automation-service.test.ts` (graphql-mutation pause, graphql-read
ignore, non-feedback write ignore, the restart watermark advance for an
attempted dispatch, and inline exclusion under a published review) and
`github-pr-client.test.ts` (`pullRequestReviewId` carried on inline events).

Documented v1 deviations: a terminal PR observation cancels queued dispatch but keeps the owner
held until its candidate is no longer enabled; dispatch waits for conflicting writers before
sending (the normal send path provides model-queue admission) but does not yet gate on
repository-wide merge quiescence (merge consumer is a separate plan); restart reconciliation
covers recorded running dispatches via their turn reference, and unknown outcomes stay failed
with the visible Resume requirement. Publication capture is terminal-observation based and
cannot exhaustively attribute opaque scripts (wrapped commands or suppressed output) while
preserving unrestricted terminal access; such output is treated as uncertain capture and
pauses automation with a visible reason and an explicit resume rather than guessing. The
five-attempts-per-60-minute safety cap deliberately bounds legitimate rapid review cycles
too: it is a safety stop, not a claim that every repeated turn is a loop.

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
- Publication-capture manual test on a fresh disposable task/PR: (1) enable Auto address
  comments and publish reviewer feedback; (2) verify one implementation follow-up posts
  replies and its published identities are recorded in the COMMENT-0 record; (3) verify those
  replies do not trigger another follow-up; (4) publish feedback from another reviewer using
  the same account and verify it remains eligible; (5) verify capture uncertainty and the
  five-attempt rate-limit pause automation while manual terminal work still functions.

Use focused backend/UI tests, typechecks and repository Biome checks for supported files.
Isolate HOME/USERPROFILE and Git subprocess environments. Planning changes no runtime settings,
environment variables or deployment. Proposed timing stays 120/600 seconds; only the PR record
gains this minimal comment block. Document actual storage/schema changes and auth read/push
permissions in implementation PRs; pilot one task before expanding.

Deployment requirements for the publication-capture change: none. The new
`commentAutomation.publication` and `autoSendAttempts`/`autoSendPaused` fields are optional
additions to the existing COMMENT-0 record (old records load with empty attribution state),
no environment variables, settings, or manual migration are required, and no publication
command is ever run by the observer.

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
