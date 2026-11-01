// AR-3 — Owned, observable local validation jobs.
//
// A native local Cline session can start one long-running check through the
// `validation_job` tool, observe progress, page the retained log, and learn
// the actual exit status beyond the ordinary 30-second command deadline.
//
// Ownership and retention:
// - A job belongs to exactly one task (and to the session that started it).
//   State lives under `<task worktrees home>/<taskId>/validation-jobs/`, a
//   sibling of the task's worktree state, so deleting the task state removes
//   its spools and archives with it (no orphan logs indefinitely).
// - Spool files are owner-only (0o600) and capped; on settlement the retained
//   log is archived through the existing task context-artifact writer and the
//   spool is removed. Status is preserved even when archival fails.
// - After a runtime crash a retained "running" record is reclassified as
//   interrupted/unknown; it is never auto-resumed and never killed by a reused
//   PID. Killing targets the spawned process group (POSIX) or the child
//   process (Windows), so daemonized grandchildren are not a sandboxed
//   workload.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getTaskWorktreesHomePath } from "../state/workspace-state";
import { isPathWithinRoot } from "../workspace/path-sandbox";
import { getTaskContextArtifactsDir, writeTaskContextArtifact } from "../workspace/task-artifacts";
import { normalizeTaskIdForWorktreePath } from "../workspace/task-worktree-path";
import type { ClineSdkToolApprovalResult } from "./sdk-runtime-boundary";

export const VALIDATION_JOB_TOOL_NAME = "validation_job";
export const VALIDATION_JOB_SCHEMA_VERSION = 1;
/** Wall-clock deadline for one job (30 minutes). */
export const VALIDATION_JOB_DEFAULT_DEADLINE_MS = 30 * 60 * 1000;
/**
 * Grace period after the child's `exit` event before assuming a background
 * member is holding the stdio pipes (in which case the group is killed and
 * the job settles with the real exit status instead of waiting for `close`).
 */
const EXIT_CLOSE_GRACE_MS = 200;
/** Spool retention limit (25 MiB). */
export const VALIDATION_JOB_DEFAULT_MAX_LOG_BYTES = 25 * 1024 * 1024;
/** Read page limit (8 KiB). */
export const VALIDATION_JOB_READ_PAGE_BYTES = 8 * 1024;
/** Stay below the ordinary 30-second tool deadline. */
export const VALIDATION_JOB_MAX_WAIT_MS = 25_000;
const TRUNCATION_MARKER_PREFIX = "[validation job log incomplete:";

/** Job ids are generated UUIDs; anything else is rejected, never path-joined. */
const VALIDATION_JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function isValidJobId(jobId: string): boolean {
	return VALIDATION_JOB_ID_PATTERN.test(jobId);
}

export type ValidationJobState = "running" | "exited" | "canceled" | "timed_out" | "spawn_failed" | "interrupted";

/**
 * Versioned ownership/status metadata persisted per job. `toolCallId` is the
 * `start` tool-call id, which links the transcript's start receipt to the
 * settled record and archived log (AR-7 start/completion correlation).
 */
export interface ValidationJobRecord {
	schemaVersion: 1;
	taskId: string;
	sessionId: string;
	jobId: string;
	toolCallId: string;
	command: string;
	args: string[];
	/** Worktree-relative working directory ("" = worktree root). */
	cwd: string;
	startedAt: string;
	endedAt: string | null;
	state: ValidationJobState;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	canceled: boolean;
	logTruncated: boolean;
	logBytesRetained: number;
	logBytesOmitted: number;
	/** Absolute path of the archived retained log (null when archival failed). */
	artifactPath: string | null;
}

export interface ValidationJobStartRequest {
	/** The `start` tool-call id (idempotency key for repeated identical calls). */
	toolCallId: string;
	command: string;
	args: string;
	/** Worktree-relative working directory (optional). */
	cwd?: string;
}

export type ValidationJobStartResult =
	| { kind: "started"; record: ValidationJobRecord }
	| { kind: "duplicate"; record: ValidationJobRecord }
	| { kind: "reused"; record: ValidationJobRecord }
	| { kind: "busy"; running: ValidationJobRecord }
	| { kind: "denied"; reason: string }
	| { kind: "invalid"; reason: string }
	| { kind: "spawn_failed"; record: ValidationJobRecord; error: string };

