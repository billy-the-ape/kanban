// AUTOGIT: server-owned dedupe state for the generated auto git-action
// prompts (commit / open-PR).
//
// Every client pathway that sends a generated commit or PR prompt (the
// review card button, the agent panel button, and the auto-review scheduler)
// records the send here, under the workspace lock, on the task card. The
// record scopes one "review episode": it is set only while the card is in
// the Review column and is cleared automatically by `saveWorkspaceState`
// once the card leaves Review, so a new episode can prompt again.
//
// Intent semantics:
// - "auto"  (set-if-absent): a second caller in the same episode is
//   rejected with `already_sent`, so two clients or a manual send followed
//   by an auto re-arm can never deliver the same prompt twice.
// - "manual": always records the send (updating `sentAt`), preserving the
//   user's ability to re-trigger the prompt after a failed first attempt.
// A failed send releases the record so the auto path can retry, matching
// the pre-AUTOGIT client-side behavior.
import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskGitActionPromptAction } from "../core/api-contract";
import { findTaskLocation } from "../core/task-board-mutations";
import { mutateWorkspaceState } from "../state/workspace-state";
import { logWorkspaceEvent } from "./workspace-logger";

export type TaskGitActionPromptAcquireStatus = "acquired" | "already_sent" | "no_task" | "not_in_review";

const REVIEW_COLUMN_ID = "review";

/**
 * Applies the acquire to an existing board (pure). Returns the new board
 * plus the outcome; `changed` tells the caller whether a write is needed.
 */
export function acquireTaskGitActionPromptOnBoard(
	board: RuntimeBoardData,
	taskId: string,
	action: RuntimeTaskGitActionPromptAction,
	intent: "manual" | "auto",
	now: number,
): { board: RuntimeBoardData; status: TaskGitActionPromptAcquireStatus; changed: boolean } {
	const found = findTaskLocation(board, taskId.trim());
	if (!found) {
		return { board, status: "no_task", changed: false };
	}
	if (found.columnId !== REVIEW_COLUMN_ID) {
		return { board, status: "not_in_review", changed: false };
	}
	const existing = found.task.sentGitActionPrompt;
	if (existing?.action === action && intent === "auto") {
		return { board, status: "already_sent", changed: false };
	}
	const updated: RuntimeBoardCard = {
		...found.task,
		sentGitActionPrompt: { action, sentAt: now },
		updatedAt: now,
	};
	const columns = board.columns.map((column) =>
		column.id === found.columnId
			? { ...column, cards: column.cards.map((card) => (card.id === found.task.id ? updated : card)) }
			: column,
	);
	return { board: { ...board, columns }, status: "acquired", changed: true };
}

/**
 * Clears the record for `action` on an existing board (pure). No-op when the
 * card is missing, in a different action state, or already clear.
 */
export function releaseTaskGitActionPromptOnBoard(
	board: RuntimeBoardData,
	taskId: string,
	action: RuntimeTaskGitActionPromptAction,
): { board: RuntimeBoardData; changed: boolean } {
	const found = findTaskLocation(board, taskId.trim());
	if (!found) {
		return { board, changed: false };
	}
	if (found.task.sentGitActionPrompt?.action !== action) {
		return { board, changed: false };
	}
	const next: RuntimeBoardCard = { ...found.task };
	delete next.sentGitActionPrompt;
	const columns = board.columns.map((column) =>
		column.id === found.columnId
			? { ...column, cards: column.cards.map((card) => (card.id === found.task.id ? next : card)) }
			: column,
	);
	return { board: { ...board, columns }, changed: true };
}

/**
 * Acquires (or re-records) the auto git-action prompt record under the
 * workspace lock. Best-effort by contract: never throws; failures log and
 * report `no_task` so callers degrade to sending the prompt (the pre-AUTOGIT
 * behavior) instead of blocking.
 */
export async function acquireTaskGitActionPrompt(input: {
	workspacePath: string;
	taskId: string;
	action: RuntimeTaskGitActionPromptAction;
	intent: "manual" | "auto";
}): Promise<TaskGitActionPromptAcquireStatus> {
	try {
		const result = await mutateWorkspaceState<TaskGitActionPromptAcquireStatus>(input.workspacePath, (state) => {
			const applied = acquireTaskGitActionPromptOnBoard(
				state.board,
				input.taskId,
				input.action,
				input.intent,
				Date.now(),
			);
			return {
				board: applied.board,
				value: applied.status,
				save: applied.changed,
			};
		});
		return result.value;
	} catch (error) {
		logWorkspaceEvent(
			`git-action-prompt acquire failed task=${input.taskId} action=${input.action} error=${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return "no_task";
	}
}

/**
 * Releases the record for a failed send under the workspace lock. Best-effort
 * by contract: never throws; returns true only when a record was cleared.
 */
export async function releaseTaskGitActionPrompt(input: {
	workspacePath: string;
	taskId: string;
	action: RuntimeTaskGitActionPromptAction;
}): Promise<boolean> {
	try {
		const result = await mutateWorkspaceState<boolean>(input.workspacePath, (state) => {
			const applied = releaseTaskGitActionPromptOnBoard(state.board, input.taskId, input.action);
			return {
				board: applied.board,
				value: applied.changed,
				save: applied.changed,
			};
		});
		return result.value;
	} catch (error) {
		logWorkspaceEvent(
			`git-action-prompt release failed task=${input.taskId} action=${input.action} error=${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return false;
	}
}
