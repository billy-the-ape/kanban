# AM-3: Fail-closed merge eligibility and lifecycle orchestration

**Status:** implemented. **One implementation PR into `main`.** Depends on: AM-2. Read [README.md](./README.md).

## Deliverable

A pure deterministic **fixed V1** policy evaluator and subscriber integration that reports **eligible / waiting / blocked** with machine-readable reasons and evidence timestamps. V1 requires passing configured CI and **at least one** effective approving review. Do not implement configurable approval thresholds or arbitrary conditions; do not perform a GitHub merge in this PR.

## Exact eligibility contract

Evaluate one selected automation PR against task, policy and coherent GitHub evidence. **Eligible** only when all hold:

- Task is in `in_progress` or `review`, opt-in true, policy revision matches its arm, exactly one selected/sole matching automation PR resolves to the task's expected repository and target base, and no other concurrently eligible task claims the same canonical PR.
- PR is GitHub `open`, not `draft`, target base is correct, head and base identities complete, no conflicting merge attempt/native auto-merge, and GitHub reports mergeable without conflicts (unknown blocks).
- Required check contexts list is explicit and nonempty; every named check exists and the latest matching **current-head** check concluded `success`. Any observed relevant pending/failure/cancelled/unknown check, missing required context or incomplete paginated list blocks. GitHub's absent branch protection must **not** turn "no required checks" into green.
- **At least one (not exactly one)** effective **submitted APPROVED** review from a non-author on the exact HEAD (including valid bot reviewers); take latest non-dismissed submitted decision per reviewer. A later `CHANGES_REQUESTED` by any reviewer blocks until superseded by that reviewer's valid current-head approval or dismissed by GitHub. No approval by description/issue comment/label. Unknown reviewer identity, dismissed-only, pending-only, stale head or inconsistent ordering blocks.
- No unresolved actionable review thread, comment-repair dispatch outstanding/failed/paused with pending feedback, active writer, head-ref or PR reservation, or other existing operation that could be changing the PR. Do not merge while review repair might race its commit.
- Authorization/credential scope matches the snapshot and task binding; stale snapshots and changed settings/PR links produce **waiting** or **blocked**, never eligible.
- GitHub repository rules remain independent and authoritative: GitHub may require more approvals, CODEOWNERS, deployments or other requirements. Kanban V1 eligibility means only that its own fixed trigger is satisfied; the executor must surface GitHub rejection and fail closed.

The evaluator is independent of the UI; return structured `kind`, blocker code(s), `evaluatedAt`, `headSha`, `baseSha`, `policyRevision`, and evidence age. Specify ordering and short messages for combinations (e.g. CI still running vs review missing). An explicit permission/configuration error is `blocked`; an ordinary pending check or missing approval is `waiting`.

## Orchestration contract

- Extend existing `PrConsumerRegistry`, `PR_CONSUMER_READ_SOURCES`, `PrTaskSubscriptionDemand` and coordinator to recognize a third `autoMerge` demand/consumer (names may follow current conventions). Preserve existing comment and merge-completion observers, terminal subscription stops, access-scoped coalescing and in-flight fencing.
- Read costs scale with **opted-in** PRs only. No parallel interval runner; no aggressive retry loops for pending CI or reviews; use coordinator's existing poll/backoff. UI polling is presentation-only.
- Persist at most a small eligibility summary/diagnostic in the existing PR record, never the entire review/check list; prefer transient evidence with timestamps. Recompute after task preference, selected PR, policy revision, or auth context changes. Ensure disable/move-to-Done/unlink stops attempts immediately.
- When eligible, emit an internal handoff callback to AM-4's future executor. In this PR supply a no-op/injected recording adapter. No shell commands to merge, no GitHub write.

## Expected files

