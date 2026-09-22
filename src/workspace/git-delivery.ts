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
//   (B-8.8).
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
	RuntimeTaskDeliveryInfoResponse,
	RuntimeTaskDeliveryStartResponse,
} from "../core/api-contract";
import { runtimeGitDeliveryReceiptSchema } from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { resolveTaskTitle } from "../core/task-title";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getTaskWorktreesHomePath, loadWorkspaceBoardById } from "../state/workspace-state";
import { runGit } from "./git-utils";
import { readReviewHandoff, readReviewOutcome } from "./task-review-handoff";
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";

const execFileAsync = promisify(execFile);
const DELIVERY_GH_MAX_BUFFER_BYTES = 1024 * 1024;
const DELIVERY_EVIDENCE_MAX_ENTRIES = 50;
const DELIVERY_ERROR_DETAIL_MAX_CHARS = 500;
const DELIVERY_EVIDENCE_PATH_MAX_LISTED = 20;
const DELIVERY_ARTIFACTS_DIR_NAME = "delivery";
const DELIVERY_RECEIPT_FILENAME = "receipt.json";
const TASK_COMMIT_REF_PREFIX = "refs/kanban/tasks/";

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

async function runGhCommand(args: string[]): Promise<GhCommandResult> {
	try {
		const { stdout, stderr } = await execFileAsync("gh", args, {
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

/**
 * B-8.2: the change manifest for one delivery — tracked changes (including
 * unmerged) plus untracked (not ignored) paths from `git status --porcelain=v2`,
 * sorted and deduplicated.
 */
function parseDeliveryChangeManifest(output: string): string[] {
	const paths = new Set<string>();
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line) {
			continue;
		}
		if (line.startsWith("1 ") || line.startsWith("u ") || line.startsWith("2 ")) {
			const parts = line.split("\t");
			const path = parts[parts.length - 1]?.trim();
			if (path) {
				paths.add(path);
			}
		} else if (line.startsWith("? ")) {
			const path = line.slice(2).trim();
			if (path) {
				paths.add(path);
			}
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

function parseGhJson(output: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(output);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

// --- delivery service --------------------------------------------------------

export interface GitDeliveryServiceOptions {
	/** Injectable git runner (defaults to the shared runGit conventions). */
	git?: GitDeliveryRunner;
	/** Injectable gh runner (defaults to the gh CLI via execFile). */
	gh?: (args: string[]) => Promise<GhCommandResult>;
}

export class GitDeliveryService {
	private readonly git: GitDeliveryRunner;
	private readonly gh: (args: string[]) => Promise<GhCommandResult>;
	private readonly inFlightByDestination: Map<string, Promise<unknown>> = new Map();

	constructor(options: GitDeliveryServiceOptions = {}) {
		this.git = options.git ?? defaultGitDeliveryRunner;
		this.gh = options.gh ?? runGhCommand;
	}

	/** B-8.6: serialize integration/publication for a destination branch. */
	private serializeForDestination<T>(repoPath: string, destinationBranch: string, run: () => Promise<T>): Promise<T> {
		const key = `${resolve(repoPath)}::${destinationBranch}`;
		const previous = this.inFlightByDestination.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(() => run());
		this.inFlightByDestination.set(
			key,
			next.catch(() => undefined),
		);
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

	/** B-8.8: read the durable delivery receipt for a task (null when none). */
	async getDeliveryInfo(taskId: string): Promise<RuntimeTaskDeliveryInfoResponse> {
		try {
			const receipt = await readTaskDeliveryReceipt(taskId);
			return { ok: true, receipt, error: null };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, receipt: null, error: message };
		}
	}

	private async runPipeline(
		input: StartGitDeliveryInput,
		destinationBranch: string,
	): Promise<RuntimeTaskDeliveryStartResponse> {
		const previous = await readTaskDeliveryReceipt(input.taskId);
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
			status: "failed",
			stage: "validated",
			policy: input.policy,
			commitMessageSource: null,
			stagedPaths: [],
			excludedPaths: [],
			reviewOutcome: null,
			verificationPassed: null,
			pr: { status: "not_required", number: null, url: null, error: null },
			evidence: [],
			attempt: (previous?.attempt ?? 0) + 1,
			startedAt: previous?.startedAt ?? now,
			updatedAt: now,
		};
		const evidence = (stage: string, detail: string) => {
			receipt.evidence.push({ stage, detail });
			if (receipt.evidence.length > DELIVERY_EVIDENCE_MAX_ENTRIES) {
				receipt.evidence.splice(0, receipt.evidence.length - DELIVERY_EVIDENCE_MAX_ENTRIES);
			}
		};
		const fail = async (
			stage: RuntimeGitDeliveryStage,
			detail: string,
		): Promise<RuntimeTaskDeliveryStartResponse> => {
			receipt.status = "failed";
			receipt.stage = stage;
			evidence(stage, detail.slice(0, DELIVERY_ERROR_DETAIL_MAX_CHARS));
			receipt.updatedAt = Date.now();
			await persistDeliveryReceipt(receipt);
			return { ok: false, receipt, error: detail };
		};
		const pauseHere = async (
			stage: RuntimeGitDeliveryStage,
			detail: string,
		): Promise<RuntimeTaskDeliveryStartResponse> => {
			receipt.status = "paused";
			receipt.stage = stage;
			evidence(stage, detail.slice(0, DELIVERY_ERROR_DETAIL_MAX_CHARS));
			receipt.updatedAt = Date.now();
			await persistDeliveryReceipt(receipt);
			return { ok: false, receipt, error: detail };
		};

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
		const worktreeEntry = worktreeEntries.find(
			(entry) => entry.path === canonicalizeWorktreePath(input.worktreePath),
		);
		if (!worktreeEntry) {
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

		// The review/verification gates are recorded as receipt evidence; they
		// never block deterministic delivery — model-driven gates must not gate
		// application-controlled delivery (the receipt surfaces their state).
		const reviewOutcome = await readReviewOutcome(input.taskId).catch(() => null);
		receipt.reviewOutcome = reviewOutcome ? (reviewOutcome.status === "ready" ? "ready" : "not_ready") : "absent";
		receipt.verificationPassed = reviewOutcome?.verification?.passed ?? null;
		const handoff = await readReviewHandoff(input.taskId).catch(() => null);
		receipt.baseSha = handoff?.startingCommit ?? null;
		evidence(
			"validated",
			`worktree OK (HEAD ${shortSha(headSha)}); review gate: ${receipt.reviewOutcome}; verification passed: ${
				receipt.verificationPassed ?? "n/a"
			}; recorded base: ${shortSha(receipt.baseSha)}`,
		);

		// --- B-8.2: stage only the recorded change manifest ------------------
		const statusResult = await this.git.run(input.worktreePath, [
			"status",
			"--porcelain=v2",
			"--untracked-files=all",
		]);
		if (!statusResult.ok) {
			return await fail(
				"validated",
				`Could not read the worktree status: ${statusResult.stderr || "git status failed."}`,
			);
		}
		const candidates = parseDeliveryChangeManifest(statusResult.stdout);
		const stagedPaths: string[] = [];
		const excludedPaths: string[] = [];
		for (const path of candidates) {
			if (isExcludedDeliveryPath(path)) {
				excludedPaths.push(path);
			} else {
				stagedPaths.push(path);
			}
		}
		receipt.stagedPaths = stagedPaths;
		receipt.excludedPaths = excludedPaths;

		const taskCommitRef = `${TASK_COMMIT_REF_PREFIX}${input.taskId}/commit`;
		const priorCommitResult = await this.git.run(input.worktreePath, [
			"rev-parse",
			"--verify",
			"--quiet",
			taskCommitRef,
		]);
		const priorCommitSha = priorCommitResult.ok && priorCommitResult.stdout ? priorCommitResult.stdout : null;

		if (stagedPaths.length === 0) {
			if (priorCommitSha && priorCommitSha === headSha) {
				// B-8.8: reuse the commit from a crashed/ambiguous prior attempt
				// (e.g. push lost its response) instead of recording a bare no-op.
				receipt.taskCommitSha = priorCommitSha;
				receipt.commitMessageSource = "reused";
				evidence("staged", `no new changes; reusing task commit ${shortSha(priorCommitSha)} from a prior attempt`);
			} else if (previous && (previous.status === "delivered" || previous.status === "no_op")) {
				evidence("staged", "no changes found and a prior delivery already completed; returning the stored receipt");
				return { ok: true, receipt: previous, error: null };
			} else {
				receipt.status = "no_op";
				receipt.stage = "staged";
				evidence("staged", "no tracked changes or untracked files in the worktree; nothing to deliver (no-op)");
				receipt.updatedAt = Date.now();
				await persistDeliveryReceipt(receipt);
				return { ok: true, receipt, error: null };
			}
		} else {
			const addResult = await this.git.run(input.worktreePath, ["add", "--", ...stagedPaths]);
			if (!addResult.ok) {
				return await fail(
					"validated",
					`Staging failed: ${addResult.stderr || addResult.error || "git add failed."}`,
				);
			}
			receipt.stage = "staged";
			evidence("staged", `staged ${stagedPaths.length} path(s): ${boundedPathList(stagedPaths)}`);
			if (excludedPaths.length > 0) {
				evidence("staged", `excluded ${excludedPaths.length} path(s) by policy: ${boundedPathList(excludedPaths)}`);
			}
			receipt.updatedAt = Date.now();
			await persistDeliveryReceipt(receipt);
		}

		// --- B-8.3: commit anchored by a durable ref -------------------------
		if (!receipt.taskCommitSha) {
			const taskTitle = await this.readTaskTitle(input.workspaceId, input.taskId);
			const message = buildDeliveryCommitMessage(input.commitMessage, taskTitle, input.taskId);
			receipt.commitMessageSource = input.commitMessage ? "model" : "fallback";
			const commitResult = await this.git.run(input.worktreePath, ["commit", "-m", message]);
			if (!commitResult.ok) {
				if (/nothing to commit/i.test(commitResult.output)) {
					receipt.status = "no_op";
					receipt.stage = "staged";
					evidence("commit", "git reported nothing to commit; recorded as a no-op delivery");
					receipt.updatedAt = Date.now();
					await persistDeliveryReceipt(receipt);
					return { ok: true, receipt, error: null };
				}
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
			receipt.taskCommitSha = newHeadResult.stdout;
			const updateRefResult = await this.git.run(input.worktreePath, [
				"update-ref",
				taskCommitRef,
				receipt.taskCommitSha,
			]);
			if (!updateRefResult.ok) {
				return await fail(
					"staged",
					`Could not record the durable task commit ref ${taskCommitRef}: ${
						updateRefResult.stderr || "git update-ref failed."
					}`,
				);
			}
			receipt.stage = "committed";
			evidence(
				"committed",
				`created task commit ${shortSha(receipt.taskCommitSha)} (message source: ${receipt.commitMessageSource})`,
			);
			receipt.updatedAt = Date.now();
			await persistDeliveryReceipt(receipt);
		}

		// --- B-8.4/B-8.5: integrate onto the destination branch -------------
		const taskCommitSha = receipt.taskCommitSha;
		const destRef = `refs/heads/${destinationBranch}`;
		// A prior successful delivery advances the expected base to that
		// delivery's integrated sha, so follow-up deliveries fast-forward from
		// where the last one landed instead of stalling on the original base.
		const requiredBaseSha =
			previous && previous.status === "delivered" && previous.integratedSha
				? previous.integratedSha
				: receipt.baseSha;

		const destRefResult = await this.git.run(input.repoPath, ["rev-parse", "--verify", "--quiet", destRef]);
		let destSha = destRefResult.ok && destRefResult.stdout ? destRefResult.stdout : null;
		if (destSha === null) {
			if (!requiredBaseSha) {
				return await fail(
					"committed",
					`Destination branch "${destinationBranch}" does not exist locally and no starting commit was recorded to create it from.`,
				);
			}
			const createBranchResult = await this.git.run(input.repoPath, ["branch", destinationBranch, requiredBaseSha]);
			if (!createBranchResult.ok) {
				return await fail(
					"committed",
					`Could not create destination branch "${destinationBranch}" at the recorded base: ${
						createBranchResult.stderr || "git branch failed."
					}`,
				);
			}
			destSha = requiredBaseSha;
			evidence(
				"integrated",
				`created local destination branch ${destinationBranch} at recorded base ${shortSha(destSha)}`,
			);
		}

		if (destSha !== taskCommitSha && destSha !== requiredBaseSha) {
			// No recorded base (e.g. review never ran): fall back to the
			// fast-forward guarantee — the destination must already be contained
			// in the task commit's history. A destination that advanced or
			// diverged is not an ancestor and pauses with evidence (B-8.5).
			const destInTaskHistory = await this.isAncestorOf(input.repoPath, destSha, taskCommitSha);
			if (requiredBaseSha === null && destInTaskHistory) {
				evidence(
					"integrated",
					`no recorded starting commit; destination ${shortSha(destSha)} is contained in the task commit's history (fast-forward safe)`,
				);
			} else {
				return await pauseHere(
					"committed",
					requiredBaseSha
						? `Destination "${destinationBranch}" is at ${shortSha(destSha)} but delivery expects ${shortSha(
								requiredBaseSha,
							)} (recorded base). It advanced or diverged; re-run the task from the new base or reconcile the branch, then retry. No force/reset/stash was performed.`
						: `Destination "${destinationBranch}" is at ${shortSha(
								destSha,
							)} and is not contained in the task commit's history; it advanced or diverged. Re-run the task from the current branch tip, then retry. No force/reset/stash was performed.`,
				);
			}
		}

		if (destSha === taskCommitSha) {
			// A crashed prior attempt already integrated; continue to push/verify.
			receipt.integratedSha = destSha;
			receipt.stage = "integrated";
			evidence(
				"integrated",
				`destination already contains the task commit ${shortSha(destSha)}; integration skipped (retry)`,
			);
			receipt.updatedAt = Date.now();
			await persistDeliveryReceipt(receipt);
		} else {
			const destWorktree = worktreeEntries.find((entry) => entry.branch === destRef);
			let integratedSha: string | null = null;
			if (destWorktree) {
				// B-8.4: checked out → refuse dirty state, then the worktree-aware
				// merge (no stashing of user changes, ever).
				const cleanResult = await this.git.run(destWorktree.path, ["status", "--porcelain"]);
				if (!cleanResult.ok || cleanResult.stdout.trim() !== "") {
					return await pauseHere(
						"committed",
						`Destination "${destinationBranch}" is checked out at ${destWorktree.path} with uncommitted changes; commit or stash them in that worktree, then retry delivery.`,
					);
				}
				const mergeArgs =
					input.policy.integrationStrategy === "merge"
						? ["merge", "--no-ff", "--no-edit", taskCommitSha]
						: ["merge", "--ff-only", taskCommitSha];
				const mergeResult = await this.git.run(destWorktree.path, mergeArgs);
				if (!mergeResult.ok) {
					return await pauseHere(
						"committed",
						`Integration onto "${destinationBranch}" failed in ${destWorktree.path}: ${
							mergeResult.stderr || "git merge failed."
						} No conflicts were auto-resolved.`,
					);
				}
				integratedSha = (await this.git.run(destWorktree.path, ["rev-parse", "HEAD"])).stdout || null;
			} else if (input.policy.integrationStrategy === "merge") {
				// Not checked out: build the merge commit with plumbing so no
				// worktree is touched, then apply it with an expected-old-SHA
				// ref update (B-8.4).
				const treeResult = await this.git.run(input.repoPath, ["rev-parse", `${taskCommitSha}^{tree}`]);
				if (!treeResult.ok) {
					return await fail(
						"committed",
						`Could not read the task commit tree: ${treeResult.stderr || "git rev-parse failed."}`,
					);
				}
				const mergeTreeResult = await this.git.run(input.repoPath, [
					"commit-tree",
					treeResult.stdout,
					"-p",
					destSha,
					"-p",
					taskCommitSha,
					"-m",
					`Merge task commit ${shortSha(taskCommitSha)} into ${destinationBranch} (kanban ${input.taskId})`,
				]);
				if (!mergeTreeResult.ok || !mergeTreeResult.stdout) {
					return await fail(
						"committed",
						`Could not build the merge commit: ${mergeTreeResult.stderr || "git commit-tree failed."}`,
					);
				}
				const updateResult = await this.git.run(input.repoPath, [
					"update-ref",
					destRef,
					mergeTreeResult.stdout,
					destSha,
				]);
				if (!updateResult.ok) {
					return await pauseHere(
						"committed",
						`Destination "${destinationBranch}" moved while integrating; retry delivery.`,
					);
				}
				integratedSha = mergeTreeResult.stdout;
			} else {
				// B-8.4: not checked out → expected-old-SHA ref update (atomic;
				// a concurrent move fails instead of clobbering).
				const updateResult = await this.git.run(input.repoPath, ["update-ref", destRef, taskCommitSha, destSha]);
				if (!updateResult.ok) {
					return await pauseHere(
						"committed",
						`Destination "${destinationBranch}" moved while integrating; retry delivery.`,
					);
				}
				integratedSha = taskCommitSha;
			}
			if (!integratedSha) {
				return await fail("committed", "Integration finished but the new destination sha could not be read.");
			}
			receipt.integratedSha = integratedSha;
			receipt.stage = "integrated";
			evidence(
				"integrated",
				`integrated task commit ${shortSha(taskCommitSha)} onto ${destinationBranch} at ${shortSha(integratedSha)}`,
			);
			receipt.updatedAt = Date.now();
			await persistDeliveryReceipt(receipt);
		}

		// --- B-8.6/B-8.7: push an explicit refspec, then verify the remote --
		if (!input.policy.pushRequired) {
			receipt.status = "delivered";
			evidence("pushed", "push not required by policy; delivery is complete locally");
			receipt.updatedAt = Date.now();
			await persistDeliveryReceipt(receipt);
			return await this.finishPr(input, receipt, evidence);
		}
		const pushRefSpec = `${destRef}:${destRef}`;
		const pushResult = await this.git.run(input.repoPath, ["push", input.policy.remote, pushRefSpec]);
		if (pushResult.ok) {
			evidence("pushed", `pushed ${pushRefSpec} to remote "${input.policy.remote}"`);
		} else {
			// B-8.8: an ambiguous failure (e.g. a timeout after the server
			// accepted the ref update) may already be on the remote. Reconcile
			// before declaring failure — never push a different commit.
			const reconciledSha = await this.readRemoteBranchSha(input.repoPath, input.policy.remote, destinationBranch);
			const containsDelivered =
				reconciledSha !== null &&
				receipt.integratedSha !== null &&
				(await this.isAncestorOf(input.repoPath, receipt.integratedSha, reconciledSha));
			if (!containsDelivered) {
				return await fail(
					"integrated",
					`Push to "${input.policy.remote}" failed: ${(
						pushResult.stderr || pushResult.error || "git push failed."
					).slice(
						0,
						DELIVERY_ERROR_DETAIL_MAX_CHARS,
					)} The remote does not contain the delivered commit yet; resolve the remote state and retry (the local commit and integration are preserved).`,
				);
			}
			evidence(
				"pushed",
				`push reported a failure, but the remote branch already contains ${shortSha(
					receipt.integratedSha,
				)}; reconciled as pushed (no second push)`,
			);
		}

		// B-8.7: verify the remote equals or contains the delivered commit;
		// remote movement that excludes it blocks completion.
		const remoteSha = await this.readRemoteBranchSha(input.repoPath, input.policy.remote, destinationBranch);
		const remoteContainsDelivered =
			remoteSha !== null &&
			receipt.integratedSha !== null &&
			(await this.isAncestorOf(input.repoPath, receipt.integratedSha, remoteSha));
		if (!remoteContainsDelivered) {
			return await pauseHere(
				"pushed",
				`Remote "${input.policy.remote}" branch "${destinationBranch}" does not contain the delivered commit ${shortSha(
					receipt.integratedSha,
				)} after push; completion is blocked until the remote ref is restored or the delivery is re-run.`,
			);
		}
		receipt.remoteBranchSha = remoteSha;
		receipt.status = "delivered";
		receipt.stage = "verified";
		evidence(
			"verified",
			`remote "${input.policy.remote}" branch "${destinationBranch}" at ${shortSha(remoteSha)} contains the delivered commit ${shortSha(
				receipt.integratedSha,
			)}`,
		);
		receipt.updatedAt = Date.now();
		await persistDeliveryReceipt(receipt);

		return await this.finishPr(input, receipt, evidence);
	}

	/** Fetch <remote>/<branch> into FETCH_HEAD and return the fetched sha (null when unavailable). */
	private async readRemoteBranchSha(repoPath: string, remote: string, branch: string): Promise<string | null> {
		const fetchResult = await this.git.run(repoPath, ["fetch", "--no-tags", remote, branch]);
		if (!fetchResult.ok) {
			return null;
		}
		const shaResult = await this.git.run(repoPath, ["rev-parse", "FETCH_HEAD"]);
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
		evidence: (stage: string, detail: string) => void,
	): Promise<RuntimeTaskDeliveryStartResponse> {
		if (!input.policy.requirePullRequest) {
			receipt.pr = { status: "not_required", number: null, url: null, error: null };
			receipt.stage = "pr";
			receipt.updatedAt = Date.now();
			await persistDeliveryReceipt(receipt);
			return { ok: true, receipt, error: null };
		}
		if (!input.policy.pushRequired) {
			receipt.pr = {
				status: "skipped",
				number: null,
				url: null,
				error: "Push is not required by policy; no PR was created.",
			};
			receipt.stage = "pr";
			evidence("pr", receipt.pr.error ?? "PR skipped.");
			receipt.updatedAt = Date.now();
			await persistDeliveryReceipt(receipt);
			return { ok: true, receipt, error: null };
		}
		const taskTitle = await this.readTaskTitle(input.workspaceId, input.taskId);
		const pr = await this.openPullRequest(input, receipt, taskTitle);
		receipt.pr = pr;
		receipt.stage = "pr";
		if (pr.status === "failed") {
			// B-8.9: preserve the pushed commit on PR creation failure.
			evidence("pr", `PR creation failed (push is preserved): ${pr.error ?? "unknown gh error"}`);
		} else {
			evidence("pr", `pull request ${pr.status}${pr.url ? ` at ${pr.url}` : ""}`);
		}
		receipt.updatedAt = Date.now();
		await persistDeliveryReceipt(receipt);
		return { ok: true, receipt, error: null };
	}

	private async openPullRequest(
		input: StartGitDeliveryInput,
		receipt: RuntimeGitDeliveryReceipt,
		taskTitle: string | null,
	): Promise<NonNullable<RuntimeGitDeliveryReceipt["pr"]>> {
		const base = input.policy.protectedBranches[0] ?? "main";
		const head = receipt.destinationBranch;
		// B-8.9: deduplicate by head/base — an existing PR wins over creation.
		const existing = await this.gh(["pr", "view", "--head", head, "--base", base, "--json", "number,url"]);
		if (existing.ok) {
			const parsed = parseGhJson(existing.stdout);
			if (parsed && typeof parsed.number === "number") {
				return {
					status: "existing",
					number: parsed.number,
					url: typeof parsed.url === "string" ? parsed.url : null,
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
			`- Delivery receipt: ${getTaskDeliveryDir(input.taskId)}/${DELIVERY_RECEIPT_FILENAME}`,
		]
			.filter((line): line is string => line !== null)
			.join("\n");
		const createResult = await this.gh([
			"pr",
			"create",
			"--head",
			head,
			"--base",
			base,
			"--title",
			prTitle,
			"--body",
			body,
		]);
		if (!createResult.ok) {
			if (createResult.missingBinary) {
				return {
					status: "skipped",
					number: null,
					url: null,
					error: "gh CLI is not installed; PR creation skipped.",
				};
			}
			return {
				status: "failed",
				number: null,
				url: null,
				error: (createResult.stderr || "gh pr create failed").slice(0, DELIVERY_ERROR_DETAIL_MAX_CHARS),
			};
		}
		const urlMatch = createResult.stdout.match(/https?:\/\/\S+/);
		const numberResult = await this.gh(["pr", "view", "--head", head, "--base", base, "--json", "number"]);
		const parsedNumber = numberResult.ok ? parseGhJson(numberResult.stdout) : null;
		return {
			status: "created",
			number: parsedNumber && typeof parsedNumber.number === "number" ? parsedNumber.number : null,
			url: urlMatch ? urlMatch[0] : null,
			error: null,
		};
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
