import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	collectRestorablePiCardIds,
	isDetachedPiRestoreCandidate,
	isSettledPiSummaryWithoutProcess,
} from "../../../src/terminal/pi-session-restore";

function createPiSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "pi",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function createBoard(cardsByColumn: Record<string, string[]>): RuntimeBoardData {
	return {
		columns: Object.entries(cardsByColumn).map(([id, cards]) => ({
			id,
			title: id,
			cards: cards.map((cardId) => ({ id: cardId })),
		})),
	} as unknown as RuntimeBoardData;
}

describe("isDetachedPiRestoreCandidate", () => {
	it("accepts the records Kanban writes when it lost a live Pi process", () => {
		// A graceful shutdown (or a hard stop) rewrites the summary to
		// `interrupted`, and an orphaned record from a previous runtime still
		// claims the pid of a process that no longer exists.
		expect(isDetachedPiRestoreCandidate(createPiSummary({ state: "interrupted", pid: null }))).toBe(true);
		expect(isDetachedPiRestoreCandidate(createPiSummary({ state: "interrupted", reviewReason: "interrupted" }))).toBe(
			true,
		);
		expect(isDetachedPiRestoreCandidate(createPiSummary({ state: "running" }))).toBe(true);
		expect(isDetachedPiRestoreCandidate(createPiSummary({ state: "awaiting_review", reviewReason: "hook" }))).toBe(
			true,
		);
	});

	it("rejects a Pi session that already ended on its own", () => {
		// The user pressed Stop (or the turn finished/crashed) before the restart,
		// so nothing was lost: reopening the task must not relaunch the agent.
		expect(
			isDetachedPiRestoreCandidate(createPiSummary({ state: "awaiting_review", reviewReason: "exit", pid: null })),
		).toBe(false);
		expect(
			isDetachedPiRestoreCandidate(createPiSummary({ state: "awaiting_review", reviewReason: "error", pid: null })),
		).toBe(false);
		expect(isDetachedPiRestoreCandidate(createPiSummary({ state: "idle", pid: null }))).toBe(false);
		expect(isDetachedPiRestoreCandidate(createPiSummary({ state: "failed", pid: null }))).toBe(false);
	});

	it("rejects every non-Pi summary and a missing record", () => {
		expect(isDetachedPiRestoreCandidate(null)).toBe(false);
		expect(isDetachedPiRestoreCandidate(createPiSummary({ agentId: "codex", state: "interrupted" }))).toBe(false);
		expect(isDetachedPiRestoreCandidate(createPiSummary({ agentId: null }))).toBe(false);
	});
});

describe("isSettledPiSummaryWithoutProcess", () => {
	it("marks the Pi sessions this runtime has no process to interrupt", () => {
		expect(isSettledPiSummaryWithoutProcess(createPiSummary({ state: "awaiting_review", pid: null }))).toBe(true);
		expect(isSettledPiSummaryWithoutProcess(createPiSummary({ state: "idle", pid: null }))).toBe(true);
		// `running` with no pid is the orphaned record of a previous runtime, which
		// is precisely the session a restart is expected to recover.
		expect(isSettledPiSummaryWithoutProcess(createPiSummary({ state: "running", pid: null }))).toBe(false);
		expect(isSettledPiSummaryWithoutProcess(createPiSummary())).toBe(false);
		expect(isSettledPiSummaryWithoutProcess(createPiSummary({ agentId: "codex", pid: null }))).toBe(false);
	});

	it("never treats an interrupted Pi record as ended on its own", () => {
		// Both a graceful shutdown and the terminal's stale-record recovery leave a
		// card in exactly this shape. If the shutdown coordinator read it as ended,
		// the next shutdown — before the user reopened the task — would archive the
		// worktree the earlier one deliberately kept, stranding the conversation.
		expect(isSettledPiSummaryWithoutProcess(createPiSummary({ state: "interrupted", pid: null }))).toBe(false);
		expect(
			isSettledPiSummaryWithoutProcess(
				createPiSummary({ state: "interrupted", reviewReason: "interrupted", pid: null }),
			),
		).toBe(false);
	});
});

describe("collectRestorablePiCardIds", () => {
	it("returns the cards in the two lanes a restore may be asked for", () => {
		// Shared by the restore guard and the shutdown coordinator, so the worktree
		// it keeps is exactly the one the guard is allowed to reattach into.
		const ids = collectRestorablePiCardIds(
			createBoard({ backlog: ["b"], in_progress: ["p"], review: ["r"], done: ["d"], trash: ["t"] }),
		);
		expect(Array.from(ids).sort()).toEqual(["p", "r"]);
	});
});
