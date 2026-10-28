import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { getTaskWriterActivity, isTaskWriterActive } from "../../../src/server/task-writer-activity";

function summary(state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId: "task",
		state,
		agentId: "cline",
		workspacePath: "/task",
		pid: null,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe("task writer activity", () => {
	it.each([null, "idle", "awaiting_review", "interrupted", "failed"] as const)(
		"ignores a hydrated terminal running record with no process when Cline is %s",
		(state) => {
			const cline = state ? summary(state) : null;
			const terminal = summary("running");
			const sources = {
				clineTaskSessionService: { getSummary: () => cline },
				terminalManager: { getSummary: () => terminal, hasActiveProcess: () => false },
			};
			expect(isTaskWriterActive("task", sources)).toBe(false);
			expect(getTaskWriterActivity("task", sources)).toEqual({
				clineSummary: cline,
				terminalSummary: terminal,
				terminalHasActiveProcess: false,
				writerActive: false,
			});
		},
	);

	it.each([
		["running", "idle", false],
		["idle", "running", true],
	] as const)("blocks a real writer: Cline %s, terminal %s, process %s", (cline, terminal, process) => {
		expect(
			isTaskWriterActive("task", {
				clineTaskSessionService: { getSummary: () => summary(cline) },
				terminalManager: { getSummary: () => summary(terminal), hasActiveProcess: () => process },
			}),
		).toBe(true);
	});
});
