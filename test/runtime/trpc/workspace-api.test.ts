import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary, RuntimeWorkspaceChangesResponse } from "../../../src/core/api-contract";

const workspaceTaskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
	deleteTaskWorktree: vi.fn(),
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
}));

const workspaceChangesMocks = vi.hoisted(() => ({
	createEmptyWorkspaceChangesResponse: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	getWorkspaceChangesBetweenRefs: vi.fn(),
	getWorkspaceChangesFromRef: vi.fn(),
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	deleteTaskWorktree: workspaceTaskWorktreeMocks.deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist: workspaceTaskWorktreeMocks.ensureTaskWorktreeIfDoesntExist,
	getTaskWorkspaceInfo: vi.fn(),
	resolveTaskCwd: workspaceTaskWorktreeMocks.resolveTaskCwd,
}));

vi.mock("../../../src/workspace/get-workspace-changes.js", () => ({
	createEmptyWorkspaceChangesResponse: workspaceChangesMocks.createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges: workspaceChangesMocks.getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs: workspaceChangesMocks.getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef: workspaceChangesMocks.getWorkspaceChangesFromRef,
}));

const prLinkMocks = vi.hoisted(() => ({
	loadWorkspaceBoardById: vi.fn(),
	saveWorkspaceState: vi.fn(),
	mutateWorkspaceState: vi.fn(),
	recordTaskPullRequests: vi.fn(),
	lookupTaskPullRequests: vi.fn(),
	fireReviewPullRequestLookup: vi.fn(),
	findTasksEnteringReviewWithoutPullRequests: vi.fn(),
	removeTaskPullRequest: vi.fn(),
	setPrimaryTaskPullRequest: vi.fn(),
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	loadWorkspaceBoardById: prLinkMocks.loadWorkspaceBoardById,
	saveWorkspaceState: prLinkMocks.saveWorkspaceState,
	mutateWorkspaceState: prLinkMocks.mutateWorkspaceState,
	WorkspaceStateConflictError: class WorkspaceStateConflictError extends Error {},
}));

vi.mock("../../../src/workspace/task-pull-requests.js", () => ({
	recordTaskPullRequests: prLinkMocks.recordTaskPullRequests,
}));

vi.mock("../../../src/workspace/task-pull-request-lookup.js", () => ({
	findTasksEnteringReviewWithoutPullRequests: prLinkMocks.findTasksEnteringReviewWithoutPullRequests,
	fireReviewPullRequestLookup: prLinkMocks.fireReviewPullRequestLookup,
	lookupTaskPullRequests: prLinkMocks.lookupTaskPullRequests,
}));

vi.mock("../../../src/core/task-board-mutations.js", () => ({
	removeTaskPullRequest: prLinkMocks.removeTaskPullRequest,
	setPrimaryTaskPullRequest: prLinkMocks.setPrimaryTaskPullRequest,
}));

import { createWorkspaceApi } from "../../../src/trpc/workspace-api";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createChangesResponse(): RuntimeWorkspaceChangesResponse {
	return {
		repoRoot: "/tmp/worktree",
		generatedAt: Date.now(),
		files: [],
	};
}

describe("createWorkspaceApi loadChanges", () => {
	beforeEach(() => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockReset();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockReset();
		workspaceChangesMocks.getWorkspaceChanges.mockReset();
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockReset();
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockReset();

		workspaceTaskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChanges.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockResolvedValue(createChangesResponse());
	});

	it("shows the completed turn diff while awaiting review", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "1111111",
			toRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).not.toHaveBeenCalled();
	});

	it("tracks the current turn from the latest checkpoint while running", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "running",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("uses native cline session checkpoints when terminal summaries are unavailable", async () => {
		const terminalManager = {
			getSummary: vi.fn(() => null),
		};
		const clineTaskSessionService = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					latestTurnCheckpoint: {
						turn: 3,
						ref: "refs/kanban/checkpoints/task-1/turn/3",
						commit: "3333333",
						createdAt: 3,
					},
					previousTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(clineTaskSessionService.getSummary).toHaveBeenCalledWith("task-1");
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
			toRef: "3333333",
		});
	});

	it("prefers the newer live cline summary over a stale terminal summary", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					agentId: "claude",
					updatedAt: 10,
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "terminal-2",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "terminal-1",
						createdAt: 1,
					},
				}),
			),
		};
		const clineTaskSessionService = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					agentId: "cline",
					updatedAt: 20,
					latestTurnCheckpoint: {
						turn: 3,
						ref: "refs/kanban/checkpoints/task-1/turn/3",
						commit: "cline-3",
						createdAt: 3,
					},
					previousTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "cline-2",
						createdAt: 2,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "cline-2",
			toRef: "cline-3",
		});
	});

	it("returns an empty diff when the task worktree does not exist yet", async () => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);

		const emptyResponse = createChangesResponse();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(emptyResponse);

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			getScopedClineTaskSessionService: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		const response = await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "working_copy",
			},
		);

		expect(response).toBe(emptyResponse);
		expect(workspaceChangesMocks.createEmptyWorkspaceChangesResponse).toHaveBeenCalledWith("/tmp/repo");
		expect(workspaceChangesMocks.getWorkspaceChanges).not.toHaveBeenCalled();
	});
});

