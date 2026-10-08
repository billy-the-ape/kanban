# PRTRACK-1 — FOUNDATION-1: task preferences, live subscriptions, owners/reservations, consumer API, lifecycle gates

Part of the **GitHub PR tracking foundation** feature. The master plan lives in
[github-pr-tracking-master-plan.md](./github-pr-tracking-master-plan.md). This document is a
self-contained execution brief for the second implementation PR (slice **FOUNDATION-1**). It
represents a single PR.

| Field | Value |
| --- | --- |
| Document revision | 3 |
| Prepared | 2026-10-06 |
| Status | implemented in this worktree (branch targets `feat/pr-tracking-base`) |
| Source baseline | 49a2ca05c6c2927da2194aaec8bd1e45e6fa2928 (main) |
| Fork | https://github.com/billy-the-ape/kanban |
| Prerequisites | PRTRACK-0 (FOUNDATION-0) landed: record store, gh adapter, read-only coordinator; PR #49 PR-linking contracts landed (through PRTRACK-0's prerequisite) |
| Follow-on | COMMENT-0 and MERGE-1 proceed independently and in parallel from their own plan folders after this PR lands |

As the master plan states, this plan (with the comment and merge plans) supersedes overlapping
scope in unmerged PR #21 — do not run both task series.

## Purpose

Wire the read-only foundation into real tasks and freeze the stable consumer API that the
comment-handling and merge-tracking features will build on:

1. The two independent task preferences — **Auto address comments**
   (`autoAddressComments`) and **Auto complete task when PR is merged**
   (`autoFinishOnMerge`) — default false, persisted server-side, editable through a
   dedicated revision-checked mutation, visible in task create/edit and detail settings.
2. Live task-derived subscriptions replacing PRTRACK-0's fake subscriptions: the coordinator's
   demand comes from real cards, reevaluated on board moves, checkbox changes, link
   selection/removal, and every poll.
3. Durable repair-owner selection/transfer and fenced operation reservations
   (`reservePrOperation` / `validateReservation` / `releasePrOperation`) with the fixed
   lock order and gate keys.
4. The frozen consumer API: `registerConsumer`/`unregisterConsumer`, settings/selection/resume
   operations, snapshot read/refresh, PR record mutators, and versioned subscriptions with
   durable replay cursors.
5. Shared lifecycle gates so browser, CLI, and deterministic delivery automation never compete
   with the PR-driven lifecycle; legacy premature Done is gated behind consumer ownership.

Consumer registration is **explicit**; the two real feature consumers stay unregistered in this
PR (fake consumers in tests). Terminology used throughout: a checkbox is **enabled** when it
is persisted true on the card, and **disabled** when it is non-interactive because its
consumer is not installed. An enabled checkbox for an uninstalled consumer shows "Feature
unavailable" and creates no API demand.

## Fixed decisions carried in from the master plan

- Both controls are independent booleans, default false. Old cards with missing fields behave as
  false; no bulk enable or session restart. Saving preferences is allowed during a running turn
  without restarting that turn; toggle changes and PR removal invalidate queued intents,
  revalidated at execution time.
- Confirmed merge is acceptance for `autoFinishOnMerge` — no review/approval, CI,
  thread-resolution, or human-merger gate. Off means manual completion.
- One selected **Automation PR** drives both controls; other links stay historical. If exactly
  one link matches the task's repository and actual delivery/head branch, select it
  automatically; otherwise require an explicit choice and show an ambiguity blocker. Never finish
  because an unrelated or older linked PR merged. Cross-repository reference PRs cannot
  authorize repair or handoff. A genuinely new selected PR starts a new completion generation;
  the same PR never rearms by toggling settings.
- One automatic repair owner per PR. Exactly one valid task enables comments with no owner →
  atomic assignment. Multiple candidates → block all with "Choose repair owner"; never choose by
  poll timing, backlog order, or task ID. Owner is retained until explicit transfer or release
  (release = `transferRepairOwner` to none, with the same drain/invalidate/reconcile
  preconditions as transfer); owner disable/pause/trash/unlink stops its work but never
  transfers authority; owner deletion blocks remaining candidates until explicit reassignment.
