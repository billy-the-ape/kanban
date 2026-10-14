// B-2.6 — Local artifacts for oversized tool results.
//
// When the tool-result bounding hook (src/cline-sdk/cline-tool-result-bounding-hook.ts)
// shrinks an oversized read-family tool result, the full content is preserved here as a
// plain-text artifact the agent can re-read (in pages) by path.
//
// Placement: `<task worktrees home>/<taskId>/context-artifacts/`, a sibling of the task's
// worktree folder under the per-task home (getTaskWorktreesHomePath). Deliberately outside
// any repository checkout:
// - putting the artifacts inside the task workspace (the card's first proposal,
//   <task-workspace>/.kanban/context-artifacts) dirties the worktree git status with
//   untracked files, which is a stop condition for this card;
// - home-agent sessions run with cwd equal to the repository checkout itself, so nothing
//   under cwd would be safe there either;
// - sitting alongside the task's worktree state directory means deleting the task state
//   directory removes its artifacts with it.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getTaskWorktreesHomePath } from "../state/workspace-state";
import { appendTaskArtifactIndexEntry, classifyTaskArtifactContentFormat } from "./task-artifact-index";
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";

const CONTEXT_ARTIFACTS_DIR_NAME = "context-artifacts";
const ARTIFACT_TOOL_CALL_ID_MAX_CHARS = 80;
const ARTIFACT_RANDOM_SUFFIX_BYTES = 4;

/** Directory that holds this task's oversized tool-result artifacts (created on demand). */
export function getTaskContextArtifactsDir(taskId: string): string {
	return join(getTaskWorktreesHomePath(), normalizeTaskIdForWorktreePath(taskId), CONTEXT_ARTIFACTS_DIR_NAME);
}

/**
 * Sanitizes a tool call id into a deterministic file-name stem. Shared by the
 * artifact file name and the DIAG-2 filename-based export fallback so both stay aligned.
 */
export function sanitizeToolCallIdForArtifactName(toolCallId: string): string {
	const sanitized = toolCallId
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.slice(0, ARTIFACT_TOOL_CALL_ID_MAX_CHARS)
		.replace(/^[.-]+|[.-]+$/g, "");
	return sanitized || "tool-call";
}

/**
 * File name for one artifact: `<sanitized toolCallId>-<timestampMs>-<random>.txt`.
 * The timestamp plus random suffix keep same-millisecond writes distinct instead of
 * overwriting each other.
 */
export function buildTaskContextArtifactFileName(
	toolCallId: string,
	timestampMs: number = Date.now(),
	randomSuffix: string = randomBytes(ARTIFACT_RANDOM_SUFFIX_BYTES).toString("hex"),
): string {
	return `${sanitizeToolCallIdForArtifactName(toolCallId)}-${timestampMs}-${randomSuffix}.txt`;
}

export interface WriteTaskContextArtifactInput {
	/** Task that owns the artifact directory. */
	taskId: string;
	/** Tool call id whose result this artifact preserves (used only for the file name). */
	toolCallId: string;
	/** Full, untruncated tool result content (serialized). */
	content: string;
	/** Timestamp injection for deterministic file names (tests). */
	timestampMs?: number;
	/**
	 * DIAG-2: best-effort sidecar index write is diagnostic-only. A failure is
	 * reported here (so the caller can log it) and never rejects the write,
	 * mirroring how an artifact write failure is treated.
	 */
	onIndexWriteError?: (error: unknown) => void;
}

/**
 * Atomically writes the full tool-result content under this task's context-artifacts
 * directory and returns the absolute artifact path. Uses the locked filesystem so concurrent
 * writers never observe a partial file (lock + temp + rename, parent dirs created on demand).
 *
 * After the artifact is written, a `toolCallId -> fileName` entry is appended to the
 * best-effort sidecar index (DIAG-2) so an export can resolve the full output without
 * guessing the file name; an index failure is reported through `input.onIndexWriteError`.
 */
export async function writeTaskContextArtifact(input: WriteTaskContextArtifactInput): Promise<string> {
	const fileName = buildTaskContextArtifactFileName(input.toolCallId, input.timestampMs ?? Date.now());
	const path = join(getTaskContextArtifactsDir(input.taskId), fileName);
	await lockedFileSystem.writeTextFileAtomic(path, input.content);
	// Record the content classification alongside the file reference so an
	// export can label the artifact without re-reading it (DIAG-2).
	try {
		await appendTaskArtifactIndexEntry({
			taskId: input.taskId,
			toolCallId: input.toolCallId,
			fileName,
			contentFormat: classifyTaskArtifactContentFormat(input.content),
		});
	} catch (error) {
		input.onIndexWriteError?.(error);
	}
	return path;
}

/** Reads back a previously written artifact (verification and agent retrieval). */
export async function readTaskContextArtifact(path: string): Promise<string> {
	return await readFile(path, "utf8");
}
