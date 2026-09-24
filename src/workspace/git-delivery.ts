// B-8: deterministic git delivery.
//
// Application-controlled commit → integrate → push → remote verify → receipt,
// independent of model availability. The pipeline (B-8.1…B-8.9):
//
//   validate → stage → commit → integrate → push → verify → (optional PR)
//
// Invariants:
// - No force-push, no reset, no stash, no lock-file deletion (B-8.5). A
//   divergence or dirty destination pauses with evidence instead of guessing.
// - The push uses an explicit refspec (B-8.6); it never relies on ambient
//   `push.default` configuration (unlike git-sync.ts's home-branch sync).
// - A durable per-task receipt (`<task state home>/<taskId>/delivery/receipt.json`)
//   is persisted after every stage, so a crash leaves an explicit resumable
//   stage and retries reuse existing commits instead of creating new ones
//   (B-8.8). A clean worktree is never, by itself, evidence of delivery: a
//   HEAD that is not on the destination is delivered as-is.
// - When review/verification are required, delivery pauses unless the stored
//   ready verdict is bound to the exact candidate tree being committed
//   (B-6.7/B-7.6).
// - Integration/publication for a destination branch is serialized in-process;
//   cross-process safety comes from expected-old-SHA ref updates and the
//   remote's own ref-update atomicity (B-8.4/B-8.6).
//
// Git invocation conventions match src/workspace/git-sync.ts: argument arrays
// (never shell strings), sanitized process env (createGitProcessEnv), and
// bounded output via runGit. Task text is never interpolated into a shell
// (B-8.1).
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type {
	RuntimeGitDeliveryPolicy,
	RuntimeGitDeliveryReceipt,
	RuntimeGitDeliveryStage,
	RuntimeReviewOutcomeFile,
	RuntimeTaskDeliveryInfoResponse,
	RuntimeTaskDeliveryStartResponse,
	RuntimeTaskDependentsUnlock,
} from "../core/api-contract";
import { runtimeGitDeliveryReceiptSchema } from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { resolveTaskTitle } from "../core/task-title";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getTaskWorktreesHomePath, loadWorkspaceBoardById } from "../state/workspace-state";
import { runGit } from "./git-utils";
import { readTaskPreservationRecord } from "./task-preservation";
import { computeCandidateTreeHash, readReviewHandoff, readReviewOutcome } from "./task-review-handoff";
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";

const execFileAsync = promisify(execFile);
const DELIVERY_GH_MAX_BUFFER_BYTES = 1024 * 1024;
const DELIVERY_EVIDENCE_MAX_ENTRIES = 50;
const DELIVERY_ERROR_DETAIL_MAX_CHARS = 500;
const DELIVERY_EVIDENCE_PATH_MAX_LISTED = 20;
const DELIVERY_ARTIFACTS_DIR_NAME = "delivery";
const DELIVERY_RECEIPT_FILENAME = "receipt.json";
const DELIVERY_COMMIT_REF_PREFIX = "refs/kanban/delivery/";
const DELIVERY_REMOTE_TRACKING_REF_PREFIX = "refs/kanban/delivery-remotes/";

export interface GitDeliveryCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	output: string;
	error: string | null;
	exitCode: number;
}

/** Injectable git runner (tests substitute a scripted runner). */
export interface GitDeliveryRunner {
	run(cwd: string, args: string[]): Promise<GitDeliveryCommandResult>;
}

const defaultGitDeliveryRunner: GitDeliveryRunner = {
	run: (cwd, args) => runGit(cwd, args),
};

export interface GhCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
	/** True when the gh binary itself was missing (not installed). */
	missingBinary: boolean;
}

async function runGhCommand(args: string[], cwd: string): Promise<GhCommandResult> {
	try {
		const { stdout, stderr } = await execFileAsync("gh", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: DELIVERY_GH_MAX_BUFFER_BYTES,
			env: createGitProcessEnv(),
		});
		return {
			ok: true,
			stdout: String(stdout ?? "").trim(),
			stderr: String(stderr ?? "").trim(),
			exitCode: 0,
			missingBinary: false,
		};
	} catch (error) {
		const candidate = error as {
			code?: string | number | null;
			stdout?: unknown;
			stderr?: unknown;
			message?: unknown;
		};
		const message = String(candidate.message ?? "");
		return {
			ok: false,
			stdout: String(candidate.stdout ?? "").trim(),
			stderr: String(candidate.stderr ?? "").trim(),
			exitCode: typeof candidate.code === "number" ? candidate.code : -1,
			missingBinary: candidate.code === "ENOENT" || /ENOENT/.test(message),
		};
	}
}

export interface GitDeliveryGates {
	/** B-6.7: delivery requires a "ready" review bound to the current candidate tree. */
	reviewRequired: boolean;
	/** B-7.6: delivery requires a passing verification receipt bound to the current candidate tree. */
	verificationRequired: boolean;
}

export interface StartGitDeliveryInput {
	taskId: string;
	workspaceId: string;
	/** Main repository checkout (integration + push run here). */
	repoPath: string;
	/** Task worktree (detached HEAD; the task changes live here). */
	worktreePath: string;
	/** The card's base ref (null when unknown). */
	baseRef: string | null;
	/** Normalized git delivery policy (must be enabled). */
	policy: RuntimeGitDeliveryPolicy;
	/** Review/verification gates derived from the effective runtime config (default: both off). */
	gates?: GitDeliveryGates;
	/** Optional model-supplied commit message (B-8.2). */
	commitMessage?: string;
}

// --- receipt persistence (B-8.8) --------------------------------------------

/** Per-task directory for delivery artifacts (mirrors the review/verification dirs). */
export function getTaskDeliveryDir(taskId: string): string {
	return join(getTaskWorktreesHomePath(), normalizeTaskIdForWorktreePath(taskId), DELIVERY_ARTIFACTS_DIR_NAME);
}

