import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../../src/core/api-contract";
import { shutdownRuntimeServer } from "../../src/server/shutdown-coordinator";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import type { TerminalSessionManager } from "../../src/terminal/session-manager";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-shutdown-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

function createCard(taskId: string) {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function createBoard(taskIds: { inProgress?: string[]; review?: string[] }): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{
				id: "in_progress",
				title: "In Progress",
				cards: (taskIds.inProgress ?? []).map((taskId) => createCard(taskId)),
			},
			{
				id: "review",
				title: "Review",
				cards: (taskIds.review ?? []).map((taskId) => createCard(taskId)),
			},
			{ id: "done", title: "Done", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

function createSession(
	taskId: string,
	state: "running" | "awaiting_review" | "idle",
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "codex",
		workspacePath: `/tmp/${taskId}`,
		pid: state === "idle" ? null : 1234,
		startedAt: state === "idle" ? null : Date.now() - 1_000,
		updatedAt: Date.now(),
		lastOutputAt: state === "idle" ? null : Date.now(),
		reviewReason: state === "awaiting_review" ? "hook" : null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

describe.sequential("shutdown coordinator integration", () => {
	it("interrupts in-progress and review sessions for every indexed project on shutdown, keeping cards in place", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-shutdown-scope-");
			try {
				const managedProjectPath = join(sandboxRoot, "managed-project");
				const indexedProjectPath = join(sandboxRoot, "indexed-project");
				mkdirSync(managedProjectPath, { recursive: true });
				mkdirSync(indexedProjectPath, { recursive: true });
				initGitRepository(managedProjectPath);
				initGitRepository(indexedProjectPath);

				const managedInitial = await loadWorkspaceState(managedProjectPath);
				await saveWorkspaceState(managedProjectPath, {
					board: createBoard({
						inProgress: ["managed-running", "managed-missing-session"],
						review: ["managed-idle"],
					}),
					sessions: {
						"managed-running": createSession("managed-running", "running"),
						"managed-idle": createSession("managed-idle", "idle"),
					},
					expectedRevision: managedInitial.revision,
				});

				const indexedInitial = await loadWorkspaceState(indexedProjectPath);
				await saveWorkspaceState(indexedProjectPath, {
					board: createBoard({
						inProgress: ["indexed-missing-session"],
						review: ["indexed-awaiting-review"],
					}),
					sessions: {
						"indexed-awaiting-review": createSession("indexed-awaiting-review", "awaiting_review"),
					},
					expectedRevision: indexedInitial.revision,
				});

				let didCloseRuntimeServer = false;
				const managedTerminalManager = {
					markInterruptedAndStopAll: () => [createSession("managed-running", "running")],
					listSummaries: () => [createSession("managed-running", "running")],
					getSummary: (taskId: string) => {
						if (taskId === "managed-running") {
							return createSession("managed-running", "running");
						}
						if (taskId === "managed-idle") {
							return createSession("managed-idle", "idle");
						}
						return null;
					},
				} as unknown as TerminalSessionManager;
				await shutdownRuntimeServer({
					workspaceRegistry: {
						listManagedWorkspaces: () => [
							{
								workspaceId: "managed-project",
								workspacePath: managedProjectPath,
								terminalManager: managedTerminalManager,
							},
						],
					},
					warn: () => {},
					closeRuntimeServer: async () => {
						didCloseRuntimeServer = true;
					},
				});

				expect(didCloseRuntimeServer).toBe(true);

				// B-5: interrupted cards stay in their columns (work preserved, not discarded).
				const cardIds = (state: RuntimeWorkspaceStateResponse, columnId: string) =>
					(state.board.columns.find((column) => column.id === columnId)?.cards ?? [])
						.map((card) => card.id)
						.sort();
				const managedAfter = await loadWorkspaceState(managedProjectPath);
				expect(cardIds(managedAfter, "trash")).toEqual([]);
				expect(cardIds(managedAfter, "in_progress")).toEqual(["managed-missing-session", "managed-running"]);
				expect(cardIds(managedAfter, "review")).toEqual(["managed-idle"]);
				expect(managedAfter.sessions["managed-running"]?.state).toBe("interrupted");
				expect(managedAfter.sessions["managed-idle"]?.state).toBe("interrupted");
				expect(managedAfter.sessions["managed-missing-session"]).toBeUndefined();

				const indexedAfter = await loadWorkspaceState(indexedProjectPath);
				expect(cardIds(indexedAfter, "trash")).toEqual([]);
				expect(cardIds(indexedAfter, "in_progress")).toEqual(["indexed-missing-session"]);
				expect(cardIds(indexedAfter, "review")).toEqual(["indexed-awaiting-review"]);
				expect(indexedAfter.sessions["indexed-awaiting-review"]?.state).toBe("interrupted");
				expect(indexedAfter.sessions["indexed-missing-session"]).toBeUndefined();
			} finally {
				cleanup();
			}
		});
	}, 30_000);

	it("keeps a restore-pending Pi worktree and leaves an intentionally stopped Pi session ended", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-shutdown-pi-");
			try {
				const projectPath = join(sandboxRoot, "pi-project");
				mkdirSync(projectPath, { recursive: true });
				initGitRepository(projectPath);

				const running = createSession("pi-running", "running", { agentId: "pi" });
				// Stop leaves a settled record: no pid, and the reason it ended with.
				const stopped = createSession("pi-stopped", "awaiting_review", {
					agentId: "pi",
					reviewReason: "exit",
					pid: null,
				});
				const crashed = createSession("pi-crashed", "awaiting_review", {
					agentId: "pi",
					reviewReason: "error",
					pid: null,
				});
				const initial = await loadWorkspaceState(projectPath);
				await saveWorkspaceState(projectPath, {
					board: createBoard({ inProgress: ["pi-running"], review: ["pi-stopped", "pi-crashed"] }),
					sessions: {
						"pi-running": running,
						"pi-stopped": stopped,
						"pi-crashed": crashed,
					},
					expectedRevision: initial.revision,
				});

				const summaries = new Map([running, stopped, crashed].map((summary) => [summary.taskId, summary] as const));
				const piTerminalManager = {
					// Only the running card has a process this runtime is stopping.
					markInterruptedAndStopAll: () => [running],
					listSummaries: () => [running, stopped, crashed],
					getSummary: (taskId: string) => summaries.get(taskId) ?? null,
				} as unknown as TerminalSessionManager;
				const removedTaskIds: string[] = [];
				await shutdownRuntimeServer({
					workspaceRegistry: {
						listManagedWorkspaces: () => [
							{
								workspaceId: "pi-project",
								workspacePath: projectPath,
								terminalManager: piTerminalManager,
							},
						],
					},
					warn: () => {},
					closeRuntimeServer: async () => {},
					removeTaskWorktree: async ({ taskId }) => {
						removedTaskIds.push(taskId);
						return { ok: true, removed: true, preserved: true, blockedReason: null };
					},
				});

				const after = await loadWorkspaceState(projectPath);
				// The card Kanban was actually running is the one a restart may recover.
				expect(after.sessions["pi-running"]?.state).toBe("interrupted");
				// A stop or a crash is not "lost": rewriting it to `interrupted` would
				// make the task detail relaunch work the user ended on purpose.
				expect(after.sessions["pi-stopped"]?.state).toBe("awaiting_review");
				expect(after.sessions["pi-stopped"]?.reviewReason).toBe("exit");
				expect(after.sessions["pi-crashed"]?.reviewReason).toBe("error");
				// The restore reattaches into the original worktree and refuses to
				// recreate it, so archiving it away here would strand the card.
				expect(removedTaskIds.sort()).toEqual(["pi-crashed", "pi-stopped"]);
			} finally {
				cleanup();
			}
		});
	}, 30_000);
});