describe("createWorkspaceApi deleteWorktree (B-5.5)", () => {
	const scope = { workspaceId: "workspace-1", workspacePath: "/tmp/repo" };

	function createApi(states: {
		cline: RuntimeTaskSessionSummary["state"] | null;
		terminal: RuntimeTaskSessionSummary["state"] | null;
	}) {
		return createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(
				async () =>
					({
						getSummary: vi.fn(() => (states.terminal ? createSummary({ state: states.terminal }) : null)),
					}) as never,
			),
			getScopedClineTaskSessionService: vi.fn(
				async () =>
					({
						getSummary: vi.fn(() => (states.cline ? createSummary({ state: states.cline }) : null)),
					}) as never,
			),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});
	}

	beforeEach(() => {
		workspaceTaskWorktreeMocks.deleteTaskWorktree.mockReset();
		workspaceTaskWorktreeMocks.deleteTaskWorktree.mockResolvedValue({
			ok: true,
			removed: true,
			preserved: true,
			blockedReason: null,
		});
	});

	it("refuses to remove a worktree while the task's agent session is running", async () => {
		for (const states of [
			{ cline: "running" as const, terminal: null },
			{ cline: null, terminal: "running" as const },
		]) {
			const response = await createApi(states).deleteWorktree(scope, { taskId: "task-1" });
			expect(response.ok).toBe(false);
			expect(response.removed).toBe(false);
			expect(response.blockedReason).toMatch(/still running/);
		}
		expect(workspaceTaskWorktreeMocks.deleteTaskWorktree).not.toHaveBeenCalled();
	});

	it("removes the worktree once no writer is active", async () => {
		const response = await createApi({ cline: "interrupted", terminal: null }).deleteWorktree(scope, {
			taskId: "task-1",
		});
		expect(response.removed).toBe(true);
		expect(workspaceTaskWorktreeMocks.deleteTaskWorktree).toHaveBeenCalledWith({
			repoPath: "/tmp/repo",
			taskId: "task-1",
		});
	});
});

describe("createWorkspaceApi ensureWorktree (UPD-0.5 refusal)", () => {
	const scope = { workspaceId: "workspace-1", workspacePath: "/tmp/repo" };

	function createApi() {
		return createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			getScopedClineTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});
	}

	beforeEach(() => {
		workspaceTaskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockReset();
	});

	it("passes the fresh-task refusal through unchanged so no worktree is created", async () => {
		workspaceTaskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockResolvedValue({
			ok: false,
			path: null,
			baseRef: "main",
			baseCommit: null,
			category: "initial_start_preparation_required",
			remedy: "Start the task to create its worktree.",
			error: 'The worktree for task "task-1" is created when the task starts, which prepares its base ref first. Start the task to create its worktree.',
			restoredFromPreservation: false,
		});

		const response = await createApi().ensureWorktree(scope, { taskId: "task-1", baseRef: "main" });
		expect(response.ok).toBe(false);
		if (response.ok) {
			throw new Error("Expected the generic ensure to be refused");
		}
		expect(response.path).toBeNull();
		expect(response.category).toBe("initial_start_preparation_required");
		expect(response.remedy).toBe("Start the task to create its worktree.");
		expect(workspaceTaskWorktreeMocks.ensureTaskWorktreeIfDoesntExist).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
		});
	});

	it("keeps the reuse behavior for tasks that already have a worktree", async () => {
		workspaceTaskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockResolvedValue({
			ok: true,
			path: "/tmp/worktrees/repo/task-1",
			baseRef: "main",
			baseCommit: "abc123",
			restoredFromPreservation: false,
		});

		const response = await createApi().ensureWorktree(scope, { taskId: "task-1", baseRef: "main" });
		expect(response.ok).toBe(true);
		if (response.ok) {
			expect(response.path).toBe("/tmp/worktrees/repo/task-1");
			expect(response.baseCommit).toBe("abc123");
		}
	});
});

