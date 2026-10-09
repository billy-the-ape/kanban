// UPD-0 — real local-Git coverage for the start-owned base-ref refresh
// preparation: temporary repo, local bare origin, and a second clone that
// advances the remote base branch. Covers the acceptance rows for refreshed
// and blocked starts, prepared-baseline restore, recovery with an unavailable
// base, the generic-ensure refusal, and retry after a fetch fault.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { type LockRequest, lockedFileSystem } from "../../src/fs/locked-file-system";
import { getTaskInitialStartEvidence, readTaskInitialStartRecord } from "../../src/workspace/task-initial-start";
import { resetUnstartedQueuedWorktree } from "../../src/workspace/task-queued-reset";
import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskBaseRefreshLock,
	getTaskWorktreePath,
	getTaskWorktreeSetupLock,
	prepareInitialTaskWorktree,
} from "../../src/workspace/task-worktree";
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

interface BaseRefreshFixture {
	sandboxRoot: string;
	workspacePath: string;
	originPath: string;
	baseRef: string;
	localBaseSha: string;
	remoteBaseSha: string;
}

/**
 * Workspace clone tracking a local bare origin. A second ("advancer") clone
 * pushes one extra commit to the base branch so the remote is ahead of the
 * workspace's local branch.
 */
function createBaseRefreshFixture(sandboxRoot: string, baseRef = "feat/task"): BaseRefreshFixture {
	const originPath = join(sandboxRoot, "origin.git");
	const workspacePath = join(sandboxRoot, "workspace");
	mkdirSync(originPath, { recursive: true });
	runGit(originPath, ["init", "--bare"]);

	mkdirSync(workspacePath, { recursive: true });
	runGit(workspacePath, ["init"]);
	runGit(workspacePath, ["config", "user.name", "Kanban Test"]);
	runGit(workspacePath, ["config", "user.email", "kanban-test@example.com"]);
	writeFileSync(join(workspacePath, "README.md"), "hello\n", "utf8");
	runGit(workspacePath, ["add", "README.md"]);
	runGit(workspacePath, ["commit", "-m", "init"]);
	runGit(workspacePath, ["branch", "-M", "main"]);
	runGit(workspacePath, ["remote", "add", "origin", originPath]);
	runGit(workspacePath, ["push", "-u", "origin", "main"]);

	runGit(workspacePath, ["checkout", "-b", baseRef]);
	runGit(workspacePath, ["push", "-u", "origin", baseRef]);
	const localBaseSha = runGit(workspacePath, ["rev-parse", "HEAD"]);

	const advancerPath = join(sandboxRoot, "advancer");
	runGit(sandboxRoot, ["clone", "-q", "-b", baseRef, originPath, "advancer"]);
	runGit(advancerPath, ["config", "user.name", "Advancer"]);
	runGit(advancerPath, ["config", "user.email", "advancer@example.com"]);
	writeFileSync(join(advancerPath, "advanced.txt"), "advanced\n", "utf8");
	runGit(advancerPath, ["add", "advanced.txt"]);
	runGit(advancerPath, ["commit", "-m", "advance remote base"]);
	runGit(advancerPath, ["push", "-q", "origin", baseRef]);
	const remoteBaseSha = runGit(advancerPath, ["rev-parse", "HEAD"]);

	return {
		sandboxRoot,
		workspacePath,
		originPath,
		baseRef,
		localBaseSha,
		remoteBaseSha,
	};
}

/**
 * Acquire a lock and hold it until the returned release function is called.
 * Resolves only after the lock is actually acquired (the operation entered),
 * so callers can order acquisitions deterministically. The returned function
 * resolves once the lock is fully released (and rejects if the release fails).
 */
