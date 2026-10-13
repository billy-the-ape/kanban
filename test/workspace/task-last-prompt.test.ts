// LASTPROMPT: single server-side write path for the card's latest user
// authored chat prompt. Isolated from the real ~/.cline by redirecting HOME
// (AGENTS.md).
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { clearTaskLastPrompt, recordTaskLastPrompt } from "../../src/workspace/task-last-prompt";
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
	tempHome = { ...createTempDir("kanban-last-prompt-home-"), previousHome, previousUserProfile };
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

function findCard(board: RuntimeBoardData, taskId: string) {
	return board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId);
}

async function seedWorkspace(workspacePath: string): Promise<number> {
	const initial = await loadWorkspaceState(workspacePath);
	await saveWorkspaceState(workspacePath, {
		board: createBoard("task-1"),
		sessions: {},
		expectedRevision: initial.revision,
	});
	return initial.revision;
}

describe("recordTaskLastPrompt", () => {
	it("records the latest user prompt, preserves internal newlines, and broadcasts", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-last-prompt-ws-");
		try {
			const workspacePath = join(sandboxRoot, "project-a");
			initWorkspace(workspacePath);
			const baseRevision = await seedWorkspace(workspacePath);
			const broadcast = vi.fn();

			const result = await recordTaskLastPrompt({
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "task-1",
				text: "  Fix the flaky test \n\nsecond line  ",
				acceptedAt: 123456789,
				broadcast,
			});
			expect(result).toBe("recorded");
			expect(broadcast).toHaveBeenCalledTimes(1);
			expect(broadcast).toHaveBeenCalledWith("workspace-1", workspacePath);

			const recorded = await loadWorkspaceState(workspacePath);
			// +1 for the seed save, +1 for the record.
			expect(recorded.revision).toBe(baseRevision + 2);
			const card = findCard(recorded.board, "task-1");
			expect(card?.lastPrompt).toBe("Fix the flaky test \n\nsecond line");
			expect(card?.lastPromptAt).toBe(123456789);
			expect(card?.updatedAt).toBe(123456789);
			// The original task prompt remains untouched.
			expect(card?.prompt).toBe("Task prompt");
		} finally {
			cleanup();
		}
	});

	it("keeps the newest accepted prompt regardless of async completion order", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-last-prompt-order-");
		try {
			const workspacePath = join(sandboxRoot, "project-order");
			initWorkspace(workspacePath);
			await seedWorkspace(workspacePath);

			// Accepted second, persisted first.
			await recordTaskLastPrompt({
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "task-1",
				text: "Second prompt",
				acceptedAt: 200,
			});
			// Accepted first but completing later: must not overwrite.
			const stale = await recordTaskLastPrompt({
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "task-1",
				text: "First prompt",
				acceptedAt: 100,
			});
			expect(stale).toBe("skipped");

			const afterStale = await loadWorkspaceState(workspacePath);
			const card = findCard(afterStale.board, "task-1");
			expect(card?.lastPrompt).toBe("Second prompt");
			expect(card?.lastPromptAt).toBe(200);

			// A later accepted send still wins.
			const newer = await recordTaskLastPrompt({
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "task-1",
				text: "Third prompt",
				acceptedAt: 300,
			});
			expect(newer).toBe("recorded");
			const afterNewer = await loadWorkspaceState(workspacePath);
			expect(findCard(afterNewer.board, "task-1")?.lastPrompt).toBe("Third prompt");
		} finally {
			cleanup();
		}
	});

	it("keeps the later write when two accepts share an acceptance timestamp", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-last-prompt-tie-");
		try {
			const workspacePath = join(sandboxRoot, "project-tie");
			initWorkspace(workspacePath);
			await seedWorkspace(workspacePath);

			await recordTaskLastPrompt({
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "task-1",
				text: "First write",
				acceptedAt: 100,
			});
			const tied = await recordTaskLastPrompt({
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "task-1",
				text: "Second write",
				acceptedAt: 100,
			});
			expect(tied).toBe("recorded");
			const recorded = await loadWorkspaceState(workspacePath);
			expect(findCard(recorded.board, "task-1")?.lastPrompt).toBe("Second write");
		} finally {
			cleanup();
		}
	});

	it("skips blank text without saving or broadcasting", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-last-prompt-blank-");
		try {
			const workspacePath = join(sandboxRoot, "project-blank");
			initWorkspace(workspacePath);
			const baseRevision = await seedWorkspace(workspacePath);
			const broadcast = vi.fn();

			const result = await recordTaskLastPrompt({
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "task-1",
				text: " \t\n ",
				acceptedAt: 100,
				broadcast,
			});
			expect(result).toBe("skipped");
			expect(broadcast).not.toHaveBeenCalled();

			const after = await loadWorkspaceState(workspacePath);
			expect(after.revision).toBe(baseRevision + 1);
			expect(findCard(after.board, "task-1")?.lastPrompt).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("never recreates a deleted card and reports no_task", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-last-prompt-missing-");
		try {
			const workspacePath = join(sandboxRoot, "project-missing");
			initWorkspace(workspacePath);
			const baseRevision = await seedWorkspace(workspacePath);
			const broadcast = vi.fn();

			const result = await recordTaskLastPrompt({
				workspaceId: "workspace-1",
				workspacePath,
				taskId: "deleted-task",
				text: "Late update",
				acceptedAt: 100,
				broadcast,
			});
			expect(result).toBe("no_task");
			expect(broadcast).not.toHaveBeenCalled();

			const after = await loadWorkspaceState(workspacePath);
			expect(after.revision).toBe(baseRevision + 1);
			expect(after.board.columns.flatMap((column) => column.cards).map((card) => card.id)).toEqual(["task-1"]);
		} finally {
			cleanup();
		}
	});

	it("returns failed instead of throwing when the workspace state cannot be read", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-last-prompt-fail-");
		try {
			const result = await recordTaskLastPrompt({
				workspaceId: "workspace-1",
				workspacePath: join(sandboxRoot, "missing-workspace"),
				taskId: "task-1",
				text: "hello",
				acceptedAt: 100,
			});
			expect(result).toBe("failed");
		} finally {
			cleanup();
		}
	});
});

describe("clearTaskLastPrompt", () => {
	it("removes the server-owned preview fields from an existing card", () => {
		const board = createBoard("task-1");
		const withPrompt: RuntimeBoardData = {
			...board,
			columns: board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) =>
					card.id === "task-1" ? { ...card, lastPrompt: "Latest prompt", lastPromptAt: 42 } : card,
				),
			})),
		};

		const cleared = clearTaskLastPrompt(withPrompt, "task-1");
		expect(findCard(cleared, "task-1")?.lastPrompt).toBeUndefined();
		expect(findCard(cleared, "task-1")?.lastPromptAt).toBeUndefined();
		// Everything else is unchanged.
		expect(findCard(cleared, "task-1")?.prompt).toBe("Task prompt");
	});

	it("leaves the board unchanged for a missing card", () => {
		const board = createBoard("task-1");
		expect(clearTaskLastPrompt(board, "missing")).toBe(board);
	});
});
