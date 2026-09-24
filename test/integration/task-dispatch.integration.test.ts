// B-9 integration: a three-task linear chain (t1 -> t2 -> t3) running against
// real git repositories, real board state, real dispatch records, and real
// delivery receipts. The "restart" is simulated by rebuilding the dispatch
// deps with a fresh session list; a push failure is simulated with a failed
// delivery receipt (the B-8 pipeline itself is covered by its own tests).
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadRuntimeConfig, updateRuntimeConfig } from "../../src/config/runtime-config";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeGitDeliveryReceipt,
} from "../../src/core/api-contract";
import { moveTaskToColumn } from "../../src/core/task-board-mutations";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import {
	getTaskWorktreesHomePath,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	mutateWorkspaceState,
} from "../../src/state/workspace-state";
import { readTaskDispatchRecord } from "../../src/task-dispatch/dispatch-records";
import {
	dispatchReadyTasks,
	reconcileTaskDispatch,
	type TaskDispatchDeps,
} from "../../src/task-dispatch/task-dispatch-service";
import { getTaskDeliveryDir, readTaskDeliveryReceipt } from "../../src/workspace/git-delivery";
import { resolveTaskCwd } from "../../src/workspace/task-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(
			[`git ${args.join(" ")} failed in ${cwd}`, result.stdout.trim(), result.stderr.trim()]
				.filter((part) => part.length > 0)
				.join("\n"),
		);
	}
	return result.stdout.trim();
}

function gitIsAncestor(cwd: string, ancestorSha: string, descendantSha: string): boolean {
	const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestorSha, descendantSha], {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	return result.status === 0;
}

/** Simulate the durable receipt the B-8 delivery pipeline would have written. */
async function writeSimulatedReceipt(
	workspaceId: string,
	taskId: string,
	status: "delivered" | "failed",
	integratedSha: string | null,
): Promise<void> {
	const receipt: RuntimeGitDeliveryReceipt = {
		taskId,
		workspaceId,
		repoPath: "repo",
		worktreePath: join(getTaskWorktreesHomePath(), taskId),
		baseRef: "main",
		baseSha: null,
		destinationBranch: "main",
		remote: "origin",
		remoteBranchSha: null,
		taskCommitSha: status === "delivered" ? integratedSha : null,
		integratedSha,
		status,
		stage: "pushed",
		policy: {
			enabled: true,
			remote: "origin",
			destinationBranch: "main",
			pushRequired: true,
			protectedBranches: ["main"],
			integrationStrategy: "fast_forward",
			requirePullRequest: false,
			pullRequestBaseBranch: null,
		},
		commitMessageSource: null,
		stagedPaths: [],
		excludedPaths: [],
		reviewOutcome: null,
		verificationPassed: null,
		candidateTreeHash: null,
		combinedVerificationPassed: null,
		pr: null,
		evidence: [],
		attempt: 1,
		startedAt: Date.now(),
		updatedAt: Date.now(),
	};
	const dir = getTaskDeliveryDir(taskId);
	await mkdir(dir, { recursive: true });
	await lockedFileSystem.writeJsonFileAtomic(join(dir, "receipt.json"), receipt);
}

