// B-8: deterministic git delivery — end-to-end pipeline tests against real
// temporary git repositories (detached task worktree + bare remote). The model
// is not involved at all: commit messages fall back to the deterministic
// task-title form, which is exactly the property B-8 requires.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeGitDeliveryPolicy, RuntimeReviewHandoffArtifact } from "../../src/core/api-contract";
import {
	type GitDeliveryCommandResult,
	type GitDeliveryRunner,
	GitDeliveryService,
	readTaskDeliveryReceipt,
} from "../../src/workspace/git-delivery";
import { runGit } from "../../src/workspace/git-utils";
import { persistReviewHandoff } from "../../src/workspace/task-review-handoff";
import { createTempDir } from "../utilities/temp-dir";

interface DeliveryFixture {
	repoPath: string;
	remotePath: string;
	worktreePath: string;
	baseSha: string;
	cleanup: () => void;
}

/**
 * Creates: a bare remote, a repo with `origin` pointing at it and a base
 * commit pushed to main, and a detached task worktree at the base commit.
 * Redirects HOME so delivery receipts land in a temporary task-state home.
 */
async function createDeliveryFixture(): Promise<DeliveryFixture> {
	const home = createTempDir("kanban-git-delivery-home-");
	const repo = createTempDir("kanban-git-delivery-repo-");
	const remote = createTempDir("kanban-git-delivery-remote-");
	const worktree = createTempDir("kanban-git-delivery-worktree-");
	const cleanups = [home.cleanup, repo.cleanup, remote.cleanup, worktree.cleanup];
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home.path;
	process.env.USERPROFILE = home.path;

	const fixture: DeliveryFixture = {
		repoPath: repo.path,
		remotePath: remote.path,
		worktreePath: worktree.path,
		baseSha: "",
		cleanup: () => {
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
			for (const cleanup of cleanups) {
				cleanup();
			}
		},
	};

	const bare = await runGit(remote.path, ["init", "--bare", "-b", "main"]);
	const init = await runGit(repo.path, ["init", "-b", "main"]);
	expect(bare.ok).toBe(true);
	expect(init.ok).toBe(true);
	await runGit(repo.path, ["config", "user.email", "delivery@test.local"]);
	await runGit(repo.path, ["config", "user.name", "Delivery Test"]);
	await runGit(repo.path, ["remote", "add", "origin", remote.path]);

	await writeFile(join(repo.path, "base.txt"), "base\n", "utf8");
	await runGit(repo.path, ["add", "base.txt"]);
	await runGit(repo.path, ["commit", "-m", "base commit"]);
	await runGit(repo.path, ["push", "origin", "refs/heads/main:refs/heads/main"]);
	fixture.baseSha = (await runGit(repo.path, ["rev-parse", "HEAD"])).stdout;

	const worktreeAdd = await runGit(repo.path, ["worktree", "add", "--detach", worktree.path, "HEAD"]);
	expect(worktreeAdd.ok).toBe(true);
	return fixture;
}

/** Records the review handoff with the fixture's base commit as the starting revision. */
async function persistFixtureHandoff(fixture: DeliveryFixture, taskId: string): Promise<void> {
	const artifact: RuntimeReviewHandoffArtifact = {
		taskId,
		worktreePath: fixture.worktreePath,
		repoPath: fixture.repoPath,
		startingCommit: fixture.baseSha,
		latestCommit: fixture.baseSha,
		changedPaths: [],
		untrackedPaths: [],
		planDocuments: [],
		acceptanceCriteria: [],
		designDecisions: [],
		testsAttempted: [],
		knownLimitations: [],
		unresolvedQuestions: [],
		createdAt: Date.now(),
	};
	await persistReviewHandoff(artifact);
}

function deliveryPolicy(overrides: Partial<RuntimeGitDeliveryPolicy> = {}): RuntimeGitDeliveryPolicy {
	return {
		enabled: true,
		remote: "origin",
		destinationBranch: "feature/b8",
		pushRequired: true,
		protectedBranches: ["main"],
		integrationStrategy: "fast_forward",
		requirePullRequest: false,
		...overrides,
	};
}