function getTaskDeliveryReceiptPath(taskId: string): string {
	return join(getTaskDeliveryDir(taskId), DELIVERY_RECEIPT_FILENAME);
}

/**
 * Durable ref anchoring a task's delivery commit (B-8.3). It lives in its own
 * namespace: the B-5 preservation ref is `refs/kanban/tasks/<id>`, and git
 * cannot hold both `<x>` and `<x>/<y>` as refs.
 */
export function getTaskDeliveryCommitRefName(taskId: string): string {
	return `${DELIVERY_COMMIT_REF_PREFIX}${normalizeTaskIdForWorktreePath(taskId)}`;
}

/** B-8.8: read the durable delivery receipt (null when absent or malformed). */
export async function readTaskDeliveryReceipt(taskId: string): Promise<RuntimeGitDeliveryReceipt | null> {
	const rawText = await readFile(getTaskDeliveryReceiptPath(taskId), "utf8").catch(() => null);
	if (!rawText) {
		return null;
	}
	try {
		return runtimeGitDeliveryReceiptSchema.parse(JSON.parse(rawText));
	} catch {
		return null;
	}
}

/** True when a receipt records completed delivery (the evidence dependents may unlock on). */
export function isDeliveryReceiptComplete(receipt: RuntimeGitDeliveryReceipt | null): boolean {
	return receipt?.status === "delivered" || receipt?.status === "no_op";
}

/**
 * B-5.9/B-8.8: dependents may start only once delivery evidence exists. In
 * legacy (model-driven Git) mode there is no receipt to wait for, so the
 * pre-existing unlock-on-completion behavior is kept.
 */
export function evaluateDependentsUnlock(
	policy: RuntimeGitDeliveryPolicy | null | undefined,
	receipt: RuntimeGitDeliveryReceipt | null,
): RuntimeTaskDependentsUnlock {
	if (!policy?.enabled) {
		return { allowed: true, reason: null };
	}
	if (isDeliveryReceiptComplete(receipt)) {
		return { allowed: true, reason: null };
	}
	return {
		allowed: false,
		reason: receipt
			? `Delivery is ${receipt.status} at stage "${receipt.stage}"; linked tasks start once the task is delivered.`
			: "The task has not been delivered yet; linked tasks start once it is delivered.",
	};
}

async function persistDeliveryReceipt(receipt: RuntimeGitDeliveryReceipt): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getTaskDeliveryReceiptPath(receipt.taskId), receipt);
}

// --- deterministic parsing helpers ------------------------------------------

/**
 * Git reports canonical (symlink-resolved) worktree paths; macOS /tmp and user
 * paths are frequently symlinked, so identity checks must compare
 * canonicalized paths.
 */
function canonicalizeWorktreePath(path: string): string {
	try {
		return realpathSync.native(resolve(path));
	} catch {
		return resolve(path);
	}
}

interface WorktreeListEntry {
	path: string;
	head: string | null;
	branch: string | null;
}

function parseWorktreeList(output: string): WorktreeListEntry[] {
	const entries: WorktreeListEntry[] = [];
	let current: WorktreeListEntry | null = null;
	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = { path: resolve(line.slice("worktree ".length).trim()), head: null, branch: null };
			entries.push(current);
		} else if (current && line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length).trim();
		} else if (current && line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length).trim();
		}
	}
	return entries;
}

/** Returns the text after the first `fieldCount` space-separated fields (the path of a porcelain v2 record). */
function sliceAfterFields(record: string, fieldCount: number): string | null {
	let index = 0;
	for (let field = 0; field < fieldCount; field += 1) {
		const next = record.indexOf(" ", index);
		if (next === -1) {
			return null;
		}
		index = next + 1;
	}
	return record.slice(index) || null;
}

/**
 * B-8.2: the change manifest for one delivery — every changed path from
 * `git status --porcelain=v2 -z --untracked-files=all`, sorted and
 * deduplicated. Record layouts (git-status(1)):
 *   `1 XY sub mH mI mW hH hI <path>`                (8 fields before the path)
 *   `2 XY sub mH mI mW hH hI Xscore <path>\0<orig>` (9 fields; orig is the next record)
 *   `u XY sub m1 m2 m3 mW h1 h2 h3 <path>`          (10 fields)
 *   `? <path>`
 * Paths are NUL-terminated and never quoted, so spaces and non-ASCII names are safe.
 */
export function parseDeliveryChangeManifest(output: string): string[] {
	const paths = new Set<string>();
	const records = output.split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (!record) {
			continue;
		}
		let path: string | null = null;
		if (record.startsWith("1 ")) {
			path = sliceAfterFields(record, 8);
		} else if (record.startsWith("2 ")) {
			path = sliceAfterFields(record, 9);
			const originalPath = records[index + 1];
			index += 1;
			if (originalPath) {
				paths.add(originalPath);
			}
		} else if (record.startsWith("u ")) {
			path = sliceAfterFields(record, 10);
		} else if (record.startsWith("? ")) {
			path = record.slice(2) || null;
		}
		if (path) {
			paths.add(path);
		}
	}
	return [...paths].sort((a, b) => a.localeCompare(b));
}

/**
 * B-8.2: deterministic exclusions — secrets, generated logs, VCS internals, and
 * dependency trees never become part of a delivery commit. (Ignored files are
 * already absent from `git status`; these cover tracked/visible ones.)
 */
function isExcludedDeliveryPath(relativePath: string): boolean {
	const segments = relativePath.replaceAll("\\", "/").split("/");
	if (segments.some((segment) => segment === "node_modules" || segment === ".git")) {
		return true;
	}
	const name = segments[segments.length - 1] ?? "";
	if (name === ".DS_Store") {
		return true;
	}
	if (name === ".env" || name.startsWith(".env.")) {
		return true;
	}
	if (name.endsWith(".log")) {
		return true;
	}
	return name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12") || name.endsWith(".pfx");
}

