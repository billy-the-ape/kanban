# PRTRACK-1 — FOUNDATION-1: task preferences, live subscriptions, owners/reservations, consumer API, lifecycle gates

Part of the **GitHub PR tracking foundation** feature. The master plan lives in
[github-pr-tracking-master-plan.md](./github-pr-tracking-master-plan.md). This document is a
self-contained execution brief for the second implementation PR (slice **FOUNDATION-1**). It
represents a single PR.

| Field | Value |
| --- | --- |
| Document revision | 1 |
| Prepared | 2026-10-06 |
| Status | planned; no milestone started |
| Source baseline | 49a2ca05c6c2927da2194aaec8bd1e45e6fa2928 (main) |
| Fork | https://github.com/billy-the-ape/kanban |
| Prerequisites | PRTRACK-0 (FOUNDATION-0) landed: record store, gh adapter, read-only coordinator |
| Follow-on | COMMENT-0 and MERGE-1 proceed independently and in parallel from their own plan folders after this PR lands |

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
PR (fake consumers in tests). An enabled checkbox for an uninstalled consumer shows
"Feature unavailable" and creates no API demand.

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
  poll timing, backlog order, or task ID. Owner is retained until explicit transfer/release;
  owner disable/pause/trash/unlink stops its work but never transfers authority; owner deletion
  blocks remaining candidates until explicit reassignment.
- Mutation arbitration: PR gate keyed by canonical PR; remote write gate keyed by canonical
  head repository + ref (also preventing distinct PRs on the same branch from writing
  concurrently). Durable fenced intent reservations instead of holding filesystem mutexes while
  awaiting model slots or network I/O. Durable reservations are revalidated under the
  tracking-registry mutex immediately before execution; never nest registry and task locks.
  Observed merge/close centrally invalidates queued write intents, blocks new admissions, and
  requests safe cancellation of live tracked operations.
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
- `web-ui/` — task create/edit and detail settings checkboxes, "Waiting for linked PR",
  "Feature unavailable" disabled states, ambiguity blocker, repair-owner selector, Resume PR
  tracking, snapshot as-of labelling, and blocker surfaces in the existing detail
  warning/status areas
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
- `web-ui/src/hooks/use-review-auto-actions.ts` — legacy premature Done; must be gated so
  browser automation cannot complete a task whose linked PR workflow is owned by an installed
  enabled consumer.
- `web-ui/src/state/drag-rules.ts` — preserved Done → Review movement; manual completion
  keeps its existing safeguards.
  `src/fs/locked-file-system.ts` — distinct locks need distinct `path` values (proper-lockfile
  keys its in-process map by `path`, not the lockfile name).
## Implementation tasks (in this order)

- [ ] PRTRACK-1.1 **Revision-checked preference and selection APIs.** Add
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
      freshness). No selected-PR tracking state in browser localStorage.
- [ ] PRTRACK-1.2 **Live task-derived subscriptions.** Replace PRTRACK-0's fake subscriptions:
      on startup enumerate current managed workspaces/cards, validate links/preferences, join
      matching PR records, and rebuild the in-memory index solely from eligible current tasks
      and installed consumers. Reconcile live on board moves, checkbox changes, link
      selection/removal, workspace removal, and runtime disposal; reevaluate before every read.
      Prune subscriptions on deletion, workspace removal, unlink/replacement, and column/
      settings changes; stop API work when the last eligible subscriber leaves; drop transient
      feedback snapshots immediately when their last subscriber leaves without calling GitHub.
      Retain the minimal PR record while any current task links it (including inactive/history
      cards) so terminal/fingerprint markers survive. A fetched result is applied only after
      rereading task settings, linkage, and current revision; in-flight responses revalidate
      each consumer before applying state or scheduling effects.
