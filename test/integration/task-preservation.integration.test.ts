// B-5.2 / B-5.3 / B-5.6 acceptance: task work survives worktree cleanup and
// restores exactly, and a failed preservation write blocks cleanup.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getTaskPreservationDir, readTaskPreservationRecord } from "../../src/workspace/task-preservation";
import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

async function withRepo(run: (repoPath: string) => Promise<void>): Promise<void> {
	const home = createTempDir("kanban-preservation-home-");
	const sandbox = createTempDir("kanban-preservation-repo-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home.path;
	process.env.USERPROFILE = home.path;
	try {
		const repoPath = join(sandbox.path, "repo");
		mkdirSync(repoPath, { recursive: true });
		runGit(repoPath, ["init", "-q"]);
		runGit(repoPath, ["config", "user.name", "Kanban Test"]);
		runGit(repoPath, ["config", "user.email", "kanban-test@example.com"]);
		writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
		writeFileSync(join(repoPath, "remove-me.txt"), "tracked\n", "utf8");
		runGit(repoPath, ["add", "."]);
		runGit(repoPath, ["commit", "-qm", "init"]);
		await run(repoPath);
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
		sandbox.cleanup();
		home.cleanup();
	}
}

async function ensureWorktree(repoPath: string, taskId: string): Promise<string> {
	const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId, baseRef: "HEAD" });
	if (!ensured.ok || !ensured.path) {
		throw new Error(`worktree for ${taskId} was not created: ${ensured.error ?? ""}`);
	}
	return ensured.path;
}

const BINARY_CONTENT = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 0, 128]);

describe("task work preservation acceptance (B-5.2/B-5.3/B-5.6)", () => {
	it("restores modified, deleted, hidden, untracked, and binary content exactly", async () => {
		await withRepo(async (repoPath) => {
			const taskId = "preserve-all-kinds";
			const worktree = await ensureWorktree(repoPath, taskId);
			writeFileSync(join(worktree, "README.md"), "hello, changed\n", "utf8");
			rmSync(join(worktree, "remove-me.txt"));
			mkdirSync(join(worktree, ".hidden"), { recursive: true });
			writeFileSync(join(worktree, ".hidden", "config"), "secret-ish\n", "utf8");
			mkdirSync(join(worktree, "nested", "dir"), { recursive: true });
			writeFileSync(join(worktree, "nested", "dir", "untracked.txt"), "untracked\n", "utf8");
			writeFileSync(join(worktree, "image.bin"), BINARY_CONTENT);

			const deleted = await deleteTaskWorktree({ repoPath, taskId });
			expect(deleted).toMatchObject({ ok: true, removed: true, preserved: true });
			expect(existsSync(worktree)).toBe(false);

			const restoredPath = await ensureWorktree(repoPath, taskId);
			expect(readFileSync(join(restoredPath, "README.md"), "utf8")).toBe("hello, changed\n");
			expect(existsSync(join(restoredPath, "remove-me.txt"))).toBe(false);
			expect(readFileSync(join(restoredPath, ".hidden", "config"), "utf8")).toBe("secret-ish\n");
			expect(readFileSync(join(restoredPath, "nested", "dir", "untracked.txt"), "utf8")).toBe("untracked\n");
			expect(readFileSync(join(restoredPath, "image.bin")).equals(BINARY_CONTENT)).toBe(true);
		});
	});

	it("keeps an unintegrated manual commit recoverable after cleanup (B-5.2/B-5.4)", async () => {
		await withRepo(async (repoPath) => {
			const taskId = "preserve-manual-commit";
			const worktree = await ensureWorktree(repoPath, taskId);
			writeFileSync(join(worktree, "feature.txt"), "committed work\n", "utf8");
			runGit(worktree, ["add", "feature.txt"]);
			runGit(worktree, ["commit", "-qm", "manual task commit"]);
			const manualCommit = runGit(worktree, ["rev-parse", "HEAD"]);
			// The worktree is clean: that must not be treated as "nothing to keep".
			expect(runGit(worktree, ["status", "--porcelain"])).toBe("");

			const deleted = await deleteTaskWorktree({ repoPath, taskId });
			expect(deleted.preserved).toBe(true);
			const record = await readTaskPreservationRecord(taskId);
			expect(record?.latestCommit).toBe(manualCommit);
			expect(runGit(repoPath, ["rev-parse", record?.refName ?? "missing-ref"])).toBe(manualCommit);

			// Restore uses the preserved revision, not the older base (B-5.6).
			const restoredPath = await ensureWorktree(repoPath, taskId);
			expect(runGit(restoredPath, ["rev-parse", "HEAD"])).toBe(manualCommit);
			expect(readFileSync(join(restoredPath, "feature.txt"), "utf8")).toBe("committed work\n");
		});
	});

	it("blocks cleanup and records why when the preservation write fails (B-5.3)", async () => {
		await withRepo(async (repoPath) => {
			const taskId = "preserve-write-fails";
			const worktree = await ensureWorktree(repoPath, taskId);
			writeFileSync(join(worktree, "work.txt"), "unsaved work\n", "utf8");
			// Make the archive write fail: a regular file where the archive must go.
			const preservationDir = getTaskPreservationDir(taskId);
			mkdirSync(preservationDir, { recursive: true });
			mkdirSync(join(preservationDir, "archive.tar.gz"), { recursive: true });
			writeFileSync(join(preservationDir, "archive.tar.gz", "occupied"), "x", "utf8");

			const deleted = await deleteTaskWorktree({ repoPath, taskId });

			expect(deleted.ok).toBe(false);
			expect(deleted.removed).toBe(false);
			expect(deleted.blockedReason).toMatch(/archive/i);
			// The work is untouched and the blocked reason is durable (B-5.9).
			expect(readFileSync(join(worktree, "work.txt"), "utf8")).toBe("unsaved work\n");
			expect((await readTaskPreservationRecord(taskId))?.cleanupBlockedReason).toMatch(/archive/i);
		});
	});
});
