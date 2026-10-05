import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { loadWorkspaceState, saveWorkspaceState } from "../../../src/state/workspace-state";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createHooksApi } from "../../../src/trpc/hooks-api";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

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
		...overrides,
	};
}

describe("createHooksApi", () => {
	it("treats ineligible hook transitions as successful no-ops", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
	});

	it("stores activity metadata without changing session state", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: {
				source: "claude",
				activityText: "Using Read",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(manager.applyHookActivity).toHaveBeenCalledWith("task-1", {
			source: "claude",
			activityText: "Using Read",
		});
	});

	it("captures a turn checkpoint when transitioning to review", async () => {
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			latestTurnCheckpoint: {
				turn: 2,
				ref: "refs/kanban/checkpoints/task-1/turn/2",
				commit: "2222222",
				createdAt: 1,
			},
			previousTurnCheckpoint: {
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			},
		});

		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const captureTaskTurnCheckpoint = vi.fn(async () => ({
			turn: 3,
			ref: "refs/kanban/checkpoints/task-1/turn/3",
			commit: "3333333",
			createdAt: Date.now(),
		}));
		const deleteTaskTurnCheckpointRef = vi.fn(async () => undefined);

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			captureTaskTurnCheckpoint,
			deleteTaskTurnCheckpointRef,
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
		});

		expect(response).toEqual({ ok: true });
		expect(captureTaskTurnCheckpoint).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			taskId: "task-1",
			turn: 3,
		});
		expect(manager.applyTurnCheckpoint).toHaveBeenCalledTimes(1);
		expect(deleteTaskTurnCheckpointRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			ref: "refs/kanban/checkpoints/task-1/turn/1",
		});
	});
});

// PRLINK-2: hook-detected PR URLs are recorded onto the card server-side.
// These tests touch real workspace state, so HOME/USERPROFILE are redirected
// to a temp dir (AGENTS.md).
describe("createHooksApi pull-request recording", () => {
	let tempHome: { path: string; cleanup: () => void; previousHome?: string; previousUserProfile?: string } | null =
		null;
	let sandboxRoot: ReturnType<typeof createTempDir> | null = null;
	let workspacePath: string;

	beforeEach(async () => {
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		tempHome = { ...createTempDir("kanban-hooks-pr-home-"), previousHome, previousUserProfile };
		process.env.HOME = tempHome.path;
		process.env.USERPROFILE = tempHome.path;
		sandboxRoot = createTempDir("kanban-hooks-pr-ws-");
		workspacePath = join(sandboxRoot.path, "project-a");
		mkdirSync(workspacePath, { recursive: true });
		const init = spawnSync("git", ["init"], {
			cwd: workspacePath,
			stdio: "ignore",
			env: createGitTestEnv(),
		});
		if (init.status !== 0) {
			throw new Error(`Failed to initialize git repository at ${workspacePath}`);
		}
		const board: RuntimeBoardData = {
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "task-1",
							title: "Task",
							prompt: "Task prompt",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: Date.now(),
							updatedAt: Date.now(),
						},
					],
				},
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};
		const initial = await loadWorkspaceState(workspacePath);
		await saveWorkspaceState(workspacePath, { board, sessions: {}, expectedRevision: initial.revision });
	});

	afterEach(() => {
		if (tempHome) {
			if (tempHome.previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = tempHome.previousHome;
			}
			if (tempHome.previousUserProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = tempHome.previousUserProfile;
			}
			tempHome.cleanup();
			tempHome = null;
		}
		sandboxRoot?.cleanup();
		sandboxRoot = null;
	});

	function findCardPullRequests(board: RuntimeBoardData, taskId: string) {
		return board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId)?.pullRequests;
	}

	function createApi(broadcast: (workspaceId: string, workspacePath: string) => void | Promise<void>) {
		const manager: TerminalSessionManager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
		} as unknown as TerminalSessionManager;
		return {
			manager,
			api: createHooksApi({
				getWorkspacePathById: vi.fn(() => workspacePath),
				ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
				broadcastRuntimeWorkspaceStateUpdated: broadcast,
				broadcastTaskReadyForReview: vi.fn(),
			}),
		};
	}

	it("records PR URLs onto the card with source agent_tool and broadcasts on change", async () => {
		const broadcast = vi.fn();
		const { manager, api } = createApi(broadcast);

		// A running task receiving to_in_progress does not transition, so any
		// broadcast here must come from the PR recording itself.
		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			pullRequestUrls: ["https://github.com/owner/repo/pull/12/files"],
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(broadcast).toHaveBeenCalledWith("workspace-1", workspacePath);

		const recorded = await loadWorkspaceState(workspacePath);
		const pullRequests = findCardPullRequests(recorded.board, "task-1");
		expect(pullRequests).toHaveLength(1);
		expect(pullRequests?.[0]).toMatchObject({
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
			number: 12,
			url: "https://github.com/owner/repo/pull/12",
			source: "agent_tool",
		});
	});

	it("drops unparseable URLs without recording and still succeeds", async () => {
		const { api } = createApi(vi.fn());

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			pullRequestUrls: [
				"not a url",
				"https://github.com/owner/repo/issues/3",
				"https://github.com/owner/repo/pull/new/branch",
			],
		});

		expect(response).toEqual({ ok: true });
		const recorded = await loadWorkspaceState(workspacePath);
		expect(findCardPullRequests(recorded.board, "task-1")).toBeUndefined();
	});

	it("records PRs on non-transition events (asserts the board file, not the transition)", async () => {
		const broadcast = vi.fn();
		const { manager, api } = createApi(broadcast);

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			pullRequestUrls: ["https://gitlab.com/group/repo/-/merge_requests/4"],
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();

		const recorded = await loadWorkspaceState(workspacePath);
		const pullRequests = findCardPullRequests(recorded.board, "task-1");
		expect(pullRequests?.map((pullRequest) => pullRequest.url)).toEqual([
			"https://gitlab.com/group/repo/-/merge_requests/4",
		]);
		expect(pullRequests?.[0]?.source).toBe("agent_tool");
	});

	it("does not bump the revision for duplicate URLs already recorded", async () => {
		const { api: firstApi } = createApi(vi.fn());

		const first = await firstApi.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			pullRequestUrls: ["https://github.com/owner/repo/pull/7"],
		});
		expect(first).toEqual({ ok: true });
		const revisionAfterFirst = (await loadWorkspaceState(workspacePath)).revision;

		const broadcast = vi.fn();
		const { api: secondApi } = createApi(broadcast);
		const second = await secondApi.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			pullRequestUrls: ["https://github.com/owner/repo/pull/7#discussion_r1"],
		});

		expect(second).toEqual({ ok: true });
		expect(broadcast).not.toHaveBeenCalled();
		const recorded = await loadWorkspaceState(workspacePath);
		expect(recorded.revision).toBe(revisionAfterFirst);
		expect(findCardPullRequests(recorded.board, "task-1")).toHaveLength(1);
	});
});
