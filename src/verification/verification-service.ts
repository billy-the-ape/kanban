// B-7.2 / B-7.3 / B-7.4 — deterministic verification gate.
//
// Runs the operator-configured checks (B-7.1) against the task worktree and
// produces an evidence receipt that gates delivery independently of the
// agent's narrative:
//
// - Checks spawn directly (never through a shell) with a minimal environment
//   allowlist and a per-check timeout. A check passes IFF its exit code is in
//   the configured `successExitCodes` (default [0]) — success-looking output
//   never counts.
// - The tree identity (the B-6.7 candidate content hash) is recorded before
//   and after the run; any mutation invalidates the receipt (B-7.4). The run
//   is never re-based onto the mutated tree: that would bless formatter
//   rewrites or generated sources nobody reviewed. Generated build output
//   belongs in .gitignore (ignored files are outside the tree identity).
// - A "required" gate with no required check fails: an empty gate must be an
//   explicit "off", never a silent pass.
// - The receipt binds to the candidate tree hash the review verdict used
//   (`matchesCandidate`), and `passed` requires every required check to pass
//   AND the tree identity to be bound. Missing executables, uncomputable
//   trees, and cancelled runs never pass.
// - Each check's full log is written under
//   <task state home>/<taskId>/verification/ (B-7.3); the receipt carries
//   only a bounded head excerpt.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type {
	RuntimeVerificationCheck,
	RuntimeVerificationCheckResult,
	RuntimeVerificationConfig,
	RuntimeVerificationReceipt,
} from "../core/api-contract";
import { computeCandidateTreeHash, getTaskVerificationDir } from "../workspace/task-review-handoff";

/** Default per-check timeout in milliseconds (5 minutes). */
export const DEFAULT_VERIFICATION_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
/** Bounded head excerpt of a check's output carried in the receipt. */
const OUTPUT_EXCERPT_LIMIT_CHARS = 256 * 1024;
/** Hard cap on the full per-check log file (disk protection). */
const MAX_LOG_BYTES = 1024 * 1024;
/** Grace between SIGTERM and SIGKILL when a check hits its timeout. */
const KILL_GRACE_MS = 5_000;

/** Minimal base environment a check sees (everything else is stripped). */
const BASE_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"TEMP",
	"LANG",
	"LC_ALL",
	"TZ",
	"SystemRoot",
	"windir",
	"ComSpec",
	"PATHEXT",
] as const;

/** One verification run against a single worktree. */
export interface VerificationRunInput {
	/** Task the worktree belongs to (log artifact placement). */
	taskId: string;
	/** Absolute path of the task worktree to verify. */
	worktreePath: string;
	/** Candidate tree hash the review verdict was bound to (null when unavailable). */
	candidateTreeHash: string | null;
	/** Override the per-check log directory (defaults to the task verification dir). */
	logDir?: string;
	/** Optional cancellation signal; aborting kills the in-flight check. */
	signal?: AbortSignal;
}

/** B-7.2: the gate runner seam the review session orchestrator invokes. */
export interface VerificationRunner {
	run(config: RuntimeVerificationConfig, input: VerificationRunInput): Promise<RuntimeVerificationReceipt>;
}

function buildCheckEnv(check: RuntimeVerificationCheck): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of BASE_ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	for (const [key, value] of Object.entries(check.env ?? {})) {
		env[key] = value;
	}
	return env;
}

/** Resolves a configured check cwd inside the worktree; null when unsafe. */
function resolveCheckCwd(worktreePath: string, check: RuntimeVerificationCheck): string | null {
	if (!check.cwd) {
		return worktreePath;
	}
	// Config validation (B-7.1) already rejects absolute paths and `..`
	// traversal; re-guard here because the runner is a trusted boundary.
	if (check.cwd.startsWith("/") || /^[a-zA-Z]:/.test(check.cwd) || check.cwd.split(/[\\/]+/).includes("..")) {
		return null;
	}
	return join(worktreePath, check.cwd);
}

