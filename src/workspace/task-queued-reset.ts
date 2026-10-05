import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import { runGit } from "./git-utils";
import {
	clearTaskInitialStartRecord,
	getTaskInitialStartEvidence,
	readTaskInitialStartRecord,
} from "./task-initial-start";
import {
	clearUnstartedTaskPreservation,
	getTaskPreservationDir,
	getTaskPreservationRefName,
	readTaskPreservationRecord,
} from "./task-preservation";
import { getTaskWorktreePath, getTaskWorktreeSetupLock } from "./task-worktree";

/** Withdraw only an untouched initial preparation; ordinary cleanup preserves historical work. */
export async function resetUnstartedQueuedWorktree(input: {
	repoPath: string;
	taskId: string;
	withdraw: () => Promise<boolean>;
}): Promise<void> {
	await lockedFileSystem.withLock(await getTaskWorktreeSetupLock(input.repoPath), async () => {
		const worktree = getTaskWorktreePath(input.repoPath, input.taskId);
		const [record, evidence, preservation] = await Promise.all([
			readTaskInitialStartRecord(input.taskId),
			getTaskInitialStartEvidence(input.taskId),
			readTaskPreservationRecord(input.taskId),
		]);
		const baseline = record?.state === "prepared" ? record.baselineSha : null;
		if (
			!baseline ||
			evidence.hasSavedPatch ||
			evidence.hasDeliveryReceipt ||
			(preservation &&
				(preservation.status !== "active" ||
					preservation.startingCommit !== baseline ||
					preservation.latestCommit !== baseline ||
					preservation.archivePath ||
					preservation.patchPath ||
					preservation.preservedAt ||
					resolve(preservation.repoPath) !== resolve(input.repoPath) ||
					resolve(preservation.worktreePath) !== resolve(worktree)))
		) {
			throw new Error("This task has prior work or recovery history and cannot return to Backlog.");
		}
		const assets = await readdir(getTaskPreservationDir(input.taskId)).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		if (assets.some((name) => name !== "manifest.json")) throw new Error("Task has saved recovery assets.");
		const [head, branch, status, ignored, recoveryRef] = await Promise.all([
			runGit(worktree, ["rev-parse", "HEAD^{commit}"]),
			runGit(worktree, ["symbolic-ref", "-q", "HEAD"]),
			runGit(worktree, ["status", "--porcelain", "--untracked-files=all"]),
			runGit(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
			runGit(input.repoPath, ["rev-parse", "--verify", `${getTaskPreservationRefName(input.taskId)}^{commit}`]),
		]);
		if (
			!head.ok ||
			head.stdout !== baseline ||
			branch.ok ||
			!status.ok ||
			status.stdout ||
			!ignored.ok ||
			(preservation && !recoveryRef.ok) ||
			(recoveryRef.ok && recoveryRef.stdout !== baseline)
		) {
			throw new Error("The task worktree has edits, commits, or a branch and cannot return to Backlog.");
		}
		// Preparation mirrors ignored dependencies/config as symlinks. Keep their source data;
		// refuse to remove any actual ignored files or generated directories.
		for (const path of ignored.stdout.split("\0").filter(Boolean)) {
			if (!(await lstat(join(worktree, path.replace(/\/$/, "")))).isSymbolicLink()) {
				throw new Error("The task worktree has ignored files and cannot return to Backlog.");
			}
		}
		if (!(await input.withdraw())) throw new Error("Task is no longer waiting; it cannot return to Backlog.");
		const removed = await runGit(input.repoPath, ["worktree", "remove", worktree]);
		if (!removed.ok) throw new Error(removed.output || "Could not remove the queued worktree.");
		await clearUnstartedTaskPreservation(input.repoPath, input.taskId, recoveryRef.ok ? baseline : null);
		await clearTaskInitialStartRecord(input.taskId);
	});
}
