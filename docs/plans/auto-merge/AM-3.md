# AM-3: Fail-closed merge eligibility and lifecycle orchestration

**Status:** planned. **One implementation PR into `main`.** Depends on: AM-2. Read [README.md](./README.md).

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
