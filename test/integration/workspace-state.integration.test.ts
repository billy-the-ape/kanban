import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskPullRequest, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { getPullRequestIdentityKey } from "../../src/core/pull-request-links";
import {
	addTaskPullRequests,
	setPrimaryTaskPullRequest,
	updateTaskPrSettings,
} from "../../src/core/task-board-mutations";
import type { WorkspaceStateConflictError } from "../../src/state/workspace-state";
import {
	getWorkspacesRootPath,
	listWorkspaceIndexEntries,
	loadWorkspaceContext,
	loadWorkspaceContextById,
	loadWorkspaceState,
	mutateWorkspaceState,
	removeWorkspaceIndexEntry,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function createBoard(title: string): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title: title,
						prompt: title,
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

function createSessionSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-");
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

function stripPullRequests(board: RuntimeBoardData): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => {
				const nextCard = { ...card };
				delete nextCard.pullRequests;
				return nextCard;
			}),
		})),
	};
}

function boardWithTaskPullRequests(
	board: RuntimeBoardData,
	taskId: string,
	pullRequests: RuntimeTaskPullRequest[],
): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => (card.id === taskId ? { ...card, pullRequests } : card)),
		})),
	};
}

function findCard(board: RuntimeBoardData, taskId: string) {
	return board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId);
}

