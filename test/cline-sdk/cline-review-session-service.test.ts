// B-6.2 / B-6.4 / B-6.5 / B-6.7 / B-7.2 / B-7.5 — integration tests for the
// bounded review session orchestrator (ClineReviewSessionService).
//
// Drives the REAL InMemoryClineTaskSessionService through the real
// InMemoryClineSessionRuntime against the in-memory fake session host (the
// shared harness), while the git/FS evidence (handoff, diff, tree hash,
// durable artifacts) is a small in-memory fake. The fake host's onTurn handler
// scripts the reviewer's replies and emits the "ended" event that moves each
// turn to a terminal state (the fake host never emits it on its own, like the
// real SDK). Covers: ready, bounded repair loop, parse failure, session
// failure, tree-hash-bound info, and disposal.

import type { ResolvedClineLaunchConfig } from "../../src/cline-sdk/cline-provider-service";
import {
	type ClineReviewEvidencePort,
	createClineReviewSessionService,
	reviewSessionIdForTask,
} from "../../src/cline-sdk/cline-review-session-service";
import type { ClineLaunchConfigResolver } from "../../src/cline-sdk/cline-session-runtime";
import type {
	RuntimeReviewHandoffArtifact,
	RuntimeReviewOutcomeFile,
	RuntimeVerificationCheckResult,
	RuntimeVerificationConfig,
	RuntimeVerificationReceipt,
} from "../../src/core/api-contract";
import type { VerificationRunInput, VerificationRunner } from "../../src/verification/verification-service";
import type { BuildReviewHandoffInput } from "../../src/workspace/task-review-handoff";
import {
	createTaskSessionServiceHarness,
	type TaskSessionServiceHarness,
} from "../utilities/cline-session-service-harness";

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
	deleteTaskTurnCheckpointRef: vi.fn(),
}));

vi.mock("../../src/workspace/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
	deleteTaskTurnCheckpointRef: turnCheckpointMocks.deleteTaskTurnCheckpointRef,
}));

beforeEach(() => {
	turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
	turnCheckpointMocks.deleteTaskTurnCheckpointRef.mockReset();
	turnCheckpointMocks.captureTaskTurnCheckpoint.mockImplementation(
		async (input: { taskId: string; turn: number }) => ({
			turn: input.turn,
			ref: `refs/kanban/checkpoints/${input.taskId}/turn/${input.turn}`,
			commit: `commit-${input.turn}`,
			createdAt: input.turn,
		}),
	);
	turnCheckpointMocks.deleteTaskTurnCheckpointRef.mockResolvedValue(undefined);
});

const services: TaskSessionServiceHarness[] = [];

afterEach(async () => {
	await Promise.allSettled(services.splice(0).map((harness) => harness.service.dispose()));
});

function makeLaunchConfig(): ResolvedClineLaunchConfig {
	return {
		providerId: "openrouter",
		modelId: "local/test-model",
		apiKey: "sk-test-key",
		baseUrl: "http://localhost:11434/v1",
		contextWindowTokens: 32_768,
		contextWindowSource: "provider-metadata",
		maxTokens: 4_096,
	};
}

const makeResolver = (): ClineLaunchConfigResolver => async () => makeLaunchConfig();

/** Builds a complete, valid handoff artifact from the orchestrator's input. */
function makeArtifact(input: BuildReviewHandoffInput): RuntimeReviewHandoffArtifact {
	return {
		taskId: input.taskId,
		worktreePath: input.worktreePath,
		repoPath: input.repoPath,
		startingCommit: input.startingCommit ?? null,
		latestCommit: "latestcommit",
		changedPaths: ["src/a.ts"],
		untrackedPaths: [],
		planDocuments: (input.planDocumentPaths ?? []).map((path) => ({
			path,
			sha256: "sha256",
			revision: "revision",
			exists: true,
		})),
		acceptanceCriteria: [input.description],
		designDecisions: input.agentNotes?.designDecisions ?? [],
		testsAttempted: input.agentNotes?.testsAttempted ?? [],
		knownLimitations: input.agentNotes?.knownLimitations ?? [],
		unresolvedQuestions: input.agentNotes?.unresolvedQuestions ?? [],
		createdAt: 1_700_000_000_000,
	};
}

interface FakeEvidenceOptions {
	baseRef?: string | null;
	worktreePath?: string;
	/** Mutable tree-hash source so tests can simulate a later edit invalidating the verdict. */
	treeHash?: () => string | null;
}

