# Task launch validation and unstarted-task recovery

A task launch either reaches an agent process (or a native session) or it says why it
did not. This document covers what the runtime guarantees in between: which settings
are allowed, when they are checked, what a failure leaves behind, and how a card that
prepared a worktree but never started an agent is recovered.

Related: [`task-worktree-recovery.md`](./task-worktree-recovery.md) (preserved
checkouts), [`cline-concurrency.md`](./cline-concurrency.md) (model capacity),
[`diagnostics-export.md`](./diagnostics-export.md) (the diagnostics bundle).

## Capabilities are the only source of truth

[`src/core/agent-capabilities.ts`](../src/core/agent-capabilities.ts) holds one row per
agent (plan mode, images, approval mode, explicit resume, …).
[`src/core/task-launch-requirements.ts`](../src/core/task-launch-requirements.ts) turns
a task's saved settings plus the **effective agent** into an allow/refuse answer, and
never branches on an agent id. The effective agent is the card's own override, then the
project/runtime default — the same precedence the launcher applies, so the UI disables
what would actually run rather than what the dropdown currently shows.

- `checkTaskLaunchRequirements(agentId, settings)` — authoritative, used by the runtime.
- `planModeUnsupported` / `imagesUnsupported` / `describeUnsupportedTaskSetting` — UI
  helpers, used to disable an option and render the reason beside it.

**An unsupported request is a refusal, never a downgrade.** Silently running Act mode
because plan mode was unavailable would let an agent edit files when the human asked for
a read-only plan. The same rule is why image attachments to an agent with no image input
are refused instead of dropped.

## Where the check runs

The rule is enforced at every entry point that can start an agent, and always
*before* the first side effect (base refresh, worktree creation, the move to In
Progress, model-slot admission, process spawn):

| Entry point | Location |
| --- | --- |
| Manual Start / Start in progress / resume | `startTaskSession` in [`src/trpc/runtime-api.ts`](../src/trpc/runtime-api.ts) |
| Unstarted-task relaunch | the recovery pre-check in the same function |
| Dispatch queue | `dispatchSingleTask` in [`src/task-dispatch/task-dispatch-service.ts`](../src/task-dispatch/task-dispatch-service.ts) |
| Terminal launch | the agent adapter in [`src/terminal/agent-session-adapters.ts`](../src/terminal/agent-session-adapters.ts) |
| Browser form | `use-task-editor.ts` + `task-setting-notices.ts` (disables the option, shows the reason) |

The browser check is a convenience; the runtime check is the one that counts, because
cards can be created by the API, edited on another instance, or saved before a
capability changed. A refused launch returns `ok: false` with a message that names the
agent and the setting, and leaves the card editable.

## Failures are durable, not just a toast

Anything that stops a launch records itself twice:

1. On the task session summary as `state: "failed"` plus `warningMessage`, so the card,
   the detail view and the diagnostics download all show it after a reload.
2. In the server log as one `task-launch-failed` line carrying the task id, effective
   agent, failure **stage** (`settings-validation`, `worktree-preparation`,
   `capacity-admission`, `adapter-preparation`, `process-spawn`, `recovery-precheck`)
   and the error text — never the prompt, attachments or environment
   ([`src/terminal/task-launch-failure-log.ts`](../src/terminal/task-launch-failure-log.ts)).

Capacity waits and cancellations are deliberately **not** failures: a start queued for a
model slot is an idle record with no pid plus a `PiInitialTurnCapacityGate` wait, an
interrupted launch keeps its `interrupted` review reason so Restore still applies, and a
user Stop is recorded as an exit, not an error.

## A prepared worktree with no session is not "paused"

`assessUnstartedTaskRecovery`
([`src/terminal/task-unstarted-recovery.ts`](../src/terminal/task-unstarted-recovery.ts))
answers two separate questions, and both are surfaced in the task detail view:

- **`neverLaunched`** — no active process, no session that ever started, and no
  agent-side conversation. This is what distinguishes "nothing ran" from an ordinary
  idle, paused or interrupted card.
- **`recoverable`** — the stored prompt can be re-sent safely **in place**. Every
  condition below must hold, otherwise the answer explains what to do instead:
  - the task has a prompt and an agent, and its saved settings are supported;
  - no process, no running session, and no finished session awaiting review;
  - the agent can prove it has no conversation to duplicate (Cline: no recoverable
    session and no assistant message; Pi: no session file under its Kanban-minted id).
    An agent that cannot be probed is refused rather than guessed at;
  - a durable baseline exists (`initialStart.state === "prepared"`);
  - the worktree exists, its `HEAD` still equals that baseline, it is clean, and it is
    not ahead of the base;
  - no preservation ref, delivery receipt, or stored patch claims the work — replaying
    delivered work is worse than asking the human to start a fresh task.

Recovery therefore *reuses* the existing worktree and baseline: no base refresh, no
second worktree, no new card, and the original prompt is submitted as a genuinely new
conversation. When a conversation does exist, exact-session resume (Restore) remains the
only path.

## The prompt belongs to the card

The stored task prompt lives on the board card, not in the terminal or the Cline
transcript, so it stays readable (`TaskPromptSection`), copyable and — while the task
has never launched — editable, including the agent and launch settings that have to be
corrected. Long prompts start collapsed so the detail view is not swallowed by text the
agent already received.