function buildDeliveryCommitMessage(
	modelMessage: string | undefined,
	taskTitle: string | null,
	taskId: string,
): string {
	if (modelMessage) {
		const cleaned = modelMessage.replace(/\r\n/g, "\n").trim();
		if (cleaned) {
			return cleaned.length > 5000 ? `${cleaned.slice(0, 5000)}…` : cleaned;
		}
	}
	// B-8.2: deterministic fallback from the task title (no model required).
	return taskTitle ? `${taskTitle} (kanban ${taskId})` : `kanban task ${taskId}`;
}

function shortSha(sha: string | null): string {
	return sha ? sha.slice(0, 12) : "(none)";
}

function boundedPathList(paths: string[]): string {
	if (paths.length <= DELIVERY_EVIDENCE_PATH_MAX_LISTED) {
		return paths.join(", ");
	}
	const head = paths.slice(0, DELIVERY_EVIDENCE_PATH_MAX_LISTED).join(", ");
	return `${head} … (+${paths.length - DELIVERY_EVIDENCE_PATH_MAX_LISTED} more)`;
}

function parseGhJsonArray(output: string): Array<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(output);
		return Array.isArray(parsed)
			? parsed.filter(
					(entry): entry is Record<string, unknown> =>
						typeof entry === "object" && entry !== null && !Array.isArray(entry),
				)
			: [];
	} catch {
		return [];
	}
}

