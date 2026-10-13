// LASTPROMPT: server-side persistence of the latest user-authored task-chat
// prompt on the task card.
//
// Only the native `sendTaskChatMessage` route feeds this, and only after the
// send was accepted (running-session send or successful persisted-session
// rebind). Rejected sends, slash commands, image-only sends, home-agent
// sessions, and automated callers (generated commit/PR instructions) never
// call the recorder. The write goes through `mutateWorkspaceState` under the
// workspace lock, updates the card timestamp and the workspace revision, and
// broadcasts the updated workspace state so open clients refresh their
// preview.
//
// Best-effort by contract: the recorder never throws and never recreates a
// deleted card. Failures are logged by the caller, which must keep the chat
// send reported as successful (no duplicate-submission prompts).
import type { RuntimeBoardCard, RuntimeBoardData } from "../core/api-contract";
import { findTaskLocation } from "../core/task-board-mutations";
import { mutateWorkspaceState } from "../state/workspace-state";
import { logWorkspaceEvent } from "./workspace-logger";

export interface RecordTaskLastPromptInput {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	/** Submitted user text exactly as accepted (before any workflow expansion). */
	text: string;
	/**
	 * Acceptance timestamp captured when the send was accepted. Orders
	 * concurrent accepted sends: an older accepted prompt must never
	 * overwrite a newer one, regardless of async completion order.
	 */
	acceptedAt: number;
	broadcast?: (workspaceId: string, workspacePath: string) => void | Promise<void>;
}

export type RecordTaskLastPromptOutcome = "recorded" | "skipped" | "no_task" | "failed";

/**
 * Applies the recorded prompt to an existing card, or returns the board
 * unchanged when the card does not exist (a deleted card must not be
 * recreated) or when the accepted prompt is older than the persisted one.
 */
export function applyTaskLastPromptToBoard(
	board: RuntimeBoardData,
	taskId: string,
	text: string,
	acceptedAt: number,
): { board: RuntimeBoardData; updated: boolean } {
	const found = findTaskLocation(board, taskId.trim());
	if (!found) {
		return { board, updated: false };
	}
	const existing = found.task;
	if (typeof existing.lastPromptAt === "number" && acceptedAt < existing.lastPromptAt) {
		return { board, updated: false };
	}
	const updated: RuntimeBoardCard = {
		...existing,
		lastPrompt: text,
		lastPromptAt: acceptedAt,
		updatedAt: acceptedAt,
	};
	const columns = board.columns.map((column) =>
		column.id === found.columnId
			? { ...column, cards: column.cards.map((card) => (card.id === existing.id ? updated : card)) }
			: column,
	);
	return { board: { ...board, columns }, updated: true };
}

/** Removes the server-owned last-prompt fields from a card (explicit reset). */
export function clearTaskLastPrompt(board: RuntimeBoardData, taskId: string): RuntimeBoardData {
	const found = findTaskLocation(board, taskId.trim());
	if (!found) {
		return board;
	}
	const columns = board.columns.map((column) =>
		column.id === found.columnId
			? {
					...column,
					cards: column.cards.map((card) => {
						if (card.id !== found.task.id) {
							return card;
						}
						const next: RuntimeBoardCard = { ...card };
						delete next.lastPrompt;
						delete next.lastPromptAt;
						return next;
					}),
				}
			: column,
	);
	return { ...board, columns };
}

/**
 * Records the latest user-authored prompt on an existing card. Never throws;
 * returns the outcome so the caller can log persistence failures without
 * surfacing them as chat-send failures.
 */
export async function recordTaskLastPrompt(input: RecordTaskLastPromptInput): Promise<RecordTaskLastPromptOutcome> {
	const text = input.text.trim();
	if (!text) {
		// Blank / image-only sends leave the previous preview unchanged.
		return "skipped";
	}
	try {
		const result = await mutateWorkspaceState<RuntimeBoardCard | null>(input.workspacePath, (state) => {
			const applied = applyTaskLastPromptToBoard(state.board, input.taskId, text, input.acceptedAt);
			const found = findTaskLocation(state.board, input.taskId.trim());
			return {
				board: applied.board,
				value: found ? found.task : null,
				save: applied.updated,
			};
		});
		if (result.value === null) {
			// Deleted-card race: never recreate the card.
			return "no_task";
		}
		if (!result.saved) {
			return "skipped";
		}
		void input.broadcast?.(input.workspaceId, input.workspacePath);
		return "recorded";
	} catch (error) {
		logWorkspaceEvent(
			`last-prompt persist failed workspace=${input.workspaceId} task=${input.taskId} error=${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return "failed";
	}
}