- [ ] PRTRACK-1.3 **Owner selection, transfer, and reservations.** Durable repair-owner
      selection: exactly-one-candidate atomic assignment; multi-candidate "Choose repair owner"
      ambiguity block; revision-checked **Repair owner** selector listing linked tasks with
      workspace labels; owner validity requires the task selects this PR and has a verified
      writable head mapping. Ownership persists until explicit transfer/release; disable/pause/
      trash/unlink never transfers; deletion blocks remaining candidates. Transfer requires both
      tasks' intents invalidated, running/queued writer actions drained, and ambiguous
      commit/push reconciled; persist the new fencing generation and transfer handoff atomically
      in the same PR record; retain pending/last-dispatched fingerprints and failure status;
      transfer never authorizes scope changes, a repair turn, or replay of dispatched feedback.
      A lease timeout alone cannot grant ownership: verify prior process/session exit and remote
      side effects first, otherwise needs-human.
      Fenced operation reservations: `reservePrOperation` / `validateReservation` /
      `releasePrOperation` with busy/blocked/stale outcomes; only the repair owner may claim an
      automatic comment-follow-up reservation covering queue admission through the normal agent
      turn and known completion/cancellation. Existing activity on any linked task sharing the
      write target blocks admission with an explicit busy result or safe cancellation/drain,
      never simultaneous writes. Gates: PR gate keyed by canonical PR; remote write gate keyed
      by canonical head repository + ref. Acquire task ownership and shared PR/head branch
      ownership in a documented fixed lock order; persist fenced intent reservations instead of
      holding filesystem mutexes while awaiting model slots or network I/O; revalidate durable
      reservations under the tracking-registry mutex immediately before execution. Observed
      merge/close centrally invalidates queued write intents, prevents new admissions, and
      requests safe cancellation of live tracked operations, preserving unpublished work.
      External tools outside Kanban cannot be locked: compare remote/local state and stop on
      drift.
- [ ] PRTRACK-1.4 **Task lifecycle gates.** Shared arbitration: when either installed enabled
      consumer owns a linked PR workflow, legacy automatic clean-tree/PR-delivery completion
      cannot run (browser auto-actions, CLI, and deterministic delivery all gated); manual
      completion retains existing safeguards including preserved Done → Review movement.
      When `autoFinishOnMerge` is enabled, PR creation/push with a clean worktree means
      In Review, never Done; comment repair alone also leaves the task In Review until manual
      completion or opted-in merge completion. Merge consumers record manual-reopen/consumed
      generations through the shared mutators (`updateTaskMergeBinding`); reserved comment
      operations and merge completion cannot overlap. The gate must work with zero real
      consumers installed (fake consumers in tests).
- [ ] PRTRACK-1.5 **UI.** Both checkboxes in task create/edit and detail settings, independent,
      default false, editable throughout In Progress and In Review including queued tasks;
      enabled choice with no PR shows "Waiting for linked PR"; uninstalled consumer shows the
      checkbox disabled with "Feature unavailable" and an explanation (no API demand created).
      Ambiguity blocker for multiple matching links; explicit Automation PR choice;
      "Repairs owned by <workspace/task>" display on non-owner tasks; repair-owner selector;
      Resume PR tracking action (one-shot fresh reconciliation; recurring polling resumes only
      on confirmed open/draft + eligibility); snapshots labelled as of a time; all blockers in
      the existing detail warning/status surfaces with concise reasons. Tailwind tokens,
      `@/components/ui` primitives, `lucide-react` icons; conditional state via `cn()`.
- [ ] PRTRACK-1.6 **Fake-consumer and task lifecycle integration tests.** Cover the acceptance
      rows below with independently registered fake consumers (merge-only, comment-only, both,
      neither) and real task/board changes driving subscription demand.

## Frozen consumer API (input/result schemas land in this PR)

These domain operations and their schemas are frozen here; downstream features add consumer
modules and targeted existing API integrations, not new pollers, settings plumbing, or
ownership primitives. Any necessary shared contract change is a prerequisite foundation
follow-up, never a hidden dependency between the features. No feature imports the other's
implementation.

- `registerConsumer(kind, capabilities)` / `unregisterConsumer` — explicit runtime capability
  and required read sources; subscriptions remain task-derived. Merge requests metadata only.
  Both real consumers stay unregistered until their own PR lands.
- `getTaskTrackingState` / `updateTaskPrSettings` / `selectAutomationPr` / `resumePrTracking` —
  revision-checked settings, selection, diagnostics, and one-shot terminal resume.
