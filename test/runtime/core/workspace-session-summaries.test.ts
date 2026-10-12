import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { resolveWorkspaceSessionSummaries } from "../../../src/core/workspace-session-summaries";

function summary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "7wp6m",
		state: "running",
		agentId: "cline",
		pid: null,
		workspacePath: "/worktrees/7wp6m/kanban",
		startedAt: 100,
		updatedAt: 110,
		lastOutputAt: 110,
		reviewReason: null,
		exitCode: null,
		lastHookAt: 110,
		latestHookActivity: null,
		latestTurnCheckpoint: { turn: 1, ref: "refs/checkpoint/1", commit: "abc", createdAt: 100 },
		previousTurnCheckpoint: null,
		...overrides,
	};
}

describe("workspace session reconciliation", () => {
	it("stops a hydrated running record without losing its work or checkpoints", () => {
		const old = summary();
		const terminal = { listSummaries: () => [old], hasActiveProcess: () => false };
		const result = resolveWorkspaceSessionSummaries({ [old.taskId]: old }, terminal, []);
		expect(result[old.taskId]).toMatchObject({ state: "interrupted", reviewReason: "interrupted", pid: null });
		expect(result[old.taskId]?.workspacePath).toBe(old.workspacePath);
		expect(result[old.taskId]?.latestTurnCheckpoint).toEqual(old.latestTurnCheckpoint);
		expect(result[old.taskId]?.updatedAt).toBeGreaterThan(old.updatedAt);
		expect(old.state).toBe("running");
	});

	it.each(["running", "idle", "awaiting_review"] as const)(
		"prefers the resumed Cline owner's %s state over the old terminal copy",
		(state) => {
			const old = summary();
			const resumed = summary({ state, startedAt: 200, updatedAt: 210 });
			const terminal = { listSummaries: () => [old], hasActiveProcess: () => false };
			expect(resolveWorkspaceSessionSummaries({ [old.taskId]: old }, terminal, [resumed])[old.taskId]).toBe(resumed);
		},
	);

	it("keeps a newer saved completed session when an older terminal copy is replayed", () => {
		const old = summary();
		const completed = summary({ state: "awaiting_review", updatedAt: 210, startedAt: 200 });
		const terminal = { listSummaries: () => [old], hasActiveProcess: () => false };
		expect(resolveWorkspaceSessionSummaries({ [old.taskId]: completed }, terminal, [])[old.taskId]).toBe(completed);
	});

	it("does not resurrect an orphan after its reconciled record is saved", () => {
		const old = summary();
		const terminal = { listSummaries: () => [old], hasActiveProcess: () => false };
		const stopped = resolveWorkspaceSessionSummaries({ [old.taskId]: old }, terminal, []);
		expect(resolveWorkspaceSessionSummaries(stopped, terminal, [])).toEqual(stopped);
	});

	it("keeps a real terminal process running even when a stopped Cline copy exists", () => {
		const active = summary({ agentId: "claude", pid: 123 });
		const terminal = { listSummaries: () => [active], hasActiveProcess: () => true };
		const oldCline = summary({ state: "idle" });
		expect(resolveWorkspaceSessionSummaries({}, terminal, [oldCline])[active.taskId]).toBe(active);
	});
});
