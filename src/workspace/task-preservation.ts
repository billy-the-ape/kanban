import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import type { RuntimeTaskPreservationRecord } from "../core/api-contract";
import { runtimeTaskPreservationRecordSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { runGit } from "./git-utils";
import { applyTaskPatch, captureTaskPatch, deleteTaskPatchFiles, findTaskPatch } from "./task-patch";
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";

const execFileAsync = promisify(execFile);

const KANBAN_TASK_PRESERVATION_DIR_NAME = "task-preservation";
const TASK_PRESERVATION_MANIFEST_FILENAME = "manifest.json";
const TASK_PRESERVATION_ARCHIVE_FILENAME = "archive.tar.gz";
const TASK_PRESERVATION_REF_PREFIX = "refs/kanban/tasks/";

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Durable, namespaced recovery ref for a task. Keeping the ref updated while
 * the worktree is alive (not only at deletion time) means an unpushed task
 * commit is recoverable even if the process is killed before cleanup runs.
 */
export function getTaskPreservationRefName(taskId: string): string {
	return `${TASK_PRESERVATION_REF_PREFIX}${normalizeTaskIdForWorktreePath(taskId)}`;
}

export function getTaskPreservationDir(taskId: string): string {
	return join(getRuntimeHomePath(), KANBAN_TASK_PRESERVATION_DIR_NAME, normalizeTaskIdForWorktreePath(taskId));
}

function getTaskPreservationManifestPath(taskId: string): string {
	return join(getTaskPreservationDir(taskId), TASK_PRESERVATION_MANIFEST_FILENAME);
}

function getTaskPreservationArchivePath(taskId: string): string {
	return join(getTaskPreservationDir(taskId), TASK_PRESERVATION_ARCHIVE_FILENAME);
}

export async function readTaskPreservationRecord(taskId: string): Promise<RuntimeTaskPreservationRecord | null> {
	const raw = await readFile(getTaskPreservationManifestPath(taskId), "utf8").catch(() => null);
	if (!raw) {
		return null;
	}
	try {
		const parsed = runtimeTaskPreservationRecordSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

async function writeTaskPreservationRecord(record: RuntimeTaskPreservationRecord): Promise<void> {
	await mkdir(getTaskPreservationDir(record.taskId), { recursive: true });
	await lockedFileSystem.writeJsonFileAtomic(getTaskPreservationManifestPath(record.taskId), record);
}

async function writeTaskWorktreeArchive(worktreePath: string, taskId: string): Promise<string> {
	const archivePath = getTaskPreservationArchivePath(taskId);
	await mkdir(dirname(archivePath), { recursive: true });
	await rm(archivePath, { force: true });
	// Full snapshot of the worktree (tracked, untracked, and binary content).
	// .git is a pointer file for linked worktrees and must not be archived.
	await execFileAsync("tar", [
		"czf",
		archivePath,
		"--exclude=.git",
		"-C",
		dirname(worktreePath),
		basename(worktreePath),
	]);
	return archivePath;
}

export async function extractTaskWorktreeArchive(archivePath: string, worktreePath: string): Promise<void> {
	// The archive stores a top-level directory named after the worktree, so
	// extract into the parent to merge contents into the existing worktree.
	await execFileAsync("tar", ["xzf", archivePath, "-C", dirname(worktreePath)]);
}

/**
 * Durably preserves a task worktree before it may be removed:
 *  - binary patch of uncommitted tracked + untracked changes (best-effort),
 *  - refs/kanban/tasks/<id> pointing at the latest worktree commit,
 *  - full tar archive of the worktree (authoritative for untracked/binary state).
 *
 * A failed archive write blocks cleanup (B-5.3): without the full snapshot,
 * uncommitted or untracked work could be lost.
 */
export async function preserveTaskWorktree(options: {
	repoPath: string;
	taskId: string;
	worktreePath: string;
}): Promise<{
	preserved: boolean;
	blockedReasons: string[];
	record: RuntimeTaskPreservationRecord;
}> {
	const taskId = normalizeTaskIdForWorktreePath(options.taskId);
	const warnings: string[] = [];
	const blockedReasons: string[] = [];

	let latestCommit: string | null = null;
	const headResult = await runGit(options.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (headResult.ok && headResult.stdout) {
		latestCommit = headResult.stdout;
	}

	try {
		await captureTaskPatch({
			repoPath: options.repoPath,
			taskId,
			worktreePath: options.worktreePath,
		});
	} catch (error) {
		warnings.push(`Patch capture failed: ${toErrorMessage(error)}`);
	}
	const storedPatch = await findTaskPatch(taskId);

	const refName = getTaskPreservationRefName(taskId);
	let refCommit: string | null = null;
	if (latestCommit) {
		const updateRefResult = await runGit(options.repoPath, ["update-ref", refName, latestCommit]);
		if (updateRefResult.ok) {
			refCommit = latestCommit;
		} else {
			warnings.push(
				`Could not update preservation ref ${refName}: ${updateRefResult.error ?? updateRefResult.stderr}`,
			);
		}
	}

	let archivePath: string | null = null;
	try {
		archivePath = await writeTaskWorktreeArchive(options.worktreePath, taskId);
	} catch (error) {
		blockedReasons.push(`Could not write task worktree archive: ${toErrorMessage(error)}`);
	}

	const existing = await readTaskPreservationRecord(taskId);
	const now = Date.now();
	const preserved = blockedReasons.length === 0;
	const record: RuntimeTaskPreservationRecord = {
		taskId: options.taskId,
		worktreePath: options.worktreePath,
		repoPath: options.repoPath,
		startingCommit: existing?.startingCommit ?? latestCommit,
		latestCommit,
		status: preserved ? "preserved" : "blocked",
		blockedReasons: [...blockedReasons, ...warnings],
		patchPath: storedPatch?.path ?? null,
		archivePath,
		refName: refCommit ? refName : null,
		preservedAt: preserved ? now : (existing?.preservedAt ?? null),
		updatedAt: now,
	};
	try {
		await writeTaskPreservationRecord(record);
	} catch (error) {
		record.status = "blocked";
		blockedReasons.push(`Could not write preservation manifest: ${toErrorMessage(error)}`);
		record.blockedReasons = [...blockedReasons, ...warnings];
	}

	return {
		preserved,
		blockedReasons,
		record,
	};
}

/**
 * Best-effort bookkeeping while a worktree is alive: keep the preservation
 * ref and record in sync with the live worktree so the latest known commit is
 * always durable (B-5.2). Never throws.
 */
export async function syncTaskPreservationActivity(options: {
	repoPath: string;
	taskId: string;
	worktreePath: string;
	headCommit: string | null;
	startingCommit?: string | null;
}): Promise<void> {
	try {
		const existing = await readTaskPreservationRecord(options.taskId);
		const headCommit = options.headCommit;
		const refName = getTaskPreservationRefName(options.taskId);
		if (headCommit) {
			await runGit(options.repoPath, ["update-ref", refName, headCommit]).catch(() => undefined);
		}
		const record: RuntimeTaskPreservationRecord = {
			taskId: options.taskId,
			worktreePath: options.worktreePath,
			repoPath: options.repoPath,
			startingCommit: options.startingCommit ?? existing?.startingCommit ?? headCommit,
			latestCommit: headCommit ?? existing?.latestCommit ?? null,
			status: "active",
			blockedReasons: [],
			patchPath: existing?.patchPath ?? null,
			archivePath: existing?.archivePath ?? null,
			refName: headCommit ? refName : (existing?.refName ?? null),
			preservedAt: existing?.preservedAt ?? null,
			updatedAt: Date.now(),
		};
		await writeTaskPreservationRecord(record);
	} catch {
		// Preservation bookkeeping must never break worktree operations.
	}
}

export interface TaskPreservationRestoreTarget {
	// Commit to check out (preserved ref first, then last known commit). Null
	// means the caller should fall back to its normal base ref resolution.
	commit: string | null;
	patch: { path: string; commit: string } | null;
	archivePath: string | null;
}

/**
 * Resolves what a restored worktree should be built from (B-5.6: the preserved
 * task revision, not an older base). Returns null when no preservation data
 * exists for the task.
 */
export async function resolveTaskPreservationRestoreTarget(options: {
	repoPath: string;
	taskId: string;
}): Promise<TaskPreservationRestoreTarget | null> {
	const taskId = normalizeTaskIdForWorktreePath(options.taskId);
	const record = await readTaskPreservationRecord(taskId);
	if (!record) {
		return null;
	}

	const refName = record.refName ?? getTaskPreservationRefName(taskId);
	const refResult = await runGit(options.repoPath, ["rev-parse", "--verify", `${refName}^{commit}`]);
	if (refResult.ok && refResult.stdout) {
		return {
			commit: refResult.stdout,
			patch: await findTaskPatch(taskId),
			archivePath: record.archivePath && (await pathExists(record.archivePath)) ? record.archivePath : null,
		};
	}

	if (record.latestCommit) {
		const latestResult = await runGit(options.repoPath, ["cat-file", "-e", `${record.latestCommit}^{commit}`]);
		if (latestResult.ok) {
			return {
				commit: record.latestCommit,
				patch: await findTaskPatch(taskId),
				archivePath: record.archivePath && (await pathExists(record.archivePath)) ? record.archivePath : null,
			};
		}
	}

	const archivePath = record.archivePath && (await pathExists(record.archivePath)) ? record.archivePath : null;
	if (!archivePath) {
		return null;
	}
	return {
		commit: null,
		patch: await findTaskPatch(taskId),
		archivePath,
	};
}

/**
 * Reapplies preserved uncommitted changes onto a freshly restored worktree.
 * Prefers the binary patch when it matches the checked-out commit, otherwise
 * overlays the full archive snapshot.
 */
export async function applyPreservedWorktreeContent(options: {
	taskId: string;
	worktreePath: string;
	checkedOutCommit: string | null;
	patch: { path: string; commit: string } | null;
	archivePath: string | null;
}): Promise<string | undefined> {
	if (options.patch && options.checkedOutCommit && options.patch.commit === options.checkedOutCommit) {
		try {
			await applyTaskPatch(options.patch.path, options.worktreePath);
			await rm(options.patch.path, { force: true });
			return undefined;
		} catch (error) {
			if (options.archivePath) {
				try {
					await extractTaskWorktreeArchive(options.archivePath, options.worktreePath);
					return undefined;
				} catch {
					// Fall through to the error message below.
				}
			}
			return `Preserved task changes could not be reapplied automatically. ${toErrorMessage(error)}`;
		}
	}
	if (options.archivePath) {
		try {
			await extractTaskWorktreeArchive(options.archivePath, options.worktreePath);
			return undefined;
		} catch (error) {
			return `Preserved task snapshot could not be restored automatically. ${toErrorMessage(error)}`;
		}
	}
	return undefined;
}

/**
 * Permanently removes preservation assets (manifest, archive, patches, and
 * the recovery ref) for a task. Only use for explicit disposal.
 */
export async function removeTaskPreservationAssets(repoPath: string, taskId: string): Promise<void> {
	const normalizedTaskId = normalizeTaskIdForWorktreePath(taskId);
	await rm(getTaskPreservationDir(normalizedTaskId), { recursive: true, force: true }).catch(() => undefined);
	await deleteTaskPatchFiles(normalizedTaskId).catch(() => undefined);
	await runGit(repoPath, ["update-ref", "-d", getTaskPreservationRefName(taskId)]).catch(() => undefined);
}
