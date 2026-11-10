# AM-2: Exact-head GitHub review and CI evidence reader

**Status:** implemented. **One implementation PR into `main`.** Depends on: AM-1. Read [README.md](./README.md).

Implementation notes (final state):
- `src/pr-tracking/auto-merge-evidence.ts` owns the bounded reader: `collectAutoMergeEvidence` re-reads authoritative PR metadata at the start and after source collection, discards on any head/base change (`head_changed`), reads reviews/check-runs/commit-statuses to completion in parallel, and assembles the complete-or-incomplete envelope (`complete`, stable `reasons`, per-source `sources`, `checkedAt`, `policyRevision`, `headSha`/`baseSha`).
- The envelope schemas live in `src/core/api-contract.ts` (`autoMergeEvidenceEnvelopeSchema`, `autoMergeCheckEvidenceSchema`, `autoMergeReviewEvidenceSchema`, `autoMergeEvidenceSourcesSchema`, `AUTO_MERGE_EVIDENCE_SCHEMA_VERSION = 1`); `githubPrMetadataSnapshotSchema` gained nullable/optional `baseSha`, `mergeable`, `authorLogin`, and `autoMergePresent` projected from the same read.
- `github-gh-adapter.ts` gained `readRawRestList` (complete multi-page raw list; mid-list failure or an unreconstructable 304 is `partial_page`, never a silent truncation) and `readCommitStatuses` (pages exhausted before `total_count` is an ambiguous/partial read).
- `pr-tracking-coordinator.ts` exposes `readAutoMergeEvidence(canonicalPrKey, accessScopeId?, { policyRevision, declaredHeadSha? })`: consumer-requested (no new timer, no poll re-arm, no record mutation), coalesced per (PR, scope), scope-validated, rate-limit-deadline honoring (reports `rate_limited`, never waits or retries), and routes adapter failure categories through the shared `handleFailure` classification (auth stops all polls; access stops the (PR, scope); rate limits extend the deadline).
- Reviewed in `test/runtime/pr-tracking/auto-merge-evidence.test.ts` (normalization, scripted-adapter reader matrix, coordinator wiring).

## Deliverable

A bounded, injectable, **read-only** GitHub evidence component returning complete or explicitly incomplete evidence for one canonical PR, access scope and exact head SHA. No merge execution, no decision to arm, and no new independent timer.

## Design

- Reuse `GitHubGhAdapter`'s noninteractive `gh api`, active credential scope, read concurrency, timeout/backoff/rate-limit classification, and `PrTrackingCoordinator` subscriptions. Integrate by a narrow opt-in-specific read on the existing ~60-second PR cycle (or a consumer-requested read) only when auto-merge demand exists. **No check/review polling** for unrelated tasks.
- Read authoritative PR metadata (`state`, `draft`, `base.repo.full_name`, `base.ref`, `base.sha`, `head.repo.full_name`, `head.ref`, `head.sha`, `mergeable`/`mergeable_state`, author, `auto_merge` when present). Existing `normalizePrMetadata` does not contain every required fact; add explicit fields or a scoped merge-evidence envelope.
- Read all pages of **submitted GitHub reviews** through `/repos/{repo}/pulls/{number}/reviews`; keep review `state`, actor, `commit_id`, `submitted_at`, and identity. The existing comment-feedback `normalizeReviews` reduces `state` to pending/submitted; it is **insufficient** for merge approval. Do not infer APPROVED from the feedback body digest.
- Read **check-runs** for the current head (`/repos/{repo}/commits/{sha}/check-runs`) and **commit statuses** (`/repos/{repo}/commits/{sha}/status` or complete statuses endpoint). Preserve app/source ID, check name/context, `status`, `conclusion`, SHA, and run identity. Follow pagination to completion, handle duplicate contexts/re-runs with a documented latest-run rule, and never let a success from an old attempt mask a newer failure/pending attempt. Explicitly distinguish complete-empty from missing/partial data.
- Read review-thread resolution when needed via existing GraphQL capability; unresolved active threads are a blocker, even if unrelated comments have positive wording. Keep raw bodies out of persistent approval and UI records.
- **Coherent snapshot:** collect for a declared `headSha`, then re-read PR head/base/selected identity; if any changed, discard the evidence (retry next eligible cycle). An old success, even if recently observed, is never evidence for the new head. Track complete source lists, checked timestamp, accessScopeId, head/base SHA and policy revision in the evidence envelope.
- Auth failures, 403, 404, timeout, paging cap, rate-limit, GraphQL error, status API ambiguity and HEAD churn are **unknown**, never "green". Avoid persisting large response bodies. Provide a reusable pure normalization layer with injected runner/test fixtures.

## Expected files

`src/pr-tracking/github-gh-adapter.ts`, `src/pr-tracking/pr-snapshots.ts`, `src/pr-tracking/pr-tracking-coordinator.ts`, `src/core/api-contract.ts`, new `src/pr-tracking/auto-merge-evidence.ts`, and focused `test/runtime/pr-tracking/` suites. Keep existing feedback reads/merge-completion contracts unchanged for tasks that do not opt in.

## Acceptance tests

1. Multi-page reviews, check runs and statuses produce complete, exact-head evidence; failing page 2 blocks, not truncates.
2. Submitted `APPROVED` events retain state, actor and `commit_id`; pending, dismissed, old-head approvals and text-only comments are not misclassified.
3. Success on an earlier SHA cannot satisfy current-head check names; duplicate check reruns choose the effective latest attempt.
4. Partial/empty/unauthorized reads, mergeability unknown, pending CI and base/head changes yield an explicit unknown/blocker.
5. Poll coalescing, auth-context rotation, bounded requests and backoff stay intact. No writes to GitHub.

## Deployment

Read-only enhancement. Existing `gh` login needs read access to pull request reviews, checks, statuses and relevant review-thread data. No new environment variables or migration; no merge behavior yet.
