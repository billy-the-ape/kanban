// B-5.7 / B-5.9 — workspace maintenance: reconcilable cleanup and retention.
//
// One pass over a workspace's board and preservation records:
//
// 1. B-5.9 reconciliation: a Trash card whose worktree still exists is a
//    cleanup that was blocked or interrupted; retry it (preservation-gated,
//    never while its agent session is writing). Blocked reasons stay visible
//    on the preservation record and in the report.
// 2. B-5.7 disposal: a Done card with a completed delivery receipt no longer
//    needs its worktree — the receipt plus the preservation archive are the
//    recovery path — so the worktree is removed (preservation-gated).
// 3. B-5.7 retention: preservation assets (archive, patch, recovery ref) of
//    delivered or discarded work are pruned once they are older than the
//    retention period, and oldest-first while the workspace's total exceeds
//    the size cap. Undelivered work (anything still on the board outside
//    Trash, or Done without a delivery receipt) is never pruned automatically;
//    when it is past the retention period or the cap cannot be met it is
//    reported as flagged instead.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { RuntimeBoardData, RuntimeGitDeliveryReceipt, RuntimeTaskPreservationRecord } from "../core/api-contract";
import { isDeliveryReceiptComplete } from "./git-delivery";
import {
	listTaskPreservationRecords,
	measureTaskPreservationBytes,
	readTaskPreservationRecord,
	removeTaskPreservationAssets,
} from "./task-preservation";
import { deleteTaskWorktree, taskWorktreeExists } from "./task-worktree";
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Records store the repo path as given; compare symlink-resolved paths (macOS /tmp, home symlinks). */
function canonicalizeRepoPath(path: string): string {
	try {
		return realpathSync.native(resolve(path));
	} catch {
		return resolve(path);
	}
}

export interface TaskWorkspaceRetentionPolicy {
	/** Days after delivery or discard that preservation assets are kept. */
	archiveRetentionDays: number;
	/** Cap for this workspace's preservation assets; eligible assets are pruned oldest-first above it. */
	maxArchiveBytes: number;
	/** Remove a Done task's worktree once its delivery receipt is complete. */
	removeDeliveredWorktrees: boolean;
}

export const DEFAULT_TASK_WORKSPACE_RETENTION_POLICY: TaskWorkspaceRetentionPolicy = {
	archiveRetentionDays: 30,
	maxArchiveBytes: 5 * 1024 * 1024 * 1024,
	removeDeliveredWorktrees: true,
};

export interface TaskWorkspaceMaintenanceReport {
	/** Worktrees removed: trash cleanups that now succeeded, and delivered Done tasks. */
	removedWorktrees: string[];
	/** Cleanups that are still blocked, with the reason (B-5.9 visibility). */
	blockedCleanups: Array<{ taskId: string; reason: string }>;
	/** Tasks whose preservation assets were pruned by retention. */
	prunedPreservation: string[];
	/** Undelivered work kept past the retention period or over the cap (never pruned automatically). */
	flaggedPreservation: Array<{ taskId: string; reason: string }>;
	/** This workspace's preservation assets after the pass, in bytes. */
	preservationBytes: number;
}

export interface RunTaskWorkspaceMaintenanceInput {
	repoPath: string;
	board: RuntimeBoardData;
	readDeliveryReceipt: (taskId: string) => Promise<RuntimeGitDeliveryReceipt | null>;
	/** B-5.5: true while the task's agent session is still writing (cleanup is skipped). */
	isTaskWriterActive?: (taskId: string) => Promise<boolean>;
	policy?: TaskWorkspaceRetentionPolicy;
	now?: number;
}

interface BoardPlacement {
	columnId: RuntimeBoardData["columns"][number]["id"];
	updatedAt: number;
}

function indexBoard(board: RuntimeBoardData): Map<string, BoardPlacement> {
	const placements = new Map<string, BoardPlacement>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			placements.set(normalizeTaskIdForWorktreePath(card.id), { columnId: column.id, updatedAt: card.updatedAt });
		}
	}
	return placements;
}

/**
 * When the task's work stopped needing its preservation assets (delivery or
 * discard), or null when it still does (undelivered work).
 */
function resolveRetentionStart(
	record: RuntimeTaskPreservationRecord,
	placement: BoardPlacement | undefined,
	receipt: RuntimeGitDeliveryReceipt | null,
): number | null {
	if (!placement) {
		// Cleared from the board entirely: discarded.
		return record.updatedAt;
	}
	if (placement.columnId === "trash") {
		return placement.updatedAt;
	}
	if (placement.columnId === "done" && receipt && isDeliveryReceiptComplete(receipt)) {
		return receipt.updatedAt;
	}
	return null;
}

