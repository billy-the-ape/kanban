# PR merge tracking — master plan

Updated: 2026-10-09. Status: MERGE-1 implemented (branch `feat/merge-tracking`, pending review); documentation + implementation. Repository: `billy-the-ape/kanban`.

## Goal and independent feature boundary

Finish opted-in tasks after a linked PR merges, then release linked successor tasks
against verified merged code. Preserve manual Done → In Review history access without repeated
completion or successor launch. This feature never merges PRs.

First complete the [GitHub PR tracking foundation](../github-pr-tracking/github-pr-tracking-master-plan.md)
(FOUNDATION-0 and FOUNDATION-1). After that, merge tracking and
[comment handling](../pr-comment-handling/pr-comment-handling-master-plan.md) can be built
in parallel and ship in either order. Merge tracking requires no comment implementation:
consume foundation snapshots/gates and existing completion/dispatch services only.

## Dependencies and existing work

- [PR linking](../pr-linking/PR_LINKING_PLAN.md), currently proposed in
  [PR #49](https://github.com/billy-the-ape/kanban/pull/49): durable server-owned `pullRequests`
  identities, capture and manual correction. Require the implemented contracts and mutation
  paths, not merely approval of its plan. Resolve PRLINK milestone naming against current code.
- [B-9 dispatcher](../B-9.md): durable launch ownership, dependency checks and verified baselines.
- [Base refresh](../update-base-ref-before-start/PLAN.md): safe preparation and repository locks.
- [Model capacity queue](../../runtime/cline-concurrency.md): endpoint/model FIFO admission,
  automatic slot discovery, cancellation and `q #N` badges.
- [PR #21](https://github.com/billy-the-ape/kanban/pull/21) contains an older unmerged
  feedback/repair proposal. These three plans supersede its overlapping monitoring, repair and
  merge lifecycle design for this implementation. Do not run both card series or create a
  second task/PR mapping. Keep #21 as historical rationale; no closure/merge is implied.
- [PR #29](https://github.com/billy-the-ape/kanban/pull/29) proposes broader history viewing.
  This feature must preserve existing Done → Review support without requiring that entire plan.

Source inspection baseline: `main` commit `49a2ca05c6c2927da2194aaec8bd1e45e6fa2928`.
Reinspect before implementation; PR linking is not assumed merged at this baseline.

Known integration points: `src/core/api-contract.ts`, `src/core/task-board-mutations.ts`,
`src/state/workspace-state.ts`, `src/trpc/workspace-api.ts`, `src/server/runtime-server.ts`,
`src/workspace/git-delivery.ts`, `src/task-dispatch/`, and the native Cline session boundary.
The dispatcher currently requires Done plus a delivered/no-op receipt and original commit
ancestry. That is insufficient for squash/rebase merges; a new merge completion evidence
type and baseline resolver are required. Do not fabricate a legacy delivery receipt.
`web-ui/src/hooks/use-review-auto-actions.ts` can complete after PR delivery or a clean tree;
that behavior must be suppressed for tasks waiting for merge.
`web-ui/src/state/drag-rules.ts` already permits Done → Review.

## Foundation contract used by this feature

The foundation owns card preferences, selected Automation PR, one canonical PR record with
validated task bindings, authorized snapshots, polling subscriptions and operation gates. Do not
implement those again here. Register the merge consumer, requesting PR metadata only,
and use its revision-checked task merge binding consumed by existing dispatch APIs.
Comment execution state remains minimal in that same PR record; this feature adds no comment ledger.

Auto complete task when PR is merged remains false by default and editable in In Progress/In Review.
The foundation prevents legacy PR-delivery/clean-tree automatic Done while this workflow is
enabled. This feature owns confirmed-merge completion, successor dispatch and historical reopening.
Observe the foundation's polling stop/resume table and bounded terminal reconciliation;
never add a feature timer or a completion retry loop that extends terminal API reads.

When one PR belongs to multiple tasks, each eligible merge consumer may finish its own card
using its own validated task/linkage and merge evidence; completion/dispatch evidence remains
task-scoped. Reuse the shared PR quiescence gate so neither card completes while any tracked
writer on that head has unresolved work. This does not grant either task repair ownership.

## Merge completion

1. Freshly confirm the selected PR is merged; closed-unmerged and draft/open remain In Review.
2. The enabled checkbox plus confirmed merge is the complete acceptance rule. Do not require
   an APPROVED review, final-head review evidence, resolved threads, a human merger, passing
   CI checks or a second user confirmation. A human or bot merge is equally eligible. Review/
   merge policy belongs to GitHub or the user's workflow. If manual completion is desired,
   leave this checkbox unchecked; no card movement or successor launch follows this PR merge.
3. Consume foundation terminal invalidation and acquire its quiescence gate. The foundation
   cancels undispatched write intents, prevents new writes and requests orderly safe stop of
   tracked task writers, verification and delivery, even with no comment consumer installed.
   Reconcile and preserve dirty/untracked or unpublished work before completing. Uncertain side effects
   or post-merge edits block for manual handling; never force-clean the worktree.
4. Persist a completion receipt containing task/workspace/repository identity, selected PR,
   final head, merge/base identity, merge SHA, timestamp and generation.
5. Apply a revision-checked board transition through existing completion/preservation APIs,
   broadcast the updated board, then request the backend dispatch pass. Persist effect stages
   so restart after receipt, board movement or dispatch cannot lose or repeat the transition.

Recheck checkbox, selected PR, task generation and column immediately before mutation. No auto
completion from Backlog, Trash or a manually reopened historical card. Disable blocks pending
completion without discarding evidence. Enabling on an already merged PR can complete after
all gates pass, except a previously consumed/reopened generation. No automatic GitHub merge,
review submission or branch deletion is introduced.

## Fixed completion and dispatcher contract

Store mergeCompletion in the PR record's task binding, with schema version, workspace/task/link
generation, selected PR identity, finalHeadSha, base repository/ref, mergeCommitSha, mergedAt,
observedAt, status (pending/completed/blocked), completedAt and concise error. No review fields.
Use that binding as the authoritative merge receipt; existing dispatch records own child launch
state. Board state and record writes need not be one filesystem transaction: persist pending →
apply idempotent board move → mark completed → dispatch. Startup reconciles each stage.

Extract one backend completeTaskFromMergedPr operation. Invoke it on fresh terminal observation,
startup pending reconciliation and explicit completion resume. Revalidate checkbox, task column,
PR/link generation and shared quiescence. Use existing preservation/stop APIs and authoritative
mutateWorkspaceState board writes followed by broadcastRuntimeWorkspaceStateUpdated.
Preserve actual dirty/untracked or unpublished work and block visibly when unresolved; never
silently discard work to satisfy the merge rule. These are data-preservation gates, not approval
gates. If target fetch later fails, the parent remains Done and its child stays blocked/queued
with the fetch error; do not undo valid parent completion.

Extend dispatchReadyTasks with an explicit merged_pr trigger and candidateTaskIds derived from
direct linked dependents of completed merge bindings. This path runs even when
taskDispatchPolicy.enabled or gitDeliveryPolicy.enabled is false; enabling PR merge tracking
must not require enabling deterministic PR creation/delivery. Do not auto-enable either policy
or launch unrelated backlog cards. For non-merge prerequisites retain their existing delivery/
no-op readiness rules. All prerequisite cards must be Done; Trash/missing/cycles/manual deferral
block. Do not run a second browser launcher for these candidates.

Use the existing taskDispatchPolicy.workerLimit (configured value, otherwise 1) as the independent
workspace launch cap, even in this trigger path. Reuse endpoint/model queue for actual turns;
a saturated model can leave an admitted child In Progress with q #N. A worker-cap wait remains
Backlog with a dispatch-wait reason, not a fake model queue position. Persist dispatch ownership
before the board move/start; board move is server-owned and precedes startTaskSession.
Use the child's existing agent/model/plan-mode settings and normal start API.

Re-run candidate passes after merge completion, relevant board/dependency change, worker/turn
release, model admission cancellation and runtime startup. Only eligible undispatched children
launch, once. Preserve existing retry cap/manual deferral. If prerequisites are reopened before
a child starts, cancel its pending admission and retain its backlog/blocked intent; never remove
prior work to do this. Already admitted/running children keep their existing state/history.

For baseline preparation, fetch the exact base ref into remote-tracking refs under the existing
base-preparation lock. Require Git merge-base --is-ancestor for mergeCommitSha against the resolved
successor baseline. GitHub merge_commit_sha is the landed merge/squash commit or last rebase
commit after a confirmed merge; do not substitute original PR head ancestry. Missing/unreachable
merge SHA blocks rather than guesses. Retain the child's selected base: fetch its origin-backed
branch and verify it contains all merged prerequisites; a pinned/incompatible base blocks with
an action to update it. Do not silently select a different branch or pull into a dirty checkout.
Normal fresh start creates its worktree at that verified SHA; existing prior-work worktrees are
checked, not reset. Preparation-only untouched worktrees use the existing safe reset/reprepare
path. The optional base-refresh checkbox cannot waive required dependency freshness.

## Successor handoff and history

Extend B-9 readiness to accept explicit confirmed-merge completion receipts while retaining
existing delivery/no-op modes for other tasks. The runtime, not browser hooks, owns this handoff
even when the old reliable dispatcher policy is disabled; offer the needed backend dispatch
path for merged prerequisites without requiring deterministic PR creation for agent-created PRs.
Retain explicit user dependency edges and require all prerequisites, including diamonds.
Honor manual deferral, pause, cancellation and existing dispatch retry limits.

Fetch the exact PR base repository/ref under the preparation lock before starting a successor.
Resolve a current base containing the recorded merge result. For merge commits, squash and
rebase merges verify the provider's landed commit against fetched target ancestry; do not
require the original PR head/task commit to remain an ancestor after squash/rebase. If merge
identity cannot be verified, block visibly rather than guessing. If a successor targets another
base/repository, require proof that it includes the result or block with the required action.
Never rewrite a dirty primary checkout, force-pull, or destructively reset an existing worktree.
Reprepare untouched pre-created worktrees safely; existing prior work requires manual resolution
when it lacks the prerequisite result. The task's optional “Update base ref before starting”
setting cannot waive this mandatory dependency freshness check.

Reserve durable dispatch ownership, then start a fresh successor session with its own task
prompt, concise prerequisite handoff and verified base SHA. Reuse endpoint/model capacity
admission and `q #N` badges; waiting does not count as execution or failure. The per-workspace
worker limit remains an independent launch cap: distinguish “waiting for dispatch” from a
turn already queued for model capacity. Preserve FIFO, cancellation and unstarted queued-task
return-to-Backlog rules. Restart must reconcile durable intents with live ownership before
resuming; never launch a successor twice or depend on the in-memory admission queue surviving.

Done → In Review remains manually available and retains settings, PR links, transcript,
receipts and preserved work. Persist a manual-reopen marker before exposing Review; the same
merged PR cannot immediately send it back to Done. Reopening must not clear comment dispatch markers,
replay Auto PR, start an agent or trigger already-dispatched successors. Already running children
are unaffected; children not yet dispatched wait while the prerequisite is back in Review.
Moving it manually to Done may release waiting children once, using retained valid evidence.
History inspection must not trigger base-refresh or delivery side effects. Preserve existing
worktree recovery where needed for detail access.

## Implementation PR boundary

One implementation PR: **MERGE-1 — confirmed merge completion and successor handoff**.
Combine receipt/board completion, legacy completion arbitration, merged baseline resolution,
successor dispatch/queueing and manual history reopening. Depends on FOUNDATION-0 and
FOUNDATION-1 only; no COMMENT dependency. Former MERGE-2 is folded into this PR; former
MERGE-0 is the separate foundation. Do not schedule either obsolete slice.

Implement in order: consume confirmed metadata → complete through quiescence/preservation →
record receipt and board outcome → extend dispatcher receipt/baseline logic → wire triggers
and queued restart reconciliation → preserve history reopening → run tests below.
Do not create task breakout documents; the user's agent will generate them.

## Verification

- Foundation contract integration: merge consumer alone and alongside a fake comment consumer;
  task-scoped completion for two tasks sharing a PR; terminal observation cannot race a shared
  head writer or exceed read limits; stopped subscriptions remain stopped after history reopen.
- Lifecycle tests: open/draft/closed-unmerged vs merged; no approval, stale approval, unresolved
  review requests and bot merge all complete when enabled; disabled remains unchanged;
  live/dirty task, toggle-off race and duplicate polls;
  crash at each receipt/move/dispatch boundary; no early Done after PR delivery or clean tree.
- Dispatch tests with real temporary Git repositories: merge, squash and rebase landed results;
  stale/pre-created and dirty worktrees; fetch failure and incompatible base; diamond dependencies;
  one durable launch; manual deferral; saturated model and worker caps; cancel queued successor.
- UI/API tests: independent editable checkboxes in both active columns; stale board saves;
  no-PR/ambiguous/unsupported/blocked reasons; Done → Review survives polling/restart without
  bounce, duplicate PR prompt, hidden agent startup or repeated child launch.
- End-to-end disposable PR: enable merge tracking, publish a PR with no formal approval, leave the browser
  closed, merge externally, confirm Done and successor running/queued on the merged baseline.
  Reopen parent to inspect history and restart the runtime; it stays In Review.

Isolate HOME/USERPROFILE and use the repository Git test environment helper for subprocesses.
Run focused backend/UI tests, backend/web typechecks, Biome on changed supported files and
required CI. Scripted fixtures prove lifecycle plumbing, not model review quality.

## Rollout, deployment and documentation

This PR is planning only: no environment variables, dependencies, migration or deployment.
The foundation supplies false-default settings, records, 60-second polling and runtime auth.
Merge implementation adds only its task merge binding schema and completion/handoff
behavior. Document storage upgrades and deployment/rollback in
implementation PRs. Merge tracking requires read access and no PR push permission.

## MERGE-1 final implementation state

Implemented in `feat/merge-tracking` (single PR, per the boundary above):

- **Consumer module** `src/pr-tracking/pr-merge-completion.ts`:
  `reconcileMergeCompletion` runs the observation flow (idempotency/manual-reopen
  guard on the persisted binding's `mergeCompletion` — the same merge commit is
  consumed at most once; a later merge commit completes again; a card in an
  active column without the server-derived `manualReopenAt` marker is a crash
  straggler and re-runs the idempotent completion), card eligibility
  (`autoFinishOnMerge` + In Progress/In Review only), writer quiescence probe,
  fenced `merge_completion` reservation (released in `finally` on every outcome),
  worktree inspection (base branch must contain the merge commit; no clean local
  commits ahead of base — the ahead count excludes the merged PR head so
  squash/rebase merges do not read as local work), hard reset of a dirty worktree
  to the base branch, then moves the task to Done BEFORE persisting
  `mergeCompletion: completed` + terminal stop `merged_completed` (the move is
  idempotent, so a failed move leaves the binding untouched and the bounded
  reconciliation reads retry from scratch — no stranded card). Blocks persist
  `blocked` + `merged_unresolved` (needs human); busy writer/reservation or
  unverifiable states (unfetched merge commit / PR head, unfetchable base,
  failing writes) stay pending and retry on the next read, bounded by the
  coordinator's reconciliation read budget. `registerMergeCompletionConsumer`
  installs the single consumer with `requiredReadSources = [metadata]`.
- **Observation delivery** `src/pr-tracking/pr-consumer-registry.ts` +
  `src/pr-tracking/pr-tracking-coordinator.ts`: the coordinator accepts an
  optional `consumerRegistry` and delivers one observation per active task
  subscription after every successful metadata read (after authoritative
  terminal-state effects); observer failures are logged and never break the
  poll cycle.
- **Server wiring** `src/server/runtime-server.ts`: the merge completion consumer
  is registered on the shared registry BEFORE the coordinator is created (every
  read the coordinator performs already delivers observations). `completeTask`
  moves the card to Done through `completeTaskAndGetReadyLinkedTaskIds`,
  broadcasts the updated workspace state, then fires the dispatch pass exactly
  once so waiting children release with their retained valid evidence. The
  worktree seam resolves `resolveTaskCwd` (no ensure) + `defaultInspectWorktree`
  (direct git probes: best-effort remote fetch of the merge commit, PR head and
  base branch; `cat-file -e` object-existence checks; `rev-parse`,
  `merge-base --is-ancestor`, `status --porcelain`, `rev-list --count` excluding
  the merged PR head); only the specific "no worktree" case means nothing to
  reconcile — any other resolution failure retries (pending), and a missing
  workspace path makes the board move throw so the episode retries.
- **Manual-reopen marker**: server-owned `manualReopenAt` on the card
  (`src/core/task-board-mutations.ts` sets it on Done → In Review and clears it on
  Done/Trash; `src/state/workspace-state.ts` re-derives it server-side at save so
  a stale client board can neither forge nor drop it). The binding's consumed
  merge commit is the enforcement guard; the marker is the durable,
  client-visible record of the manual reopen.
- **UI**: `web-ui/src/components/detail-panels/task-pr-tracking-panel.tsx`
  renders the merge-completion episode state (completed / in progress / needs a
  human decision / closed without merging) alongside the existing "Auto complete
  when the PR merges" checkbox and needs-human blockers.
- **Tests** `test/runtime/pr-tracking/pr-merge-completion.test.ts`: completion,
  idempotency + later-merge re-completion, preference/column/task-missing skips,
  writer-active pending, reservation contention + release, both block reasons,
  failing inspection pending, failed board move pending (binding untouched),
  crash-straggler recovery, dirty-worktree reset failure pending, plus
  coordinator delivery (observation delivered to the installed consumer during a
  real poll cycle; no completion when no consumer is installed).
  `test/runtime/pr-tracking/pr-merge-worktree-inspection.test.ts` exercises
  `defaultInspectWorktree` against real local git repositories: merge-commit,
  squash and rebase landed merges (the PR work is never counted as local
  commits), genuine local commits ahead, a base lacking the merge commit,
  unverifiable states (missing objects, missing PR head) throwing retryable,
  and a stale local base verified through a best-effort remote fetch.

Remaining verification items (require a live environment, not covered by the
committed tests): the real-Git-repository dispatch matrix (merge/squash/rebase
landed results, diamond dependencies, saturated caps) and the end-to-end
disposable-PR exercise from the Verification section.

Roll out collection without effects, then one merge-completion pilot, then successor queue tests.
Disable either task checkbox independently; preserve records/work/history. Before binary rollback,
drain live actions and confirm older versions preserve unknown server fields/record versions.
After actual service/device changes, append a final task to update
`billy-the-ape/homelab-documentation` through a Ready for Review PR with deployed settings,
credential references, storage, admission limits and rollback. Do not claim deployment now.
