# Kanban task history implementation plan

Document revision: 1  
Prepared: 2026-10-03  
Status: Planned. Open decisions in the "Decisions required" section must be answered before H-2 starts.  
Source baseline: ba3b715 (fork main after PR #28).  
Related plan: [B_IMPLEMENTATION_PLAN.md](../B_IMPLEMENTATION_PLAN.md) (B-5 preservation, B-5.8 Done/Trash split, B-8 delivery receipts).  
Fork: https://github.com/billy-the-ape/kanban

## Purpose and delivery summary

Let users open a task in Done or Trash and see its prompt, its agent conversation, and the code it changed, without reopening it. Today these cards cannot be selected at all. The block is UI-only: most of the underlying data still exists after a task leaves Review, but no screen or API reads it after the worktree is gone.

H-0 confirms what survives in each task state. H-1 records one durable snapshot of the task's final tree before a worktree is removed. H-2 exposes a read-only history API that finds the best available source for a task's changes. H-3 opens Done and Trash cards in a read-only detail view. H-4 adds an "All changes" diff mode. H-5 covers conversation and terminal history. H-6 sets the retention rules for history and for Clear Trash. H-7 adds CLI parity. H-8 covers end-to-end validation and documentation.

The H identifiers are implementation milestones. Subtasks use stable identifiers such as H-2.3. Do not renumber completed milestones. Record later additions under a new H number.

## Requirements

1. A card in Done or Trash opens in the detail view when clicked, the same way an In Progress or Review card does.
2. The view is strictly read-only. Opening it must never start, resume or restart an agent session, create or recreate a worktree, spawn a shell, run a Git action, or write to the board.
3. The view shows the full set of changes the task made relative to its starting point, not only uncommitted changes. That must keep working after the worktree has been removed.
4. The view shows the Cline conversation transcript when one was persisted. For terminal agents it shows whatever output was retained, or says clearly that none was.
5. When a source has been pruned, the view says what is missing and why. It never shows an empty diff as if the task changed nothing.
6. Reopening a task stays an explicit action (drag to Review, or a "Reopen in Review" button). It is never a side effect of viewing.
7. No regressions to B-5 preservation guarantees, B-5.7 retention, or B-8 delivery receipts. New git refs must not collide with existing ref namespaces.
8. Keep changes modular and small enough for upstream PRs. The UI gate change and the history API should be reviewable separately.

## Evidence

### Confirmed in the baseline

The block is two UI checks:

- `web-ui/src/hooks/use-board-interactions.ts` `handleCardSelect` returns early when the selected card is in `trash` or `done`.
- `web-ui/src/components/board-card.tsx` sets `isCardInteractive = !isTrashCard && !isDoneCard`. That removes the pointer cursor and hover styles. The card's `onClick` is still wired, so the hook's early return is what actually blocks selection.

The check was inherited from upstream cline/kanban. There, the single end column (`{ id: "trash", title: "Done" }`) deleted the worktree immediately, so nothing was left to show. B-5-8 (`a5b3103`) split the column and extended the check to `done` to match `trash`, without adding a new reason.

The detail view already handles end-column cards in a few places that cannot currently be reached:

- `App.tsx` `activeWorkspaceHint` shows "Task worktree deleted" for trash cards.
- `card-detail-view.tsx` turns off diff polling for `trash` and sets `isTaskTerminalEnabled` only for `in_progress` and `review`.
- `agent-terminal-panel.tsx` has a comment about not opening websockets for "backlog and trash views".
- `cline-chat-message-utils.ts` already has a `done` branch for how completion messages render.

What survives in each state:

| Data | While the worktree exists | After the worktree is removed | Lost when |
|---|---|---|---|
| Card (title, prompt, baseRef, settings) | board state | board state | Clear Trash removes the card |
| Session summary (state, turn checkpoints) | `sessions.json` | `sessions.json` | Clear Trash deletes the entry (`handleConfirmClearTrash`) |
| Cline transcript | SDK session store, read by `loadTaskSessionMessages` → `readPersistedTaskSession` | same, because it is independent of the worktree | only `/clear` (`clearTaskSession` → `clearTaskSessions`). Clear Trash leaves the session files orphaned |
| Latest two turn checkpoints | `refs/kanban/checkpoints/<b64 id>/turn/<n>` (full working-tree commits) | the refs and their objects remain in the main repo | older turns are deleted as new turns land; nothing deletes the last two |
| Preservation ref (HEAD commit only) | `refs/kanban/tasks/<id>` | remains | `removeTaskPreservationAssets` (30-day / 5 GiB retention, or explicit disposal) |
| Patch (HEAD → working tree, includes untracked files) | written at preservation | `~/.cline/kanban/trashed-task-patches/` | same as above |
| Full tar archive | written at preservation | `~/.cline/kanban/task-preservation/<id>/archive.tar.gz` | same as above |
| Delivery receipt (`baseSha`, `taskCommitSha`, `integratedSha`, PR) | `~/.cline/worktrees/<id>/delivery/` | remains, because `pruneEmptyParents` stops at a non-empty directory | nothing deletes it today |
| Delivery commit ref | `refs/kanban/delivery/<id>` | remains | nothing deletes it today |

Constraints that shape the design:

- The existing diff modes cannot show a finished task's work. `working_copy` (`getWorkspaceChanges`) diffs the worktree against **HEAD**, so committed work is invisible. A delivered task with a clean worktree shows "No working changes" even while the worktree still exists. `last_turn` shows one turn only. `loadChanges` returns an empty response once the worktree is missing (`isMissingTaskWorktreeError`).
- `getWorkspaceChangesBetweenRefs({ cwd, fromRef, toRef })` already diffs two commits from any checkout of the repo. Worktrees share the main repo's object store, so a commit recorded from a task worktree can be diffed from `repoPath` after the worktree is gone.
- The preservation ref records HEAD only. Uncommitted work at removal time exists only in the patch and the archive. There is no single commit holding the task's final tree.
- `createWorkingTreeCheckpointCommit` in `turn-checkpoints.ts` already builds a commit of the full working tree, untracked files included, using a temporary index. That is the right tool for a final snapshot.
- Ref namespace rule (see AGENTS.md): `refs/kanban/tasks/<id>` is a leaf, so a new per-task ref needs its own namespace, not `refs/kanban/tasks/<id>/...`.

### Not yet proven (resolve in H-0)

- Whether a terminal agent's output (`TerminalStateMirror`, which uses xterm's serialize addon) is kept anywhere after the PTY session exits, and whether it survives a runtime restart. The working assumption is that it lives in memory only.
- Whether `startingCommit` in the preservation record is reliably the task's real starting point for every task-creation path, including tasks that predate B-5. Otherwise the fallback is `merge-base(baseRef, final)`.
- Whether `readPersistedTaskSession` finds the right session after a task was restarted several times or reviewed (B-6 review sessions use their own session IDs).
- Whether opening `ClineAgentChatPanel` or `AgentTerminalPanel` for a task without a live session has side effects, such as hydrating and binding a session (`bindTaskSession` in the restore path) or opening a websocket.

