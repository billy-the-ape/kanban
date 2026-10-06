# PR merge tracking — master plan

Updated: 2026-10-06. Status: proposed; documentation only. Repository: `billy-the-ape/kanban`.

## Goal and independent feature boundary

Finish opted-in tasks after a reviewed linked PR merges, then release linked successor tasks
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

The foundation owns card preferences, selected Automation PR, durable task tracking records,
shared authorized snapshots, runtime-wide polling subscriptions and operation gates. Do not
implement those again here. Register the merge consumer, requesting metadata/review sources,
and use its revision-checked task namespace for completion receipts/stages.

Auto finish on merge remains false by default and editable in In Progress/In Review.
The foundation prevents legacy PR-delivery/clean-tree automatic Done while this workflow is
enabled. This feature owns reviewed completion, successor dispatch and historical reopening.
Observe the foundation's polling stop/resume table and bounded terminal reconciliation;
never add a feature timer or a completion retry loop that extends terminal API reads.

When one PR belongs to multiple tasks, each eligible merge consumer may finish its own card
using its own validated specification/linkage and evidence; completion/dispatch receipts remain
task-scoped. Reuse the shared PR quiescence gate so neither card completes while any tracked
writer on that head has unresolved work. This does not grant either task repair ownership.

## Merge completion (MERGE-1)

1. Freshly confirm the selected PR is merged; closed-unmerged and draft/open remain In Review.
2. Require qualifying submitted review evidence on the final pre-merge head SHA. Reuse an
   existing trustworthy review receipt where available; otherwise require a GitHub APPROVED
   review on that SHA by a non-author reviewer, not dismissed, with no unresolved current
   CHANGES_REQUESTED review. Allow a configured trusted reviewer bot; self-approval, comments,
   stale approval and a model's completion claim do not qualify. Persist exact evidence IDs/SHA.
   A merge without qualifying review remains blocked for manual inspection: preserve the
   established rule that unreviewed work must never become automatically Done.
3. Consume foundation terminal invalidation and acquire its quiescence gate. The foundation
   cancels undispatched write intents, prevents new writes and requests orderly safe stop of
   tracked task writers, verification and delivery, even with no comment consumer installed.
   Reconcile and preserve dirty/untracked or unpublished work before completing. Uncertain side effects
   or post-merge edits block for manual handling; never force-clean the worktree.
4. Persist a completion receipt containing task/workspace/repository identity, selected PR,
   final head, reviewed evidence, merge/base identity, merge SHA, timestamp and generation.
5. Apply a revision-checked board transition through existing completion/preservation APIs,
   broadcast the updated board, then request the backend dispatch pass. Persist effect stages
   so restart after receipt, board movement or dispatch cannot lose or repeat the transition.

Recheck checkbox, selected PR, task generation and column immediately before mutation. No auto
completion from Backlog, Trash or a manually reopened historical card. Disable blocks pending
completion without discarding evidence. Enabling on an already merged PR can complete after
all gates pass, except a previously consumed/reopened generation. No automatic GitHub merge,
review submission or branch deletion is introduced.

## Successor handoff and history (MERGE-2)

Extend B-9 readiness to accept explicit reviewed-merge completion receipts while retaining
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
merged PR cannot immediately send it back to Done. Reopening must not reset repair budgets,
replay Auto PR, start an agent or trigger already-dispatched successors. Already running children
are unaffected; children not yet dispatched wait while the prerequisite is back in Review.
Moving it manually to Done may release waiting children once, using retained valid evidence.
History inspection must not trigger base-refresh or delivery side effects. Preserve existing
worktree recovery where needed for detail access.

## Implementation slices

Each row is one implementation PR/card; all are planned and unchecked. No additional breakout
files or cards are created by this document. Reinspect the latest source and list concrete
changes, validation and deployment requirements in every implementation PR.

| ID | Scope | Depends on | Acceptance |
| --- | --- | --- | --- |
| MERGE-1 | Reviewed merge receipt and completion using foundation gates | FOUNDATION-0 + FOUNDATION-1 | Exactly-once reviewed completion; errors and unsafe work block |
| MERGE-2 | Backend successor integration, merged baseline and manual reopen suppression | MERGE-1 | Fresh squash/rebase-safe handoff, queueing and Done → Review history |

The old MERGE-0 shared slice is replaced by the separate foundation plan. Neither merge slice
requires COMMENT-0/COMMENT-1. Merge standalone qualification must pass with no comment consumer.

## Verification

- Foundation contract integration: merge consumer alone and alongside a fake comment consumer;
  task-scoped completion for two tasks sharing a PR; terminal observation cannot race a shared
  head writer or exceed read limits; stopped subscriptions remain stopped after history reopen.
- Lifecycle tests: open/draft/closed-unmerged vs merged; final-SHA approval, stale/dismissed/self
  approval and unresolved change requests; live/dirty task; toggle-off race; duplicate polls;
  crash at each receipt/move/dispatch boundary; no early Done after PR delivery or clean tree.
- Dispatch tests with real temporary Git repositories: merge, squash and rebase landed results;
  stale/pre-created and dirty worktrees; fetch failure and incompatible base; diamond dependencies;
  one durable launch; manual deferral; saturated model and worker caps; cancel queued successor.
- UI/API tests: independent editable checkboxes in both active columns; stale board saves;
  no-PR/ambiguous/unsupported/blocked reasons; Done → Review survives polling/restart without
  bounce, duplicate PR prompt, hidden agent startup or repeated child launch.
- End-to-end disposable PR: enable merge tracking, publish a reviewed PR, leave the browser
  closed, merge externally, confirm Done and successor running/queued on the merged baseline.
  Reopen parent to inspect history and restart the runtime; it stays In Review.

Isolate HOME/USERPROFILE and use the repository Git test environment helper for subprocesses.
Run focused backend/UI tests, backend/web typechecks, Biome on changed supported files and
required CI. Scripted fixtures prove lifecycle plumbing, not model review quality.

## Rollout, deployment and documentation

This PR is planning only: no environment variables, dependencies, migration or deployment.
The foundation supplies false-default settings, records, 60-second polling and runtime auth.
Merge implementation adds only its consumer namespace/receipt schema and completion/handoff
behavior. Document final trusted-reviewer policy, storage upgrades and deployment/rollback in
implementation PRs. Merge tracking requires read access and no PR push permission.

Roll out collection without effects, then one reviewed-merge pilot, then successor queue tests.
Disable either task checkbox independently; preserve records/work/history. Before binary rollback,
drain live actions and confirm older versions preserve unknown server fields/record versions.
After actual service/device changes, append a final task to update
`billy-the-ape/homelab-documentation` through a Ready for Review PR with deployed settings,
credential references, storage, admission limits and rollback. Do not claim deployment now.
