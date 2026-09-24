// B-4 — backend completion coordinator (reliable mode).
//
// Owns one durable completion attempt per task and drives it through the
// typed phases (B-4.1):
//
//   implementation → review → verification → committing → integrating →
//   integrated_verification → pushing → remote_verification → complete
//
// - B-4.2: every transition is persisted on the attempt record with its
//   evidence (session ids, review/verification refs, commits, remote
//   receipt), so the backend — not the browser — knows what has succeeded.
// - B-4.4: `start` is idempotent. A second start while an attempt is running
//   (double click, second tab, CLI) returns the running attempt; a stopped
//   attempt resumes at its recorded phase; a complete attempt is returned
//   as-is.
// - B-4.5: intent is persisted before each side-effecting phase. The Git
//   phases run through the delivery service, whose own receipt reuses
//   commits and reconciles the remote, so resuming after a crash never
//   repeats a side effect. `reconcileAfterRestart` settles attempts a
//   restart left "running": a delivered receipt completes them, anything
//   else becomes a resumable `blocked` attempt.
// - B-4.6: cancellation stops a running review/repair session immediately;
//   Git phases stop at the next phase boundary (killing git does not undo a
//   ref update). Locks are proper-lockfile locks with stale detection.
// - B-4.7: reliable mode is `gitDeliveryPolicy.enabled`. The attempt records
//   its mode and policy (with a version hash). An attempt that reached the
//   Git phases always finishes under its recorded policy, even if reliable
//   mode is later disabled; it never falls back to the legacy prompt path.
import { createHash, randomUUID } from "node:crypto";

import type {
	RuntimeCompletionAttempt,
	RuntimeCompletionPhase,
	RuntimeCompletionStatus,
	RuntimeGitDeliveryPolicy,
	RuntimeGitDeliveryReceipt,
	RuntimeReviewPolicy,
	RuntimeTaskCompletionResponse,
	RuntimeTaskDeliveryStartResponse,
	RuntimeTaskReviewStartResponse,
	RuntimeVerificationConfig,
	RuntimeVerificationReceipt,
} from "../core/api-contract";
import type { StartGitDeliveryInput } from "../workspace/git-delivery";
import {
	archiveCompletionAttempt,
	COMPLETION_ATTEMPT_SCHEMA_VERSION,
	readCompletionAttempt,
	updateCompletionAttempt,
	writeCompletionAttempt,
} from "./completion-attempt-store";

/** Phases whose work is Git delivery; an attempt past these finishes under its recorded policy. */
const GIT_PHASES: readonly RuntimeCompletionPhase[] = [
	"committing",
	"integrating",
	"integrated_verification",
	"pushing",
	"remote_verification",
];

export function isGitCompletionPhase(phase: RuntimeCompletionPhase): boolean {
	return GIT_PHASES.includes(phase);
}

export interface CompletionScope {
	workspaceId: string;
	workspacePath: string;
}

export interface CompletionPolicy {
	gitDelivery: RuntimeGitDeliveryPolicy | null;
	reviewRequired: boolean;
	verificationRequired: boolean;
	/** Passed to the review/verification runs; the recorded snapshot keeps only the gates. */
	reviewPolicy: RuntimeReviewPolicy | undefined;
	verification: RuntimeVerificationConfig | null;
}

export interface CompletionTaskContext {
	baseRef: string;
	worktreePath: string;
	description: string;
	taskTitle: string | null;
	/** Identifies the implementation session run (agent + start time), when known. */
	implementationSessionId: string | null;
}