## Architecture

### History source resolution

One runtime function resolves where a task's changes come from, in this order:

1. **Live worktree.** Diff `base` → working tree via `getWorkspaceChangesFromRef({ cwd: worktree, fromRef: base })`. Untracked files are included.
2. **History snapshot (new, H-1).** `refs/kanban/history/<id>`. Diff `base` → snapshot via `getWorkspaceChangesBetweenRefs` from `repoPath`.
3. **Delivery receipt.** `baseSha` → `taskCommitSha` when the receipt is complete and the commit is reachable (the delivery ref keeps it alive).
4. **Legacy preservation.** The preservation ref commit plus the patch, built into a snapshot on first read (H-2.4) and then served as source 2.
5. **Latest turn checkpoint.** `latestTurnCheckpoint.commit` from the session summary. This is best effort: it misses changes made after the last turn.
6. **Unavailable.** Return a typed reason (pruned, never had a worktree, base unknown). The UI says so.

`base` is the preservation record's `startingCommit`, then the receipt's `baseSha`, then `merge-base(baseRef, final)`.

The response always reports which source it used, so the UI can label it ("Final snapshot", "Delivered commit abc1234", "Best effort: last agent turn").

### Read-only detail mode

One value, `isTaskHistoryView = column.id === "done" || column.id === "trash"`, is computed once in `card-detail-view.tsx` and passed down. Every panel uses it instead of checking column IDs itself. A dedicated hook (`useTaskHistoryView`) owns fetching history info and changes, and controls polling (off when the worktree is gone; slow when it exists).

