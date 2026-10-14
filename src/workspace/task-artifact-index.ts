// DIAG-2 (2b) — best-effort sidecar index mapping tool call ids to the full
// tool-result artifact file names under a task's context-artifacts directory.
//
// The index lives next to the artifacts it describes so an export can resolve
// `toolCallId -> artifact file` without scanning or guessing. It is
// diagnostic-only: a failed index write never affects the session or the
// already-written artifact (the B-2.6 hook logs it and keeps its excerpt).
//
// Concurrency: the read-append-write cycle runs under `withLock` on the index
// file with a `path` distinct from the artifact files' lock paths (proper-lockfile
// keys its in-process lock map by `path`), and the write inside the lock uses the
// `lock: null` option so the atomic temp+rename does not take a second lock on a
// path an outer acquisition owns.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getTaskContextArtifactsDir } from "./task-artifacts";

export const TASK_ARTIFACT_INDEX_FILE_NAME = "tool-artifact-index.json";
const TASK_ARTIFACT_INDEX_LOCK_FILE_NAME = ".tool-artifact-index.lock";

/** One recorded artifact write; a tool call id can accumulate several (retries). */
export interface TaskArtifactIndexEntry {
	toolCallId: string;
	fileName: string;
	writtenAt: string;
	/**
	 * DIAG-2: content classification recorded at archive time so an export can
	 * label the artifact without re-reading (and re-parsing) a potentially
	 * large file before the download response starts.
	 */
	contentFormat?: TaskArtifactContentFormat;
}

/** toolCallId -> artifact entries in append order. */
export type TaskArtifactIndex = Record<string, TaskArtifactIndexEntry[]>;

/** Classification of stored artifact content. */
export type TaskArtifactContentFormat = "json-text" | "text";

/**
 * Classifies already-in-memory content at archive time (same rules as the
 * export's streaming classifier in src/core/task-diagnostics-export-artifacts).
 * Runs once per artifact write, when the content is already loaded for the
 * write itself.
 */
export function classifyTaskArtifactContentFormat(content: string): TaskArtifactContentFormat {
	const trimmed = content.trim();
	if (trimmed.length === 0 || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
		return "text";
	}
	try {
		JSON.parse(trimmed);
		return "json-text";
	} catch {
		return "text";
	}
}

export function getTaskContextArtifactsIndexPath(taskId: string): string {
	return join(getTaskContextArtifactsDir(taskId), TASK_ARTIFACT_INDEX_FILE_NAME);
}

function isTaskArtifactIndex(value: unknown): value is TaskArtifactIndex {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return Object.entries(value).every(([, entries]) => {
		if (!Array.isArray(entries)) {
			return false;
		}
		return entries.every(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				typeof entry.toolCallId === "string" &&
				typeof entry.fileName === "string" &&
				typeof entry.writtenAt === "string" &&
				(entry.contentFormat === undefined ||
					entry.contentFormat === "json-text" ||
					entry.contentFormat === "text"),
		);
	});
}

/**
 * Reads the sidecar index. A missing file is an empty index; a corrupt file
 * degrades to empty so the next append rebuilds it rather than failing.
 */
export async function readTaskArtifactIndex(taskId: string): Promise<TaskArtifactIndex> {
	const raw = await readFile(getTaskContextArtifactsIndexPath(taskId), "utf8").catch(() => null);
	if (raw === null) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return isTaskArtifactIndex(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Appends one entry to the sidecar index under the index-file lock. The lock
 * request's `path` is the index file itself — distinct from the artifact files'
 * lock paths — and the write inside the lock passes `lock: null`.
 */
export async function appendTaskArtifactIndexEntry(input: {
	taskId: string;
	toolCallId: string;
	fileName: string;
	contentFormat?: TaskArtifactContentFormat;
}): Promise<void> {
	const indexPath = getTaskContextArtifactsIndexPath(input.taskId);
	await lockedFileSystem.withLock(
		{
			type: "file",
			path: indexPath,
			lockfilePath: join(getTaskContextArtifactsDir(input.taskId), TASK_ARTIFACT_INDEX_LOCK_FILE_NAME),
		},
		async () => {
			const index = await readTaskArtifactIndex(input.taskId);
			const entry: TaskArtifactIndexEntry = {
				toolCallId: input.toolCallId,
				fileName: input.fileName,
				writtenAt: new Date().toISOString(),
				...(input.contentFormat !== undefined ? { contentFormat: input.contentFormat } : {}),
			};
			const existing = index[input.toolCallId];
			if (existing) {
				existing.push(entry);
			} else {
				index[input.toolCallId] = [entry];
			}
			await lockedFileSystem.writeTextFileAtomic(indexPath, JSON.stringify(index, null, 2), { lock: null });
		},
	);
}
