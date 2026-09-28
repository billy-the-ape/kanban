import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	isAllowedCrossColumnCardMove,
	isCardDropDisabled,
	isTaskSessionRunning,
	type ProgrammaticCardMoveInFlight,
} from "@/state/drag-rules";

describe("drag rules", () => {
	it("keeps manual in-progress to review drops disabled", () => {
		expect(isCardDropDisabled("review", "in_progress")).toBe(true);
	});

	it("allows the matching programmatic in-progress to review drop", () => {
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "in_progress",
			toColumnId: "review",
			insertAtTop: true,
		};

		expect(
			isCardDropDisabled("review", "in_progress", {
				activeDragTaskId: "task-1",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(false);
		expect(
			isCardDropDisabled("review", "in_progress", {
				activeDragTaskId: "task-2",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(true);
	});

	it("allows the matching programmatic review to in-progress drop", () => {
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "review",
			toColumnId: "in_progress",
			insertAtTop: true,
		};

		expect(
			isCardDropDisabled("in_progress", "review", {
				activeDragTaskId: "task-1",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(false);
		expect(
			isCardDropDisabled("in_progress", "review", {
				activeDragTaskId: "task-1",
				programmaticCardMoveInFlight: {
					...move,
					toColumnId: "review",
				},
			}),
		).toBe(true);
	});

	it("allows manual trash to review drops", () => {
		expect(isCardDropDisabled("review", "trash")).toBe(false);
	});

	it("allows discarding completed (done) cards into trash", () => {
		expect(isCardDropDisabled("trash", "done")).toBe(false);
		expect(isCardDropDisabled("done", "review")).toBe(false);
		expect(isCardDropDisabled("done", "in_progress")).toBe(true);
	});

	it("allows reopening completed (done) cards in review", () => {
		expect(isCardDropDisabled("review", "done")).toBe(false);
		expect(isAllowedCrossColumnCardMove("done", "review")).toBe(true);
		expect(isAllowedCrossColumnCardMove("done", "backlog")).toBe(false);
	});

	it("allows moving an in-progress card to review only once its session has stopped", () => {
		expect(isCardDropDisabled("review", "in_progress", { isActiveDragTaskSessionRunning: false })).toBe(false);
		expect(isCardDropDisabled("review", "in_progress", { isActiveDragTaskSessionRunning: true })).toBe(true);
		expect(isAllowedCrossColumnCardMove("in_progress", "review", { isTaskSessionRunning: false })).toBe(true);
		expect(isAllowedCrossColumnCardMove("in_progress", "review", { isTaskSessionRunning: true })).toBe(false);
		expect(isAllowedCrossColumnCardMove("in_progress", "review")).toBe(false);
	});

	it("treats only a running session as running", () => {
		expect(isTaskSessionRunning(undefined)).toBe(false);
		expect(isTaskSessionRunning({ state: "running" } as RuntimeTaskSessionSummary)).toBe(true);
		expect(isTaskSessionRunning({ state: "interrupted" } as RuntimeTaskSessionSummary)).toBe(false);
		expect(isTaskSessionRunning({ state: "failed" } as RuntimeTaskSessionSummary)).toBe(false);
	});
});