export async function runTaskWorkspaceMaintenance(
	input: RunTaskWorkspaceMaintenanceInput,
): Promise<TaskWorkspaceMaintenanceReport> {
	const policy = input.policy ?? DEFAULT_TASK_WORKSPACE_RETENTION_POLICY;
	const now = input.now ?? Date.now();
	const isWriterActive = input.isTaskWriterActive ?? (async () => false);
	const report: TaskWorkspaceMaintenanceReport = {
		removedWorktrees: [],
		blockedCleanups: [],
		prunedPreservation: [],
		flaggedPreservation: [],
		preservationBytes: 0,
	};
	const placements = indexBoard(input.board);
	const receipts = new Map<string, RuntimeGitDeliveryReceipt | null>();
	const readReceipt = async (taskId: string) => {
		if (!receipts.has(taskId)) {
			receipts.set(taskId, await input.readDeliveryReceipt(taskId).catch(() => null));
		}
		return receipts.get(taskId) ?? null;
	};

	// 1 + 2: trash reconciliation and delivered Done disposal.
	for (const [taskId, placement] of placements) {
		const isTrash = placement.columnId === "trash";
		const isDeliveredDone =
			placement.columnId === "done" &&
			policy.removeDeliveredWorktrees &&
			isDeliveryReceiptComplete(await readReceipt(taskId));
		if (!isTrash && !isDeliveredDone) {
			continue;
		}
		if (!(await taskWorktreeExists(input.repoPath, taskId))) {
			continue;
		}
		if (await isWriterActive(taskId)) {
			report.blockedCleanups.push({ taskId, reason: "The task's agent session is still running." });
			continue;
		}
		const deleted = await deleteTaskWorktree({ repoPath: input.repoPath, taskId });
		if (deleted.ok && deleted.removed) {
			report.removedWorktrees.push(taskId);
		} else if (!deleted.ok) {
			report.blockedCleanups.push({
				taskId,
				reason: deleted.blockedReason ?? deleted.error ?? "Worktree cleanup failed.",
			});
		}
	}

	// 3: retention of preservation assets for this workspace.
	const repoIdentity = canonicalizeRepoPath(input.repoPath);
	const records = (await listTaskPreservationRecords()).filter(
		(record) => canonicalizeRepoPath(record.repoPath) === repoIdentity,
	);
	const candidates: Array<{ taskId: string; retentionStart: number; bytes: number }> = [];
	for (const record of records) {
		const taskId = normalizeTaskIdForWorktreePath(record.taskId);
		const bytes = await measureTaskPreservationBytes(taskId);
		if (await taskWorktreeExists(input.repoPath, taskId)) {
			// A live worktree's record is its backup; never prune it.
			report.preservationBytes += bytes;
			continue;
		}
		const placement = placements.get(taskId);
		const retentionStart = resolveRetentionStart(record, placement, await readReceipt(taskId));
		if (retentionStart === null) {
			report.preservationBytes += bytes;
			if (now - record.updatedAt > policy.archiveRetentionDays * DAY_MS) {
				report.flaggedPreservation.push({
					taskId,
					reason: `Preserved work was never delivered (task is in ${placement?.columnId ?? "an unknown column"}); it is kept until the task is delivered or discarded.`,
				});
			}
			continue;
		}
		if (now - retentionStart > policy.archiveRetentionDays * DAY_MS) {
			await removeTaskPreservationAssets(input.repoPath, taskId);
			report.prunedPreservation.push(taskId);
			continue;
		}
		candidates.push({ taskId, retentionStart, bytes });
		report.preservationBytes += bytes;
	}

	candidates.sort((left, right) => left.retentionStart - right.retentionStart);
	for (const candidate of candidates) {
		if (report.preservationBytes <= policy.maxArchiveBytes) {
			break;
		}
		await removeTaskPreservationAssets(input.repoPath, candidate.taskId);
		report.prunedPreservation.push(candidate.taskId);
		report.preservationBytes -= candidate.bytes;
	}
	if (report.preservationBytes > policy.maxArchiveBytes) {
		report.flaggedPreservation.push({
			taskId: "*",
			reason: `Preserved work uses ${report.preservationBytes} bytes, above the ${policy.maxArchiveBytes}-byte cap, but everything left is undelivered or still in use; nothing more is pruned automatically.`,
		});
	}
	return report;
}

/**
 * B-5.9: Trash cards whose worktree cleanup is still blocked, with the
 * recorded reason — what the board shows on those cards.
 */
export async function listBlockedTaskCleanups(input: {
	repoPath: string;
	board: RuntimeBoardData;
}): Promise<Array<{ taskId: string; reason: string }>> {
	const trashCards = input.board.columns.find((column) => column.id === "trash")?.cards ?? [];
	const blocked: Array<{ taskId: string; reason: string }> = [];
	for (const card of trashCards) {
		if (!(await taskWorktreeExists(input.repoPath, card.id))) {
			continue;
		}
		const record = await readTaskPreservationRecord(card.id);
		blocked.push({
			taskId: card.id,
			reason:
				record?.cleanupBlockedReason ??
				(record?.status === "blocked" ? record.blockedReasons.join("; ") : null) ??
				"The worktree has not been cleaned up yet; it is retried automatically.",
		});
	}
	return blocked;
}
