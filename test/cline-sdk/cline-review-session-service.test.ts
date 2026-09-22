// B-6.2 / B-6.4 / B-6.5 / B-6.7 — integration tests for the bounded review
// session orchestrator (ClineReviewSessionService).
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
import type { RuntimeReviewHandoffArtifact, RuntimeReviewOutcomeFile } from "../../src/core/api-contract";
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

function createReviewService(harness: TaskSessionServiceHarness, evidence: ClineReviewEvidencePort) {
	return createClineReviewSessionService({
		clineTaskSessionService: harness.service,
		resolveClineLaunchConfig: makeResolver(),
		workspaceId: "ws-1",
		repoPath: "/tmp/repo",
		evidence,
	});
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
