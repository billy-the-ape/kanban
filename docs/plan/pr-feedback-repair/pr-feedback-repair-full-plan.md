# Durable PR Feedback and Bounded Repair — Full Plan

**Updated:** 2026-09-30
**Status:** Proposed; planning only
**Repository:** `billy-the-ape/kanban`
**Directory:** `docs/plan/pr-feedback-repair/`

## 1. Goal and scope

Extend the local write → review → update loop so Kanban monitors external PR feedback,
waits for a stable batch, runs a fresh scoped repair, verifies and updates the same PR.
Use local models and existing delivery/session services. Human merge approval remains in place.
Backend monitoring requires Kanban to remain running, but works with the UI closed.
All new automation is opt-in and defaults off. No inbound ports or webhook server.

| Card | Document | Scope | Dependencies |
| --- | --- | --- | --- |
| 0 | [feedback monitor](pr-feedback-repair-0.md) | Durable task/PR mapping, lifecycle retention, polling, normalization, debounce, batch reservations; no agent launch | Existing delivery/state services |
| 1 | [bounded repairs](pr-feedback-repair-1.md) | Fresh repair, authority handoff, verification, same-PR delivery, crash recovery and lifecycle budgets | Card 0; behavior manifest/report contracts for corresponding integrations |
| Final operational task | Separate homelab-documentation PR after deployment | Actual backend/service/storage/credential/model-admission state and rollback | Actual service/device changes |

These two implementation cards relocate Action follow-ups 7–8. They target Kanban, not the
gateway. If implementation reveals a missing shared admission primitive, isolate that
dependency explicitly instead of silently expanding a card.

## 2. Plan boundaries and dependency order

