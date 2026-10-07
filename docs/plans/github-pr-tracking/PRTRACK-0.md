# PRTRACK-0 — FOUNDATION-0: PR record schema/store, GitHub gh adapter, read-only coordinator

Part of the **GitHub PR tracking foundation** feature. The master plan lives in
[github-pr-tracking-master-plan.md](./github-pr-tracking-master-plan.md). This document is a
self-contained execution brief for the first implementation PR (slice **FOUNDATION-0**). It
represents a single PR.

| Field | Value |
| --- | --- |
| Document revision | 2 |
| Prepared | 2026-10-06 |
| Status | Implemented — PR opened targeting `feat/pr-tracking-base` |
| Source baseline | 49a2ca05c6c2927da2194aaec8bd1e45e6fa2928 (main) |
| Fork | https://github.com/billy-the-ape/kanban |
| Prerequisites | PR #49 (still open) supplies the landed PR-linking contracts (`docs/plans/pr-linking/`); verify `getPullRequestIdentityKey` exists before starting. This plan (with the comment and merge plans) supersedes overlapping scope in unmerged PR #21 — do not run both task series |
| Follow-on | PRTRACK-1 (FOUNDATION-1), then COMMENT-0 and MERGE-1 in parallel from their own plan folders |

The foundation totals two implementation PRs in this folder. The master plan's "total of four
implementation PRs" counts these two foundation PRs plus COMMENT-0 and MERGE-1, the latter two
living in `docs/plans/pr-comment-handling/` and `docs/plans/pr-merge-tracking/`. Both
foundation PRs must land before either feature series starts.

## Purpose

Ship the read-only half of the shared PR tracking foundation:

1. A versioned, durable `GitHubPrTrackingRecord` keyed by canonical PR identity, stored under the
   runtime home, written only through revision-checked atomic updates.
2. A fixed noninteractive GitHub provider adapter (`gh api --hostname github.com`) with complete
   pagination, conditional reads, bounded timeouts, backoff, and visible auth-blocker semantics.
3. One runtime-wide observation coordinator covering all managed workspaces: deduplicated
   60-second polling, in-flight read coalescing, access-scope isolation, the polling eligibility
   table, terminal stop/resume rules, and orphan-record safety.

**No new UI, API, or consumer behavior ships in this PR.** No task preference fields or
checkboxes, no consumer registration API, no owner/reservation operations, no repair dispatch,
no card moves, no PR writes, no merges, no agent launches. Fake/inspect-only subscriptions
prove the mechanics; the real task-derived subscriptions and consumer API are PRTRACK-1.

This PR still ships *visible* failure states, but nowhere near a user yet: auth and scheduler
blockers are held as coordinator state (PRTRACK-1's `getTaskTrackingState` later surfaces
them), and a scheduler-lock failure additionally emits a startup log/stderr line. There is no
UI, trpc, or consumer API in this PR to render them.

## Fixed decisions carried in from the master plan

These are settled. Implementation may choose local helper names and file layout, but not the
architecture or product rules.

- **Runtime provider:** github.com only. Noninteractive `gh api --hostname github.com` through
  direct `execFile` (no shell), the service's existing gh auth/environment, cwd at the owning
  repository, 30-second timeout, 8 MiB output bound per page. No interactive shell, no new token
  database, no browser authentication, no webhook server, no HTTP adapter. Missing gh/credentials
  → visible auth blocker, never a hot-loop of login attempts. Never send the GitHub credential to
  an arbitrary linked host; other provider/host links report "Automation unsupported".
- **Credential scope:** the service account's one active github.com credential context. An opaque
  nonsecret `accessScopeId` follows the authenticated account/configuration revision; snapshots
  invalidate on auth-context change. Never persist tokens. Disjoint scopes get separate
  reads/caches and never leak data into each other; this PR holds exactly one PR record keyed
  by canonical PR regardless of how many scopes read it (scoped snapshots live inside it), and
  durable mutation ownership (PRTRACK-1) keys by the same canonical PR across scopes.
- **Reads:** PR metadata from `repos/{owner}/{repo}/pulls/{number}`. Published review bodies,
  inline comments/thread resolution, and conversation comments only when a (fake) subscription
  requests feedback sources — real demand arrives via the PRTRACK-1 consumer registry.
  Paginated REST plus GraphQL thread
  resolution via gh; retain per-source completeness — publish a snapshot only after all pages
  succeed. Four read requests maximum in flight runtime-wide.
