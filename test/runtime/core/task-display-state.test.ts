import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import {
	countTasksByDisplayState,
	createEmptyTaskCounts,
	isPlaceholderSessionSummary,
	mergeSessionSummaries,
	pickNewerSessionSummary,
	resolveTaskDisplayState,
} from "../../../src/core/task-display-state";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task",
		state: "running",
		agentId: "cline",
		workspacePath: "/repos/project",
		pid: null,
		startedAt: 100,
		updatedAt: 100,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createBoard(cardIdsByColumn: Partial<Record<RuntimeBoardColumnId, string[]>>): RuntimeBoardData {
	const allColumns: Array<{ id: RuntimeBoardColumnId; title: string }> = [
		{ id: "backlog", title: "Backlog" },
		{ id: "in_progress", title: "In Progress" },
		{ id: "review", title: "Review" },
		{ id: "done", title: "Done" },
		{ id: "trash", title: "Trash" },
	];
	return {
		columns: allColumns.map((column) => ({
			...column,
			cards: (cardIdsByColumn[column.id] ?? []).map(
				(id) =>
					({
						id,
						title: id,
						prompt: "",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 100,
						updatedAt: 100,
					}) satisfies RuntimeBoardCard,
			),
		})),
		dependencies: [],
	};
}

describe("resolveTaskDisplayState", () => {
	it.each(["backlog", "in_progress", "review", "done", "trash"] as const)(
		"maps %s cards without a summary to their column",
		(columnId) => {
			expect(resolveTaskDisplayState(columnId, undefined)).toBe(columnId);
		},
	);

	it("keeps an in-progress card in progress without a summary or with a placeholder summary", () => {
		expect(resolveTaskDisplayState("in_progress", undefined)).toBe("in_progress");
		const placeholder = createSummary({ state: "idle", agentId: null, workspacePath: null, startedAt: null });
		expect(isPlaceholderSessionSummary(placeholder)).toBe(true);
		expect(resolveTaskDisplayState("in_progress", placeholder)).toBe("in_progress");
	});

	it.each([
		["idle", "paused"],
		["interrupted", "paused"],
		["failed", "paused"],
		["awaiting_review", "review"],
		["running", "in_progress"],
	] as const)("%s displays as %s for an in-progress card", (state, expected) => {
		expect(resolveTaskDisplayState("in_progress", createSummary({ state }))).toBe(expected);
	});

	it("counts a running card queued behind a concurrency slot as paused", () => {
		const queuedHook = {
			canReturnToBacklog: false,
			activityText: "Waiting for a slot",
			toolName: null,
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: "concurrency_waiting",
			notificationType: null,
			source: null,
		};
		const queued = createSummary({ state: "running", latestHookActivity: queuedHook });
		expect(resolveTaskDisplayState("in_progress", queued)).toBe("paused");

		const workingHook = { ...queuedHook, activityText: "Working", hookEventName: "post_tool_use" };
		expect(resolveTaskDisplayState("in_progress", { ...queued, latestHookActivity: workingHook })).toBe(
			"in_progress",
		);
	});
});

describe("countTasksByDisplayState", () => {
	it("counts cards by display state across all columns", () => {
		const board = createBoard({
			backlog: ["backlog-1"],
			in_progress: ["running-1", "paused-1", "review-1"],
			review: ["review-2"],
			done: ["done-1"],
			trash: ["trash-1"],
		});
		const sessions: Record<string, RuntimeTaskSessionSummary> = {
			"running-1": createSummary({ taskId: "running-1", state: "running" }),
			"paused-1": createSummary({ taskId: "paused-1", state: "idle" }),
			"review-1": createSummary({ taskId: "review-1", state: "awaiting_review" }),
		};
		expect(countTasksByDisplayState(board, sessions)).toEqual({
			backlog: 1,
			in_progress: 1,
			paused: 1,
			review: 2,
			done: 1,
			trash: 1,
		});
	});

	it("returns empty counts for an empty board", () => {
		expect(countTasksByDisplayState(createBoard({}), {})).toEqual(createEmptyTaskCounts());
	});
});

describe("pickNewerSessionSummary", () => {
	it("returns the candidate when there is no current summary", () => {
		const candidate = createSummary();
		expect(pickNewerSessionSummary(undefined, candidate)).toBe(candidate);
	});

	it("prefers the newer summary for two real summaries and keeps the current one on an older candidate", () => {
		const current = createSummary({ state: "idle", updatedAt: 200 });
		const newer = createSummary({ state: "running", updatedAt: 300 });
		const older = createSummary({ state: "running", updatedAt: 100 });
		expect(pickNewerSessionSummary(current, newer)).toBe(newer);
		expect(pickNewerSessionSummary(newer, older)).toBe(newer);
	});

	it("lets the candidate win an exact timestamp tie", () => {
		const current = createSummary({ state: "idle", updatedAt: 200 });
		const candidate = createSummary({ state: "running", updatedAt: 200 });
		expect(pickNewerSessionSummary(current, candidate)).toBe(candidate);
	});

	it("always prefers a real summary over a placeholder, regardless of timestamp", () => {
		const real = createSummary({ state: "idle", updatedAt: 100 });
		const placeholder = createSummary({
			state: "idle",
			agentId: null,
			workspacePath: null,
			startedAt: null,
			updatedAt: 999,
		});
		expect(pickNewerSessionSummary(real, placeholder)).toBe(real);
		expect(pickNewerSessionSummary(placeholder, real)).toBe(real);
	});
});

describe("mergeSessionSummaries", () => {
	it("merges sources in order with later sources winning ties and real summaries beating placeholders", () => {
		const disk = createSummary({ taskId: "a", state: "idle", updatedAt: 100 });
		const browser = createSummary({ taskId: "a", state: "idle", updatedAt: 100 });
		const terminal = createSummary({
			taskId: "a",
			state: "idle",
			agentId: null,
			workspacePath: null,
			startedAt: null,
			updatedAt: 500,
		});
		const cline = createSummary({ taskId: "a", state: "running", updatedAt: 200 });
		const merged = mergeSessionSummaries(
			[disk],
			[browser, createSummary({ taskId: "b", state: "running", updatedAt: 1 })],
			[terminal],
			[cline],
		);
		// Tie between disk and browser: browser (later source) wins, then the
		// Cline summary beats the placeholder and the older browser copy.
		expect(merged["a"]).toBe(cline);
		expect(merged["b"]).toBeDefined();
	});

	it("keeps disk-only summaries that no later source mentions", () => {
		const disk = createSummary({ taskId: "a", state: "idle", updatedAt: 100 });
		const merged = mergeSessionSummaries([disk], []);
		expect(merged["a"]).toBe(disk);
	});
});