function parsePullRequestNumberFromUrl(url: string | null): number | null {
	const match = url?.match(/\/pull\/(\d+)/);
	return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function isResumableStatus(status: RuntimeGitDeliveryReceipt["status"]): boolean {
	return status === "in_progress" || status === "failed" || status === "paused";
}

// --- delivery service --------------------------------------------------------

export interface GitDeliveryServiceOptions {
	/** Injectable git runner (defaults to the shared runGit conventions). */
	git?: GitDeliveryRunner;
	/** Injectable gh runner (defaults to the gh CLI via execFile, run inside the repository). */
	gh?: (args: string[], cwd: string) => Promise<GhCommandResult>;
	/** Injectable candidate-tree hash (defaults to the review/verification tree identity). */
	computeTreeHash?: (worktreePath: string) => Promise<string | null>;
}

type EvidenceRecorder = (stage: string, detail: string) => void;

export class GitDeliveryService {
	private readonly git: GitDeliveryRunner;
	private readonly gh: (args: string[], cwd: string) => Promise<GhCommandResult>;
	private readonly computeTreeHash: (worktreePath: string) => Promise<string | null>;
	private readonly inFlightByDestination: Map<string, Promise<unknown>> = new Map();

	constructor(options: GitDeliveryServiceOptions = {}) {
		this.git = options.git ?? defaultGitDeliveryRunner;
		this.gh = options.gh ?? runGhCommand;
		this.computeTreeHash = options.computeTreeHash ?? computeCandidateTreeHash;
	}

	/** B-8.6: serialize integration/publication for a destination branch. */
	private serializeForDestination<T>(repoPath: string, destinationBranch: string, run: () => Promise<T>): Promise<T> {
		const key = `${canonicalizeWorktreePath(repoPath)}::${destinationBranch}`;
		const previous = this.inFlightByDestination.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(() => run());
		const settled = next.catch(() => undefined);
		this.inFlightByDestination.set(key, settled);
		void settled.then(() => {
			if (this.inFlightByDestination.get(key) === settled) {
				this.inFlightByDestination.delete(key);
			}
		});
		return next;
	}

	async startDelivery(input: StartGitDeliveryInput): Promise<RuntimeTaskDeliveryStartResponse> {
		const policy = input.policy;
		if (!policy.enabled) {
			return {
				ok: false,
				receipt: null,
				error: "Git delivery is not enabled; enable gitDeliveryPolicy in the runtime settings first.",
			};
		}
		const destinationBranch = policy.destinationBranch ?? input.baseRef;
		if (!destinationBranch) {
			return {
				ok: false,
				receipt: null,
				error: "Cannot determine the delivery destination branch: set gitDeliveryPolicy.destinationBranch or give the task a base ref.",
			};
		}
		// B-8.3: respect protected-branch settings; the target deployment uses a
		// feature branch, never a protected one.
		if (policy.protectedBranches.includes(destinationBranch)) {
			return {
				ok: false,
				receipt: null,
				error: `Delivery destination "${destinationBranch}" is in gitDeliveryPolicy.protectedBranches; choose a feature branch.`,
			};
		}
		const remoteResult = await this.git.run(input.repoPath, ["remote", "get-url", policy.remote]);
		if (!remoteResult.ok) {
			return {
				ok: false,
				receipt: null,
				error: `Remote "${policy.remote}" is not configured on the repository at ${input.repoPath}.`,
			};
		}
		try {
			return await this.serializeForDestination(input.repoPath, destinationBranch, () =>
				this.runPipeline(input, destinationBranch),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, receipt: null, error: message };
		}
	}

	/**
	 * B-8.8: read the durable delivery receipt for a task (null when none) and
	 * whether it is evidence enough to start the task's dependents (B-5.9).
	 */
	async getDeliveryInfo(
		taskId: string,
		policy: RuntimeGitDeliveryPolicy | null | undefined,
	): Promise<RuntimeTaskDeliveryInfoResponse> {
		try {
			const receipt = await readTaskDeliveryReceipt(taskId);
			return { ok: true, receipt, error: null, dependentsUnlock: evaluateDependentsUnlock(policy, receipt) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				receipt: null,
				error: message,
				dependentsUnlock: { allowed: false, reason: `The delivery receipt could not be read: ${message}` },
			};
		}
	}

	private async runPipeline(
		input: StartGitDeliveryInput,
		destinationBranch: string,
	): Promise<RuntimeTaskDeliveryStartResponse> {
		const previous = await readTaskDeliveryReceipt(input.taskId);
		const gates: GitDeliveryGates = input.gates ?? { reviewRequired: false, verificationRequired: false };
		const now = Date.now();
		const receipt: RuntimeGitDeliveryReceipt = {
			taskId: input.taskId,
			workspaceId: input.workspaceId,
			repoPath: input.repoPath,
			worktreePath: input.worktreePath,
			baseRef: input.baseRef,
			baseSha: null,
			destinationBranch,
			remote: input.policy.remote,
			remoteBranchSha: null,
			taskCommitSha: null,
			integratedSha: null,
			status: "in_progress",
			stage: "validated",
			policy: input.policy,
			commitMessageSource: null,
			stagedPaths: [],
			excludedPaths: [],
			reviewOutcome: null,
			verificationPassed: null,
			candidateTreeHash: null,
			pr: { status: "not_required", number: null, url: null, error: null },
			evidence: [],
			attempt: (previous?.attempt ?? 0) + 1,
			startedAt: previous?.startedAt ?? now,
			updatedAt: now,
		};
		const evidence: EvidenceRecorder = (stage, detail) => {
			receipt.evidence.push({ stage, detail });
			if (receipt.evidence.length > DELIVERY_EVIDENCE_MAX_ENTRIES) {
				receipt.evidence.splice(0, receipt.evidence.length - DELIVERY_EVIDENCE_MAX_ENTRIES);
			}
		};
		const checkpoint = async (stage: RuntimeGitDeliveryStage): Promise<void> => {
			receipt.stage = stage;
			receipt.updatedAt = Date.now();
			await persistDeliveryReceipt(receipt);
		};
		const stop = async (
			status: "failed" | "paused",
			stage: RuntimeGitDeliveryStage,
			detail: string,
		): Promise<RuntimeTaskDeliveryStartResponse> => {
			receipt.status = status;
			evidence(stage, detail.slice(0, DELIVERY_ERROR_DETAIL_MAX_CHARS));
			await checkpoint(stage);
			return { ok: false, receipt, error: detail };
		};
		const fail = (stage: RuntimeGitDeliveryStage, detail: string) => stop("failed", stage, detail);
		const pauseHere = (stage: RuntimeGitDeliveryStage, detail: string) => stop("paused", stage, detail);

		// --- B-8.1: repository/worktree identity and operation state ---------
		const insideResult = await this.git.run(input.worktreePath, ["rev-parse", "--is-inside-work-tree"]);
		if (!insideResult.ok || insideResult.stdout !== "true") {
			return await fail("validated", `Task worktree at ${input.worktreePath} is not a usable git worktree.`);
		}
		const worktreeListResult = await this.git.run(input.repoPath, ["worktree", "list", "--porcelain"]);
		if (!worktreeListResult.ok) {
			return await fail(
				"validated",
				`Could not read the repository worktree list: ${worktreeListResult.stderr || "git worktree list failed."}`,
			);
		}
		const worktreeEntries = parseWorktreeList(worktreeListResult.stdout);
		if (!worktreeEntries.some((entry) => entry.path === canonicalizeWorktreePath(input.worktreePath))) {
			return await fail(
				"validated",
				`Task worktree at ${input.worktreePath} is not registered in the repository at ${input.repoPath}.`,
			);
		}
		const headResult = await this.git.run(input.worktreePath, ["rev-parse", "--verify", "HEAD"]);
		if (!headResult.ok) {
			return await fail("validated", "Task worktree has no HEAD commit; nothing can be committed or delivered.");
		}
		const headSha = headResult.stdout;

		// The recorded base: the review handoff's starting commit, else the
		// B-5 preservation record's (the worktree's first observed HEAD).
		const handoff = await readReviewHandoff(input.taskId).catch(() => null);
		const preservation = await readTaskPreservationRecord(input.taskId).catch(() => null);
		receipt.baseSha = handoff?.startingCommit ?? preservation?.startingCommit ?? null;
		// A prior successful delivery advances the expected base to that
		// delivery's integrated sha, so follow-up deliveries fast-forward from
		// where the last one landed instead of stalling on the original base.
		const requiredBaseSha =
			previous?.status === "delivered" && previous.integratedSha ? previous.integratedSha : receipt.baseSha;

		// --- B-8.4: resolve the destination before deciding what to deliver --
		const destRef = `refs/heads/${destinationBranch}`;
		const destRefResult = await this.git.run(input.repoPath, ["rev-parse", "--verify", "--quiet", destRef]);
		let destSha = destRefResult.ok && destRefResult.stdout ? destRefResult.stdout : null;
		if (destSha === null) {
			// Prefer the remote branch (never silently fork from it), then the recorded base.
			const remoteSha = await this.readRemoteBranchSha(input.repoPath, input.policy.remote, destinationBranch);
			const startPoint = remoteSha ?? requiredBaseSha;
			if (!startPoint) {
				return await fail(
					"validated",
					`Destination branch "${destinationBranch}" does not exist locally or on "${input.policy.remote}", and no starting commit was recorded to create it from.`,
				);
			}
			const createBranchResult = await this.git.run(input.repoPath, ["branch", destinationBranch, startPoint]);
			if (!createBranchResult.ok) {
				return await fail(
					"validated",
					`Could not create destination branch "${destinationBranch}": ${createBranchResult.stderr || "git branch failed."}`,
				);
			}
			destSha = startPoint;
			evidence(
				"validated",
				`created local destination branch ${destinationBranch} at ${
					remoteSha ? `${input.policy.remote}/${destinationBranch}` : "the recorded base"
				} ${shortSha(destSha)}`,
			);
		}

		// --- B-8.2: the change manifest --------------------------------------
		const statusResult = await this.git.run(input.worktreePath, [
			"status",
			"--porcelain=v2",
			"-z",
			"--untracked-files=all",
		]);
		if (!statusResult.ok) {
			return await fail(
				"validated",
				`Could not read the worktree status: ${statusResult.stderr || "git status failed."}`,
			);
		}
		const candidates = parseDeliveryChangeManifest(statusResult.stdout);
		receipt.stagedPaths = candidates.filter((path) => !isExcludedDeliveryPath(path));
		receipt.excludedPaths = candidates.filter((path) => isExcludedDeliveryPath(path));

		// --- B-8.8: decide what to deliver (reuse before creating) -----------
		const resumable =
			previous !== null &&
			isResumableStatus(previous.status) &&
			previous.taskCommitSha !== null &&
			(await this.isAncestorOf(input.repoPath, previous.taskCommitSha, destSha));
		const headIntegrated = await this.isAncestorOf(input.repoPath, headSha, destSha);
		let reuseCommitSha: string | null = null;
		if (receipt.stagedPaths.length === 0) {
			if (!headIntegrated) {
				// A clean worktree whose HEAD is not on the destination still holds
				// undelivered work (agent/manual commits, or a commit from a crashed
				// attempt) — zero changed files is not a delivery receipt (B-5.4).
				reuseCommitSha = headSha;
			} else if (resumable && previous?.taskCommitSha) {
				// Integrated locally by an interrupted attempt; resume publication.
				reuseCommitSha = previous.taskCommitSha;
			} else if (previous && isDeliveryReceiptComplete(previous)) {
				evidence("validated", "no new work and a prior delivery already completed; returning the stored receipt");
				return { ok: true, receipt: previous, error: null };
			} else {
				receipt.status = "no_op";
				evidence(
					"staged",
					`no changes and HEAD ${shortSha(headSha)} is already on ${destinationBranch}; nothing to deliver (no-op)`,
				);
				await checkpoint("staged");
				return { ok: true, receipt, error: null };
			}
		}

		// --- B-6.7/B-7.6: the candidate must be the reviewed/verified tree ----
		const resumingPublication = reuseCommitSha !== null && reuseCommitSha === previous?.taskCommitSha;
		const reviewOutcome = await readReviewOutcome(input.taskId).catch(() => null);
		receipt.reviewOutcome = reviewOutcome ? (reviewOutcome.status === "ready" ? "ready" : "not_ready") : "absent";
		receipt.verificationPassed = reviewOutcome?.verification?.passed ?? null;
		receipt.candidateTreeHash = resumingPublication
			? (previous?.candidateTreeHash ?? null)
			: await this.computeTreeHash(input.worktreePath).catch(() => null);
		const gateFailure = resumingPublication
			? null
			: this.evaluateGates(gates, reviewOutcome, receipt.candidateTreeHash);
		evidence(
			"validated",
			`worktree OK (HEAD ${shortSha(headSha)}); review: ${receipt.reviewOutcome}; verification passed: ${
				receipt.verificationPassed ?? "n/a"
			}; recorded base: ${shortSha(receipt.baseSha)}; gates: review ${gates.reviewRequired ? "required" : "off"}, verification ${
				gates.verificationRequired ? "required" : "off"
			}`,
		);
		if (gateFailure) {
			return await pauseHere("validated", gateFailure);
		}

		// --- B-8.2/B-8.3: stage the manifest and commit ----------------------
		let taskCommitSha: string;
		if (reuseCommitSha !== null) {
			taskCommitSha = reuseCommitSha;
			receipt.commitMessageSource = "reused";
			evidence(
				"committed",
				resumingPublication
					? `resuming the interrupted delivery of task commit ${shortSha(taskCommitSha)}`
					: `worktree is clean but HEAD ${shortSha(taskCommitSha)} is not on ${destinationBranch}; delivering the existing commits`,
			);
		} else {
			const addResult = await this.git.run(input.worktreePath, ["add", "-A", "--", "."]);
			if (!addResult.ok) {
				return await fail(
					"validated",
					`Staging failed: ${addResult.stderr || addResult.error || "git add failed."}`,
				);
			}
			if (receipt.excludedPaths.length > 0) {
				// Also covers excluded paths an agent staged earlier: the commit
				// takes the whole index, so they must leave it (worktree untouched).
				const unstageResult = await this.git.run(input.worktreePath, [
					"restore",
					"--staged",
					"--",
					...receipt.excludedPaths,
				]);
				if (!unstageResult.ok) {
					return await fail(
						"validated",
						`Could not unstage excluded paths: ${unstageResult.stderr || "git restore --staged failed."}`,
					);
				}
				evidence(
					"staged",
					`excluded ${receipt.excludedPaths.length} path(s) by policy: ${boundedPathList(receipt.excludedPaths)}`,
				);
			}
			evidence("staged", `staged ${receipt.stagedPaths.length} path(s): ${boundedPathList(receipt.stagedPaths)}`);
			await checkpoint("staged");

			const taskTitle = await this.readTaskTitle(input.workspaceId, input.taskId);
			const message = buildDeliveryCommitMessage(input.commitMessage, taskTitle, input.taskId);
			receipt.commitMessageSource = input.commitMessage ? "model" : "fallback";
			const commitResult = await this.git.run(input.worktreePath, ["commit", "-m", message]);
			if (!commitResult.ok) {
				return await fail(
					"staged",
					`Commit failed (hooks and signing settings are respected, not bypassed): ${
						commitResult.stderr || commitResult.error || "git commit failed."
					}`,
				);
			}
			const newHeadResult = await this.git.run(input.worktreePath, ["rev-parse", "HEAD"]);
			if (!newHeadResult.ok || !newHeadResult.stdout) {
				return await fail("staged", "Commit succeeded but the new HEAD could not be read.");
			}
			taskCommitSha = newHeadResult.stdout;
			evidence(
				"committed",
				`created task commit ${shortSha(taskCommitSha)} (message source: ${receipt.commitMessageSource})`,
			);
		}
		receipt.taskCommitSha = taskCommitSha;
		const taskCommitRef = getTaskDeliveryCommitRefName(input.taskId);
		const updateRefResult = await this.git.run(input.repoPath, ["update-ref", taskCommitRef, taskCommitSha]);
		if (!updateRefResult.ok) {
			// The commit exists (HEAD); a retry reuses it rather than committing again.
			return await fail(
				"committed",
				`Could not record the durable task commit ref ${taskCommitRef}: ${
					updateRefResult.stderr || "git update-ref failed."
				}`,
			);
		}
		await checkpoint("committed");

		// --- B-8.4/B-8.5: integrate onto the destination branch -------------
		const integrated = await this.integrate({
			input,
			destinationBranch,
			destRef,
			destSha,
			taskCommitSha,
			requiredBaseSha,
			previous,
			worktreeEntries,
			evidence,
		});
		if (!integrated.ok) {
			return integrated.paused
				? await pauseHere("committed", integrated.detail)
				: await fail("committed", integrated.detail);
		}
		receipt.integratedSha = integrated.integratedSha;
		await checkpoint("integrated");

		// --- B-8.6/B-8.7: push an explicit refspec, then verify the remote --
		if (!input.policy.pushRequired) {
			receipt.status = "delivered";
			evidence("pushed", "push not required by policy; delivery is complete locally");
			await checkpoint("integrated");
			return await this.finishPr(input, receipt, evidence);
		}
		const integratedSha = integrated.integratedSha;
		const pushRefSpec = `${destRef}:${destRef}`;
		const pushResult = await this.git.run(input.repoPath, ["push", input.policy.remote, pushRefSpec]);
		if (pushResult.ok) {
			evidence("pushed", `pushed ${pushRefSpec} to remote "${input.policy.remote}"`);
		} else {
			evidence(
				"pushed",
				`push reported a failure; reconciling against the remote: ${(
					pushResult.stderr || pushResult.error || ""
				).slice(0, DELIVERY_ERROR_DETAIL_MAX_CHARS)}`,
			);
		}
		// B-8.7/B-8.8: verify the remote equals or contains the delivered commit.
		// This is also the reconciliation for an ambiguous push failure (e.g. a
		// timeout after the server accepted the update) — never push a different
		// commit, and remote movement that excludes the delivery blocks completion.
		const remoteSha = await this.readRemoteBranchSha(input.repoPath, input.policy.remote, destinationBranch);
		const remoteContainsDelivered =
			remoteSha !== null && (await this.isAncestorOf(input.repoPath, integratedSha, remoteSha));
		if (!remoteContainsDelivered) {
			if (!pushResult.ok) {
				return await fail(
					"integrated",
					`Push to "${input.policy.remote}" failed: ${(
						pushResult.stderr || pushResult.error || "git push failed."
					).slice(
						0,
						DELIVERY_ERROR_DETAIL_MAX_CHARS,
					)} The remote does not contain the delivered commit; resolve the remote state and retry (the local commit and integration are preserved).`,
				);
			}
			return await pauseHere(
				"pushed",
				`Remote "${input.policy.remote}" branch "${destinationBranch}" does not contain the delivered commit ${shortSha(
					integratedSha,
				)} after push; completion is blocked until the remote ref is restored or the delivery is re-run.`,
			);
		}
		if (!pushResult.ok) {
			evidence(
				"pushed",
				`the remote already contains ${shortSha(integratedSha)}; reconciled as pushed (no second push)`,
			);
		}
		receipt.remoteBranchSha = remoteSha;
		receipt.status = "delivered";
		evidence(
			"verified",
			`remote "${input.policy.remote}" branch "${destinationBranch}" at ${shortSha(remoteSha)} contains the delivered commit ${shortSha(
				integratedSha,
			)}`,
		);
		await checkpoint("verified");

		return await this.finishPr(input, receipt, evidence);
	}

	/**
	 * B-6.7/B-7.6: returns the reason delivery must pause when a required gate
	 * has no passing evidence bound to the current candidate tree, else null.
	 */
	private evaluateGates(
		gates: GitDeliveryGates,
		outcome: RuntimeReviewOutcomeFile | null,
		candidateTreeHash: string | null,
	): string | null {
		if (!gates.reviewRequired && !gates.verificationRequired) {
			return null;
		}
		if (!outcome) {
			return "Delivery requires a completed review/verification, but none was recorded for this task. Run the review first.";
		}
		const boundTreeHash = outcome.result?.candidateTreeHash ?? null;
		if (candidateTreeHash === null || boundTreeHash === null || boundTreeHash !== candidateTreeHash) {
			return "The task changed after its review/verification (candidate tree mismatch); re-run the review before delivery.";
		}
		if (gates.reviewRequired && outcome.status !== "ready") {
			return `Delivery requires a "ready" review, but the latest review is "${outcome.status}"${
				outcome.error ? `: ${outcome.error}` : "."
			}`;
		}
		if (gates.verificationRequired && outcome.verification?.passed !== true) {
			return `Delivery requires passing verification checks${
				outcome.verification?.error
					? `: ${outcome.verification.error}`
					: ", but no passing verification receipt was recorded."
			}`;
		}
		return null;
	}

	/**
	 * B-8.4/B-8.5: integrate the task commit onto the destination. Returns the
	 * destination sha after integration, or why it must pause/fail. Never
	 * force-updates, resets, stashes, or resolves conflicts.
	 */
	private async integrate(options: {
		input: StartGitDeliveryInput;
		destinationBranch: string;
		destRef: string;
		destSha: string;
		taskCommitSha: string;
		requiredBaseSha: string | null;
		previous: RuntimeGitDeliveryReceipt | null;
		worktreeEntries: WorktreeListEntry[];
		evidence: EvidenceRecorder;
	}): Promise<{ ok: true; integratedSha: string } | { ok: false; paused: boolean; detail: string }> {
		const { input, destinationBranch, destRef, destSha, taskCommitSha, requiredBaseSha, previous, evidence } =
			options;
		const repoPath = input.repoPath;
		if (await this.isAncestorOf(repoPath, taskCommitSha, destSha)) {
			// Already integrated (a crashed/ambiguous prior attempt, or a merge
			// commit that contains it); never create a second merge.
			evidence(
				"integrated",
				`destination ${shortSha(destSha)} already contains task commit ${shortSha(taskCommitSha)}; integration skipped`,
			);
			return { ok: true, integratedSha: destSha };
		}
		const isMerge = input.policy.integrationStrategy === "merge";
		const destIsAncestor = await this.isAncestorOf(repoPath, destSha, taskCommitSha);
		// Follow-up delivery under the merge strategy: the destination sits on
		// the previous merge commit, which the new task commit does not contain.
		const mergeFollowUp =
			isMerge &&
			previous?.status === "delivered" &&
			previous.integratedSha === destSha &&
			previous.taskCommitSha !== null &&
			(await this.isAncestorOf(repoPath, previous.taskCommitSha, taskCommitSha));
		const baseMatches = requiredBaseSha === null || destSha === requiredBaseSha || destIsAncestor;
		if (!(destIsAncestor || mergeFollowUp) || !baseMatches) {
			return {
				ok: false,
				paused: true,
				detail: `Destination "${destinationBranch}" is at ${shortSha(destSha)}, which is not contained in task commit ${shortSha(
					taskCommitSha,
				)}${
					requiredBaseSha ? ` (recorded base ${shortSha(requiredBaseSha)})` : ""
				}; it advanced or diverged. Re-run the task from the current branch tip or reconcile the branch, then retry. No force/reset/stash was performed.`,
			};
		}

		const destWorktree = options.worktreeEntries.find((entry) => entry.branch === destRef);
		if (destWorktree) {
			// B-8.4: checked out → refuse dirty state, then the worktree-aware merge.
			const cleanResult = await this.git.run(destWorktree.path, ["status", "--porcelain"]);
			if (!cleanResult.ok || cleanResult.stdout.trim() !== "") {
				return {
					ok: false,
					paused: true,
					detail: `Destination "${destinationBranch}" is checked out at ${destWorktree.path} with uncommitted changes; commit or stash them in that worktree, then retry delivery.`,
				};
			}
			const mergeArgs = isMerge
				? ["merge", "--no-ff", "--no-edit", taskCommitSha]
				: ["merge", "--ff-only", taskCommitSha];
			const mergeResult = await this.git.run(destWorktree.path, mergeArgs);
			if (!mergeResult.ok) {
				return {
					ok: false,
					paused: true,
					detail: `Integration onto "${destinationBranch}" failed in ${destWorktree.path}: ${
						mergeResult.stderr || "git merge failed."
					} No conflicts were auto-resolved.`,
				};
			}
			const headAfter = (await this.git.run(destWorktree.path, ["rev-parse", "HEAD"])).stdout;
			if (!headAfter) {
				return {
					ok: false,
					paused: false,
					detail: "Integration finished but the new destination sha could not be read.",
				};
			}
			evidence(
				"integrated",
				`integrated ${shortSha(taskCommitSha)} onto ${destinationBranch} at ${shortSha(headAfter)}`,
			);
			return { ok: true, integratedSha: headAfter };
		}

		let newDestSha = taskCommitSha;
		if (isMerge) {
			// Not checked out: build the merge commit with plumbing so no worktree
			// is touched. The dest is contained in the task commit's line of work,
			// so the task tree is the merge result.
			const treeResult = await this.git.run(repoPath, ["rev-parse", `${taskCommitSha}^{tree}`]);
			if (!treeResult.ok) {
				return {
					ok: false,
					paused: false,
					detail: `Could not read the task commit tree: ${treeResult.stderr || "git rev-parse failed."}`,
				};
			}
			const mergeCommitResult = await this.git.run(repoPath, [
				"commit-tree",
				treeResult.stdout,
				"-p",
				destSha,
				"-p",
				taskCommitSha,
				"-m",
				`Merge task commit ${shortSha(taskCommitSha)} into ${destinationBranch} (kanban ${input.taskId})`,
			]);
			if (!mergeCommitResult.ok || !mergeCommitResult.stdout) {
				return {
					ok: false,
					paused: false,
					detail: `Could not build the merge commit: ${mergeCommitResult.stderr || "git commit-tree failed."}`,
				};
			}
			newDestSha = mergeCommitResult.stdout;
		}
		// B-8.4: expected-old-SHA ref update (atomic; a concurrent move fails instead of clobbering).
		const updateResult = await this.git.run(repoPath, ["update-ref", destRef, newDestSha, destSha]);
		if (!updateResult.ok) {
			return {
				ok: false,
				paused: true,
				detail: `Destination "${destinationBranch}" moved while integrating; retry delivery.`,
			};
		}
		evidence(
			"integrated",
			`integrated ${shortSha(taskCommitSha)} onto ${destinationBranch} at ${shortSha(newDestSha)}`,
		);
		return { ok: true, integratedSha: newDestSha };
	}

	/**
	 * Fetch <remote>/<branch> into a delivery-owned tracking ref and return its
	 * sha (null when the branch or remote is unavailable). A dedicated ref avoids
	 * racing other fetches over FETCH_HEAD.
	 */
	private async readRemoteBranchSha(repoPath: string, remote: string, branch: string): Promise<string | null> {
		const trackingRef = `${DELIVERY_REMOTE_TRACKING_REF_PREFIX}${remote}/${branch}`;
		const fetchResult = await this.git.run(repoPath, [
			"fetch",
			"--no-tags",
			remote,
			`+refs/heads/${branch}:${trackingRef}`,
		]);
		if (!fetchResult.ok) {
			return null;
		}
		const shaResult = await this.git.run(repoPath, ["rev-parse", "--verify", "--quiet", trackingRef]);
		return shaResult.ok && shaResult.stdout ? shaResult.stdout : null;
	}

	/** True when `candidateSha` is equal to or an ancestor of `referenceSha`. */
	private async isAncestorOf(cwd: string, candidateSha: string, referenceSha: string): Promise<boolean> {
		const result = await this.git.run(cwd, ["merge-base", "--is-ancestor", candidateSha, referenceSha]);
		return result.ok;
	}

	private async readTaskTitle(workspaceId: string, taskId: string): Promise<string | null> {
		const board = await loadWorkspaceBoardById(workspaceId).catch(() => null);
		for (const column of board?.columns ?? []) {
			for (const card of column.cards) {
				if (card.id === taskId) {
					return resolveTaskTitle(card.title, card.prompt) || null;
				}
			}
		}
		return null;
	}

	// --- B-8.9: optional PR creation, kept separate from commit/push ---------

	private async finishPr(
		input: StartGitDeliveryInput,
		receipt: RuntimeGitDeliveryReceipt,
		evidence: EvidenceRecorder,
	): Promise<RuntimeTaskDeliveryStartResponse> {
		if (!input.policy.requirePullRequest) {
			receipt.pr = { status: "not_required", number: null, url: null, error: null };
		} else if (!input.policy.pushRequired) {
			receipt.pr = {
				status: "skipped",
				number: null,
				url: null,
				error: "Push is not required by policy; no PR was created.",
			};
			evidence("pr", receipt.pr.error ?? "PR skipped.");
		} else {
			const taskTitle = await this.readTaskTitle(input.workspaceId, input.taskId);
			receipt.pr = await this.openPullRequest(input, receipt, taskTitle);
			if (receipt.pr.status === "failed") {
				// B-8.9: preserve the pushed commit on PR creation failure.
				evidence("pr", `PR creation failed (push is preserved): ${receipt.pr.error ?? "unknown gh error"}`);
			} else {
				evidence("pr", `pull request ${receipt.pr.status}${receipt.pr.url ? ` at ${receipt.pr.url}` : ""}`);
			}
		}
		receipt.stage = "pr";
		receipt.updatedAt = Date.now();
		await persistDeliveryReceipt(receipt);
		return { ok: true, receipt, error: null };
	}

	private async openPullRequest(
		input: StartGitDeliveryInput,
		receipt: RuntimeGitDeliveryReceipt,
		taskTitle: string | null,
	): Promise<NonNullable<RuntimeGitDeliveryReceipt["pr"]>> {
		const base = input.policy.pullRequestBaseBranch;
		const head = receipt.destinationBranch;
		const baseArgs = base ? ["--base", base] : [];
		// B-8.9: deduplicate by head/base — an open PR wins over creation.
		const existing = await this.gh(
			["pr", "list", "--head", head, ...baseArgs, "--state", "open", "--json", "number,url", "--limit", "1"],
			input.repoPath,
		);
		if (existing.missingBinary) {
			return { status: "skipped", number: null, url: null, error: "gh CLI is not installed; PR creation skipped." };
		}
		if (existing.ok) {
			const match = parseGhJsonArray(existing.stdout)[0];
			if (match && typeof match.number === "number") {
				return {
					status: "existing",
					number: match.number,
					url: typeof match.url === "string" ? match.url : null,
					error: null,
				};
			}
		}
		const prTitle = taskTitle ? `${taskTitle} (kanban ${input.taskId})` : `kanban task ${input.taskId}`;
		const body = [
			`Deterministic Kanban delivery (B-8) of task ${input.taskId}.`,
			``,
			`- Destination branch: ${head}`,
			receipt.taskCommitSha ? `- Task commit: ${receipt.taskCommitSha}` : null,
			`- Delivery receipt: ${getTaskDeliveryReceiptPath(input.taskId)}`,
		]
			.filter((line): line is string => line !== null)
			.join("\n");
		const createResult = await this.gh(
			["pr", "create", "--head", head, ...baseArgs, "--title", prTitle, "--body", body],
			input.repoPath,
		);
		if (!createResult.ok) {
			return {
				status: createResult.missingBinary ? "skipped" : "failed",
				number: null,
				url: null,
				error: createResult.missingBinary
					? "gh CLI is not installed; PR creation skipped."
					: (createResult.stderr || "gh pr create failed").slice(0, DELIVERY_ERROR_DETAIL_MAX_CHARS),
			};
		}
		const url = createResult.stdout.match(/https?:\/\/\S+/)?.[0] ?? null;
		return { status: "created", number: parsePullRequestNumberFromUrl(url), url, error: null };
	}
}

let defaultService: GitDeliveryService | null = null;

/**
 * Shared service instance: per-destination serialization (B-8.6) must span
 * requests, so all runtime delivery routes share one instance. Tests construct
 * their own services with injected runners.
 */
export function getGitDeliveryService(): GitDeliveryService {
	if (!defaultService) {
		defaultService = new GitDeliveryService();
	}
	return defaultService;
}