### Invariants

- Viewing history never mutates anything. The history tRPC procedures are queries, not mutations.
- History snapshots are written **before** worktree removal, inside the same preservation-gated path as the archive. Failing to write a snapshot is a warning, not a block: the archive remains the recovery guarantee.
- History refs live in `refs/kanban/history/<id>` and never in `refs/kanban/tasks/<id>/...`.
- Retention of history is decided once (D3) and enforced in `task-workspace-maintenance.ts`, not scattered across UI paths.

## Decisions required

Each decision lists the recommended answer first. H-0 and H-1 can start before these are answered. H-2 onwards depends on D1–D4.

- **D1. Which columns get the view?**
  - (a) Done and Trash. *Recommended.*
  - (b) Done only.

  Trash is where "why did I throw this away" questions come from, and the data is the same. With (b), Trash cards stay blocked.

- **D2. What does the diff show by default?**
  - (a) A new "All changes" mode (base → final) that is the default for Done/Trash and also available on live tasks. *Recommended.*
  - (b) "All changes" for history views only.

  Live tasks have the same blind spot: `working_copy` hides committed work. Exposing the mode everywhere is little extra work.

- **D3. How long is history kept?**
  - (a) Keep history snapshot refs until the card is permanently removed (Clear Trash, or Done → Trash → Clear). Archives and patches still follow the existing 30-day / 5 GiB policy. *Recommended.*
  - (b) Prune history refs together with the archives.
  - (c) Separate configurable retention.

  A snapshot ref costs only git objects that mostly already exist, while the 5 GiB cap is dominated by tar archives. Under (b), the diff disappears 30 days after delivery.

- **D4. What does Clear Trash delete?**
  - (a) Clear Trash permanently deletes the card, its session entry, its history ref, its checkpoint refs and its Cline SDK sessions, after a confirmation dialog that says so. *Recommended.*
  - (b) Keep today's behaviour: card and session entry only, with SDK sessions and refs orphaned.
  - (c) Add an "Archive" area so cleared tasks stay viewable.

  Today's Clear Trash leaves SDK sessions and refs orphaned on disk forever. (c) is a bigger feature and should be its own milestone if wanted.

- **D5. Persist terminal-agent output?**
  - (a) Yes: on session exit, write the serialized terminal mirror (capped, for example at 1 MiB) under the task's runtime directory and serve it read-only. *Recommended.*
  - (b) No: terminal-agent tasks show "Terminal output is not retained" plus the diff and prompt.

  Without (a), Claude Code, Codex and other terminal agents have no conversation history in the view. Depends on what H-0.2 finds.

- **D6. What may a user do from a read-only view?**
  - (a) Browse, copy, open files in the editor (live worktree only), navigate between cards, and use a "Reopen in Review" button that runs the existing restore path behind a confirmation. Diff comments, chat input, Git actions and terminal are hidden. *Recommended.*
  - (b) Same as (a) but without the reopen button.

- **D7. CLI parity?**
  - (a) Add `kanban task history <id>` (summary plus diff stat; `--patch` for the full diff) in H-7. *Recommended.*
  - (b) Skip it.

  Headless/SSH deployments (see AGENTS.md) benefit, and the code reuses the H-2 resolver.

