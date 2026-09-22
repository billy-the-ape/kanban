// B-6.1 + B-6.7 — Review handoff artifacts and durable review outcomes.
//
// A review session must start from a *fresh* context: no implementation
// transcript, no shared memory. The handoff artifact is the complete,
// authoritative briefing a reviewer needs — the task description criteria,
// plan documents (fingerprinted at handoff time), the recorded starting
// revision, and the exact change set (tracked changes + untracked files).
//
// Placement: `<task worktrees home>/<taskId>/review/`, a sibling of the
// task's worktree folder (mirrors context-artifacts in task-artifacts.ts).
// Deliberately outside any repository checkout so building the handoff never
// dirties the worktree's git status, and deleting the task state directory
// removes the artifacts with it.
//
// The outcome file (B-6.7) durably records the last review verdict for the
// task. Results are bound to a candidate tree hash (the content hash of the
// tracked + untracked worktree state) so callers can tell when later edits
// invalidated a stored "ready" verdict.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type {
	RuntimeReviewHandoffArtifact,
	RuntimeReviewHandoffPlanDocument,
	RuntimeReviewOutcomeFile,
} from "../core/api-contract";
import { runtimeReviewHandoffArtifactSchema, runtimeReviewOutcomeFileSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getTaskWorktreesHomePath, loadWorkspaceBoardById } from "../state/workspace-state";
import { readGitHeadInfo, runGit } from "./git-utils";
import { readTaskPreservationRecord } from "./task-preservation";
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";

const REVIEW_ARTIFACTS_DIR_NAME = "review";
const REVIEW_HANDOFF_FILENAME = "handoff.json";
const REVIEW_OUTCOME_FILENAME = "outcome.json";

/** Per-task directory for review handoff + outcome artifacts (created on demand). */
export function getTaskReviewDir(taskId: string): string {
	return join(getTaskWorktreesHomePath(), normalizeTaskIdForWorktreePath(taskId), REVIEW_ARTIFACTS_DIR_NAME);
}

function getTaskReviewHandoffPath(taskId: string): string {
	return join(getTaskReviewDir(taskId), REVIEW_HANDOFF_FILENAME);
}

function getTaskReviewOutcomePath(taskId: string): string {
	return join(getTaskReviewDir(taskId), REVIEW_OUTCOME_FILENAME);
}

/** Splits `git diff --name-only` output into sorted unique paths (rename lines keep the new name). */
function parseNameOnlyOutput(output: string): string[] {
	const paths = new Set<string>();
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line) {
			continue;
		}
		// Rename entries are emitted as `old\tnew`; keep the destination path.
		const path = line.includes("\t") ? line.split("\t").pop() : line;
		if (path) {
			paths.add(path);
		}
	}
	return [...paths].sort((a, b) => a.localeCompare(b));
}