function seedBoard(): RuntimeBoardData {
	const now = Date.now();
	const card = (id: string): RuntimeBoardCard => ({
		id,
		title: id,
		prompt: `Do the work for ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: now,
		updatedAt: now,
	});
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [card("t2"), card("t3")] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "done", title: "Done", cards: [card("t1")] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [
			{ id: "dep-t2-t1", fromTaskId: "t2", toTaskId: "t1", createdAt: now },
			{ id: "dep-t3-t2", fromTaskId: "t3", toTaskId: "t2", createdAt: now },
		],
	};
}

async function moveToColumn(repoPath: string, taskId: string, columnId: RuntimeBoardColumnId): Promise<void> {
	await mutateWorkspaceState<void>(repoPath, (state) => ({
		board: moveTaskToColumn(state.board, taskId, columnId).board,
		value: undefined,
	}));
}

function columnIdOf(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
	for (const column of board.columns) {
		if (column.cards.some((card) => card.id === taskId)) {
			return column.id;
		}
	}
	return null;
}

interface SessionProbe {
	started: Array<{ taskId: string; prompt: string }>;
}

function buildDeps(workspaceId: string, repoPath: string, sessions: SessionProbe): TaskDispatchDeps {
	return {
		workspaceId,
		workspacePath: repoPath,
		loadConfig: () => loadRuntimeConfig(repoPath),
		loadBoard: () => loadWorkspaceBoardById(workspaceId),
		persistBoard: async (mutate) => {
			await mutateWorkspaceState<void>(repoPath, (state) => ({
				board: mutate(state.board),
				value: undefined,
			}));
		},
		listTerminalSummaries: () => Promise.resolve([]),
		listClineSummaries: () => Promise.resolve([]),
		readReceipt: (taskId) => readTaskDeliveryReceipt(taskId),
		// The only seam we stub: no real agent process in an integration test.
		// Everything around the session launch (records, board, git, receipts)
		// is the real implementation.
		startSession: async (input) => {
			sessions.started.push({ taskId: input.taskId, prompt: input.prompt });
			return {
				ok: true,
				summary: {
					taskId: input.taskId,
					state: "running",
					agentId: "cline",
					workspacePath: repoPath,
					pid: null,
					startedAt: null,
					updatedAt: Date.now(),
					lastOutputAt: null,
					reviewReason: null,
					exitCode: null,
					lastHookAt: null,
					latestHookActivity: null,
				},
			};
		},
	};
}

let previousHome: string | undefined;
let previousUserProfile: string | undefined;

describe("B-9 task dispatch integration (linear chain, restart, failed delivery)", () => {
	let home: { path: string; cleanup: () => void };
	let repo: { path: string; cleanup: () => void };
	let repoPath: string;
	let workspaceId: string;
	let t1Sha: string;
	let t2Sha: string;
	const firstRun: SessionProbe = { started: [] };
	const afterRestart: SessionProbe = { started: [] };

	beforeAll(async () => {
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		home = createTempDir("kanban-b9-home-");
		repo = createTempDir("kanban-b9-repo-");
		process.env.HOME = home.path;
		process.env.USERPROFILE = home.path;
		repoPath = repo.path;
		runGit(repoPath, ["init"]);
		runGit(repoPath, ["branch", "-m", "main"]);
		await writeFile(join(repoPath, "README.md"), "# repo\n");
		runGit(repoPath, ["add", "."]);
		runGit(repoPath, ["commit", "-m", "initial"]);
		await writeFile(join(repoPath, "a.txt"), "a\n");
		runGit(repoPath, ["add", "."]);
		runGit(repoPath, ["commit", "-m", "t1 work"]);
		t1Sha = runGit(repoPath, ["rev-parse", "HEAD"]);

		const context = await loadWorkspaceContext(repoPath);
		workspaceId = context.workspaceId;
		await updateRuntimeConfig(repoPath, { taskDispatchPolicy: { enabled: true, workerLimit: 1 } });
		await mutateWorkspaceState<void>(repoPath, () => ({
			board: seedBoard(),
			value: undefined,
		}));
	});

	afterAll(() => {
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
		home.cleanup();
		repo.cleanup();
	});

	it("dispatches t2 from a verified base once t1 is delivered", async () => {
		await writeSimulatedReceipt(workspaceId, "t1", "delivered", t1Sha);
		const response = await dispatchReadyTasks(buildDeps(workspaceId, repoPath, firstRun));
		expect(response.dispatchedTaskId).toBe("t2");
		expect(response.skippedReason).toBeNull();
		expect(firstRun.started).toHaveLength(1);
		expect(firstRun.started[0]?.taskId).toBe("t2");
		// Fresh-context prompt references the delivered prerequisite work.
		expect(firstRun.started[0]?.prompt).toContain("Fresh Kanban task session");
		expect(firstRun.started[0]?.prompt).toContain(t1Sha);

		const board = await loadWorkspaceBoardById(workspaceId);
		expect(columnIdOf(board, "t2")).toBe("in_progress");
		expect(columnIdOf(board, "t3")).toBe("backlog");

		// Real git: the worktree exists at the verified base commit.
		const t2Worktree = await resolveTaskCwd({ cwd: repoPath, taskId: "t2", baseRef: "main", ensure: false });
		expect(runGit(t2Worktree, ["rev-parse", "HEAD"])).toBe(t1Sha);
		const record = await readTaskDispatchRecord("t2");
		expect(record?.status).toBe("dispatched");
		expect(record?.baseSha).toBe(t1Sha);
	});

	it("restart reconciliation relaunches the in-flight task with the recorded prompt", async () => {
		const response = await reconcileTaskDispatch(buildDeps(workspaceId, repoPath, afterRestart));
		expect(response.relaunchedTaskIds).toEqual(["t2"]);
		expect(response.skippedTaskIds).toEqual([]);
		expect(afterRestart.started).toHaveLength(1);
		// Same verified baseline, reused prompt (no re-build).
		expect(afterRestart.started[0]?.prompt).toBe(firstRun.started[0]?.prompt);
		const record = await readTaskDispatchRecord("t2");
		expect(record?.status).toBe("dispatched");
		expect(record?.attempt).toBe(2);
	});

	it("keeps t3 blocked while t2's delivery is failing (push failure)", async () => {
		await moveToColumn(repoPath, "t2", "done");
		await writeSimulatedReceipt(workspaceId, "t2", "failed", null);
		const response = await dispatchReadyTasks(buildDeps(workspaceId, repoPath, afterRestart));
		expect(response.dispatchedTaskId).toBeNull();
		expect(afterRestart.started).toHaveLength(1);
		const t3View = response.blockedTasks.find((view) => view.taskId === "t3");
		expect(t3View?.blockedReason).toContain("delivery failed");
	});

	it("dispatches t3 at the re-delivered base, with all delivered ancestry present", async () => {
		await writeFile(join(repoPath, "b.txt"), "b\n");
		runGit(repoPath, ["add", "."]);
		runGit(repoPath, ["commit", "-m", "t2 work"]);
		t2Sha = runGit(repoPath, ["rev-parse", "HEAD"]);
		await writeSimulatedReceipt(workspaceId, "t2", "delivered", t2Sha);

		const response = await dispatchReadyTasks(buildDeps(workspaceId, repoPath, afterRestart));
		expect(response.dispatchedTaskId).toBe("t3");
		expect(afterRestart.started).toHaveLength(2);
		expect(afterRestart.started[1]?.prompt).toContain(t2Sha);

		const board = await loadWorkspaceBoardById(workspaceId);
		expect(columnIdOf(board, "t3")).toBe("in_progress");

		// Real git: the t3 worktree sits on the re-delivered base and contains
		// every delivered prerequisite commit (base-SHA ancestry verified).
		const t3Worktree = await resolveTaskCwd({ cwd: repoPath, taskId: "t3", baseRef: "main", ensure: false });
		expect(runGit(t3Worktree, ["rev-parse", "HEAD"])).toBe(t2Sha);
		expect(gitIsAncestor(t3Worktree, t1Sha, t2Sha)).toBe(true);
		const record = await readTaskDispatchRecord("t3");
		expect(record?.status).toBe("dispatched");
		expect(record?.baseSha).toBe(t2Sha);
	});
});

function seedParallelBoard(): RuntimeBoardData {
	const now = Date.now();
	const card = (id: string): RuntimeBoardCard => ({
		id,
		title: id,
		prompt: `Do the work for ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: now,
		updatedAt: now,
	});
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [card("t2"), card("t3")] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "done", title: "Done", cards: [card("t1")] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		// t2 and t3 are independent: both depend only on the delivered t1.
		dependencies: [
			{ id: "dep-t2-t1", fromTaskId: "t2", toTaskId: "t1", createdAt: now },
			{ id: "dep-t3-t1", fromTaskId: "t3", toTaskId: "t1", createdAt: now },
		],
	};
}

