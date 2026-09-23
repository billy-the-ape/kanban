// B-9 integration: a three-task linear chain (t1 -> t2 -> t3) running against
// real git repositories, real board state, real dispatch records, and real
// delivery receipts. The "restart" is simulated the way the server sees it: a
// fresh TerminalSessionManager hydrated from the persisted session summaries
// (which have no process behind them). A push failure is simulated with a
// failed delivery receipt (the B-8 pipeline itself is covered by its own tests).
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
	RuntimeTaskSessionSummary,
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
	collectTaskDispatchSessions,
	dispatchReadyTasks,
	reconcileTaskDispatch,
	type TaskDispatchDeps,
} from "../../src/task-dispatch/task-dispatch-service";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
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
	/** The runtime's terminal session manager (hydrated from disk after a restart). */
	terminal: TerminalSessionManager;
}

function createSessionProbe(persistedSessions: Record<string, RuntimeTaskSessionSummary> = {}): SessionProbe {
	const terminal = new TerminalSessionManager();
	terminal.hydrateFromRecord(persistedSessions);
	return { started: [], terminal };
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
		listSessions: async () => collectTaskDispatchSessions({ terminal: sessions.terminal, clineSummaries: [] }),
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
	const firstRun = createSessionProbe();
	let afterRestart: SessionProbe;

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
		await updateRuntimeConfig(repoPath, {
			gitDeliveryPolicy: { enabled: true },
			taskDispatchPolicy: { enabled: true, workerLimit: 1 },
		});
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
		// The shutdown coordinator persisted t2's summary as interrupted; the
		// restarted runtime hydrates it with no process behind it.
		afterRestart = createSessionProbe({
			t2: {
				taskId: "t2",
				state: "interrupted",
				agentId: "claude",
				workspacePath: repoPath,
				pid: null,
				startedAt: null,
				updatedAt: Date.now(),
				lastOutputAt: null,
				reviewReason: "interrupted",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
			},
		});
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