- **D8. Upstream intent?**
  - (a) Shape H-3 (UI gate + read-only mode) as a standalone upstream PR, and keep H-1/H-2 fork-specific because they build on B-5/B-8. *Recommended.*
  - (b) Fork-only.

## Milestone overview

| Milestone | Outcome | Depends on | Upstream path |
|---|---|---|---|
| H-0 | Evidence: what survives, and side-effect audit | — | n/a |
| H-1 | Durable history snapshot at preservation time | H-0 | Fork (B-5) |
| H-2 | Read-only task history API and source resolver | H-1, D2, D3 | Fork |
| H-3 | Open Done/Trash cards in a read-only detail view | H-0, D1, D6 | Upstream-friendly |
| H-4 | "All changes" diff mode and history-aware diff panel | H-2, H-3 | Fork |
| H-5 | Conversation and terminal history | H-3, D5 | Mixed |
| H-6 | Retention, Clear Trash, and disposal | H-1, D3, D4 | Fork |
| H-7 | CLI parity | H-2, D7 | Fork |
| H-8 | End-to-end validation and documentation | all | n/a |

H-3 can ship first behind the existing `working_copy` / `last_turn` modes so the view is usable early. Until H-2/H-4 land, removed worktrees show an explicit "changes unavailable" state.

## H-0: Evidence and side-effect audit

### Outcome

A verified inventory of what each state retains, and a list of every place where opening a panel could change state.

### Tasks

- [ ] H-0.1 Write an integration test fixture (temp `HOME`, per AGENTS.md) that walks a task through In Progress → Review → Done (no receipt) → Done (with receipt, worktree removed by maintenance) → Trash → Clear Trash. At each step, record which rows of the evidence table are present. Commit it as a test that asserts the current behaviour, so later milestones change it deliberately.
- [ ] H-0.2 Trace `TerminalStateMirror` and `session-manager.ts` lifetimes. Answer: after PTY exit, is the mirror kept, and for how long? After a runtime restart? Record the result in this document and use it to finalise D5.
- [ ] H-0.3 Audit `ClineAgentChatPanel`, `AgentTerminalPanel`, `useRuntimeWorkspaceChanges`, `TaskReviewControl`, the delivery/verification status hooks and `onLoadClineChatMessages` for side effects when mounted for a task with no live session. Pay particular attention to `readPersistedTaskSession` vs. the restore path that calls `bindTaskSession`, websocket opens, `ensureWorktree` calls and auto-review hooks (`use-review-auto-actions.ts` already skips `done`/`trash`). Produce a table: component → side effect → gating needed.
- [ ] H-0.4 Verify `startingCommit` population for every task-creation path (fresh task, restored-from-trash, pre-B-5 legacy tasks). Decide the `base` fallback order from the result.
- [ ] H-0.5 Verify that `readPersistedTaskSession` picks the implementation session (not a B-6 review session) for tasks with multiple sessions. If it doesn't, note the fix for H-5.

## H-1: Durable history snapshot

### Outcome

Every task whose worktree is removed leaves behind one commit containing its exact final tree, untracked files included, anchored by a ref.

### Tasks