- `getAuthorizedSnapshot` / `refreshSnapshot` — access-scoped versioned normalized data with
  freshness/completeness; refresh coalesces through the coordinator.
- `updatePrCommentDispatch` / `updateTaskMergeBinding` — revision-checked updates inside the PR
  record, preserving other fields/bindings; no generic sidecar workflow store.
- `selectRepairOwner` / `transferRepairOwner` — validated explicit durable assignment and
  handoff.
- `reservePrOperation` / `validateReservation` / `releasePrOperation` — fenced task/PR/head
  ownership with busy/blocked/stale outcomes, cancellation, and reconciliation.
- `subscribeTaskSnapshot` / `subscribeTerminalInvalidation` — versioned notifications plus
  durable replay cursors; events are hints, consumers reconcile authoritative state on startup.
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
| Owner transfer | Both intents invalidated, writer actions drained, ambiguous push reconciled; new fencing generation and handoff persisted atomically; pending/last-dispatched fingerprints and failure status retained; no scope change, repair turn, or replay authorized |
| PR and shared-head locks | Competing writers/reviews/delivery/manual actions, queued cancellation, lease expiry with unknown live process, stale fencing, and lost push response all produce no unsafe takeover; distinct PRs on the same head branch cannot write concurrently |
| Merge consumer alone, comment alone, both, neither | No unresolved feature dependency; each consumer registers independently and remains disabled independently; terminal invalidation cancels queued writes and safe-cancels live operations without requiring the other feature installed |
| Legacy automation vs PR lifecycle | With an installed enabled consumer owning a linked PR workflow, legacy automatic clean-tree/PR-delivery completion cannot run from browser, CLI, or deterministic delivery; `autoFinishOnMerge` enabled → PR creation/push + clean worktree leaves the task In Review, never Done; manual completion keeps its safeguards |
| Checkbox/selection lifecycle | Default false; old cards read false without migration; enabled with no PR shows "Waiting for linked PR"; uninstalled consumer shows "Feature unavailable" disabled; ambiguity blocks with multiple matching links; same PR never rearms a consumed completion generation by toggling |
| Resume PR tracking | One fresh read; recurring polling resumes only on confirmed open/draft + eligibility; terminal stop and consumed markers never cleared; externally reopened PR detectable without periodic reads of closed PRs |
| In-flight read after consumer loss | Each remaining consumer revalidated before applying state/scheduling effects; none applied for departed consumers |

Run: targeted backend/runtime/trpc test files, `web-ui` hook/component suites, backend and web
typechecks, Biome for the changed files, and the repository's required checks. Feature-specific
end-to-end pilots remain in the comment and merge plans.

## Settings, rollout, and documentation

No environment variables, secrets, or deployment actions. Document in the PR description: the
optional false-default card settings and their old-card behavior, storage upgrade (PR records
from PRTRACK-0 plus card fields), locking and the fixed lock order, the unavailable-consumer
UI, and rollback (drain operations; preserve newer unknown fields and record versions). Both
feature consumers remain independently disabled until COMMENT-0 / MERGE-1 land.

## Handoff

Record: changed files, the new card fields and their server-owned merge point, every consumer
API route and its frozen schema, the lock order and gate keys, the lifecycle-gate hook points
(browser/CLI/delivery), the UI surface inventory, test commands and results, and any baseline
drift discovered against 49a2ca05c6c2927da2194aaec8bd1e45e6fa2928. COMMENT-0 and MERGE-1 can
then start in parallel; each adds consumer modules and targeted existing API integrations only.

## Stop conditions

- PRTRACK-0 is not landed — this PR is blocked.
- Freezing a consumer API schema reveals a conflict with current task lifecycle APIs that
  cannot be resolved without changing a settled policy — stop and record the case rather than
  invent policy.
- A test requires external network, real GitHub credentials, or a real SDK host boot in a unit
  suite — rework the fixture instead.
- A lifecycle gate cannot be expressed without a change outside this PR's scope — flag the
  design decision; do not silently widen scope.