describe.sequential("workspace-state integration", () => {
	it("persists revision numbers and rejects stale writes", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-");
			try {
				const workspacePath = join(sandboxRoot, "project-a");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const initial = await loadWorkspaceState(workspacePath);
				expect(initial.revision).toBe(0);

				const firstSave = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task One"),
					sessions: {},
					expectedRevision: initial.revision,
				});
				expect(firstSave.revision).toBe(1);
				expect(firstSave.board.columns[0]?.cards[0]?.prompt).toBe("Task One");

				const secondSave = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task Two"),
					sessions: {},
					expectedRevision: firstSave.revision,
				});
				expect(secondSave.revision).toBe(2);
				expect(secondSave.board.columns[0]?.cards[0]?.prompt).toBe("Task Two");

				await expect(
					saveWorkspaceState(workspacePath, {
						board: createBoard("Stale Task"),
						sessions: {},
						expectedRevision: firstSave.revision,
					}),
				).rejects.toMatchObject({
					name: "WorkspaceStateConflictError",
					currentRevision: secondSave.revision,
				} satisfies Partial<WorkspaceStateConflictError>);

				const loadedAfterConflict = await loadWorkspaceState(workspacePath);
				expect(loadedAfterConflict.revision).toBe(2);
				expect(loadedAfterConflict.board.columns[0]?.cards[0]?.prompt).toBe("Task Two");
			} finally {
				cleanup();
			}
		});
	});

	it("a stale whole-board save cannot clobber server-owned PR settings; new cards take client values", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-");
			try {
				const workspacePath = join(sandboxRoot, "project-a");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const initial = await loadWorkspaceState(workspacePath);
				// First save: a brand-new card takes the client's explicit booleans.
				const firstBoard = createBoard("Task One");
				const newCard = findCard(firstBoard, "task-1");
				if (newCard === undefined) {
					throw new Error("task-1 missing");
				}
				newCard.autoAddressComments = true;
				newCard.autoFinishOnMerge = true;
				await saveWorkspaceState(workspacePath, {
					board: firstBoard,
					sessions: {},
					expectedRevision: initial.revision,
				});
				let loaded = await loadWorkspaceState(workspacePath);
				let task1 = findCard(loaded.board, "task-1");
				if (task1 === undefined) {
					throw new Error("task-1 missing");
				}
				expect(task1.autoAddressComments).toBe(true);
				expect(task1.autoFinishOnMerge).toBe(true);
				expect(task1.settingsRevision).toBeUndefined();

				// The dedicated mutation (the only settings writer) flips the
				// checkbox and bumps the settings revision.
				await mutateWorkspaceState<null>(workspacePath, (state) => {
					const result = updateTaskPrSettings(state.board, "task-1", {
						autoAddressComments: false,
						expectedSettingsRevision: 0,
					});
					return { value: null, board: result.board, save: result.updated };
				});
				loaded = await loadWorkspaceState(workspacePath);
				task1 = findCard(loaded.board, "task-1");
				if (task1 === undefined) {
					throw new Error("task-1 missing");
				}
				expect(task1.autoAddressComments).toBe(false);
				expect(task1.autoFinishOnMerge).toBe(true);
				expect(task1.settingsRevision).toBe(1);

				// A stale whole-board save (client values disagree, no revision)
				// saves board content but must not touch the settings block.
				const staleBoard = createBoard("Stale title");
				const staleTask1 = findCard(staleBoard, "task-1");
				if (staleTask1 === undefined) {
					throw new Error("task-1 missing");
				}
				staleTask1.autoAddressComments = true;
				staleTask1.autoFinishOnMerge = false;
				// A brand-new card in the same save still takes its client booleans.
				const staleBacklog = staleBoard.columns[0];
				if (staleBacklog === undefined) {
					throw new Error("backlog column missing");
				}
				staleBacklog.cards.push({
					id: "task-2",
					title: "Task Two",
					prompt: "Task Two",
					startInPlanMode: false,
					autoReviewEnabled: false,
					baseRef: "main",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					autoAddressComments: true,
					autoFinishOnMerge: false,
				});
				await saveWorkspaceState(workspacePath, {
					board: staleBoard,
					sessions: {},
					expectedRevision: loaded.revision,
				});

				const afterStale = await loadWorkspaceState(workspacePath);
				const staleTask1Loaded = findCard(afterStale.board, "task-1");
				if (staleTask1Loaded === undefined) {
					throw new Error("task-1 missing");
				}
				expect(staleTask1Loaded.title).toBe("Stale title");
				expect(staleTask1Loaded.autoAddressComments).toBe(false);
				expect(staleTask1Loaded.autoFinishOnMerge).toBe(true);
				expect(staleTask1Loaded.settingsRevision).toBe(1);
				const staleTask2 = findCard(afterStale.board, "task-2");
				if (staleTask2 === undefined) {
					throw new Error("task-2 missing");
				}
				expect(staleTask2.autoAddressComments).toBe(true);
				expect(staleTask2.autoFinishOnMerge).toBe(false);
				expect(staleTask2.settingsRevision).toBeUndefined();
			} finally {
				cleanup();
			}
		});
	});

	it("lists and removes workspace index entries across multiple projects", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspaces-");
			try {
				const workspaceAPath = join(sandboxRoot, "alpha");
				const workspaceBPath = join(sandboxRoot, "beta");
				mkdirSync(workspaceAPath, { recursive: true });
				mkdirSync(workspaceBPath, { recursive: true });
				initGitRepository(workspaceAPath);
				initGitRepository(workspaceBPath);

				const contextA = await loadWorkspaceContext(workspaceAPath);
				const contextB = await loadWorkspaceContext(workspaceBPath);

				const entries = await listWorkspaceIndexEntries();
				expect(entries).toHaveLength(2);
				expect(entries.map((entry) => entry.workspaceId).sort()).toEqual(
					[contextA.workspaceId, contextB.workspaceId].sort(),
				);

				expect(await loadWorkspaceContextById(contextA.workspaceId)).not.toBeNull();
				expect(await removeWorkspaceIndexEntry(contextA.workspaceId)).toBe(true);
				expect(await loadWorkspaceContextById(contextA.workspaceId)).toBeNull();
				expect(await removeWorkspaceIndexEntry(contextA.workspaceId)).toBe(false);

				const entriesAfterRemoval = await listWorkspaceIndexEntries();
				expect(entriesAfterRemoval).toHaveLength(1);
				expect(entriesAfterRemoval[0]?.workspaceId).toBe(contextB.workspaceId);
			} finally {
				cleanup();
			}
		});
	});

	it("keeps all workspace index entries when projects are added concurrently", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspaces-concurrent-");
			try {
				const workspaceAPath = join(sandboxRoot, "alpha");
				const workspaceBPath = join(sandboxRoot, "beta");
				mkdirSync(workspaceAPath, { recursive: true });
				mkdirSync(workspaceBPath, { recursive: true });
				initGitRepository(workspaceAPath);
				initGitRepository(workspaceBPath);

				const [contextA, contextB] = await Promise.all([
					loadWorkspaceContext(workspaceAPath),
					loadWorkspaceContext(workspaceBPath),
				]);

				const entries = await listWorkspaceIndexEntries();
				expect(entries).toHaveLength(2);
				expect(entries.map((entry) => entry.workspaceId).sort()).toEqual(
					[contextA.workspaceId, contextB.workspaceId].sort(),
				);
			} finally {
				cleanup();
			}
		});
	});

	it("creates readable workspace ids from folder names with random suffix on collisions", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-id-format-");
			try {
				const workspaceAPath = join(sandboxRoot, "one", "vscrui");
				const workspaceBPath = join(sandboxRoot, "two", "vscrui");
				const workspaceCPath = join(sandboxRoot, "three", "My Cool Repo");
				mkdirSync(workspaceAPath, { recursive: true });
				mkdirSync(workspaceBPath, { recursive: true });
				mkdirSync(workspaceCPath, { recursive: true });
				initGitRepository(workspaceAPath);
				initGitRepository(workspaceBPath);
				initGitRepository(workspaceCPath);

				const contextA = await loadWorkspaceContext(workspaceAPath);
				const contextB = await loadWorkspaceContext(workspaceBPath);
				const contextC = await loadWorkspaceContext(workspaceCPath);

				expect(contextA.workspaceId).toBe("vscrui");
				expect(contextB.workspaceId).toMatch(/^vscrui-[a-z0-9]{4}$/);
				expect(contextB.workspaceId).not.toBe(contextA.workspaceId);
				expect(contextC.workspaceId).toBe("my-cool-repo");

				const contextAAgain = await loadWorkspaceContext(workspaceAPath);
				expect(contextAAgain.workspaceId).toBe(contextA.workspaceId);
			} finally {
				cleanup();
			}
		});
	});

	it("can require an existing project without auto-creating workspace entries", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-autocreate-");
			try {
				const workspacePath = join(sandboxRoot, "gamma");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				await expect(
					loadWorkspaceContext(workspacePath, {
						autoCreateIfMissing: false,
					}),
				).rejects.toThrow("is not added to Kanban yet");

				const created = await loadWorkspaceContext(workspacePath);
				expect(created.repoPath).toBeTruthy();

				const existing = await loadWorkspaceContext(workspacePath, {
					autoCreateIfMissing: false,
				});
				expect(existing.workspaceId).toBe(created.workspaceId);
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted board data is malformed", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-malformed-board-");
			try {
				const workspacePath = join(sandboxRoot, "project-bad-board");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const context = await loadWorkspaceContext(workspacePath);
				mkdirSync(context.statePath, { recursive: true });
				writeFileSync(
					join(context.statePath, "board.json"),
					JSON.stringify(
						{
							columns: [
								{
									id: "backlog",
									title: "Backlog",
									cards: [
										{
											prompt: "Missing ID and baseRef",
											startInPlanMode: false,
											createdAt: Date.now(),
											updatedAt: Date.now(),
										},
									],
								},
								{ id: "in_progress", title: "In Progress", cards: [] },
								{ id: "review", title: "Review", cards: [] },
								{ id: "trash", title: "Done", cards: [] },
							],
						},
						null,
						2,
					),
					"utf8",
				);

				await expect(loadWorkspaceState(workspacePath)).rejects.toThrow("board.json");
				await expect(loadWorkspaceState(workspacePath)).rejects.toThrow(/id|baseRef/);
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted sessions include unknown states", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-malformed-sessions-");
			try {
				const workspacePath = join(sandboxRoot, "project-bad-sessions");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const context = await loadWorkspaceContext(workspacePath);
				mkdirSync(context.statePath, { recursive: true });
				writeFileSync(
					join(context.statePath, "board.json"),
					JSON.stringify(createBoard("Valid board"), null, 2),
					"utf8",
				);
				writeFileSync(
					join(context.statePath, "sessions.json"),
					JSON.stringify(
						{
							"task-1": {
								...createSessionSummary("task-1"),
								state: "not-a-valid-state",
							},
						},
						null,
						2,
					),
					"utf8",
				);

				await expect(loadWorkspaceState(workspacePath)).rejects.toThrow("sessions.json");
				await expect(loadWorkspaceState(workspacePath)).rejects.toThrow("state");
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted workspace index data is malformed", async () => {
		await withTemporaryHome(async () => {
			mkdirSync(getWorkspacesRootPath(), { recursive: true });
			writeFileSync(
				join(getWorkspacesRootPath(), "index.json"),
				JSON.stringify(
					{
						version: 1,
						entries: {
							"workspace-a": {
								workspaceId: "workspace-a",
							},
						},
						repoPathToId: {},
					},
					null,
					2,
				),
				"utf8",
			);

			await expect(listWorkspaceIndexEntries()).rejects.toThrow("index.json");
			await expect(listWorkspaceIndexEntries()).rejects.toThrow("repoPath");
		});
	});
	it("keeps server-recorded pull request links across full board saves", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-pr-links-");
			try {
				const workspacePath = join(sandboxRoot, "project-pr-links");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const recordedLink: RuntimeTaskPullRequest = {
					provider: "github",
					host: "github.com",
					repository: "owner/repo",
					number: 12,
					url: "https://github.com/owner/repo/pull/12",
					source: "agent_tool",
					createdAt: Date.now(),
					title: "Recorded title",
					state: "open",
					stateCheckedAt: Date.now(),
				};

				const initial = await loadWorkspaceState(workspacePath);
				await saveWorkspaceState(workspacePath, {
					board: createBoard("PR link task"),
					sessions: {},
					expectedRevision: initial.revision,
				});

				await mutateWorkspaceState(workspacePath, (state) => {
					const result = addTaskPullRequests(state.board, "task-1", [recordedLink]);
					if (!result.added) {
						throw new Error("Expected the seed pull request to be recorded.");
					}
					return { board: result.board, value: result };
				});

				// PRLINK-6: a new record seeds lastSeenAt to its createdAt.
				const storedLink: RuntimeTaskPullRequest = { ...recordedLink, lastSeenAt: recordedLink.createdAt };
				const seeded = await loadWorkspaceState(workspacePath);
				expect(seeded.board.columns[0]?.cards[0]?.pullRequests).toEqual([storedLink]);

				// (a) A client board that omits the field must not erase the link.
				const omitSave = await saveWorkspaceState(workspacePath, {
					board: stripPullRequests(seeded.board),
					sessions: {},
					expectedRevision: seeded.revision,
				});
				expect(omitSave.board.columns[0]?.cards[0]?.pullRequests).toEqual([storedLink]);

				// (b) A stale client list must not overwrite the recorded link.
				const staleSave = await saveWorkspaceState(workspacePath, {
					board: boardWithTaskPullRequests(omitSave.board, "task-1", [
						{ ...recordedLink, number: 99, url: "https://github.com/owner/repo/pull/99" },
					]),
					sessions: {},
					expectedRevision: omitSave.revision,
				});
				expect(staleSave.board.columns[0]?.cards[0]?.pullRequests).toEqual([storedLink]);

				// (c) A brand-new card must never accept client-supplied pullRequests.
				const now = Date.now();
				const newCardBoard: RuntimeBoardData = {
					...staleSave.board,
					columns: staleSave.board.columns.map((column) =>
						column.id === "in_progress"
							? {
									...column,
									cards: [
										{
											id: "task-2",
											title: "New task",
											prompt: "New task",
											startInPlanMode: false,
											baseRef: "main",
											createdAt: now,
											updatedAt: now,
											pullRequests: [
												{ ...recordedLink, number: 7, url: "https://github.com/owner/repo/pull/7" },
											],
										},
										...column.cards,
									],
								}
							: column,
					),
				};
				const newCardSave = await saveWorkspaceState(workspacePath, {
					board: newCardBoard,
					sessions: {},
					expectedRevision: staleSave.revision,
				});
				const savedCards = newCardSave.board.columns.flatMap((column) => column.cards);
				expect(savedCards.find((card) => card.id === "task-1")?.pullRequests).toEqual([storedLink]);
				expect(savedCards.find((card) => card.id === "task-2")?.pullRequests).toBeUndefined();

				const loaded = await loadWorkspaceState(workspacePath);
				expect(
					loaded.board.columns.flatMap((column) => column.cards).find((card) => card.id === "task-1")
						?.pullRequests,
				).toEqual([storedLink]);

				// (d) PRLINK-6: the display-only primary flag round-trips, and
				// a stale client save cannot forge or drop it.
				await mutateWorkspaceState(workspacePath, (state) => {
					const result = setPrimaryTaskPullRequest(state.board, "task-1", getPullRequestIdentityKey(recordedLink));
					if (!result.updated) {
						throw new Error("Expected the display primary to be set.");
					}
					return { board: result.board, value: result };
				});
				const primaryLink: RuntimeTaskPullRequest = { ...storedLink, isPrimary: true };
				const primaryLoad = await loadWorkspaceState(workspacePath);
				expect(primaryLoad.board.columns[0]?.cards[0]?.pullRequests).toEqual([primaryLink]);

				const forgedSave = await saveWorkspaceState(workspacePath, {
					board: boardWithTaskPullRequests(primaryLoad.board, "task-1", [
						{ ...storedLink, number: 7, url: "https://github.com/owner/repo/pull/7", isPrimary: true },
					]),
					sessions: {},
					expectedRevision: primaryLoad.revision,
				});
				expect(forgedSave.board.columns[0]?.cards[0]?.pullRequests).toEqual([primaryLink]);
			} finally {
				cleanup();
			}
		});
	});
});