export interface CompletionCoordinatorDependencies {
	loadPolicy: (scope: CompletionScope) => Promise<CompletionPolicy>;
	resolveTask: (scope: CompletionScope, taskId: string) => Promise<CompletionTaskContext | null>;
	isTaskWriterActive: (scope: CompletionScope, taskId: string) => Promise<boolean>;
	runReview: (
		scope: CompletionScope,
		input: {
			taskId: string;
			description: string;
			taskTitle: string | null;
			reviewPolicy: RuntimeReviewPolicy | undefined;
			verification: RuntimeVerificationConfig | null;
		},
	) => Promise<RuntimeTaskReviewStartResponse>;
	cancelReview: (scope: CompletionScope, taskId: string) => Promise<void>;
	runVerification: (
		config: RuntimeVerificationConfig,
		input: { taskId: string; worktreePath: string; candidateTreeHash: string | null },
	) => Promise<RuntimeVerificationReceipt>;
	persistVerificationReceipt: (taskId: string, receipt: RuntimeVerificationReceipt) => Promise<string>;
	computeTreeHash: (worktreePath: string) => Promise<string | null>;
	deliver: (input: StartGitDeliveryInput) => Promise<RuntimeTaskDeliveryStartResponse>;
	readDeliveryReceipt: (taskId: string) => Promise<RuntimeGitDeliveryReceipt | null>;
	/** Resolves a commit's tree id (integrated verification). */
	readTreeId: (repoPath: string, commit: string) => Promise<string | null>;
	/** The repository's root commit (repo identity). */
	readRepoRootCommit: (repoPath: string) => Promise<string | null>;
	now?: () => number;
}

const DELIVERY_STAGE_TO_PHASE: Record<RuntimeGitDeliveryReceipt["stage"], RuntimeCompletionPhase> = {
	validated: "committing",
	staged: "committing",
	committed: "integrating",
	integrated: "pushing",
	pushed: "remote_verification",
	verified: "remote_verification",
	pr: "remote_verification",
};

/** B-4.7: a stable version for the policy an attempt runs under. */
export function computeCompletionPolicyVersion(policy: RuntimeCompletionAttempt["policy"]): string {
	return createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 16);
}

class CompletionStopped extends Error {
	constructor(
		readonly phase: RuntimeCompletionPhase,
		readonly status: Exclude<RuntimeCompletionStatus, "running" | "complete">,
		message: string,
	) {
		super(message);
	}
}

export class TaskCompletionCoordinator {
	private readonly deps: CompletionCoordinatorDependencies;
	private readonly now: () => number;
	/** B-4.4: one in-process owner per task attempt. */
	private readonly owners = new Map<string, Promise<void>>();
	/** Starts in progress (before the owner is registered). */
	private readonly starting = new Map<string, Promise<RuntimeTaskCompletionResponse>>();

