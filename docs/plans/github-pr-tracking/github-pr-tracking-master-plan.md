# GitHub PR tracking foundation — master plan

Updated: 2026-10-06. Status: proposed; documentation only. Repository: `billy-the-ape/kanban`.

## Delivery order and scope

Build this shared foundation first, after landed
[PR-linking contracts](../pr-linking/PR_LINKING_PLAN.md). Then
[comment handling](../pr-comment-handling/pr-comment-handling-master-plan.md) and
[merge tracking](../pr-merge-tracking/pr-merge-tracking-master-plan.md) can be implemented
in parallel: neither depends on the other. All shared contracts and integration gates below
must ship before either consumer; do not leave ownership choices to downstream agents.

This plan owns task preferences/selection, persistence schemas, normalized GitHub collection,
runtime-wide subscription scheduling, polling lifecycle, repair-owner selection and operation
arbitration. It launches no repair, writes no PR, completes no card and dispatches no successor.
Consumer registration is explicit; an enabled checkbox for an uninstalled consumer shows
“Feature unavailable” and does not create API demand. Both checkboxes are available from
the foundation, default false, with unavailable features disabled and explained.

Source inspection baseline: `main` commit `49a2ca05c6c2927da2194aaec8bd1e45e6fa2928`.
Reinspect current source before implementation. PR #49 supplies linking, not live tracking.
The three plans supersede overlapping scope in unmerged
[PR #21](https://github.com/billy-the-ape/kanban/pull/21); do not run both task series.

## Persistence: task authority, shared data and ownership

Define versioned Zod schemas in `src/core/api-contract.ts`; schemas below are distinct.
Use existing atomic JSON persistence and lock helpers, with validated dedicated mutation APIs.
Do not put automation state in SDK sessions or browser localStorage.

| Schema / storage | Identity | Required fields and ownership |
| --- | --- | --- |
| Existing card PR links + task preference fields in board.json | workspaceId + taskId | Existing pullRequests; autoAddressComments/autoFinishOnMerge; selectedAutomationPrKey; settingsRevision. False defaults; server-protected revision-checked mutations |
| TaskPrTrackingRecord, workspace-owned sidecar | workspaceId + taskId + canonicalPrKey + generation | schemaVersion; settingsRevision; observed snapshot version; stop/block reason; terminal observation; terminal-read count; manual-reopen/consumed markers; last check/error. Separate namespaced comment and merge consumer state |
| GitHubPrSnapshot, runtime-wide cache | accessScopeId + canonicalPrKey | schemaVersion; snapshotVersion; checkedAt; PR/head/base identity; state; merge timestamp/SHA; reviews; normalized published feedback/thread versions; per-source completeness; ETags/backoff |
| PrRepairOwnershipRecord, runtime-wide durable registry | canonicalPrKey | owner workspaceId/taskId/link generation; revision; operation/fencing token; live session/process identity; last heartbeat; recovery/transfer status |

Canonical PR key is provider + lowercase host/repository + positive PR number, reused from
PR linking. Retain display casing separately. Task generations are monotonic; reselecting a
previously handled PR cannot erase its historical consumed markers. Access scope identifies
a configured credential/account context by an opaque nonsecret ID; never persist tokens here.
Never reuse cached private data across authorization scopes. Owner identity includes workspace:
task IDs alone are not globally unique.

The card and existing linked PRs are authoritative for association/preferences. Task sidecars
carry durable progress, not independent subscriptions. Shared snapshots are caches, not
first-class schedulable PR jobs. Consumers own namespaced payload schemas under the task record:
comments own batches/cursors/dispositions/budgets; merge owns completion evidence/stages.
Foundation mutators preserve other namespaces and reject stale revisions/generations.
Durable comment ownership protects against switching tasks to escape repair limits: preserve
the PR's budget/disposition handoff on explicit transfer, in addition to each task's history.

Use workspace-local `pr-tracking/tasks/<taskId>.json` sidecars and runtime-state-root
`pr-tracking/cache/` and `pr-tracking/ownership/` directories via existing path helpers.
Encode composite keys with a collision-resistant digest; validate contents against their key
on every load. No host-specific paths, hardcoded usernames or credential files in source.
Malformed or mismatched records block that task and cannot schedule reads. Unsupported record
versions fail visibly without erasure.

At startup enumerate currently managed workspaces/cards first, validate links/preferences,
then join matching records. Never enumerate caches/sidecars to invent workspaces or tasks.
Rebuild the in-memory subscription index solely from eligible current tasks and installed
consumers. Prune dead subscriptions on task deletion, workspace removal, PR unlink/replacement,
column/settings change and runtime disposal; reevaluate all subscriptions before every read.
Orphan sidecars may be cleaned on explicit task deletion, but never launch polling. Retain
completion/history evidence with the task until permanent deletion.

Stop API work immediately when the last eligible subscriber leaves. Delete unused snapshot
caches after 24 hours with zero subscribers; this local cleanup never calls GitHub. Keep terminal
stop markers in task records, so cache expiry cannot restart polling. Remove owner records only
after no live/uncertain operation remains and no task needs their handoff; lost ownership
metadata must block competing repair rather than guess a new owner.

## Runtime-wide observation and authorization

One coordinator per Kanban runtime covers all managed workspaces, not one timer per workspace
or card. One canonical PR with two tasks in different workspaces uses one scheduled/in-flight
read per source when both use the same access scope. Fan out a versioned snapshot to separately
validated task consumers. Demand is the union of installed eligible consumers: metadata for
either, review evidence for merge, feedback/thread reads for comments. Explicit refreshes join
the same in-flight read; source completion is published only after all pages succeed.

Disjoint configured credential scopes require separate authorized reads/caches; never leak
one scope's private data into another. Mutation ownership still keys by PR across scopes.
Multiple separate Kanban processes are outside runtime-wide polling deduplication; they must
not share an automation storage root as concurrent schedulers. Enforce a scheduler lock for
that root and show a blocked startup for a second process; do not claim cross-host protection.

## Task controls and lifecycle gates

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

## Provider adapter and observation

Use the runtime-wide coordinator described above, running with the browser closed.
Poll linked eligible GitHub PRs every 60 seconds, deduplicating API reads by canonical identity
across eligible tasks. Startup and enabling a checkbox reconcile only eligible subscriptions;
these events never restart a stopped terminal subscription by themselves.
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

### Polling eligibility, stop and resume rules

Do not scan all repository PRs or poll every stored link. Maintain task subscriptions only
for the selected Automation PR. Reevaluate eligibility on board moves, checkbox changes,
link selection/removal and each poll; check again before issuing a queued API request.

| Task / selected PR state | Recurring polling |
| --- | --- |
| In Progress or In Review, PR open/draft, at least one checkbox enabled | Every 60 seconds, subject to backoff |
| Merged PR with auto-finish enabled and completion reconciliation pending | Temporarily, only for bounded reconciliation |
| Merged PR already handled, or with no enabled merge-completion consumer | Stop |
| PR closed without merging | Stop |
| Task in Backlog, Done or Trash | Stop |
| Both task checkboxes disabled | Stop |
| No selected eligible PR, unsupported host or ambiguous selection | No PR polling; expose the blocker |

Open/draft PRs remain observable while an agent is working or waiting for model capacity.
Collection does not grant repair execution permission; existing writer/approval gates remain.
Fetch feedback sources only for comment consumers and review evidence for merge consumers.
Once merge/close is confirmed, stop comment collection and cancel pending repair batches.
A comment-only task needs no further recurring reads after its PR becomes terminal.

Persist terminal observation and subscription stop reason so restart cannot rearm them.
Merged completion reconciliation is not indefinite polling: reuse authoritative stored evidence
for local preservation/board/dispatch stages. If additional remote evidence is necessary,
allow at most three reconciliation reads per terminal episode with normal backoff, then
stop and expose a needs-human reason. Missing qualifying review, unsafe local work or another
manual blocker stops immediately; it must not spend API requests indefinitely. API failures
before terminal state is established remain under ordinary backoff, never a fabricated terminal
stop. Stopping observation retains pending evidence, receipts and history.

Done → In Review for history never resumes observation of the same handled merged PR.
Explicit **Resume PR tracking** may request a fresh one-time reconciliation for a stopped
subscription; recurring polling resumes only if that read confirms an open/draft PR and
the task/checkbox eligibility still holds. This supports detecting an externally reopened PR
without periodic reads of closed PRs. Selecting a genuinely new linked Automation PR starts
a new eligible subscription. Returning an otherwise eligible nonterminal card to an active
column can resume its subscription. Checkbox off/on, restart or ordinary history inspection
must not clear a terminal stop or a consumed completion generation. Explicit tracking resume
does not reset repair budgets or authorize duplicate completion/successor dispatch.

Cancel scheduled reads when their last eligible consumer disappears. For a PR shared by
several cards, remove only that card's subscription; keep deduplicated reads while another
card remains eligible. In-flight responses must revalidate each consumer before applying
state or scheduling effects. Retained snapshots may be displayed without resuming polling.

### Several linked PRs

PR linking permits many links, including cross-repository links. If exactly one link matches
the task's repository and actual delivery/head branch, select it automatically. Otherwise
require an explicit **Automation PR** choice from linked PRs and show an ambiguity blocker.
One selected PR drives both controls; other links remain historical/reference links.
Never finish because an unrelated or older linked PR merged. Validate manual selection against
the task's delivery/worktree branch; cross-repository reference PRs cannot authorize repair or
handoff. On replacement/removal, invalidate pending work and require reconciliation. A genuinely
new selected PR starts a new completion generation; the same PR never rearms by toggling settings.


## One automatic repair owner and mutation arbitration

If exactly one valid task enables comments for a PR with no owner, atomically assign that task.
If multiple tasks compete before assignment, block automatic repair on all of them with
“Choose repair owner”; do not choose by poll timing, backlog order or task ID. Provide a
revision-checked **Repair owner** selector listing linked tasks with workspace labels.
The chosen task must select this PR and have a verified writable head mapping.

Once assigned, retain ownership until explicit transfer/release. Other tasks may observe the
same PR and independently finish on merge; their comment control displays “Repairs owned by
<workspace/task>” and never collects actionable batches or launches a second repair.
Owner disable/pause/trash/unlink stops its work but does not automatically transfer authority.
Deletion/removal of the owner makes remaining candidates blocked until explicit reassignment.
Do not copy one task's approved specification into another task silently.

Transfer requires both tasks' intents invalidated, all running/queued writer actions drained,
and any ambiguous commit/push reconciled. Persist the new fencing generation and transfer
handoff atomically; carry addressed event versions and spent lifecycle budget forward, then
reassess pending feedback under the new task specification. Transfer does not itself authorize
scope changes, a repair turn or budget reset. A lease timeout alone cannot grant ownership:
verify prior process/session exit and remote side effects first; otherwise needs-human.

Foundation operation gates must integrate with existing task writer/review/verification/
delivery/manual Git starts before consumers ship. Acquire task ownership and shared PR/head
branch ownership in a documented fixed lock order. A PR gate is keyed by canonical PR; a
remote write gate is keyed by canonical head repository + ref, also preventing distinct PRs
on the same branch from writing concurrently. Do not hold filesystem mutexes while waiting
for model slots or network I/O; persist fenced intent reservations instead.

Only the repair owner may claim an automatic repair reservation. Its reservation covers queue
admission through verified publication/reconciliation. Existing activity on any linked task
sharing the write target blocks admission; conflicting manual activity gets an explicit busy
result or safe cancellation/drain, never simultaneous writes. External tools outside Kanban
cannot be locked; consumers must compare remote/local state and stop on drift.

Observed merge/close centrally invalidates queued write intents and prevents new admissions.
Request safe cancellation of live tracked operations, preserving unpublished work. Merge
consumers use the shared gate to wait for verified quiescence; they never call a comment-service
API. Confirming terminal state does not require the merge feature to be installed. Return to
Review remains a consumer action after the gate confirms its own operation ended.

## Stable consumer API and parallel implementation boundaries

Freeze these domain operations and their input/result schemas in FOUNDATION-1:

- registerConsumer(kind, capabilities) / unregisterConsumer: explicit runtime capability and
  required read sources; subscriptions remain task-derived.
- getTaskTrackingState / updateTaskPrSettings / selectAutomationPr / resumePrTracking:
  revision-checked settings, selection, diagnostics and one-shot terminal resume.
- getAuthorizedSnapshot / refreshSnapshot: access-scoped versioned normalized data with
  freshness/completeness; refresh coalesces through the coordinator.
- mutateConsumerState(kind, expectedRevision, generation): atomic namespaced sidecar mutation
  preserving other consumers.
- selectRepairOwner / transferRepairOwner: validated explicit durable assignment and handoff.
- reservePrOperation / validateReservation / releasePrOperation: fenced task/PR/head ownership,
  busy/blocked/stale outcomes, cancellation and reconciliation.
- subscribeTaskSnapshot / subscribeTerminalInvalidation: versioned notifications plus durable
  replay cursors; events are hints, consumers reconcile authoritative state on startup.

No feature imports the other's implementation. Comments consume normalized feedback, gates,
their own task namespace and existing session/verification/delivery APIs. Merge consumes
normalized merge/review evidence, gates, its own namespace and existing completion/dispatch APIs.
Feature startup independently registers its consumer and resumes its own safe records.

Shared lifecycle arbitration ships here: when either installed enabled consumer owns a linked
PR workflow, legacy automatic clean-tree/PR-delivery completion cannot run. Manual completion
retains existing safeguards. Merge records a manual-reopen/consumed generation through shared
mutators; comments simply obey that gate. Reserved comment operations and merge completion
cannot overlap. Consumers can ship in either order and remain disabled independently.

Treat adapter schemas and foundation files as owned by this plan. Downstream implementations
add their consumer modules/namespace schemas and targeted existing API integrations, not new
pollers, settings plumbing or ownership primitives. Any necessary shared contract change is
a prerequisite foundation follow-up, not a hidden dependency on the other feature.

## Implementation slices and acceptance

| ID | Scope | Depends on | Completion evidence |
| --- | --- | --- | --- |
| FOUNDATION-0 | Versioned records, server-owned preferences/selection, runtime-wide observer and task-derived subscriptions | Landed PR-linking contracts | Cross-workspace one-read collection, pagination, stop/resume and orphan safety |
| FOUNDATION-1 | Durable repair-owner selection/transfer, write gates, stable consumer API, lifecycle arbitration and UI diagnostics | FOUNDATION-0 + existing task lifecycle APIs | Two-task contention, crash recovery, no competing writers, independently registered fake consumers |

Both slices must land before either feature series starts. This replaces former MERGE-0;
do not execute both IDs. Then COMMENT-0 → COMMENT-1 and MERGE-1 → MERGE-2 proceed in parallel.
The total is six implementation slices, with no breakout cards created by this plan.

Required foundation tests:

- One PR on two tasks across workspaces: one metadata request/page sequence per access scope,
  shared in-flight refresh, independently versioned task state; distinct scopes cannot leak data.
- Cache/sidecar with no live task, corrupt key/generation, deleted workspace, stale board save,
  last subscriber removal during an in-flight read: no orphan polling or stale state effects.
- Eligibility table, terminal limits, restart, history reopen, cache expiry and explicit resume;
  zero recurring reads in stopped states and no resets of consumed markers.
- Two comment candidates: ambiguity blocks; explicit owner alone can reserve; restart retains
  owner; disable/removal cannot hand off silently; transfer preserves budgets/dispositions.
- PR and shared-head locks: competing writers/reviews/delivery/manual actions, queued cancellation,
  lease expiry with unknown live process, stale fencing and lost push response; no unsafe takeover.
- Merge consumer alone, comment consumer alone, both, neither: no unresolved feature dependency;
  terminal cancellation and legacy Auto PR/clean-tree gates work before either real consumer ships.

Run focused backend/UI tests, typechecks, Biome for supported changed files and required CI.
Use isolated HOME/USERPROFILE and sanitized Git subprocess environments. Foundation acceptance
uses fake consumers/providers; feature-specific end-to-end pilots remain in their own plans.

## Rollout, deployment and documentation

Planning only; no deployment, new environment variables or dependencies. Foundation introduces
optional false-default card settings and versioned records; document storage upgrade, auth
sources/read permissions, locking, unavailable-consumer UI and rollback in implementation PRs.
No inbound listener, webhook server or credentials from chat OAuth are assumed.

Start collection with fake/inspect-only consumers, validate orphan cleanup and multi-workspace
deduplication, then enable each installed feature on its own pilot. Drain operations before
rollback and preserve newer unknown fields/record versions. After actual service/device changes,
append the operational task: update `billy-the-ape/homelab-documentation` through a Ready for
Review PR with actual storage/config/auth references, concurrency behavior and rollback.