function isMissingExecutableError(error: Error): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function sanitizeLogId(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** B-7.2: the default deterministic gate runner (spawned checks). */
export class VerificationService implements VerificationRunner {
	private readonly computeTreeHash: (worktreePath: string) => Promise<string | null>;

	/** Options exist for test injection of the tree-hash computation. */
	constructor(options?: { computeTreeHash?: (worktreePath: string) => Promise<string | null> }) {
		this.computeTreeHash =
			options?.computeTreeHash ?? ((worktreePath: string) => computeCandidateTreeHash(worktreePath));
	}

	async run(config: RuntimeVerificationConfig, input: VerificationRunInput): Promise<RuntimeVerificationReceipt> {
		const startedAt = Date.now();
		const logDir = input.logDir ?? getTaskVerificationDir(input.taskId);

		const treeHashBefore = await this.computeTreeHash(input.worktreePath).catch(() => null);
		const checkResults = await this.runChecks(config, input, logDir, 0);
		const treeHashAfter = await this.computeTreeHash(input.worktreePath).catch(() => null);

		const treeIdentityPreserved = this.isIdentityPreserved(treeHashBefore, treeHashAfter);
		const matchesCandidate =
			input.candidateTreeHash !== null && treeHashBefore !== null && treeHashBefore === input.candidateTreeHash;
		const hasRequiredCheck = config.checks.some((check) => check.required);
		const passed =
			treeIdentityPreserved &&
			hasRequiredCheck &&
			config.checks.every((check, index) => !check.required || checkResults[index]?.status === "passed");
		return {
			treeHashBefore,
			treeHashAfter,
			treeIdentityPreserved,
			matchesCandidate,
			checks: checkResults,
			passed,
			error: passed ? null : this.buildGateError(treeHashBefore, treeHashAfter, config, checkResults),
			startedAt,
			finishedAt: Date.now(),
		};
	}

	private isIdentityPreserved(before: string | null, after: string | null): boolean {
		return before !== null && after !== null && before === after;
	}

	private buildGateError(
		treeHashBefore: string | null,
		treeHashAfter: string | null,
		config: RuntimeVerificationConfig,
		checkResults: RuntimeVerificationCheckResult[],
	): string {
		const reasons: string[] = [];
		if (!config.checks.some((check) => check.required)) {
			reasons.push('no required check is configured (set verification.enabled to "off" to disable the gate)');
		}
		if (treeHashBefore === null || treeHashAfter === null) {
			reasons.push("the worktree tree identity could not be computed, so the run cannot be bound");
		} else if (treeHashBefore !== treeHashAfter) {
			reasons.push(
				"the checks mutated the worktree (tree identity not preserved); checks must not rewrite sources, and generated output belongs in .gitignore",
			);
		}
		config.checks.forEach((check, index) => {
			const result = checkResults[index];
			if (!check.required || !result || result.status === "passed") {
				return;
			}
			const detail = result.error ?? (result.exitCode !== null ? `exit code ${result.exitCode}` : "no exit code");
			reasons.push(`required check "${check.id}" ${result.status}: ${detail}`);
		});
		return `Verification gate failed: ${reasons.join("; ")}`;
	}

	private async runChecks(
		config: RuntimeVerificationConfig,
		input: VerificationRunInput,
		logDir: string,
		attempt: number,
	): Promise<RuntimeVerificationCheckResult[]> {
		const results: RuntimeVerificationCheckResult[] = [];
		for (const check of config.checks) {
			results.push(await this.runCheck(check, input, logDir, attempt));
		}
		return results;
	}

	private async runCheck(
		check: RuntimeVerificationCheck,
		input: VerificationRunInput,
		logDir: string,
		attempt: number,
	): Promise<RuntimeVerificationCheckResult> {
		const startedAt = Date.now();
		const timeoutMs =
			check.timeoutMs && check.timeoutMs > 0 ? check.timeoutMs : DEFAULT_VERIFICATION_CHECK_TIMEOUT_MS;
		const cwd = resolveCheckCwd(input.worktreePath, check);

		if (cwd === null) {
			return {
				id: check.id,
				command: check.command,
				args: check.args,
				status: "error",
				exitCode: null,
				emptyOutput: true,
				outputExcerpt: "",
				logPath: null,
				startedAt,
				finishedAt: Date.now(),
				error: "the configured check working directory is not allowed",
			};
		}

		// Mutable state updated from child-process callbacks. Reading it through
		// the object keeps TypeScript from narrowing the values to their
		// initializers (closure assignments are not tracked by control-flow analysis).
		const runState = {
			exitCode: null as number | null,
			spawnError: null as Error | null,
			timedOut: false,
		};
		const outputChunks: Buffer[] = [];
		let outputBytes = 0;
		let outputTruncated = false;

		const appendOutput = (chunk: Buffer): void => {
			if (outputBytes >= MAX_LOG_BYTES) {
				return;
			}
			const slice =
				chunk.length > MAX_LOG_BYTES - outputBytes ? chunk.subarray(0, MAX_LOG_BYTES - outputBytes) : chunk;
			outputChunks.push(Buffer.from(slice));
			outputBytes += slice.length;
			if (slice.length < chunk.length) {
				outputTruncated = true;
			}
		};

		await new Promise<true>((resolve) => {
			let child: ChildProcessByStdio<null, Readable, Readable>;
			try {
				child = spawn(check.command, check.args, {
					cwd,
					env: buildCheckEnv(check),
					// Never spawn a shell: command + args run verbatim (B-7.2).
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				runState.spawnError = error instanceof Error ? error : new Error(String(error));
				resolve(true);
				return;
			}
			let graceTimer: NodeJS.Timeout | undefined;
			const onAbort = (): void => {
				child.kill("SIGTERM");
			};
			input.signal?.addEventListener("abort", onAbort, { once: true });
			const killTimer = setTimeout(() => {
				runState.timedOut = true;
				child.kill("SIGTERM");
				graceTimer = setTimeout(() => {
					child.kill("SIGKILL");
				}, KILL_GRACE_MS);
			}, timeoutMs);
			child.stdout.on("data", appendOutput);
			child.stderr.on("data", appendOutput);
			child.on("error", (error) => {
				runState.spawnError = error;
			});
			child.on("close", (code) => {
				clearTimeout(killTimer);
				if (graceTimer) {
					clearTimeout(graceTimer);
				}
				input.signal?.removeEventListener("abort", onAbort);
				runState.exitCode = code;
				resolve(true);
			});
		});

		const finishedAt = Date.now();
		const outputText = Buffer.concat(outputChunks).toString("utf8");
		const logPath = await this.writeLog({
			taskId: input.taskId,
			logDir,
			check,
			cwd,
			exitCode: runState.exitCode,
			startedAt,
			finishedAt,
			outputText,
			outputTruncated,
			attempt,
		});

		let status: RuntimeVerificationCheckResult["status"];
		let error: string | null = null;
		if (runState.spawnError) {
			status = isMissingExecutableError(runState.spawnError) ? "missing_executable" : "error";
			error = runState.spawnError.message;
		} else if (runState.timedOut) {
			status = "timeout";
			error = `exceeded the ${timeoutMs} ms timeout`;
		} else if (input.signal?.aborted) {
			status = "cancelled";
			error = "the verification run was cancelled";
		} else if (runState.exitCode === null) {
			status = "error";
			error = "the check process ended without an exit code";
		} else if (check.successExitCodes.includes(runState.exitCode)) {
			status = "passed";
		} else {
			status = "failed";
			error = `exit code ${runState.exitCode} (success codes: ${check.successExitCodes.join(", ")})`;
		}

		return {
			id: check.id,
			command: check.command,
			args: check.args,
			status,
			exitCode: runState.exitCode,
			emptyOutput: outputBytes === 0,
			outputExcerpt: outputText.slice(0, OUTPUT_EXCERPT_LIMIT_CHARS),
			logPath,
			startedAt,
			finishedAt,
			error,
		};
	}

	private async writeLog(input: {
		taskId: string;
		logDir: string;
		check: RuntimeVerificationCheck;
		cwd: string;
		exitCode: number | null;
		startedAt: number;
		finishedAt: number;
		outputText: string;
		outputTruncated: boolean;
		attempt: number;
	}): Promise<string | null> {
		const path = join(
			input.logDir,
			`${sanitizeLogId(input.check.id)}-${input.startedAt}-attempt${input.attempt + 1}.log`,
		);
		const header = [
			"# kanban verification check log",
			`task: ${input.taskId}`,
			`check: ${input.check.id}`,
			`command: ${[input.check.command, ...input.check.args].join(" ")}`,
			`cwd: ${input.cwd}`,
			`attempt: ${input.attempt + 1}`,
			`started_at: ${new Date(input.startedAt).toISOString()}`,
			`finished_at: ${new Date(input.finishedAt).toISOString()}`,
			`exit_code: ${input.exitCode ?? "null"}`,
			`output_truncated: ${input.outputTruncated}`,
			"---",
			"",
		].join("\n");
		try {
			await mkdir(input.logDir, { recursive: true });
			await writeFile(path, header + input.outputText, "utf8");
			return path;
		} catch {
			return null;
		}
	}
}

/** B-7: default runner used by the review session orchestrator (DI seam for tests). */
export function createVerificationRunner(): VerificationRunner {
	const service = new VerificationService();
	return { run: (config: RuntimeVerificationConfig, input: VerificationRunInput) => service.run(config, input) };
}
