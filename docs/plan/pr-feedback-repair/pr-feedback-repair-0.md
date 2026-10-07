# pr-feedback-repair-0 — Durable PR Feedback Monitor

**Status:** Planning
**Implementation repository:** `billy-the-ape/kanban`
**Full plan:** [PR feedback repair](pr-feedback-repair-full-plan.md).
**Depends on:** current deterministic delivery receipts and task lifecycle.
Human-review monitoring can be implemented independently of AI Gateway rollout.
**Blocks:** [card 1](pr-feedback-repair-1.md). Structured reports/manifest support integrate
with [behavior cards 9–10](https://github.com/billy-the-ape/ai-gateway/blob/docs/pr-review-requirement-accounting-plan/docs/plans/pr-review-behavior/pr-review-behavior-updates-full-plan.md); they do not block human-feedback collection.
**Scope:** One Kanban PR: durable mapping, polling, normalization and debounce. No agent launch.

## Objective

Collect actionable external PR feedback while the UI is closed, without inbound networking.
Use a backend service, not use-review-auto-actions.ts or browser-localStorage timers.

## Implementation

Extend deterministic delivery receipts with repo/PR URL/number/head branch/delivered SHA,
task/workspace identity and approved requirement digest. Recover mappings for already opened
PRs explicitly; never infer ownership from a branch name alone. Preserve the worktree while
awaiting review. "PR delivered" is distinct from "task merged/done"; keep legacy behavior
for tasks not opted into external feedback automation.

Poll linked open PRs every 60 seconds by default while the Kanban backend runs. No work occurs
when that backend is offline; durable catch-up occurs at restart. Paginate submitted reviews,
inline comments/threads and PR conversation comments; preserve resolution/outdated status and
review commit IDs. Use conditional requests/backoff and rate-limit handling. Fetch failures
must not advance cursors. Handle edited and deleted comments as well as newly created ones.

Normalize feedback with provider ID, author, review ID, body digest/update version, commit,
path/line, thread status and actionable kind. Configured author allowlist may include the
reviewer App bot. Ignore own repair replies/status messages, approval-only messages and
resolved threads; revalidate old/outdated findings before treating them as current work.
Untrusted comment text is evidence to inspect, not an instruction to disclose secrets or
change task scope. Ambiguous top-level feedback can be shown for operator triage.

Persist pending batches, event versions, cursors, last eligible change time and due time.
Use five minutes of quiet by default (configurable to ten); eligible edits reset debounce.
Submitted bot reviews/versioned complete reports form explicit batches; do not execute pending
unsubmitted review drafts. Before a batch becomes ready, re-fetch live HEAD and thread state.
A HEAD change invalidates readiness pending reconciliation against current code.

Do not start repair here. Expose ready batches via backend/UI with current SHA/spec digest.
Provide atomic reservation and acknowledgement interfaces for card 1; acknowledging an event
is distinct from seeing it. Durable leases permit recovery after backend crashes.

## Acceptance and tests

- Three feedback events in one review produce one ready batch after quiet time.
- Duplicate poll results and edited comments do not disappear or create duplicate batches.
- Pagination, rate limit, API failure and restart preserve pending work and deadlines.
- Resolved/deleted/outdated/own comments are excluded or visibly require reconciliation.
- Mapping remains available after PR delivery; UI closure does not stop backend monitoring.
- New SHA and merged/closed PR cancel obsolete readiness without marking feedback repaired.

## Deployment settings

Per-project opt-in defaults off; configurable reviewer allowlist, 60-second polling and
300-second debounce; credential references reuse the repository's existing authenticated
GitHub access mechanism after inspection. Current delivery uses gh for PR operations;
that implementation detail does not establish an API monitor auth contract. Reuse an
explicit existing credential or document a backend API adapter with equivalent permissions.
Do not assume ChatGPT OAuth is installed inside Kanban or add an inbound endpoint. Document required token permissions and
persistent storage location, avoiding private-key duplication. No homelab changes in this PR.

## Delivery and validation

Open one Ready for Review PR in the target repository for this card. Its description must
prominently list deployment settings/actions (or explicitly say none), every feature added,
and reproducible steps to test each feature. Follow that repository's AGENTS.md and
formatting configuration before committing. Use narrow tests first, then its required
lint/typecheck/test checks. Do not count scripted model responses as evidence of model quality.
No automatic merge is introduced by this series.

## Existing integration points

Inspect `src/core/api-contract.ts`, `src/workspace/git-delivery.ts`,
`src/workspace/task-review-handoff.ts`, `src/task-dispatch/task-dispatch-service.ts`,
`src/task-dispatch/dispatch-records.ts`, `src/cline-sdk/cline-review-session-service.ts`,
`src/cline-sdk/review-prompt.ts` and `src/verification/verification-service.ts`.
Use backend lifecycle control; `web-ui/src/hooks/use-review-auto-actions.ts` is not an
always-running monitor. Existing delivery receipts track candidate-tree verification and
resumable publication; extend/reuse them instead of a second commit/push loop.

Delivery may integrate into a destination branch using a detached task worktree. Record the
actual remote PR head and verified delivered tree, and explicitly restore/reconcile the
repair worktree to that revision before writing. Do not assume the task worktree branch
equals the PR head branch. Define dependent-card unlocking for opted-in PR lifecycles:
a dependent must not consume unmerged work based only on a delivered receipt unless its
pinned feature-branch policy explicitly permits it. Keep legacy behavior for other tasks.

Follow AGENTS.md and Biome; Markdown is outside the current formatter includes.
Persist lifecycle/feedback state through locked atomic writes and schema validation.
Tests touching task state/worktrees/receipts use isolated temporary homes as AGENTS.md requires.