/** In-memory fake of the git/FS evidence the orchestrator depends on. */
function createFakeEvidencePort(options: FakeEvidenceOptions = {}): ClineReviewEvidencePort {
	const handoffs = new Map<string, RuntimeReviewHandoffArtifact>();
	const outcomes = new Map<string, RuntimeReviewOutcomeFile>();
	return {
		loadTaskBaseRef: async () => (options.baseRef === undefined ? "main" : options.baseRef),
		resolveWorktreePath: async () => options.worktreePath ?? "/tmp/review-worktree",
		readReviewRequest: async () => ({ planDocumentPaths: [], agentNotes: null }),
		buildHandoffArtifact: async (input) => makeArtifact(input),
		persistHandoff: async (artifact) => {
			handoffs.set(artifact.taskId, artifact);
			return `${artifact.taskId}/handoff.json`;
		},
		readHandoff: async (taskId) => handoffs.get(taskId) ?? null,
		extractDiff: async () => "diff --git a/src/a.ts b/src/a.ts",
		computeTreeHash: async () => (options.treeHash ? options.treeHash() : "tree-hash-1"),
		persistOutcome: async (taskId, outcome) => {
			outcomes.set(taskId, outcome);
			return `${taskId}/outcome.json`;
		},
		readOutcome: async (taskId) => outcomes.get(taskId) ?? null,
	};
}

/** Wraps a result payload in the fenced block the reviewer must emit. */
function reviewResultBlock(result: unknown): string {
	return `Review complete.\n\`\`\`kanban-review-result\n${JSON.stringify(result)}\n\`\`\``;
}

const CLEAN_RESULT = {
	findings: [],
	blocking: false,
	fixesApplied: [],
	requirementsCovered: ["criterion 1"],
	unresolvedItems: [],
};

const BLOCKED_RESULT = {
	findings: [
		{
			severity: "blocking",
			file: "src/a.ts",
			line: 10,
			description: "off-by-one",
			evidence: "line 10: i < length",
		},
	],
	blocking: true,
	fixesApplied: [],
	requirementsCovered: [],
	unresolvedItems: ["fix the off-by-one"],
};

/**
 * Scripts the fake host's per-turn replies and emits the "ended" event that
 * moves each turn to a terminal state. `reason: "completed"` is a success
 * (awaiting_review / exit); a reason containing "abort"/"interrupt" is a failure.
 */
function scriptTurns(harness: TaskSessionServiceHarness, scripts: Array<{ reply: string; reason: string }>): void {
	const { host, store } = harness;
	store.onTurn = async (context) => {
		const script = scripts[context.turnCount - 1] ?? { reply: "done", reason: "completed" };
		// Defer to after the in-flight send completes (matches the real SDK,
		// which emits "ended" once the turn finishes, not mid-turn).
		setImmediate(() => {
			host.emitEvent({ type: "ended", payload: { sessionId: context.sessionId, reason: script.reason } });
		});
		return script.reply;
	};
}

function createReviewService(
	harness: TaskSessionServiceHarness,
	evidence: ClineReviewEvidencePort,
	verificationRunner?: VerificationRunner,
	extra: { isTaskWriterActive?: (taskId: string) => Promise<boolean>; turnTimeoutMs?: number } = {},
) {
	return createClineReviewSessionService({
		clineTaskSessionService: harness.service,
		resolveClineLaunchConfig: makeResolver(),
		workspaceId: "ws-1",
		repoPath: "/tmp/repo",
		evidence,
		verificationRunner,
		...extra,
	});
}

/** B-7.1: the gate config the tests drive through the orchestrator. */
const GATE_CONFIG: RuntimeVerificationConfig = {
	enabled: "required",
	checks: [{ id: "lint", command: "npm", args: ["run", "lint"], successExitCodes: [0], required: true }],
};

function passedLintCheck(): RuntimeVerificationCheckResult {
	return {
		id: "lint",
		command: "npm",
		args: ["run", "lint"],
		status: "passed",
		exitCode: 0,
		emptyOutput: false,
		outputExcerpt: "0 problems",
		logPath: "/tmp/verification/lint.log",
		startedAt: 1,
		finishedAt: 2,
		error: null,
	};
}

function failedLintCheck(): RuntimeVerificationCheckResult {
	return {
		...passedLintCheck(),
		status: "failed",
		exitCode: 1,
		outputExcerpt: "src/a.ts:10: error TS2322",
	};
}

