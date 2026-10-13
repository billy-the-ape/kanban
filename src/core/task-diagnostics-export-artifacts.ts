// DIAG-2 (2b) — resolve a truncated tool result's full output back from the
// task's context-artifacts directory for the export bundle.
//
// Resolution chain (fixed priority):
// 1. sidecar index: `toolCallId -> fileName` entries recorded by
//    writeTaskContextArtifact (primary; deterministic).
// 2. deterministic filename lookup: artifacts are named
//    `<sanitized toolCallId>-<ts>-<rand>.txt`; the sanitization + 80-char cap can
//    collide, so more than one surviving match is an explicit "ambiguous" gap,
//    never a guess.
// 3. legacy: parse the `Full content: <path>` / `full output: <path>` reference
//    out of the persisted excerpt text for records written before the index.
//
// Every reference is untrusted: it is resolved + realpath'd and must stay
// inside this task's context-artifacts directory (a sibling task's artifact,
// an escape symlink, or a non-file is an explicit "invalid" gap). The content
// is only classified (`json-text` vs `text`) — never parsed and re-serialized.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { readTaskArtifactIndex } from "../workspace/task-artifact-index";
import { getTaskContextArtifactsDir, sanitizeToolCallIdForArtifactName } from "../workspace/task-artifacts";

/** Outcome of resolving a tool result's full output for the export. */
export type TaskArtifactFullOutputStatus = "resolved" | "missing" | "ambiguous" | "invalid";

export interface TaskArtifactFullOutputEvidence {
	status: TaskArtifactFullOutputStatus;
	artifactFileName: string | null;
	artifactPath: string | null;
	/** Classification of the stored content; null until resolved. */
	contentFormat: "json-text" | "text" | null;
	/** Explicit gap explanation when the full output could not be resolved. */
	gap: string | null;
}

/**
 * Character-based excerpt marker (`...[truncated N chars]...`) and command
 * line-based marker (`... [truncated N lines]` / `... [truncated N lines; full
 * output: <path>]`). Either one means the persisted result is a bounded
 * excerpt with a full-content artifact.
 */
export const TASK_ARTIFACT_TRUNCATION_MARKER_PATTERN =
	/\.{3}\s*\[truncated \d+ (?:chars\]\.{3}|lines(?:; full output: [^\]]+)?\])/;

/** Legacy reference patterns in persisted excerpt text (both excerpt families). */
const LEGACY_FULL_OUTPUT_PATTERNS: RegExp[] = [/Full content: (\S+)/, /full output: (\S+)/];

function isContainedInParent(parent: string, candidate: string): boolean {
	return candidate === parent || candidate.startsWith(parent + sep);
}

/**
 * Resolves an untrusted artifact reference against this task's
 * context-artifacts directory. Relative references resolve against the
 * directory; absolute references are accepted only if they stay inside it
 * after realpath (escape symlinks rejected). Returns null for anything that
 * cannot be proven to be a regular file inside the directory.
 */
async function resolveContainedArtifactPath(
	taskId: string,
	reference: string,
): Promise<{ path: string; fileName: string } | null> {
	const dir = getTaskContextArtifactsDir(taskId);
	const candidate = resolve(dir, reference);
	let realPath: string;
	try {
		realPath = await realpath(candidate);
	} catch {
		return null;
	}
	let realDir: string;
	try {
		realDir = await realpath(dir);
	} catch {
		return null;
	}
	if (!isContainedInParent(realDir, realPath)) {
		return null;
	}
	const info = await stat(realPath).catch(() => null);
	if (!info || !info.isFile()) {
		return null;
	}
	return { path: realPath, fileName: basename(realPath) };
}