// B-11 integration: two independent tasks forked from one delivered base run
// in parallel under a shared budget of 2, both branches land on main (simulated
// with the same cherry-pick integration the B-8/B-11 pipeline performs against
// a diverged destination), and the dependent task dispatches at a base
// containing both integrated results.
describe("B-11 task dispatch integration (parallel branches, shared budget)", () => {
	let previousHomeB11: string | undefined;
	let previousUserProfileB11: string | undefined;
	let home: { path: string; cleanup: () => void };
	let repo: { path: string; cleanup: () => void };
	let repoPath: string;
	let workspaceId: string;
	let baseSha: string;
	const parallelRun: SessionProbe = { started: [] };

	beforeAll(async () => {
		previousHomeB11 = process.env.HOME;
		previousUserProfileB11 = process.env.USERPROFILE;
		home = createTempDir("kanban-b11-home-");
		repo = createTempDir("kanban-b11-repo-");
		process.env.HOME = home.path;
		process.env.USERPROFILE = home.path;
		repoPath = repo.path;
		runGit(repoPath, ["init"]);
		runGit(repoPath, ["branch", "-m", "main"]);
		await writeFile(join(repoPath, "README.md"), "# repo\n");
		runGit(repoPath, ["add", "."]);
		runGit(repoPath, ["commit", "-m", "initial"]);
		await writeFile(join(repoPath, "a.txt"), "a\n");
		runGit(repoPath, ["add", "."]);
		runGit(repoPath, ["commit", "-m", "t1 work"]);
		baseSha = runGit(repoPath, ["rev-parse", "HEAD"]);

		const context = await loadWorkspaceContext(repoPath);
		workspaceId = context.workspaceId;
		await updateRuntimeConfig(repoPath, {
			taskDispatchPolicy: { enabled: true, workerLimit: 2 },
		});
		await mutateWorkspaceState<void>(repoPath, () => ({
			board: seedParallelBoard(),
			value: undefined,
		}));
	});

	afterAll(() => {
		if (previousHomeB11 === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHomeB11;
		}
		if (previousUserProfileB11 === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfileB11;
		}
		home.cleanup();
		repo.cleanup();
	});

	it("dispatches both independent tasks in one pass under the shared budget", async () => {
		await writeSimulatedReceipt(workspaceId, "t1", "delivered", baseSha);
		const response = await dispatchReadyTasks(buildDeps(workspaceId, repoPath, parallelRun));
		expect(response.dispatchedTaskId).toBe("t2");
		expect(response.skippedReason).toBeNull();
		expect(parallelRun.started.map((session) => session.taskId)).toEqual(["t2", "t3"]);

		const board = await loadWorkspaceBoardById(workspaceId);
		expect(columnIdOf(board, "t2")).toBe("in_progress");
		expect(columnIdOf(board, "t3")).toBe("in_progress");

		// Real git: both worktrees are created at the verified fork point.
		for (const taskId of ["t2", "t3"]) {
			const worktree = await resolveTaskCwd({
				cwd: repoPath,
				taskId,
				baseRef: "main",
				ensure: false,
			});
			expect(runGit(worktree, ["rev-parse", "HEAD"])).toBe(baseSha);
		}
	});

	it("integrates both branches and dispatches the dependent task at a base containing both", async () => {
		// Simulate the agents' work in each task worktree...
		const t2Worktree = await resolveTaskCwd({
			cwd: repoPath,
			taskId: "t2",
			baseRef: "main",
			ensure: false,
		});
		await writeFile(join(t2Worktree, "b.txt"), "b\n");
		runGit(t2Worktree, ["add", "."]);
		runGit(t2Worktree, ["commit", "-m", "t2 work"]);
		const t2TaskSha = runGit(t2Worktree, ["rev-parse", "HEAD"]);
		// ...and the B-8/B-11 pipeline's cherry-pick integration into the
		// destination branch (main has diverged: both tasks forked from baseSha).
		runGit(repoPath, ["cherry-pick", t2TaskSha]);
		const t2IntegratedSha = runGit(repoPath, ["rev-parse", "HEAD"]);
		await writeSimulatedReceipt(workspaceId, "t2", "delivered", t2IntegratedSha);

		const t3Worktree = await resolveTaskCwd({
			cwd: repoPath,
			taskId: "t3",
			baseRef: "main",
			ensure: false,
		});
		await writeFile(join(t3Worktree, "c.txt"), "c\n");
		runGit(t3Worktree, ["add", "."]);
		runGit(t3Worktree, ["commit", "-m", "t3 work"]);
		const t3TaskSha = runGit(t3Worktree, ["rev-parse", "HEAD"]);
		runGit(repoPath, ["cherry-pick", t3TaskSha]);
		const t3IntegratedSha = runGit(repoPath, ["rev-parse", "HEAD"]);
		await writeSimulatedReceipt(workspaceId, "t3", "delivered", t3IntegratedSha);

		await moveToColumn(repoPath, "t2", "done");
		await moveToColumn(repoPath, "t3", "done");

		// t4 depends on both parallel branches.
		await mutateWorkspaceState<void>(repoPath, (state) => {
			const now = Date.now();
			const card: RuntimeBoardCard = {
				id: "t4",
				title: "t4",
				prompt: "Build on t2 and t3",
				startInPlanMode: false,
				baseRef: "main",
				createdAt: now,
				updatedAt: now,
			};
			const board = state.board;
			const backlog = board.columns.find((column) => column.id === "backlog");
			if (backlog) {
				backlog.cards.push(card);
			}
			board.dependencies.push(
				{ id: "dep-t4-t2", fromTaskId: "t4", toTaskId: "t2", createdAt: now },
				{ id: "dep-t4-t3", fromTaskId: "t4", toTaskId: "t3", createdAt: now },
			);
			return { board, value: undefined };
		});

		const response = await dispatchReadyTasks(buildDeps(workspaceId, repoPath, parallelRun));
		expect(response.dispatchedTaskId).toBe("t4");
		expect(parallelRun.started.map((session) => session.taskId)).toEqual(["t2", "t3", "t4"]);

		const board = await loadWorkspaceBoardById(workspaceId);
		expect(columnIdOf(board, "t4")).toBe("in_progress");

		// The dependent task's worktree sits on a base that contains both
		// integrated parallel results (base-SHA ancestry verified against both).
		const t4Worktree = await resolveTaskCwd({
			cwd: repoPath,
			taskId: "t4",
			baseRef: "main",
			ensure: false,
		});
		const t4Head = runGit(t4Worktree, ["rev-parse", "HEAD"]);
		expect(gitIsAncestor(t4Worktree, t2IntegratedSha, t4Head)).toBe(true);
		expect(gitIsAncestor(t4Worktree, t3IntegratedSha, t4Head)).toBe(true);
		const record = await readTaskDispatchRecord("t4");
		expect(record?.status).toBe("dispatched");
		expect(record?.baseSha).toBe(t3IntegratedSha);

		// Both parallel results are on main, and both are referenced in the
		// dependent task's fresh-context prompt.
		expect(runGit(repoPath, ["show", "HEAD:b.txt"])).toBe("b");
		expect(runGit(repoPath, ["show", "HEAD:c.txt"])).toBe("c");
		expect(parallelRun.started[2]?.prompt).toContain(t2IntegratedSha);
		expect(parallelRun.started[2]?.prompt).toContain(t3IntegratedSha);
	});
});
