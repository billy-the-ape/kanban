// PRLINK-8: PR linking derived from a native task chat send.
// Isolated from the real ~/.cline by redirecting HOME (AGENTS.md).
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import { parsePullRequestUrl } from "../../src/core/pull-request-links";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import type { ResolveTaskChatPrLinkingInput } from "../../src/workspace/task-chat-pr-linking";
import { resolveTaskChatPrLinking } from "../../src/workspace/task-chat-pr-linking";
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
	tempHome = { ...createTempDir("kanban-chat-pr-link-home-"), previousHome, previousUserProfile };
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

function createBoard(taskId: string | null): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards:
					taskId === null
						? []
						: [
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

async function setupWorkspace(sandboxRoot: string, name: string, taskId: string | null): Promise<string> {
	const workspacePath = join(sandboxRoot, name);
	mkdirSync(workspacePath, { recursive: true });
	const init = spawnSync("git", ["init"], { cwd: workspacePath, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${workspacePath}`);
	}
	const initial = await loadWorkspaceState(workspacePath);
	await saveWorkspaceState(workspacePath, {
		board: createBoard(taskId),
		sessions: {},
		expectedRevision: initial.revision,
	});
	return workspacePath;
}

async function saveBoardWithoutTask(workspacePath: string, taskId: string | null): Promise<void> {
	const current = await loadWorkspaceState(workspacePath);
	await saveWorkspaceState(workspacePath, {
		board: createBoard(taskId),
		sessions: {},
		expectedRevision: current.revision,
	});
}

function findCardPullRequests(board: RuntimeBoardData, taskId: string) {
	return board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId)?.pullRequests;
}

describe("resolveTaskChatPrLinking", () => {
	const bareUrl = "https://github.com/owner/repo/pull/12";

	it("records a bare-URL send as a manual link and broadcasts", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-chat-pr-link-ws-");
		try {
			const workspacePath = await setupWorkspace(sandboxRoot, "project-a", "task-1");
			const broadcast = vi.fn();

			const result = await resolveTaskChatPrLinking({
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "task-1",
				text: `  ${bareUrl}/files  `,
				hasImages: false,
				broadcast,
			});

			expect(result).toEqual({
				status: "linked",
				links: [
					{
						provider: "github",
						host: "github.com",
						repository: "owner/repo",
						number: 12,
						url: bareUrl,
						alreadyLinked: false,
					},
				],
			});
			expect(broadcast).toHaveBeenCalledTimes(1);
			expect(broadcast).toHaveBeenCalledWith("workspace-1", workspacePath);

			const recorded = await loadWorkspaceState(workspacePath);
			const pullRequests = findCardPullRequests(recorded.board, "task-1");
			expect(pullRequests).toHaveLength(1);
			expect(pullRequests?.[0]).toMatchObject({
				repository: "owner/repo",
				number: 12,
				url: bareUrl,
				source: "manual",
			});
		} finally {
			cleanup();
		}
	});

	it("reports a duplicate auto-link without writing or broadcasting", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-chat-pr-link-ws-");
		try {
			const workspacePath = await setupWorkspace(sandboxRoot, "project-b", "task-1");
			const broadcast = vi.fn();
			const input: ResolveTaskChatPrLinkingInput = {
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "task-1",
				text: bareUrl,
				hasImages: false,
				broadcast,
			};

			const first = await resolveTaskChatPrLinking(input);
			expect(first?.status).toBe("linked");

			const second = await resolveTaskChatPrLinking(input);
			expect(second).toEqual({
				status: "already_linked",
				links: [
					{
						provider: "github",
						host: "github.com",
						repository: "owner/repo",
						number: 12,
						url: bareUrl,
						alreadyLinked: true,
					},
				],
			});
			expect(broadcast).toHaveBeenCalledTimes(1);

			const recorded = await loadWorkspaceState(workspacePath);
			expect(findCardPullRequests(recorded.board, "task-1")).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	it("keeps the send ok and reports failed when the card was deleted in the race", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-chat-pr-link-ws-");
		try {
			const workspacePath = await setupWorkspace(sandboxRoot, "project-c", "task-1");
			const broadcast = vi.fn();
			await saveBoardWithoutTask(workspacePath, null);

			const result = await resolveTaskChatPrLinking({
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "task-1",
				text: bareUrl,
				hasImages: false,
				broadcast,
			});

			expect(result).toEqual({
				status: "failed",
				links: [
					{
						provider: "github",
						host: "github.com",
						repository: "owner/repo",
						number: 12,
						url: bareUrl,
						alreadyLinked: false,
					},
				],
				error: "Task no longer exists.",
			});
			expect(broadcast).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("offers prose suggestions with authoritative alreadyLinked flags and no write", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-chat-pr-link-ws-");
		try {
			const workspacePath = await setupWorkspace(sandboxRoot, "project-d", "task-1");
			const alreadyLinked = parsePullRequestUrl("https://github.com/owner/repo/pull/12");
			const fresh = parsePullRequestUrl("https://github.com/owner/repo/pull/13");
			if (!alreadyLinked || !fresh) {
				throw new Error("Expected both URLs to parse");
			}
			const recorded = await recordTaskPullRequests({
				workspacePath,
				taskId: "task-1",
				links: [alreadyLinked],
				source: "manual",
			});
			expect(recorded.recorded).toBe(true);

			const broadcast = vi.fn();
			const result = await resolveTaskChatPrLinking({
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "task-1",
				text: `See ${alreadyLinked.url} and ${fresh.url} for context.`,
				hasImages: false,
				broadcast,
			});

			expect(result).toEqual({
				status: "suggestions",
				links: [
					{ ...alreadyLinked, alreadyLinked: true },
					{ ...fresh, alreadyLinked: false },
				],
			});
			// Suggestions are read-only: no board write, no broadcast.
			expect(broadcast).not.toHaveBeenCalled();
			const board = await loadWorkspaceState(workspacePath);
			expect(findCardPullRequests(board.board, "task-1")).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	it("treats a bare URL with attached images as a suggestion only", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-chat-pr-link-ws-");
		try {
			const workspacePath = await setupWorkspace(sandboxRoot, "project-e", "task-1");
			const broadcast = vi.fn();

			const result = await resolveTaskChatPrLinking({
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "task-1",
				text: bareUrl,
				hasImages: true,
				broadcast,
			});

			expect(result).toMatchObject({ status: "suggestions" });
			expect(broadcast).not.toHaveBeenCalled();
			const board = await loadWorkspaceState(workspacePath);
			expect(findCardPullRequests(board.board, "task-1")).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("returns undefined for messages with no candidates", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-chat-pr-link-ws-");
		try {
			const workspacePath = await setupWorkspace(sandboxRoot, "project-f", "task-1");

			expect(
				await resolveTaskChatPrLinking({
					workspaceId: "workspace-1",
					workspacePath,
					taskId: "task-1",
					text: "Just a normal update.",
					hasImages: false,
					broadcast: vi.fn(),
				}),
			).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});
