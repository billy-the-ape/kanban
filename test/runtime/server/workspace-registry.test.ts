import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import { createWorkspaceRegistry } from "../../../src/server/workspace-registry";

const fixtures = vi.hoisted(() => {
	const entries = [{ workspaceId: "project", repoPath: "/repos/project" }];
	const board = { columns: [{ id: "backlog", title: "Backlog", cards: [{ id: "task" }] }], dependencies: [] };
	const state = { board, sessions: {}, revision: 7 };
	return {
		entries,
		state,
		removeWorkspaceIndexEntry: vi.fn(),
		removeWorkspaceStateFiles: vi.fn(),
		manager: { hydrateFromRecord: vi.fn(), listSummaries: vi.fn(() => []), markInterruptedAndStopAll: vi.fn() },
	};
});

vi.mock("../../../src/config/runtime-config", () => ({
	toGlobalRuntimeConfigState: (config: RuntimeConfigState) => config,
}));
vi.mock("../../../src/state/workspace-state", () => ({
	listWorkspaceIndexEntries: vi.fn(async () => fixtures.entries),
	loadWorkspaceBoardById: vi.fn(async () => fixtures.state.board),
	loadWorkspaceContext: vi.fn(),
	loadWorkspaceState: vi.fn(async () => fixtures.state),
	removeWorkspaceIndexEntry: fixtures.removeWorkspaceIndexEntry,
	removeWorkspaceStateFiles: fixtures.removeWorkspaceStateFiles,
}));
vi.mock("../../../src/terminal/session-manager", () => ({
	TerminalSessionManager: class {
		hydrateFromRecord = fixtures.manager.hydrateFromRecord;
		listSummaries = fixtures.manager.listSummaries;
		markInterruptedAndStopAll = fixtures.manager.markInterruptedAndStopAll;
	},
}));

describe("workspace stream validation", () => {
	beforeEach(() => vi.clearAllMocks());

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