- Mutation arbitration: PR gate keyed by canonical PR; remote write gate keyed by canonical
  head repository + ref (also preventing distinct PRs on the same branch from writing
  concurrently). Gates are durable fenced intent reservations persisted in the PR record —
  no separate filesystem gate mutexes are held while awaiting model slots or network I/O.
  Gate acquire/validate/release and durable-reservation revalidation are short CAS operations
  under the single tracking-registry mutex, taken immediately before execution. Nesting is
  one-way only (refining the master's blanket "never nest registry and task locks"): task
  ownership or a held gate may be followed by a registry CAS (task/gates → registry
  permitted); the registry mutex is never held while acquiring a task or Git lock or while
  awaiting model/network work (registry → task/Git never). Because the head-ref gate spans
  distinct PRs but reservations live in per-PR records, acquiring it validates under the
  single global registry mutex every record whose head mapping matches the same canonical
  head repository + ref, serializing sibling records on the gate. Fixed acquisition order:
  task ownership → PR gate → head-ref gate (each gate acquisition is itself a registry CAS).
  Observed merge/close centrally invalidates queued write intents, blocks new admissions, and
  requests safe cancellation of live tracked operations. Replacing or removing the selected PR
  invalidates pending work and requires reconciliation before any further action.
- The completion label is **Auto complete task when PR is merged**; the persisted field stays
  `autoFinishOnMerge`.
- First comment support is native Cline only; other task agents show comments unsupported but
  may use provider-independent merge completion.

## Scope

Allowed:

- `src/core/api-contract.ts` — task preference fields on the board card
  (`autoAddressComments`, `autoFinishOnMerge`, `selectedAutomationPrKey`, `settingsRevision`),
  the consumer API request/response schemas, tracking-state diagnostic and subscription event
  types
- `src/core/task-board-mutations.ts` — the dedicated revision-checked task-settings mutation and
  server-owned preservation of these fields against stale whole-board saves
- `src/state/workspace-state.ts` — server-owned field carry-forward in `saveWorkspaceState`
  (same pattern as the server-owned `pullRequests` field from PR linking)
- `src/pr-tracking/` — live task-derived subscription reconciliation, owner selection/transfer,
  operation reservations, consumer registry, lifecycle gate hooks
- `src/trpc/workspace-api.ts`, `src/trpc/runtime-api.ts`, `src/trpc/app-router.ts` — the consumer
  API endpoints (settings, selection, resume, snapshot, mutators, owner, reservations,
  subscriptions) and task tracking-state diagnostics
- `src/cline-sdk/cline-task-session-service.ts` — turn ownership/liveness/continuation references
  for reservation admission and safe cancellation (existing session references only, no copied
  execution history)
- `src/task-dispatch/task-dispatch-service.ts` — worker policy/readiness integration for the
  shared lifecycle gates
- `src/workspace/git-delivery.ts` — gate the deterministic delivery completion path (legacy
  clean-tree/PR-delivery completion) behind the shared lifecycle arbitration
- `src/commands/task.ts` — gate the CLI completion path (`completeTaskById` /
  `completeTaskAndGetReadyLinkedTaskIds`) behind the shared lifecycle arbitration
- `src/verification/verification-service.ts` — reserve verification starts against durable
  reservations so verification never races a reserved write target
- `src/server/runtime-server.ts` / `src/server/workspace-registry.ts` — coordinator start/stop,
  workspace-removal and runtime-disposal reconciliation hooks, and the consumer-registry
  lifecycle
- `web-ui/` — task create/edit and detail settings checkboxes, "Waiting for linked PR",
  "Feature unavailable"/"comments unsupported"/"Automation unsupported" disabled states,
  auth-blocker display, ambiguity blocker, repair-owner selector, Resume PR tracking,
  snapshot as-of labelling, and blocker surfaces in the existing detail warning/status areas;
  plus the gate in `web-ui/src/hooks/use-review-auto-actions.ts` that keeps legacy premature
  Done from completing a task whose linked PR workflow is owned by an installed enabled
  consumer
- Tests under `test/` and `web-ui` hook/component tests

Explicit non-goals:

- No real comment-handling or merge-tracking consumer (COMMENT-0 / MERGE-1)
- No launching repair turns, posting PR comments, completing cards on merge, or dispatching
  successors — this PR ships the gates and API only
- No changes to the PR record storage format beyond PRTRACK-0's schema (it already contains the
  comment block, merge binding, and reservation blocks)
- No new dependencies, environment variables, or inbound listeners

## Source map (reinspect before editing; baseline is historical)

- `src/core/api-contract.ts` — `runtimeBoardCardSchema` is a `z.object({...}).transform(...)`;
  new optional fields pass through the transform untouched. Keep every new card field
  **optional** — `web-ui/src/runtime/types.ts` re-exports the contract, and a required field
  crashes uncast test mocks (`as unknown as RuntimeBoardCard`) at render time. Grep web-ui for
  mock card factories after the change.
- `src/state/workspace-state.ts` — `saveWorkspaceState` writes the client-supplied board
  wholesale; add server-owned carry-forward for the new preference fields the way the
  PR-linking `pullRequests` field does. `mutateWorkspaceState` returns a response object, not a
  board.
- `src/core/task-board-mutations.ts` — pure mutation functions returning result objects
  (`{ moved, board, task, ... }`); a common bug is passing the result where a board is expected
  and failing zod validation on the next read.