/** Untracked (not ignored) files in the worktree, sorted. */
async function listUntrackedPaths(worktreePath: string): Promise<string[]> {
	const result = await runGit(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
	if (!result.ok) {
		return [];
	}
	return parseNameOnlyOutput(result.stdout);
}

/**
 * Tracked working-tree changes vs `startingCommit` (covers committed +
 * uncommitted). Falls back to HEAD when the recorded start is not reachable
 * (e.g. stale preservation record), and to HEAD-only changes when no start
 * was ever recorded.
 */
async function listTrackedChangedPaths(worktreePath: string, startingCommit: string | null): Promise<string[]> {
	const head = await readGitHeadInfo(worktreePath);
	let base = startingCommit ?? null;
	if (base) {
		const reachable = await runGit(worktreePath, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
		if (!reachable.ok) {
			base = null;
		}
	}
	if (!head.headCommit && !base) {
		// No commits and no usable baseline: nothing is tracked-changed yet.
		return [];
	}
	const diffBase = base ?? (head.headCommit ? "HEAD" : null);
	if (!diffBase) {
		return [];
	}
	const diff = await runGit(worktreePath, ["diff", "--name-only", diffBase]);
	if (!diff.ok) {
		return [];
	}
	return parseNameOnlyOutput(diff.stdout);
}

/**
 * B-6.3: the unified diff vs the recorded starting revision (tracked changes,
 * committed + uncommitted). Uses the same base-fallback as the handoff's
 * changed-path listing so the prompt's diff always matches the artifact's
 * changed paths. Empty string when there is no usable base or diff.
 */
export async function extractReviewDiff(worktreePath: string, startingCommit: string | null): Promise<string> {
	const head = await readGitHeadInfo(worktreePath);
	let base = startingCommit ?? null;
	if (base) {
		const reachable = await runGit(worktreePath, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
		if (!reachable.ok) {
			base = null;
		}
	}
	const diffBase = base ?? (head.headCommit ? "HEAD" : null);
	if (!diffBase) {
		return "";
	}
	const diff = await runGit(worktreePath, ["diff", diffBase]);
	if (!diff.ok) {
		return "";
	}
	return diff.stdout;
}

/** Last commit that touched a worktree-relative path (null when untracked or unknown). */
async function lastCommitForPath(worktreePath: string, relPath: string): Promise<string | null> {
	const result = await runGit(worktreePath, ["log", "-1", "--format=%H", "--", relPath]);
	if (!result.ok || !result.stdout.trim()) {
		return null;
	}
	return result.stdout.trim();
}

async function buildPlanDocument(worktreePath: string, rawPath: string): Promise<RuntimeReviewHandoffPlanDocument> {
	const relPath = rawPath.replace(/^\/+/, "").replace(/\\/g, "/");
	const absolutePath = join(worktreePath, relPath);
	// Guard against path traversal outside the worktree.
	const escaped = relative(worktreePath, absolutePath);
	if (escaped.startsWith("..") || escaped.split(sep)[0] === "..") {
		return { path: relPath, sha256: null, revision: null, exists: false };
	}
	let contentHash: string | null = null;
	let exists = false;
	try {
		const content = await readFile(absolutePath, "utf8");
		contentHash = createHash("sha256").update(content, "utf8").digest("hex");
		exists = true;
	} catch {
		exists = false;
	}
	return {
		path: relPath,
		sha256: contentHash,
		revision: exists ? await lastCommitForPath(worktreePath, relPath) : null,
		exists,
	};
}

/** Derives checklist-style acceptance criteria from the authoritative description. */
export function deriveAcceptanceCriteria(description: string): string[] {
	return description
		.split(/\r?\n/)
		.map((line) =>
			line
				.trim()
				.replace(/^[-*+]\s+/, "")
				.replace(/^\d+[.)]\s+/, "")
				.trim(),
		)
		.filter((line) => line.length > 0);
}

function stringList(value: string[] | undefined | null): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter((entry) => entry.length > 0);
}

export interface BuildReviewHandoffInput {
	/** Task that owns the handoff artifact. */
	taskId: string;
	/** Absolute path to the task worktree to inspect. */
	worktreePath: string;
	/** Absolute path to the main repository checkout. */
	repoPath: string;
	/** Authoritative task description the review is judged against. */
	description: string;
	/** Worktree-relative plan document paths to fingerprint into the handoff. */
	planDocumentPaths?: string[];
	/** Structured self-report from the implementation session (unverified claims). */
	agentNotes?: {
		designDecisions?: string[];
		testsAttempted?: string[];
		knownLimitations?: string[];
		unresolvedQuestions?: string[];
	} | null;
	/** Recorded starting revision; falls back to the task preservation record. */
	startingCommit?: string | null;
	/** Timestamp injection for deterministic artifacts (tests). */
	timestampMs?: number;
}

/**
 * B-6.1: builds the implementation handoff for a fresh review session.
 * Reads the live worktree state (never trusting the implementation
 * session's self-report), fingerprints plan documents, and records the
 * baseline the change set is measured against.
 */
export async function buildReviewHandoffArtifact(
	input: BuildReviewHandoffInput,
): Promise<RuntimeReviewHandoffArtifact> {
	const head = await readGitHeadInfo(input.worktreePath);
	let startingCommit = input.startingCommit ?? null;
	if (!startingCommit) {
		const record = await readTaskPreservationRecord(input.taskId).catch(() => null);
		startingCommit = record?.startingCommit ?? null;
	}
	const [changedPaths, untrackedPaths] = await Promise.all([
		listTrackedChangedPaths(input.worktreePath, startingCommit),
		listUntrackedPaths(input.worktreePath),
	]);
	const planDocuments = await Promise.all(
		(input.planDocumentPaths ?? []).map((path) => buildPlanDocument(input.worktreePath, path)),
	);
	const notes = input.agentNotes ?? null;
	return runtimeReviewHandoffArtifactSchema.parse({
		taskId: input.taskId,
		worktreePath: input.worktreePath,
		repoPath: input.repoPath,
		startingCommit,
		latestCommit: head.headCommit,
		changedPaths,
		untrackedPaths,
		planDocuments,
		acceptanceCriteria: deriveAcceptanceCriteria(input.description),
		designDecisions: stringList(notes?.designDecisions),
		testsAttempted: stringList(notes?.testsAttempted),
		knownLimitations: stringList(notes?.knownLimitations),
		unresolvedQuestions: stringList(notes?.unresolvedQuestions),
		createdAt: input.timestampMs ?? Date.now(),
	});
}
/** Streams a file's content into the given hash. */
function hashFileContent(filePath: string, hash: ReturnType<typeof createHash>): Promise<void> {
	return new Promise((resolve, reject) => {
		const stream = createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve());
		stream.on("error", (error) => reject(error));
	});
}

