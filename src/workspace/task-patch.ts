import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { getGitStdout, runGit } from "./git-utils";
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";

const KANBAN_TRASHED_TASK_PATCHES_DIR_NAME = "trashed-task-patches";
const TASK_PATCH_FILE_SUFFIX = ".patch";

function getTrashedTaskPatchesRootPath(): string {
	return join(getRuntimeHomePath(), KANBAN_TRASHED_TASK_PATCHES_DIR_NAME);
}

function getTaskPatchFilePrefix(taskId: string): string {
	return `${normalizeTaskIdForWorktreePath(taskId)}.`;
}

function parseTaskPatchCommit(taskId: string, filename: string): string | null {
	const prefix = getTaskPatchFilePrefix(taskId);
	if (!filename.startsWith(prefix) || !filename.endsWith(TASK_PATCH_FILE_SUFFIX)) {
		return null;
	}
	const commit = filename.slice(prefix.length, -TASK_PATCH_FILE_SUFFIX.length).trim();
	return commit.length > 0 ? commit : null;
}

async function listTaskPatchFiles(taskId: string): Promise<string[]> {
	const patchesRootPath = getTrashedTaskPatchesRootPath();
	try {
		const entries = await readdir(patchesRootPath);
		return entries.filter((entry) => parseTaskPatchCommit(taskId, entry) !== null);
	} catch {
		return [];
	}
}

export async function deleteTaskPatchFiles(taskId: string): Promise<void> {
	const patchesRootPath = getTrashedTaskPatchesRootPath();
	const filenames = await listTaskPatchFiles(taskId);
	await Promise.all(filenames.map((filename) => rm(join(patchesRootPath, filename), { force: true })));
}

export async function findTaskPatch(taskId: string): Promise<{ path: string; commit: string } | null> {
	const patchesRootPath = getTrashedTaskPatchesRootPath();
	const filenames = await listTaskPatchFiles(taskId);
	const filename = filenames.sort().at(-1);
	if (!filename) {
		return null;
	}
	const commit = parseTaskPatchCommit(taskId, filename);
	if (!commit) {
		return null;
	}
	return {
		path: join(patchesRootPath, filename),
		commit,
	};
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}

export async function listUntrackedPaths(worktreePath: string): Promise<string[]> {
	const output = await getGitStdout(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath, {
		trimStdout: false,
	});
	return output
		.split("\0")
		.map((path) => path.trim())
		.filter((path) => path.length > 0);
}

/**
 * Captures uncommitted tracked changes plus untracked files (including binary
 * content) as a single binary patch keyed by the current HEAD commit. Any
 * previously stored patches for the task are replaced.
 */
export async function captureTaskPatch(options: {
	repoPath: string;
	taskId: string;
	worktreePath: string;
}): Promise<void> {
	const headCommit = await getGitStdout(["rev-parse", "--verify", "HEAD"], options.worktreePath);

	const trackedResult = await runGit(options.worktreePath, ["diff", "--binary", "HEAD", "--"], {
		trimStdout: false,
	});
	if (!trackedResult.ok && trackedResult.exitCode !== 1) {
		throw new Error(trackedResult.error ?? "Failed to capture tracked diff.");
	}
	const trackedPatch = trackedResult.stdout;
	const patchChunks = trackedPatch.trim().length > 0 ? [ensureTrailingNewline(trackedPatch)] : [];

	for (const relativePath of await listUntrackedPaths(options.worktreePath)) {
		const untrackedResult = await runGit(
			options.worktreePath,
			["diff", "--binary", "--no-index", "--", "/dev/null", relativePath],
			{ trimStdout: false },
		);
		if (!untrackedResult.ok && untrackedResult.exitCode !== 1) {
			throw new Error(untrackedResult.error ?? "Failed to capture untracked diff.");
		}
		const untrackedPatch = untrackedResult.stdout;
		if (untrackedPatch.trim().length > 0) {
			patchChunks.push(ensureTrailingNewline(untrackedPatch));
		}
	}

	await deleteTaskPatchFiles(options.taskId);
	if (patchChunks.length === 0) {
		return;
	}

	const patchesRootPath = getTrashedTaskPatchesRootPath();
	await mkdir(patchesRootPath, { recursive: true });
	const patchPath = join(
		patchesRootPath,
		`${normalizeTaskIdForWorktreePath(options.taskId)}.${headCommit}${TASK_PATCH_FILE_SUFFIX}`,
	);
	await lockedFileSystem.writeTextFileAtomic(patchPath, patchChunks.join(""));
}

export async function applyTaskPatch(patchPath: string, worktreePath: string): Promise<void> {
	await getGitStdout(["apply", "--binary", "--whitespace=nowarn", patchPath], worktreePath);
}
