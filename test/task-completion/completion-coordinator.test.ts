// B-4 — backend completion coordinator: phases, durability, idempotency,
// cancellation, restart reconciliation, and mode/policy versioning.
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeCompletionAttempt,
	RuntimeGitDeliveryPolicy,
	RuntimeGitDeliveryReceipt,
	RuntimeTaskReviewStartResponse,
	RuntimeVerificationReceipt,
} from "../../src/core/api-contract";
import {
	getTaskCompletionDir,
	readCompletionAttempt,
	writeCompletionAttempt,
} from "../../src/task-completion/completion-attempt-store";
import {
	type CompletionCoordinatorDependencies,
	type CompletionPolicy,
	computeCompletionPolicyVersion,
	TaskCompletionCoordinator,
} from "../../src/task-completion/completion-coordinator";
import type { StartGitDeliveryInput } from "../../src/workspace/git-delivery";
import { createTempDir } from "../utilities/temp-dir";

const SCOPE = { workspaceId: "ws-1", workspacePath: "/tmp/repo" };
const TASK_ID = "task-1";

const DELIVERY_POLICY: RuntimeGitDeliveryPolicy = {
	enabled: true,
	remote: "origin",
	destinationBranch: "feature/b4",
	pushRequired: true,
	protectedBranches: ["main"],
	integrationStrategy: "fast_forward",
	requirePullRequest: false,
	pullRequestBaseBranch: null,
};

function policy(overrides: Partial<CompletionPolicy> = {}): CompletionPolicy {
	return {
		gitDelivery: DELIVERY_POLICY,
		reviewRequired: true,
		verificationRequired: true,
		reviewPolicy: { enabled: "required", instructions: "", modelOverride: null, maxRepairRounds: 2 },
		verification: {
			enabled: "required",
			checks: [{ id: "test", command: "npm", args: ["test"], successExitCodes: [0], required: true }],
		},
		...overrides,
	};
}