`src/pr-tracking/pr-consumer-registry.ts`, `pr-task-subscriptions.ts`, `pr-tracking-coordinator.ts`, `pr-lifecycle-gate.ts` (only if needed; don't change clean-tree completion accidentally), `pr-record-store.ts`, `src/core/api-contract.ts`, new `src/pr-tracking/auto-merge-eligibility.ts`, and coordinator/unit tests.

## Acceptance tests

- Table-driven approvals (current/old/changed/dismissed/bot/self), zero/missing/pending/rerun CI, unrelated failing checks, unprotected branch, base/head race, unresolved thread, active repair/writer, and ambiguous linked tasks.
- Enabled/disabled subscription changes, restart, auth rotation and terminal stop behavior produce no duplicate polling or unintended merge-completion events.
- Approval+CI order is irrelevant: either may arrive first, and eligibility becomes true only after both are current. One or multiple valid approvals pass the V1 minimum; an effective change request blocks despite any other approvals.
- No live merge request is possible from AM-3.

## Deployment

No new credentials, environment variables or migrations. Existing behavior unchanged until AM-4 binds execution and AM-5 exposes the opt-in control.

## Final state (implemented)

- **New `src/pr-tracking/auto-merge-eligibility.ts`** holds the pure evaluator and the `autoMerge` consumer observer:
  - `AutoMergeEligibilityResult` (`schemaVersion 1`, `kind: "eligible" | "waiting" | "blocked"`, ordered blocker codes/messages, `evaluatedAt`, `headSha`, `baseSha`, `policyRevision`, `evidenceCheckedAt`, `evidenceAgeMs`). Blocked-vs-waiting is decided by the fixed `AUTO_MERGE_BLOCKED_CODES` array (configuration/identity/auth/evidence-identity problems block; ordinary pending conditions wait).
  - `classifyAutoMergeReviews` (per-reviewer latest submitted decision; valid current-head non-author approval required; CR blocks until a strictly-later valid approval; tied timestamps → `review_inconsistent`; dismissed reviews contribute nothing — fail-closed) and `classifyRequiredChecks` (exact-name match across check runs + commit statuses; effective attempt is the latest by occurredAt then runId; neutral/skipped conclusions are never success; empty policy check list → `no_required_checks`).
  - `reconcileAutoMergeEligibility` observes coordinator observations: it re-reads the task's card, requires the opt-in to be live and armed, requires the card's resolved automation PR to match the observation's PR (stale selections are skipped), requests the consumer coalesced evidence read, persists at most the small `autoMerge` summary on the task binding, and calls the injected `onEligible` handoff (AM-4 will bind the real merge) only when eligible. `registerAutoMergeConsumer` wires the kind into the registry (metadata-only read demand).
- **Contracts** (`src/core/api-contract.ts`): new `autoMergeEligibilityResultSchema` / `autoMergeEligibilitySummarySchema` (schema version 1) plus the shared `AUTO_MERGE_ELIGIBILITY_SUMMARY_MAX_CODES` cap on persisted blocker codes; `runtimePrConsumerKindSchema` gained `"autoMerge"`; `githubPrTaskBindingSchema` gained `autoMerge: autoMergeEligibilitySummarySchema.nullable().optional()`; and `runtimeTaskTrackingStateResponseSchema` gained `autoMergeEligibility` (null until observed). The `mergeMethod` field on `autoMergePolicySchema` and the comment-automation opt-in/armed response fields pre-date this PR (AM-1) — they are not additions here.
- **Subscriber integration**: `PR_CONSUMER_READ_SOURCES.autoMerge = ["metadata"]`; `PrInstalledConsumers` gained an `autoMerge` flag; task demand requires opt-in true **and an armed revision present** and In Progress/In Review; the coordinator seeds the in-memory replay event sequence from the **highest persisted cursor across consumers** on restart; `readTaskSnapshotEvents` accepts the `autoMerge` consumer.
- **Lifecycle gate** (`src/pr-tracking/pr-lifecycle-gate.ts`): an armed opt-in with the installed consumer gates legacy completion (`legacyCompletionGated`) so clean-tree completion cannot race a pending auto-merge; `mergeFinishesInReview` still reflects only `autoFinishOnMerge`. The CLI `task complete` gate passes the installed consumers accordingly.
- **Server wiring** (`src/server/runtime-server.ts`): the autoMerge consumer is registered with a lazy coordinator accessor (registry-first ordering), policy reads from the AM-1 policy store, writer admission from `probeTaskWriterActive`, and `onEligible` currently only logs the eligibility handoff (AM-4 performs the merge). No merge path, no GitHub writes, no new timers.
- **Default binding** gains `autoMerge: null`; the AM-1 arming API and the `prTracking.autoMergePolicy` API surface are unchanged by this PR.

## Implementation notes (deviations worth remembering)

- A dismissed GitHub review's original decision (approval vs CR) is not recoverable from the evidence envelope, so dismissed reviews contribute nothing and an un-dismissed CR keeps blocking (fail-closed), rather than modeling GitHub dismissal of the CR as a supersede.
- `comment_repair_pending` fires for any non-completed comment-repair dispatch (`queued`/`running`/`failed`): the service clears the pending feedback fingerprint when a dispatch is authorized (running) and again on failure, so the fingerprint must not be part of the guard. A failed dispatch keeps blocking until a later dispatch replaces it.
- Subscription demand requires the armed revision to exist on the card; the evaluator still enforces the full policy-revision match (`policy_mismatch`) and fails closed on a stale arm.

