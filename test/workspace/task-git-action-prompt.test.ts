// AUTOGIT: server-owned dedupe state for generated auto git-action prompts.
// Isolated from the real ~/.cline by redirecting HOME (AGENTS.md).
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../src/core/api-contract";
import { completeTaskAndGetReadyLinkedTaskIds } from "../../src/core/task-board-mutations";
import { loadWorkspaceState, mutateWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { acquireTaskGitActionPrompt, releaseTaskGitActionPrompt } from "../../src/workspace/task-git-action-prompt";
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
	tempHome = { ...createTempDir("kanban-git-action-prompt-home-"), previousHome, previousUserProfile };
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

function createCard(id: string): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: "Task prompt",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createBoard(reviewCardIds: string[], doneCardIds: string[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: reviewCardIds.map(createCard) },
			{ id: "done", title: "Done", cards: doneCardIds.map(createCard) },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

async function initWorkspace(workspacePath: string, board: RuntimeBoardData): Promise<void> {
	mkdirSync(workspacePath, { recursive: true });
	const init = spawnSync("git", ["init"], { cwd: workspacePath, stdio: "ignore", env: createGitTestEnv() });
	expect(init.status).toBe(0);
	await saveWorkspaceState(workspacePath, { board, sessions: {} });
}

function findCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | undefined {
	return board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId);
}

describe("task git action prompt records", () => {
	it("acquires once per episode and rejects a second auto attempt", async () => {
		const workspace = createTempDir("kanban-git-action-prompt-ws-");
		try {
			await initWorkspace(workspace.path, createBoard(["task-1"], []));
			const first = await acquireTaskGitActionPrompt({
				workspacePath: workspace.path,
				taskId: "task-1",
				action: "pr",
				intent: "auto",
			});
			expect(first).toBe("acquired");
			const second = await acquireTaskGitActionPrompt({
				workspacePath: workspace.path,
				taskId: "task-1",
				action: "pr",
				intent: "auto",
			});
			expect(second).toBe("already_sent");
			const state = await loadWorkspaceState(workspace.path);
			expect(findCard(state.board, "task-1")?.sentGitActionPrompt?.action).toBe("pr");
		} finally {
			workspace.cleanup();
		}
	});

	it("lets a manual send override the existing record in the same episode", async () => {
		const workspace = createTempDir("kanban-git-action-prompt-ws-");
		try {
			await initWorkspace(workspace.path, createBoard(["task-1"], []));
			expect(
				await acquireTaskGitActionPrompt({
					workspacePath: workspace.path,
					taskId: "task-1",
					action: "pr",
					intent: "auto",
				}),
			).toBe("acquired");
			expect(
				await acquireTaskGitActionPrompt({
					workspacePath: workspace.path,
					taskId: "task-1",
					action: "commit",
					intent: "manual",
				}),
			).toBe("acquired");
			const state = await loadWorkspaceState(workspace.path);
			expect(findCard(state.board, "task-1")?.sentGitActionPrompt?.action).toBe("commit");
		} finally {
			workspace.cleanup();
		}
	});

	it("rejects records for cards outside Review and unknown cards", async () => {
		const workspace = createTempDir("kanban-git-action-prompt-ws-");
		try {
			await initWorkspace(workspace.path, createBoard([], ["task-done"]));
			expect(
				await acquireTaskGitActionPrompt({
					workspacePath: workspace.path,
					taskId: "task-done",
					action: "pr",
					intent: "auto",
				}),
			).toBe("not_in_review");
			expect(
				await acquireTaskGitActionPrompt({
					workspacePath: workspace.path,
					taskId: "missing",
					action: "pr",
					intent: "auto",
				}),
			).toBe("no_task");
		} finally {
			workspace.cleanup();
		}
	});

	it("releases only a matching record", async () => {
		const workspace = createTempDir("kanban-git-action-prompt-ws-");
		try {
			await initWorkspace(workspace.path, createBoard(["task-1"], []));
			expect(
				await acquireTaskGitActionPrompt({
					workspacePath: workspace.path,
					taskId: "task-1",
					action: "commit",
					intent: "auto",
				}),
			).toBe("acquired");
			expect(
				await releaseTaskGitActionPrompt({
					workspacePath: workspace.path,
					taskId: "task-1",
					action: "pr",
				}),
			).toBe(false);
			expect(
				await releaseTaskGitActionPrompt({
					workspacePath: workspace.path,
					taskId: "task-1",
					action: "commit",
				}),
			).toBe(true);
			const state = await loadWorkspaceState(workspace.path);
			expect(findCard(state.board, "task-1")?.sentGitActionPrompt).toBeUndefined();
		} finally {
			workspace.cleanup();
		}
	});

	it("clears the record automatically when a board save leaves Review", async () => {
		const workspace = createTempDir("kanban-git-action-prompt-ws-");
		try {
			await initWorkspace(workspace.path, createBoard(["task-1"], []));
			expect(
				await acquireTaskGitActionPrompt({
					workspacePath: workspace.path,
					taskId: "task-1",
					action: "pr",
					intent: "auto",
				}),
			).toBe("acquired");
			// A client save moves the card to Done; the record must not survive.
			await saveWorkspaceState(workspace.path, { board: createBoard([], ["task-1"]), sessions: {} });
			const state = await loadWorkspaceState(workspace.path);
			const card = findCard(state.board, "task-1");
			expect(card?.sentGitActionPrompt).toBeUndefined();
			// The card sits in Done: no acquisition is possible there.
			expect(
				await acquireTaskGitActionPrompt({
					workspacePath: workspace.path,
					taskId: "task-1",
					action: "pr",
					intent: "auto",
				}),
			).toBe("not_in_review");
		} finally {
			workspace.cleanup();
		}
	});

	it("keeps the record across a whole-board save while the card stays in Review", async () => {
		const workspace = createTempDir("kanban-git-action-prompt-ws-");
		try {
			await initWorkspace(workspace.path, createBoard(["task-1"], []));
			expect(
				await acquireTaskGitActionPrompt({
					workspacePath: workspace.path,
					taskId: "task-1",
					action: "pr",
					intent: "auto",
				}),
			).toBe("acquired");
			// A stale client save that omits the field must not drop the record.
			await saveWorkspaceState(workspace.path, { board: createBoard(["task-1"], []), sessions: {} });
			const state = await loadWorkspaceState(workspace.path);
			expect(findCard(state.board, "task-1")?.sentGitActionPrompt?.action).toBe("pr");
		} finally {
			workspace.cleanup();
		}
	});
	it("does not resurrect a stale record after a server-side move out of Review", async () => {
		const workspace = createTempDir("kanban-git-action-prompt-ws-");
		try {
			await initWorkspace(workspace.path, createBoard(["task-1"], []));
			expect(
				await acquireTaskGitActionPrompt({
					workspacePath: workspace.path,
					taskId: "task-1",
					action: "pr",
					intent: "auto",
				}),
			).toBe("acquired");
			// Server-side completion (runtime-server auto-complete, CLI done)
			// moves the card through mutateWorkspaceState, bypassing the
			// saveWorkspaceState merge; moveTaskToColumn spreads the card and
			// keeps the record on the Done card.
			await mutateWorkspaceState<void>(workspace.path, (state) => {
				const result = completeTaskAndGetReadyLinkedTaskIds(state.board, "task-1");
				return { board: result.board, value: undefined, save: result.moved };
			});
			const afterMove = await loadWorkspaceState(workspace.path);
			expect(findCard(afterMove.board, "task-1")?.sentGitActionPrompt).toBeDefined();
			// The first client save after the move puts the card back in
			// Review: that is a new episode, so the stale record must not be
			// restored and the prompt must not be suppressed.
			await saveWorkspaceState(workspace.path, { board: createBoard(["task-1"], []), sessions: {} });
			const reopened = await loadWorkspaceState(workspace.path);
			expect(findCard(reopened.board, "task-1")?.sentGitActionPrompt).toBeUndefined();
			expect(
				await acquireTaskGitActionPrompt({
					workspacePath: workspace.path,
					taskId: "task-1",
					action: "pr",
					intent: "auto",
				}),
			).toBe("acquired");
		} finally {
			workspace.cleanup();
		}
	});

	it("reports a distinct error status when the workspace state cannot be read", async () => {
		const workspace = createTempDir("kanban-git-action-prompt-ws-");
		try {
			await initWorkspace(workspace.path, createBoard(["task-1"], []));
			// A path that is not a workspace makes loadWorkspaceContext throw;
			// the acquire must swallow it and report `error` (not `no_task`)
			// so clients degrade to sending the prompt.
			const status = await acquireTaskGitActionPrompt({
				workspacePath: join(workspace.path, "no-such-workspace"),
				taskId: "task-1",
				action: "pr",
				intent: "auto",
			});
			expect(status).toBe("error");
		} finally {
			workspace.cleanup();
		}
	});
});