/** A receipt bound to the reviewed tree; overrides stand in for a specific gate outcome. */
function makeReceipt(overrides: Partial<RuntimeVerificationReceipt> = {}): RuntimeVerificationReceipt {
	return {
		treeHashBefore: "tree-hash-1",
		treeHashAfter: "tree-hash-1",
		treeIdentityPreserved: true,
		matchesCandidate: true,
		checks: [passedLintCheck()],
		passed: true,
		error: null,
		startedAt: 1,
		finishedAt: 2,
		...overrides,
	};
}

/** Scripted verification runner: serves receipts in order (the last one repeats). */
function createFakeVerificationRunner(
	receipts: RuntimeVerificationReceipt[],
	onRun?: (callIndex: number) => void,
): { runner: VerificationRunner; calls: VerificationRunInput[] } {
	const calls: VerificationRunInput[] = [];
	return {
		calls,
		runner: {
			async run(_config, input) {
				const callIndex = calls.length;
				calls.push(input);
				onRun?.(callIndex);
				return receipts[Math.min(callIndex, receipts.length - 1)];
			},
		},
	};
}

describe("ClineReviewSessionService.startTaskReview", () => {
	it("produces a ready result bound to the candidate tree when there are no blocking findings", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const reviewService = createReviewService(harness, createFakeEvidencePort());
		scriptTurns(harness, [{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
		});

		expect(response.ok).toBe(true);
		expect(response.status).toBe("ready");
		expect(response.error).toBeNull();
		expect(response.sessionId).toBe(reviewSessionIdForTask("task-1"));
		expect(response.candidateTreeHash).toBe("tree-hash-1");
		expect(response.result).not.toBeNull();
		expect(response.result?.blocking).toBe(false);
		expect(response.result?.taskId).toBe("task-1");
		expect(response.result?.candidateTreeHash).toBe("tree-hash-1");
		expect(response.handoff?.taskId).toBe("task-1");
	});

	it("runs a bounded repair round and reports ready once the findings are resolved", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const reviewService = createReviewService(harness, createFakeEvidencePort());
		scriptTurns(harness, [
			{ reply: reviewResultBlock(BLOCKED_RESULT), reason: "completed" }, // turn 1: findings
			{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }, // turn 2 (repair): fixed
		]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
			reviewPolicy: { enabled: "required", instructions: "", modelOverride: null, maxRepairRounds: 2 },
		});

		expect(response.ok).toBe(true);
		expect(response.status).toBe("ready");
		expect(response.result?.blocking).toBe(false);
		// Exactly two turns: the initial review + one repair round.
		await vi.waitFor(() => expect(harness.host.sentPrompts.length).toBe(2));
	});

	it("stops after the bounded repair budget and reports blocked when findings remain", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const reviewService = createReviewService(harness, createFakeEvidencePort());
		// Both rounds still report the same blocking finding (the repair cannot fix it).
		scriptTurns(harness, [
			{ reply: reviewResultBlock(BLOCKED_RESULT), reason: "completed" },
			{ reply: reviewResultBlock(BLOCKED_RESULT), reason: "completed" },
		]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
			reviewPolicy: { enabled: "required", instructions: "", modelOverride: null, maxRepairRounds: 1 },
		});

		expect(response.ok).toBe(true);
		expect(response.status).toBe("blocked");
		expect(response.result?.blocking).toBe(true);
		// Bounded to one repair round: initial + 1 repair = 2 turns (not 3).
		await vi.waitFor(() => expect(harness.host.sentPrompts.length).toBe(2));
	});

	it("reports parse_failed (never a pass) when the reviewer omits the result block", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const reviewService = createReviewService(harness, createFakeEvidencePort());
		scriptTurns(harness, [
			{ reply: "I reviewed the change set but forgot to include the required block.", reason: "completed" },
		]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
		});

		expect(response.ok).toBe(false);
		expect(response.status).toBe("parse_failed");
		expect(response.result).toBeNull();
		expect(response.error).toMatch(/kanban-review-result/);
	});

	it("reports failed when the review session is interrupted before producing a result", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const reviewService = createReviewService(harness, createFakeEvidencePort());
		scriptTurns(harness, [{ reply: "interrupted", reason: "aborted" }]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
		});

		expect(response.ok).toBe(false);
		expect(response.status).toBe("failed");
		expect(response.result).toBeNull();
		expect(response.error).toMatch(/interrupted/i);
	});

	it("reports failed when the task's base branch cannot be determined", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const reviewService = createReviewService(harness, createFakeEvidencePort({ baseRef: null }));
		scriptTurns(harness, [{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
		});

		expect(response.ok).toBe(false);
		expect(response.status).toBe("failed");
		expect(response.error).toMatch(/base branch/i);
	});
});

