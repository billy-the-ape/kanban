import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardColumn, BoardColumnId } from "@/types";

export interface ProgrammaticCardMoveInFlight {
	taskId: string;
	fromColumnId: BoardColumnId;
	toColumnId: BoardColumnId;
	insertAtTop: boolean;
}

function isMatchingProgrammaticCardMove(
	taskId: string | null | undefined,
	fromColumnId: BoardColumnId,
	toColumnId: BoardColumnId,
	programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null,
): boolean {
	return (
		taskId !== null &&
		taskId !== undefined &&
		programmaticCardMoveInFlight?.taskId === taskId &&
		programmaticCardMoveInFlight.fromColumnId === fromColumnId &&
		programmaticCardMoveInFlight.toColumnId === toColumnId
	);
}

export interface CardMoveRuleOptions {
	taskId?: string | null;
	programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
	/**
	 * Whether the moved task's agent session is still working. An in-progress
	 * card whose session stopped (interrupted by a runtime restart, failed, or
	 * never started) has nothing left to move it to Review automatically, so it
	 * may be moved there by hand. Unknown (undefined) is treated as running.
	 */
	isTaskSessionRunning?: boolean;
	canReturnTaskToBacklog?: boolean;
}

export function isAllowedCrossColumnCardMove(
	fromColumnId: BoardColumnId,
	toColumnId: BoardColumnId,
	options?: CardMoveRuleOptions,
): boolean {
	if (fromColumnId === "in_progress" && toColumnId === "backlog") return options?.canReturnTaskToBacklog === true;
	if (fromColumnId === "backlog" && toColumnId === "in_progress") {
		return true;
	}
	if (fromColumnId === "review" && toColumnId === "done") {
		return true;
	}
	// Any card may be discarded, including completed ones (their retained
	// worktrees are cleaned up through the preservation-gated trash path).
	if (toColumnId === "trash" && fromColumnId !== "trash") {
		return true;
	}
	// Discarded and completed cards can be reopened in Review; the worktree is
	// recreated from preserved work when it no longer exists.
	if ((fromColumnId === "trash" || fromColumnId === "done") && toColumnId === "review") {
		return true;
	}
	if (fromColumnId === "in_progress" && toColumnId === "review" && options?.isTaskSessionRunning === false) {
		return true;
	}
	if (
		(fromColumnId === "in_progress" && toColumnId === "review") ||
		(fromColumnId === "review" && toColumnId === "in_progress")
	) {
		return isMatchingProgrammaticCardMove(
			options?.taskId,
			fromColumnId,
			toColumnId,
			options?.programmaticCardMoveInFlight,
		);
	}
	return false;
}

export function canReturnQueuedTaskToBacklog(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	return (
		summary?.state === "running" &&
		summary.latestHookActivity?.hookEventName === "concurrency_waiting" &&
		summary.latestHookActivity.canReturnToBacklog === true
	);
}

export function isTaskSessionRunning(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	return summary?.state === "running";
}

export function findCardColumnId(columns: ReadonlyArray<BoardColumn>, taskId: string): BoardColumnId | null {
	for (const column of columns) {
		if (column.cards.some((card) => card.id === taskId)) {
			return column.id;
		}
	}
	return null;
}

export function isCardDropDisabled(
	columnId: BoardColumnId,
	activeDragSourceColumnId: BoardColumnId | null,
	options?: {
		activeDragTaskId?: string | null;
		programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
		isActiveDragTaskSessionRunning?: boolean;
		canReturnActiveDragTaskToBacklog?: boolean;
	},
): boolean {
	if (!activeDragSourceColumnId) {
		return false;
	}
	const moveRuleOptions: CardMoveRuleOptions = {
		taskId: options?.activeDragTaskId,
		programmaticCardMoveInFlight: options?.programmaticCardMoveInFlight,
		isTaskSessionRunning: options?.isActiveDragTaskSessionRunning,
		canReturnTaskToBacklog: options?.canReturnActiveDragTaskToBacklog,
	};
	if (columnId === "review") {
		return !isAllowedCrossColumnCardMove(activeDragSourceColumnId, columnId, moveRuleOptions);
	}
	if (columnId === "backlog") {
		return (
			activeDragSourceColumnId !== "backlog" &&
			!isAllowedCrossColumnCardMove(activeDragSourceColumnId, columnId, moveRuleOptions)
		);
	}
	if (columnId === "in_progress") {
		if (activeDragSourceColumnId === "backlog" || activeDragSourceColumnId === "in_progress") {
			return false;
		}
		return !isAllowedCrossColumnCardMove(activeDragSourceColumnId, columnId, moveRuleOptions);
	}
	if (columnId === "done") {
		return !isAllowedCrossColumnCardMove(activeDragSourceColumnId, columnId, moveRuleOptions);
	}
	if (columnId === "trash") {
		return activeDragSourceColumnId === "trash";
	}
	return false;
}
