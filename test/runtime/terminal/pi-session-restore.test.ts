import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
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
});