describe("GitDeliveryService", () => {
	it("commits, fast-forwards, pushes, verifies, and persists a delivered receipt", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-1");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");

			const infoBefore = await new GitDeliveryService().getDeliveryInfo("task-1");
			expect(infoBefore.ok).toBe(true);
			expect(infoBefore.receipt).toBeNull();

			const service = new GitDeliveryService();
			const response = await service.startDelivery({
				taskId: "task-1",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});

			expect(response.ok).toBe(true);
			const receipt = response.receipt;
			expect(receipt).not.toBeNull();
			expect(receipt?.status).toBe("delivered");
			expect(receipt?.taskCommitSha).toMatch(/^[0-9a-f]{40}$/);
			// fast-forward integration: the destination lands exactly on the task commit
			expect(receipt?.integratedSha).toBe(receipt?.taskCommitSha);
			expect(receipt?.baseSha).toBe(fixture.baseSha);
			expect(receipt?.commitMessageSource).toBe("fallback");
			expect(receipt?.remoteBranchSha).toBe(receipt?.taskCommitSha);
			expect(receipt?.stagedPaths).toEqual(["task.txt"]);
			expect(receipt?.attempt).toBe(1);

			// local destination advanced onto the task commit
			const destSha = (await runGit(fixture.repoPath, ["rev-parse", "refs/heads/feature/b8"])).stdout;
			expect(destSha).toBe(receipt?.taskCommitSha);
			// the durable task ref anchors the commit
			const taskRefSha = (
				await runGit(fixture.worktreePath, ["rev-parse", "--verify", "refs/kanban/tasks/task-1/commit"])
			).stdout;
			expect(taskRefSha).toBe(receipt?.taskCommitSha);
			// the remote branch contains the delivered commit (verified ancestry)
			const remoteSha = (await runGit(fixture.remotePath, ["rev-parse", "refs/heads/feature/b8"])).stdout;
			expect(remoteSha).toBe(receipt?.taskCommitSha);
			// deterministic fallback commit message (no model involved)
			const log = await runGit(fixture.worktreePath, ["log", "-1", "--format=%s"]);
			expect(log.stdout).toBe("kanban task task-1");
			// the receipt is durably persisted and readable
			const persisted = await readTaskDeliveryReceipt("task-1");
			expect(persisted?.status).toBe("delivered");
			expect(persisted?.taskCommitSha).toBe(receipt?.taskCommitSha);
		} finally {
			fixture.cleanup();
		}
	});

	it("uses a model-supplied commit message when provided", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-msg");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");

			const response = await new GitDeliveryService().startDelivery({
				taskId: "task-msg",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
				commitMessage: "Add the thing\r\n\r\nBody line.",
			});

			expect(response.ok).toBe(true);
			expect(response.receipt?.commitMessageSource).toBe("model");
			const log = await runGit(fixture.worktreePath, ["log", "-1", "--format=%s"]);
			expect(log.stdout).toBe("Add the thing");
		} finally {
			fixture.cleanup();
		}
	});

	it("records an explicit no-op delivery when the worktree has no changes", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);

			const response = await new GitDeliveryService().startDelivery({
				taskId: "task-noop",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});

			expect(response.ok).toBe(true);
			expect(response.receipt?.status).toBe("no_op");
			expect(response.receipt?.taskCommitSha).toBeNull();
			expect(response.receipt?.evidence.some((entry) => entry.detail.includes("no-op"))).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});

	it("refuses to deliver directly onto a protected branch", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");

			const response = await new GitDeliveryService().startDelivery({
				taskId: "task-protected",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy({ destinationBranch: "main" }),
			});

			expect(response.ok).toBe(false);
			expect(response.receipt).toBeNull();
			expect(response.error).toContain("protected");
		} finally {
			fixture.cleanup();
		}
	});

	it("pauses with evidence when the destination is checked out with uncommitted changes", async () => {
		const fixture = await createDeliveryFixture();
		const destWorktree = createTempDir("kanban-git-delivery-dest-dirty-");
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-dirty");
			await runGit(fixture.repoPath, ["worktree", "add", destWorktree.path, "feature/b8"]);
			// leave the checked-out destination dirty
			await writeFile(join(destWorktree.path, "user-change.txt"), "user edit\n", "utf8");

			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");
			const response = await new GitDeliveryService().startDelivery({
				taskId: "task-dirty",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});

			expect(response.ok).toBe(false);
			expect(response.receipt?.status).toBe("paused");
			expect(response.error).toContain("uncommitted changes");
			// no stash was taken: the user file is still present and uncommitted
			const dirtyStatus = await runGit(destWorktree.path, ["status", "--porcelain"]);
			expect(dirtyStatus.stdout).toContain("user-change.txt");
		} finally {
			destWorktree.cleanup();
			fixture.cleanup();
		}
	});

	it("pauses with evidence when the destination advanced past the recorded base", async () => {
		const fixture = await createDeliveryFixture();
		const destWorktree = createTempDir("kanban-git-delivery-dest-");
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-diverge");
			// advance the destination branch past the recorded base
			await runGit(fixture.repoPath, ["worktree", "add", destWorktree.path, "feature/b8"]);
			await writeFile(join(destWorktree.path, "advance.txt"), "advance\n", "utf8");
			await runGit(destWorktree.path, ["add", "advance.txt"]);
			await runGit(destWorktree.path, ["commit", "-m", "advance destination"]);
			const advancedSha = (await runGit(destWorktree.path, ["rev-parse", "HEAD"])).stdout;

			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");
			const response = await new GitDeliveryService().startDelivery({
				taskId: "task-diverge",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});

			expect(response.ok).toBe(false);
			expect(response.receipt?.status).toBe("paused");
			expect(response.receipt?.stage).toBe("committed");
			expect(response.error).toContain("recorded base");
			// the task work is preserved (committed + durable ref), the destination is untouched
			expect(response.receipt?.taskCommitSha).toMatch(/^[0-9a-f]{40}$/);
			const destSha = (await runGit(fixture.repoPath, ["rev-parse", "refs/heads/feature/b8"])).stdout;
			expect(destSha).toBe(advancedSha);
		} finally {
			destWorktree.cleanup();
			fixture.cleanup();
		}
	});

	it("reconciles an ambiguous push failure when the remote already accepted the commit", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-flaky");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");

			// The runner executes the real push but reports a failure the first
			// time, simulating a timeout after the server accepted the ref update.
			let pushAttempts = 0;
			const flakyGit: GitDeliveryRunner = {
				run: async (cwd: string, args: string[]): Promise<GitDeliveryCommandResult> => {
					const result = await runGit(cwd, args);
					if (args[0] === "push" && pushAttempts === 0) {
						pushAttempts += 1;
						return {
							...result,
							ok: false,
							error: "simulated timeout after server acceptance",
							stderr: "simulated timeout",
							exitCode: -1,
						};
					}
					return result;
				},
			};
			const service = new GitDeliveryService({ git: flakyGit });
			const response = await service.startDelivery({
				taskId: "task-flaky",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});

			expect(response.ok).toBe(true);
			expect(response.receipt?.status).toBe("delivered");
			expect(pushAttempts).toBe(1); // no second push with a different commit
			expect(response.receipt?.evidence.some((entry) => entry.detail.includes("reconciled as pushed"))).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});

	it("fails (without force) when the remote rejects the push and lacks the commit", async () => {
		const fixture = await createDeliveryFixture();
		const scratch = createTempDir("kanban-git-delivery-scratch-");
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await runGit(fixture.repoPath, ["push", "origin", "refs/heads/feature/b8:refs/heads/feature/b8"]);
			// advance the remote branch through a separate clone so the local
			// destination is no longer a fast-forward source for the remote.
			await runGit(scratch.path, ["clone", fixture.remotePath, join(scratch.path, "scratch")]);
			const scratchRepo = join(scratch.path, "scratch");
			await runGit(scratchRepo, ["config", "user.email", "scratch@test.local"]);
			await runGit(scratchRepo, ["config", "user.name", "Scratch"]);
			await runGit(scratchRepo, ["checkout", "feature/b8"]);
			await writeFile(join(scratchRepo, "remote-advance.txt"), "remote advance\n", "utf8");
			await runGit(scratchRepo, ["add", "remote-advance.txt"]);
			await runGit(scratchRepo, ["commit", "-m", "remote advance"]);
			await runGit(scratchRepo, ["push", "origin", "refs/heads/feature/b8:refs/heads/feature/b8"]);

			await persistFixtureHandoff(fixture, "task-reject");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");
			const response = await new GitDeliveryService().startDelivery({
				taskId: "task-reject",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});

			expect(response.ok).toBe(false);
			expect(response.receipt?.status).toBe("failed");
			expect(response.receipt?.stage).toBe("integrated");
			expect(response.error).toContain("Push to");
			// the local commit and integration are preserved for a later retry
			expect(response.receipt?.taskCommitSha).toMatch(/^[0-9a-f]{40}$/);
			expect(response.receipt?.integratedSha).toBe(response.receipt?.taskCommitSha);
		} finally {
			scratch.cleanup();
			fixture.cleanup();
		}
	});

	it("creates an explicit merge commit for the merge strategy when the destination is not checked out", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-merge");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");

			const response = await new GitDeliveryService().startDelivery({
				taskId: "task-merge",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy({ integrationStrategy: "merge" }),
			});

			expect(response.ok).toBe(true);
			const receipt = response.receipt;
			expect(receipt?.status).toBe("delivered");
			// the merge commit is distinct from the task commit
			expect(receipt?.integratedSha).not.toBe(receipt?.taskCommitSha);
			// its parents are the destination base and the task commit
			const parents = (
				await runGit(fixture.repoPath, ["log", "-1", "--format=%P", receipt?.integratedSha ?? ""])
			).stdout.split(/\s+/);
			expect(parents).toEqual([fixture.baseSha, receipt?.taskCommitSha ?? ""]);
			// the remote carries the merge commit
			const remoteSha = (await runGit(fixture.remotePath, ["rev-parse", "refs/heads/feature/b8"])).stdout;
			expect(remoteSha).toBe(receipt?.integratedSha);
		} finally {
			fixture.cleanup();
		}
	});

	it("excludes secrets and generated logs from the delivery commit", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-exclude");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");
			await writeFile(join(fixture.worktreePath, ".env"), "SECRET=1\n", "utf8");
			await writeFile(join(fixture.worktreePath, "app.log"), "log line\n", "utf8");
			// node_modules file via a real nested write
			const nodeModulesDir = join(fixture.worktreePath, "node_modules");
			await mkdir(nodeModulesDir, { recursive: true });
			await writeFile(join(nodeModulesDir, "dep.js"), "module\n", "utf8");

			const response = await new GitDeliveryService().startDelivery({
				taskId: "task-exclude",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});

			expect(response.ok).toBe(true);
			expect(response.receipt?.status).toBe("delivered");
			expect(response.receipt?.stagedPaths).toEqual(["task.txt"]);
			expect(response.receipt?.excludedPaths).toContain(".env");
			expect(response.receipt?.excludedPaths).toContain("app.log");
			expect(response.receipt?.excludedPaths.some((path) => path.startsWith("node_modules"))).toBe(true);
			// the delivered tree contains only the task file (plus the base file)
			const lsTree = (await runGit(fixture.repoPath, ["ls-tree", "--name-only", "refs/heads/feature/b8"])).stdout;
			expect(lsTree).toContain("task.txt");
			expect(lsTree).not.toContain(".env");
		} finally {
			fixture.cleanup();
		}
	});

	it("reuses the existing commit and is idempotent when delivery is retried", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-retry");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");

			const service = new GitDeliveryService();
			const first = await service.startDelivery({
				taskId: "task-retry",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});
			expect(first.ok).toBe(true);
			expect(first.receipt?.status).toBe("delivered");

			// no new changes: the retry reuses the existing commit instead of
			// creating a new one (B-8.8 retry deduplication).
			const second = await service.startDelivery({
				taskId: "task-retry",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});
			expect(second.ok).toBe(true);
			expect(second.receipt?.status).toBe("delivered");
			expect(second.receipt?.taskCommitSha).toBe(first.receipt?.taskCommitSha);
			expect(second.receipt?.commitMessageSource).toBe("reused");
			expect(second.receipt?.attempt).toBe(2);
		} finally {
			fixture.cleanup();
		}
	});
});
