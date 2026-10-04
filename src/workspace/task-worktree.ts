import { access, lstat, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type {
	RuntimeTaskInitialStartOutcome,
	RuntimeTaskPreservationInfoResponse,
	RuntimeTaskPreservationRecord,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeTaskWorktreeRecoverResponse,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { getTaskWorktreesHomePath, loadWorkspaceContext } from "../state/workspace-state";
import { getGitCommandErrorMessage, getGitStdout, readGitHeadInfo, runGit } from "./git-utils";
import { refreshTaskBaseRef } from "./task-base-refresh";
import {
	clearInitialStartLiveStage,
	getTaskInitialStartEvidence,
	isInitialStartBaselineFixed,
	setInitialStartLiveStage,
	writeTaskInitialStartRecord,
} from "./task-initial-start";
import { applyTaskPatch, findTaskPatch } from "./task-patch";
import {
	applyPreservedWorktreeContent,
	preserveTaskWorktree,
	readTaskPreservationRecord,
	recordTaskCleanupBlockedReason,
	resolveTaskPreservationRestoreTarget,
	syncTaskPreservationActivity,
} from "./task-preservation";
import { getWorkspaceFolderLabelForWorktreePath, normalizeTaskIdForWorktreePath } from "./task-worktree-path";
import { listTurbopackNodeModulesSymlinkSkipPaths } from "./task-worktree-turbopack";
import { logWorkspaceEvent } from "./workspace-logger";

const KANBAN_MANAGED_EXCLUDE_BLOCK_START = "# kanban-managed-symlinked-ignored-paths:start";
const KANBAN_MANAGED_EXCLUDE_BLOCK_END = "# kanban-managed-symlinked-ignored-paths:end";
const KANBAN_TASK_WORKTREE_SETUP_LOCKFILE_NAME = "kanban-task-worktree-setup.lock";

const SYMLINK_PATH_SEGMENT_BLACKLIST = new Set([
	".git",
	".DS_Store",
	"Thumbs.db",
	"Desktop.ini",
	"Icon\r",
	".Spotlight-V100",
	".Trashes",
]);

type CreateSymlink = (target: string, path: string, type: "dir" | "file") => Promise<void>;

export async function mirrorIgnoredPath(options: {
	sourcePath: string;
	targetPath: string;
	isDirectory: boolean;
	createSymlink?: CreateSymlink;
}): Promise<"mirrored" | "skipped"> {
	const createSymlink = options.createSymlink ?? symlink;
	try {
		await createSymlink(options.sourcePath, options.targetPath, options.isDirectory ? "dir" : "file");
		return "mirrored";
	} catch {
		return "skipped";
	}
}

function toPlatformRelativePath(path: string): string {
	return path
		.trim()
		.replaceAll("\\", "/")
		.replace(/\/+$/g, "")
		.split("/")
		.filter((segment) => segment.length > 0)
		.join("/");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function isMissingInitialCommitError(message: string): boolean {
	const normalizedMessage = message.trim().toLowerCase();
	if (!normalizedMessage) {
		return false;
	}

	return (
		normalizedMessage.includes("needed a single revision") ||
		normalizedMessage.includes("ambiguous argument") ||
		normalizedMessage.includes("unknown revision or path not in the working tree") ||
		normalizedMessage.includes("bad revision")
	);
}

function getWorktreeBaseRefResolutionErrorMessage(baseRef: string, errorMessage: string): string {
	if (!isMissingInitialCommitError(errorMessage)) {
		return errorMessage;
	}

	return `This repository does not have an initial commit yet, so Kanban cannot create a task worktree from base ref "${baseRef}". Create an initial commit, then try moving the task to in progress again.`;
}

async function tryRunGit(cwd: string, args: string[]): Promise<string | null> {
	const result = await runGit(cwd, args);
	return result.ok ? result.stdout : null;
}

async function getGitCommonDir(repoPath: string): Promise<string> {
	const gitCommonDir = await getGitStdout(["rev-parse", "--git-common-dir"], repoPath);
	return isAbsolute(gitCommonDir) ? gitCommonDir : join(repoPath, gitCommonDir);
}

async function getTaskWorktreeSetupLock(repoPath: string): Promise<LockRequest> {
	return {
		path: await getGitCommonDir(repoPath),
		type: "directory",
		lockfileName: KANBAN_TASK_WORKTREE_SETUP_LOCKFILE_NAME,
	};
}

export async function removeTaskWorktreeSetupLock(repoPath: string): Promise<boolean> {
	const lockPath = join(repoPath, ".git", KANBAN_TASK_WORKTREE_SETUP_LOCKFILE_NAME);
	const existed = await pathExists(lockPath);
	await rm(lockPath, { force: true, recursive: true });
	return existed;
}

async function withTaskWorktreeSetupLock<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
	return await lockedFileSystem.withLock(await getTaskWorktreeSetupLock(repoPath), operation);
}

function getWorktreesRootPath(taskId: string): string {
	const normalizedTaskId = normalizeTaskIdForWorktreePath(taskId);
	return join(getTaskWorktreesHomePath(), normalizedTaskId);
}

function getWorktreesBaseRootPath(): string {
	return getTaskWorktreesHomePath();
}

function getTaskWorktreePath(repoPath: string, taskId: string): string {
	const workspaceLabel = getWorkspaceFolderLabelForWorktreePath(repoPath);
	return join(getWorktreesRootPath(taskId), workspaceLabel);
}

/** True when the task's worktree directory exists (B-5.7/B-5.9 maintenance). */
export async function taskWorktreeExists(repoPath: string, taskId: string): Promise<boolean> {
	return await pathExists(getTaskWorktreePath(repoPath, normalizeTaskIdForWorktreePath(taskId)));
}

function shouldSkipSymlink(relativePath: string): boolean {
	const segments = relativePath.split("/").filter((segment) => segment.length > 0);
	if (segments.length === 0) {
		return true;
	}
	return segments.some((segment) => SYMLINK_PATH_SEGMENT_BLACKLIST.has(segment));
}

function isPathWithinRoot(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

function getUniquePaths(relativePaths: string[]): string[] {
	const uniquePaths = Array.from(new Set(relativePaths.map((path) => toPlatformRelativePath(path)).filter(Boolean)));
	uniquePaths.sort((left, right) => {
		const leftDepth = left.split("/").length;
		const rightDepth = right.split("/").length;
		if (leftDepth !== rightDepth) {
			return leftDepth - rightDepth;
		}
		return left.localeCompare(right);
	});

	const roots: string[] = [];
	for (const path of uniquePaths) {
		if (roots.some((root) => isPathWithinRoot(path, root))) {
			continue;
		}
		roots.push(path);
	}

	return roots;
}

async function listIgnoredPaths(repoPath: string): Promise<string[]> {
	const output = await getGitStdout(
		["ls-files", "--others", "--ignored", "--exclude-per-directory=.gitignore", "--directory"],
		repoPath,
	);
	return output
		.split("\n")
		.map((line) => toPlatformRelativePath(line))
		.filter((line) => line.length > 0);
}

async function worktreeHasConfiguredSubmodules(worktreePath: string): Promise<boolean> {
	const gitmodulesPath = join(worktreePath, ".gitmodules");
	if (!(await pathExists(gitmodulesPath))) {
		return false;
	}

	const result = await runGit(worktreePath, [
		"config",
		"--file",
		gitmodulesPath,
		"--get-regexp",
		"^submodule\\..*\\.path$",
	]);
	return result.ok && result.stdout.length > 0;
}

function escapeGitIgnoreLiteral(path: string): string {
	const normalized = toPlatformRelativePath(path);
	return normalized
		.replace(/\\/g, "\\\\")
		.replace(/^([#!])/u, "\\$1")
		.replace(/([*?[])/g, "\\$1");
}

function stripManagedExcludeBlock(content: string): string {
	const lines = content.split("\n");
	const nextLines: string[] = [];
	let insideManagedBlock = false;
	for (const line of lines) {
		if (line === KANBAN_MANAGED_EXCLUDE_BLOCK_START) {
			insideManagedBlock = true;
			continue;
		}
		if (line === KANBAN_MANAGED_EXCLUDE_BLOCK_END) {
			insideManagedBlock = false;
			continue;
		}
		if (!insideManagedBlock) {
			nextLines.push(line);
		}
	}
	return nextLines.join("\n").replace(/\n+$/g, "");
}

async function syncManagedIgnoredPathExcludes(repoPath: string, relativePaths: string[]): Promise<void> {
	const excludePathOutput = await getGitStdout(["rev-parse", "--git-path", "info/exclude"], repoPath);
	if (!excludePathOutput) {
		return;
	}
	const excludePath = isAbsolute(excludePathOutput) ? excludePathOutput : join(repoPath, excludePathOutput);

	const existingContent = await readFile(excludePath, "utf8").catch(() => "");
	const preservedContent = stripManagedExcludeBlock(existingContent);
	const managedPaths = getUniquePaths(relativePaths);
	const managedBlock =
		managedPaths.length === 0
			? ""
			: [
					KANBAN_MANAGED_EXCLUDE_BLOCK_START,
					"# Keep symlinked ignored paths ignored inside Kanban task worktrees.",
					...managedPaths.map((relativePath) => `/${escapeGitIgnoreLiteral(relativePath)}`),
					KANBAN_MANAGED_EXCLUDE_BLOCK_END,
				].join("\n");

	const nextContent = [preservedContent, managedBlock].filter(Boolean).join("\n\n").replace(/\n+$/g, "");
	const normalizedNextContent = nextContent ? `${nextContent}\n` : "";
	if (normalizedNextContent === existingContent) {
		return;
	}

	await lockedFileSystem.writeTextFileAtomic(excludePath, normalizedNextContent);
}

async function syncIgnoredPathsIntoWorktree(repoPath: string, worktreePath: string): Promise<void> {
	const ignoredPaths = getUniquePaths(await listIgnoredPaths(repoPath)).filter(
		(relativePath) => !shouldSkipSymlink(relativePath),
	);
	const turbopackNodeModulesSkipPaths = new Set(await listTurbopackNodeModulesSymlinkSkipPaths(repoPath));
	const mirroredIgnoredPaths = ignoredPaths.filter((relativePath) => !turbopackNodeModulesSkipPaths.has(relativePath));

	await syncManagedIgnoredPathExcludes(repoPath, mirroredIgnoredPaths);
	for (const relativePath of mirroredIgnoredPaths) {
		if (shouldSkipSymlink(relativePath)) {
			continue;
		}

		const sourcePath = join(repoPath, relativePath);
		if (!(await pathExists(sourcePath))) {
			continue;
		}

		const targetPath = join(worktreePath, relativePath);
		if (await pathExists(targetPath)) {
			continue;
		}

		const sourceStat = await lstat(sourcePath);
		await mkdir(dirname(targetPath), { recursive: true });
		await mirrorIgnoredPath({
			sourcePath,
			targetPath,
			isDirectory: sourceStat.isDirectory(),
		});
	}
}

async function initializeSubmodulesIfNeeded(worktreePath: string): Promise<void> {
	if (!(await worktreeHasConfiguredSubmodules(worktreePath))) {
		return;
	}

	await getGitStdout(["submodule", "update", "--init", "--recursive"], worktreePath);
}

/**
 * Make a fresh worktree of the repository runnable: initialize submodules and
 * mirror the repository's ignored paths (dependencies, build caches) into it.
 * B-11.5: the clean integration worktree needs this too before combined
 * verification runs the configured checks there.
 */
export async function prepareWorktreeEnvironment(repoPath: string, worktreePath: string): Promise<void> {
	await initializeSubmodulesIfNeeded(worktreePath);
	await syncIgnoredPathsIntoWorktree(repoPath, worktreePath);
}

async function prepareNewTaskWorktree(repoPath: string, worktreePath: string): Promise<void> {
	try {
		await prepareWorktreeEnvironment(repoPath, worktreePath);
	} catch (error) {
		await removeTaskWorktreeInternal(repoPath, worktreePath).catch(() => {});
		throw error;
	}
}

async function removeTaskWorktreeInternal(repoPath: string, worktreePath: string): Promise<boolean> {
	const existed = await pathExists(worktreePath);
	const removeResult = await runGit(repoPath, ["worktree", "remove", "--force", worktreePath]);
	if (!removeResult.ok) {
		// If remove failed (e.g. worktree in bad state), prune stale registrations
		// so git doesn't think the path is still registered after we rm it.
		await runGit(repoPath, ["worktree", "prune"]);
	}
	await rm(worktreePath, { recursive: true, force: true });
	return existed;
}

async function pruneEmptyParents(rootPath: string, fromPath: string): Promise<void> {
	let current = fromPath;
	while (current.startsWith(rootPath) && current !== rootPath) {
		try {
			const entries = await readdir(current);
			if (entries.length > 0) {
				return;
			}
			await rm(current, { recursive: true, force: true });
			current = dirname(current);
		} catch {
			return;
		}
	}
}

export async function ensureTaskWorktreeIfDoesntExist(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<RuntimeWorktreeEnsureResponse> {
	try {
		const context = await loadWorkspaceContext(options.cwd);
		const taskId = normalizeTaskIdForWorktreePath(options.taskId);
		const worktreePath = getTaskWorktreePath(context.repoPath, taskId);
		// Investigation note: ensure is called on every task start. The previous implementation
		// compared the worktree HEAD to the latest baseRef commit and recreated the worktree
		// when the base branch advanced, which could destroy valid task progress. Existing
		// worktrees are now treated as authoritative and only missing worktrees are created.
		const existingResult = await runGit(worktreePath, ["rev-parse", "HEAD"]);
		if (existingResult.ok && existingResult.stdout) {
			await syncIgnoredPathsIntoWorktree(context.repoPath, worktreePath);
			await syncTaskPreservationActivity({
				repoPath: context.repoPath,
				taskId,
				worktreePath,
				headCommit: existingResult.stdout,
			});
			return {
				ok: true,
				path: worktreePath,
				baseRef: options.baseRef.trim(),
				baseCommit: existingResult.stdout,
				restoredFromPreservation: false,
			};
		}

		return await withTaskWorktreeSetupLock(context.repoPath, async () => {
			const lockedExistingCommit = await tryRunGit(worktreePath, ["rev-parse", "HEAD"]);
			if (lockedExistingCommit) {
				await syncIgnoredPathsIntoWorktree(context.repoPath, worktreePath);
				await syncTaskPreservationActivity({
					repoPath: context.repoPath,
					taskId,
					worktreePath,
					headCommit: lockedExistingCommit,
				});
				return {
					ok: true,
					path: worktreePath,
					baseRef: options.baseRef.trim(),
					baseCommit: lockedExistingCommit,
					restoredFromPreservation: false,
				};
			}

			const requestedBaseRef = options.baseRef.trim();
			if (!requestedBaseRef) {
				return {
					ok: false,
					path: null,
					baseRef: requestedBaseRef,
					baseCommit: null,
					error: "Task base branch is required for worktree creation.",
				};
			}

			// UPD-0: a generic ensure never creates a worktree for a task that
			// has never started. That worktree is created by the start
			// lifecycle, which first refreshes the origin-backed base ref for
			// fresh tasks with the update option enabled.
			const initialStartEvidence = await getTaskInitialStartEvidence(taskId);
			const hasHistoricalWork = initialStartEvidence.hasPreservationRecord || initialStartEvidence.hasSavedPatch;
			if (!hasHistoricalWork && initialStartEvidence.preparedBaselineSha !== null) {
				// A fixed baseline is authoritative (only when no preserved
				// work needs restoring): restore at the recorded SHA, never
				// re-resolve against a newer origin state.
				const restored = await restoreDetachedTaskWorktree({
					repoPath: context.repoPath,
					worktreePath,
					sha: initialStartEvidence.preparedBaselineSha,
				});
				if (!restored.ok) {
					return {
						ok: false,
						path: null,
						baseRef: requestedBaseRef,
						baseCommit: null,
						error: restored.error,
						restoredFromPreservation: false,
					};
				}
				await syncTaskPreservationActivity({
					repoPath: context.repoPath,
					taskId,
					worktreePath,
					headCommit: restored.headCommit,
					startingCommit: restored.headCommit,
				});
				return {
					ok: true,
					path: worktreePath,
					baseRef: requestedBaseRef,
					baseCommit: restored.headCommit,
					restoredFromPreservation: false,
				};
			}
			if (
				!hasHistoricalWork &&
				!initialStartEvidence.hasDeliveryReceipt &&
				initialStartEvidence.preparedBaselineSha === null
			) {
				return {
					ok: false,
					path: null,
					baseRef: requestedBaseRef,
					baseCommit: null,
					category: "initial_start_preparation_required",
					remedy: "Start the task to create its worktree.",
					error: `The worktree for task "${options.taskId}" is created when the task starts, which prepares its base ref first. Start the task to create its worktree.`,
					restoredFromPreservation: false,
				};
			}

			const baseRefResult = await runGit(context.repoPath, [
				"rev-parse",
				"--verify",
				`${requestedBaseRef}^{commit}`,
			]);
			if (!baseRefResult.ok) {
				return {
					ok: false,
					path: null,
					baseRef: requestedBaseRef,
					baseCommit: null,
					error: getWorktreeBaseRefResolutionErrorMessage(
						requestedBaseRef,
						baseRefResult.stderr || baseRefResult.output,
					),
				};
			}
			const requestedBaseCommit = baseRefResult.stdout;

			// B-5: if this task's work was durably preserved (trashed, or the runtime
			// was interrupted), restore from that preserved revision rather than the
			// current base ref so prior work is not lost or reset.
			const restoreTarget = await resolveTaskPreservationRestoreTarget({
				repoPath: context.repoPath,
				taskId,
			});
			if (restoreTarget?.commit) {
				const restoreAddResult = await runGit(context.repoPath, [
					"worktree",
					"add",
					"--detach",
					worktreePath,
					restoreTarget.commit,
				]);
				if (restoreAddResult.ok) {
					await prepareNewTaskWorktree(context.repoPath, worktreePath);
					const preserveWarning = await applyPreservedWorktreeContent({
						taskId,
						worktreePath,
						checkedOutCommit: restoreTarget.commit,
						patch: restoreTarget.patch,
						archivePath: restoreTarget.archivePath,
					});
					await syncTaskPreservationActivity({
						repoPath: context.repoPath,
						taskId,
						worktreePath,
						headCommit: restoreTarget.commit,
						startingCommit: restoreTarget.commit,
					});
					return {
						ok: true,
						path: worktreePath,
						baseRef: requestedBaseRef,
						baseCommit: restoreTarget.commit,
						restoredFromPreservation: true,
						warning: preserveWarning,
					};
				}
				// The preserved commit may no longer exist (e.g. gc'd objects).
				// Fall through to the base-ref path below.
			}

			const storedPatch = await findTaskPatch(taskId);
			let baseCommit = storedPatch?.commit ?? requestedBaseCommit;
			let warning: string | undefined;

			if (await pathExists(worktreePath)) {
				await removeTaskWorktreeInternal(context.repoPath, worktreePath);
			}

			// Clean up stale worktree registrations that can linger when git
			// worktree remove fails or the process is interrupted. Without this,
			// git worktree add refuses with "missing but already registered".
			await runGit(context.repoPath, ["worktree", "prune"]);

			await mkdir(dirname(worktreePath), { recursive: true });
			const addResult = await runGit(context.repoPath, ["worktree", "add", "--detach", worktreePath, baseCommit]);
			if (!addResult.ok) {
				if (!storedPatch) {
					return {
						ok: false,
						path: null,
						baseRef: requestedBaseRef,
						baseCommit: null,
						error: addResult.stderr || addResult.output,
					};
				}

				baseCommit = requestedBaseCommit;
				warning =
					"Could not restore the saved task patch onto its original commit. Started from the task base ref instead.";
				await getGitStdout(["worktree", "add", "--detach", worktreePath, baseCommit], context.repoPath);
			}
			await prepareNewTaskWorktree(context.repoPath, worktreePath);

			if (storedPatch && baseCommit === storedPatch.commit) {
				try {
					await applyTaskPatch(storedPatch.path, worktreePath);
					await rm(storedPatch.path, { force: true });
				} catch (error) {
					warning = `Saved task changes could not be reapplied automatically. ${getGitCommandErrorMessage(error)}`;
				}
			}

			return {
				ok: true,
				path: worktreePath,
				baseRef: requestedBaseRef,
				baseCommit,
				restoredFromPreservation: false,
				warning,
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			path: null,
			baseRef: options.baseRef.trim(),
			baseCommit: null,
			error: message,
		};
	}
}

/**
 * Create (or recreate a stale) detached task worktree at an exact commit and
 * make it runnable. Shared by the prepared-baseline restore path and the
 * start-owned preparation.
 */
async function restoreDetachedTaskWorktree(options: {
	repoPath: string;
	worktreePath: string;
	sha: string;
}): Promise<{ ok: true; headCommit: string } | { ok: false; error: string }> {
	if (await pathExists(options.worktreePath)) {
		await removeTaskWorktreeInternal(options.repoPath, options.worktreePath);
	}
	// Clean up stale worktree registrations that can linger when git
	// worktree remove fails or the process is interrupted. Without this,
	// git worktree add refuses with "missing but already registered".
	await runGit(options.repoPath, ["worktree", "prune"]);
	await mkdir(dirname(options.worktreePath), { recursive: true });
	const addResult = await runGit(options.repoPath, ["worktree", "add", "--detach", options.worktreePath, options.sha]);
	if (!addResult.ok) {
		return {
			ok: false,
			error: addResult.stderr || addResult.output || "Could not create the task worktree at the recorded baseline.",
		};
	}
	await prepareNewTaskWorktree(options.repoPath, options.worktreePath);
	const headCommit = (await tryRunGit(options.worktreePath, ["rev-parse", "HEAD^{commit}"])) ?? options.sha;
	return { ok: true, headCommit };
}

export interface InitialStartPreparationResponse {
	ok: boolean;
	path: string | null;
	baseRef: string;
	baseCommit: string | null;
	restoredFromPreservation: boolean;
	warning?: string;
	error?: string;
	/** UPD-0: terminal preparation outcome (fixed baseline + final stage). */
	initialStart: RuntimeTaskInitialStartOutcome;
}

/**
 * UPD-0: runtime-owned preparation for a task's initial start. This is the
 * ONLY path that creates the worktree for a task that has never started and
 * the only path that refreshes the base ref:
 *
 * 1. an existing worktree is authoritative and reused (never refreshed);
 * 2. preserved work or a saved patch restores before any base resolution
 *    (trash restore / saved-patch resume keeps historical state
 *    authoritative);
 * 3. a prepared baseline record restores at the recorded SHA (never
 *    re-resolved against a newer origin state);
 * 4. a fresh task (no durable evidence) refreshes the selected base ref
 *    against origin when the persisted policy allows it, then creates the
 *    worktree detached at the post-refresh SHA and persists the baseline.
 *
 * Failures before a successful worktree preparation are retryable: a blocked
 * record is overwritten by the next attempt and may fetch again.
 */
export async function prepareInitialTaskWorktree(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
	/** Persisted card policy (missing values already normalized to true). */
	updateBaseRefBeforeStart: boolean;
	/** True when durable session records show this task already started. */
	hasPriorSession?: boolean;
}): Promise<InitialStartPreparationResponse> {
	const startedAt = Date.now();
	const taskId = normalizeTaskIdForWorktreePath(options.taskId);
	const baseRef = options.baseRef.trim();
	const elapsed = () => `${Date.now() - startedAt}ms`;
	const fail = (
		error: string,
		failure: RuntimeTaskInitialStartOutcome["failure"],
	): InitialStartPreparationResponse => {
		clearInitialStartLiveStage(taskId);
		logWorkspaceEvent(
			`initial-start preparation blocked task=${taskId} baseRef=${baseRef} after ${elapsed()}: ${error}`,
		);
		return {
			ok: false,
			path: null,
			baseRef,
			baseCommit: null,
			restoredFromPreservation: false,
			error,
			initialStart: {
				stage: "blocked",
				baselineSha: null,
				refreshed: false,
				failure,
			},
		};
	};
	try {
		const context = await loadWorkspaceContext(options.cwd);
		const worktreePath = getTaskWorktreePath(context.repoPath, taskId);

		return await withTaskWorktreeSetupLock(context.repoPath, async () => {
			// 1. Existing worktree: authoritative, never refreshed.
			const existingCommit = await tryRunGit(worktreePath, ["rev-parse", "HEAD^{commit}"]);
			if (existingCommit) {
				await syncIgnoredPathsIntoWorktree(context.repoPath, worktreePath);
				await syncTaskPreservationActivity({
					repoPath: context.repoPath,
					taskId,
					worktreePath,
					headCommit: existingCommit,
				});
				logWorkspaceEvent(
					`initial-start reused existing worktree task=${taskId} head=${existingCommit} after ${elapsed()}`,
				);
				return {
					ok: true,
					path: worktreePath,
					baseRef,
					baseCommit: existingCommit,
					restoredFromPreservation: false,
					initialStart: {
						stage: "ready",
						baselineSha: existingCommit,
						refreshed: false,
						failure: null,
					},
				};
			}

			const evidence = await getTaskInitialStartEvidence(taskId);

			// 2. Preserved work / saved patch: restore before any base
			//    resolution or baseline reuse so historical state stays
			//    authoritative (trash restore, saved-patch resume).
			if (evidence.hasPreservationRecord || evidence.hasSavedPatch) {
				const restored = await restorePreservedOrPatchedWorktree({
					repoPath: context.repoPath,
					taskId,
					worktreePath,
					baseRef,
				});
				if (!restored.ok) {
					return fail(restored.error, {
						category: "worktree_setup_failed",
						reason: restored.error,
						remedy:
							"Recover the task's preserved work (kanban task recover), or delete the task and start again.",
						selectedRef: baseRef,
					});
				}
				logWorkspaceEvent(
					`initial-start restored historical work task=${taskId} sha=${restored.baseCommit} after ${elapsed()}`,
				);
				return {
					ok: true,
					path: restored.path,
					baseRef,
					baseCommit: restored.baseCommit,
					restoredFromPreservation: restored.restoredFromPreservation,
					...(restored.warning ? { warning: restored.warning } : {}),
					initialStart: {
						stage: "ready",
						baselineSha: restored.baseCommit,
						refreshed: false,
						failure: null,
					},
				};
			}

			// 3. Prepared baseline (no preserved work): restore at the recorded
			//    SHA, never re-resolved against a newer origin state.
			if (evidence.preparedBaselineSha !== null) {
				setInitialStartLiveStage(taskId, "creating_worktree");
				const restored = await restoreDetachedTaskWorktree({
					repoPath: context.repoPath,
					worktreePath,
					sha: evidence.preparedBaselineSha,
				});
				if (!restored.ok) {
					return fail(
						`The recorded initial baseline ${evidence.preparedBaselineSha.slice(0, 12)} is no longer available. ${restored.error}`,
						{
							category: "worktree_setup_failed",
							reason: "The recorded initial baseline for the task is no longer available in the repository.",
							remedy:
								"Recover the task's preserved work (kanban task recover), or delete the task and start again.",
							selectedRef: baseRef,
						},
					);
				}
				await syncTaskPreservationActivity({
					repoPath: context.repoPath,
					taskId,
					worktreePath,
					headCommit: restored.headCommit,
					startingCommit: restored.headCommit,
				});
				clearInitialStartLiveStage(taskId);
				logWorkspaceEvent(
					`initial-start restored prepared baseline task=${taskId} sha=${restored.headCommit} after ${elapsed()}`,
				);
				return {
					ok: true,
					path: worktreePath,
					baseRef,
					baseCommit: restored.headCommit,
					restoredFromPreservation: false,
					initialStart: {
						stage: "ready",
						baselineSha: restored.headCommit,
						refreshed: false,
						failure: null,
					},
				};
			} // 4. Fresh task (or blocked retry): resolve the base. A prior
			//    session (durable session records) or a disabled policy means
			//    no refresh — resolve locally as before.
			let baselineSha: string;
			let refreshed = false;
			if (options.updateBaseRefBeforeStart && !options.hasPriorSession) {
				setInitialStartLiveStage(taskId, "refreshing");
				logWorkspaceEvent(`initial-start refreshing base task=${taskId} baseRef=${baseRef}`);
				const refresh = await refreshTaskBaseRef({
					repoPath: context.repoPath,
					baseRef,
				});
				if (!refresh.ok) {
					await writeTaskInitialStartRecord({
						taskId,
						baseRef,
						updateBaseRefBeforeStart: true,
						state: "blocked",
						baselineSha: null,
						failure: refresh.failure,
						updatedAt: Date.now(),
					});
					return fail(`${refresh.failure.reason} ${refresh.failure.remedy}`, refresh.failure);
				}
				baselineSha = refresh.baselineSha;
				refreshed = true;
				logWorkspaceEvent(`initial-start refreshed base task=${taskId} baseRef=${baseRef} baseline=${baselineSha}`);
			} else {
				const resolved = await runGit(context.repoPath, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
				if (!resolved.ok) {
					const resolutionError = getWorktreeBaseRefResolutionErrorMessage(
						baseRef,
						resolved.stderr || resolved.output,
					);
					await writeTaskInitialStartRecord({
						taskId,
						baseRef,
						updateBaseRefBeforeStart: options.updateBaseRefBeforeStart,
						state: "blocked",
						baselineSha: null,
						failure: {
							category: "unsupported_ref",
							reason: resolutionError,
							remedy: "Select a valid base ref for the task, then start again.",
							selectedRef: baseRef,
						},
						updatedAt: Date.now(),
					});
					return fail(resolutionError, {
						category: "unsupported_ref",
						reason: resolutionError,
						remedy: "Select a valid base ref for the task, then start again.",
						selectedRef: baseRef,
					});
				}
				baselineSha = resolved.stdout;
			}

			// 5. Create the worktree detached at the fixed baseline.
			setInitialStartLiveStage(taskId, "creating_worktree");
			const created = await restoreDetachedTaskWorktree({
				repoPath: context.repoPath,
				worktreePath,
				sha: baselineSha,
			});
			if (!created.ok) {
				return fail(created.error, {
					category: "worktree_setup_failed",
					reason: created.error,
					remedy: "Retry starting the task.",
					selectedRef: baseRef,
				});
			}

			// 6. Persist the fixed baseline before anything can relaunch it.
			setInitialStartLiveStage(taskId, "recording_baseline");
			await writeTaskInitialStartRecord({
				taskId,
				baseRef,
				updateBaseRefBeforeStart: options.updateBaseRefBeforeStart,
				state: "prepared",
				baselineSha: created.headCommit,
				failure: null,
				updatedAt: Date.now(),
			});
			clearInitialStartLiveStage(taskId);
			logWorkspaceEvent(
				`initial-start prepared worktree task=${taskId} baseline=${created.headCommit} refreshed=${refreshed} after ${elapsed()}`,
			);
			return {
				ok: true,
				path: worktreePath,
				baseRef,
				baseCommit: created.headCommit,
				restoredFromPreservation: false,
				initialStart: {
					stage: "ready",
					baselineSha: created.headCommit,
					refreshed,
					failure: null,
				},
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return fail(message, {
			category: "worktree_setup_failed",
			reason: message,
			remedy: "Retry starting the task.",
			selectedRef: baseRef,
		});
	}
}

/**
 * UPD-0: preservation / saved-patch restoration shared by the start-owned
 * preparation (the generic ensure keeps its own equivalent behavior).
 */
async function restorePreservedOrPatchedWorktree(options: {
	repoPath: string;
	taskId: string;
	worktreePath: string;
	baseRef: string;
}): Promise<
	| {
			ok: true;
			path: string;
			baseCommit: string;
			restoredFromPreservation: boolean;
			warning?: string;
	  }
	| { ok: false; error: string }
> {
	try {
		// 1. Preserved work (trashed, or the runtime was interrupted) is
		//    authoritative and restores without resolving the selected base
		//    ref, which may no longer exist.
		const restoreTarget = await resolveTaskPreservationRestoreTarget({
			repoPath: options.repoPath,
			taskId: options.taskId,
		});
		if (restoreTarget?.commit) {
			const restored = await restoreDetachedTaskWorktree({
				repoPath: options.repoPath,
				worktreePath: options.worktreePath,
				sha: restoreTarget.commit,
			});
			if (restored.ok) {
				const preserveWarning = await applyPreservedWorktreeContent({
					taskId: options.taskId,
					worktreePath: options.worktreePath,
					checkedOutCommit: restoreTarget.commit,
					patch: restoreTarget.patch,
					archivePath: restoreTarget.archivePath,
				});
				await syncTaskPreservationActivity({
					repoPath: options.repoPath,
					taskId: options.taskId,
					worktreePath: options.worktreePath,
					headCommit: restoreTarget.commit,
					startingCommit: restoreTarget.commit,
				});
				return {
					ok: true,
					path: options.worktreePath,
					baseCommit: restoreTarget.commit,
					restoredFromPreservation: true,
					...(preserveWarning ? { warning: preserveWarning } : {}),
				};
			}
			// The preserved commit may no longer exist (e.g. gc'd objects).
			// Fall through to the patch/base-ref path below.
		}

		// 2. Saved patch: restore onto its recorded commit; this also never
		//    requires the selected base ref.
		const storedPatch = await findTaskPatch(options.taskId);
		if (storedPatch) {
			const created = await restoreDetachedTaskWorktree({
				repoPath: options.repoPath,
				worktreePath: options.worktreePath,
				sha: storedPatch.commit,
			});
			if (created.ok) {
				let patchWarning: string | undefined;
				try {
					await applyTaskPatch(storedPatch.path, options.worktreePath);
					await rm(storedPatch.path, { force: true });
				} catch (patchError) {
					patchWarning = `Saved task changes could not be reapplied automatically. ${getGitCommandErrorMessage(patchError)}`;
				}
				return {
					ok: true,
					path: options.worktreePath,
					baseCommit: storedPatch.commit,
					restoredFromPreservation: false,
					...(patchWarning ? { warning: patchWarning } : {}),
				};
			}
			// The saved patch's original commit is gone; fall back to the base
			// ref below with a warning.
		}

		// 3. Last resort: no restorable state survived (or its commits are
		//    gone), so resolve the selected base ref.
		const baseRefResult = await runGit(options.repoPath, ["rev-parse", "--verify", `${options.baseRef}^{commit}`]);
		if (!baseRefResult.ok) {
			return {
				ok: false,
				error: getWorktreeBaseRefResolutionErrorMessage(
					options.baseRef,
					baseRefResult.stderr || baseRefResult.output,
				),
			};
		}
		const requestedBaseCommit = baseRefResult.stdout;
		const created = await restoreDetachedTaskWorktree({
			repoPath: options.repoPath,
			worktreePath: options.worktreePath,
			sha: requestedBaseCommit,
		});
		if (!created.ok) {
			return { ok: false, error: created.error };
		}
		return {
			ok: true,
			path: options.worktreePath,
			baseCommit: requestedBaseCommit,
			restoredFromPreservation: false,
			...(restoreTarget?.commit || storedPatch
				? {
						warning:
							"Could not restore the saved task patch onto its original commit. Started from the task base ref instead.",
					}
				: {}),
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function deleteTaskWorktree(options: {
	repoPath: string;
	taskId: string;
}): Promise<RuntimeWorktreeDeleteResponse> {
	try {
		const taskId = normalizeTaskIdForWorktreePath(options.taskId);
		const rootPath = getWorktreesBaseRootPath();
		const worktreePath = getTaskWorktreePath(options.repoPath, taskId);
		if (!(await pathExists(worktreePath))) {
			// B-5: the worktree is already gone. Keep any patch/archive
			// preservation assets so previously preserved work stays restorable.
			await pruneEmptyParents(rootPath, dirname(worktreePath));
			return {
				ok: true,
				removed: false,
				preserved: true,
				blockedReason: null,
			};
		}

		// B-5.2/3: the task work must be durably preserved before the worktree
		// is removed. If preservation fails, stop cleanup and keep the worktree
		// rather than risk losing uncommitted, untracked, or unpushed work.
		const preservation = await preserveTaskWorktree({
			repoPath: options.repoPath,
			taskId,
			worktreePath,
		});
		if (!preservation.preserved) {
			const blockedReason = preservation.blockedReasons.join("; ") || "Task work could not be preserved.";
			await recordTaskCleanupBlockedReason(taskId, blockedReason);
			return {
				ok: false,
				removed: false,
				preserved: false,
				blockedReason,
				error: `Task work could not be preserved before worktree removal; cleanup was blocked. ${blockedReason}`,
			};
		}

		const removed = await removeTaskWorktreeInternal(options.repoPath, worktreePath);
		await pruneEmptyParents(rootPath, dirname(worktreePath));
		await recordTaskCleanupBlockedReason(taskId, null);

		return {
			ok: true,
			removed,
			preserved: true,
			blockedReason: null,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await recordTaskCleanupBlockedReason(options.taskId, message).catch(() => undefined);
		return {
			ok: false,
			removed: false,
			preserved: false,
			blockedReason: null,
			error: message,
		};
	}
}

/**
 * Read-only snapshot of a task's recoverable work state: live worktree stats
 * (HEAD, dirty state, changed files, commits ahead of the preserved starting
 * point) plus the durable preservation record. B-5: backs `kanban task
 * locate` and the UI's preserved-work affordances.
 */
export async function getTaskPreservationInfo(options: {
	repoPath: string;
	taskId: string;
}): Promise<RuntimeTaskPreservationInfoResponse> {
	const taskId = normalizeTaskIdForWorktreePath(options.taskId);
	const worktreePath = getTaskWorktreePath(options.repoPath, taskId);
	const worktreeExists = await pathExists(worktreePath);
	let headCommit: string | null = null;
	let dirty = false;
	let commitsAheadOfBase = 0;
	const changedFiles: string[] = [];
	let preservation: RuntimeTaskPreservationRecord | null = null;
	try {
		if (worktreeExists) {
			const headResult = await runGit(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
			if (headResult.ok && headResult.stdout) {
				headCommit = headResult.stdout;
			}
			const statusResult = await runGit(worktreePath, ["status", "--porcelain"]);
			if (statusResult.ok) {
				for (const line of statusResult.stdout.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) {
						continue;
					}
					dirty = true;
					const target = trimmed.slice(3).trim();
					changedFiles.push(target.includes(" -> ") ? (target.split(" -> ").pop()?.trim() ?? target) : target);
				}
			}
		}
		preservation = await readTaskPreservationRecord(taskId);
		if (headCommit && preservation?.startingCommit && preservation.startingCommit !== headCommit) {
			const aheadResult = await runGit(options.repoPath, [
				"rev-list",
				"--count",
				`${preservation.startingCommit}..${headCommit}`,
			]);
			if (aheadResult.ok) {
				commitsAheadOfBase = Number.parseInt(aheadResult.stdout, 10) || 0;
			}
		}
		return {
			ok: true,
			worktreeExists,
			worktreePath,
			headCommit,
			dirty,
			changedFiles,
			commitsAheadOfBase,
			preservation,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			worktreeExists,
			worktreePath,
			headCommit,
			dirty,
			changedFiles,
			commitsAheadOfBase,
			preservation,
			error: message,
		};
	}
}

/**
 * Restores a removed task worktree from its durable preservation state
 * (recovery ref, binary patch, and full archive). The restored worktree is
 * detached at the preserved commit with preserved uncommitted content
 * reapplied. B-5: backs `kanban task recover` and the UI's "Recover
 * worktree" action.
 */
export async function recoverTaskWorktree(options: {
	repoPath: string;
	taskId: string;
}): Promise<RuntimeTaskWorktreeRecoverResponse> {
	const taskId = normalizeTaskIdForWorktreePath(options.taskId);
	const worktreePath = getTaskWorktreePath(options.repoPath, taskId);
	try {
		const existingCommit = await tryRunGit(worktreePath, ["rev-parse", "HEAD^{commit}"]);
		if (existingCommit) {
			return {
				ok: true,
				restored: false,
				path: worktreePath,
				headCommit: existingCommit,
			};
		}

		return await withTaskWorktreeSetupLock(options.repoPath, async () => {
			const lockedCommit = await tryRunGit(worktreePath, ["rev-parse", "HEAD^{commit}"]);
			if (lockedCommit) {
				return {
					ok: true,
					restored: false,
					path: worktreePath,
					headCommit: lockedCommit,
				};
			}

			const restoreTarget = await resolveTaskPreservationRestoreTarget({
				repoPath: options.repoPath,
				taskId,
			});
			if (!restoreTarget?.commit) {
				return {
					ok: false,
					restored: false,
					path: null,
					headCommit: null,
					error: `No preserved task state with a recoverable commit was found for task "${taskId}".`,
				};
			}

			if (await pathExists(worktreePath)) {
				// A stale directory without a valid worktree would block `git worktree add`.
				await removeTaskWorktreeInternal(options.repoPath, worktreePath);
			}
			await runGit(options.repoPath, ["worktree", "prune"]);
			await mkdir(dirname(worktreePath), { recursive: true });

			const addResult = await runGit(options.repoPath, [
				"worktree",
				"add",
				"--detach",
				worktreePath,
				restoreTarget.commit,
			]);
			if (!addResult.ok) {
				return {
					ok: false,
					restored: false,
					path: null,
					headCommit: null,
					error: addResult.stderr || addResult.output || "Could not restore the task worktree.",
				};
			}

			await prepareNewTaskWorktree(options.repoPath, worktreePath);
			const warning = await applyPreservedWorktreeContent({
				taskId,
				worktreePath,
				checkedOutCommit: restoreTarget.commit,
				patch: restoreTarget.patch,
				archivePath: restoreTarget.archivePath,
			});
			const restoredHead = (await tryRunGit(worktreePath, ["rev-parse", "HEAD^{commit}"])) ?? restoreTarget.commit;
			await syncTaskPreservationActivity({
				repoPath: options.repoPath,
				taskId,
				worktreePath,
				headCommit: restoredHead,
				startingCommit: restoreTarget.commit,
			});
			return {
				ok: true,
				restored: true,
				path: worktreePath,
				headCommit: restoredHead,
				warning,
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			restored: false,
			path: null,
			headCommit: null,
			error: message,
		};
	}
}

export async function resolveTaskCwd(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
	ensure?: boolean;
}): Promise<string> {
	const context = await loadWorkspaceContext(options.cwd);

	const normalizedBaseRef = options.baseRef.trim();
	if (!normalizedBaseRef) {
		throw new Error("Task base branch is required for task workspace resolution.");
	}

	if (options.ensure) {
		const ensured = await ensureTaskWorktreeIfDoesntExist({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: normalizedBaseRef,
		});
		if (!ensured.ok) {
			throw new Error(ensured.error ?? "Worktree setup failed.");
		}
		return ensured.path;
	}

	const worktreePath = getTaskWorktreePath(context.repoPath, options.taskId);
	if (await pathExists(worktreePath)) {
		return worktreePath;
	}
	throw new Error(`Task worktree not found for task "${options.taskId}".`);
}

export async function getTaskWorkspacePathInfo(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<Pick<RuntimeTaskWorkspaceInfoResponse, "taskId" | "path" | "exists" | "baseRef">> {
	const taskId = normalizeTaskIdForWorktreePath(options.taskId);
	const normalizedBaseRef = options.baseRef.trim();
	const repoPath = options.cwd.trim();

	if (!repoPath) {
		throw new Error("Task workspace root is required for task workspace info.");
	}

	if (!normalizedBaseRef) {
		throw new Error("Task base branch is required for task workspace info.");
	}

	const worktreePath = getTaskWorktreePath(repoPath, taskId);
	return {
		taskId,
		path: worktreePath,
		exists: await pathExists(worktreePath),
		baseRef: normalizedBaseRef,
	};
}

export async function getTaskWorkspaceInfo(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<RuntimeTaskWorkspaceInfoResponse> {
	const workspacePathInfo = await getTaskWorkspacePathInfo(options);
	// UPD-0: expose the same durable signal that gates the base refresh.
	const evidence = await getTaskInitialStartEvidence(workspacePathInfo.taskId);
	const initialStartBaselineFixed = isInitialStartBaselineFixed(evidence, {
		worktreeExists: workspacePathInfo.exists,
	});
	if (!workspacePathInfo.exists) {
		return {
			taskId: workspacePathInfo.taskId,
			path: workspacePathInfo.path,
			exists: false,
			baseRef: workspacePathInfo.baseRef,
			branch: null,
			isDetached: false,
			headCommit: null,
			initialStartBaselineFixed,
		};
	}

	const headInfo = await readGitHeadInfo(workspacePathInfo.path);
	return {
		taskId: workspacePathInfo.taskId,
		path: workspacePathInfo.path,
		exists: true,
		baseRef: workspacePathInfo.baseRef,
		branch: headInfo.branch,
		isDetached: headInfo.isDetached,
		headCommit: headInfo.headCommit,
		initialStartBaselineFixed,
	};
}