describe("ClineReviewSessionService.getReviewInfo", () => {
	it("confirms a stored result matches the tree, then flags it stale after the tree changes", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		let treeHash = "tree-hash-1";
		const reviewService = createReviewService(harness, createFakeEvidencePort({ treeHash: () => treeHash }));
		scriptTurns(harness, [{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }]);

		const startResponse = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
		});
		expect(startResponse.result?.candidateTreeHash).toBe("tree-hash-1");

		// Tree unchanged: the stored verdict still matches.
		const matched = await reviewService.getReviewInfo("task-1");
		expect(matched.ok).toBe(true);
		expect(matched.status).toBe("ready");
		expect(matched.candidateTreeHash).toBe("tree-hash-1");
		expect(matched.resultMatchesTree).toBe(true);

		// A later edit changes the tree: the stored verdict is now invalid.
		treeHash = "tree-hash-2";
		const stale = await reviewService.getReviewInfo("task-1");
		expect(stale.candidateTreeHash).toBe("tree-hash-2");
		expect(stale.resultMatchesTree).toBe(false);
	});

	it("reports nulls when no review has been run for the task", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const reviewService = createReviewService(harness, createFakeEvidencePort());

		const info = await reviewService.getReviewInfo("never-reviewed");

		expect(info.ok).toBe(true);
		expect(info.status).toBeNull();
		expect(info.handoff).toBeNull();
		expect(info.result).toBeNull();
		expect(info.resultMatchesTree).toBeNull();
		expect(info.error).toBeNull();
	});
});

describe("ClineReviewSessionService.dispose", () => {
	it("stops an in-flight review session", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const reviewService = createReviewService(harness, createFakeEvidencePort());
		// No onTurn scripted: the turn completes but never emits "ended", so the
		// session stays running (an in-flight review).
		const sessionId = reviewSessionIdForTask("task-1");

		await harness.service.startTaskSession({
			taskId: sessionId,
			cwd: "/tmp/review-worktree",
			prompt: "review the change set",
		});
		await vi.waitFor(() => expect(harness.host.sentPrompts.length).toBe(1));
		expect(harness.service.getSummary(sessionId)?.state).toBe("running");

		await reviewService.dispose();

		await vi.waitFor(() => expect(harness.service.getSummary(sessionId)?.state).toBe("interrupted"));
	});
});

