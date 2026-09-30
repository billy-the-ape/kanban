# pr-feedback-repair-1 — Bounded Feedback Repair and Lifecycle

**Status:** Planning
**Implementation repository:** `billy-the-ape/kanban`
**Full plan:** [PR feedback repair](pr-feedback-repair-full-plan.md).
**Depends on:** [card 0](pr-feedback-repair-0.md); existing review/verification/delivery services.
Approved manifest export needs behavior card 9; structured report support needs card 10.
Do not infer criteria from the writer summary while those contracts are unavailable.
**Scope:** One PR wiring ready batches into existing fresh sessions and durable delivery.

## Objective

Complete write → PR review → scoped repair → verification → push → new review, using local
models and a bounded durable state machine. No automatic merging.

## State and handoff

States: awaiting-review, debouncing, ready, repairing, verifying, delivering,
awaiting-new-review, needs-human, merged, closed. Reuse existing task lifecycle primitives
rather than creating a competing task dispatcher. Persist transitions and pause reason.

Create a fresh repair session with original approved manifest and plan snapshots, live
head/base, affected code and normalized findings. Do not append an unbounded writer history
or repeat the Auto PR prompt. Export the behavior-card-9 manifest from the approved task handoff,
including an approved immutable source policy; never generate acceptance criteria solely
from the writer's completion summary. Publish manifest references through existing delivery.
Reconcile reporter/requirement IDs and SHA/digest across provider-specific adapters.

Atomically reserve one batch and one writer slot per task/worktree. If any writer, review,
verification, delivery or manual task operation is active, queue rather than inject a message
into that session. Feedback arriving during repairs becomes the next batch, never a second
concurrent writer. A per-model budget must cover these sessions; one Actions runner does not
serialize Kanban's separate local-model requests. Use existing admission/worker controls;
if a shared model admission primitive is absent, implement a documented cooperative gate
for these two clients rather than assuming GPU exclusivity.

The agent assesses findings against code and may reject incorrect advice with evidence.
Repair only defects within the original scope; new requirements, ambiguous large changes,
authority mismatch and security/policy modifications require operator intervention.
Re-run configured deterministic checks using existing verification-service receipts bound to
the candidate tree. Do not weaken checks to obtain a pass. Tests execute only in Kanban's
existing authorized development workspace; never inside the privileged PR review Action.

Use existing deterministic delivery to commit/push the same PR branch after checks pass.
Prevent branch drift or dirty manual edits from being overwritten. If HEAD changes before
delivery, stop/reconcile instead of force pushing. Recovery after push must inspect the
receipt/remote state, not push again blindly. Publish concise per-finding responses through
existing authenticated API support when enabled, with commit/test evidence; no model may
invent successful checks. Thread resolution is optional and never treated as proof by itself.

## Bounds and durable acknowledgement

Default maximum three automatic repair cycles per task/PR, shared across feedback batches,
not reset by comments, rebases or restarts. Also bound wall time/model calls/output and stop
on two repeated no-progress cycles (unchanged content or recurring unresolved findings).
Persist the consumed budget; explicit operator action resumes/reset with an audit record.
Crashes during an uncertain agent turn enter recovery/needs-human unless service receipts
establish safe continuation. Do not promise exactly-once external side effects without receipts.

A batch becomes addressed only after verified delivery or an evidenced rejection of feedback;
failures retain retryable status. An uncertain publication is reconciled via provider IDs and
idempotency markers before replay. Await a review of the new HEAD, not an approval on the old
commit. Do not mark the task done because the worktree is clean or PR creation succeeded.
Merge detection completes the opted-in lifecycle; closed-unmerged is a separate visible state.

## Acceptance and tests

- One debounced review causes one fresh repair, verified push and new-review wait.
- Feedback during active writing queues; no duplicate PR prompts or competing sessions.
- Repeat delivery after crash reuses receipt; no duplicate commit/push/reply.
- Failed checks, stale HEAD, manual edits, missing spec and round limit stop visibly.
- Bad reviewer advice is rejected with evidence, without an unrelated code change.
- Approval for old HEAD never completes current work; merge closes the lifecycle.
- End-to-end local-model pilot records rounds, tokens, checks and outcomes with timestamps.

## Deployment and rollback

Separate monitor, auto-repair and auto-reply switches, all off by default. Dry-run batch
inspection first, then one test task, then limited opted-in projects. Disabling auto-repair
retains pending state/worktrees and permits manual work. Maintain human merge approval.
After deploying monitor/repair services or changing AI-MONSTER operations, open a final
Ready for Review PR in homelab-documentation recording backend/service placement, storage,
credential references, local model contention, outbound-only networking and rollback.

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
