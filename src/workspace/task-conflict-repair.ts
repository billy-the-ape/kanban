// PCR-2: server-owned durable dispatch record for the explicit
// "Resolve conflicts" action, kept on the task card.
//
// Deliberately NOT `card.sentGitActionPrompt`: that union is `commit | pr`
// and is cleared when the card leaves Review, while a conflict repair must
// stay re-triggerable after a failure yet refuse a duplicate click against
// the SAME head from a second tab. The record is keyed by head SHA: after a
// successful push the head changes, so the record naturally expires on the
// next read. It is never replayed on restart (same rule as comment repair:
// an accepted prompt is never re-run) — it only explains the state, and a
// fresh click against the current head is what retries.
import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskConflictRepairRecord } from "../core/api-contract";
import { findTaskLocation } from "../core/task-board-mutations";
import { mutateWorkspaceState } from "../state/workspace-state";
import { logWorkspaceEvent } from "./workspace-logger";

export interface RecordConflictRepairInput {
	workspacePath: string;
	taskId: string;
	record: RuntimeTaskConflictRepairRecord;
}

/** Applies the record to an existing board (pure). */
export function recordConflictRepairOnBoard(
	board: RuntimeBoardData,
	taskId: string,
	record: RuntimeTaskConflictRepairRecord,
): { board: RuntimeBoardData; changed: boolean } {
	const found = findTaskLocation(board, taskId.trim());
	if (!found) {
		return { board, changed: false };
	}
	const updated: RuntimeBoardCard = { ...found.task, conflictRepair: record, updatedAt: found.task.updatedAt };
	const columns = board.columns.map((column) =>
		column.id === found.columnId
			? { ...column, cards: column.cards.map((card) => (card.id === found.task.id ? updated : card)) }
			: column,
	);
	return { board: { ...board, columns }, changed: true };
}

/**
 * Writes the record under the workspace lock. Best-effort by contract: never
 * throws; returns false when the write (or the card) failed so the caller
 * degrades to sending without durable dedupe, matching the git-action
 * acquire path's "error degrades to send" rule.
 */
export async function recordConflictRepair(input: RecordConflictRepairInput): Promise<boolean> {
	try {
		const result = await mutateWorkspaceState<boolean>(input.workspacePath, (state) => {
			const applied = recordConflictRepairOnBoard(state.board, input.taskId, input.record);
			return { board: applied.board, value: applied.changed, save: applied.changed };
		});
		return result.value;
	} catch (error) {
		logWorkspaceEvent(
			`conflict-repair record write failed task=${input.taskId} error=${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return false;
	}
}