- `src/server/runtime-server.ts` / `src/server/workspace-registry.ts` — coordinator start/stop;
  this PR replaces its fake-subscription demand with task-derived subscriptions.
- `src/cline-sdk/cline-task-session-service.ts` — existing turn ownership/liveness/continuation
  primitives to reference, not re-derive.
- `src/workspace/git-delivery.ts` — existing deterministic delivery completion path that the
  shared lifecycle gate must gate (legacy clean-tree/PR-delivery completion).
- `src/task-dispatch/task-dispatch-service.ts` — automated completion/dispatch paths the gate
  must cover.
- `src/commands/task.ts` — CLI completion entry points (`completeTaskById` /
  `completeTaskAndGetReadyLinkedTaskIds`); the shared lifecycle gate must also block CLI-driven
  completion of tasks whose linked PR workflow is owned by an installed enabled consumer.
- `src/verification/verification-service.ts` — verification runner
  (`VerificationService`/`createVerificationRunner`); reserve verification starts against
  durable reservations so verification never races a reserved write target.
- `web-ui/src/hooks/use-review-auto-actions.ts` — legacy premature Done; must be gated so
  browser automation cannot complete a task whose linked PR workflow is owned by an installed
  enabled consumer.
- `web-ui/src/state/drag-rules.ts` — preserved Done → Review movement; manual completion
  keeps its existing safeguards.
- `src/fs/locked-file-system.ts` — distinct locks need distinct `path` values (proper-lockfile
  keys its in-process map by `path`, not the lockfile name).

## Implementation tasks (in this order)