export interface ValidationJobLogPage {
	text: string;
	offset: number;
	nextOffset: number;
	totalRetainedBytes: number;
	logTruncated: boolean;
	logBytesOmitted: number;
	complete: boolean;
}

export interface ValidationJobApprovalInput {
	toolCallId: string;
	command: string;
	args: string[];
	cwd?: string;
}

export interface ValidationJobServiceOptions {
	taskId: string;
	sessionId: string;
	/** Absolute path to the task worktree (cwd anchor and containment root). */
	worktreePath: string;
	/** Normal command-approval gate; must resolve before anything is spawned. */
	approve: (input: ValidationJobApprovalInput) => Promise<ClineSdkToolApprovalResult>;
	deadlineMs?: number;
	maxLogBytes?: number;
	maxReadBytes?: number;
	/** Artifact writer override (tests); defaults to the task context-artifact writer. */
	archiveArtifact?: (input: { taskId: string; toolCallId: string; content: string }) => Promise<string | null>;
}

interface LiveJob {
	record: ValidationJobRecord;
	child: ChildProcess;
	spool: FileHandle;
	spoolClosed: boolean;
	drainTail: Promise<void>;
	deadlineTimer: NodeJS.Timeout;
	pendingOutcome: Extract<ValidationJobState, "canceled" | "timed_out"> | null;
	/** Armed on `exit`; fires when `close` does not follow within the grace period. */
	exitGraceTimer: NodeJS.Timeout | null;
	settled: Promise<ValidationJobRecord> | null;
	completion: Promise<void>;
	notifyCompletion: () => void;
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) {
		return error.message;
	}
	return String(error);
}

function buildTruncationMarker(omittedBytes: number): string {
	return `${TRUNCATION_MARKER_PREFIX} ${omittedBytes} trailing bytes exceeded the spool limit and were discarded]`;
}

/**
 * Tokenizes a single args string into argv entries WITHOUT shell parsing:
 * whitespace separates tokens; single/double quotes group; backslash escapes
 * the next character (inside double quotes and outside quotes). No shell
 * operators, expansions, or command substitution are honored — an unmatched
 * quote or dangling escape returns null instead of guessing.
 */
export function tokenizeCommandArgs(input: string): string[] | null {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | null = null;
	let escaped = false;
	const push = (): void => {
		if (started) {
			tokens.push(current);
			current = "";
			started = false;
		}
	};
	for (const ch of input) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (ch === "'") {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = null;
			} else if (ch === "\\") {
				escaped = true;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			started = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			push();
			continue;
		}
		current += ch;
		started = true;
	}
	if (quote !== null || escaped) {
		return null;
	}
	push();
	return tokens;
}

/** Directory holding a task's validation-job spools and records (created on demand). */
export function getTaskValidationJobsDir(taskId: string): string {
	return join(getTaskWorktreesHomePath(), normalizeTaskIdForWorktreePath(taskId), "validation-jobs");
}

/**
 * AR-7: read-only observation of a task's settled validation-job records.
 * Never starts, cancels, or reclassifies anything (no orphan adoption); a
 * missing directory yields an empty list, and malformed or foreign records
 * are skipped rather than surfaced. Ordered by recorded start time.
 */
export async function listValidationJobRecords(taskId: string): Promise<ValidationJobRecord[]> {
	const dir = getTaskValidationJobsDir(taskId);
	const entries = await readdir(dir).catch(() => []);
	const records: ValidationJobRecord[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) {
			continue;
		}
		const jobId = entry.slice(0, -".json".length);
		if (!isValidJobId(jobId)) {
			continue;
		}
		const raw = await readFile(join(dir, entry), "utf8").catch(() => null);
		if (!raw) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				continue;
			}
			const record = parsed as ValidationJobRecord;
			// Persisted JSON is untrusted: the id must match its file name and
			// the schema version must be one this reader understands.
			if (record.jobId !== jobId || record.schemaVersion !== VALIDATION_JOB_SCHEMA_VERSION) {
				continue;
			}
			records.push(record);
		} catch {
			// Malformed JSON is skipped, never fatal to a diagnostics read.
		}
	}
	records.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
	return records;
}

/** AR-7: default byte limit of a job-log preview in a quality summary. */
export const VALIDATION_JOB_LOG_PREVIEW_LIMIT_BYTES = 64 * 1024;