describe("ClineReviewSessionService.startTaskReview — B-7 verification gate", () => {
	it("gates a clean review as ready when the checks pass, persisting the receipt", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const evidence = createFakeEvidencePort();
		const fake = createFakeVerificationRunner([makeReceipt()]);
		const reviewService = createReviewService(harness, evidence, fake.runner);
		scriptTurns(harness, [{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
			verification: GATE_CONFIG,
		});

		expect(response.ok).toBe(true);
		expect(response.status).toBe("ready");
		expect(response.error).toBeNull();
		expect(response.verification?.passed).toBe(true);
		expect(response.verification?.matchesCandidate).toBe(true);
		expect(response.verification?.treeHashBefore).toBe("tree-hash-1");
		// The gate runs against the exact reviewed candidate in the task worktree.
		expect(fake.calls).toEqual([
			{ taskId: "task-1", worktreePath: "/tmp/review-worktree", candidateTreeHash: "tree-hash-1" },
		]);
		// The receipt is bound into the durable outcome.
		const outcome = await evidence.readOutcome("task-1");
		expect(outcome?.verification?.passed).toBe(true);
		expect(outcome?.verification?.checks?.[0]?.id).toBe("lint");
	});

	it("blocks delivery on a failing receipt even when the reviewer reports clean", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const failing = makeReceipt({
			passed: false,
			error: "required check failed: lint (exit 1)",
			checks: [failedLintCheck()],
		});
		const fake = createFakeVerificationRunner([failing]);
		const reviewService = createReviewService(harness, createFakeEvidencePort(), fake.runner);
		scriptTurns(harness, [{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
			reviewPolicy: { enabled: "required", instructions: "", modelOverride: null, maxRepairRounds: 1 },
			verification: GATE_CONFIG,
		});

		// The reviewer's narrative is clean, but the deterministic gate blocks.
		expect(response.ok).toBe(true);
		expect(response.status).toBe("blocked");
		expect(response.result?.blocking).toBe(false);
		expect(response.error).toBe("required check failed: lint (exit 1)");
		expect(response.verification?.passed).toBe(false);
		expect(response.verification?.checks?.[0]?.status).toBe("failed");
		// Initial gate run + one (unsuccessful) verification repair round.
		expect(fake.calls.length).toBe(2);
	});

	it("re-runs the gate after a verification repair round and rebinds to the mutated tree", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		let treeHash = "tree-hash-1";
		const evidence = createFakeEvidencePort({ treeHash: () => treeHash });
		const failing = makeReceipt({
			passed: false,
			error: "required check failed: lint (exit 1)",
			checks: [failedLintCheck()],
		});
		const fake = createFakeVerificationRunner(
			[failing, makeReceipt({ treeHashBefore: "tree-hash-2", treeHashAfter: "tree-hash-2" })],
			(callIndex) => {
				if (callIndex === 0) {
					// The repair agent fixes the lint error: the tree moves.
					treeHash = "tree-hash-2";
				}
			},
		);
		const reviewService = createReviewService(harness, evidence, fake.runner);
		scriptTurns(harness, [{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
			reviewPolicy: { enabled: "required", instructions: "", modelOverride: null, maxRepairRounds: 1 },
			verification: GATE_CONFIG,
		});

		expect(response.ok).toBe(true);
		expect(response.status).toBe("ready");
		// The outcome is bound to the post-repair tree, not the original candidate.
		expect(response.candidateTreeHash).toBe("tree-hash-2");
		expect(response.verification?.treeHashBefore).toBe("tree-hash-2");
		expect(fake.calls.map((call) => call.candidateTreeHash)).toEqual(["tree-hash-1", "tree-hash-2"]);
		// Initial review + one verification repair prompt.
		await vi.waitFor(() => expect(harness.host.sentPrompts.length).toBe(2));
	});

	it("reports blocked when the gate keeps failing until the repair budget is exhausted", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const failing = makeReceipt({
			passed: false,
			error: "required check failed: lint (exit 1)",
			checks: [failedLintCheck()],
		});
		const fake = createFakeVerificationRunner([failing]);
		const reviewService = createReviewService(harness, createFakeEvidencePort(), fake.runner);
		scriptTurns(harness, [{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
			reviewPolicy: { enabled: "required", instructions: "", modelOverride: null, maxRepairRounds: 2 },
			verification: GATE_CONFIG,
		});

		expect(response.ok).toBe(true);
		expect(response.status).toBe("blocked");
		expect(response.error).toBe("required check failed: lint (exit 1)");
		// Initial gate run + two repair rounds (the full budget).
		expect(fake.calls.length).toBe(3);
		await vi.waitFor(() => expect(harness.host.sentPrompts.length).toBe(3));
	});

	it("shares the repair budget between review repairs and verification repairs", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const failing = makeReceipt({
			passed: false,
			error: "required check failed: lint (exit 1)",
			checks: [failedLintCheck()],
		});
		const fake = createFakeVerificationRunner([failing]);
		const reviewService = createReviewService(harness, createFakeEvidencePort(), fake.runner);
		scriptTurns(harness, [
			{ reply: reviewResultBlock(BLOCKED_RESULT), reason: "completed" }, // turn 1: findings
			{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }, // turn 2 (review repair): resolved
			// turn 3 (verification repair): the fallback reply, then the gate fails again.
		]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
			reviewPolicy: { enabled: "required", instructions: "", modelOverride: null, maxRepairRounds: 2 },
			verification: GATE_CONFIG,
		});

		// One round went to the review findings, leaving one for the gate — exhausted.
		expect(response.status).toBe("blocked");
		expect(response.result?.blocking).toBe(false);
		expect(response.error).toBe("required check failed: lint (exit 1)");
		expect(fake.calls.length).toBe(2);
		await vi.waitFor(() => expect(harness.host.sentPrompts.length).toBe(3));
	});

	it("never runs the gate when the review itself blocks or the gate config is absent", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const fake = createFakeVerificationRunner([makeReceipt()]);
		const reviewService = createReviewService(harness, createFakeEvidencePort(), fake.runner);
		scriptTurns(harness, [
			{ reply: reviewResultBlock(BLOCKED_RESULT), reason: "completed" },
			{ reply: reviewResultBlock(BLOCKED_RESULT), reason: "completed" },
		]);

		const blockedResponse = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
			reviewPolicy: { enabled: "required", instructions: "", modelOverride: null, maxRepairRounds: 1 },
			verification: GATE_CONFIG,
		});
		expect(blockedResponse.status).toBe("blocked");
		expect(blockedResponse.verification).toBeNull();

		// A second, gateless review on a fresh session: the runner must stay untouched.
		const secondHarness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(secondHarness);
		const secondReviewService = createReviewService(secondHarness, createFakeEvidencePort(), fake.runner);
		scriptTurns(secondHarness, [{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }]);

		const noGateResponse = await secondReviewService.startTaskReview({
			taskId: "task-2",
			description: "Implement feature Y",
		});
		expect(noGateResponse.status).toBe("ready");
		expect(noGateResponse.verification).toBeNull();
		expect(fake.calls.length).toBe(0);
	});
});

