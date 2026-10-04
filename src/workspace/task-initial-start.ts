/**
 * UPD-0: durable state for the runtime-owned initial task-start preparation
 * (base-ref refresh + worktree creation at a fixed baseline).
 *
 * The prepared-baseline record is the authoritative "the base ref was already
 * resolved for this task" signal: once it exists (or any other historical
 * evidence does), neither a restart nor a later ensure may re-resolve the
 * base against a newer origin state. A blocked record (refresh failed before
 * any worktree was created) is also durable so a reconnecting UI can see the
 * last outcome, but it does NOT fix a baseline — a retry is allowed and may
 * fetch again.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { RuntimeTaskBaseRefreshFailure, RuntimeTaskInitialStartStage } from "../core/api-contract";
import { runtimeTaskBaseRefreshFailureSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { readTaskDeliveryReceipt } from "./git-delivery";
import { findTaskPatch } from "./task-patch";
import { readTaskPreservationRecord } from "./task-preservation";
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";

const KANBAN_TASK_INITIAL_START_DIR_NAME = "task-initial-start";

export type TaskInitialStartRecordState = "prepared" | "blocked";

export interface TaskInitialStartRecord {
	taskId: string;
	baseRef: string;
	updateBaseRefBeforeStart: boolean;
	state: TaskInitialStartRecordState;
	/** Fixed only for prepared records; never re-resolved once recorded. */
	baselineSha: string | null;
	failure: RuntimeTaskBaseRefreshFailure | null;
	updatedAt: number;
}

const taskInitialStartRecordSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	updateBaseRefBeforeStart: z.boolean(),
	state: z.enum(["prepared", "blocked"]),
	baselineSha: z.string().nullable(),
	failure: runtimeTaskBaseRefreshFailureSchema.nullable().default(null),
	updatedAt: z.number(),
});

export function getTaskInitialStartRecordPath(taskId: string): string {
	return join(
		getRuntimeHomePath(),
		KANBAN_TASK_INITIAL_START_DIR_NAME,
		normalizeTaskIdForWorktreePath(taskId),
		"record.json",
	);
}

export async function readTaskInitialStartRecord(taskId: string): Promise<TaskInitialStartRecord | null> {
	const recordPath = getTaskInitialStartRecordPath(taskId);
	const raw = await readFile(recordPath, "utf8").catch(() => null);
	if (raw === null) {
		return null;
	}
	const parsed = taskInitialStartRecordSchema.safeParse(JSON.parse(raw));
	return parsed.success ? parsed.data : null;
}

export async function writeTaskInitialStartRecord(record: TaskInitialStartRecord): Promise<void> {
	const recordPath = getTaskInitialStartRecordPath(record.taskId);
	await mkdir(dirname(recordPath), { recursive: true });
	await lockedFileSystem.writeJsonFileAtomic(recordPath, record);
}

// ---------------------------------------------------------------------------
// In-memory live stages (observable while a preparation is in flight; the
// durable record is the source of truth for completed preparations).
// ---------------------------------------------------------------------------

export type TaskInitialStartLiveStage = Exclude<RuntimeTaskInitialStartStage, "idle" | "ready" | "blocked">;

const liveStages = new Map<string, { stage: TaskInitialStartLiveStage; updatedAt: number }>();

export function setInitialStartLiveStage(taskId: string, stage: TaskInitialStartLiveStage): void {
	liveStages.set(normalizeTaskIdForWorktreePath(taskId), { stage, updatedAt: Date.now() });
}

export function getInitialStartLiveStage(taskId: string): TaskInitialStartLiveStage | null {
	return liveStages.get(normalizeTaskIdForWorktreePath(taskId))?.stage ?? null;
}

export function clearInitialStartLiveStage(taskId: string): void {
	liveStages.delete(normalizeTaskIdForWorktreePath(taskId));
}

// ---------------------------------------------------------------------------
// Evidence: the durable signal that a task's initial baseline is fixed and
// must never be re-resolved against a newer origin state.
// ---------------------------------------------------------------------------