/**
 * AR-7: read-only access to a job's retained log for diagnostics
 * observations. Returns the archived log path when it exists and lives in
 * this task's context-artifacts directory (null when no log is available).
 * Never starts, cancels, or reclassifies anything.
 */
export async function readValidationJobLogReference(record: ValidationJobRecord): Promise<string | null> {
	if (!record.artifactPath) {
		return null;
	}
	if (!isPathWithinRoot(getTaskContextArtifactsDir(record.taskId), record.artifactPath)) {
		return null;
	}
	return (await stat(record.artifactPath).catch(() => null))?.isFile() ? record.artifactPath : null;
}

/**
 * AR-7: a bounded preview of the job's retained log (null when no log is
 * available). Reads at most `limitBytes` from the start of the archived log.
 * Never starts, cancels, or reclassifies anything.
 */
export async function readValidationJobLogPreview(
	record: ValidationJobRecord,
	limitBytes: number = VALIDATION_JOB_LOG_PREVIEW_LIMIT_BYTES,
): Promise<string | null> {
	const path = await readValidationJobLogReference(record);
	if (!path) {
		return null;
	}
	const handle = await open(path, "r").catch(() => null);
	if (!handle) {
		return null;
	}
	try {
		const size = (await handle.stat().catch(() => null))?.size ?? 0;
		const length = Math.min(Math.max(0, Math.trunc(limitBytes)), size);
		if (length <= 0) {
			return "";
		}
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Owns the validation jobs of one task for one session: at most one live job
 * at a time, one owner-only spool per job, and one versioned metadata record
 * per job. The process is never auto-retried.
 */
export class ValidationJobService {
	readonly taskId: string;
	readonly sessionId: string;
	private readonly worktreePath: string;
	private readonly approve: (input: ValidationJobApprovalInput) => Promise<ClineSdkToolApprovalResult>;
	private readonly deadlineMs: number;
	private readonly maxLogBytes: number;
	private readonly maxReadBytes: number;
	private readonly archiveArtifact: (input: {
		taskId: string;
		toolCallId: string;
		content: string;
	}) => Promise<string | null>;
	private readonly jobsDir: string;
	private readonly receiptByToolCallId = new Map<string, ValidationJobRecord>();
	private liveJob: LiveJob | null = null;
	private adopted: Promise<void> | null = null;
	/** Serializes start() so concurrent tool calls cannot double-book the live slot. */
	private startChain: Promise<void> = Promise.resolve();
	/** Set when the service is closed (stop/clear/abort/shutdown); no further spawns. */
	private closed = false;

	constructor(options: ValidationJobServiceOptions) {
		this.taskId = options.taskId;
		this.sessionId = options.sessionId;
		this.worktreePath = options.worktreePath;
		this.approve = options.approve;
		this.deadlineMs = options.deadlineMs ?? VALIDATION_JOB_DEFAULT_DEADLINE_MS;
		this.maxLogBytes = options.maxLogBytes ?? VALIDATION_JOB_DEFAULT_MAX_LOG_BYTES;
		this.maxReadBytes = options.maxReadBytes ?? VALIDATION_JOB_READ_PAGE_BYTES;
		this.archiveArtifact = options.archiveArtifact ?? writeTaskContextArtifact;
		this.jobsDir = getTaskValidationJobsDir(options.taskId);
	}

	/**
	 * Reclassifies retained "running" records (from a crashed or replaced
	 * runtime) as interrupted/unknown. Never resumes them and never kills any
	 * process by a possibly-reused PID. Idempotent.
	 */
	async initialize(): Promise<void> {
		if (!this.adopted) {
			this.adopted = this.adoptOrphanedRunningRecords();
		}
		await this.adopted;
	}

	/**
	 * Starts one job (or returns a receipt for an already-started one).
	 * Approval happens once, before anything is spawned; a denied start
	 * creates no process, spool, or record (a start refused because the
	 * service closed after approval drops the spool and record it created).
	 * Starts are serialized on a promise chain so concurrent tool calls cannot
	 * double-book the single live slot before the first start registers it.
	 */
	async start(request: ValidationJobStartRequest): Promise<ValidationJobStartResult> {
		const run = this.startChain.then(() => this.performStart(request));
		// Keep the chain alive even when a start rejects.
		this.startChain = run.then(() => undefined).catch(() => undefined);
		return await run;
	}

	private async performStart(request: ValidationJobStartRequest): Promise<ValidationJobStartResult> {
		await this.initialize();
		if (this.closed) {
			return { kind: "invalid", reason: "the validation-job service has been closed; no new jobs can start." };
		}
		const command = request.command.trim();
		if (!command || /\r?\n/.test(command) || command.includes("\0")) {
			return { kind: "invalid", reason: "command must be a single non-empty executable name or path." };
		}
		const args = tokenizeCommandArgs(request.args);
		if (args === null) {
			return {
				kind: "invalid",
				reason: "args is not a valid argument string (unbalanced quote or dangling escape).",
			};
		}
		// NUL bytes make spawn throw synchronously (ERR_INVALID_ARG_VALUE);
		// reject them up front so no spool or record is created.
		if (args.some((arg) => arg.includes("\0"))) {
			return { kind: "invalid", reason: "args must not contain NUL bytes." };
		}
		const cwdRel = this.resolveCwd(request.cwd);
		if (cwdRel === null) {
			return { kind: "invalid", reason: "cwd must be an existing directory inside the task worktree." };
		}

		const existingReceipt = this.receiptByToolCallId.get(request.toolCallId);
		if (existingReceipt) {
			return { kind: "duplicate", record: existingReceipt };
		}
		const live = this.liveJob;
		if (live) {
			const record = live.record;
			const sameCommand =
				record.command === command && record.args.join("\0") === args.join("\0") && record.cwd === cwdRel;
			return sameCommand ? { kind: "reused", record } : { kind: "busy", running: record };
		}

		const approval = await this.approve({
			toolCallId: request.toolCallId,
			command,
			args,
			...(cwdRel ? { cwd: cwdRel } : {}),
		});
		if (!approval.approved) {
			return { kind: "denied", reason: approval.reason?.trim() || "the tool policy did not approve this start." };
		}
		// A stop/clear/abort may have closed the service while approval
		// was pending; never spawn on a closed service.
		if (this.closed) {
			return { kind: "invalid", reason: "the validation-job service was closed while approval was pending." };
		}

		const record: ValidationJobRecord = {
			schemaVersion: VALIDATION_JOB_SCHEMA_VERSION,
			taskId: this.taskId,
			sessionId: this.sessionId,
			jobId: randomUUID(),
			toolCallId: request.toolCallId,
			command,
			args,
			cwd: cwdRel,
			startedAt: new Date().toISOString(),
			endedAt: null,
			state: "running",
			exitCode: null,
			signal: null,
			timedOut: false,
			canceled: false,
			logTruncated: false,
			logBytesRetained: 0,
			logBytesOmitted: 0,
			artifactPath: null,
		};
		let spool: FileHandle;
		try {
			await mkdir(this.jobsDir, { recursive: true });
			spool = await open(this.spoolPathFor(record.jobId), "w", 0o600);
			await chmod(this.spoolPathFor(record.jobId), 0o600).catch(() => undefined);
		} catch (error) {
			return { kind: "invalid", reason: `could not create the job spool: ${toErrorMessage(error)}` };
		}
		try {
			await this.writeRecord(record);
		} catch (error) {
			await spool.close().catch(() => undefined);
			return { kind: "invalid", reason: `could not persist the job record: ${toErrorMessage(error)}` };
		}

		if (this.closed) {
			// Nothing has spawned and no receipt was handed out: drop the
			// spool and record created above rather than leaving a phantom
			// running record behind.
			await spool.close().catch(() => undefined);
			await rm(this.spoolPathFor(record.jobId), { force: true }).catch(() => undefined);
			await rm(this.recordPathFor(record.jobId), { force: true }).catch(() => undefined);
			return { kind: "invalid", reason: "the validation-job service was closed before the job could start." };
		}

		const detached = process.platform !== "win32";
		let child: ChildProcess;
		try {
			child = spawn(command, args, {
				cwd: join(this.worktreePath, cwdRel),
				stdio: ["ignore", "pipe", "pipe"],
				// POSIX: become a process-group leader so cancel/timeout can kill
				// the whole group. Windows: kill the child directly instead.
				detached,
				env: process.env,
			});
		} catch (error) {
			// spawn threw synchronously (e.g. an invalid argv): close the spool,
			// persist a settled spawn_failed record, and report. No process was
			// created, so there is nothing to kill.
			const failed: ValidationJobRecord = {
				...record,
				endedAt: new Date().toISOString(),
				state: "spawn_failed",
			};
			await this.writeRecord(failed).catch(() => undefined);
			await spool.close().catch(() => undefined);
			await rm(this.spoolPathFor(record.jobId), { force: true }).catch(() => undefined);
			return { kind: "spawn_failed", record: failed, error: toErrorMessage(error) };
		}
		let notifyCompletion = () => {};
		const completion = new Promise<void>((resolve) => {
			notifyCompletion = resolve;
		});
		const liveJob: LiveJob = {
			record,
			child,
			spool,
			spoolClosed: false,
			drainTail: Promise.resolve(),
			deadlineTimer: setTimeout(() => this.beginKill(liveJob, "timed_out"), this.deadlineMs),
			pendingOutcome: null,
			exitGraceTimer: null,
			settled: null,
			completion,
			notifyCompletion,
		};
		this.wireChildEvents(liveJob);
		this.liveJob = liveJob;
		this.receiptByToolCallId.set(request.toolCallId, record);

		// The spawn event fires exactly once (success or failure) before any
		// stream data; awaiting it lets a missing executable settle promptly
		// while a real process returns its receipt immediately.
		const spawnOutcome = await this.waitForSpawnOutcome(child);
		if (spawnOutcome.outcome !== "spawn") {
			this.settle(liveJob, { state: "spawn_failed" });
			const settled = (await liveJob.settled) ?? record;
			return { kind: "spawn_failed", record: settled, error: toErrorMessage(spawnOutcome.error) };
		}
		return { kind: "started", record };
	}

	/** Wait for an owned job to settle, or return its current state at the bounded deadline. */
	async waitForJob(
		jobId: string,
		timeoutMs = VALIDATION_JOB_MAX_WAIT_MS,
		signal?: AbortSignal,
	): Promise<ValidationJobRecord | null> {
		signal?.throwIfAborted();
		const record = await this.getJob(jobId);
		signal?.throwIfAborted();
		const live = this.liveJob;
		if (!record || record.state !== "running" || live?.record !== record) return record;
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid validation wait duration.");
		const timer = new AbortController();
		const waitSignal = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
		try {
			await Promise.race([
				live.completion,
				delay(Math.min(timeoutMs, VALIDATION_JOB_MAX_WAIT_MS), undefined, { signal: waitSignal }),
			]);
			signal?.throwIfAborted();
			return record;
		} finally {
			// Remove the losing timer and abort listeners when completion wins.
			timer.abort();
		}
	}

	/** Reads a job's ownership/status metadata (live or settled); null when unknown for this task. */
	async getJob(jobId: string): Promise<ValidationJobRecord | null> {
		await this.initialize();
		const trimmed = jobId.trim();
		if (!trimmed || !isValidJobId(trimmed)) {
			return null;
		}
		const live = this.liveJob;
		if (live && live.record.jobId === trimmed) {
			return live.record;
		}
		return await this.readRecord(trimmed);
	}

	/**
	 * Pages the retained log with a byte cursor (bounded to the page limit).
	 * Never starts or restarts a process. Null when the job is unknown.
	 */
	async readJobLog(jobId: string, offset: number = 0, limit?: number): Promise<ValidationJobLogPage | null> {
		await this.initialize();
		const record = await this.getJob(jobId);
		if (!record) {
			return null;
		}
		const sourcePath = await this.logSourcePathFor(record);
		if (!sourcePath) {
			return {
				text: "",
				offset: 0,
				nextOffset: 0,
				totalRetainedBytes: record.logBytesRetained,
				logTruncated: record.logTruncated,
				logBytesOmitted: record.logBytesOmitted,
				complete: true,
			};
		}
		const total = (await stat(sourcePath).catch(() => null))?.size ?? record.logBytesRetained;
		const safeOffset = Math.max(0, Math.min(Math.trunc(offset), total));
		const safeLimit = Math.max(1, Math.min(Math.trunc(limit ?? this.maxReadBytes), this.maxReadBytes));
		const length = Math.min(safeLimit, total - safeOffset);
		let text = "";
		if (length > 0) {
			const handle = await open(sourcePath, "r");
			try {
				const buffer = Buffer.alloc(length);
				const { bytesRead } = await handle.read(buffer, 0, length, safeOffset);
				text = buffer.subarray(0, bytesRead).toString("utf8");
			} finally {
				await handle.close().catch(() => undefined);
			}
		}
		const nextOffset = safeOffset + length;
		return {
			text,
			offset: safeOffset,
			nextOffset,
			totalRetainedBytes: total,
			logTruncated: record.logTruncated,
			logBytesOmitted: record.logBytesOmitted,
			complete: nextOffset >= total,
		};
	}

	/**
	 * Cancels one job (kills the owned process group on POSIX, the child on
	 * Windows) and resolves once its status is settled. Already-settled jobs
	 * return their record unchanged. Null when the job is unknown.
	 */
	async cancelJob(jobId: string): Promise<ValidationJobRecord | null> {
		await this.initialize();
		const trimmed = jobId.trim();
		if (!trimmed || !isValidJobId(trimmed)) {
			return null;
		}
		const live = this.liveJob;
		if (live && live.record.jobId === trimmed) {
			this.beginKill(live, "canceled");
			return await this.ensureSettled(live);
		}
		return await this.readRecord(trimmed);
	}

	/**
	 * Settles every live job of this session (stop/cancel/clear/shutdown
	 * paths) and closes the service: no further jobs may spawn, including
	 * starts still queued on the start chain or awaiting approval. Never
	 * starts a process. Without a live job it only sets the close flag and
	 * returns an empty list.
	 */
	async cancelAllJobs(): Promise<ValidationJobRecord[]> {
		this.closed = true;
		const live = this.liveJob;
		if (!live) {
			return [];
		}
		this.beginKill(live, "canceled");
		return [await this.ensureSettled(live)];
	}

	/** The currently live job record, if any (no I/O). */
	getLiveJob(): ValidationJobRecord | null {
		return this.liveJob?.record ?? null;
	}

	private resolveCwd(cwdInput: string | undefined): string | null {
		if (cwdInput === undefined || cwdInput.trim() === "") {
			return "";
		}
		const candidate = cwdInput.trim().split("\\").join("/");
		if (candidate.startsWith("/") || candidate.split("/").some((segment) => segment === "..")) {
			return null;
		}
		const absolute = join(this.worktreePath, candidate);
		if (!isPathWithinRoot(this.worktreePath, absolute)) {
			return null;
		}
		try {
			if (!statSync(absolute).isDirectory()) {
				return null;
			}
		} catch {
			return null;
		}
		const cleaned = candidate.replace(/^\.\//, "").replace(/\/+$/, "");
		return cleaned || "";
	}

	private spoolPathFor(jobId: string): string {
		return join(this.jobsDir, `${jobId}.log`);
	}

	private recordPathFor(jobId: string): string {
		return join(this.jobsDir, `${jobId}.json`);
	}

	private async readRecord(jobId: string): Promise<ValidationJobRecord | null> {
		try {
			const raw = await readFile(this.recordPathFor(jobId), "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				return null;
			}
			const record = parsed as ValidationJobRecord;
			// The record's own id must match the file name we read: persisted
			// JSON is untrusted, and a mismatched or malformed id must never be
			// joined into a spool or artifact path.
			if (
				!isValidJobId(record.jobId) ||
				record.jobId !== jobId ||
				record.schemaVersion !== VALIDATION_JOB_SCHEMA_VERSION ||
				record.taskId !== this.taskId
			) {
				return null;
			}
			return record;
		} catch {
			return null;
		}
	}

	private async writeRecord(record: ValidationJobRecord): Promise<void> {
		const path = this.recordPathFor(record.jobId);
		await lockedFileSystem.writeJsonFileAtomic(path, record, {
			lock: { type: "file", path },
		});
		await chmod(path, 0o600).catch(() => undefined);
	}

	/**
	 * Reclassifies retained "running" records as interrupted/unknown. A live
	 * job owned by this service is never touched; records that do not belong
	 * to this task or schema version are left alone.
	 */
	private async adoptOrphanedRunningRecords(): Promise<void> {
		const entries = await readdir(this.jobsDir).catch(() => []);
		for (const entry of entries) {
			if (!entry.endsWith(".json")) {
				continue;
			}
			const record = await this.readRecord(entry.slice(0, -".json".length));
			if (!record || record.state !== "running") {
				continue;
			}
			const live = this.liveJob;
			if (live && live.record.jobId === record.jobId) {
				continue;
			}
			// Re-read just before writing: a competing settle (a previous
			// session's un-awaited cancelAllJobs, or any other process
			// reclassifying the same record) may finish between the scan and
			// the write, and its final status (with artifactPath) must not be
			// clobbered by an interrupted classification.
			const fresh = await this.readRecord(entry.slice(0, -".json".length));
			if (!fresh || fresh.state !== "running") {
				continue;
			}
			fresh.state = "interrupted";
			fresh.endedAt = new Date().toISOString();
			await this.writeRecord(fresh).catch(() => undefined);
		}
	}

	private async logSourcePathFor(record: ValidationJobRecord): Promise<string | null> {
		const spool = this.spoolPathFor(record.jobId);
		if ((await stat(spool).catch(() => null))?.isFile()) {
			return spool;
		}
		if (record.artifactPath) {
			// The record is persisted JSON: only open artifacts that live in
			// this task's context-artifacts directory, never an arbitrary path.
			if (!isPathWithinRoot(getTaskContextArtifactsDir(record.taskId), record.artifactPath)) {
				return null;
			}
			return (await stat(record.artifactPath).catch(() => null))?.isFile() ? record.artifactPath : null;
		}
		return null;
	}

	private async waitForSpawnOutcome(
		child: ChildProcess,
	): Promise<{ outcome: "spawn" } | { outcome: "error"; error: Error }> {
		return await new Promise((resolve) => {
			const onSpawn = () => {
				child.removeListener("error", onError);
				resolve({ outcome: "spawn" });
			};
			const onError = (error: Error) => {
				child.removeListener("spawn", onSpawn);
				resolve({ outcome: "error", error });
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
	}

	private enqueueSpoolWrite(live: LiveJob, chunk: Buffer): void {
		if (chunk.length === 0) {
			return;
		}
		const job = live;
		job.drainTail = job.drainTail
			.then(async () => {
				if (job.spoolClosed) {
					return;
				}
				const remaining = this.maxLogBytes - job.record.logBytesRetained;
				if (remaining <= 0) {
					// Keep draining so the child never blocks on a full pipe,
					// but retain no additional bytes beyond the limit. Every
					// byte dropped here is truncation, even when the spool was
					// already exactly full by the previous chunk.
					job.record.logBytesOmitted += chunk.length;
					job.record.logTruncated = true;
					return;
				}
				const toWrite = chunk.subarray(0, Math.min(chunk.length, remaining));
				await job.spool.write(toWrite);
				job.record.logBytesRetained += toWrite.length;
				if (toWrite.length < chunk.length) {
					job.record.logBytesOmitted += chunk.length - toWrite.length;
					job.record.logTruncated = true;
				}
			})
			.catch(() => undefined);
	}

	/** Kills the owned process (group) and marks the pending settle outcome. */
	private beginKill(live: LiveJob, outcome: "canceled" | "timed_out"): void {
		const child = live.child;
		const exited = child.exitCode !== null || child.signalCode !== null;
		if (!exited || process.platform !== "win32") {
			// On POSIX always attempt the group kill: the group id stays valid
			// while any member lives, so a leader that already exited cannot
			// leave background members holding the pipes. An empty group
			// throws ESRCH, which the fallback in killProcessGroup handles.
			this.killProcessGroup(child);
		}
		live.pendingOutcome = outcome;
		if (exited) {
			this.settle(live, {
				state: outcome,
				exitCode: child.exitCode ?? undefined,
				signal: child.signalCode ?? undefined,
			});
		}
	}

	private killProcessGroup(child: ChildProcess): void {
		const pid = child.pid;
		if (pid === undefined) {
			return;
		}
		if (process.platform === "win32") {
			// Windows has no portable process-group kill; kill the child
			// directly (daemonized grandchildren are out of scope).
			child.kill("SIGKILL");
			return;
		}
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}

	private wireChildEvents(live: LiveJob): void {
		const { child } = live;
		if (child.stdout) {
			child.stdout.on("data", (chunk: Buffer) => this.enqueueSpoolWrite(live, chunk));
		}
		if (child.stderr) {
			child.stderr.on("data", (chunk: Buffer) => this.enqueueSpoolWrite(live, chunk));
		}
		child.on("error", () => {
			if (live.settled === null) {
				this.settle(live, { state: "spawn_failed" });
			}
		});
		// exit fires when the child itself exits, before close, which also
		// requires the stdio pipes to be released. If a background member
		// inherited the pipes, close never follows; the grace timer then
		// force-settles with the real exit status instead of leaving the job
		// running (and misreporting timed_out at the deadline).
		child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
			if (live.settled !== null) {
				return;
			}
			live.exitGraceTimer = setTimeout(() => {
				live.exitGraceTimer = null;
				if (live.settled !== null) {
					return;
				}
				this.killProcessGroup(child);
				this.settle(live, {
					state: live.pendingOutcome ?? "exited",
					exitCode: code ?? undefined,
					signal: signal ? signal.toString() : undefined,
				});
			}, EXIT_CLOSE_GRACE_MS);
		});
		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			this.settle(live, {
				state: live.pendingOutcome ?? "exited",
				exitCode: code ?? undefined,
				signal: signal ? signal.toString() : undefined,
			});
		});
	}

	private async ensureSettled(live: LiveJob): Promise<ValidationJobRecord> {
		if (live.settled === null) {
			// No close/error event is coming (the child is already gone);
			// settle now so callers awaiting the receipt do not hang.
			this.settle(live, {
				state: live.pendingOutcome ?? "exited",
				exitCode: live.child.exitCode ?? undefined,
				signal: live.child.signalCode ?? undefined,
			});
		}
		const settled = live.settled;
		if (settled === null) {
			return live.record;
		}
		return await settled;
	}

	/**
	 * Settles a live job exactly once: drains the spool, archives the retained
	 * log through the task context-artifact writer (status is preserved when
	 * archival fails), persists the final metadata, and frees the live slot.
	 */
	private settle(
		live: LiveJob,
		outcome: { state: ValidationJobState; exitCode?: number | null; signal?: string | null },
	): Promise<ValidationJobRecord> {
		if (live.settled !== null) {
			return live.settled;
		}
		const record = live.record;
		// The settled fields are applied to the shared record only after
		// archival completes (in one synchronous stretch), so readers never
		// observe a settled state with missing log/archive fields, and a new
		// start never mistakes a settling job for live or busy.
		const endedAt = new Date().toISOString();
		clearTimeout(live.deadlineTimer);
		if (live.exitGraceTimer) {
			clearTimeout(live.exitGraceTimer);
			live.exitGraceTimer = null;
		}
		const settled = (async () => {
			await live.drainTail;
			if (!live.spoolClosed) {
				live.spoolClosed = true;
				await live.spool.close().catch(() => undefined);
			}
			let artifactPath: string | null = null;
			let spoolConsumed = false;
			if (record.logBytesRetained > 0) {
				try {
					let content = await readFile(this.spoolPathFor(record.jobId), "utf8");
					if (record.logTruncated) {
						content = `${content}\n\n${buildTruncationMarker(record.logBytesOmitted)}`;
					}
					artifactPath = await this.archiveArtifact({
						taskId: record.taskId,
						toolCallId: record.toolCallId,
						content,
					});
					spoolConsumed = artifactPath !== null;
				} catch {
					// Preserve the status even if archival failed; the spool stays.
				}
			} else {
				// Nothing retained: the spool is safe to drop (after the final
				// record is published; see below).
				spoolConsumed = true;
			}
			// Persist the final record before flipping the shared one, so a
			// reader can never observe a backward-going state from the file.
			const finalRecord: ValidationJobRecord = {
				...record,
				endedAt,
				state: outcome.state,
				exitCode: outcome.exitCode ?? record.exitCode,
				signal: outcome.signal ?? record.signal,
				timedOut: outcome.state === "timed_out" ? true : record.timedOut,
				canceled: outcome.state === "canceled" ? true : record.canceled,
				artifactPath,
			};
			await this.writeRecord(finalRecord).catch(() => undefined);
			// One synchronous stretch: publish the final state to the shared
			// record and release the live slot, so `status` never reports a
			// settled job with missing log or archive fields, and a new start
			// never mistakes a settling job for live or busy.
			Object.assign(record, finalRecord);
			live.notifyCompletion();
			if (this.liveJob === live) {
				this.liveJob = null;
			}
			// Only delete the spool after the final record is published and the
			// live slot is released: a reader racing settlement must see either
			// the spool (job running) or the archive (job settled), never
			// neither — an empty "end of retained log" page would misreport a
			// retained log as empty and complete.
			if (spoolConsumed) {
				await rm(this.spoolPathFor(record.jobId), { force: true }).catch(() => undefined);
			}
			return record;
		})();
		live.settled = settled;
		return settled;
	}
}