/** Classifies stored content without ever embedding a parsed copy. */
export async function classifyArtifactContentFormat(artifactPath: string): Promise<"json-text" | "text"> {
	const content = await readFile(artifactPath, "utf8");
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

/**
 * Resolves the full output for one tool result. `persistedResultText` is the
 * text stored in the transcript's tool_result part (needed for the legacy
 * reference step); it may be omitted for tool results that were never
 * excerpted.
 */
export async function resolveTaskToolFullOutput(input: {
	taskId: string;
	toolCallId: string;
	persistedResultText?: string | null;
}): Promise<TaskArtifactFullOutputEvidence> {
	const missing: TaskArtifactFullOutputEvidence = {
		status: "missing",
		artifactFileName: null,
		artifactPath: null,
		contentFormat: null,
		gap: "No surviving artifact records the full output for this tool call.",
	};
	const invalid = (reference: string): TaskArtifactFullOutputEvidence => ({
		status: "invalid",
		artifactFileName: null,
		artifactPath: null,
		contentFormat: null,
		gap: `Recorded artifact reference "${reference}" could not be resolved as a regular file inside this task's context-artifacts directory.`,
	});

	// 1. Primary: sidecar index.
	const index = await readTaskArtifactIndex(input.taskId).catch(() => null);
	const indexedEntries = index ? (index[input.toolCallId] ?? []) : [];
	if (indexedEntries.length > 0) {
		const resolved = (
			await Promise.all(indexedEntries.map((entry) => resolveContainedArtifactPath(input.taskId, entry.fileName)))
		).filter((candidate): candidate is { path: string; fileName: string } => candidate !== null);
		if (resolved.length === 1) {
			return {
				status: "resolved",
				artifactFileName: resolved[0].fileName,
				artifactPath: resolved[0].path,
				contentFormat: await classifyArtifactContentFormat(resolved[0].path).catch(() => "text" as const),
				gap: null,
			};
		}
		if (resolved.length > 1) {
			return {
				status: "ambiguous",
				artifactFileName: null,
				artifactPath: null,
				contentFormat: null,
				gap: "Multiple surviving artifacts match this tool call; refusing to guess which one is authoritative.",
			};
		}
		// Indexed file no longer survives (e.g. partially deleted): fall through
		// to the filename lookup before declaring an invalid reference.
	}

	// 2. Fallback: deterministic filename lookup.
	const prefix = `${sanitizeToolCallIdForArtifactName(input.toolCallId)}-`;
	const entries = await readdir(getTaskContextArtifactsDir(input.taskId)).catch(() => []);
	const matches = entries.filter((name) => name.startsWith(prefix) && name.endsWith(".txt"));
	if (matches.length === 1) {
		const candidate = join(getTaskContextArtifactsDir(input.taskId), matches[0]);
		const info = await stat(candidate).catch(() => null);
		if (info?.isFile()) {
			return {
				status: "resolved",
				artifactFileName: matches[0],
				artifactPath: candidate,
				contentFormat: await classifyArtifactContentFormat(candidate).catch(() => "text" as const),
				gap: null,
			};
		}
	} else if (matches.length > 1) {
		return {
			status: "ambiguous",
			artifactFileName: null,
			artifactPath: null,
			contentFormat: null,
			gap: "Multiple surviving artifacts share this tool call's sanitized file-name prefix; refusing to guess which one is authoritative.",
		};
	}

	// 3. Legacy: reference parsed out of the persisted excerpt text.
	const text = input.persistedResultText ?? "";
	for (const pattern of LEGACY_FULL_OUTPUT_PATTERNS) {
		const match = pattern.exec(text);
		if (!match || typeof match[1] !== "string" || match[1].length === 0) {
			continue;
		}
		const reference = match[1];
		const resolved = await resolveContainedArtifactPath(input.taskId, reference);
		if (!resolved) {
			return invalid(reference);
		}
		return {
			status: "resolved",
			artifactFileName: resolved.fileName,
			artifactPath: resolved.path,
			contentFormat: await classifyArtifactContentFormat(resolved.path).catch(() => "text" as const),
			gap: null,
		};
	}

	return missing;
}
