// B-8: deterministic git delivery — end-to-end pipeline tests against real
// temporary git repositories (detached task worktree + bare remote). The model
// is not involved at all: commit messages fall back to the deterministic
// task-title form, which is exactly the property B-8 requires.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeGitDeliveryPolicy, RuntimeReviewHandoffArtifact } from "../../src/core/api-contract";
import {
	evaluateDependentsUnlock,
	type GhCommandResult,
	type GitDeliveryCommandResult,
	type GitDeliveryRunner,
	GitDeliveryService,
	getTaskDeliveryCommitRefName,
	parseDeliveryChangeManifest,
	readTaskDeliveryReceipt,
} from "../../src/workspace/git-delivery";
import { runGit } from "../../src/workspace/git-utils";
import { getTaskPreservationRefName } from "../../src/workspace/task-preservation";
import {
	computeCandidateTreeHash,
	persistReviewHandoff,
	persistReviewOutcome,
	persistVerificationReceipt,
} from "../../src/workspace/task-review-handoff";
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
		pullRequestBaseBranch: null,
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

			const infoBefore = await new GitDeliveryService().getDeliveryInfo("task-1", deliveryPolicy());
			expect(infoBefore.ok).toBe(true);
			expect(infoBefore.receipt).toBeNull();
			// B-5.9: without a receipt, dependents stay locked in delivery mode.
			expect(infoBefore.dependentsUnlock.allowed).toBe(false);

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
				await runGit(fixture.worktreePath, ["rev-parse", "--verify", getTaskDeliveryCommitRefName("task-1")])
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
			const infoAfter = await service.getDeliveryInfo("task-1", deliveryPolicy());
			expect(infoAfter.dependentsUnlock).toEqual({ allowed: true, reason: null });
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

			// no new changes: the retry returns the stored receipt instead of
			// creating a new commit (B-8.8 retry deduplication).
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
			const remoteSha = (await runGit(fixture.remotePath, ["rev-parse", "refs/heads/feature/b8"])).stdout;
			expect(remoteSha).toBe(first.receipt?.taskCommitSha);
		} finally {
			fixture.cleanup();
		}
	});
	it("stages modified, renamed, deleted, and space-named paths", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-kinds");
			await writeFile(join(fixture.worktreePath, "base.txt"), "base changed\n", "utf8");
			await writeFile(join(fixture.worktreePath, "with space.txt"), "spaced\n", "utf8");
			await runGit(fixture.worktreePath, ["mv", "base.txt", "renamed.txt"]);

			const response = await new GitDeliveryService().startDelivery({
				taskId: "task-kinds",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});

			expect(response.error).toBeNull();
			expect(response.receipt?.status).toBe("delivered");
			expect(response.receipt?.stagedPaths).toEqual(["base.txt", "renamed.txt", "with space.txt"]);
			const lsTree = (await runGit(fixture.repoPath, ["ls-tree", "--name-only", "refs/heads/feature/b8"])).stdout;
			expect(lsTree.split("\n").sort()).toEqual(["renamed.txt", "with space.txt"]);
			const renamed = (await runGit(fixture.repoPath, ["show", "refs/heads/feature/b8:renamed.txt"])).stdout;
			expect(renamed).toBe("base changed");
		} finally {
			fixture.cleanup();
		}
	});

	it("parses porcelain v2 -z records by field position", () => {
		const output = [
			"1 .M N... 100644 100644 100644 aaa aaa src/a file.ts",
			"2 R. N... 100644 100644 100644 bbb bbb R100 new name.ts",
			"old name.ts",
			"u UU N... 100644 100644 100644 100644 ccc ddd eee conflict.ts",
			"? untracked dir/x.ts",
			"",
		].join("\0");
		expect(parseDeliveryChangeManifest(output)).toEqual([
			"conflict.ts",
			"new name.ts",
			"old name.ts",
			"src/a file.ts",
			"untracked dir/x.ts",
		]);
	});

	it("delivers alongside the B-5 preservation ref for the same task", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-preserved");
			// B-5 keeps refs/kanban/tasks/<id> updated while the worktree is alive.
			await runGit(fixture.repoPath, ["update-ref", getTaskPreservationRefName("task-preserved"), fixture.baseSha]);
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");

			const response = await new GitDeliveryService().startDelivery({
				taskId: "task-preserved",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});

			expect(response.error).toBeNull();
			expect(response.receipt?.status).toBe("delivered");
		} finally {
			fixture.cleanup();
		}
	});

	it("delivers commits the agent already made instead of recording a no-op", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-agent-commit");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");
			await runGit(fixture.worktreePath, ["add", "task.txt"]);
			await runGit(fixture.worktreePath, ["commit", "-m", "agent commit"]);
			const agentSha = (await runGit(fixture.worktreePath, ["rev-parse", "HEAD"])).stdout;

			const response = await new GitDeliveryService().startDelivery({
				taskId: "task-agent-commit",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});

			expect(response.receipt?.status).toBe("delivered");
			expect(response.receipt?.taskCommitSha).toBe(agentSha);
			expect(response.receipt?.commitMessageSource).toBe("reused");
			const remoteSha = (await runGit(fixture.remotePath, ["rev-parse", "refs/heads/feature/b8"])).stdout;
			expect(remoteSha).toBe(agentSha);
		} finally {
			fixture.cleanup();
		}
	});

	it("reuses the commit from a crashed attempt instead of recording a no-op or committing again", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-crash");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");

			// The first attempt commits, then dies before the durable ref is written.
			const crashingGit: GitDeliveryRunner = {
				run: async (cwd: string, args: string[]): Promise<GitDeliveryCommandResult> => {
					if (args[0] === "update-ref" && args[1] === getTaskDeliveryCommitRefName("task-crash")) {
						return { ok: false, stdout: "", stderr: "simulated crash", output: "", error: "crash", exitCode: 1 };
					}
					return await runGit(cwd, args);
				},
			};
			const first = await new GitDeliveryService({ git: crashingGit }).startDelivery({
				taskId: "task-crash",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});
			expect(first.receipt?.status).toBe("failed");
			const crashedCommit = first.receipt?.taskCommitSha;
			expect(crashedCommit).toMatch(/^[0-9a-f]{40}$/);

			const retry = await new GitDeliveryService().startDelivery({
				taskId: "task-crash",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});
			expect(retry.receipt?.status).toBe("delivered");
			expect(retry.receipt?.taskCommitSha).toBe(crashedCommit);
			const commitCount = (await runGit(fixture.repoPath, ["rev-list", "--count", "refs/heads/feature/b8"])).stdout;
			expect(commitCount).toBe("2");
		} finally {
			fixture.cleanup();
		}
	});

	it("keeps an excluded path out of the commit even when it was already staged", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-staged-secret");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");
			await writeFile(join(fixture.worktreePath, ".env"), "SECRET=1\n", "utf8");
			await runGit(fixture.worktreePath, ["add", ".env"]);

			const response = await new GitDeliveryService().startDelivery({
				taskId: "task-staged-secret",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy(),
			});

			expect(response.receipt?.status).toBe("delivered");
			const lsTree = (await runGit(fixture.repoPath, ["ls-tree", "--name-only", "refs/heads/feature/b8"])).stdout;
			expect(lsTree).not.toContain(".env");
		} finally {
			fixture.cleanup();
		}
	});

	it("resumes a merge-strategy delivery after a failed push without a second merge commit", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-merge-retry");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");

			const rejectingGit: GitDeliveryRunner = {
				run: async (cwd: string, args: string[]): Promise<GitDeliveryCommandResult> => {
					if (args[0] === "push") {
						return {
							ok: false,
							stdout: "",
							stderr: "network down",
							output: "",
							error: "push failed",
							exitCode: 1,
						};
					}
					return await runGit(cwd, args);
				},
			};
			const first = await new GitDeliveryService({ git: rejectingGit }).startDelivery({
				taskId: "task-merge-retry",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy({ integrationStrategy: "merge" }),
			});
			expect(first.receipt?.status).toBe("failed");
			const mergeSha = first.receipt?.integratedSha;

			const service = new GitDeliveryService();
			const retry = await service.startDelivery({
				taskId: "task-merge-retry",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy({ integrationStrategy: "merge" }),
			});
			expect(retry.receipt?.status).toBe("delivered");
			expect(retry.receipt?.integratedSha).toBe(mergeSha);

			// A no-change retry after success must not build another merge commit.
			const again = await service.startDelivery({
				taskId: "task-merge-retry",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy({ integrationStrategy: "merge" }),
			});
			expect(again.receipt?.status).toBe("delivered");
			const destSha = (await runGit(fixture.repoPath, ["rev-parse", "refs/heads/feature/b8"])).stdout;
			expect(destSha).toBe(mergeSha);
		} finally {
			fixture.cleanup();
		}
	});

	it("pauses when a required review is missing or bound to a different tree, and delivers once it matches", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-gated");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");
			const service = new GitDeliveryService();
			const gates = { reviewRequired: true, verificationRequired: false };
			const start = () =>
				service.startDelivery({
					taskId: "task-gated",
					workspaceId: "workspace-1",
					repoPath: fixture.repoPath,
					worktreePath: fixture.worktreePath,
					baseRef: "main",
					policy: deliveryPolicy(),
					gates,
				});

			const missing = await start();
			expect(missing.receipt?.status).toBe("paused");
			expect(missing.error).toContain("none was recorded");

			const reviewedHash = await computeCandidateTreeHash(fixture.worktreePath);
			const persistReady = async (candidateTreeHash: string | null) =>
				await persistReviewOutcome("task-gated", {
					status: "ready",
					result: {
						taskId: "task-gated",
						candidateTreeHash,
						reviewedAt: Date.now(),
						findings: [],
						blocking: false,
						fixesApplied: [],
						requirementsCovered: [],
						unresolvedItems: [],
					},
					error: null,
					sessionId: "review-session",
					warnings: [],
					verification: null,
					updatedAt: Date.now(),
				});

			await persistReady(reviewedHash);
			// An edit after the review invalidates it (B-6.7).
			await writeFile(join(fixture.worktreePath, "task.txt"), "edited after review\n", "utf8");
			const stale = await start();
			expect(stale.receipt?.status).toBe("paused");
			expect(stale.error).toContain("candidate tree mismatch");

			await persistReady(await computeCandidateTreeHash(fixture.worktreePath));
			const delivered = await start();
			expect(delivered.receipt?.status).toBe("delivered");
			expect(delivered.receipt?.candidateTreeHash).toMatch(/.+/);
		} finally {
			fixture.cleanup();
		}
	});

	it("deduplicates PRs with gh pr list and runs gh inside the repository", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-pr");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");
			const calls: Array<{ args: string[]; cwd: string }> = [];
			let listResult = "[]";
			const gh = async (args: string[], cwd: string): Promise<GhCommandResult> => {
				calls.push({ args, cwd });
				const stdout = args[1] === "list" ? listResult : "https://github.com/o/r/pull/42";
				return { ok: true, stdout, stderr: "", exitCode: 0, missingBinary: false };
			};
			const service = new GitDeliveryService({ gh });
			const created = await service.startDelivery({
				taskId: "task-pr",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy({ requirePullRequest: true }),
			});
			expect(created.receipt?.pr).toEqual({
				status: "created",
				number: 42,
				url: "https://github.com/o/r/pull/42",
				error: null,
			});
			expect(calls.every((call) => call.cwd === fixture.repoPath)).toBe(true);
			expect(calls[0]?.args.slice(0, 4)).toEqual(["pr", "list", "--head", "feature/b8"]);
			// null base: the forge default branch is used (no --base argument).
			expect(calls.some((call) => call.args.includes("--base"))).toBe(false);

			listResult = JSON.stringify([{ number: 42, url: "https://github.com/o/r/pull/42" }]);
			await writeFile(join(fixture.worktreePath, "task2.txt"), "more work\n", "utf8");
			const existing = await service.startDelivery({
				taskId: "task-pr",
				workspaceId: "workspace-1",
				repoPath: fixture.repoPath,
				worktreePath: fixture.worktreePath,
				baseRef: "main",
				policy: deliveryPolicy({ requirePullRequest: true, pullRequestBaseBranch: "main" }),
			});
			expect(existing.receipt?.pr?.status).toBe("existing");
			expect(calls.at(-1)?.args).toContain("--base");
			expect(calls.filter((call) => call.args[1] === "create")).toHaveLength(1);
		} finally {
			fixture.cleanup();
		}
	});
	it("unlocks dependents only on a completed receipt when delivery is enabled", () => {
		expect(evaluateDependentsUnlock(null, null)).toEqual({ allowed: true, reason: null });
		expect(evaluateDependentsUnlock(deliveryPolicy({ enabled: false }), null).allowed).toBe(true);
		const locked = evaluateDependentsUnlock(deliveryPolicy(), null);
		expect(locked.allowed).toBe(false);
		expect(locked.reason).toMatch(/not been delivered/);
	});
	it("accepts a standalone verification receipt bound to the tree when review is off", async () => {
		const fixture = await createDeliveryFixture();
		try {
			await runGit(fixture.repoPath, ["branch", "feature/b8", fixture.baseSha]);
			await persistFixtureHandoff(fixture, "task-verify-only");
			await writeFile(join(fixture.worktreePath, "task.txt"), "task work\n", "utf8");
			const service = new GitDeliveryService();
			const start = () =>
				service.startDelivery({
					taskId: "task-verify-only",
					workspaceId: "workspace-1",
					repoPath: fixture.repoPath,
					worktreePath: fixture.worktreePath,
					baseRef: "main",
					policy: deliveryPolicy(),
					gates: { reviewRequired: false, verificationRequired: true },
				});

			const unverified = await start();
			expect(unverified.receipt?.status).toBe("paused");

			const treeHash = await computeCandidateTreeHash(fixture.worktreePath);
			await persistVerificationReceipt("task-verify-only", {
				treeHashBefore: treeHash,
				treeHashAfter: treeHash,
				treeIdentityPreserved: true,
				matchesCandidate: true,
				checks: [],
				passed: true,
				error: null,
				startedAt: 1,
				finishedAt: 2,
			});
			const verified = await start();
			expect(verified.receipt?.status).toBe("delivered");
		} finally {
			fixture.cleanup();
		}
	});
});
