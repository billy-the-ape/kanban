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

export type ConflictRepairClaim =
	| { status: "claimed" }
	/** A `dispatched` record for the same PR + head already exists under the lock. */
	| { status: "duplicate"; existing: RuntimeTaskConflictRepairRecord };

/**
 * Compare-and-set version of {@link recordConflictRepair}: the write
 * re-checks the CURRENT card inside the workspace lock and refuses to
 * overwrite a `dispatched` record for the same PR key and head SHA. This is
 * what makes the dedupe atomic — two concurrent dispatch calls can both
 * pass an earlier board read, but only one claim can land, and the loser
 * gets the existing record back (the PR reservation cannot close this gap:
 * `reservePrOperation` treats a second reservation by the SAME task and
 * operation as idempotent success). A lock failure degrades to `claimed`
 * exactly like the unconditional writer, so a broken lock never strands the
 * retry lane.
 */
export async function claimConflictRepair(input: RecordConflictRepairInput): Promise<ConflictRepairClaim> {
	try {
		const result = await mutateWorkspaceState<ConflictRepairClaim>(input.workspacePath, (state) => {
			const found = findTaskLocation(state.board, input.taskId.trim());
			const existing = found?.task.conflictRepair;
			if (
				existing !== undefined &&
				existing.status === "dispatched" &&
				existing.prKey === input.record.prKey &&
				existing.headSha === input.record.headSha
			) {
				return { board: state.board, value: { status: "duplicate" as const, existing }, save: false };
			}
			const applied = recordConflictRepairOnBoard(state.board, input.taskId, input.record);
			return {
				board: applied.board,
				value: { status: "claimed" as const },
				save: applied.changed,
			};
		});
		return result.value;
	} catch (error) {
		logWorkspaceEvent(
			`conflict-repair claim failed task=${input.taskId} error=${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		// Degrade to sending without durable dedupe (same contract as the
		// unconditional writer): a lock failure must never strand the repair.
		return { status: "claimed" };
	}
}
