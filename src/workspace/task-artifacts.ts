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
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";

const CONTEXT_ARTIFACTS_DIR_NAME = "context-artifacts";
const ARTIFACT_TOOL_CALL_ID_MAX_CHARS = 80;
const ARTIFACT_RANDOM_SUFFIX_BYTES = 4;

/** Directory that holds this task's oversized tool-result artifacts (created on demand). */
export function getTaskContextArtifactsDir(taskId: string): string {
	return join(getTaskWorktreesHomePath(), normalizeTaskIdForWorktreePath(taskId), CONTEXT_ARTIFACTS_DIR_NAME);
}

/**
 * File name for one artifact: `<sanitized toolCallId>-<timestampMs>-<random>.txt`.
 * Characters that are not filesystem-safe in a tool call id are collapsed to dashes, the id
 * is capped in length, and the timestamp plus random suffix keep same-millisecond writes
 * distinct instead of overwriting each other.
 */
export function buildTaskContextArtifactFileName(
	toolCallId: string,
	timestampMs: number = Date.now(),
	randomSuffix: string = randomBytes(ARTIFACT_RANDOM_SUFFIX_BYTES).toString("hex"),
): string {
	const sanitized = toolCallId
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.slice(0, ARTIFACT_TOOL_CALL_ID_MAX_CHARS)
		.replace(/^[.-]+|[.-]+$/g, "");
	const idPart = sanitized || "tool-call";
	return `${idPart}-${timestampMs}-${randomSuffix}.txt`;
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
}

/**
 * Atomically writes the full tool-result content under this task's context-artifacts
 * directory and returns the absolute artifact path. Uses the locked filesystem so concurrent
 * writers never observe a partial file (lock + temp + rename, parent dirs created on demand).
 */
export async function writeTaskContextArtifact(input: WriteTaskContextArtifactInput): Promise<string> {
	const path = join(
		getTaskContextArtifactsDir(input.taskId),
		buildTaskContextArtifactFileName(input.toolCallId, input.timestampMs ?? Date.now()),
	);
	await lockedFileSystem.writeTextFileAtomic(path, input.content);
	return path;
}

/** Reads back a previously written artifact (verification and agent retrieval). */
export async function readTaskContextArtifact(path: string): Promise<string> {
	return await readFile(path, "utf8");
}