/**
 * B-6.7: deterministic content hash of the worktree's tracked + untracked
 * state. Every file git knows about (tracked via `git ls-files`, untracked
 * via `git ls-files --others`) is content-hashed and folded into a single
 * SHA-256, so any edit, add, or delete changes the hash. Binding a review
 * result to this hash is what lets callers detect that later edits
 * invalidated the verdict (B-6.7).
 *
 * Hashes content on disk (not index blobs), so unstaged edits are captured
 * too. Returns null when the directory is not a usable git worktree.
 */
export async function computeCandidateTreeHash(worktreePath: string): Promise<string | null> {
	const head = await readGitHeadInfo(worktreePath);
	if (!head.headCommit) {
		// A worktree without any commit still has state (all-untracked); only
		// bail when git itself cannot resolve HEAD at all in a repo.
		const isRepo = await runGit(worktreePath, ["rev-parse", "--is-inside-work-tree"]);
		if (!isRepo.ok) {
			return null;
		}
	}
	const tracked = await runGit(worktreePath, ["ls-files", "-z"]);
	if (!tracked.ok) {
		return null;
	}
	const untracked = await runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (!untracked.ok) {
		return null;
	}
	const entries: Array<{ path: string; absolutePath: string }> = [];
	for (const relPath of tracked.stdout.split("\0")) {
		if (relPath) {
			entries.push({ path: relPath, absolutePath: join(worktreePath, relPath) });
		}
	}
	for (const relPath of untracked.stdout.split("\0")) {
		if (relPath) {
			entries.push({ path: `untracked:${relPath}`, absolutePath: join(worktreePath, relPath) });
		}
	}
	entries.sort((a, b) => a.path.localeCompare(b.path));
	const combined = createHash("sha256");
	for (const entry of entries) {
		combined.update(entry.path);
		combined.update("\0");
		try {
			await hashFileContent(entry.absolutePath, combined);
		} catch {
			// A file that vanished between listing and hashing: record only its path.
		}
		combined.update("\0");
	}
	return combined.digest("hex");
}

/** B-6.1: durably stores the review handoff artifact. */
export async function persistReviewHandoff(artifact: RuntimeReviewHandoffArtifact): Promise<string> {
	const path = getTaskReviewHandoffPath(artifact.taskId);
	await lockedFileSystem.writeJsonFileAtomic(path, artifact);
	return path;
}

