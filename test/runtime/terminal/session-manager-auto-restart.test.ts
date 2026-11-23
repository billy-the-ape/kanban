import { beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
		triggerData: (chunk: string | Buffer) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

describe("TerminalSessionManager auto-restart", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	it("restores a saved Pi conversation in Review without starting a turn or losing checkpoints", async () => {
		const session = createMockPtySession(222, {});
		ptySessionSpawnMock.mockReturnValue(session);
		const manager = new TerminalSessionManager();
		const checkpoint = { turn: 7, ref: "refs/kanban/checkpoints/task-1/turn/7", commit: "abc1234", createdAt: 7 };
		manager.hydrateFromRecord({
			"task-1": {
				taskId: "task-1", state: "awaiting_review", agentId: "pi",
				workspacePath: "/tmp/task-1", pid: 111, startedAt: 1, updatedAt: 2,
				lastOutputAt: 2, reviewReason: "hook", exitCode: null,
				lastHookAt: 2, latestHookActivity: null,
				latestTurnCheckpoint: checkpoint, previousTurnCheckpoint: null,
			},
		});
		const restored = await manager.startTaskSession({
			taskId: "task-1", agentId: "pi", binary: "pi", args: [],
			cwd: "/tmp/task-1", prompt: "", restoreDetachedSession: true,
		});
		expect(restored.state).toBe("awaiting_review");
		expect(restored.reviewReason).toBe("hook");
		expect(restored.latestTurnCheckpoint).toEqual(checkpoint);
		expect(restored.pid).toBe(222);
		expect(prepareAgentLaunchMock).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: "", agentId: "pi" }),
		);
		const second = await manager.startTaskSession({
			taskId: "task-1", agentId: "pi", binary: "pi", args: [],
			cwd: "/tmp/task-1", prompt: "", restoreDetachedSession: true,
		});
		expect(second.pid).toBe(222);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
	});

	it("restores an interrupted Pi session to a hook-resumable, input-ready state", async () => {
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => createMockPtySession(222, request));
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": {
				taskId: "task-1", state: "running", agentId: "pi",
				workspacePath: "/tmp/task-1", pid: 111, startedAt: 1, updatedAt: 2,
				lastOutputAt: 2, reviewReason: null, exitCode: null,
				lastHookAt: null, latestHookActivity: null,
			},
		});
		const restored = await manager.startTaskSession({
			taskId: "task-1", agentId: "pi", binary: "pi", args: [],
			cwd: "/tmp/task-1", prompt: "", restoreDetachedSession: true,
		});
		expect(restored.state).toBe("awaiting_review");
		expect(restored.reviewReason).toBe("attention");
		expect(manager.transitionToRunning("task-1")?.state).toBe("running");
		expect(manager.transitionToReview("task-1", "hook")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.reviewReason).toBe("hook");
	});

	it("does not replay the original Pi task prompt when its initial process crashes", async () => {
		const sessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(123, request);
			sessions.push(session);
			return session;
		});
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession({
			taskId: "task-1", agentId: "pi", binary: "pi", args: [],
			cwd: "/tmp/task-1", prompt: "Create code and push a PR",
		});
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		sessions[0]?.triggerExit(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.hasActiveProcess("task-1")).toBe(false);
	});

	it("does not auto-restart a restored Pi PTY after its process exits", async () => {
		const sessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(222, request);
			sessions.push(session);
			return session;
		});
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": {
				taskId: "task-1", state: "awaiting_review", agentId: "pi",
				workspacePath: "/tmp/task-1", pid: 111, startedAt: 1, updatedAt: 2,
				lastOutputAt: 2, reviewReason: "hook", exitCode: null,
				lastHookAt: null, latestHookActivity: null,
			},
		});
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession({
			taskId: "task-1", agentId: "pi", binary: "pi", args: [],
			cwd: "/tmp/task-1", prompt: "", restoreDetachedSession: true,
		});
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		sessions[0]?.triggerExit(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.hasActiveProcess("task-1")).toBe(false);
	});

	it("restarts an attached agent session after it exits", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		spawnedSessions[0]?.triggerExit(130);

		await vi.waitFor(() => {
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		});
		expect(manager.getSummary("task-1")?.state).toBe("running");
		expect(manager.getSummary("task-1")?.pid).toBe(222);
	});

	it("does not restart an attached agent session after an explicit stop", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		manager.stopTaskSession("task-1");
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.pid).toBeNull();
	});

	it("sends deferred Codex startup input when the prompt marker appears", async () => {
		const deferredStartupInput = "\u001b[200~/plan Validate rollout\u001b[201~\r";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupInput,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			startInPlanMode: true,
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData("Booting Codex\n");
		expect(session.write).not.toHaveBeenCalledWith(deferredStartupInput);

		session.triggerData("› ");
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
	});

	it("sends deferred Codex startup input when the startup UI header appears", async () => {
		const deferredStartupInput = "\u001b[200~/plan Validate startup UI detect\u001b[201~\r";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupInput,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			startInPlanMode: true,
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData(">_ OpenAI Codex (v0.117.0)\n");
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
	});
});
