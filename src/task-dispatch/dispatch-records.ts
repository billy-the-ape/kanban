// B-9: durable per-task dispatch records. Mirrors the delivery receipt
// persistence pattern: one JSON file per task under the task-state home,
// written atomically. A dispatch record is written *before* the session is
// started and *before* the board mutation, so restart reconciliation can
// always recover what the queue was doing.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeTaskDispatchRecord } from "../core/api-contract";
import { runtimeTaskDispatchRecordSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getTaskWorktreesHomePath } from "../state/workspace-state";
import { normalizeTaskIdForWorktreePath } from "../workspace/task-worktree-path";

const DISPATCH_RECORD_DIR_NAME = "task-dispatch";
const DISPATCH_RECORD_FILENAME = "dispatch.json";

/** Per-task dispatch record directory (mirrors the delivery/review artifact dirs). */
export function getTaskDispatchDir(taskId: string): string {
	return join(getTaskWorktreesHomePath(), normalizeTaskIdForWorktreePath(taskId), DISPATCH_RECORD_DIR_NAME);
}

function getTaskDispatchRecordPath(taskId: string): string {
	return join(getTaskDispatchDir(taskId), DISPATCH_RECORD_FILENAME);
}

/** B-9.4: read the durable dispatch record (null when absent or malformed). */
export async function readTaskDispatchRecord(taskId: string): Promise<RuntimeTaskDispatchRecord | null> {
	const rawText = await readFile(getTaskDispatchRecordPath(taskId), "utf8").catch(() => null);
	if (!rawText) {
		return null;
	}
	try {
		return runtimeTaskDispatchRecordSchema.parse(JSON.parse(rawText));
	} catch {
		return null;
	}
}

export async function writeTaskDispatchRecord(record: RuntimeTaskDispatchRecord): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getTaskDispatchRecordPath(record.taskId), record);
}
