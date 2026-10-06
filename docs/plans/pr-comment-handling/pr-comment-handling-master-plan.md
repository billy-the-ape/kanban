# PR comment handling — master plan

Updated: 2026-10-06. Status: proposed; documentation only. Repository: `billy-the-ape/kanban`.

## Goal, boundaries and dependencies

When a task generates/links a PR and **Auto address comments** is enabled, collect actionable
feedback, wait two minutes for a stable batch, then repair scoped defects on the same PR.
Show In Progress during repair and In Review after verified publication. Use bounded backend
work that survives browser closure and service restart.

This is separate from **Auto finish on merge**. It may operate with that checkbox off and never
merges PRs or completes tasks because feedback was addressed, checks passed or a tree is clean.
The [GitHub PR tracking foundation](../github-pr-tracking/github-pr-tracking-master-plan.md)
owns shared observation, task settings, selected Automation PR, schemas, subscriptions and
repair ownership/gates. Require both FOUNDATION-0 and FOUNDATION-1 after landed PR linking.
Then this feature and merge tracking can be built in parallel and ship in either order.
No merge consumer is required: terminal cancellation is supplied by the foundation.

These plans supersede overlapping scope in unmerged
[PR #21](https://github.com/billy-the-ape/kanban/pull/21). Keep its bounded repair principles
but use PR-linking's card identities instead of another mapping; replace its five-minute
debounce with the two-minute default requested here. Gateway review Action/report work is an
optional feedback producer, not a dependency for ordinary human GitHub comments. No need to
implement auto-replies, new gateway contracts or another reviewer engine in this series.

Source baseline and shared integration paths are listed in the foundation plan. Additionally
inspect `src/cline-sdk/cline-task-session-service.ts`, the existing review/session/verification
services, `src/workspace/task-review-handoff.ts`, delivery receipts and prompt receipt handling.
Reverify APIs before edits; absence of a usable primitive must be reported as a dependency,
not hidden by assuming a plan is implemented.

## Settings and user behavior

`autoAddressComments` is optional on persisted cards, false when missing. The **Auto address
comments** checkbox remains editable during In Progress, model-capacity waiting and In Review.
It is independent of `autoFinishOnMerge`, Auto PR, and existing Auto review controls. It does
not require those creation controls: a correctly linked manually created PR can be selected.
Persist settings through the shared revision-checked API; never require session restart.

Enable triggers a fresh scan of currently published, unresolved feedback, including comments
posted before enabling. Resolved/deleted or already-addressed versions do not replay. Disable
cancels pending batches/admissions immediately; an active repair stops at the next safe boundary
without discarding edits or replaying ambiguous pushes. Settings changes cannot waive locks,
checks or lifecycle budgets. A visible **Resume automatic repairs** action can explicitly reset
an exhausted budget after operator inspection; toggling the checkbox cannot reset it.

For no eligible selected PR, missing access, unsupported agent/provider, branch mismatch or
ambiguity, retain the checkbox and show the blocking reason. First automatic repair support
targets native Cline with the existing capacity/session primitives. External terminal agents
must not be advertised as supported until equivalent durable dispatch and cancellation are
implemented and tested; they retain manual feedback handling and visible diagnostics.

## Polling lifecycle

Use the shared observer's polling eligibility, stop and resume rules in the foundation plan.
Register the comment consumer with metadata/feedback sources; do not add another polling loop.
Only In Progress/In Review subscriptions with an enabled consumer observe open/draft PRs.
Backlog/Done/Trash, both options disabled, and terminal PRs stop recurring observation.
Merged/closed PRs immediately stop feedback reads and pending repairs; only an enabled merge
consumer may need bounded completion reconciliation. Retain versions and dispositions when
polling stops. History reopen, service restart and checkbox toggles do not rearm terminal PRs.
Explicit Resume PR tracking performs a one-time read and resumes recurring observation only
for a confirmed eligible open/draft PR; it does not reset repair limits or launch a turn itself.

## Feedback normalization and debounce (COMMENT-0)

Consume shared observer snapshots of submitted review bodies, inline review comments/threads
and PR conversation comments. The foundation already normalizes canonical identity, event/review/
thread IDs, author/times/digests, commit/path/line and resolution; consume that schema without
renormalizing or introducing provider-specific reads here.
Persist seen, pending, reserved and addressed versions separately. Reading is not addressing.
An edited comment becomes a new version; duplicate provider reads do not create new work.
Do not double-count a review body and its inline comments as duplicate instructions.

Human feedback on the selected PR is eligible; bots require an explicit trusted reviewer
allowlist. Ignore approvals without requests, pending reviews, resolved/deleted comments,
own repair output, CI status chatter and known generated summaries. Candidate text is assessed
for actionable in-scope requests inside the bounded repair turn; no extra model call per comment.
An empty CHANGES_REQUESTED review is a visible request for clarification, not an endless repair.
Outdated inline feedback is checked against current code before editing, not blindly applied.
PR text is untrusted input and cannot override task requirements, tool approvals or permissions.

Use **120 seconds of quiet** after the latest eligible addition/edit. Reset only for a real
eligible version change, not each poll or an unrelated status update. Persist first-pending time,
last-change time and due time. Add a **600-second maximum batch wait** from the first eligible
event so a continuously active reviewer cannot starve repair. Dispatch takes the latest stable
snapshot available at that boundary; new events afterward remain pending for the next batch.
Actual start may be later due to writer ownership/model capacity; display that distinction.

On due time, refresh PR head, published feedback and thread states with complete successful
pagination. Drop resolved/deleted feedback and reconcile edited versions. A changed head makes
the batch stale and requires reassessment on that head; never run against a cached old tree.
Persist batch identity, selected-PR/settings generation, base head, event versions and due time
before admission. Backend timers derive from durable records; startup catches up due batches.
COMMENT-0 only collects and exposes batches; it never launches an agent.

## Repair execution (COMMENT-1)

1. Require this task to be the foundation's explicit automatic repair owner. Claim a durable
   batch lease plus fenced task/PR/head operation reservation; another linked task cannot repair.
   Recheck checkbox, selected PR, open/unmerged state,
   current head and column. Backlog, Trash, Done, manual pause and historical reopen block.
   A live writer, review, verification, delivery or manual Git action retains ownership;
   feedback waits without being injected into its turn. Shared branch ownership also blocks
   conflicts across tasks/workspaces, not just a writer on this task's worktree.
2. Verify the actual remote head repository/branch and reconcile delivery mappings. A fork PR
   or PR outside the task's delivery repository needs verified writable mapping; otherwise
   block. Preserve local edits and never reset/rebase user work to match a remote branch.
3. Queue through the same endpoint/model admission as implementation and review. Use current
   task model/provider/rules/permissions, cancellation and `q #N` badges. A follow-up repair
   with history is not eligible for the untouched-initial-task Backlog reset path. Persist
   intent and reconcile after restart; the in-memory queue is not the durable scheduler.
4. Once admitted, move Review → In Progress and run a fresh scoped repair session with the
   approved original task requirements, exact current PR head, concise handoff, feedback URLs,
   normalized versions and remaining budget. Preserve the original transcript and associate
   the repair transcript with task history. Do not reset the task or resend Auto PR prompts.
5. Assess each item: fix an in-scope defect, record that it is already satisfied, or give a
   concise evidence-backed rejection. Scope changes, unclear requirements and unsafe advice
   stop visibly for human handling. Never execute arbitrary feedback commands as authority.
6. Run configured deterministic verification against the candidate tree, preserving existing
   review/check gates. On success, commit and push to the same PR branch through delivery
   services; suppress new PR creation, local target integration and premature Done behavior.
   Compare remote head before push and stop on external drift. No force-push or hidden stash.
7. Persist candidate, verification and publication evidence before marking feedback addressed.
   For a valid no-change disposition record the rationale and checked head without inventing
   a commit. Return to In Review after successful publication/disposition and await review of
   the new head. Failed or blocked repairs return to In Review with a visible failure; do not
   leave Thinking or `impl` active when no turn is running.

No automatic public replies or thread resolution are required in v1; expose per-item dispositions,
commit/check links and blocked reasons locally. In particular, a thread left unresolved by the
reviewer does not rerun forever: its addressed version remains consumed until edited or an
explicit new actionable follow-up appears. New feedback during a run forms the next batch.

## Bounds, races and recovery

Default maximum is **three automatic repair batches per task/selected PR lifecycle** and stop
after **two consecutive no-progress rounds**. “Progress” is verified/published relevant changes
or a new evidence-backed terminal disposition; unchanged repetition is not progress. Persist
budget spend before starting a turn; failed runs still consume it. Inherited turn time/token,
tool retry and verification bounds remain enforced. Success, new comments, head changes,
restarts and checkbox toggles do not replenish the lifecycle budget. Surface remaining budget.

Persist stages: pending → reserved → queued → repairing → verifying → publishing → addressed,
with blocked/needs-human and cancellation outcomes. A claim/lease is not proof that a push
succeeded. If a response is lost after commit/push, reconcile Git, remote head and the expected
candidate receipt before retrying. Unknown outcomes enter needs-human rather than replaying
the entire repair. On restart, adopt verified live ownership or resume a safe pending stage;
never duplicate a live session or blindly reexecute an uncertain turn.

If the PR merges/closes during debounce or queueing, cancel the intent. During repair or push,
stop at a safe boundary and reconcile unpublished/dirty work through foundation terminal
invalidation/gates, including when no merge feature is installed. This feature never moves
cards to Done; an installed merge consumer uses the same gate for its separate transition. A merged PR cannot trigger further comment repairs, even
when the user reopens its card from Done for history. Unchecking either option does not toggle
the other. Pausing/trashing/removing a PR cancels queued work and cannot silently relaunch it.

## Implementation slices

Each row is one implementation PR/card, planned and unchecked. Keep the count small; create
individual task documents only when the user requests breakout.

| ID | Scope | Depends on | Acceptance |
| --- | --- | --- | --- |
| COMMENT-0 | Actionable feedback classification, durable batches, two-minute debounce and visibility | FOUNDATION-0 + FOUNDATION-1 | One stable batch; old eligible feedback included; restart and edit-safe collection |
| COMMENT-1 | Bounded native Cline repair, admission, verification, same-PR push and recovery | COMMENT-0 + existing session/verification/delivery contracts | One writer; checks gate publication; no duplicate run/push or early Done |

Ownership selection/transfer is implemented by the foundation. Only the selected owner stores
pending repair batches and spends budget. Explicit transfer carries addressed versions and spent
budget forward, invalidates old intents/fencing tokens and reassesses the new task's approved
scope. Do not reset limits by choosing another task or silently inherit its specification.
Persist consumer fields under the comment namespace using foundation mutation APIs. No MERGE
slice is a dependency; prove terminal stopping and In Review return with merge absent.

## Verification and manual pilot

- Ownership integration: two linked tasks across workspaces yield only one repairing task;
  owner contention/disable/unlink/transfer use foundation blockers; stale ownership cannot push;
  transfer retains consumed feedback and budget. Run comments alone and with a fake merge consumer.
- Polling lifecycle: inactive columns and terminal PRs produce no recurring feedback reads;
  a shared PR remains observable for another eligible card; restart/history inspection cannot
  rearm a terminal subscription; explicit resume of an externally reopened PR preserves budgets.
- Fake clock/provider: multiple comments batched, edits reset quiet timer, duplicate polls do
  not; max wait; pagination failure; resolution/deletion/outdated feedback; submitted review
  bodies and inline threads; untrusted bot/status noise; enable backfill and disable race.
- Session fixtures: currently running writer, manual edits and remote drift; capacity wait
  with `q #N`; pause/trash cancellation; restored settings and transcript; verified same-PR
  changes and no-change dispositions; failed checks; scope escalation; visible terminal error.
- Restart at every reservation/turn/verification/publication boundary, including successful
  push with lost response. Assert persisted budgets, no repeated addressed versions and one
  writer/session. Toggle-off/on and manual Done → Review do not reset or rearm consumed work.
- Merge during debounce, queue, execution and delivery; no further repair after merge,
  no automatic completion with auto-finish disabled, and no competing merge transition.
- Disposable end-to-end PR: enable comments, submit several review comments within two minutes,
  confirm one fresh repair and same-PR commit after checks, then In Review. Submit another
  comment during repair; it waits as the next batch. Saturate model slots and verify queueing.
  Exhaust the repair budget, inspect the blocker, then explicitly resume once.

Use isolated HOME/USERPROFILE, sanitized Git subprocess environments, focused backend/UI
tests, typechecks, Biome on changed supported files and required CI. A real local-model pilot
must validate repair usefulness; scripted fixtures prove orchestration only.

## Rollout and operations

Planning adds no deployment requirements. Implementation defaults the task checkbox off;
proposed runtime policy values are 120-second quiet time, 600-second max wait, three batches
and two no-progress rounds. Reuse existing configuration conventions, and document final names,
record version/storage, auth read/push permissions and rollout/rollback in each implementation PR.
No new environment variables or packages are presumed necessary; justify any additions.
Kanban runtime auth is separate from chat OAuth. No inbound listener is required.

Inspect batches first, pilot one repair task, then expand. Disable scheduling, drain or safely
stop live work and retain records before rollback. Follow the shared plan's final operational
task: after actual service/device changes, update `billy-the-ape/homelab-documentation` via a
Ready for Review PR recording deployed configuration, permissions, admission and rollback.
