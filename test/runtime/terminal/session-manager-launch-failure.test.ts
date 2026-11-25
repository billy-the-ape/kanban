import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

// The PTY is the only thing mocked here: the adapters run for real, so an
// adapter that refuses a request (Pi + plan mode) is the actual failure the
// manager has to survive instead of a stand-in rejection.
vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import { TerminalSessionManager } from "../../../src/terminal/session-manager";

function createPtySession(pid: number) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
	};
}

/**
 * Launch failures used to leave no trace: the summary was never written, so the
 * card read as an ordinary idle task. These tests pin the persisted record and
 * the one server-side log line that replaced the silence.
 */
describe("TerminalSessionManager launch failures (AA-UNSUPPORTED)", () => {
	let stdoutLines: string[] = [];
	let _stdoutWrite: typeof process.stdout.write;

	beforeEach(() => {
		ptySessionSpawnMock.mockReset();
		ptySessionSpawnMock.mockImplementation(() => createPtySession(4321));
		stdoutLines = [];
		_stdoutWrite = process.stdout.write;
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			stdoutLines.push(String(chunk));
			return true;
		}) as unknown as typeof process.stdout.write);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function loggedLines(): string {
		return stdoutLines.join("");
	}

	it("persists a failed summary when the adapter refuses the launch", async () => {
		const manager = new TerminalSessionManager();
		const emitted: RuntimeTaskSessionSummary[] = [];
		manager.onSummary((summary) => emitted.push(summary));

		// Pi has no plan mode, so the real adapter refuses instead of quietly
		// starting an Act run.
		await expect(
			manager.startTaskSession({
				taskId: "task-1",
				agentId: "pi",
				binary: "pi",
				args: [],
				cwd: "/tmp/worktree",
				prompt: "Plan this refactor",
				startInPlanMode: true,
				workspaceId: "workspace-1",
			}),
		).rejects.toThrow(/plan mode/i);

		const summary = manager.getSummary("task-1");
		expect(summary?.state).toBe("failed");
		expect(summary?.reviewReason).toBe("error");
		expect(summary?.agentId).toBe("pi");
		expect(summary?.workspacePath).toBe("/tmp/worktree");
		// Nothing ran, so nothing may look like it ran.
		expect(summary?.pid).toBeNull();
		expect(summary?.startedAt).toBeNull();
		expect(summary?.launchAttemptId).toBeNull();
		expect(summary?.warningMessage).toMatch(/plan mode/i);
		// The failure reached the summary listeners (so the card, the detail view
		// and the diagnostics download all show it) and the server log.
		expect(emitted.at(-1)?.state).toBe("failed");
		expect(loggedLines()).toContain("task-launch-failed task=task-1");
		expect(loggedLines()).toContain("stage=adapter-preparation");
		expect(loggedLines()).toContain("agent=pi");
		expect(loggedLines()).toContain("workspace=workspace-1");
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
	});

	it("persists the formatted reason when the process cannot be spawned", async () => {
		ptySessionSpawnMock.mockImplementation(() => {
			throw new Error("posix_spawnp failed");
		});
		const manager = new TerminalSessionManager();

		await expect(
			manager.startTaskSession({
				taskId: "task-2",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp/worktree",
				prompt: "Fix the bug",
			}),
		).rejects.toThrow(/Failed to launch "claude"/);

		const summary = manager.getSummary("task-2");
		expect(summary?.state).toBe("failed");
		expect(summary?.reviewReason).toBe("error");
		expect(summary?.agentId).toBe("claude");
		expect(summary?.pid).toBeNull();
		expect(summary?.warningMessage).toContain("Command not found");
		expect(loggedLines()).toContain("task-launch-failed task=task-2");
		expect(loggedLines()).toContain("stage=process-spawn");
		expect(loggedLines()).toContain("agent=claude");
	});

	it("clears the recorded failure once an agent actually starts", async () => {
		const manager = new TerminalSessionManager();
		await expect(
			manager.startTaskSession({
				taskId: "task-3",
				agentId: "pi",
				binary: "pi",
				args: [],
				cwd: "/tmp/worktree",
				prompt: "Plan this",
				startInPlanMode: true,
			}),
		).rejects.toThrow(/plan mode/i);
		expect(manager.getSummary("task-3")?.state).toBe("failed");

		const summary = await manager.startTaskSession({
			taskId: "task-3",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/worktree",
			prompt: "Do it",
		});

		expect(summary.state).toBe("running");
		expect(summary.pid).toBe(4321);
		// A stale failure on a live session would keep the card reading as broken.
		expect(summary.warningMessage ?? null).toBeNull();
	});
});