- [ ] H-1.1 Extract the temp-index snapshot logic from `createWorkingTreeCheckpointCommit` (`src/workspace/turn-checkpoints.ts`) into a shared helper, for example `createWorkingTreeSnapshotCommit({ repoRoot, message, env })`. Turn checkpoints keep using it unchanged.
- [ ] H-1.2 Add `src/workspace/task-history.ts` with `getTaskHistoryRefName(taskId)` → `refs/kanban/history/<normalized id>`, `writeTaskHistorySnapshot({ repoPath, taskId, worktreePath })`, `readTaskHistorySnapshot` and `deleteTaskHistorySnapshot`. Ignored files are excluded, matching `git add -A` with standard excludes, which is the same view the diff panel uses.
- [ ] H-1.3 Call `writeTaskHistorySnapshot` from `preserveTaskWorktree` (`task-preservation.ts`) after patch capture and before archive. Failure adds a warning to `blockedReasons` warnings and does not block cleanup.
- [ ] H-1.4 Extend `runtimeTaskPreservationRecordSchema` with `historyCommit: z.string().nullable().default(null)` and `historyCapturedAt`. Defaults keep old manifests valid.
- [ ] H-1.5 Optionally also snapshot when a task moves to Done, even when the worktree stays, so the history view is stable if the user edits the worktree afterwards. Snapshot-on-Done is cheap; recommend yes, with the ref overwritten on each Done transition.
- [ ] H-1.6 Tests in `test/integration/task-preservation.integration.test.ts`: modified, deleted, renamed, untracked, binary and nested-untracked files all appear in `base..historyCommit`. Ignored files do not. The ref name doesn't collide with an existing `refs/kanban/tasks/<id>`. A snapshot failure doesn't block cleanup.

## H-2: Task history API

### Outcome

One query that tells the UI (and later the CLI) what history exists for a task and returns its full change set from the best source.

### Tasks

- [ ] H-2.1 Contract (`src/core/api-contract.ts`):
  - `runtimeTaskHistorySourceSchema = z.enum(["worktree", "history_snapshot", "delivery_commit", "legacy_preservation", "turn_checkpoint", "unavailable"])`.
  - `runtimeTaskHistoryInfoResponseSchema` with: `source`, `baseCommit`, `finalCommit`, `worktreeExists`, `deliveryReceipt` (nullable, a subset: status, `taskCommitSha`, `integratedSha`, destination branch, PR URL), `preservation` (nullable: status, `preservedAt`, archive present), `retention` (nullable `expiresAt` for archives; history per D3), and `unavailableReason` (nullable enum: `pruned`, `never_started`, `base_unknown`, `objects_missing`).
  - Extend `runtimeWorkspaceChangesModeSchema` with `"task"` (all changes, base → final).
- [ ] H-2.2 Add the resolver `src/workspace/task-history-resolver.ts` implementing the source order in the Architecture section. Verify each candidate with `git cat-file -e <sha>^{commit}` before using it. Keep the resolver pure apart from git and file reads, and cover it with unit tests for every fallback.
- [ ] H-2.3 Add `workspace.getTaskHistoryInfo` (query) to `app-router.ts` / `workspace-api.ts`. Teach `loadChanges` that `mode: "task"` routes through the resolver and works without a worktree. For `working_copy` / `last_turn` on a missing worktree, keep returning empty, but have the UI switch to `task` (H-4).
- [ ] H-2.4 Backfill for legacy preservation: when there is no history ref but the preservation ref and patch exist, build the snapshot with a temp index (`read-tree <refCommit>`, `apply --cached --binary <patch>`, `write-tree`, `commit-tree`), store it in `refs/kanban/history/<id>`, and record it in the manifest. Run it lazily on first read, under the workspace lock. If the patch doesn't apply, fall back to `refCommit` with `source: "legacy_preservation"` and a note that uncommitted changes are missing. Do not extract tar archives on the read path.
- [ ] H-2.5 Mirror the new response type everywhere test factories build it (per AGENTS.md: grep for factories that cast with `as unknown as`).
- [ ] H-2.6 Tests in `test/runtime/` for: every resolver source, unreachable SHAs, a missing `startingCommit` with a `merge-base` fallback, and a deleted worktree with a live history ref. Use temp `HOME`.

## H-3: Read-only detail view for Done and Trash

### Outcome

Clicking a Done or Trash card opens the detail view in a mode that can only read.

### Tasks