describe("ClineReviewSessionService.startTaskReview — ownership, freshness, and bounds", () => {
	it("skips the verification gate when verification.enabled is off", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const fake = createFakeVerificationRunner([makeReceipt({ passed: false, error: "should not run" })]);
		const reviewService = createReviewService(harness, createFakeEvidencePort(), fake.runner);
		scriptTurns(harness, [{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
			verification: { ...GATE_CONFIG, enabled: "off" },
		});

		expect(response.status).toBe("ready");
		expect(response.verification).toBeNull();
		expect(fake.calls.length).toBe(0);
	});

	it("refuses to review while the implementation writer is still running", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const reviewService = createReviewService(harness, createFakeEvidencePort(), undefined, {
			isTaskWriterActive: async () => true,
		});

		const response = await reviewService.startTaskReview({ taskId: "task-1", description: "Implement feature X" });

		expect(response.ok).toBe(false);
		expect(response.error).toMatch(/implementation session is still running/);
		expect(harness.host.sentPrompts.length).toBe(0);
	});

	it("rejects a concurrent review of the same task", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const reviewService = createReviewService(harness, createFakeEvidencePort());
		scriptTurns(harness, [{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }]);

		const first = reviewService.startTaskReview({ taskId: "task-1", description: "Implement feature X" });
		const second = await reviewService.startTaskReview({ taskId: "task-1", description: "Implement feature X" });

		expect(second.ok).toBe(false);
		expect(second.error).toMatch(/already running/);
		expect((await first).status).toBe("ready");
	});

	it("starts every review run from a fresh session instead of reusing the finished one", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const reviewService = createReviewService(harness, createFakeEvidencePort());
		scriptTurns(harness, [
			{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" },
			{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" },
		]);

		const first = await reviewService.startTaskReview({ taskId: "task-1", description: "Implement feature X" });
		expect(first.status).toBe("ready");

		// A second run must send a new initial prompt, not return the old summary.
		const promptsBefore = harness.host.sentPrompts.length;
		const second = await reviewService.startTaskReview({ taskId: "task-1", description: "Implement feature X" });
		expect(second.status).toBe("ready");
		expect(harness.host.sentPrompts.length).toBeGreaterThan(promptsBefore);
	});

	it("stops a turn that exceeds the turn timeout and reports the review as failed", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		// No "ended" event is scripted, so the turn never finishes on its own.
		const reviewService = createReviewService(harness, createFakeEvidencePort(), undefined, { turnTimeoutMs: 50 });

		const response = await reviewService.startTaskReview({ taskId: "task-1", description: "Implement feature X" });

		expect(response.status).toBe("failed");
		expect(response.error).toMatch(/exceeded the .*limit and was stopped/);
	});

	it("runs verification repairs in a fresh session scoped to the change set", async () => {
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: makeResolver() });
		services.push(harness);
		const failing = makeReceipt({ passed: false, error: "lint failed", checks: [failedLintCheck()] });
		const fake = createFakeVerificationRunner([failing, makeReceipt()]);
		const reviewService = createReviewService(harness, createFakeEvidencePort(), fake.runner);
		scriptTurns(harness, [{ reply: reviewResultBlock(CLEAN_RESULT), reason: "completed" }]);

		const response = await reviewService.startTaskReview({
			taskId: "task-1",
			description: "Implement feature X",
			reviewPolicy: { enabled: "required", instructions: "", modelOverride: null, maxRepairRounds: 1 },
			verification: GATE_CONFIG,
		});

		expect(response.status).toBe("ready");
		const repairSessionId = `${reviewSessionIdForTask("task-1")}::verification-repair-1`;
		expect(harness.service.getSummary(repairSessionId)).not.toBeNull();
		const repairPrompt = harness.service
			.listMessages(repairSessionId)
			.find((message) => message.role === "user")?.content;
		expect(repairPrompt).toContain("fresh repair session");
		expect(repairPrompt).toContain("src/a.ts");
	});
});
