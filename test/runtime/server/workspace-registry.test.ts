import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type {
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";
import { createWorkspaceRegistry } from "../../../src/server/workspace-registry";
import * as workspaceStateModule from "../../../src/state/workspace-state";

const fixtures = vi.hoisted(() => {
	const entries = [{ workspaceId: "project", repoPath: "/repos/project" }];
	const board = { columns: [{ id: "backlog", title: "Backlog", cards: [{ id: "task" }] }], dependencies: [] };
	const state = { board, sessions: {}, revision: 7 };
	return {
		entries,
		state,
		removeWorkspaceIndexEntry: vi.fn(),
		removeWorkspaceStateFiles: vi.fn(),
		manager: {
			hydrateFromRecord: vi.fn(),
			listSummaries: vi.fn<() => RuntimeTaskSessionSummary[]>(() => []),
			hasActiveProcess: vi.fn(() => false),
			markInterruptedAndStopAll: vi.fn(),
		},
	};
});

vi.mock("../../../src/config/runtime-config", () => ({
	toGlobalRuntimeConfigState: (config: RuntimeConfigState) => config,
}));
vi.mock("../../../src/state/workspace-state", () => ({
	listWorkspaceIndexEntries: vi.fn(async () => fixtures.entries),
	loadWorkspaceBoardById: vi.fn(async () => fixtures.state.board),
	loadWorkspaceContext: vi.fn(),
	loadWorkspaceSessionsById: vi.fn(async () => ({})),
	loadWorkspaceState: vi.fn(async () => fixtures.state),
	removeWorkspaceIndexEntry: fixtures.removeWorkspaceIndexEntry,
	removeWorkspaceStateFiles: fixtures.removeWorkspaceStateFiles,
}));
vi.mock("../../../src/terminal/session-manager", () => ({
	TerminalSessionManager: class {
		hydrateFromRecord = fixtures.manager.hydrateFromRecord;
		listSummaries = fixtures.manager.listSummaries;
		hasActiveProcess = fixtures.manager.hasActiveProcess;
		markInterruptedAndStopAll = fixtures.manager.markInterruptedAndStopAll;
	},
}));

describe("workspace stream validation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fixtures.manager.listSummaries.mockReturnValue([]);
	});

	it("includes the resumed Cline owner in reload and websocket snapshots", async () => {
		const old: RuntimeTaskSessionSummary = {
			taskId: "7wp6m",
			state: "running",
			agentId: "cline",
			workspacePath: "/worktrees/7wp6m",
			pid: null,
			startedAt: 100,
			updatedAt: 110,
			lastOutputAt: 110,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		};
		fixtures.manager.listSummaries.mockReturnValue([old]);
		const config = {} as RuntimeConfigState;
		let clineSummaries: RuntimeTaskSessionSummary[] = [];
		const registry = await createWorkspaceRegistry({
			cwd: "/launcher",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: () => false,
			pathIsDirectory: async () => true,
			getClineTaskSessionSummaries: () => clineSummaries,
		});
		const first = await registry.buildWorkspaceStateSnapshot("project", "/repos/project");
		expect(first.sessions[old.taskId]?.state).toBe("interrupted");
		const completed = { ...old, startedAt: 200, updatedAt: 210, state: "awaiting_review" as const };
		clineSummaries = [completed];
		expect((await registry.buildWorkspaceStateSnapshot("project", "/repos/project")).sessions[old.taskId]).toEqual(
			completed,
		);
	});

	it.each(["missing directory", "invalid Git configuration"])(
		"retains project data after %s and recovers on retry",
		async (failure) => {
			const config = {} as RuntimeConfigState;
			const hasGitRepository = vi.fn((path: string) => path !== "/launcher");
			const pathIsDirectory = vi.fn(async () => true);
			const registry = await createWorkspaceRegistry({
				cwd: "/launcher",
				loadGlobalRuntimeConfig: async () => config,
				loadRuntimeConfig: async () => config,
				hasGitRepository,
				pathIsDirectory,
			});
			const manager = await registry.ensureTerminalManagerForWorkspace("project", "/repos/project");

			if (failure === "missing directory") {
				pathIsDirectory.mockResolvedValue(false);
			} else {
				hasGitRepository.mockReturnValue(false);
			}

			const result = await registry.resolveWorkspaceForStream("project");
			expect(result.workspaceId).toBeNull();
			expect(result.unavailableRequestedWorkspaceMessage).toContain("Project and task data retained");
			expect(result.unavailableRequestedWorkspaceMessage).toContain("Repair the repository and retry");
			expect(fixtures.removeWorkspaceIndexEntry).not.toHaveBeenCalled();
			expect(fixtures.removeWorkspaceStateFiles).not.toHaveBeenCalled();
			expect(fixtures.manager.markInterruptedAndStopAll).not.toHaveBeenCalled();
			expect(registry.getTerminalManagerForWorkspace("project")).toBe(manager);
			expect(registry.getWorkspacePathById("project")).toBe("/repos/project");
			expect((await registry.buildProjectsPayload("project")).projects).toEqual([
				expect.objectContaining({ id: "project", taskCounts: expect.objectContaining({ backlog: 1 }) }),
			]);

			pathIsDirectory.mockResolvedValue(true);
			hasGitRepository.mockReturnValue(true);
			expect(await registry.resolveWorkspaceForStream("project")).toEqual({
				workspaceId: "project",
				workspacePath: "/repos/project",
				unavailableRequestedWorkspaceMessage: null,
			});
			expect((await registry.buildWorkspaceStateSnapshot("project", "/repos/project")).board).toBe(
				fixtures.state.board,
			);
			expect(registry.getTerminalManagerForWorkspace("project")).toBe(manager);
		},
	);

	it("does not delete an unavailable project when another project opens a stream", async () => {
		const config = {} as RuntimeConfigState;
		const registry = await createWorkspaceRegistry({
			cwd: "/launcher",
			loadGlobalRuntimeConfig: async () => config,
			loadRuntimeConfig: async () => config,
			hasGitRepository: () => false,
			pathIsDirectory: async () => true,
		});
		await registry.resolveWorkspaceForStream(null);
		expect(fixtures.removeWorkspaceIndexEntry).not.toHaveBeenCalled();
		expect(fixtures.removeWorkspaceStateFiles).not.toHaveBeenCalled();
		expect((await registry.buildProjectsPayload(null)).projects).toHaveLength(1);
	});
});
describe("project task counts from effective sessions", () => {
	const inProgressBoard: RuntimeBoardData = {
		columns: [
			{
				id: "in_progress",
				title: "In Progress",
				cards: [
					{
						id: "task",
						title: "task",
						prompt: "",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 100,
						updatedAt: 100,
					},
				],
			},
		],
		dependencies: [],
	};
	const workspaceStateResponse: RuntimeWorkspaceStateResponse = {
		repoPath: "/repos/project",
		statePath: "/repos/project/.kanban/state.json",
		git: { currentBranch: "main", defaultBranch: null, branches: [] },
		board: inProgressBoard,
		sessions: {},
		revision: 7,
	};
	let clineSummaries: RuntimeTaskSessionSummary[];

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

	async function createRegistry(): Promise<ReturnType<typeof createWorkspaceRegistry>> {
		return createWorkspaceRegistry({
			cwd: "/launcher",
			loadGlobalRuntimeConfig: async () => ({}) as RuntimeConfigState,
			loadRuntimeConfig: async () => ({}) as RuntimeConfigState,
			hasGitRepository: () => false,
			pathIsDirectory: async () => true,
			getClineTaskSessionSummaries: () => clineSummaries,
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		fixtures.manager.listSummaries.mockReturnValue([]);
		fixtures.manager.hasActiveProcess.mockReturnValue(false);
		fixtures.state.sessions = {};
		clineSummaries = [];
		vi.mocked(workspaceStateModule.loadWorkspaceBoardById).mockResolvedValue(inProgressBoard);
		vi.mocked(workspaceStateModule.loadWorkspaceSessionsById).mockResolvedValue({});
		workspaceStateResponse.sessions = {};
		vi.mocked(workspaceStateModule.loadWorkspaceState).mockResolvedValue(workspaceStateResponse);
	});

	it("classifies an in-progress task from the live Cline summary over the frozen terminal copy", async () => {
		fixtures.manager.listSummaries.mockReturnValue([createSummary({ state: "awaiting_review", updatedAt: 100 })]);
		clineSummaries = [createSummary({ state: "running", updatedAt: 200 })];
		const registry = await createRegistry();
		await registry.ensureTerminalManagerForWorkspace("project", "/repos/project");

		const counts = await registry.summarizeProjectTaskCounts("project", "/repos/project");
		expect(counts).toEqual({ backlog: 0, in_progress: 1, paused: 0, review: 0, done: 0, trash: 0 });
	});

	it("counts an idle live Cline summary as paused", async () => {
		fixtures.manager.listSummaries.mockReturnValue([createSummary({ state: "awaiting_review", updatedAt: 100 })]);
		clineSummaries = [createSummary({ state: "idle", updatedAt: 200 })];
		const registry = await createRegistry();
		await registry.ensureTerminalManagerForWorkspace("project", "/repos/project");

		const counts = await registry.summarizeProjectTaskCounts("project", "/repos/project");
		expect(counts).toEqual({ backlog: 0, in_progress: 0, paused: 1, review: 0, done: 0, trash: 0 });
	});

	it("counts a queued running task as paused and a replaced queue hook as in progress", async () => {
		const waitingHook = {
			canReturnToBacklog: false,
			activityText: "Waiting for a slot",
			toolName: null,
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: "concurrency_waiting",
			notificationType: null,
			source: null,
		};
		const workingHook = { ...waitingHook, activityText: "Working", hookEventName: "post_tool_use" };
		clineSummaries = [
			createSummary({
				state: "running",
				updatedAt: 200,
				latestHookActivity: waitingHook,
			}),
		];
		const registry = await createRegistry();
		await registry.ensureTerminalManagerForWorkspace("project", "/repos/project");

		expect(await registry.summarizeProjectTaskCounts("project", "/repos/project")).toMatchObject({
			in_progress: 0,
			paused: 1,
		});
		expect(
			(await registry.buildWorkspaceStateSnapshot("project", "/repos/project")).sessions.task?.latestHookActivity
				?.hookEventName,
		).toBe("concurrency_waiting");

		clineSummaries = [
			createSummary({
				state: "running",
				updatedAt: 300,
				latestHookActivity: workingHook,
			}),
		];
		// Fresh registry: counts are cached per registry on success.
		const secondRegistry = await createRegistry();
		await secondRegistry.ensureTerminalManagerForWorkspace("project", "/repos/project");
		expect(await secondRegistry.summarizeProjectTaskCounts("project", "/repos/project")).toMatchObject({
			in_progress: 1,
			paused: 0,
		});
		expect(
			(await secondRegistry.buildWorkspaceStateSnapshot("project", "/repos/project")).sessions.task
				?.latestHookActivity?.hookEventName,
		).toBe("post_tool_use");
	});

	it("classifies a terminal-agent task from the newer terminal summary", async () => {
		vi.mocked(workspaceStateModule.loadWorkspaceSessionsById).mockResolvedValue({
			task: createSummary({ agentId: "codex", state: "awaiting_review", updatedAt: 100 }),
		});
		fixtures.manager.listSummaries.mockReturnValue([
			createSummary({ agentId: "codex", state: "running", updatedAt: 200 }),
		]);
		fixtures.manager.hasActiveProcess.mockReturnValue(true);
		const registry = await createRegistry();
		await registry.ensureTerminalManagerForWorkspace("project", "/repos/project");

		const counts = await registry.summarizeProjectTaskCounts("project", "/repos/project");
		expect(counts).toEqual({ backlog: 0, in_progress: 1, paused: 0, review: 0, done: 0, trash: 0 });
	});

	it("keeps an in-progress display for a just-attached terminal placeholder over an older persisted summary", async () => {
		vi.mocked(workspaceStateModule.loadWorkspaceSessionsById).mockResolvedValue({
			task: createSummary({ state: "running", startedAt: 100, updatedAt: 100 }),
		});
		fixtures.manager.listSummaries.mockReturnValue([
			createSummary({ state: "idle", agentId: null, workspacePath: null, startedAt: null, updatedAt: 500 }),
		]);
		// A live terminal process owns the task, so the fresh placeholder wins
		// the merge and the placeholder rule keeps the in-progress display.
		fixtures.manager.hasActiveProcess.mockReturnValue(true);
		const registry = await createRegistry();
		await registry.ensureTerminalManagerForWorkspace("project", "/repos/project");

		const counts = await registry.summarizeProjectTaskCounts("project", "/repos/project");
		expect(counts).toEqual({ backlog: 0, in_progress: 1, paused: 0, review: 0, done: 0, trash: 0 });

		// Without a live process the placeholder loses to the real summary,
		// and the orphaned running entry reconciles to interrupted (paused).
		fixtures.manager.hasActiveProcess.mockReturnValue(false);
		const secondRegistry = await createRegistry();
		await secondRegistry.ensureTerminalManagerForWorkspace("project", "/repos/project");
		expect(await secondRegistry.summarizeProjectTaskCounts("project", "/repos/project")).toMatchObject({
			in_progress: 0,
			paused: 1,
		});
	});

	it("keeps a newer persisted summary over an older terminal one, and a newer live Cline summary wins everywhere", async () => {
		workspaceStateResponse.sessions = { task: createSummary({ state: "awaiting_review", updatedAt: 200 }) };
		vi.mocked(workspaceStateModule.loadWorkspaceSessionsById).mockResolvedValue({
			task: createSummary({ state: "awaiting_review", updatedAt: 200 }),
		});
		fixtures.manager.listSummaries.mockReturnValue([createSummary({ state: "running", updatedAt: 100 })]);
		const registry = await createRegistry();
		await registry.ensureTerminalManagerForWorkspace("project", "/repos/project");

		expect((await registry.buildWorkspaceStateSnapshot("project", "/repos/project")).sessions.task?.state).toBe(
			"awaiting_review",
		);
		expect(await registry.summarizeProjectTaskCounts("project", "/repos/project")).toMatchObject({
			in_progress: 0,
			review: 1,
		});

		clineSummaries = [createSummary({ state: "running", updatedAt: 300 })];
		expect((await registry.buildWorkspaceStateSnapshot("project", "/repos/project")).sessions.task?.state).toBe(
			"running",
		);
		// Fresh registry: counts are cached per registry on success.
		const secondRegistry = await createRegistry();
		await secondRegistry.ensureTerminalManagerForWorkspace("project", "/repos/project");
		expect(await secondRegistry.summarizeProjectTaskCounts("project", "/repos/project")).toMatchObject({
			in_progress: 1,
			review: 0,
		});
	});

	it("counts an untracked project from persisted sessions without creating a manager", async () => {
		vi.mocked(workspaceStateModule.loadWorkspaceSessionsById).mockResolvedValue({
			task: createSummary({ state: "idle", updatedAt: 100 }),
		});
		const registry = await createRegistry();

		const counts = await registry.summarizeProjectTaskCounts("project", "/repos/project");
		expect(counts).toEqual({ backlog: 0, in_progress: 0, paused: 1, review: 0, done: 0, trash: 0 });
		expect(fixtures.manager.hydrateFromRecord).not.toHaveBeenCalled();
		expect(registry.getTerminalManagerForWorkspace("project")).toBeNull();
	});
});
describe("buildProjectTasksPayload", () => {
	function createBoardFor(projectId: string, updatedAt: number): RuntimeBoardData {
		return {
			columns: [
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "task",
							title: `${projectId} task`,
							prompt: "",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 100,
							updatedAt,
						},
					],
				},
			],
			dependencies: [],
		};
	}

	async function createRegistry(): Promise<ReturnType<typeof createWorkspaceRegistry>> {
		return createWorkspaceRegistry({
			cwd: "/launcher",
			loadGlobalRuntimeConfig: async () => ({}) as RuntimeConfigState,
			loadRuntimeConfig: async () => ({}) as RuntimeConfigState,
			hasGitRepository: () => false,
			pathIsDirectory: async () => true,
			getClineTaskSessionSummaries: () => [],
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(workspaceStateModule.listWorkspaceIndexEntries).mockResolvedValue([]);
		vi.mocked(workspaceStateModule.loadWorkspaceBoardById).mockResolvedValue(createBoardFor("project", 100));
		vi.mocked(workspaceStateModule.loadWorkspaceSessionsById).mockResolvedValue({});
	});

	it("merges sorted items over multiple projects without creating terminal managers", async () => {
		vi.mocked(workspaceStateModule.listWorkspaceIndexEntries).mockResolvedValue([
			{ workspaceId: "a", repoPath: "/repos/a" },
			{ workspaceId: "b", repoPath: "/repos/b" },
		]);
		vi.mocked(workspaceStateModule.loadWorkspaceBoardById).mockImplementation(async (workspaceId) =>
			createBoardFor(workspaceId, workspaceId === "a" ? 150 : 100),
		);
		const registry = await createRegistry();

		const payload = await registry.buildProjectTasksPayload();
		expect(payload.tasks.map((task) => task.projectId)).toEqual(["a", "b"]);
		expect(payload.tasks[0]?.title).toBe("a task");
		expect(payload.unavailableProjectIds).toEqual([]);
		expect(fixtures.manager.hydrateFromRecord).not.toHaveBeenCalled();
		expect(registry.getTerminalManagerForWorkspace("a")).toBeNull();
	});

	it("returns empty arrays for an empty index", async () => {
		const registry = await createRegistry();
		expect(await registry.buildProjectTasksPayload()).toEqual({ tasks: [], unavailableProjectIds: [] });
	});

	it("includes only the failed project id on partial failure", async () => {
		vi.mocked(workspaceStateModule.listWorkspaceIndexEntries).mockResolvedValue([
			{ workspaceId: "a", repoPath: "/repos/a" },
			{ workspaceId: "broken", repoPath: "/repos/broken" },
			{ workspaceId: "b", repoPath: "/repos/b" },
		]);
		vi.mocked(workspaceStateModule.loadWorkspaceBoardById).mockImplementation(async (workspaceId) => {
			if (workspaceId === "broken") {
				throw new Error("missing state");
			}
			return createBoardFor(workspaceId, 100);
		});
		const registry = await createRegistry();

		const payload = await registry.buildProjectTasksPayload();
		expect(payload.tasks.map((task) => task.projectId).sort()).toEqual(["a", "b"]);
		expect(payload.unavailableProjectIds).toEqual(["broken"]);
	});

	it("fails the query when the index read fails", async () => {
		const registry = await createRegistry();
		vi.mocked(workspaceStateModule.listWorkspaceIndexEntries).mockRejectedValue(new Error("index down"));
		await expect(registry.buildProjectTasksPayload()).rejects.toThrow("index down");
	});

	it("loads at most four project snapshots concurrently", async () => {
		const projectIds = Array.from({ length: 8 }, (_, index) => `p${index}`);
		vi.mocked(workspaceStateModule.listWorkspaceIndexEntries).mockResolvedValue(
			projectIds.map((workspaceId) => ({ workspaceId, repoPath: `/repos/${workspaceId}` })),
		);
		let inFlight = 0;
		let maxInFlight = 0;
		vi.mocked(workspaceStateModule.loadWorkspaceBoardById).mockImplementation(async (workspaceId) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight -= 1;
			return createBoardFor(workspaceId, 100);
		});
		const registry = await createRegistry();

		const payload = await registry.buildProjectTasksPayload();
		expect(payload.tasks).toHaveLength(8);
		expect(maxInFlight).toBeGreaterThan(1);
		expect(maxInFlight).toBeLessThanOrEqual(4);
	});
});