- [ ] H-3.1 Remove the `done`/`trash` early return from `handleCardSelect`. Make `isCardInteractive` true for these columns too, while keeping the strike-through and muted styling for Trash. Update `board-card.test.tsx` and `use-board-interactions.test.tsx`.
- [ ] H-3.2 Add `web-ui/src/hooks/use-task-history-view.ts`. It returns `{ isHistoryView, historyInfo, isLoading }` and fetches `getTaskHistoryInfo` once on open and when the board revision changes. It doesn't poll while the worktree is absent.
- [ ] H-3.3 In `card-detail-view.tsx`, pass `isHistoryView` to every child and gate:
  - `ClineAgentChatPanel`: hide the composer, mode toggle, settings, commit/PR, complete, trash and cancel-automatic-action controls. Load messages via `onLoadClineChatMessages` only. Never call start/reload.
  - `AgentTerminalPanel`: `terminalEnabled={false}` (already the case), no session toolbar, and the H-5 transcript or a "not retained" notice.
  - `TaskReviewControl`, diff comments (`onAddDiffComments` / `onSendDiffComments`), the bottom shell terminal toggle, title editing and dependency editing: hidden.
  - Keyboard: keep card navigation (arrow keys) and Escape. Guard any shortcut that starts or sends.
- [ ] H-3.4 Add a history header (a small component in `detail-panels/`) showing the column ("Done" / "Discarded"), completion or discard time, the delivery summary (branch, commit, PR link) when a receipt exists, the history source label, and the D6 "Reopen in Review" button, which reuses the existing restore path (`reopenTaskInReview`) behind a confirmation.
- [ ] H-3.5 Fix `App.tsx` `activeWorkspaceHint` so it uses the history source instead of the `trash` special case.
- [ ] H-3.6 Selection lifecycle: if the open card moves to Done/Trash while viewed (auto-complete, CLI), stay on it and switch to history mode instead of losing context. If Clear Trash removes it, close the view (existing behaviour in `handleConfirmClearTrash`).
- [ ] H-3.7 Mobile tab layout (`MobileDetailTabBar`): same gating. Verify there is no horizontal overflow from the header.
- [ ] H-3.8 Tests: rendering each panel in history mode asserts no start/send/ensure calls (spy on runtime client mutations), the controls are absent, and the reopen action needs confirmation.

## H-4: "All changes" diff mode

### Outcome

The diff panel can show a task's whole change set, and it defaults to that in history mode.

### Tasks

- [ ] H-4.1 Add an "All changes" `DiffModeButton` (mode `task`) to `DiffToolbar`. In history mode it is the default and the only enabled mode once the worktree is gone. `last_turn` stays available when its checkpoints exist. Per D2, it also shows on live tasks.
- [ ] H-4.2 `useRuntimeWorkspaceChanges`: support `task` mode. Turn polling off when `historyInfo.worktreeExists === false`.
- [ ] H-4.3 Empty and unavailable states: "No changes" is shown only when the resolver found a source and the diff is genuinely empty. Otherwise show the `unavailableReason` text, for example "Changes were pruned on <date> under the 30-day retention policy". Replace the hard-coded `emptyDiffTitle`.
- [ ] H-4.4 Source label in the toolbar ("Final snapshot", "Delivered commit abc1234", "Last agent turn (may be incomplete)").
- [ ] H-4.5 Tests: each mode/source combination renders the right label and empty state. No polling interval is registered for a removed worktree.

## H-5: Conversation and terminal history

### Outcome

The left panel shows what the agent said and did.

### Tasks

- [ ] H-5.1 Cline: confirm (from H-0.3) that `getTaskChatMessages` is a pure read for a task without a live entry. If hydration has side effects (`messageRepository.hydrateTaskMessages` caching, `bindTaskSession`), add a dedicated read-only path (`readTaskTranscript`) that skips binding. Apply the H-0.5 session-selection fix if one was needed.
- [ ] H-5.2 Show review-session transcripts (B-6) as a collapsible secondary section when present, labelled "Review session".
- [ ] H-5.3 Terminal agents, if D5 is (a): on PTY exit, serialize the mirror (capped, oldest output dropped first) to `~/.cline/kanban/workspaces/<ws>/terminal-transcripts/<taskId>.txt` (ANSI kept), using the locked file system. Serve it through a read-only query and render it in a non-interactive xterm instance (no websocket, no input). If D5 is (b), show a notice.
- [ ] H-5.4 Tests: transcript retrieval with no live session and after a simulated runtime restart (fresh service instance, same temp `HOME`). Terminal transcript cap and truncation.