- [x] PRTRACK-1.1 **Revision-checked preference and selection APIs.** Add
      `autoAddressComments`, `autoFinishOnMerge`, `selectedAutomationPrKey`, and
      `settingsRevision` to the board card contract (all optional; absent reads as false /
      unset). Implement a dedicated revision-checked task-settings mutation through
      `task-board-mutations.ts` + trpc that preserves server-owned links, snapshots, automation
      records, and settings against unrelated stale whole-board saves (server-owned carry-forward
      in `saveWorkspaceState`, same pattern as `pullRequests`). Add `updateTaskPrSettings`,
      `selectAutomationPr` (auto-select when exactly one link matches the task's repository and
      actual delivery/head branch; otherwise explicit choice with ambiguity blocker; manual
      selection validated against the task's delivery/worktree branch), `resumePrTracking`
      (one-shot fresh reconciliation for a stopped subscription; never clears dispatch
      failure/deduplication or authorizes duplicate completion), and `getTaskTrackingState`
      (revision-checked diagnostics: eligibility, blockers, owner, reservation, snapshot
      freshness, and installed consumers/capabilities per consumer kind plus per-task agent
      support — the signal the UI's "Feature unavailable"/"comments unsupported" states
      read). If the installed-consumer list is carried in `RuntimeConfigResponse`, remember
      the `as unknown as` mock trap (uncast test mocks bypass tsc and crash at render time).
      No selected-PR tracking state in browser localStorage.
- [x] PRTRACK-1.2 **Consumer registry and frozen API surface.** Implement
      `registerConsumer(kind, capabilities)` / `unregisterConsumer` with per-consumer required
      read sources — demand rule: both consumers request metadata; only the comment consumer
      requests feedback/review/thread reads; a comment-only task needs no further recurring
      reads once its PR is terminal. Add the snapshot endpoints `getAuthorizedSnapshot` /
      `refreshSnapshot` (access-scoped versioned normalized data, refresh coalesced through
      the coordinator) and the two record mutators `updatePrCommentDispatch` /
      `updateTaskMergeBinding` (revision-checked updates inside the PR record that preserve
      other fields/bindings; no generic sidecar workflow store). Add `subscribeTaskSnapshot` /
      `subscribeTerminalInvalidation` with durable replay cursors persisted per consumer kind
      on each task binding in the PR record; events are hints and consumers reconcile
      authoritative state on startup. This registry is the "installed consumers" input for
      1.3 and must land before it.
- [x] PRTRACK-1.3 **Live task-derived subscriptions.** Replace PRTRACK-0's fake subscriptions
      as the production demand source (they remain the test seam for the coordinator suites —
      do not delete the PRTRACK-0 tests): on startup enumerate current managed workspaces/cards,
      validate links/preferences, join
      matching PR records, and rebuild the in-memory index solely from eligible current tasks
      and installed consumers. Reconcile live on board moves, checkbox changes, link
      selection/removal, workspace removal, and runtime disposal; reevaluate before every read.
      Prune subscriptions on deletion, workspace removal, unlink/replacement, and column/
      settings changes; stop API work when the last eligible subscriber leaves; drop transient
      feedback snapshots immediately when their last subscriber leaves without calling GitHub.
      Retain the minimal PR record while any current task links it (including inactive/history
      cards) so terminal/fingerprint markers survive. Reading cards from other workspaces'
      boards must not hold a workspace lock across any network call. A fetched result is
      applied only after rereading task settings, linkage, and current revision; in-flight
      responses revalidate each consumer before applying state or scheduling effects.
- [x] PRTRACK-1.4 **Owner selection, transfer, and reservations.** Durable repair-owner
      selection: exactly-one-candidate atomic assignment; multi-candidate "Choose repair owner"
      ambiguity block; revision-checked **Repair owner** selector listing linked tasks with
      workspace labels; owner validity requires the task selects this PR and has a verified
      writable head mapping. Ownership persists until explicit transfer/release; disable/pause/
      trash/unlink never transfers; deletion blocks remaining candidates. Transfer requires both
      tasks' intents invalidated, running/queued writer actions drained, and ambiguous
      commit/push reconciled; persist the new fencing generation and transfer handoff atomically
      in the same PR record; retain pending/last-dispatched fingerprints and failure status;
      pending feedback is reassessed under the new task's specification, and one task's
      approved specification is never silently copied into another; transfer never
      authorizes scope changes, a repair turn, or replay of dispatched feedback. Replacing or
      removing the selected PR invalidates pending work and requires reconciliation.
      A lease timeout alone cannot grant ownership: verify prior process/session exit and remote
      side effects first, otherwise needs-human.
      Fenced operation reservations: `reservePrOperation` / `validateReservation` /
      `releasePrOperation` with busy/blocked/stale outcomes; only the repair owner may claim an
      automatic comment-follow-up reservation covering queue admission through the normal agent
      turn and known completion/cancellation. Existing activity on any linked task sharing the
      write target blocks admission with an explicit busy result or safe cancellation/drain,
      never simultaneous writes. Gates: PR gate keyed by canonical PR; remote write gate keyed
      by canonical head repository + ref. Gates are durable fenced reservation entries in
      the PR record (no separate filesystem gate locks); acquire/validate/release and the
      before-execution revalidation of durable reservations are short CAS operations under
      the tracking-registry mutex. Nesting is one-way: task ownership or a held gate may be
      followed by a registry CAS (task/gates → registry permitted); the registry mutex is
      never held while acquiring a task or Git lock or while awaiting model/network work
      (registry → task/Git never). The head-ref gate spans distinct PRs, so acquiring it
      validates, under the single global registry mutex, every record whose head mapping
      matches the same canonical head repository + ref — sibling records serialize on the
      gate even though reservations are per-PR. Fixed acquisition order: task ownership → PR
      gate → head-ref gate (each gate acquisition is itself a registry CAS). Observed
      merge/close centrally invalidates queued write intents, prevents new admissions, and
      requests safe cancellation of live tracked operations, preserving unpublished work.
      External tools outside Kanban cannot be locked: compare remote/local state and stop on
      drift.
- [x] PRTRACK-1.5 **Task lifecycle gates.** Shared arbitration: when either installed enabled
      consumer owns a linked PR workflow, legacy automatic clean-tree/PR-delivery completion
      cannot run (browser auto-actions, CLI, and deterministic delivery all gated); manual
      completion retains existing safeguards including preserved Done → Review movement.
      When `autoFinishOnMerge` is persisted true **and the merge consumer is installed**,
      PR creation/push with a clean worktree means In Review, never Done; **with the merge
      consumer uninstalled, legacy behavior is unchanged** (a persisted true checkbox alone
      never strands a card). Comment repair alone also leaves the task In Review until manual
      completion or opted-in merge completion. Merge consumers record manual-reopen/consumed
      generations through the shared mutators (`updateTaskMergeBinding`); reserved comment
      operations and merge completion cannot overlap. Merge consumers wait for verified
      quiescence using `subscribeTerminalInvalidation` plus an exclusive
      `reservePrOperation` — they never call a comment-service API. The gate must work with
      zero real consumers installed (fake consumers in tests).
- [x] PRTRACK-1.6 **UI.** Both checkboxes in task create/edit and detail settings, independent,
      default false, editable throughout In Progress and In Review including queued tasks,
      subject to the consumer being installed; enabled choice with no PR shows "Waiting for
      linked PR"; the installed-consumer/capability signal comes from `getTaskTrackingState`
      (per consumer kind and per-task agent support) and is the only state that renders an
      active checkbox; uninstalled consumer shows the checkbox disabled with "Feature
      unavailable" and an explanation (no API demand created); tasks running non-native-Cline
      agents show comments **unsupported** while merge completion stays available; non-
      github.com hosts/providers show "Automation unsupported"; the visible auth blocker is
      surfaced. Ambiguity blocker for multiple matching links; explicit Automation PR choice;
      "Repairs owned by <workspace/task>" display on non-owner tasks; repair-owner selector;
      Resume PR tracking action (one-shot fresh reconciliation; recurring polling resumes only
      on confirmed open/draft + eligibility); snapshots labelled as of a time; all blockers in
      the existing detail warning/status surfaces with concise reasons. Tailwind tokens,
      `@/components/ui` primitives, `lucide-react` icons; conditional state via `cn()`.
- [x] PRTRACK-1.7 **Fake-consumer and task lifecycle integration tests.** Cover the acceptance
      rows below with independently registered fake consumers (merge-only, comment-only,
      both, neither) and real task/board changes driving subscription demand.

## Frozen consumer API (input/result schemas land in this PR)

These domain operations and their schemas are frozen here; downstream features add consumer
modules and targeted existing API integrations, not new pollers, settings plumbing, or
ownership primitives. Any necessary shared contract change is a prerequisite foundation
follow-up, never a hidden dependency between the features. No feature imports the other's
implementation.

- `registerConsumer(kind, capabilities)` / `unregisterConsumer` — explicit runtime capability
  and required read sources; subscriptions remain task-derived. Demand: both consumers request
  metadata; only the comment consumer requests feedback/review/thread reads; a comment-only
  task needs no further recurring reads once its PR is terminal. Merge requests metadata
  only. Both real consumers stay unregistered until their own PR lands.
- `getTaskTrackingState` / `updateTaskPrSettings` / `selectAutomationPr` / `resumePrTracking` —
  revision-checked settings, selection, diagnostics, and one-shot terminal resume.
- `getAuthorizedSnapshot` / `refreshSnapshot` — access-scoped versioned normalized data with
  freshness/completeness; refresh coalesces through the coordinator.
- `updatePrCommentDispatch` / `updateTaskMergeBinding` — revision-checked updates inside the PR
  record, preserving other fields/bindings; no generic sidecar workflow store.
- `selectRepairOwner` / `transferRepairOwner` — validated explicit durable assignment and
  handoff (a transfer to none is the explicit release path).
- `reservePrOperation` / `validateReservation` / `releasePrOperation` — fenced task/PR/head
  ownership with busy/blocked/stale outcomes, cancellation, and reconciliation.
- `subscribeTaskSnapshot` / `subscribeTerminalInvalidation` — versioned notifications plus
  durable replay cursors persisted per consumer kind on each task binding in the PR record;
  events are hints, consumers reconcile authoritative state on startup. Merge consumers use
  terminal invalidation plus exclusive reservation to wait for verified quiescence — never
  a comment-service API.

## Acceptance and tests (PRTRACK-1 rows)

Unit suites must not boot real SDK hosts; tests touching workspace state, task worktrees,
delivery receipts, or dispatch records redirect `process.env.HOME` (and `USERPROFILE`) to a
temp dir in `beforeEach` and restore in `afterEach`; Git subprocess fixtures use the sanitized
Git test environment. At minimum:

| Scenario | Required result |
| --- | --- |
| Real task changes remove demand | Moving a card to Backlog/Done/Trash, disabling both checkboxes, removing the link, or deleting the workspace prunes the subscription; zero recurring reads after; PR record retained while any current task links it |
| One PR, two tasks across workspaces | Shared in-flight read; independent task bindings; both settings updates revision-checked and unrelated fields preserved; stale whole-board save cannot clobber server-owned fields |
| Two comment candidates for one PR | Automatic repair blocked on both with "Choose repair owner"; only the explicitly selected owner can reserve; other task shows "Repairs owned by <workspace/task>" and never launches a second repair |
| Restart with an assigned owner | Owner retained; disabling/trashing the owner stops work without silent handoff; deleting the owner blocks remaining candidates until explicit reassignment |
| Owner transfer | Both intents invalidated, writer actions drained, ambiguous push reconciled; new fencing generation and handoff persisted atomically; pending/last-dispatched fingerprints and failure status retained; pending feedback reassessed under the new task's specification; no scope change, repair turn, or replay authorized |
| PR and shared-head locks | Competing writers/reviews/delivery/manual actions, queued cancellation, lease expiry with unknown live process, stale fencing, and lost push response all produce no unsafe takeover; distinct PRs on the same head branch cannot write concurrently |
| Merge consumer alone, comment alone, both, neither | No unresolved feature dependency; each consumer registers independently and remains disabled independently; terminal invalidation cancels queued writes and safe-cancels live operations without requiring the other feature installed |
| Legacy automation vs PR lifecycle | With an installed enabled consumer owning a linked PR workflow, legacy automatic clean-tree/PR-delivery completion cannot run from browser, CLI, or deterministic delivery; `autoFinishOnMerge` persisted true + merge consumer installed → PR creation/push + clean worktree leaves the task In Review, never Done; manual completion keeps its safeguards |
| Auto-finish persisted true, merge consumer uninstalled | Legacy clean-tree completion behavior unchanged (no stranding); checkbox shown disabled with "Feature unavailable" |
| Checkbox/selection lifecycle | Default false; old cards read false without migration; enabled with no PR shows "Waiting for linked PR"; uninstalled consumer shows "Feature unavailable" disabled; ambiguity blocks with multiple matching links; same PR never rearms a consumed completion generation by toggling |
| Resume PR tracking | One fresh read; recurring polling resumes only on confirmed open/draft + eligibility; terminal stop and consumed markers never cleared; externally reopened PR detectable without periodic reads of closed PRs |
| In-flight read after consumer loss | Each remaining consumer revalidated before applying state/scheduling effects; none applied for departed consumers |
| Consumer registry demand rule | Merge-only consumer → metadata reads only; comment consumer → feedback/review/thread sources; unregistering or uninstalling a consumer removes exactly its demand; zero demand → zero API reads |
| Snapshot API through trpc | `getAuthorizedSnapshot` returns access-scoped, versioned data labelled with freshness/completeness; `refreshSnapshot` coalesces into the single in-flight read with no duplicate request |
| Record mutators | `updatePrCommentDispatch` / `updateTaskMergeBinding` reject stale revision, wrong generation, and non-owner callers; unrelated fields and bindings preserved in the persisted record |
| Subscriptions and replay cursors | `subscribeTaskSnapshot` / `subscribeTerminalInvalidation` emit versioned events; after restart, replay resumes from the persisted per-consumer-kind cursor; events are hints and consumers reconcile authoritative state on startup |
| Merge quiescence | With zero comment consumers installed, merge completion waits on terminal invalidation plus an exclusive `reservePrOperation` and proceeds only after drain; no comment-service API is called |
| Mutation ownership across scopes | Same PR visible under two access scopes → one owner/reservation state keyed by canonical PR; a claim from either scope validates against that one record; no duplicate owner |
| Lock-order violation | Acquiring a task or Git lock (or awaiting model/network work) while holding the tracking-registry mutex, or reversing the task → PR gate → head-ref gate order, is rejected; gate acquisition itself (a registry CAS) succeeds; no deadlock and no unsafe takeover |
| Non-native-Cline agent | Comments shown as **comments unsupported** for the task; merge completion remains available and functional |
| Non-github.com host/provider | Link shows "Automation unsupported"; no subscription and no API reads |
| Auth blocker display | Missing gh/credentials surfaces the visible auth blocker in the task detail surface; no login attempts, no silent success |

Run: targeted backend/runtime/trpc test files, `web-ui` hook/component suites, backend and web
typechecks, Biome for the changed files, and the repository's required checks. Feature-specific
end-to-end pilots remain in the comment and merge plans.

## Settings, rollout, and documentation

No new environment variables, secrets, or configuration. Document in the PR description: the
optional false-default card settings and their old-card behavior, the installed-consumer
signal source (per consumer kind and per-task agent support, via `getTaskTrackingState` or
`RuntimeConfigResponse`), storage upgrade (PR records from PRTRACK-0 plus card fields),
locking and the fixed lock order, the unavailable/unsupported-consumer UI, and rollback
(drain operations; preserve newer unknown fields and record versions). Both feature consumers
remain independently disabled until COMMENT-0 / MERGE-1 land; rollout keeps them unregistered
and validates with fake consumers only. After actual service/device changes, append the
operational task: update `billy-the-ape/homelab-documentation` through a Ready for Review PR
with actual storage/config/auth references, concurrency behavior, and rollback.

## Handoff

Implemented in this worktree (PR targets `feat/pr-tracking-base`). Record:

- **Changed files.** New: `src/pr-tracking/pr-consumer-registry.ts`,
  `pr-lifecycle-gate.ts`, `pr-owner-selection.ts`, `pr-reservations.ts`,
  `pr-task-subscriptions.ts`, `src/trpc/pr-tracking-api.ts`,
  `test/runtime/pr-tracking/pr-track1-foundation.test.ts`,
  `web-ui/src/components/detail-panels/task-pr-tracking-panel.tsx`,
  `web-ui/src/utils/pr-tracking.ts`. Modified: `src/core/api-contract.ts`,
  `src/core/task-board-mutations.ts`, `src/state/workspace-state.ts`,
  `src/pr-tracking/{in-memory-pr-record-store,pr-record-store,pr-tracking-coordinator}.ts`,
  `src/trpc/{app-router,runtime-api,workspace-api,projects-api}.ts`, `src/server/runtime-server.ts`,
  `src/commands/task.ts`, `web-ui/src/App.tsx`, `web-ui/src/components/{card-detail-view,task-create-dialog,task-inline-create-card}.tsx`,
  `web-ui/src/hooks/{use-board-interactions,use-review-auto-actions,use-task-editor}.ts`,
  `web-ui/src/state/board-state.ts`, `web-ui/src/types/board.ts`.
- **New card fields and merge point.** `autoAddressComments`, `autoFinishOnMerge`,
  `selectedAutomationPrKey`, `settingsRevision` (all optional on
  `runtimeBoardCardSchema`; absent reads false / unselected / 0). Server-owned
  carry-forward in `saveWorkspaceState` (`mergeServerOwnedPrSettings`) restores the
  persisted values over stale whole-board saves, same pattern as `pullRequests`.
- **Consumer API routes (frozen schemas).** Under `runtimeAppRouter` →
  `workspace.prTracking`: `setTaskPrSettings`, `selectTaskAutomationPr`,
  `resumeTaskPrTracking`, `getTaskTrackingState`, `getTaskPrSnapshot`,
  `refreshTaskPrSnapshot`, `updateTaskCommentDispatch`, `updateTaskMergeBinding`,
  `selectRepairOwner`, `transferRepairOwner`, `reservePrOperation`,
  `validatePrOperation`, `releasePrOperation`, `readPrSnapshotEvents`. The
  installed-consumer list is also exposed on `RuntimeConfigResponse.installedPrConsumers`
  (empty until COMMENT-0 / MERGE-1 register).
- **Review-hardened semantics (revision 3).**
  - Reservation authorization is per operation: `comment_followup` requires the
    caller to be the repair owner; `merge_completion` is claimable by any task
    whose own binding selects the PR (the two consumers are independent, and a
    merge-only task is never a repair owner). `releasePrOperation` supports an
    audited operator `force` flag (server warning log); without it, a
    non-holder release is `stale`.
  - The head-ref write gate is keyed by the RECORD's verified head mapping
    (`getRecordHeadMapping`, latest snapshot wins); caller-supplied
    `headRepository`/`headRef` are validation hints that reject on mismatch,
    and a record with no verified mapping is blocked (no writes before
    verification).
  - Cross-repository auto-owner guard: `validateAutoAssignedOwner`
    (`src/pr-tracking/pr-owner-selection.ts`) clears a just-made
    auto-assignment (revision-checked) when the verified head mapping does not
    match the record's repository; explicit assignments are never touched.
  - `removeTaskPullRequest` clears `selectedAutomationPrKey` (and bumps
    `settingsRevision`) when the removed link was the selection, so a dangling
    selection can never keep demand/gates alive.
  - `updateTaskCommentDispatch` checks `expectedOwnerRevision` in addition to
    the record-revision CAS (a handoff between read and write is a conflict);
    `updateTaskMergeBinding` does not require ownership (merge consumers are
    not repair owners).
  - `readPrSnapshotEvents` omits `fromCursor` to resume from the persisted
    per-consumer cursor (no zero-cursor reset for re-opened panels).
  - `getTaskTrackingState` reports coordinator auth blockers plus the
    per-task subscription blocker; `refreshTaskPrSnapshot` reports whether it
    joined an in-flight read (`coalesced`).
- **Shared reconcile pass.** All subscription reconciliation goes through one
  single-flight pass (`runPrTrackingReconcilePassShared` in
  `src/server/runtime-server.ts`): startup, board saves (save + PR-link
  add/remove in `workspace-api`), workspace removal (`projects-api` hook),
  the poll-time backstop (coordinator `revalidateSubscriptions`), and API
  triggers join the in-flight pass instead of interleaving. The coordinator
  and every PR API consumer share ONE durable `PrRecordStore`.
- **Lock order and gate keys.** Fixed acquisition order task ownership → PR gate
  (canonical PR key) → head-ref gate (canonical head repository + ref), each
  gate acquisition a short CAS under the single tracking-registry mutex
  (`PrRecordStoreBase.withRegistryTransaction`); the registry mutex is never held
  while acquiring task/Git locks or awaiting model/network work. Sibling records
  sharing a head ref serialize on the gate under the global registry mutex.
- **Lifecycle-gate hook points.** Browser: `web-ui/src/hooks/use-review-auto-actions.ts`
  (`computePrLifecycleGatedTaskIds`). CLI: `src/commands/task.ts`
  (`completeTaskById`). Deterministic delivery: `src/workspace/git-delivery.ts` +
  `src/task-dispatch/task-dispatch-service.ts` (`checkPrDeliveryReservation`).
  All read the installed-consumer registry through
  `evaluatePrLifecycleGate` / `isPrLifecycleGated`; with zero consumers installed
  every gate is a no-op (legacy behavior unchanged).
- **Installed-consumer signal source.** `getTaskTrackingState` per consumer kind
  plus per-task agent support; `RuntimeConfigResponse.installedPrConsumers`
  drives the create/edit dialog checkbox availability ("Feature unavailable").
- **UI surface inventory.** Task create dialog + inline edit card: both
  checkboxes (disabled with "(feature unavailable)" when the consumer is not
  installed). Detail view: `TaskPrTrackingPanel` — checkbox toggles, snapshot
  as-of label with manual refresh, "Waiting for linked PR", ambiguity blocker
  with Automation PR selector, "Repairs owned by <workspace/task>", Resume PR
  tracking, auth/unsupported blocker surfaces.
- **Test commands and results.** `npx vitest run test/runtime/pr-tracking`
  (96 tests pass, incl. 22 PRTRACK-1 foundation tests); `npm run test:fast`
  (1061/1062 — the one failure, `test/runtime/server/middleware.test.ts`
  socket-upgrade case, fails identically on the clean base branch:
  environment-dependent, not a regression); `npm run typecheck` and
  `npm run web:typecheck` clean; `npm run web:test` (586 tests pass); Biome clean.
- **Baseline drift.** None beyond PRTRACK-0; no storage-format changes beyond
  PRTRACK-0's record schema (reservation/owner blocks already present).
- **Review-hardened semantics (revision 4, #66 follow-up).**
  - Diagnostics are split so the UI can distinguish capability from agent
    support: `feature_unavailable` (consumer not installed, message
    "Comment follow-up automation is not installed in this runtime.") vs
    `comments_unsupported` (installed but the task is not native Cline,
    message "Comment follow-up automation requires a native Cline task.").
    `getTaskTrackingState` also returns `commentsSupportedForTask`
    (consumer installed AND native-Cline task), and the zero-consumer
    short-circuit skips board enumeration entirely, so a repair owner is
    reported `active` (never `deleted`) when no consumers are installed.
  - The task edit dialog saves changed PR settings through the
    revision-checked `setTaskPrSettings` (`expectedSettingsRevision` from the
    board card, diff-detected: only changed values are sent, unchanged
    settings never write). `updateTask` no longer carries PR fields (stale
    whole-board saves cannot clobber server-owned settings); conflicts surface
    a toast instead of silently losing the change. `settingsRevision`
    hydrates through `normalizeCard`/`BoardCard`.
  - `releasePrOperation` operator path is authorized: `force` requires the
    reservation the operator observed (`expectedHolder` +
    `expectedFencingGeneration`); a mismatch is `stale`, and the release is
    refused (`busy`) while the holder's writer is still active
    (`isTaskWriterActive` wired through `app-router` →
    `runtime-server` → PR API). All force outcomes are audited through the
    server warning log.
  - No-op settings writes (no field present) report `ok` without touching the
    revision; `selectTaskAutomationPr` reuses `setTaskSelectedAutomationPr`
    (no duplicated inline mutation).
  - Reconcile triggers queue a follow-up FULL pass after the in-flight one
    (dirty-flag coalescing in `runtime-server`), so a coalesced trigger never
    runs on a board view older than the trigger; `createReconcilePass`
    (pr-task-subscriptions) is the single implementation (no dead duplicate).
    Every board-change broadcast (save, PR-link add/remove from any writer,
    including auto-discovered links) re-derives subscription demand.
  - Fork-PR decision (review comment "needs a decision"): the
    cross-repository auto-owner guard is NOT enforced at assignment. Fork→
    upstream PRs have a head repository that differs from the base/record
    repository by construction, so treating that as "cross-repository
    reference" would block the normal fork workflow. Protection is enforced
    at the point of use instead: the record's verified head mapping keys the
    head-ref write gate (`reservePrOperation`/`validatePrOperation`), and the
    repair turn (COMMENT-0) validates the task's delivery branch against that
    mapping before any remote write.
  - New API-level suite: `test/runtime/pr-tracking/pr-tracking-api.test.ts`
    (diagnostics, no-op/conflict settings, force-release authorization).
- **Test commands and results (revision 4).** `npx vitest run
  test/runtime/pr-tracking` (104 tests pass); `npx vitest run
  test/runtime/trpc test/integration/workspace-state.integration.test.ts
  test/runtime/task-board-mutations.test.ts` (246 pass); `npx tsc --noEmit`
  and web-ui typecheck clean; `npx vitest run` (web-ui) passes incl.
  `use-task-editor.test.tsx` (12 tests, 2 new revision-checked settings
  tests); Biome clean for all changed files.

COMMENT-0 and MERGE-1 can now start in parallel; each adds consumer modules and
targeted existing API integrations only.

## Stop conditions

- PRTRACK-0 is not landed — this PR is blocked.
- Freezing a consumer API schema reveals a conflict with current task lifecycle APIs that
  cannot be resolved without changing a settled policy — stop and record the case rather than
  invent policy.
- A test requires external network, real GitHub credentials, or a real SDK host boot in a unit
  suite — rework the fixture instead.
- A lifecycle gate cannot be expressed without a change outside this PR's scope — flag the
  design decision; do not silently widen scope.