export interface TaskInitialStartEvidence {
	/** Fixed baseline SHA from a completed preparation (worktree may be gone). */
	preparedBaselineSha: string | null;
	/** A refresh was attempted and blocked (no worktree, no fixed baseline). */
	hasBlockedRecord: boolean;
	hasPreservationRecord: boolean;
	hasSavedPatch: boolean;
	hasDeliveryReceipt: boolean;
}

export async function getTaskInitialStartEvidence(taskId: string): Promise<TaskInitialStartEvidence> {
	const normalizedTaskId = normalizeTaskIdForWorktreePath(taskId);
	const [record, preservation, storedPatch, receipt] = await Promise.all([
		readTaskInitialStartRecord(normalizedTaskId),
		readTaskPreservationRecord(normalizedTaskId),
		findTaskPatch(normalizedTaskId),
		readTaskDeliveryReceipt(normalizedTaskId),
	]);
	return {
		preparedBaselineSha: record && record.state === "prepared" && record.baselineSha ? record.baselineSha : null,
		hasBlockedRecord: record?.state === "blocked",
		hasPreservationRecord: preservation !== null,
		hasSavedPatch: storedPatch !== null,
		hasDeliveryReceipt: receipt !== null,
	};
}

/**
 * True when the task has already started (durable evidence) and its base ref
 * must not be refreshed. A prior-session flag (durable session records) also
 * counts: a missing directory alone must never classify a task as never
 * started.
 */
export function isInitialStartBaselineFixed(
	evidence: TaskInitialStartEvidence,
	options: { worktreeExists?: boolean; hasPriorSession?: boolean } = {},
): boolean {
	return (
		options.worktreeExists === true ||
		evidence.preparedBaselineSha !== null ||
		evidence.hasPreservationRecord ||
		evidence.hasSavedPatch ||
		evidence.hasDeliveryReceipt ||
		options.hasPriorSession === true
	);
}

// ---------------------------------------------------------------------------
// Pollable status (live stage while in flight, durable outcome when done).
// ---------------------------------------------------------------------------

export interface TaskInitialStartStatus {
	ok: boolean;
	taskId: string;
	stage: RuntimeTaskInitialStartStage;
	baselineSha: string | null;
	initialStartBaselineFixed: boolean;
	failure: RuntimeTaskBaseRefreshFailure | null;
	error?: string;
}

export async function getTaskInitialStartStatus(options: {
	taskId: string;
	worktreeExists?: boolean;
}): Promise<TaskInitialStartStatus> {
	const taskId = normalizeTaskIdForWorktreePath(options.taskId);
	const liveStage = getInitialStartLiveStage(taskId);
	const evidence = await getTaskInitialStartEvidence(taskId);
	const baselineFixed = isInitialStartBaselineFixed(evidence, { worktreeExists: options.worktreeExists });
	if (liveStage !== null) {
		return {
			ok: true,
			taskId,
			stage: liveStage,
			baselineSha: evidence.preparedBaselineSha,
			initialStartBaselineFixed: baselineFixed,
			failure: null,
		};
	}
	const record = await readTaskInitialStartRecord(taskId);
	if (record?.state === "prepared") {
		return {
			ok: true,
			taskId,
			stage: "ready",
			baselineSha: record.baselineSha,
			initialStartBaselineFixed: baselineFixed,
			failure: null,
		};
	}
	if (record?.state === "blocked") {
		return {
			ok: true,
			taskId,
			stage: "blocked",
			baselineSha: null,
			initialStartBaselineFixed: baselineFixed,
			failure: record.failure,
			...(record.failure ? { error: `${record.failure.reason} ${record.failure.remedy}` } : {}),
		};
	}
	return {
		ok: true,
		taskId,
		stage: "idle",
		baselineSha: null,
		initialStartBaselineFixed: baselineFixed,
		failure: null,
	};
}
