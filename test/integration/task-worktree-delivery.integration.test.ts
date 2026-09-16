// B-1.5 — Deterministic incorrect-completion / worktree-cleanup reproductions.
//
// Baseline: abd4912 (Kanban 0.1.70). Task worktrees are created detached
// (src/workspace/task-worktree.ts: `worktree add --detach`) and
// deleteTaskWorktree only captures UNCOMMITTED work (`git diff HEAD` plus
// untracked files, src/workspace/task-worktree.ts captureTaskPatch). Work the
// agent committed on the detached HEAD therefore has no ref and no patch
// after the worktree is removed.
//
// Tests marked "[B-1 repro]" assert the DESIRED behavior (work is preserved /
// integrated) and FAIL on the baseline. They are skipped on the baseline
// (it.skip) so the suite stays green; REMOVE the skip when B-4/B-5/B-8 make
// the tests pass. See the evidence report in docs/plans/B-1.md.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getGitSyncSummary, runGitSyncAction } from "../../src/workspace/git-sync";
import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(
			[`git ${args.join(" ")} failed in ${cwd}`, result.stdout.trim(), result.stderr.trim()]
				.filter((part) => part.length > 0)
				.join("\n"),
		);
	}
	return result.stdout.trim();
}

/** Run git without throwing; returns null on failure (for negative probes). */
function tryRunGit(cwd: string, args: string[]): string | null {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		return null;
	}
	return result.stdout.trim();
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

interface DeliveryFixture {
	sandboxRoot: string;
	repoPath: string;
	originPath: string;
	ensureWorktree: (taskId: string) => Promise<string>;
	cleanup: () => void;
}

/**
 * Bare origin + main checkout with one committed file, mirroring the
 * deployment layout (task worktrees detach from the base branch).
 */
async function createDeliveryFixture(prefix: string): Promise<DeliveryFixture> {
	const { path: sandboxRoot, cleanup } = createTempDir(prefix);
	const repoPath = join(sandboxRoot, "repo");
	const originPath = join(sandboxRoot, "origin.git");
	mkdirSync(repoPath, { recursive: true });

	runGit(sandboxRoot, ["init", "--bare", "origin.git"]);
	runGit(repoPath, ["init"]);
	runGit(repoPath, ["config", "user.name", "Kanban Test"]);
	runGit(repoPath, ["config", "user.email", "kanban-test@example.com"]);
	writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
	runGit(repoPath, ["add", "README.md"]);
	runGit(repoPath, ["commit", "-m", "init"]);
	runGit(repoPath, ["branch", "-M", "main"]);
	runGit(repoPath, ["remote", "add", "origin", originPath]);
	runGit(repoPath, ["push", "-u", "origin", "main"]);

	const ensureWorktree = async (taskId: string): Promise<string> => {
		const ensured = await ensureTaskWorktreeIfDoesntExist({
			cwd: repoPath,
			taskId,
			baseRef: "main",
		});
		if (!ensured.ok || !ensured.path) {
			throw new Error(`Worktree creation failed: ${ensured.error ?? "unknown"}`);
		}
		return ensured.path;
	};

	return {
		sandboxRoot,
		repoPath,
		originPath,
		ensureWorktree,
		cleanup,
	};
}

function trashedPatchesDir(): string {
	return join(process.env.HOME ?? "", ".cline", "kanban", "trashed-task-patches");
}

function taskPatchFiles(taskId: string): string[] {
	try {
		const prefix = `${taskId}.`;
		return readdirSync(trashedPatchesDir())
			.filter((name) => name.startsWith(prefix) && name.endsWith(".patch"))
			.map((name) => join(trashedPatchesDir(), name));
	} catch {
		return [];
	}
}

