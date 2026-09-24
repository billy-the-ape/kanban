// B-4.2 / B-4.3 — durable completion attempt records.
//
// One current attempt per task at
// `<task worktrees home>/<taskId>/completion/attempt.json` (next to the
// review, verification, and delivery artifacts); superseded attempts move to
// `completion/attempts/<attemptId>.json`. Writes use the shared
// locked-file-system conventions (proper-lockfile locks with stale
// detection, atomic rename), so a crashed process never leaves a permanent
// lock (B-4.6).
//
// Schema versioning (B-4.3): every record carries `schemaVersion`. A record
// with an unknown version is reported as unreadable instead of being
// guessed at or overwritten; migrations from older versions go through
// `migrateCompletionAttempt`.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeCompletionAttempt } from "../core/api-contract";
import { runtimeCompletionAttemptSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getTaskWorktreesHomePath } from "../state/workspace-state";
import { normalizeTaskIdForWorktreePath } from "../workspace/task-worktree-path";

export const COMPLETION_ATTEMPT_SCHEMA_VERSION = 1;
const COMPLETION_DIR_NAME = "completion";
const CURRENT_ATTEMPT_FILENAME = "attempt.json";
const ARCHIVED_ATTEMPTS_DIR_NAME = "attempts";
const MAX_HISTORY_ENTRIES = 100;

export type CompletionAttemptReadResult =
	| { kind: "none" }
	| { kind: "attempt"; attempt: RuntimeCompletionAttempt }
	| { kind: "unreadable"; reason: string };

export function getTaskCompletionDir(taskId: string): string {
	return join(getTaskWorktreesHomePath(), normalizeTaskIdForWorktreePath(taskId), COMPLETION_DIR_NAME);
}

function getCurrentAttemptPath(taskId: string): string {
	return join(getTaskCompletionDir(taskId), CURRENT_ATTEMPT_FILENAME);
}

/**
 * B-4.3: brings a stored record to the current schema. Version 1 is the first
 * version, so there is nothing to migrate yet; unknown versions (e.g. written
 * by newer code before a rollback) return null so they are never guessed at.
 */
export function migrateCompletionAttempt(raw: unknown): RuntimeCompletionAttempt | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}
	const version = (raw as { schemaVersion?: unknown }).schemaVersion;
	if (version !== COMPLETION_ATTEMPT_SCHEMA_VERSION) {
		return null;
	}
	const parsed = runtimeCompletionAttemptSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

export async function readCompletionAttempt(taskId: string): Promise<CompletionAttemptReadResult> {
	const rawText = await readFile(getCurrentAttemptPath(taskId), "utf8").catch(() => null);
	if (rawText === null) {
		return { kind: "none" };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(rawText);
	} catch {
		return { kind: "unreadable", reason: "The completion attempt record is not valid JSON." };
	}
	const attempt = migrateCompletionAttempt(raw);
	if (!attempt) {
		const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
		return {
			kind: "unreadable",
			reason: `The completion attempt record (schema version ${String(version)}) is not readable by this version of Kanban; resolve it by hand before completing the task again.`,
		};
	}
	return { kind: "attempt", attempt };
}

/** Persists the attempt (history bounded) as the task's current attempt. */
export async function writeCompletionAttempt(attempt: RuntimeCompletionAttempt): Promise<void> {
	const history =
		attempt.history.length > MAX_HISTORY_ENTRIES ? attempt.history.slice(-MAX_HISTORY_ENTRIES) : attempt.history;
	await lockedFileSystem.writeJsonFileAtomic(
		getCurrentAttemptPath(attempt.taskId),
		runtimeCompletionAttemptSchema.parse({ ...attempt, history }),
	);
}

/**
 * Read-modify-write of the current attempt under its file lock, so a
 * concurrent cancel request and a phase transition never lose each other.
 * Returns the stored result, or null when there is no readable attempt.
 */
export async function updateCompletionAttempt(
	taskId: string,
	mutate: (attempt: RuntimeCompletionAttempt) => RuntimeCompletionAttempt,
): Promise<RuntimeCompletionAttempt | null> {
	const path = getCurrentAttemptPath(taskId);
	return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const current = await readCompletionAttempt(taskId);
		if (current.kind !== "attempt") {
			return null;
		}
		const next = mutate(current.attempt);
		const history =
			next.history.length > MAX_HISTORY_ENTRIES ? next.history.slice(-MAX_HISTORY_ENTRIES) : next.history;
		await lockedFileSystem.writeJsonFileAtomic(path, runtimeCompletionAttemptSchema.parse({ ...next, history }), {
			lock: null,
		});
		return next;
	});
}

/** Moves the current attempt aside (kept for inspection) before a new attempt starts. */
export async function archiveCompletionAttempt(attempt: RuntimeCompletionAttempt): Promise<void> {
	const archivedPath = join(
		getTaskCompletionDir(attempt.taskId),
		ARCHIVED_ATTEMPTS_DIR_NAME,
		`${attempt.attemptId}.json`,
	);
	await lockedFileSystem.writeJsonFileAtomic(archivedPath, attempt);
	await rm(getCurrentAttemptPath(attempt.taskId), { force: true });
}