- **Cadence/backoff:** poll 60 seconds with jitter; transient failures back off
  60/120/240/480/900 seconds capped at 900; honor longer Retry-After/reset deadlines. Terminal
  reconciliation permits at most three additional remote reads per episode, then stop and expose
  a needs-human reason.
- **Bot/feedback policy:** accept non-empty *submitted* review bodies and inline review feedback
  from human and GitHub bot accounts; ignore empty/approval-only review events, unpublished or
  pending reviews, and resolved threads; accept human conversation comments but ignore bot
  conversation/status chatter; no reviewer-bot allowlist; do not exclude a human comment solely
  because it uses the service's own account. The foundation normalizes this feedback with
  classification metadata; consumers apply the policy (COMMENT-0).
- **Record:** schema version 1, SHA-256 key digest, revision-checked atomic updates. Serialize
  shared record/reservation changes with a single tracking-registry mutex; release it before
  acquiring existing task/Git locks or awaiting network/model work. Nesting is one-way only
  (this refines the master's blanket "never nest registry and task locks"): a short record CAS
  may run under the registry mutex while task ownership or a PR/head-ref gate reservation is
  already held (task/gates → registry permitted), but the registry mutex is never held while
  acquiring a task or Git lock or while awaiting network/model work (registry → task/Git
  never). Gate reservations are record entries, so acquiring one is itself a CAS under the
  mutex. Do not hold workspace locks during network calls.
- **Identity:** canonical PR key = provider + lowercase host/repository + positive PR number,
  reused from PR linking. Never infer association from title, branch name, or the latest UI link.
  Owner/binding identity always includes workspaceId and taskId.

## Scope

Allowed:

- `src/core/api-contract.ts` — provider-free contract types only: the
  `GitHubPrTrackingRecord` schema, normalized snapshot/versioned event types, and the comment
  block / merge binding / reservation field shapes (semantics frozen by the comment and merge
  plans, but the fields must exist in the foundation contract before downstream work starts)
- `src/pr-tracking/` (new) — identity, record store, gh adapter, transient snapshots,
  coordinator, eligibility/stop rules
- `src/server/runtime-server.ts`, `src/server/workspace-registry.ts` — coordinator
  registration/start/stop, the scheduler lock for the automation storage root
  `join(getRuntimeHomePath(), "pr-tracking")` (proper-lockfile `path` = that directory), and
  the tracking-registry mutex (proper-lockfile `path` = `join(getRuntimeHomePath(),
  "pr-tracking", "registry")` — distinct from the scheduler lock's `path`; on-disk lockfile
  names are set separately via `lockfilePath`)
- `src/state/workspace-state.ts` — reuse `getRuntimeHomePath()` and the existing atomic
  JSON/lock helpers; no board schema changes in this PR
- Tests under `test/` (runtime, integration, trpc as needed)

Explicit non-goals:

- No task preference fields (`autoAddressComments`, `autoFinishOnMerge`), no UI changes, no
  trpc settings endpoints (PRTRACK-1)
- No `registerConsumer`/consumer API, no durable owner/reservation operations, no lifecycle
  gates over task completion (PRTRACK-1)
- No comment handling or merge tracking consumer; both remain unregistered
- No writes to GitHub (no PR creation, comment posting, pushes), no card moves, no agent
  launches, no completion of any kind
- No new dependencies, environment variables, configuration, or inbound listeners

## Source map (reinspect before editing; baseline is historical)

- `src/core/api-contract.ts` — schema conventions; PR-linking identity
  (`getPullRequestIdentityKey` in `src/core/pull-request-links.ts`) is the authoritative PR key.
- `src/state/workspace-state.ts` — `getRuntimeHomePath()` and the atomic JSON read-modify-write
  helpers. Trap: `mutateWorkspaceState` returns a response object, not the value.
- `src/workspace/git-delivery.ts` — follow its direct-exec/argument-array convention and
  `createGitProcessEnv()` from `src/core/git-process-env.ts` (which only strips repo-routing
  variables like `GIT_DIR`/`GIT_WORK_TREE`; it does not make gh noninteractive). Its
  `runGhCommand` has no timeout and a 1 MiB `maxBuffer` — the 30-second timeout, 8 MiB bound,
  and noninteractive gh settings are new for this adapter. Do not refactor `git-delivery.ts`.
- `src/fs/locked-file-system.ts` — wraps proper-lockfile, which keys its in-process lock map by
  the resolved `path` argument, not the lockfile name. Each distinct lock needs a distinct
  `path`; the on-disk lockfile name is controlled separately via `lockfilePath`.
- `src/server/runtime-server.ts` / `src/server/workspace-registry.ts` — where per-runtime
  singletons start and stop; the coordinator joins this lifecycle.
- `src/task-dispatch/task-dispatch-service.ts` — worker policy/readiness reference only; not
  wired in this PR.

## Implementation tasks (in this order)

- [x] PRTRACK-0.1 **Canonical PR identity and record schema.** Reuse the PR-linking identity as
      the `canonicalPrKey`; define the version-1 `GitHubPrTrackingRecord` contract in
      `src/core/api-contract.ts`: `schemaVersion`/`revision`; PR identity; `orphanedAt`
      (timestamp the record was first observed orphaned — starts the 24-hour retention
      clock); authorized metadata snapshots keyed by `accessScopeId` (`checkedAt`, head/base
      repository/ref, head SHA, PR state open/closed/draft/merged, merged timestamp, merge
      commit SHA); task bindings
      (`workspaceId`+`taskId`) with terminal stop/reopen/completion markers and monotonic link
      generations (reselecting the same handled PR cannot erase consumed markers).
      Declare here the field shapes downstream plans freeze (field semantics are normatively
      frozen by the comment and merge plans; these names/shapes are the declared contract
      surface, so PRTRACK-1's no-storage-change non-goal holds):
      - comment automation block: `repairOwner` (workspaceId/taskId + owner revision),
        `pendingFeedbackFingerprint` and `lastDispatchedFeedbackFingerprint` as a structured
        dedupe descriptor (digest + latest-`updatedAt` watermark + sorted version tokens at
        that watermark — not a bare string), `debounceDeadline`, `firstPendingAt`, and the
        dispatch descriptor (`dispatchId`, `attemptedAt` null while provably unsent, captured
        fingerprint, owner revision, `status` queued/running/completed/failed, turn/session
        reference, concise error);
      - merge binding on each task binding: `mergeCompletion` (schema version,
        workspaceId/taskId/link generation, selected PR identity, `finalHeadSha`, base
        repository/ref, `mergeCommitSha`, `mergedAt`, `observedAt`, `status`
        pending/completed/blocked, `completedAt`, concise error);
      - owner/operation reservation block: owner revision, fencing generation, reservation
        state, and transfer handoff marker;
      - durable replay cursors live on each task binding in the PR record, per consumer kind.
      No comment bodies, per-item dispositions, batch ledgers, or repair-budget counters are
      durable fields.
- [x] PRTRACK-0.2 **Durable record store.** Persist at
      `join(getRuntimeHomePath(), "pr-tracking", "prs", <sha256(canonicalPrKey)> + ".json")`
      using the existing atomic JSON/lock helpers under the single tracking-registry mutex.
      Revision-checked updates that preserve unrelated fields and check revision/generation/owner.
      Validate the composite identity against record contents: malformed/unsupported records
      block tracking and never create subscriptions. Startup enumerates current managed
      workspaces/cards and joins matching PR records **read-only, solely to classify orphan
      records** (does any current card, active or history, still link this PR?) and decide
      retention/cleanup — subscription rebuild from cards is PRTRACK-1.3; never enumerate PR
      records to discover tasks. Orphan records cannot schedule work; the 24-hour clock starts
      when a record is first observed orphaned (persisted on the record); delete an orphan
      record only after 24 hours with no task links and no live/uncertain operation; an
      unresolved operation blocks cleanup and requires manual reconciliation.
- [x] PRTRACK-0.3 **GitHub gh adapter.** Noninteractive `gh api --hostname github.com` via
      direct execFile following the `git-delivery.ts`/`createGitProcessEnv()` convention;
      because the existing `runGhCommand` has no timeout and a 1 MiB `maxBuffer`, the
      30-second timeout, 8 MiB per-page bound, and noninteractive gh environment (prompt
      disabled, no browser login) are new here, and `execFile` timeout/`maxBuffer` error codes
      map into the failure taxonomy below. cwd: pick one of the local repositories of the
      canonical repo deterministically — cwd has no effect on the request or the credentials
      (the full `repos/{owner}/{repo}` path makes the request absolute, and `gh` takes
      credentials from its environment/config for `--hostname`). Complete
      pagination for REST lists and GraphQL thread resolution; per-source ETag/conditional
      reads; completeness tracked per source. Structured failure categories: auth (missing
      gh/credentials → visible blocker, no login retries), rate limit (429/abuse, honor
      Retry-After/reset deadline), 404/access ambiguity, network, timeout/buffer-bound,
      partial-page — each retains last state and pauses decisions; never treat missing/failed
      data as closed or merged. Sanitized errors with timestamps. Runtime-wide cap of four
      in-flight reads.
- [x] PRTRACK-0.4 **Normalized transient snapshots.** Versioned, access-scoped normalized
      metadata (and, when a (fake) subscription requests feedback sources,
      review/conversation/thread feedback) with freshness/completeness. The normalized
      feedback model carries per event: author kind (human/bot) and whether it is the
      service's own account, review state (submitted vs pending), thread resolved/deleted
      flags, `updatedAt`, and a body digest — the foundation normalizes and exposes the full
      feedback with that classification metadata; the bot policy filters downstream (COMMENT-0
      applies it to this normalized data), never here. Full feedback/thread snapshots are
      transient and refetched; only durable aggregate fingerprints are persisted for
      scheduling deduplication. Publish a snapshot only after all of a source's pages succeed.
      Explicit refreshes join the same in-flight read; `accessScopeId` is an opaque hash of
      host + authenticated login + gh config/environment revision (never token material), and
      disjoint `accessScopeId`s get disjoint reads/caches with no data leak. Snapshots are
      labelled as-of a time; a snapshot is stale once its `checkedAt` is older than one poll
      interval plus backoff jitter (a named constant — a stale snapshot may still be displayed
      as-of its time but is refetched before any decision), and snapshots invalidate on
      auth-context change; destructive lifecycle decisions (later consumers) require a fresh
      authoritative read.
- [x] PRTRACK-0.5 **Single runtime-wide coordinator.** One coordinator per Kanban runtime
      covering all managed workspaces — not one timer per workspace or card. One canonical PR
      linked by tasks in different workspaces produces one scheduled/in-flight read per source
      per access scope; fan out the versioned snapshot to separately validated task consumers.
      Demand is the union of eligible subscribers; cancel scheduled reads when the last
      eligible consumer leaves (for a PR shared by several cards, remove only that card's
      subscription). Enforce a scheduler lock on the automation storage root
      `join(getRuntimeHomePath(), "pr-tracking")` (proper-lockfile `path` = that directory —
      distinct from the tracking-registry mutex's `path`). The lock is acquired lazily on the
      first eligible subscription, and a failure blocks only the PR-tracking *scheduler*
      startup — never the runtime, board, or process startup; this is a deliberate refinement
      of the master's "show a blocked startup for a second process" — with a visible
      log/stderr line; a second Kanban process on the same root keeps serving normally with
      tracking disabled. Do not claim cross-host protection.
- [x] PRTRACK-0.6 **Eligibility, backoff, terminal stop/resume.** Implement the master plan's
      eligibility table as coordinator rules driven by subscription state. The subscription
      descriptor records *which* checkbox/consumer is enabled (comment, merge, both) — not
      just "at least one": In Progress/In Review + open/draft PR + at least one enabled
      checkbox → poll every 60 s (subject to backoff); merged PR **with auto-finish enabled**
      and completion reconciliation pending → bounded temporary polling (≤3 remote reads per
      terminal episode); merged already handled, **or with no enabled merge-completion
      consumer**, closed without merge, task in Backlog/Done/Trash, both checkboxes off, or no
      selected eligible PR/unsupported host/ambiguous selection → stop (or no polling with a
      visible blocker); a comment-only task needs no further recurring reads once its PR is
      terminal. Reevaluate eligibility before every read. Persist terminal observation and
      stop reason so restart cannot rearm; API failures before terminal state remain under
      ordinary backoff, never a fabricated terminal stop. Returning an otherwise eligible
      nonterminal card to an active column can resume its subscription; selecting a genuinely
      new linked Automation PR starts a new eligible subscription. Open/draft PRs remain
      observable while an agent is working or waiting for model capacity — polling is never
      gated on turn state. Resume here is a coordinator-level primitive (the public
      `resumePrTracking` API/UI is PRTRACK-1.1/1.6): it requests one fresh read; recurring
      polling resumes only if that read confirms open/draft and eligibility still holds.
      Transient failures back off 60/120/240/480/900 capped at 900, honoring longer
      Retry-After/reset deadlines; add jitter.
- [x] PRTRACK-0.7 **Provider/store/coordinator tests.** Fake subscriptions (and, for adapter
      tests, a fake `gh` executable on PATH — never real network) prove: complete pagination;
      cross-workspace dedupe and shared in-flight refresh; backoff schedule including
      Retry-After; eligibility table transitions (including the auto-finish qualifier, the
      no-merge-consumer stop, and comment-only terminal stop); terminal limits and restart
      no-rearm; column-return and new-PR-selection resume rules; cache expiry and auth-context
      invalidation (old-scope snapshots invalidated, new scope reads fresh, nothing persisted
      that identifies a token); ETag/304 conditional reads (snapshot retained, no completeness
      regression); orphan, corrupt-key, deleted-workspace, and last-subscriber-during-
      in-flight cases.

## Acceptance and tests (PRTRACK-0 rows)

Unit suites must not boot real SDK hosts; tests touching workspace/home state redirect
`process.env.HOME` (and `USERPROFILE`) to a temp dir in `beforeEach` and restore in
`afterEach`; Git subprocess fixtures use the sanitized Git test environment. At minimum:

| Scenario | Required result |
| --- | --- |
| One PR linked by two tasks in different workspaces, same access scope | Exactly one metadata request/page sequence; both task bindings appear independently in one PR record; snapshot fanned out to both |
| Same PR, two disjoint access scopes | One PR record keyed by canonical PR; two authorized reads/caches with scoped snapshots inside it; no private data crosses scopes (durable mutation ownership across scopes is asserted in PRTRACK-1.4) |
| Auth-context change | Old scope's snapshots invalidated; new scope reads fresh; nothing persisted identifies a token |
| ETag/304 conditional read | Snapshot retained on 304 with no completeness regression; expired snapshot refetched before any decision |
| Column return / new PR selection | Returning an eligible nonterminal card to an active column resumes its subscription; selecting a genuinely new linked Automation PR starts a new eligible subscription |
| Comment-only task, PR terminal | No further recurring reads after merge or close; terminal observation persisted |
| Explicit refresh while a poll is in flight | Coalesced into the same in-flight read; no duplicate request |
| PR record with no linked live task, corrupt key/generation, deleted workspace, stale board save | No orphan polling, no invented subscription, no stale state effect; malformed record blocks tracking |
| Last subscriber removed during an in-flight read | Response revalidates consumers; no state or scheduling effect applied; transient feedback dropped immediately without a GitHub call |
| Eligibility table transitions (column moves, checkbox off/on, link removal, unsupported host, ambiguous selection, auto-finish on/off, no enabled merge consumer) | Zero recurring reads in every stopped state; blockers exposed; no polling invented |
| Merged terminal episode | At most three reconciliation reads with normal backoff; then stop with a needs-human reason where evidence is incomplete; stop reason persisted |
| Restart after terminal stop; Done → In Review history move; checkbox off/on | No rearm of a stopped subscription; no reset of consumed markers; only explicit resume performs one fresh read |
| Transient 429/network failure | Backoff ladder 60/120/240/480/900 capped at 900; longer Retry-After honored; last snapshot retained; no fabricated terminal state |
| Missing gh/credentials | Visible auth blocker; no repeated login attempts; no silent success |
| Second Kanban process on the same automation storage root | Lock acquired lazily on the first eligible subscription; the second process keeps serving normally while only its PR-tracking scheduler is blocked, with a visible log/stderr line |
| Orphan record retention | No links + no live/uncertain operation + 24 h elapsed → deleted; any live/uncertain operation → retained and blocked from cleanup |

Run: targeted `test/runtime` / `test/integration` suites, backend and web typechecks, Biome for
the changed files, and the repository's required checks. Foundation acceptance uses
fake consumers/providers only; feature-specific end-to-end pilots stay in the comment and
merge plans.

## Settings, rollout, and documentation

No new environment variables, secrets, or configuration. Deployment prerequisite: the service
account's existing host `gh` credential must have read access to the linked repositories;
otherwise tracking reports the visible auth blocker and stays blocked. The PR introduces
optional versioned record files under the runtime home; document in the PR description: the
storage location and schema version, the auth source and read permissions required (existing
host gh auth), the tracking-registry mutex and lock ordering, the scheduler-lock behavior for
a second process (lazy acquisition, scheduler-only block), and rollback (records are inert
without consumers; preserve newer unknown fields and record versions on older code). Rollout
starts with fake/inspect-only consumers to validate orphan cleanup and multi-workspace
deduplication, then enables each feature on its own pilot. After actual service/device
changes, append the operational task: update `billy-the-ape/homelab-documentation` through a
Ready for Review PR with actual storage/config/auth references, concurrency behavior, and
rollback.

## Handoff

Record: changed files, the record location/format and schema version, both lock scopes
(scheduler lock and tracking-registry mutex) and their distinct `path` choices, the
coordinator lifecycle registration point, the failure-category
taxonomy, test commands and results, and any baseline drift discovered against
49a2ca05c6c2927da2194aaec8bd1e45e6fa2928. PRTRACK-1 then adds task preferences, live
task-derived subscriptions, owner/reservation operations, the consumer API, and lifecycle gates
against this read-only foundation.

## Stop conditions

- The master plan's fixed decisions conflict with current source in a way that cannot be
  resolved without changing a settled policy — stop and record the case rather than invent
  policy.
- A test requires external network, a real gh credential, or a real SDK host boot in a unit
  suite — rework the fixture instead.
- The PR-linking identity helpers are not yet landed — this PR is blocked; do not re-implement
  PR identity locally.

## Final implementation record (handoff)

Landed on branch `feat/prtrack-0-foundation`, PR opened against `feat/pr-tracking-base`.

**Changed files**

- `src/core/api-contract.ts` — version-1 `GitHubPrTrackingRecord` contract
  (`githubPrTrackingRecordSchema`): `schemaVersion`/`revision`, PR identity, `orphanedAt`,
  access-scoped metadata snapshots, task bindings with terminal stop/reopen/merge-completion
  markers, monotonic link generations, comment-automation block, and the reservation block.
  Provider-free contract types only; no runtime behavior.
- `src/pr-tracking/` (new)
  - `pr-identity.ts` — canonical PR key parse/build/digest reusing the PR-linking identity
    (`getPullRequestIdentityKey` in `src/core/pull-request-links.ts`) and
    `recordIdentityMatchesKey` validation.
  - `pr-record-store.ts` — `PrRecordStore` (revision-checked atomic updates under the
    tracking-registry mutex), `getPrTrackingRootPath()`,
    `getPrTrackingSchedulerLockRequest()`, `getPrTrackingRegistryMutexRequest()`, and the
    24-hour orphan-retention constant.
  - `github-gh-adapter.ts` — `GitHubGhAdapter`/`createGhAdapter`: noninteractive
    `gh api --hostname github.com` via direct `execFile` + `createGitProcessEnv()`, 30-second
    timeout, 8 MiB per-page bound, full REST + GraphQL pagination, per-source ETag/conditional
    reads, structured `GhAdapterFailure` taxonomy (auth, rate_limit with reset deadline,
    not_found, network, timeout, buffer_bound, partial_page), runtime-wide four-read
    in-flight cap.
  - `pr-snapshots.ts` — normalized access-scoped metadata/feedback snapshots,
    freshness/staleness (`PR_SNAPSHOT_STALE_AFTER_MS` = one poll interval + jitter), body
    digests, and `prKeyDigest`.
  - `pr-tracking-coordinator.ts` — `createPrTrackingCoordinator`: one runtime-wide
    coordinator; per-`(prKey, accessScopeId)` poll state; demand-union eligibility
    re-evaluated before every read; 60 s cadence with jitter; 60/120/240/480/900 s backoff
    capped at 900; rate-limit reset deadlines override backoff; terminal stop reasons
    persisted (no rearm on restart); merged reconciliation capped at three reads per
    episode; explicit `refresh` coalesces into the in-flight read; `resumePrTracking`
    performs one fresh authoritative read; orphan classification pass at `start()`.
- `src/server/runtime-server.ts` — coordinator created in the server startup path,
  `start()` awaited (non-blocking: orphan pass is background, scheduler lock lazy),
  `stop()` awaited in `close()` before the runtime state hub closes. `workspace-registry.ts`
  needed no changes.
- `test/runtime/pr-tracking/` (new) — `pr-identity`, `pr-record-store`, `pr-snapshots`,
  `github-gh-adapter` (fake `gh` executable on PATH; no real network), and
  `pr-tracking-coordinator` (fake timers + fake adapter; in-memory store) suites.
  - `in-memory-pr-record-store.ts` — `InMemoryPrRecordStore`, a deterministic
    `PrRecordStoreBase` backend (same CAS semantics, no fs I/O / lockfile timers)
    so coordinator tests run under fake timers with exact timing and shared-state
    assertions (two coordinators, one store object). Production keeps the disk
    `PrRecordStore`; the in-memory store is test-only.

**Record location/format.** `join(getRuntimeHomePath(), "pr-tracking", "prs",
<sha256(canonicalPrKey)> + ".json")`, schema version 1, revision-checked. Rollback: records
are inert without consumers; unknown fields/versions are preserved by the revision-checked
store, never clobbered.

**Lock scopes (distinct `path`s — proper-lockfile keys its in-process map by `path`).**

- Scheduler lock: `path = join(getRuntimeHomePath(), "pr-tracking")` (directory), on-disk
  lockfile `.scheduler.lock`. Acquired lazily on first eligible subscription; a failure
  blocks only the PR-tracking scheduler (state `schedulerBlocked`, add-subscription returns
  `blocked`), never the runtime, with a visible log line.
- Tracking-registry mutex: `path = join(getRuntimeHomePath(), "pr-tracking", "registry")`
  (directory), on-disk lockfile `registry/.registry.lock`. Serializes all shared record
  updates; never held while awaiting network/model work.

**Test results.** `npx vitest run test/runtime/pr-tracking/` — 5 files / 64 tests passing.
`npx tsc --noEmit` clean. `npx @biomejs/biome check` clean for all changed files.

**PR 64 review responses (second round)**

- Per-source feedback retention: the coordinator keeps the last successfully-read events
  per source (`reviews` / `conversationComments` / `inlineComments` / `threads`) and
  publishes the union; a source reporting `not_modified` (or a failed source keeping
  last state) never freezes the changed ones. Fresh-thread flags are re-applied to
  retained inline events at publish time.
- A failed feedback source counts as a cycle failure (backoff ladder) instead of being
  silently swallowed by the success path.
- A failed metadata snapshot write sets a per-PR `metadataNeedsFresh` flag so the next
  read is forced fresh and the applied state catches the recorded body digest.
- Access failures (`403`/`451`, category `access`) stop ALL polling (every poll
  cancelled, visible `accessBlocker` in state) instead of retrying on the backoff
  ladder; an explicit refresh re-probes and clears the blocker.
- Orphan classification joins managed boards across workspaces and counts only
  In Progress / In Review cards as live links (a Done card does not keep polling).
- Adapter thread reads paginate comments within a thread (no 100-comment truncation)
  and carry `resolved` / `outdated` / `deleted` separately (`outdated` is not
  treated as deleted); deleted threads keep their node id in the thread map.
- Coordinator tests now use the deterministic `InMemoryPrRecordStore` (fake timers
  with exact timing; a second runtime with a different access scope shares the same
  store object); the disk store keeps its own suite for fs/CAS behavior.

**Deviations/refinements noted during implementation**

- Coordinator error logging goes through an injectable `logError` callback (default no-op);
  the runtime server routes it to the existing `deps.warn` abstraction instead of a direct
  `console.error` (Biome forbids direct console calls in `src/`).
- The coordinator accepts an injectable `schedulerLockRequest` (and store, clocks, RNG) for
  testability; production defaults match the fixed decisions above.
- No baseline drift found against 49a2ca05c6c2927da2194aaec8bd1e45e6fa2928; the PR-linking
  identity helpers were already landed.