The [Action plan](https://github.com/billy-the-ape/ai-gateway/blob/feat/pr-review-action/docs/plans/pr-review-action/pr-review-action-full-plan.md)
owns event-driven review execution, App auth, cutover and poller cleanup.
The [behavior plan](https://github.com/billy-the-ape/ai-gateway/blob/docs/pr-review-requirement-accounting-plan/docs/plans/pr-review-behavior/pr-review-behavior-updates-full-plan.md) owns engine quality, pinned approved requirements
(card 9), exhaustive ledger/reports (card 10), and broader evaluations (card 11).
Behavior cards 0–4 are done, card 5 is in flight; Kanban must not reopen that work.

Card 0 can collect human feedback before gateway changes land. Card 1 needs a trustworthy
approved original task handoff even when structured reports are unavailable. Manifest export
uses behavior card 9's versioned contract; report ingestion uses card 10's exact SHA/digest
identity. Do not make the entire monitor depend on chat tools or machine-readable artifacts.
Rollout order: inspect batches → one repair pilot → limited projects after gateway Action
cutover and quality baseline. No PR-Agent adoption in this series.

## 3. Existing code and lifecycle

Reuse delivery receipts in `src/workspace/git-delivery.ts`, handoffs in
`src/workspace/task-review-handoff.ts`, dispatcher records in `src/task-dispatch/`,
fresh sessions in `src/cline-sdk/`, and `src/verification/verification-service.ts`.
Contract changes belong in `src/core/api-contract.ts`. Existing PR delivery invokes gh;
inspect its actual auth without assuming this chat's OAuth exists on the host.
A backend API adapter should reuse explicit authorized credentials, paginate every source,
and document required read/write permissions. Avoid duplicate key storage.

Opted-in tasks retain worktrees and enter awaiting-review after delivery. They complete on
merge, with closed-unmerged separately visible. Existing tasks retain legacy behavior.
Specify how column transitions, preservation cleanup and dependent-task unlocking consume
the new lifecycle so a done event cannot delete a repair workspace or unlock work prematurely.
Delivery may integrate detached task work into another branch; map and reconcile actual
remote head and candidate tree rather than assuming worktree HEAD equals PR HEAD.

States: awaiting-review → debouncing → ready → repairing → verifying → delivering →
awaiting-new-review; failures/limits enter needs-human. Merge/close are terminal states
after reconciliation. UI shows current reviewed/delivered SHA, pending count, next due time,
round budget and pause reason with manual resume controls.

## 4. Durable feedback collection (card 0)

Persist task/workspace ↔ repo/PR/branch/delivered SHA/approved requirement digest mapping in
existing delivery receipts. Opted-in tasks enter awaiting-review and retain their worktree;
PR delivery is no longer task completion. Legacy tasks preserve their current lifecycle.

Backend polling defaults to 60 seconds, with pagination, conditional requests, rate-limit
backoff and durable cursors. Read submitted reviews, inline threads/comments and conversation
comments, including updates/deletions/resolution. Monitor only explicitly linked PRs with
existing authenticated access. No inbound networking or dependency on browser presence.
Offline backend pauses work; restart catches up from durable state.

Normalize event IDs/versions, authors, review IDs, body digests, SHA/path/line and thread
status. Allowlisted reviewer bots are eligible. Ignore own repair replies/status noise,
approval-only feedback and resolved threads. Reconcile outdated feedback against current code;
untrusted feedback cannot authorize scope changes or arbitrary commands.

Collect a batch after five minutes of quiet (configurable to ten), reset by eligible feedback
changes. Submitted review/complete report is a natural bot batch boundary; never process
pending unpublished reviews. Persist due times across restarts. Re-fetch HEAD/thread state
before readiness; changing HEAD requires reconciliation. Card 0 exposes batches only,
with atomic reservations/leases and separate seen/addressed cursors; it launches no agent.

## 5. Bounded repair loop (card 1)

Use existing fresh review/session, deterministic verification and delivery services.
Reserve one task/worktree writer slot. Queue while any writer/reviewer/verification/delivery
or manual operation is active. New feedback during repair becomes a subsequent batch.
Do not inject feedback into an old long writer transcript or repeat Auto PR instructions.

A fresh repair receives approved original spec, current code and normalized feedback.
It checks advice, fixes scoped defects or records an evidence-backed rejection. New scope,
uncertain large edits and changed source authority enter needs-human. Run configured checks
in the authorized Kanban environment, tied to candidate tree; do not weaken tests/gates.
Commit/push the same PR via existing receipts after verification. Stop on branch drift or
manual edits rather than force pushing. Reconcile unknown publication outcomes before replay.
Optional replies identify actual repair commit/check results; do not invent successful tests.

Default lifecycle-wide limit: three automatic repair cycles, plus per-turn time/token bounds.
Two no-progress cycles also stop. Persist budgets across comments/restarts/rebases; operator
resume/reset is explicit and audited. Leases and durable receipts govern crash recovery;
uncertain execution stops for reconciliation, not unconditional replay.

Wait for review of the new HEAD. Approval on an old commit does not complete current work.
Only merge detection completes the opted-in task; closed-unmerged is separately visible.
No auto-merge. Independent monitor/repair/reply switches default off; inspect batches first,
pilot one task, then limited projects. Disable automation without losing pending feedback,
worktrees or manual control.

After actual operational deployment of these services, a final homelab-documentation PR
records backend location/storage, model admission/contending clients, credential references,
outbound access and rollback. Do not write machine state as deployed before it is deployed.

## 6. Configuration, deployment and rollback

Separate monitor/auto-repair/auto-reply switches default off. Proposed policy defaults:
poll every 60 seconds; 300 seconds quiet debounce (configurable to 600); three lifecycle
repair cycles; two no-progress cycles stop. Persist counters and due times across restarts.
The implementation cards choose configuration names in existing runtime policy conventions
and document them, storage, credential sources/permissions, local model limits and operator
reset/audit behavior. No secrets in logs; operational events include timestamps.

Use actual cooperative model admission for Kanban and reviewer clients, or explicitly
state bounded independent admission and its limitations. A single Actions runner is not
a GPU-wide lock. Never run untrusted PR checks on the privileged review runner.

Disable repair to retain batches/worktrees and manual control. Drain active delivery before
changing auth/config; do not erase receipts or blindly replay uncertain pushes. After actual
host/service changes, append a Ready for Review homelab-documentation PR documenting reality.
Planning itself does not change a device and must not claim the service is deployed.

## 7. Validation and completion

Card 0 covers pagination, edits/deletes/resolution, duplicate snapshots, own messages,
bot allowlisting, quiet-time resets, API/backoff failures, restart catch-up and stale heads.
Card 1 covers concurrent writers/manual work, false reviewer advice, failed verification,
branch drift, accepted-but-response-lost publication, persisted round caps, approval on old
HEAD and merged/closed lifecycle. Use narrow meaningful tests, required repository checks,
and an end-to-end local-model pilot. Scripted model fixtures prove plumbing, not review quality.
API/state tests isolate home/storage according to AGENTS.md.

Done: opted-in feedback survives restart/UI closure; one stable batch reserves one writer;
fresh repairs preserve approved scope; checks and publication receipts bind exact trees;
new commits await new reviews; limits/errors are visible; merge is human-approved.
No unbounded transcript reuse, duplicate Auto PR instructions, auto-merge, forced push,
arbitrary feedback-driven features, or competing delivery pipeline.

Implementation PR descriptions prominently list settings/deployment actions, every feature,
and reproducible tests. Open Ready for Review PRs using the established repository workflow.