## H-6: Retention, Clear Trash, and disposal

### Outcome

History lives exactly as long as D3 says and is removed completely when D4 says.

### Tasks

- [ ] H-6.1 `task-workspace-maintenance.ts`: apply D3. Under (a), `removeTaskPreservationAssets` keeps `refs/kanban/history/<id>` and a new `disposeTaskHistory` deletes it. Under (b), it is deleted together with the archives.
- [ ] H-6.2 Clear Trash per D4. Move permanent disposal server-side (one mutation that deletes the history ref, checkpoint refs, delivery ref if undelivered, Cline SDK sessions via `clearTaskSessions`, the session entry and the card) instead of only editing board state in `handleConfirmClearTrash`. Update `clear-trash-dialog.tsx` copy to say history is deleted.
- [ ] H-6.3 Report history refs in the maintenance report so `kanban task cleanup` shows them, and include them in the size accounting only if D3 is (c).
- [ ] H-6.4 Tests: maintenance keeps or deletes history per policy. Clear Trash leaves no `refs/kanban/{history,checkpoints,tasks}` refs and no SDK session files for the cleared tasks.

## H-7: CLI parity (if D7 is (a))

- [ ] H-7.1 `kanban task history <id>`: prints the source, base/final commits, delivery summary, retention, and `git diff --stat`. `--patch` prints the full diff. `--json` prints the `getTaskHistoryInfo` response.
- [ ] H-7.2 Add to `kanban task --help` and the CLI reference docs under `.plan/docs/CLI References` if that is where they are kept.
- [ ] H-7.3 Integration test via `cli-compat.integration.test.ts`.

## H-8: Validation and documentation

- [ ] H-8.1 Manual pass in the real app (`run` skill): for each of Done-with-worktree, Done-delivered-worktree-removed, Trash-preserved, Trash-pruned, legacy-preserved (pre-H-1) and terminal-agent tasks, open the card, confirm the content, and confirm nothing was started (check the runtime logs and `git worktree list`).
- [ ] H-8.2 Confirm no new state is written under the real `~/.cline` during tests (`ls ~/.cline/worktrees ~/.cline/kanban/workspaces` before and after).
- [ ] H-8.3 Update AGENTS.md with any non-obvious findings (for example, the `refs/kanban/history` namespace, or `working_copy` diffing against HEAD and not base).
- [ ] H-8.4 Update this document's status and tick the subtasks.

## Risks

- **Accidental session restart from a history view.** This is the biggest risk. It is mitigated by H-0.3's audit, query-only procedures, and H-3.8 tests that spy on mutations.
- **Large final trees.** A snapshot commit reuses existing blobs, so its cost is roughly the size of new content, the same as the patch. Snapshots with very large untracked files (build output not covered by `.gitignore`) could bloat the repo. Mitigation: reuse the archive's size measurement and skip the snapshot (with a warning) above a cap, falling back to the delivery commit or the preservation ref.
- **Diff cost on huge change sets.** `getWorkspaceChangesBetweenRefs` loads every file's content. Reuse the existing diff panel's limits. If there are none, cap at the same thresholds the live view uses.
- **`git gc` on unreferenced objects.** Every source the resolver uses is anchored by a ref, except the turn checkpoint fallback, which is anchored by its checkpoint ref. The resolver verifies reachability before using any source.

## Branching and delivery

Each milestone ships as its own PR into `main`. H-3 may land before H-2 with the explicit "changes unavailable" state. H-1 should land early, even before the UI, so snapshots start accumulating for tasks completed in the meantime.