/** B-6.1: reads a previously stored review handoff (null when absent or corrupt). */
export async function readReviewHandoff(taskId: string): Promise<RuntimeReviewHandoffArtifact | null> {
	const raw = await readFile(getTaskReviewHandoffPath(taskId), "utf8").catch(() => null);
	if (!raw) {
		return null;
	}
	try {
		const parsed = runtimeReviewHandoffArtifactSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** B-6.7: durably stores the review outcome for a task. */
export async function persistReviewOutcome(taskId: string, outcome: RuntimeReviewOutcomeFile): Promise<string> {
	const path = getTaskReviewOutcomePath(taskId);
	const validated = runtimeReviewOutcomeFileSchema.parse(outcome);
	await lockedFileSystem.writeJsonFileAtomic(path, validated);
	return path;
}

/** B-6.7: reads the stored review outcome (null when absent or corrupt). */
export async function readReviewOutcome(taskId: string): Promise<RuntimeReviewOutcomeFile | null> {
	const raw = await readFile(getTaskReviewOutcomePath(taskId), "utf8").catch(() => null);
	if (!raw) {
		return null;
	}
	try {
		const parsed = runtimeReviewOutcomeFileSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
// ---------------------------------------------------------------------------
// B-6.2: implementation self-report (unverified input, read permissively).
// ---------------------------------------------------------------------------

const REVIEW_REQUEST_FILENAME = "review-request.json";

/**
 * Structured self-report the implementation session may leave behind (via
 * the commit prompt template) when a task becomes ready for review. Kanban
 * records it in the handoff purely as unverified claims for the reviewer;
 * a missing or malformed file never blocks a review.
 */
export interface TaskReviewRequest {
	/** Worktree-relative plan document paths to fingerprint into the handoff. */
	planDocumentPaths: string[];
	/** Unverified self-report from the implementation session. */
	agentNotes: {
		designDecisions: string[];
		testsAttempted: string[];
		knownLimitations: string[];
		unresolvedQuestions: string[];
	} | null;
}

export const DEFAULT_TASK_REVIEW_REQUEST: TaskReviewRequest = {
	planDocumentPaths: [],
	agentNotes: null,
};

function getTaskReviewRequestPath(taskId: string): string {
	return join(getTaskReviewDir(taskId), REVIEW_REQUEST_FILENAME);
}

function toTrimmedStringList(value: unknown): string[] | null {
	if (!Array.isArray(value)) {
		return null;
	}
	return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter((entry) => entry.length > 0);
}

function parseTaskReviewRequest(raw: unknown): TaskReviewRequest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ...DEFAULT_TASK_REVIEW_REQUEST };
	}
	const record = raw as Record<string, unknown>;
	let agentNotes: TaskReviewRequest["agentNotes"] = null;
	if (record.agentNotes && typeof record.agentNotes === "object" && !Array.isArray(record.agentNotes)) {
		const notes = record.agentNotes as Record<string, unknown>;
		const designDecisions = toTrimmedStringList(notes.designDecisions);
		const testsAttempted = toTrimmedStringList(notes.testsAttempted);
		const knownLimitations = toTrimmedStringList(notes.knownLimitations);
		const unresolvedQuestions = toTrimmedStringList(notes.unresolvedQuestions);
		if (designDecisions || testsAttempted || knownLimitations || unresolvedQuestions) {
			agentNotes = {
				designDecisions: designDecisions ?? [],
				testsAttempted: testsAttempted ?? [],
				knownLimitations: knownLimitations ?? [],
				unresolvedQuestions: unresolvedQuestions ?? [],
			};
		}
	}
	return {
		planDocumentPaths: toTrimmedStringList(record.planDocumentPaths) ?? [],
		agentNotes,
	};
}

/** B-6.2: reads the implementation self-report (defaults when absent or malformed). */
export async function readTaskReviewRequest(taskId: string): Promise<TaskReviewRequest> {
	const rawText = await readFile(getTaskReviewRequestPath(taskId), "utf8").catch(() => null);
	if (!rawText) {
		return { ...DEFAULT_TASK_REVIEW_REQUEST };
	}
	try {
		return parseTaskReviewRequest(JSON.parse(rawText));
	} catch {
		return { ...DEFAULT_TASK_REVIEW_REQUEST };
	}
}

/** B-6.2: finds the task's base branch on the board (null when the task is not present). */
export async function findTaskBaseRef(workspaceId: string, taskId: string): Promise<string | null> {
	const board = await loadWorkspaceBoardById(workspaceId);
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.id === taskId) {
				return card.baseRef;
			}
		}
	}
	return null;
}
