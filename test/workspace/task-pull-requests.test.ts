// PRLINK-1: single server-side write path for task card pull-request links.
// Isolated from the real ~/.cline by redirecting HOME (AGENTS.md).
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import { type ParsedPullRequestLink, parsePullRequestUrl } from "../../src/core/pull-request-links";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { recordTaskPullRequests } from "../../src/workspace/task-pull-requests";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

interface TempDirWithEnv extends ReturnType<typeof createTempDir> {
	previousHome?: string;
	previousUserProfile?: string;
}

let tempHome: TempDirWithEnv | null = null;

beforeEach(() => {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	tempHome = { ...createTempDir("kanban-task-pr-home-"), previousHome, previousUserProfile };
	process.env.HOME = tempHome.path;
	process.env.USERPROFILE = tempHome.path;
});

afterEach(() => {
	if (!tempHome) {
		return;
	}
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
});

function createBoard(taskId: string): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: taskId,
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
}

function initWorkspace(workspacePath: string): void {
	mkdirSync(workspacePath, { recursive: true });
	const init = spawnSync("git", ["init"], {
		cwd: workspacePath,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${workspacePath}`);
	}
}

function findCardPullRequests(board: RuntimeBoardData, taskId: string) {
	return board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId)?.pullRequests;
}

function parseLink(url: string): ParsedPullRequestLink {
	const link = parsePullRequestUrl(url);
	if (!link) {
		throw new Error(`Expected ${url} to parse as a pull request link`);
	}
	return link;
}

describe("recordTaskPullRequests", () => {
	it("records a detected link onto the card and bumps the revision once", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-ws-");
		try {
			const workspacePath = join(sandboxRoot, "project-a");
			initWorkspace(workspacePath);
			const link = parseLink("https://github.com/owner/repo/pull/12/files");

			const initial = await loadWorkspaceState(workspacePath);
			await saveWorkspaceState(workspacePath, {
				board: createBoard("task-1"),
				sessions: {},
				expectedRevision: initial.revision,
			});

			const result = await recordTaskPullRequests({
				workspacePath,
				taskId: "task-1",
				links: [link],
				source: "agent_tool",
			});
			expect(result).toEqual({ recorded: true, changed: true });

			const recorded = await loadWorkspaceState(workspacePath);
			// +1 for the initial saveWorkspaceState, +1 for the record.
			expect(recorded.revision).toBe(initial.revision + 2);
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
			expect(typeof pullRequests?.[0]?.createdAt).toBe("number");
		} finally {
			cleanup();
		}
	});

	it("does not duplicate, bump the revision, or rewrite on a repeated detection", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-ws-");
		try {
			const workspacePath = join(sandboxRoot, "project-b");
			initWorkspace(workspacePath);
			const link = parseLink("https://github.com/owner/repo/pull/12");

			const initial = await loadWorkspaceState(workspacePath);
			await saveWorkspaceState(workspacePath, {
				board: createBoard("task-1"),
				sessions: {},
				expectedRevision: initial.revision,
			});

			const first = await recordTaskPullRequests({
				workspacePath,
				taskId: "task-1",
				links: [link],
				source: "agent_tool",
			});
			expect(first).toEqual({ recorded: true, changed: true });

			const second = await recordTaskPullRequests({
				workspacePath,
				taskId: "task-1",
				links: [link],
				source: "agent_tool",
			});
			expect(second).toEqual({ recorded: false, changed: false });

			const recorded = await loadWorkspaceState(workspacePath);
			// The repeated no-op must not bump the revision again.
			expect(recorded.revision).toBe(initial.revision + 2);
			expect(findCardPullRequests(recorded.board, "task-1")).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	it("returns a no-op result for unknown tasks and unknown workspaces without throwing", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-ws-");
		try {
			const workspacePath = join(sandboxRoot, "project-c");
			initWorkspace(workspacePath);
			const link = parseLink("https://github.com/owner/repo/pull/12");

			const initial = await loadWorkspaceState(workspacePath);
			await saveWorkspaceState(workspacePath, {
				board: createBoard("task-1"),
				sessions: {},
				expectedRevision: initial.revision,
			});

			const unknownTask = await recordTaskPullRequests({
				workspacePath,
				taskId: "missing-task",
				links: [link],
				source: "agent_tool",
			});
			expect(unknownTask).toEqual({ recorded: false, changed: false });

			// A directory with no git repository is an unknown workspace context.
			const unknownWorkspace = await recordTaskPullRequests({
				workspacePath: join(sandboxRoot, "not-a-repo"),
				taskId: "task-1",
				links: [link],
				source: "agent_tool",
			});
			expect(unknownWorkspace).toEqual({ recorded: false, changed: false });

			const recorded = await loadWorkspaceState(workspacePath);
			expect(recorded.revision).toBe(initial.revision + 1);
			expect(findCardPullRequests(recorded.board, "task-1")).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("keeps multiple links in first-appearance order", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-ws-");
		try {
			const workspacePath = join(sandboxRoot, "project-d");
			initWorkspace(workspacePath);
			const first = parseLink("https://github.com/owner/repo/pull/12");
			const second = parseLink("https://gitlab.com/group/subgroup/repo/-/merge_requests/7");
			const duplicate = parseLink("https://github.com/owner/repo/pull/12/files");

			const initial = await loadWorkspaceState(workspacePath);
			await saveWorkspaceState(workspacePath, {
				board: createBoard("task-1"),
				sessions: {},
				expectedRevision: initial.revision,
			});

			const result = await recordTaskPullRequests({
				workspacePath,
				taskId: "task-1",
				links: [first, second, duplicate],
				source: "agent_tool",
			});
			expect(result).toEqual({ recorded: true, changed: true });

			const recorded = await loadWorkspaceState(workspacePath);
			expect(findCardPullRequests(recorded.board, "task-1")?.map((pullRequest) => pullRequest.url)).toEqual([
				"https://github.com/owner/repo/pull/12",
				"https://gitlab.com/group/subgroup/repo/-/merge_requests/7",
			]);
		} finally {
			cleanup();
		}
	});

	it("does nothing when given no links", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-ws-");
		try {
			const workspacePath = join(sandboxRoot, "project-e");
			initWorkspace(workspacePath);
			const initial = await loadWorkspaceState(workspacePath);
			await saveWorkspaceState(workspacePath, {
				board: createBoard("task-1"),
				sessions: {},
				expectedRevision: initial.revision,
			});

			const result = await recordTaskPullRequests({
				workspacePath,
				taskId: "task-1",
				links: [],
				source: "agent_tool",
			});
			expect(result).toEqual({ recorded: false, changed: false });
			expect((await loadWorkspaceState(workspacePath)).revision).toBe(initial.revision + 1);
		} finally {
			cleanup();
		}
	});
});
