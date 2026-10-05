# PR merge tracking — master plan

Updated: 2026-10-05. Status: proposed; documentation only. Repository: `billy-the-ape/kanban`.

## Goal and feature split

Observe linked GitHub PRs in the backend, finish opted-in tasks after a reviewed PR merges,
and release linked successor tasks against the merged code. Preserve manual Done → In Review
movement for history inspection without repeating completion or successor launches.

Implement two independently selectable features sharing one backend observer:

- **PR merge tracking** (this plan): collection, task settings, merge completion and successor handoff.
- **[PR comment handling](../pr-comment-handling/pr-comment-handling-master-plan.md)**:
  debounced feedback batches and bounded repairs using the same observer.

Merge tracking is the smaller deterministic feature and should ship first. Comment handling
depends on shared collection, not on enabling merge completion. Neither feature merges PRs.

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
  feedback/repair proposal. These two plans supersede its overlapping monitoring, repair and
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

## Task controls and ownership

| Checkbox | Persisted field | Default | Behavior |
| --- | --- | --- | --- |
| Auto address comments | `autoAddressComments` | false | Enables the companion feedback workflow |
| Auto finish on merge | `autoFinishOnMerge` | false | Enables reviewed-merge completion |

Both controls are independent booleans visible in task create/edit and detail settings,
editable throughout In Progress and In Review, including queued tasks. Keep enabled choices
when no PR exists; show “Waiting for linked PR.” They activate once an eligible PR is linked.
Old cards with missing fields behave as false; no bulk enable or session restart required.
Allow saving these preferences during a running turn without restarting that turn.

Use a dedicated revision-checked task-settings mutation. Preserve server-owned links,
snapshots, automation records and settings against unrelated stale whole-board saves.
Store progress/counters in backend records, not client localStorage or session summaries.
Toggle changes and PR removal invalidate queued intents; revalidate at execution time.

When auto-finish is enabled, PR creation/push and a clean worktree mean In Review, never Done.
Comment repair alone also leaves the task In Review until manual completion or opted-in merge
completion. Prevent browser, CLI and deterministic delivery automation from competing with
this lifecycle. Explicit manual completion remains available with existing safeguards.

## Shared observer contract (MERGE-0)

Create one runtime-owned service per managed workspace, running with the browser closed.
Poll linked eligible GitHub PRs every 60 seconds, deduplicating API reads by canonical identity
across tasks; startup and enabling a checkbox request an immediate reconciliation.
Use PR-linking identity (`provider`, `host`, repository, number) as the authoritative key.
Never infer association from title, current branch name or the latest UI link alone.

First release supports github.com. Other provider/host links stay visible but report
“Automation unsupported”; never send a GitHub credential to an arbitrary linked host.
Reuse explicitly configured runtime authentication through a backend adapter (existing
noninteractive gh/API facilities where suitable). This chat's OAuth does not authenticate
the installed Kanban service. Missing access must show a blocked state, not silent success.
Read PR metadata, submitted reviews, conversation comments and inline review threads with
complete pagination. Pending unpublished reviews are not feedback. Expose normalized snapshots
and versioned events to both consumers; the observer itself never starts an agent or moves cards.

Persist metadata: PR head SHA, head/base repository and ref, open/closed/draft/merged status,
merged timestamp, merge commit SHA, review evidence and checked-at time. Persist feedback IDs,
versions/digests and thread resolution for the companion feature. UI snapshots are labelled
as of a time; destructive lifecycle decisions require a successful fresh authoritative read.
Use conditional reads, bounded timeouts, jitter and rate-limit/Retry-After backoff. Authentication,
404/access ambiguity, network and partial-page failures retain last state and pause decisions.
Do not treat missing/failed API data as closed or merged. Record timestamps and sanitized errors.

Task records contain schema version, settings revision, selected automation PR, collection
cursors, blocked reason, pending intent, and durable completion/reopen markers. Shared snapshots
can be cached by PR; task consumption remains separately owned. Restart reconciliation and
per-task leases prevent duplicate effects. Do not hold workspace locks during network calls.
Apply the fetched result only after rereading task settings, linkage and current revision.

### Several linked PRs

PR linking permits many links, including cross-repository links. If exactly one link matches
the task's repository and actual delivery/head branch, select it automatically. Otherwise
require an explicit **Automation PR** choice from linked PRs and show an ambiguity blocker.
One selected PR drives both controls; other links remain historical/reference links.
Never finish because an unrelated or older linked PR merged. Validate manual selection against
the task's delivery/worktree branch; cross-repository reference PRs cannot authorize repair or
handoff. On replacement/removal, invalidate pending work and require reconciliation. A genuinely
new selected PR starts a new completion generation; the same PR never rearms by toggling settings.

## Merge completion (MERGE-1)

1. Freshly confirm the selected PR is merged; closed-unmerged and draft/open remain In Review.
2. Require qualifying submitted review evidence on the final pre-merge head SHA. Reuse an
   existing trustworthy review receipt where available; otherwise require a GitHub APPROVED
   review on that SHA by a non-author reviewer, not dismissed, with no unresolved current
   CHANGES_REQUESTED review. Allow a configured trusted reviewer bot; self-approval, comments,
   stale approval and a model's completion claim do not qualify. Persist exact evidence IDs/SHA.
   A merge without qualifying review remains blocked for manual inspection: preserve the
   established rule that unreviewed work must never become automatically Done.
3. Cancel undispatched feedback intents. If a task writer, verification or delivery is live,
   prevent new writes and request orderly stop through the existing lifecycle. Reconcile and
   preserve dirty/untracked or unpublished work before completing. Uncertain side effects
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
| MERGE-0 | Shared observer, durable settings/records, both controls and PR selection; no effects | Landed PR-linking contracts | Browser-closed collection, pagination, restart and stale-save safety |
| MERGE-1 | Reviewed merge receipt, completion ownership and delivery-auto-Done arbitration | MERGE-0 | Exactly-once reviewed completion; errors and unsafe work block |
| MERGE-2 | Backend successor integration, merged baseline and manual reopen suppression | MERGE-1 | Fresh squash/rebase-safe handoff, queueing and Done → Review history |

## Verification

- Fake-provider tests: pagination, duplicate/out-of-order snapshots, backoff, auth/404 failure,
  stale settings/link changes, multiple links, unsupported hosts and service restart.
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
Implementation adds optional card booleans and versioned backend records with false defaults.
Use existing runtime config conventions for proposed 60-second polling and trusted-bot policy;
document final names, storage and authenticated API permissions in implementation PRs. Merge
tracking requires read access; repair later requires push access. No inbound ports or new hub.

Roll out collection without effects, then one reviewed-merge pilot, then successor queue tests.
Disable either task checkbox independently; preserve records/work/history. Before binary rollback,
drain live actions and confirm older versions preserve unknown server fields/record versions.
After actual service/device changes, append a final task to update
`billy-the-ape/homelab-documentation` through a Ready for Review PR with deployed settings,
credential references, storage, admission limits and rollback. Do not claim deployment now.