/** Simulate an agent that committed its work inside the detached worktree. */
function commitWorkInWorktree(worktreePath: string, file: string, content: string): string {
	writeFileSync(join(worktreePath, file), content, "utf8");
	runGit(worktreePath, ["config", "user.name", "Agent"]);
	runGit(worktreePath, ["config", "user.email", "agent@test.com"]);
	runGit(worktreePath, ["add", file]);
	runGit(worktreePath, ["commit", "-m", `task work: ${file}`]);
	return runGit(worktreePath, ["rev-parse", "HEAD"]);
}
describe.sequential("task worktree delivery and cleanup (B-1.5)", () => {
	it.skip("[B-1 repro] committed task work survives worktree deletion (clean-but-unintegrated work)", async () => {
		await withTemporaryHome(async () => {
			const fixture = await createDeliveryFixture("kanban-delivery-committed-");
			try {
				const taskId = `task-delivery-committed-${Date.now()}`;
				const worktreePath = await fixture.ensureWorktree(taskId);
				const committed = commitWorkInWorktree(worktreePath, "delivered.txt", "committed work\n");

				const deleted = await deleteTaskWorktree({
					repoPath: fixture.repoPath,
					taskId,
				});
				expect(deleted.ok).toBe(true);
				expect(deleted.removed).toBe(true);
				expect(existsSync(worktreePath)).toBe(false);

				// Desired: the committed work is preserved somewhere the
				// product can restore it — either a trashed-task patch that
				// covers committed changes, or a ref that still points at the
				// commit.
				const patches = taskPatchFiles(taskId);
				const patchContent = patches.map((patch) => readFileSync(patch, "utf8")).join("");
				const pointedAtByRef =
					(tryRunGit(fixture.repoPath, ["for-each-ref", "--points-at", committed]) ?? "").trim().length > 0;
				expect(patchContent.length > 0 || pointedAtByRef).toBe(true);
				expect(patchContent).toContain("delivered.txt");
			} finally {
				fixture.cleanup();
			}
		});
	});

	it.skip("[B-1 repro] pushing from the task worktree integrates committed work into the base branch", async () => {
		await withTemporaryHome(async () => {
			const fixture = await createDeliveryFixture("kanban-delivery-push-");
			try {
				const taskId = `task-delivery-push-${Date.now()}`;
				const worktreePath = await fixture.ensureWorktree(taskId);
				commitWorkInWorktree(worktreePath, "pushed.txt", "work that must land on main\n");

				const result = await runGitSyncAction({
					cwd: worktreePath,
					action: "push",
				});

				// Desired: the push succeeds and origin/main contains the work.
				expect(result.ok).toBe(true);
				const originFiles = tryRunGit(fixture.originPath, ["ls-tree", "--name-only", "main"]) ?? "";
				expect(originFiles).toContain("pushed.txt");
			} finally {
				fixture.cleanup();
			}
		});
	});

	it("characterization: a clean worktree with un-integrated commits reports zero changed files", async () => {
		await withTemporaryHome(async () => {
			const fixture = await createDeliveryFixture("kanban-delivery-clean-");
			try {
				const taskId = `task-delivery-clean-${Date.now()}`;
				const worktreePath = await fixture.ensureWorktree(taskId);
				commitWorkInWorktree(worktreePath, "clean.txt", "ahead but clean\n");

				const summary = await getGitSyncSummary(worktreePath);
				const aheadCount = tryRunGit(worktreePath, ["rev-list", "--count", "main..HEAD"]);

				// This is the exact signal the review auto-completion
				// heuristic consumes (web-ui/src/hooks/use-review-auto-actions.ts):
				// zero changed files is read as "commit succeeded", even though
				// the work is only a commit on a detached HEAD that nothing
				// has integrated.
				expect(summary.changedFiles).toBe(0);
				expect(aheadCount).toBe("1");
			} finally {
				fixture.cleanup();
			}
		});
	});

	it("characterization: uncommitted work survives a service interruption and is patch-captured on deletion", async () => {
		await withTemporaryHome(async () => {
			const fixture = await createDeliveryFixture("kanban-delivery-interrupted-");
			try {
				const taskId = `task-delivery-interrupted-${Date.now()}`;
				const worktreePath = await fixture.ensureWorktree(taskId);
				writeFileSync(join(worktreePath, "interrupted.txt"), "uncommitted work\n", "utf8");

				// A killed Kanban process performs no deletion: the worktree
				// (and its uncommitted work) simply remains on disk.
				expect(readFileSync(join(worktreePath, "interrupted.txt"), "utf8")).toBe("uncommitted work\n");

				const deleted = await deleteTaskWorktree({
					repoPath: fixture.repoPath,
					taskId,
				});
				expect(deleted.ok).toBe(true);
				expect(deleted.removed).toBe(true);

				// The uncommitted work is saved as a trashed-task patch.
				const patches = taskPatchFiles(taskId);
				expect(patches.length).toBe(1);
				expect(readFileSync(patches[0] as string, "utf8")).toContain("uncommitted work");
			} finally {
				fixture.cleanup();
			}
		});
	});
});