	constructor(deps: CompletionCoordinatorDependencies) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
	}

	private ownerKey(scope: CompletionScope, taskId: string): string {
		return `${scope.workspaceId}::${taskId}`;
	}

	/** Resolves once the task's running attempt (if any) has stopped. For tests and CLI waiting. */
	async whenIdle(scope: CompletionScope, taskId: string): Promise<void> {
		await this.owners.get(this.ownerKey(scope, taskId));
	}

	async get(taskId: string): Promise<RuntimeTaskCompletionResponse> {
		const read = await readCompletionAttempt(taskId);
		if (read.kind === "unreadable") {
			return { ok: false, attempt: null, error: read.reason };
		}
		return { ok: true, attempt: read.kind === "attempt" ? read.attempt : null, error: null };
	}

	async start(scope: CompletionScope, taskId: string): Promise<RuntimeTaskCompletionResponse> {
		const key = this.ownerKey(scope, taskId);
		// Ownership is reserved synchronously, before any await, so concurrent
		// commands (double click, second tab, CLI) cannot both start (B-4.4).
		if (this.owners.has(key)) {
			return await this.get(taskId);
		}
		const pending = this.starting.get(key);
		if (pending) {
			await pending.catch(() => undefined);
			return await this.get(taskId);
		}
		const starting = this.startOwned(scope, taskId, key);
		this.starting.set(key, starting);
		try {
			return await starting;
		} finally {
			this.starting.delete(key);
		}
	}

	private async startOwned(
		scope: CompletionScope,
		taskId: string,
		key: string,
	): Promise<RuntimeTaskCompletionResponse> {
		const read = await readCompletionAttempt(taskId);
		if (read.kind === "unreadable") {
			return { ok: false, attempt: null, error: read.reason };
		}
		const existing = read.kind === "attempt" ? read.attempt : null;
		if (existing?.status === "complete") {
			return { ok: true, attempt: existing, error: null };
		}

		const policy = await this.deps.loadPolicy(scope);
		const task = await this.deps.resolveTask(scope, taskId);
		if (!task) {
			return { ok: false, attempt: existing, error: `Task "${taskId}" or its worktree was not found.` };
		}
		if (await this.deps.isTaskWriterActive(scope, taskId)) {
			return {
				ok: false,
				attempt: existing,
				error: "The task's agent session is still running; completion starts once it has stopped.",
			};
		}

		let attempt: RuntimeCompletionAttempt;
		if (existing && this.shouldResume(existing, policy)) {
			// Resume at the recorded phase under the recorded policy (B-4.7).
			attempt = await this.transition(existing, existing.phase, "running", "resumed", {
				cancelRequested: false,
				failureReason: null,
			});
		} else {
			if (!policy.gitDelivery?.enabled) {
				return {
					ok: false,
					attempt: existing,
					error: "Reliable completion is off; enable gitDeliveryPolicy to complete tasks through the backend.",
				};
			}
			if (existing) {
				await archiveCompletionAttempt(existing);
			}
			attempt = await this.createAttempt(scope, taskId, task, policy);
		}

		const run = this.run(scope, attempt, task, policy).finally(() => {
			this.owners.delete(key);
		});
		this.owners.set(key, run);
		return { ok: true, attempt, error: null };
	}

	/**
	 * B-4.6: request cancellation. A running review/repair session stops now;
	 * Git phases stop at the next phase boundary.
	 */
	async cancel(scope: CompletionScope, taskId: string): Promise<RuntimeTaskCompletionResponse> {
		const updated = await updateCompletionAttempt(taskId, (attempt) =>
			attempt.status === "running" ? { ...attempt, cancelRequested: true, updatedAt: this.now() } : attempt,
		);
		if (!updated) {
			return await this.get(taskId);
		}
		if (updated.status === "running") {
			if (!this.owners.has(this.ownerKey(scope, taskId))) {
				// No live owner (stale after a restart): settle it directly.
				const canceled = await this.transition(updated, updated.phase, "canceled", "canceled (no running owner)");
				return { ok: true, attempt: canceled, error: null };
			}
			if (updated.phase === "review" || updated.phase === "verification") {
				await this.deps.cancelReview(scope, taskId);
			}
		}
		return { ok: true, attempt: updated, error: null };
	}

	/**
	 * B-4.5: after a runtime restart no attempt can be running. Settle each
	 * one: Git work whose receipt shows delivery is complete (the crash hit
	 * between the side effect and the record); everything else stops at its
	 * phase as `blocked`, resumable by starting completion again.
	 */
	async reconcileAfterRestart(taskIds: readonly string[]): Promise<RuntimeCompletionAttempt[]> {
		const settled: RuntimeCompletionAttempt[] = [];
		for (const taskId of taskIds) {
			const read = await readCompletionAttempt(taskId);
			if (read.kind !== "attempt" || read.attempt.status !== "running") {
				continue;
			}
			const attempt = read.attempt;
			if (isGitCompletionPhase(attempt.phase)) {
				const receipt = await this.deps.readDeliveryReceipt(taskId).catch(() => null);
				if (receipt && (receipt.status === "delivered" || receipt.status === "no_op")) {
					settled.push(
						await this.transition(
							attempt,
							"complete",
							"complete",
							"reconciled after restart: delivery receipt shows delivery",
							{
								evidence: this.deliveryEvidence(attempt, receipt),
							},
						),
					);
					continue;
				}
			}
			settled.push(
				await this.transition(
					attempt,
					attempt.phase,
					"blocked",
					`runtime restarted during ${attempt.phase}; start completion again to resume (Git work is reused, never repeated)`,
					{ failureReason: `The runtime restarted during ${attempt.phase}.` },
				),
			);
		}
		return settled;
	}

	private shouldResume(existing: RuntimeCompletionAttempt, policy: CompletionPolicy): boolean {
		if (isGitCompletionPhase(existing.phase)) {
			// B-4.7: Git phases finish under the mode and policy they started with.
			return true;
		}
		if (!policy.gitDelivery?.enabled) {
			return false;
		}
		// Before any Git side effect, a policy change starts a fresh attempt.
		return existing.policyVersion === computeCompletionPolicyVersion(this.snapshotPolicy(policy));
	}

	private snapshotPolicy(policy: CompletionPolicy): RuntimeCompletionAttempt["policy"] {
		if (!policy.gitDelivery) {
			throw new Error("Reliable completion requires a git delivery policy.");
		}
		return {
			gitDelivery: policy.gitDelivery,
			reviewRequired: policy.reviewRequired,
			verificationRequired: policy.verificationRequired,
		};
	}

	private async createAttempt(
		scope: CompletionScope,
		taskId: string,
		task: CompletionTaskContext,
		policy: CompletionPolicy,
	): Promise<RuntimeCompletionAttempt> {
		const snapshot = this.snapshotPolicy(policy);
		const now = this.now();
		const attempt: RuntimeCompletionAttempt = {
			schemaVersion: COMPLETION_ATTEMPT_SCHEMA_VERSION,
			attemptId: randomUUID(),
			taskId,
			workspaceId: scope.workspaceId,
			repoPath: scope.workspacePath,
			repoRootCommit: await this.deps.readRepoRootCommit(scope.workspacePath).catch(() => null),
			worktreePath: task.worktreePath,
			startingCommit: null,
			candidateTreeHash: null,
			targetRef: `refs/heads/${snapshot.gitDelivery.destinationBranch ?? task.baseRef}`,
			mode: "reliable",
			policyVersion: computeCompletionPolicyVersion(snapshot),
			policy: snapshot,
			phase: "implementation",
			status: "running",
			sessionIds: { implementation: task.implementationSessionId, review: null },
			evidence: {
				reviewStatus: null,
				reviewOutcomeRef: null,
				verificationPassed: null,
				verificationRef: null,
				taskCommit: null,
				integratedCommit: null,
				remoteCommit: null,
				deliveryReceiptRef: null,
			},
			failureReason: null,
			cancelRequested: false,
			history: [{ phase: "implementation", status: "running", detail: "attempt created", at: now }],
			createdAt: now,
			updatedAt: now,
		};
		await writeCompletionAttempt(attempt);
		return attempt;
	}

	/** Persists a phase/status transition (plus any field updates) under the attempt lock. */
	private async transition(
		attempt: RuntimeCompletionAttempt,
		phase: RuntimeCompletionPhase,
		status: RuntimeCompletionStatus,
		detail: string,
		updates: Partial<RuntimeCompletionAttempt> = {},
	): Promise<RuntimeCompletionAttempt> {
		const at = this.now();
		const next = await updateCompletionAttempt(attempt.taskId, (current) => ({
			...current,
			...updates,
			phase,
			status,
			history: [...current.history, { phase, status, detail, at }],
			updatedAt: at,
		}));
		if (!next) {
			throw new Error(`The completion attempt for task "${attempt.taskId}" disappeared while running.`);
		}
		return next;
	}

	/** Stops at a phase boundary when cancellation was requested (B-4.6). */
	private async checkCancellation(attempt: RuntimeCompletionAttempt): Promise<RuntimeCompletionAttempt> {
		const read = await readCompletionAttempt(attempt.taskId);
		const current = read.kind === "attempt" ? read.attempt : attempt;
		if (current.cancelRequested) {
			throw new CompletionStopped(current.phase, "canceled", `Canceled before ${current.phase}.`);
		}
		return current;
	}

	private deliveryEvidence(
		attempt: RuntimeCompletionAttempt,
		receipt: RuntimeGitDeliveryReceipt,
	): RuntimeCompletionAttempt["evidence"] {
		return {
			...attempt.evidence,
			taskCommit: receipt.taskCommitSha,
			integratedCommit: receipt.integratedSha,
			remoteCommit: receipt.remoteBranchSha,
			deliveryReceiptRef: `delivery/receipt.json (attempt ${receipt.attempt})`,
		};
	}

	private async run(
		scope: CompletionScope,
		initial: RuntimeCompletionAttempt,
		task: CompletionTaskContext,
		livePolicy: CompletionPolicy,
	): Promise<void> {
		let attempt = initial;
		try {
			const order: RuntimeCompletionPhase[] = ["implementation", "review", "verification", "committing"];
			const startIndex = isGitCompletionPhase(attempt.phase) ? 3 : Math.max(0, order.indexOf(attempt.phase));
			if (startIndex <= 0) {
				attempt = await this.transition(attempt, "review", "running", "implementation finished (writer stopped)");
			}
			if (startIndex <= 1) {
				attempt = await this.runReviewPhase(scope, await this.checkCancellation(attempt), task, livePolicy);
			}
			if (startIndex <= 2) {
				attempt = await this.runVerificationPhase(await this.checkCancellation(attempt), task, livePolicy);
			}
			attempt = await this.runDeliveryPhases(scope, await this.checkCancellation(attempt), task);
		} catch (error) {
			const stopped =
				error instanceof CompletionStopped
					? error
					: new CompletionStopped(attempt.phase, "failed", error instanceof Error ? error.message : String(error));
			const read = await readCompletionAttempt(attempt.taskId);
			const current = read.kind === "attempt" ? read.attempt : attempt;
			await this.transition(current, stopped.phase, stopped.status, stopped.message, {
				failureReason: stopped.message,
			}).catch(() => undefined);
		}
	}

	private async runReviewPhase(
		scope: CompletionScope,
		attempt: RuntimeCompletionAttempt,
		task: CompletionTaskContext,
		livePolicy: CompletionPolicy,
	): Promise<RuntimeCompletionAttempt> {
		if (!attempt.policy.reviewRequired) {
			return await this.transition(attempt, "verification", "running", "review not required by policy");
		}
		const response = await this.deps.runReview(scope, {
			taskId: attempt.taskId,
			description: task.description,
			taskTitle: task.taskTitle,
			reviewPolicy: livePolicy.reviewPolicy,
			verification: attempt.policy.verificationRequired ? livePolicy.verification : null,
		});
		// A review stopped by a cancel request reports canceled, not failed.
		await this.checkCancellation(attempt);
		const updates: Partial<RuntimeCompletionAttempt> = {
			sessionIds: { ...attempt.sessionIds, review: response.sessionId },
			candidateTreeHash: response.candidateTreeHash,
			startingCommit: response.handoff?.startingCommit ?? attempt.startingCommit,
			evidence: {
				...attempt.evidence,
				reviewStatus: response.status,
				reviewOutcomeRef: "review/outcome.json",
				verificationPassed: response.verification?.passed ?? attempt.evidence.verificationPassed,
				verificationRef: response.verification
					? "review/outcome.json#verification"
					: attempt.evidence.verificationRef,
			},
		};
		if (response.status !== "ready") {
			const verificationFailed = response.verification !== null && !response.verification.passed;
			const stoppedAt: RuntimeCompletionPhase = verificationFailed ? "verification" : "review";
			await updateCompletionAttempt(attempt.taskId, (current) => ({ ...current, ...updates }));
			throw new CompletionStopped(
				stoppedAt,
				"blocked",
				response.error ?? `The review finished as "${response.status}"; resolve its findings, then complete again.`,
			);
		}
		return await this.transition(attempt, "verification", "running", "review ready", updates);
	}

	private async runVerificationPhase(
		attempt: RuntimeCompletionAttempt,
		task: CompletionTaskContext,
		livePolicy: CompletionPolicy,
	): Promise<RuntimeCompletionAttempt> {
		if (!attempt.policy.verificationRequired) {
			return await this.transition(attempt, "committing", "running", "verification not required by policy");
		}
		if (attempt.policy.reviewRequired && attempt.evidence.verificationPassed === true) {
			return await this.transition(attempt, "committing", "running", "verification passed during review");
		}
		if (!livePolicy.verification || livePolicy.verification.enabled !== "required") {
			throw new CompletionStopped(
				"verification",
				"blocked",
				"Verification is required by the attempt's policy but no verification checks are configured.",
			);
		}
		const candidateTreeHash = await this.deps.computeTreeHash(task.worktreePath).catch(() => null);
		const receipt = await this.deps.runVerification(livePolicy.verification, {
			taskId: attempt.taskId,
			worktreePath: task.worktreePath,
			candidateTreeHash,
		});
		await this.checkCancellation(attempt);
		const verificationRef = await this.deps.persistVerificationReceipt(attempt.taskId, receipt);
		const updates: Partial<RuntimeCompletionAttempt> = {
			candidateTreeHash: receipt.treeHashBefore ?? candidateTreeHash,
			evidence: { ...attempt.evidence, verificationPassed: receipt.passed, verificationRef },
		};
		if (!receipt.passed) {
			await updateCompletionAttempt(attempt.taskId, (current) => ({ ...current, ...updates }));
			throw new CompletionStopped("verification", "blocked", receipt.error ?? "Verification checks failed.");
		}
		return await this.transition(attempt, "committing", "running", "verification passed", updates);
	}

	private async runDeliveryPhases(
		scope: CompletionScope,
		attempt: RuntimeCompletionAttempt,
		task: CompletionTaskContext,
	): Promise<RuntimeCompletionAttempt> {
		// B-4.5: intent before the Git side effects.
		const current = await this.transition(
			attempt,
			attempt.phase,
			"running",
			attempt.phase === "committing" ? "delivery intent recorded" : `resuming delivery at ${attempt.phase}`,
		);
		const response = await this.deps.deliver({
			taskId: attempt.taskId,
			workspaceId: scope.workspaceId,
			repoPath: scope.workspacePath,
			worktreePath: task.worktreePath,
			baseRef: task.baseRef,
			policy: attempt.policy.gitDelivery,
			gates: {
				reviewRequired: attempt.policy.reviewRequired,
				verificationRequired: attempt.policy.verificationRequired,
			},
			// B-7.6 integrated verification, before anything is pushed.
			verifyIntegrated: async ({ taskCommitSha, integratedSha }) => {
				const [taskTree, integratedTree] = await Promise.all([
					this.deps.readTreeId(scope.workspacePath, taskCommitSha),
					this.deps.readTreeId(scope.workspacePath, integratedSha),
				]);
				if (taskTree !== null && taskTree === integratedTree) {
					return null;
				}
				return "The integrated tree differs from the verified tree; delivery stopped before pushing so the integrated result can be verified.";
			},
		});
		const receipt = response.receipt;
		if (!receipt) {
			throw new CompletionStopped(current.phase, "failed", response.error ?? "Delivery did not produce a receipt.");
		}
		const evidence = this.deliveryEvidence(current, receipt);
		if (receipt.status === "delivered" || receipt.status === "no_op") {
			return await this.transition(
				current,
				"complete",
				"complete",
				receipt.status === "no_op" ? "nothing to deliver (no-op receipt)" : "delivered and verified on the remote",
				{ evidence, failureReason: null },
			);
		}
		// Delivery only pauses at the integrated stage when the integrated
		// verification hook stopped it (a failed push is `failed`).
		const stoppedPhase: RuntimeCompletionPhase =
			receipt.stage === "integrated" && receipt.status === "paused"
				? "integrated_verification"
				: DELIVERY_STAGE_TO_PHASE[receipt.stage];
		await updateCompletionAttempt(current.taskId, (latest) => ({ ...latest, evidence }));
		throw new CompletionStopped(
			stoppedPhase,
			receipt.status === "paused" ? "blocked" : "failed",
			response.error ?? `Delivery ${receipt.status} at stage "${receipt.stage}".`,
		);
	}
}
