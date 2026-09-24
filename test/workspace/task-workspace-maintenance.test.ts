// B-5.7 / B-5.9 — workspace maintenance against real temporary git repos.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeGitDeliveryReceipt } from "../../src/core/api-contract";
import { readTaskPreservationRecord } from "../../src/workspace/task-preservation";
import { listBlockedTaskCleanups, runTaskWorkspaceMaintenance } from "../../src/workspace/task-workspace-maintenance";
import { ensureTaskWorktreeIfDoesntExist, taskWorktreeExists } from "../../src/workspace/task-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const DAY_MS = 24 * 60 * 60 * 1000;

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

async function withRepo(run: (repoPath: string) => Promise<void>): Promise<void> {
	const home = createTempDir("kanban-maintenance-home-");
	const repo = createTempDir("kanban-maintenance-repo-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home.path;
	process.env.USERPROFILE = home.path;
	try {
		runGit(repo.path, ["init", "-q"]);
		runGit(repo.path, ["config", "user.name", "Kanban Test"]);
		runGit(repo.path, ["config", "user.email", "kanban-test@example.com"]);
		writeFileSync(join(repo.path, "README.md"), "hello\n", "utf8");
		runGit(repo.path, ["add", "README.md"]);
		runGit(repo.path, ["commit", "-qm", "init"]);
		await run(repo.path);
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
		repo.cleanup();
		home.cleanup();
	}
}

function board(columns: Partial<Record<"review" | "done" | "trash", Array<{ id: string; updatedAt?: number }>>>) {
	const card = (entry: { id: string; updatedAt?: number }) => ({
		id: entry.id,
		title: entry.id,
		prompt: entry.id,
		startInPlanMode: false,
		baseRef: "HEAD",
		createdAt: 1,
		updatedAt: entry.updatedAt ?? Date.now(),
	});
	const result: RuntimeBoardData = {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: (columns.review ?? []).map(card) },
			{ id: "done", title: "Done", cards: (columns.done ?? []).map(card) },
			{ id: "trash", title: "Trash", cards: (columns.trash ?? []).map(card) },
		],
		dependencies: [],
	};
	return result;
}

async function createWorktree(repoPath: string, taskId: string): Promise<string> {
	const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId, baseRef: "HEAD" });
	if (!ensured.ok || !ensured.path) {
		throw new Error(`worktree for ${taskId} was not created`);
	}
	writeFileSync(join(ensured.path, "work.txt"), `${taskId} work\n`, "utf8");
	return ensured.path;
}

const deliveredReceipt = (taskId: string, updatedAt: number) =>
	({ taskId, status: "delivered", updatedAt }) as RuntimeGitDeliveryReceipt;

describe("runTaskWorkspaceMaintenance", () => {
	it("retries trash cleanups and reports the ones that stay blocked (B-5.9)", async () => {
		await withRepo(async (repoPath) => {
			await createWorktree(repoPath, "trash-ok");
			await createWorktree(repoPath, "trash-busy");
			const trashBoard = board({ trash: [{ id: "trash-ok" }, { id: "trash-busy" }] });

			const report = await runTaskWorkspaceMaintenance({
				repoPath,
				board: trashBoard,
				readDeliveryReceipt: async () => null,
				isTaskWriterActive: async (taskId) => taskId === "trash-busy",
			});

			expect(report.removedWorktrees).toEqual(["trash-ok"]);
			expect(report.blockedCleanups).toEqual([
				{ taskId: "trash-busy", reason: "The task's agent session is still running." },
			]);
			expect(await taskWorktreeExists(repoPath, "trash-ok")).toBe(false);
			expect(await taskWorktreeExists(repoPath, "trash-busy")).toBe(true);
			// The removed worktree's work was preserved first.
			expect((await readTaskPreservationRecord("trash-ok"))?.status).toBe("preserved");
			// The still-present one is what the board shows as blocked.
			const blocked = await listBlockedTaskCleanups({ repoPath, board: trashBoard });
			expect(blocked.map((entry) => entry.taskId)).toEqual(["trash-busy"]);
		});
	});

	it("removes a Done worktree only once its delivery receipt is complete (B-5.7)", async () => {
		await withRepo(async (repoPath) => {
			await createWorktree(repoPath, "done-delivered");
			await createWorktree(repoPath, "done-undelivered");

			const report = await runTaskWorkspaceMaintenance({
				repoPath,
				board: board({ done: [{ id: "done-delivered" }, { id: "done-undelivered" }] }),
				readDeliveryReceipt: async (taskId) =>
					taskId === "done-delivered" ? deliveredReceipt(taskId, Date.now()) : null,
			});

			expect(report.removedWorktrees).toEqual(["done-delivered"]);
			expect(await taskWorktreeExists(repoPath, "done-delivered")).toBe(false);
			expect(await taskWorktreeExists(repoPath, "done-undelivered")).toBe(true);
		});
	});

	it("prunes discarded work after the retention period but never undelivered work (B-5.7)", async () => {
		await withRepo(async (repoPath) => {
			await createWorktree(repoPath, "discarded");
			await createWorktree(repoPath, "in-review");
			// Preserve both (cleanup via trash), then put "in-review" back on the board in Review.
			await runTaskWorkspaceMaintenance({
				repoPath,
				board: board({ trash: [{ id: "discarded" }, { id: "in-review" }] }),
				readDeliveryReceipt: async () => null,
			});
			expect(await readTaskPreservationRecord("discarded")).not.toBeNull();

			const later = Date.now() + 31 * DAY_MS;
			const report = await runTaskWorkspaceMaintenance({
				repoPath,
				board: board({ review: [{ id: "in-review" }] }),
				readDeliveryReceipt: async () => null,
				now: later,
			});

			expect(report.prunedPreservation).toEqual(["discarded"]);
			expect(await readTaskPreservationRecord("discarded")).toBeNull();
			expect(await readTaskPreservationRecord("in-review")).not.toBeNull();
			expect(report.flaggedPreservation.map((entry) => entry.taskId)).toEqual(["in-review"]);
		});
	});

	it("prunes eligible work oldest-first to stay under the size cap", async () => {
		await withRepo(async (repoPath) => {
			await createWorktree(repoPath, "old-trash");
			await createWorktree(repoPath, "new-trash");
			const now = Date.now();
			const trashBoard = board({
				trash: [
					{ id: "old-trash", updatedAt: now - 2 * DAY_MS },
					{ id: "new-trash", updatedAt: now - DAY_MS },
				],
			});
			await runTaskWorkspaceMaintenance({ repoPath, board: trashBoard, readDeliveryReceipt: async () => null });

			const report = await runTaskWorkspaceMaintenance({
				repoPath,
				board: trashBoard,
				readDeliveryReceipt: async () => null,
				now,
				policy: { archiveRetentionDays: 30, maxArchiveBytes: 1, removeDeliveredWorktrees: true },
			});

			// Both are within retention; the cap forces pruning, oldest discard first.
			expect(report.prunedPreservation).toEqual(["old-trash", "new-trash"]);
			expect(report.preservationBytes).toBe(0);
			expect(report.flaggedPreservation).toEqual([]);
		});
	});
});
