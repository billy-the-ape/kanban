// B-10.4: durable per-task context-usage event records.
//
// The task's most recent compaction event (what happened, when, before/after
// estimates) is persisted next to the other per-task artifact directories so
// the diagnostics API can report it even after a Kanban restart. Only the
// latest event is kept — the diagnostics surface shows "last compaction",
// not a log (the full log stays in SDK session artifacts).
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeClineContextCompactionEvent } from "../core/api-contract";
import { runtimeClineContextCompactionEventSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getTaskWorktreesHomePath } from "../state/workspace-state";
import { normalizeTaskIdForWorktreePath } from "../workspace/task-worktree-path";

const CONTEXT_EVENTS_DIR_NAME = "context";
const LAST_COMPACTION_FILENAME = "last-compaction.json";

/** Per-task context event directory (sibling to the dispatch/review dirs). */
export function getTaskContextEventsDir(taskId: string): string {
	return join(getTaskWorktreesHomePath(), normalizeTaskIdForWorktreePath(taskId), CONTEXT_EVENTS_DIR_NAME);
}

function getLastCompactionEventPath(taskId: string): string {
	return join(getTaskContextEventsDir(taskId), LAST_COMPACTION_FILENAME);
}

/**
 * B-10.4: durably record the task's latest compaction event (atomic write).
 */
export async function recordTaskCompactionEvent(
	taskId: string,
	event: RuntimeClineContextCompactionEvent,
): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getLastCompactionEventPath(taskId), event);
}

/** B-10.4: read the latest compaction event (null when absent or malformed). */
export async function readTaskCompactionEvent(taskId: string): Promise<RuntimeClineContextCompactionEvent | null> {
	const rawText = await readFile(getLastCompactionEventPath(taskId), "utf8").catch(() => null);
	if (!rawText) {
		return null;
	}
	try {
		return runtimeClineContextCompactionEventSchema.parse(JSON.parse(rawText));
	} catch {
		return null;
	}
}