function receipt(overrides: Partial<RuntimeGitDeliveryReceipt> = {}): RuntimeGitDeliveryReceipt {
	return {
		taskId: TASK_ID,
		workspaceId: SCOPE.workspaceId,
		repoPath: SCOPE.workspacePath,
		worktreePath: "/tmp/worktree",
		baseRef: "main",
		baseSha: "base",
		destinationBranch: "feature/b4",
		remote: "origin",
		remoteBranchSha: "task-commit",
		taskCommitSha: "task-commit",
		integratedSha: "task-commit",
		status: "delivered",
		stage: "pr",
		policy: DELIVERY_POLICY,
		commitMessageSource: "fallback",
		stagedPaths: ["a.ts"],
		excludedPaths: [],
		reviewOutcome: "ready",
		verificationPassed: true,
		candidateTreeHash: "tree-1",
		pr: { status: "not_required", number: null, url: null, error: null },
		evidence: [],
		attempt: 1,
		startedAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

function reviewResponse(overrides: Partial<RuntimeTaskReviewStartResponse> = {}): RuntimeTaskReviewStartResponse {
	return {
		ok: true,
		status: "ready",
		handoff: null,
		result: null,
		candidateTreeHash: "tree-1",
		sessionId: "task-1::review",
		error: null,
		warnings: [],
		verification: {
			treeHashBefore: "tree-1",
			treeHashAfter: "tree-1",
			treeIdentityPreserved: true,
			matchesCandidate: true,
			checks: [],
			passed: true,
			error: null,
			startedAt: 1,
			finishedAt: 2,
		},
		...overrides,
	};
}

function verificationReceipt(passed: boolean): RuntimeVerificationReceipt {
	return {
		treeHashBefore: "tree-1",
		treeHashAfter: "tree-1",
		treeIdentityPreserved: true,
		matchesCandidate: true,
		checks: [],
		passed,
		error: passed ? null : "required check failed: test (exit 1)",
		startedAt: 1,
		finishedAt: 2,
	};
}

interface Harness {
	coordinator: TaskCompletionCoordinator;
	deps: CompletionCoordinatorDependencies;
	setPolicy: (next: CompletionPolicy) => void;
	deliver: ReturnType<
		typeof vi.fn<
			(
				input: StartGitDeliveryInput,
			) => Promise<{ ok: boolean; receipt: RuntimeGitDeliveryReceipt | null; error: string | null }>
		>
	>;
	runReview: ReturnType<typeof vi.fn>;
	runVerification: ReturnType<typeof vi.fn>;
	cancelReview: ReturnType<typeof vi.fn>;
}

function createHarness(options: { policy?: CompletionPolicy; writerActive?: boolean } = {}): Harness {
	let currentPolicy = options.policy ?? policy();
	const deliver = vi.fn(async (_input: StartGitDeliveryInput) => ({ ok: true, receipt: receipt(), error: null }));
	const runReview = vi.fn(async () => reviewResponse());
	const runVerification = vi.fn(async () => verificationReceipt(true));
	const cancelReview = vi.fn(async () => undefined);
	const deps: CompletionCoordinatorDependencies = {
		loadPolicy: async () => currentPolicy,
		resolveTask: async () => ({
			baseRef: "main",
			worktreePath: "/tmp/worktree",
			description: "Implement feature",
			taskTitle: "Feature",
			implementationSessionId: "cline@1",
		}),
		isTaskWriterActive: async () => options.writerActive ?? false,
		runReview,
		cancelReview,
		runVerification,
		persistVerificationReceipt: async () => "verification/receipt.json",
		computeTreeHash: async () => "tree-1",
		deliver,
		readDeliveryReceipt: async () => null,
		readTreeId: async (_repo, commit) => `tree-of-${commit}`,
		readRepoRootCommit: async () => "root-commit",
	};
	return {
		coordinator: new TaskCompletionCoordinator(deps),
		deps,
		setPolicy: (next) => {
			currentPolicy = next;
		},
		deliver,
		runReview,
		runVerification,
		cancelReview,
	};
}

async function readAttempt(): Promise<RuntimeCompletionAttempt> {
	const read = await readCompletionAttempt(TASK_ID);
	if (read.kind !== "attempt") {
		throw new Error(`expected an attempt, got ${read.kind}`);
	}
	return read.attempt;
}

async function runToIdle(harness: Harness): Promise<RuntimeCompletionAttempt> {
	const started = await harness.coordinator.start(SCOPE, TASK_ID);
	expect(started.error).toBeNull();
	await harness.coordinator.whenIdle(SCOPE, TASK_ID);
	return await readAttempt();
}

let home: ReturnType<typeof createTempDir>;
let previousHome: string | undefined;

beforeEach(() => {
	home = createTempDir("kanban-completion-home-");
	previousHome = process.env.HOME;
	process.env.HOME = home.path;
});

afterEach(() => {
	if (previousHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = previousHome;
	}
	home.cleanup();
});

describe("TaskCompletionCoordinator", () => {
	it("drives an attempt through every phase and records the evidence (B-4.1/B-4.2)", async () => {
		const harness = createHarness();
		const attempt = await runToIdle(harness);

		expect(attempt.status).toBe("complete");
		expect(attempt.phase).toBe("complete");
		expect(attempt.mode).toBe("reliable");
		expect(attempt.repoRootCommit).toBe("root-commit");
		expect(attempt.targetRef).toBe("refs/heads/feature/b4");
		expect(attempt.sessionIds).toEqual({ implementation: "cline@1", review: "task-1::review" });
		expect(attempt.candidateTreeHash).toBe("tree-1");
		expect(attempt.evidence).toMatchObject({
			reviewStatus: "ready",
			verificationPassed: true,
			taskCommit: "task-commit",
			integratedCommit: "task-commit",
			remoteCommit: "task-commit",
		});
		expect(attempt.history.map((event) => event.phase)).toEqual(
			expect.arrayContaining(["implementation", "review", "verification", "committing", "complete"]),
		);
		// Verification ran inside the review, so it is not repeated.
		expect(harness.runVerification).not.toHaveBeenCalled();
		const deliverInput = harness.deliver.mock.calls[0]?.[0];
		expect(deliverInput?.gates).toEqual({ reviewRequired: true, verificationRequired: true });
		expect(deliverInput?.policy).toEqual(DELIVERY_POLICY);
	});

	it("resolves duplicate start commands to one attempt owner (B-4.4)", async () => {
		const harness = createHarness();
		const [first, second] = await Promise.all([
			harness.coordinator.start(SCOPE, TASK_ID),
			harness.coordinator.start(SCOPE, TASK_ID),
		]);
		await harness.coordinator.whenIdle(SCOPE, TASK_ID);

		expect(first.attempt?.attemptId).toBeDefined();
		expect(second.attempt?.attemptId).toBe(first.attempt?.attemptId);
		expect(harness.runReview).toHaveBeenCalledTimes(1);
		expect(harness.deliver).toHaveBeenCalledTimes(1);
		// A later start on a complete attempt returns it without re-running anything.
		const again = await harness.coordinator.start(SCOPE, TASK_ID);
		expect(again.attempt?.status).toBe("complete");
		expect(harness.deliver).toHaveBeenCalledTimes(1);
	});

	it("blocks at review and resumes the same attempt there (B-4.1)", async () => {
		const harness = createHarness();
		harness.runReview.mockResolvedValueOnce(
			reviewResponse({ status: "blocked", error: "off-by-one in a.ts", verification: null }),
		);
		const blocked = await runToIdle(harness);
		expect(blocked).toMatchObject({ status: "blocked", phase: "review", failureReason: "off-by-one in a.ts" });
		expect(harness.deliver).not.toHaveBeenCalled();

		const resumed = await runToIdle(harness);
		expect(resumed.attemptId).toBe(blocked.attemptId);
		expect(resumed.status).toBe("complete");
		expect(harness.runReview).toHaveBeenCalledTimes(2);
	});

	it("runs verification on its own when review is off and blocks on failure", async () => {
		const harness = createHarness({ policy: policy({ reviewRequired: false }) });
		harness.runVerification.mockResolvedValueOnce(verificationReceipt(false));

		const blocked = await runToIdle(harness);

		expect(harness.runReview).not.toHaveBeenCalled();
		expect(blocked).toMatchObject({ status: "blocked", phase: "verification" });
		expect(blocked.evidence.verificationRef).toBe("verification/receipt.json");
		expect(harness.deliver).not.toHaveBeenCalled();
	});

	it("maps delivery pauses to the phase they stopped at", async () => {
		const harness = createHarness();
		harness.deliver.mockResolvedValueOnce({
			ok: false,
			receipt: receipt({ status: "paused", stage: "committed", integratedSha: null, remoteBranchSha: null }),
			error: "destination diverged",
		});
		const blocked = await runToIdle(harness);
		expect(blocked).toMatchObject({ status: "blocked", phase: "integrating", failureReason: "destination diverged" });
		expect(blocked.evidence.taskCommit).toBe("task-commit");
	});

	it("stops before pushing when the integrated tree differs from the verified tree", async () => {
		const harness = createHarness();
		harness.deliver.mockImplementationOnce(async (input) => {
			const reason = await input.verifyIntegrated?.({ taskCommitSha: "task-commit", integratedSha: "merge-commit" });
			return {
				ok: false,
				receipt: receipt({ status: "paused", stage: "integrated", remoteBranchSha: null }),
				error: reason ?? null,
			};
		});
		const blocked = await runToIdle(harness);
		expect(blocked).toMatchObject({ status: "blocked", phase: "integrated_verification" });
		expect(blocked.failureReason).toMatch(/integrated tree differs/);
	});

	it("cancels a running review immediately and can resume afterwards (B-4.6)", async () => {
		const harness = createHarness();
		let releaseReview: () => void = () => {};
		harness.runReview.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseReview = () =>
						resolve(
							reviewResponse({ status: "failed", error: "review session interrupted", verification: null }),
						);
				}),
		);
		harness.cancelReview.mockImplementation(async () => releaseReview());

		await harness.coordinator.start(SCOPE, TASK_ID);
		await vi.waitFor(async () => expect((await readAttempt()).phase).toBe("review"));
		await harness.coordinator.cancel(SCOPE, TASK_ID);
		await harness.coordinator.whenIdle(SCOPE, TASK_ID);

		expect(harness.cancelReview).toHaveBeenCalledWith(SCOPE, TASK_ID);
		const stopped = await readAttempt();
		expect(stopped.status).toBe("canceled");
		expect(stopped.phase).toBe("review");
		expect(harness.deliver).not.toHaveBeenCalled();

		const resumed = await runToIdle(harness);
		expect(resumed.status).toBe("complete");
		expect(resumed.cancelRequested).toBe(false);
	});

	it("stops at the next phase boundary when canceled during Git phases (B-4.6)", async () => {
		const harness = createHarness();
		let releaseDelivery: () => void = () => {};
		harness.deliver.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseDelivery = () =>
						resolve({
							ok: false,
							receipt: receipt({ status: "failed", stage: "integrated", remoteBranchSha: null }),
							error: "push failed",
						});
				}),
		);
		await harness.coordinator.start(SCOPE, TASK_ID);
		await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalled());
		const cancel = await harness.coordinator.cancel(SCOPE, TASK_ID);
		// The Git operation is not killed mid-flight.
		expect(cancel.attempt?.status).toBe("running");
		releaseDelivery();
		await harness.coordinator.whenIdle(SCOPE, TASK_ID);
		expect((await readAttempt()).phase).toBe("pushing");
	});

	it("reconciles attempts a restart left running (B-4.5)", async () => {
		const harness = createHarness();
		await runToIdle(harness);
		const complete = await readAttempt();

		// Crash after the push, before the completion record: the receipt shows delivery.
		await writeCompletionAttempt({ ...complete, status: "running", phase: "pushing" });
		harness.deps.readDeliveryReceipt = async () => receipt();
		const restarted = new TaskCompletionCoordinator(harness.deps);
		const [settled] = await restarted.reconcileAfterRestart([TASK_ID]);
		expect(settled).toMatchObject({ status: "complete", phase: "complete" });

		// Crash during review: resumable, not guessed complete.
		await writeCompletionAttempt({ ...complete, status: "running", phase: "review" });
		const [blocked] = await restarted.reconcileAfterRestart([TASK_ID]);
		expect(blocked).toMatchObject({ status: "blocked", phase: "review" });
		expect(blocked?.failureReason).toMatch(/restarted during review/);
	});

	it("finishes a Git-phase attempt under its recorded policy after reliable mode is disabled (B-4.7)", async () => {
		const harness = createHarness();
		harness.deliver.mockResolvedValueOnce({
			ok: false,
			receipt: receipt({ status: "failed", stage: "integrated", remoteBranchSha: null }),
			error: "push rejected",
		});
		const blocked = await runToIdle(harness);
		expect(blocked).toMatchObject({ status: "failed", phase: "pushing" });

		harness.setPolicy(policy({ gitDelivery: { ...DELIVERY_POLICY, enabled: false }, reviewRequired: false }));
		const resumed = await runToIdle(harness);

		expect(resumed.attemptId).toBe(blocked.attemptId);
		expect(resumed.status).toBe("complete");
		// Delivery ran with the recorded (enabled) policy and gates, not the new ones.
		const lastDeliver = harness.deliver.mock.calls.at(-1)?.[0];
		expect(lastDeliver?.policy.enabled).toBe(true);
		expect(lastDeliver?.gates).toEqual({ reviewRequired: true, verificationRequired: true });
		expect(resumed.policyVersion).toBe(blocked.policyVersion);
	});

	it("does not start or resume a pre-Git attempt once reliable mode is off", async () => {
		const harness = createHarness();
		harness.runReview.mockResolvedValueOnce(
			reviewResponse({ status: "blocked", error: "finding", verification: null }),
		);
		await runToIdle(harness);

		harness.setPolicy(policy({ gitDelivery: { ...DELIVERY_POLICY, enabled: false } }));
		const response = await harness.coordinator.start(SCOPE, TASK_ID);
		expect(response.ok).toBe(false);
		expect(response.error).toMatch(/Reliable completion is off/);
	});

	it("starts a fresh attempt when the policy changed before any Git side effect", async () => {
		const harness = createHarness();
		harness.runReview.mockResolvedValueOnce(
			reviewResponse({ status: "blocked", error: "finding", verification: null }),
		);
		const first = await runToIdle(harness);

		harness.setPolicy(policy({ verificationRequired: false }));
		const second = await runToIdle(harness);

		expect(second.attemptId).not.toBe(first.attemptId);
		expect(second.policyVersion).toBe(
			computeCompletionPolicyVersion({
				gitDelivery: DELIVERY_POLICY,
				reviewRequired: true,
				verificationRequired: false,
			}),
		);
		expect(second.status).toBe("complete");
	});

	it("refuses to start while the implementation writer is still running", async () => {
		const harness = createHarness({ writerActive: true });
		const response = await harness.coordinator.start(SCOPE, TASK_ID);
		expect(response.ok).toBe(false);
		expect(response.error).toMatch(/still running/);
		expect((await readCompletionAttempt(TASK_ID)).kind).toBe("none");
	});

	it("reports a record with an unknown schema version instead of overwriting it (B-4.3)", async () => {
		const dir = getTaskCompletionDir(TASK_ID);
		await mkdir(dir, { recursive: true });
		writeFileSync(join(dir, "attempt.json"), JSON.stringify({ schemaVersion: 99, taskId: TASK_ID }), "utf8");
		const harness = createHarness();

		const response = await harness.coordinator.start(SCOPE, TASK_ID);

		expect(response.ok).toBe(false);
		expect(response.error).toMatch(/schema version 99/);
		expect(harness.runReview).not.toHaveBeenCalled();
	});
});