async function acquireHeldLock(request: LockRequest): Promise<() => Promise<void>> {
	const state: { releaseOperation: (() => void) | null; held: Promise<void> | null } = {
		releaseOperation: null,
		held: null,
	};
	await new Promise<void>((resolveEntered) => {
		const held = lockedFileSystem.withLock(request, () => {
			// The operation only runs once the lock is acquired.
			resolveEntered();
			return new Promise<void>((resolveOperation) => {
				state.releaseOperation = resolveOperation;
			});
		});
		state.held = held;
		// Avoid an unhandled rejection while we deliberately hold the lock.
		held.catch(() => {});
	});
	const releaseOperation = state.releaseOperation;
	const held = state.held;
	if (!releaseOperation || !held) {
		throw new Error("Expected the lock to be acquired.");
	}
	return () => {
		releaseOperation();
		return held;
	};
}

describe.sequential("task base refresh integration (UPD-0)", () => {
	it("withdraws a clean queued preparation and fetches a newer base on the next start", async () => {
		await withTemporaryHome(async () => {
			const { path: sandbox, cleanup } = createTempDir("kanban-queued-reset-");
			try {
				const fixture = createBaseRefreshFixture(sandbox);
				const taskId = randomUUID();
				const start = () =>
					prepareInitialTaskWorktree({
						cwd: fixture.workspacePath,
						taskId,
						baseRef: fixture.baseRef,
						updateBaseRefBeforeStart: true,
					});
				expect((await start()).baseCommit).toBe(fixture.remoteBaseSha);
				await resetUnstartedQueuedWorktree({ repoPath: fixture.workspacePath, taskId, withdraw: async () => true });
				expect(existsSync(getTaskWorktreePath(fixture.workspacePath, taskId))).toBe(false);
				expect(await getTaskInitialStartEvidence(taskId)).toMatchObject({
					preparedBaselineSha: null,
					hasPreservationRecord: false,
				});
				const advancer = join(sandbox, "advancer");
				writeFileSync(join(advancer, "newer.txt"), "newer");
				runGit(advancer, ["add", "."]);
				runGit(advancer, ["commit", "-m", "advance again"]);
				runGit(advancer, ["push", "origin", fixture.baseRef]);
				expect((await start()).baseCommit).toBe(runGit(advancer, ["rev-parse", "HEAD"]));
			} finally {
				cleanup();
			}
		});
	});

	it.each(["tracked", "untracked", "ignored", "commit", "admitted"])(
		"rejects queued reset with %s work or a lost admission race",
		async (kind) => {
			await withTemporaryHome(async () => {
				const { path: sandbox, cleanup } = createTempDir("kanban-queued-reset-reject-");
				try {
					const fixture = createBaseRefreshFixture(sandbox);
					const taskId = randomUUID();
					await prepareInitialTaskWorktree({
						cwd: fixture.workspacePath,
						taskId,
						baseRef: fixture.baseRef,
						updateBaseRefBeforeStart: true,
					});
					const worktree = getTaskWorktreePath(fixture.workspacePath, taskId);
					if (kind === "tracked") writeFileSync(join(worktree, "README.md"), "manual edit");
					if (kind === "untracked") writeFileSync(join(worktree, "manual.txt"), "manual work");
					if (kind === "ignored") {
						const exclude = runGit(worktree, ["rev-parse", "--git-path", "info/exclude"]);
						writeFileSync(exclude, "\nmanual.log\n", { flag: "a" });
						writeFileSync(join(worktree, "manual.log"), "ignored work");
					}
					if (kind === "commit") {
						writeFileSync(join(worktree, "new.txt"), "commit work");
						runGit(worktree, ["add", "."]);
						runGit(worktree, ["commit", "-m", "manual work"]);
					}
					let withdrew = false;
					await expect(
						resetUnstartedQueuedWorktree({
							repoPath: fixture.workspacePath,
							taskId,
							withdraw: async () => {
								withdrew = true;
								return false;
							},
						}),
					).rejects.toThrow();
					expect(withdrew).toBe(kind === "admitted");
					expect(existsSync(worktree)).toBe(true);
					expect((await readTaskInitialStartRecord(taskId))?.baselineSha).toBe(fixture.remoteBaseSha);
				} finally {
					cleanup();
				}
			});
		},
	);

	it("refreshes a stale base and creates the worktree at the post-refresh SHA", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-refreshed-");
			try {
				const fixture = createBaseRefreshFixture(sandboxRoot);
				const taskId = "task-refreshed";

				const prepared = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: true,
				});

				expect(prepared.ok, JSON.stringify(prepared, null, 2)).toBe(true);
				if (!prepared.ok || !prepared.path) {
					throw new Error("Preparation did not create the worktree");
				}
				// Worktree lands at the new origin SHA; the local base branch
				// fast-forwarded to it.
				expect(runGit(prepared.path, ["rev-parse", "HEAD"])).toBe(fixture.remoteBaseSha);
				expect(runGit(fixture.workspacePath, ["rev-parse", `refs/heads/${fixture.baseRef}`])).toBe(
					fixture.remoteBaseSha,
				);
				// The durable record fixes the resolved baseline.
				const evidence = await getTaskInitialStartEvidence(taskId);
				expect(evidence.preparedBaselineSha).toBe(fixture.remoteBaseSha);
				expect(prepared.initialStart.stage).toBe("ready");
				expect(prepared.initialStart.refreshed).toBe(true);
			} finally {
				cleanup();
			}
		});
	});

	it("honors explicit false: no refresh, worktree at the existing local SHA", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-disabled-");
			try {
				const fixture = createBaseRefreshFixture(sandboxRoot);
				const taskId = "task-disabled";

				const prepared = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: false,
				});

				expect(prepared.ok, JSON.stringify(prepared, null, 2)).toBe(true);
				if (!prepared.ok || !prepared.path) {
					throw new Error("Preparation did not create the worktree");
				}
				// No fetch, no ref update: the stale local tip is authoritative.
				expect(runGit(prepared.path, ["rev-parse", "HEAD"])).toBe(fixture.localBaseSha);
				expect(runGit(fixture.workspacePath, ["rev-parse", `refs/heads/${fixture.baseRef}`])).toBe(
					fixture.localBaseSha,
				);
				expect(prepared.initialStart.stage).toBe("ready");
				expect(prepared.initialStart.refreshed).toBe(false);
				const evidence = await getTaskInitialStartEvidence(taskId);
				expect(evidence.preparedBaselineSha).toBe(fixture.localBaseSha);
			} finally {
				cleanup();
			}
		});
	});

	it("restores the prepared baseline when the worktree is missing, never re-resolving", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-baseline-restore-");
			try {
				const fixture = createBaseRefreshFixture(sandboxRoot);
				const taskId = "task-baseline-restore";

				const prepared = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: true,
				});
				expect(prepared.ok, JSON.stringify(prepared, null, 2)).toBe(true);
				if (!prepared.ok || !prepared.path) {
					throw new Error("Preparation did not create the worktree");
				}
				const baselineSha = prepared.baseCommit;
				expect(baselineSha).toBe(fixture.remoteBaseSha);

				// Remove the worktree without preserving it, then advance the
				// remote base again.
				runGit(fixture.workspacePath, ["worktree", "remove", prepared.path]);
				runGit(fixture.workspacePath, ["worktree", "prune"]);
				runGit(join(sandboxRoot, "advancer"), ["commit", "--allow-empty", "-m", "advance again"]);
				runGit(join(sandboxRoot, "advancer"), ["push", "-q", "origin", fixture.baseRef]);
				const newerRemoteSha = runGit(join(sandboxRoot, "advancer"), ["rev-parse", "HEAD"]);
				expect(newerRemoteSha).not.toBe(baselineSha);

				const restored = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: true,
				});

				// The recorded baseline is authoritative: no re-resolution to
				// the newer remote state.
				expect(restored.ok, JSON.stringify(restored, null, 2)).toBe(true);
				if (!restored.ok || !restored.path) {
					throw new Error("Preparation did not restore the worktree");
				}
				expect(runGit(restored.path, ["rev-parse", "HEAD"])).toBe(baselineSha);
				expect(restored.initialStart.refreshed).toBe(false);
			} finally {
				cleanup();
			}
		});
	});

	it("blocks a dirty checked-out base with the remedy and leaves files intact", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-dirty-");
			try {
				const fixture = createBaseRefreshFixture(sandboxRoot);
				const taskId = "task-dirty";
				const stagedFile = join(fixture.workspacePath, "staged.txt");
				writeFileSync(stagedFile, "staged\n", "utf8");
				runGit(fixture.workspacePath, ["add", "staged.txt"]);

				const prepared = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: true,
				});

				expect(prepared.ok).toBe(false);
				expect(prepared.initialStart.stage).toBe("blocked");
				expect(prepared.initialStart.failure?.category).toBe("dirty_checkout");
				expect(prepared.initialStart.failure?.selectedRef).toBe(fixture.baseRef);
				// Files and the local base are untouched.
				expect(existsSync(stagedFile)).toBe(true);
				expect(runGit(fixture.workspacePath, ["rev-parse", `refs/heads/${fixture.baseRef}`])).toBe(
					fixture.localBaseSha,
				);
				const evidence = await getTaskInitialStartEvidence(taskId);
				expect(evidence.preparedBaselineSha).toBeNull();
			} finally {
				cleanup();
			}
		});
	});

	it("reports the selected ref (not the normalized branch) on a local-phase failure", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-selectedref-");
			try {
				const fixture = createBaseRefreshFixture(sandboxRoot);
				const taskId = "task-selectedref";
				// Dirty the checkout so the refresh fails in the LOCAL phase
				// (the network fetch succeeds first).
				const stagedFile = join(fixture.workspacePath, "staged.txt");
				writeFileSync(stagedFile, "staged\n", "utf8");
				runGit(fixture.workspacePath, ["add", "staged.txt"]);

				// Select the base with a refs/heads/ prefix: the network phase
				// normalizes it to the branch, but a local-phase failure must
				// report the ref the user actually selected.
				const prepared = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: `refs/heads/${fixture.baseRef}`,
					updateBaseRefBeforeStart: true,
				});

				expect(prepared.ok).toBe(false);
				expect(prepared.initialStart.stage).toBe("blocked");
				expect(prepared.initialStart.failure?.category).toBe("dirty_checkout");
				expect(prepared.initialStart.failure?.selectedRef).toBe(`refs/heads/${fixture.baseRef}`);
			} finally {
				cleanup();
			}
		});
	});

	it("blocks a local base that is ahead of origin without a stale fallback", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-ahead-");
			try {
				const fixture = createBaseRefreshFixture(sandboxRoot);
				// Local base gains a commit the remote does not have.
				writeFileSync(join(fixture.workspacePath, "local-only.txt"), "local\n", "utf8");
				runGit(fixture.workspacePath, ["add", "local-only.txt"]);
				runGit(fixture.workspacePath, ["commit", "-m", "local ahead commit"]);
				const taskId = "task-ahead";

				const prepared = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: true,
				});

				expect(prepared.ok).toBe(false);
				expect(prepared.initialStart.stage).toBe("blocked");
				expect(prepared.initialStart.failure?.category).toBe("local_ahead_or_diverged");
				// No stale fallback: the local commit survives.
				expect(runGit(fixture.workspacePath, ["log", "-1", "--format=%s", `refs/heads/${fixture.baseRef}`])).toBe(
					"local ahead commit",
				);
			} finally {
				cleanup();
			}
		});
	});

	it("blocks a repository without an origin remote", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-no-origin-");
			try {
				const workspacePath = join(sandboxRoot, "workspace");
				mkdirSync(workspacePath, { recursive: true });
				runGit(workspacePath, ["init"]);
				runGit(workspacePath, ["config", "user.name", "Kanban Test"]);
				runGit(workspacePath, ["config", "user.email", "kanban-test@example.com"]);
				writeFileSync(join(workspacePath, "README.md"), "hello\n", "utf8");
				runGit(workspacePath, ["add", "README.md"]);
				runGit(workspacePath, ["commit", "-m", "init"]);
				runGit(workspacePath, ["branch", "-M", "main"]);
				const taskId = "task-no-origin";

				const prepared = await prepareInitialTaskWorktree({
					cwd: workspacePath,
					taskId,
					baseRef: "main",
					updateBaseRefBeforeStart: true,
				});

				expect(prepared.ok).toBe(false);
				expect(prepared.initialStart.stage).toBe("blocked");
				expect(prepared.initialStart.failure?.category).toBe("missing_origin");
			} finally {
				cleanup();
			}
		});
	});
	it("recovers preserved work when the base ref is deleted locally and on origin", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-recovery-");
			try {
				const fixture = createBaseRefreshFixture(sandboxRoot);
				const taskId = `task-recovery-${Date.now()}`;

				const prepared = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: true,
				});
				expect(prepared.ok, JSON.stringify(prepared, null, 2)).toBe(true);
				if (!prepared.ok || !prepared.path) {
					throw new Error("Preparation did not create the worktree");
				}
				const createdCommit = runGit(prepared.path, ["rev-parse", "HEAD"]);
				writeFileSync(join(prepared.path, "work.txt"), "preserved work\n", "utf8");

				const deleted = await deleteTaskWorktree({
					repoPath: fixture.workspacePath,
					taskId,
				});
				expect(deleted.ok).toBe(true);

				// The agent worked in the worktree; the primary checkout sits
				// on main. Delete the base branch everywhere: recovery must
				// not resolve it.
				runGit(fixture.workspacePath, ["checkout", "main"]);
				runGit(fixture.workspacePath, ["branch", "-D", fixture.baseRef]);
				runGit(fixture.originPath, ["branch", "-D", fixture.baseRef]);

				const restored = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: true,
				});

				expect(restored.ok, JSON.stringify(restored, null, 2)).toBe(true);
				if (!restored.ok || !restored.path) {
					throw new Error("Recovery did not restore the worktree");
				}
				expect(runGit(restored.path, ["rev-parse", "HEAD"])).toBe(createdCommit);
				expect(readFileSync(join(restored.path, "work.txt"), "utf8")).toBe("preserved work\n");
			} finally {
				cleanup();
			}
		});
	});

	it("refuses the generic ensure for a fresh task; only start-owned preparation creates", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-ensure-refusal-");
			try {
				const fixture = createBaseRefreshFixture(sandboxRoot);
				const taskId = "task-ensure-refusal";

				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
				});

				expect(ensured.ok).toBe(false);
				if (ensured.ok) {
					throw new Error("Expected the generic ensure to be refused");
				}
				expect(ensured.category).toBe("initial_start_preparation_required");
				expect(ensured.path).toBeNull();
				expect(ensured.error).toContain("created when the task starts");

				// The worktree exists only after the start-owned preparation, at
				// the post-refresh SHA.
				const prepared = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: true,
				});
				expect(prepared.ok, JSON.stringify(prepared, null, 2)).toBe(true);
				if (!prepared.ok || !prepared.path) {
					throw new Error("Preparation did not create the worktree");
				}
				expect(runGit(prepared.path, ["rev-parse", "HEAD"])).toBe(fixture.remoteBaseSha);
			} finally {
				cleanup();
			}
		});
	});

	it("lets a blocked preparation retry with a second fetch after the fault is fixed", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-retry-");
			try {
				const fixture = createBaseRefreshFixture(sandboxRoot);
				const taskId = "task-retry";
				// Point origin at a path that does not exist (fetch fails).
				runGit(fixture.workspacePath, ["remote", "set-url", "origin", join(sandboxRoot, "missing-origin.git")]);

				const blocked = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: true,
				});
				expect(blocked.ok).toBe(false);
				expect(blocked.initialStart.stage).toBe("blocked");
				expect(blocked.initialStart.failure?.category).toBe("auth_or_network_timeout");
				const evidence = await getTaskInitialStartEvidence(taskId);
				expect(evidence.preparedBaselineSha).toBeNull();

				// Restore the origin and retry: preparation had not succeeded,
				// so a second fetch is allowed.
				runGit(fixture.workspacePath, ["remote", "set-url", "origin", fixture.originPath]);
				const prepared = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: true,
				});
				expect(prepared.ok, JSON.stringify(prepared, null, 2)).toBe(true);
				if (!prepared.ok || !prepared.path) {
					throw new Error("Preparation did not create the worktree on retry");
				}
				expect(runGit(prepared.path, ["rev-parse", "HEAD"])).toBe(fixture.remoteBaseSha);
			} finally {
				cleanup();
			}
		});
	});

	it(
		"queues concurrent refreshes on the per-repo refresh lock while the setup lock stays available",
		{
			timeout: 45_000,
		},
		async () => {
			await withTemporaryHome(async () => {
				const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-concurrency-");
				try {
					const fixture = createBaseRefreshFixture(sandboxRoot);
					// An existing worktree: its ensure only takes the setup lock.
					const existing = await prepareInitialTaskWorktree({
						cwd: fixture.workspacePath,
						taskId: "task-existing",
						baseRef: fixture.baseRef,
						updateBaseRefBeforeStart: true,
					});
					expect(existing.ok).toBe(true);

					// Simulate a slow origin: another process holds the per-repo
					// base refresh lock (a foreign lockfile) for longer than the
					// setup lock's default retry budget (~5s).
					const gitDir = runGit(fixture.workspacePath, ["rev-parse", "--absolute-git-dir"]);
					const refreshLockDir = join(gitDir, "kanban-task-base-refresh.lock");
					mkdirSync(refreshLockDir, { recursive: true });
					writeFileSync(
						join(refreshLockDir, "cipher"),
						JSON.stringify({ pid: process.pid, uuid: randomUUID(), stale: 10_000 }),
					);
					const releaseHolder = () => rmSync(refreshLockDir, { recursive: true, force: true });
					const holder = new Promise<void>((resolve) => setTimeout(resolve, 6500)).then(() => {
						releaseHolder();
					});

					const ensureTask = (async () => {
						const startedAt = Date.now();
						const ensured = await ensureTaskWorktreeIfDoesntExist({
							cwd: fixture.workspacePath,
							taskId: "task-existing",
							baseRef: fixture.baseRef,
						});
						return { ensured, elapsedMs: Date.now() - startedAt };
					})();
					const [ensureResult, preparedA, preparedB, preparedC] = await Promise.all([
						ensureTask,
						prepareInitialTaskWorktree({
							cwd: fixture.workspacePath,
							taskId: "task-a",
							baseRef: fixture.baseRef,
							updateBaseRefBeforeStart: true,
						}),
						prepareInitialTaskWorktree({
							cwd: fixture.workspacePath,
							taskId: "task-b",
							baseRef: fixture.baseRef,
							updateBaseRefBeforeStart: true,
						}),
						prepareInitialTaskWorktree({
							cwd: fixture.workspacePath,
							taskId: "task-c",
							baseRef: fixture.baseRef,
							updateBaseRefBeforeStart: true,
						}),
					]);

					// The setup-lock caller completed promptly — a held refresh
					// must not starve the ~5s setup-lock retry budget.
					expect(ensureResult.ensured.ok).toBe(true);
					expect(ensureResult.elapsedMs).toBeLessThan(4500);
					// The three concurrent refreshes queued on the refresh lock
					// (long retries) and all completed after the release.
					for (const prepared of [preparedA, preparedB, preparedC]) {
						expect(prepared.ok, JSON.stringify(prepared, null, 2)).toBe(true);
						if (!prepared.path) {
							throw new Error("Expected a prepared worktree path");
						}
						expect(runGit(prepared.path, ["rev-parse", "HEAD"])).toBe(fixture.remoteBaseSha);
					}
					// The local base was fast-forwarded once and stays there.
					expect(runGit(fixture.workspacePath, ["rev-parse", `refs/heads/${fixture.baseRef}`])).toBe(
						fixture.remoteBaseSha,
					);
					await holder;
				} finally {
					cleanup();
				}
			});
		},
	);

	it("keeps the base refresh and worktree setup locks independent in the same process", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-lockkeys-");
			try {
				// A plain git repo is enough: both locks key off the common dir.
				const repoPath = join(sandboxRoot, "repo");
				mkdirSync(repoPath, { recursive: true });
				runGit(repoPath, ["init"]);

				const setupLockRequest = await getTaskWorktreeSetupLock(repoPath);
				const refreshLockRequest = await getTaskBaseRefreshLock(repoPath);

				// Hold the setup lock, then (while it is held) the refresh lock,
				// both in this process. proper-lockfile keys its in-process
				// `locks` map by the resolved `path`, so if both requests shared
				// a `path` the refresh acquisition would overwrite the setup
				// entry and releasing the setup lock afterward would fail with
				// ERELEASED / ENOTACQUIRED.
				const releaseSetup = await acquireHeldLock(setupLockRequest);
				const releaseRefresh = await acquireHeldLock(refreshLockRequest);

				// Release the refresh lock first, then the setup lock. Both
				// releases must succeed, proving the two locks are independent.
				await releaseRefresh();
				await releaseSetup();
			} finally {
				cleanup();
			}
		});
	});

	it("keeps the refresh and records a blocked outcome when worktree creation fails", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-base-refresh-createfail-");
			try {
				const fixture = createBaseRefreshFixture(sandboxRoot);
				const taskId = "task-createfail";
				// Block worktree creation: the task worktrees root exists as a
				// file, so the worktree directory cannot be created (an obstacle
				// at the worktree path itself would be cleaned up first).
				const worktreePath = getTaskWorktreePath(fixture.workspacePath, taskId);
				const taskRoot = dirname(worktreePath);
				mkdirSync(dirname(taskRoot), { recursive: true });
				writeFileSync(taskRoot, "blocker\n", "utf8");

				const failed = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: true,
				});
				expect(failed.ok).toBe(false);
				expect(failed.initialStart.stage).toBe("blocked");
				expect(failed.initialStart.failure?.category).toBe("worktree_setup_failed");
				// The refresh happened first and its fast-forward stays in place.
				expect(runGit(fixture.workspacePath, ["rev-parse", `refs/heads/${fixture.baseRef}`])).toBe(
					fixture.remoteBaseSha,
				);
				// The durable record reports THIS attempt (not idle or a stale
				// record), while keeping the baseline unfixed for a retry.
				const record = await readTaskInitialStartRecord(taskId);
				expect(record?.state).toBe("blocked");
				expect(record?.baselineSha).toBeNull();
				expect(record?.failure?.category).toBe("worktree_setup_failed");

				// Retry after clearing the obstacle: the re-fetch is a no-op
				// for the equal tip, and the worktree is created at baseline.
				rmSync(taskRoot, { force: true });
				const prepared = await prepareInitialTaskWorktree({
					cwd: fixture.workspacePath,
					taskId,
					baseRef: fixture.baseRef,
					updateBaseRefBeforeStart: true,
				});
				expect(prepared.ok, JSON.stringify(prepared, null, 2)).toBe(true);
				if (!prepared.path) {
					throw new Error("Expected a prepared worktree path");
				}
				expect(runGit(prepared.path, ["rev-parse", "HEAD"])).toBe(fixture.remoteBaseSha);
				const finalRecord = await readTaskInitialStartRecord(taskId);
				expect(finalRecord?.state).toBe("prepared");
				expect(finalRecord?.baselineSha).toBe(fixture.remoteBaseSha);
			} finally {
				cleanup();
			}
		});
	});
});