// PRLINK-5: manual PR linking, removal, refresh, and the fire-and-forget
// branch lookup triggered on review entry. All board reads/writes are
// mocked; the real API code under test is the trpc layer.
describe("createWorkspaceApi PR linking (PRLINK-5)", () => {
	const scope = { workspaceId: "workspace-1", workspacePath: "/tmp/repo" };
	type TestPullRequest = import("../../../src/core/api-contract").RuntimeTaskPullRequest;

	function createBoard(
		taskId: string,
		pullRequests: TestPullRequest[] = [],
	): import("../../../src/core/api-contract").RuntimeBoardData {
		return {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{
					id: "review",
					title: "Review",
					cards: [
						{
							id: taskId,
							title: "Task",
							prompt: "Task prompt",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
							...(pullRequests.length > 0 ? { pullRequests } : {}),
						},
					],
				},
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};
	}

	function createApi(broadcast: (workspaceId: string, workspacePath: string) => void | Promise<void> = vi.fn()) {
		return {
			broadcast,
			api: createWorkspaceApi({
				ensureTerminalManagerForWorkspace: vi.fn(async () => ({ listSummaries: vi.fn(() => []) }) as never),
				getScopedClineTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
				broadcastRuntimeWorkspaceStateUpdated: broadcast,
				broadcastRuntimeProjectsUpdated: vi.fn(),
				buildWorkspaceStateSnapshot: vi.fn(),
			}),
		};
	}

	beforeEach(() => {
		prLinkMocks.loadWorkspaceBoardById.mockReset();
		prLinkMocks.saveWorkspaceState.mockReset();
		prLinkMocks.mutateWorkspaceState.mockReset();
		prLinkMocks.recordTaskPullRequests.mockReset();
		prLinkMocks.lookupTaskPullRequests.mockReset();
		prLinkMocks.fireReviewPullRequestLookup.mockReset();
		prLinkMocks.findTasksEnteringReviewWithoutPullRequests.mockReset();
		prLinkMocks.removeTaskPullRequest.mockReset();
		prLinkMocks.setPrimaryTaskPullRequest.mockReset();
	});

	it("addTaskPullRequest rejects unknown tasks without writing", async () => {
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(createBoard("task-2"));
		const { api } = createApi();

		const response = await api.addTaskPullRequest(scope, {
			taskId: "task-1",
			url: "https://github.com/owner/repo/pull/9",
		});

		expect(response).toEqual({ ok: false, error: 'Task "task-1" not found', pullRequest: null });
		expect(prLinkMocks.recordTaskPullRequests).not.toHaveBeenCalled();
	});

	it("addTaskPullRequest rejects URLs the strict parser does not accept", async () => {
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(createBoard("task-1"));
		const { api } = createApi();

		const response = await api.addTaskPullRequest(scope, {
			taskId: "task-1",
			url: "https://example.com/not-a-pr",
		});

		expect(response).toEqual({ ok: false, error: "Not a valid pull request URL.", pullRequest: null });
		expect(prLinkMocks.recordTaskPullRequests).not.toHaveBeenCalled();
	});

	it("addTaskPullRequest records with source manual and broadcasts", async () => {
		const board = createBoard("task-1");
		const entry: TestPullRequest = {
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
			number: 9,
			url: "https://github.com/owner/repo/pull/9",
			source: "manual",
			createdAt: 1,
		};
		prLinkMocks.loadWorkspaceBoardById
			.mockResolvedValueOnce(board)
			.mockResolvedValueOnce(createBoard("task-1", [entry]));
		prLinkMocks.recordTaskPullRequests.mockResolvedValue({ changed: true });
		const { api, broadcast } = createApi();

		const response = await api.addTaskPullRequest(scope, {
			taskId: "task-1",
			url: "https://github.com/owner/repo/pull/9",
		});

		expect(response.ok).toBe(true);
		if (!response.ok) {
			throw new Error("Expected the add to succeed");
		}
		expect(response.pullRequest).toMatchObject({
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
			number: 9,
			url: "https://github.com/owner/repo/pull/9",
			source: "manual",
		});
		expect(prLinkMocks.recordTaskPullRequests).toHaveBeenCalledWith({
			workspacePath: "/tmp/repo",
			taskId: "task-1",
			links: [expect.anything()],
			source: "manual",
		});
		expect(broadcast).toHaveBeenCalledWith("workspace-1", "/tmp/repo");
	});

	it("addTaskPullRequest treats a duplicate as success without broadcasting", async () => {
		const entry: TestPullRequest = {
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
			number: 9,
			url: "https://github.com/owner/repo/pull/9",
			source: "manual",
			createdAt: 1,
		};
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(createBoard("task-1", [entry]));
		prLinkMocks.recordTaskPullRequests.mockResolvedValue({ changed: false });
		const { api, broadcast } = createApi();

		const response = await api.addTaskPullRequest(scope, {
			taskId: "task-1",
			url: "https://github.com/owner/repo/pull/9#discussion_r1",
		});

		expect(response.ok).toBe(true);
		expect(broadcast).not.toHaveBeenCalled();
	});

	it("removeTaskPullRequest removes the recorded link and broadcasts", async () => {
		const board = createBoard("task-1", [
			{
				provider: "github",
				host: "github.com",
				repository: "owner/repo",
				number: 9,
				url: "https://github.com/owner/repo/pull/9",
				source: "manual",
				createdAt: 1,
			},
		]);
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(board);
		prLinkMocks.removeTaskPullRequest.mockImplementation((b: unknown, taskId: string) => ({
			board: b,
			taskId,
			removed: true,
		}));
		prLinkMocks.mutateWorkspaceState.mockImplementation(
			async (_cwd: string, mutator: (current: unknown) => unknown) => {
				const result = mutator({ board }) as { board: unknown; value: boolean; save: boolean };
				return { saved: result.save, value: result.value, board: result.board };
			},
		);
		const { api, broadcast } = createApi();

		const response = await api.removeTaskPullRequest(scope, {
			taskId: "task-1",
			url: "https://github.com/owner/repo/pull/9",
		});

		expect(response).toEqual({ ok: true, pullRequest: null });
		expect(prLinkMocks.removeTaskPullRequest).toHaveBeenCalledWith(board, "task-1", expect.any(String));
		expect(broadcast).toHaveBeenCalledWith("workspace-1", "/tmp/repo");
	});

	it("removeTaskPullRequest rejects when no matching link is recorded", async () => {
		const board = createBoard("task-1");
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(board);
		prLinkMocks.removeTaskPullRequest.mockImplementation((b: unknown) => ({ board: b, removed: false }));
		prLinkMocks.mutateWorkspaceState.mockResolvedValue({ saved: false, value: false, board });
		const { api, broadcast } = createApi();

		const response = await api.removeTaskPullRequest(scope, {
			taskId: "task-1",
			url: "https://github.com/owner/repo/pull/9",
		});

		expect(response).toEqual({
			ok: false,
			error: "No matching pull request is recorded for this task.",
			pullRequest: null,
		});
		expect(broadcast).not.toHaveBeenCalled();
	});

	it("refreshTaskPullRequests runs the branch lookup and reports changes", async () => {
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(createBoard("task-1"));
		prLinkMocks.lookupTaskPullRequests.mockResolvedValue({ recorded: 2, reason: "updated" });
		const { api, broadcast } = createApi();

		const response = await api.refreshTaskPullRequests(scope, { taskId: "task-1" });

		expect(response).toEqual({ ok: true, updated: 2, reason: "updated" });
		expect(prLinkMocks.lookupTaskPullRequests).toHaveBeenCalledWith({
			workspacePath: "/tmp/repo",
			taskId: "task-1",
		});
		expect(broadcast).toHaveBeenCalledWith("workspace-1", "/tmp/repo");
	});

	it("passes the lookup reason through so the explicit Refresh can toast it", async () => {
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(createBoard("task-1"));
		prLinkMocks.lookupTaskPullRequests.mockResolvedValue({ recorded: 0, reason: "none_found" });
		const { api, broadcast } = createApi();

		const response = await api.refreshTaskPullRequests(scope, { taskId: "task-1" });

		expect(response).toEqual({ ok: true, updated: 0, reason: "none_found" });
		expect(broadcast).not.toHaveBeenCalled();
	});

	it("refreshTaskPullRequests rejects unknown tasks", async () => {
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(createBoard("task-2"));
		const { api } = createApi();

		const response = await api.refreshTaskPullRequests(scope, { taskId: "task-1" });

		expect(response).toEqual({ ok: false, updated: 0, error: 'Task "task-1" not found' });
		expect(prLinkMocks.lookupTaskPullRequests).not.toHaveBeenCalled();
	});

	it("saveState fires the branch lookup for tasks newly entering review without PRs", async () => {
		const board = createBoard("task-1");
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(board);
		prLinkMocks.findTasksEnteringReviewWithoutPullRequests.mockReturnValue(["task-1"]);
		prLinkMocks.saveWorkspaceState.mockResolvedValue({
			repoPath: "/tmp/repo",
			statePath: "/tmp/repo/state.json",
			git: { currentBranch: "main", defaultBranch: null, branches: [] },
			board,
			sessions: {},
			revision: 2,
		});
		const broadcast = vi.fn();
		const { api } = createApi(broadcast);

		await api.saveState(scope, { board, sessions: {}, expectedRevision: 1 });

		expect(prLinkMocks.fireReviewPullRequestLookup).toHaveBeenCalledTimes(1);
		const fireInput = prLinkMocks.fireReviewPullRequestLookup.mock.calls[0][0] as {
			workspacePath: string;
			taskId: string;
			onChanged?: () => void;
		};
		expect(fireInput).toMatchObject({ workspacePath: "/tmp/repo", taskId: "task-1" });
		// PRTRACK-1: a recorded lookup must re-broadcast the workspace state
		// so open UIs refresh and demand re-derives (via the server's
		// broadcast wiring).
		expect(typeof fireInput.onChanged).toBe("function");
		fireInput.onChanged?.();
		expect(broadcast).toHaveBeenCalledWith(scope.workspaceId, "/tmp/repo");
	});

	it("saveState does not fire the branch lookup when no task enters review", async () => {
		const board = createBoard("task-1");
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(board);
		prLinkMocks.findTasksEnteringReviewWithoutPullRequests.mockReturnValue([]);
		prLinkMocks.saveWorkspaceState.mockResolvedValue({
			repoPath: "/tmp/repo",
			statePath: "/tmp/repo/state.json",
			git: { currentBranch: "main", defaultBranch: null, branches: [] },
			board,
			sessions: {},
			revision: 2,
		});
		const { api } = createApi();

		await api.saveState(scope, { board, sessions: {}, expectedRevision: 1 });

		expect(prLinkMocks.fireReviewPullRequestLookup).not.toHaveBeenCalled();
	});

	it("setPrimaryTaskPullRequest selects a recorded entry and broadcasts", async () => {
		const first: TestPullRequest = {
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
			number: 9,
			url: "https://github.com/owner/repo/pull/9",
			source: "manual",
			createdAt: 1,
		};
		const second: TestPullRequest = {
			...first,
			number: 10,
			url: "https://github.com/owner/repo/pull/10",
		};
		const boardBefore = createBoard("task-1", [first, second]);
		const boardAfter = createBoard("task-1", [first, { ...second, isPrimary: true }]);
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValueOnce(boardBefore).mockResolvedValueOnce(boardAfter);
		prLinkMocks.setPrimaryTaskPullRequest.mockImplementation((b: unknown, taskId: string) => ({
			board: b,
			taskId,
			updated: true,
		}));
		prLinkMocks.mutateWorkspaceState.mockImplementation(
			async (_cwd: string, mutator: (current: unknown) => unknown) => {
				const result = mutator({ board: boardBefore }) as { board: unknown; value: boolean; save: boolean };
				return { saved: result.save, value: result.value, board: result.board };
			},
		);
		const { api, broadcast } = createApi();

		const response = await api.setPrimaryTaskPullRequest(scope, {
			taskId: "task-1",
			url: "https://github.com/owner/repo/pull/10",
		});

		expect(response.ok).toBe(true);
		if (!response.ok) {
			throw new Error("Expected the display primary selection to succeed");
		}
		expect(response.pullRequest).toMatchObject({ number: 10, isPrimary: true });
		expect(prLinkMocks.setPrimaryTaskPullRequest).toHaveBeenCalledWith(boardBefore, "task-1", expect.any(String));
		expect(broadcast).toHaveBeenCalledWith("workspace-1", "/tmp/repo");
	});

	it("setPrimaryTaskPullRequest clears with a null url and reports a null pullRequest", async () => {
		const primary: TestPullRequest = {
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
			number: 9,
			url: "https://github.com/owner/repo/pull/9",
			source: "manual",
			createdAt: 1,
			isPrimary: true,
		};
		const boardBefore = createBoard("task-1", [primary]);
		prLinkMocks.loadWorkspaceBoardById
			.mockResolvedValueOnce(boardBefore)
			.mockResolvedValueOnce(createBoard("task-1", [{ ...primary, isPrimary: undefined }]));
		prLinkMocks.setPrimaryTaskPullRequest.mockImplementation((b: unknown) => ({ board: b, updated: true }));
		prLinkMocks.mutateWorkspaceState.mockImplementation(
			async (_cwd: string, mutator: (current: unknown) => unknown) => {
				const result = mutator({ board: boardBefore }) as { board: unknown; value: boolean; save: boolean };
				return { saved: result.save, value: result.value, board: result.board };
			},
		);
		const { api, broadcast } = createApi();

		const response = await api.setPrimaryTaskPullRequest(scope, { taskId: "task-1", url: null });

		expect(response).toEqual({ ok: true, pullRequest: null });
		expect(prLinkMocks.setPrimaryTaskPullRequest).toHaveBeenCalledWith(boardBefore, "task-1", null);
		expect(broadcast).toHaveBeenCalledWith("workspace-1", "/tmp/repo");
	});

	it("setPrimaryTaskPullRequest rejects unknown tasks without writing", async () => {
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(createBoard("task-2"));
		const { api } = createApi();

		const response = await api.setPrimaryTaskPullRequest(scope, {
			taskId: "task-1",
			url: "https://github.com/owner/repo/pull/9",
		});

		expect(response).toEqual({ ok: false, error: 'Task "task-1" not found', pullRequest: null });
		expect(prLinkMocks.mutateWorkspaceState).not.toHaveBeenCalled();
	});

	it("setPrimaryTaskPullRequest rejects a PR that is not linked to the task", async () => {
		const board = createBoard("task-1", [
			{
				provider: "github",
				host: "github.com",
				repository: "owner/repo",
				number: 9,
				url: "https://github.com/owner/repo/pull/9",
				source: "manual",
				createdAt: 1,
			},
		]);
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(board);
		const { api } = createApi();

		const response = await api.setPrimaryTaskPullRequest(scope, {
			taskId: "task-1",
			url: "https://github.com/owner/repo/pull/7",
		});

		expect(response).toEqual({
			ok: false,
			error: "That pull request is not linked to this task.",
			pullRequest: null,
		});
		expect(prLinkMocks.mutateWorkspaceState).not.toHaveBeenCalled();
	});

	it("setPrimaryTaskPullRequest succeeds without broadcasting when the entry is already the sole primary", async () => {
		const primary: TestPullRequest = {
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
			number: 9,
			url: "https://github.com/owner/repo/pull/9",
			source: "manual",
			createdAt: 1,
			isPrimary: true,
		};
		const board = createBoard("task-1", [primary]);
		prLinkMocks.loadWorkspaceBoardById.mockResolvedValue(board);
		prLinkMocks.setPrimaryTaskPullRequest.mockImplementation((b: unknown) => ({ board: b, updated: false }));
		prLinkMocks.mutateWorkspaceState.mockImplementation(
			async (_cwd: string, mutator: (current: unknown) => unknown) => {
				const result = mutator({ board }) as { board: unknown; value: boolean; save: boolean };
				return { saved: result.save, value: result.value, board: result.board };
			},
		);
		const { api, broadcast } = createApi();

		const response = await api.setPrimaryTaskPullRequest(scope, {
			taskId: "task-1",
			url: "https://github.com/owner/repo/pull/9",
		});

		expect(response.ok).toBe(true);
		if (!response.ok) {
			throw new Error("Expected the no-op selection to succeed");
		}
		expect(response.pullRequest).toMatchObject({ number: 9, isPrimary: true });
		expect(broadcast).not.toHaveBeenCalled();
	});
});
