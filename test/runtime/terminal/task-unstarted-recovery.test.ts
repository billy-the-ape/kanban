import { describe, expect, it, vi } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeTaskPreservationInfoResponse,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import {
	assessUnstartedTaskRecovery,
	type UnstartedRecoveryTerminalView,
	type UnstartedTaskRecoveryInput,
} from "../../../src/terminal/task-unstarted-recovery";
import type { TaskInitialStartRecord } from "../../../src/workspace/task-initial-start";

const BASELINE_SHA = "0123456789abcdef0123456789abcdef01234567";

function createCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: "task-1",
		title: "Original task",
		prompt: "Implement the feature",
		startInPlanMode: false,
		baseRef: "main",
		...overrides,
	} as unknown as RuntimeBoardCard;
}

function createBaseline(baselineSha: string | null = BASELINE_SHA): TaskInitialStartRecord {
	return {
		taskId: "task-1",
		baseRef: "main",
		updateBaseRefBeforeStart: true,
		state: baselineSha ? "prepared" : "blocked",
		baselineSha,
		failure: null,
		updatedAt: Date.now(),
	};
}

function createWork(overrides: Partial<RuntimeTaskPreservationInfoResponse> = {}): RuntimeTaskPreservationInfoResponse {
	return {
		ok: true,
		worktreeExists: true,
		worktreePath: "/tmp/worktree",
		headCommit: BASELINE_SHA,
		dirty: false,
		changedFiles: [],
		commitsAheadOfBase: 0,
		preservation: null,
		...overrides,
	};
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "idle",
		agentId: "pi",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		...overrides,
	};
}

function createTerminal(summary: RuntimeTaskSessionSummary | null): UnstartedRecoveryTerminalView {
	return {
		getSummary: () => summary,
		hasActiveProcess: () => false,
	};
}

function assess(overrides: Partial<UnstartedTaskRecoveryInput> = {}) {
	return assessUnstartedTaskRecovery({
		taskId: "task-1",
		card: createCard(),
		agentId: "pi",
		terminal: createTerminal(null),
		baseline: createBaseline(),
		work: createWork(),
		hasAgentConversation: vi.fn(async () => false),
		...overrides,
	});
}

describe("unstarted task recovery assessment (AA-UNSUPPORTED)", () => {
	it("recovers a prepared task whose agent never started", async () => {
		const assessment = await assess();
		expect(assessment.recoverable).toBe(true);
		expect(assessment.neverLaunched).toBe(true);
		// Recovery relaunches the stored prompt, never a generic "resume".
		expect(assessment.prompt).toBe("Implement the feature");
		expect(assessment.reason).toBeNull();
	});

	it("treats a failed launch record with no pid as never launched", async () => {
		const assessment = await assess({
			terminal: createTerminal(
				createSummary({
					state: "failed",
					reviewReason: "error",
					warningMessage: "Could not prepare the agent launch: boom",
				}),
			),
		});
		expect(assessment.recoverable).toBe(true);
		expect(assessment.neverLaunched).toBe(true);
	});

	it("does not call a task that already ran a session never launched", async () => {
		const assessment = await assess({
			terminal: createTerminal(createSummary({ state: "idle", startedAt: 1_700_000_000_000, pid: 4242 })),
		});
		expect(assessment.neverLaunched).toBe(false);
		// An idle record with a past run is a paused task, not a failed launch; it
		// is still recoverable in place because the worktree is untouched.
		expect(assessment.recoverable).toBe(true);
	});

	it("refuses to duplicate an existing agent conversation", async () => {
		const assessment = await assess({ hasAgentConversation: async () => true });
		expect(assessment.recoverable).toBe(false);
		expect(assessment.neverLaunched).toBe(false);
		expect(assessment.reason).toContain("already exists");
	});

	it("asks for the settings to be corrected before retrying an unsupported request", async () => {
		const assessment = await assess({ card: createCard({ startInPlanMode: true }) });
		expect(assessment.recoverable).toBe(false);
		expect(assessment.settingsError).toContain("plan mode");
		expect(assessment.reason).toContain("Fix the task settings first");
		// The card is still known to have never launched, which is the point: the
		// user corrects plan mode here instead of retrying a doomed launch.
		expect(assessment.neverLaunched).toBe(true);
	});

	it("refuses to relaunch over a live or running session", async () => {
		const running = await assess({ terminal: createTerminal(createSummary({ state: "running" })) });
		expect(running.recoverable).toBe(false);
		expect(running.reason).toContain("already running");

		const manager = createTerminal(createSummary({ state: "idle" }));
		const live = await assess({
			terminal: { ...manager, hasActiveProcess: () => true },
		});
		expect(live.recoverable).toBe(false);
		expect(live.reason).toContain("running agent process");
	});

	it("points an interrupted session at Restore instead of a second conversation", async () => {
		// `state: "interrupted"` is the shape Kanban actually writes when it loses a
		// live process (shutdown coordinator, stale-record recovery, killed PTY) and
		// the shape `isDetachedPiRestoreCandidate` accepts. Matching only the review
		// reason left every real record eligible for a relaunch over a conversation
		// Restore owns.
		const assessment = await assess({
			terminal: createTerminal(
				createSummary({
					agentId: "pi",
					state: "interrupted",
					reviewReason: "interrupted",
					pid: null,
					startedAt: 1_700_000_000_000,
				}),
			),
		});
		expect(assessment.recoverable).toBe(false);
		expect(assessment.reason).toContain("Restore");
		expect(assessment.neverLaunched).toBe(false);
	});

	it("does not call a task never launched when its conversation cannot be probed", async () => {
		// Claude (and Codex/Droid/Kiro/Gemini) resume "the latest session", so nothing
		// proves a conversation is absent. A task that ran and whose relaunch then
		// failed is indistinguishable from a never-started one — the failure paths
		// reset `startedAt` — so claiming otherwise would mislabel the card and free
		// the prompt editor on a task with real work behind it.
		const assessment = await assess({
			agentId: "claude" as UnstartedTaskRecoveryInput["agentId"],
			hasAgentConversation: undefined,
			terminal: createTerminal(
				createSummary({
					agentId: "claude",
					state: "failed",
					reviewReason: "error",
					startedAt: null,
					pid: null,
					warningMessage: "Could not start the agent process: boom",
				}),
			),
		});
		expect(assessment.recoverable).toBe(false);
		expect(assessment.reason).toContain("cannot be proven empty");
		expect(assessment.neverLaunched).toBe(false);
	});

	it("guards the native Cline record that lives outside the terminal manager", async () => {
		const assessment = await assess({
			agentId: "cline",
			additionalSummaries: [createSummary({ agentId: "cline", state: "running" })],
			hasAgentConversation: async () => false,
		});
		expect(assessment.recoverable).toBe(false);
		expect(assessment.reason).toContain("already running");
	});

	it("refuses an agent whose conversation Kanban cannot prove empty", async () => {
		const assessment = await assess({ agentId: "claude", hasAgentConversation: undefined });
		expect(assessment.recoverable).toBe(false);
		expect(assessment.reason).toContain("cannot be proven empty");
	});

	it("never relaunches over work that could be discarded or replayed", async () => {
		const dirty = await assess({ work: createWork({ dirty: true, changedFiles: ["src/a.ts"] }) });
		expect(dirty.recoverable).toBe(false);
		expect(dirty.reason).toContain("uncommitted changes");
		expect(dirty.neverLaunched).toBe(false);

		const ahead = await assess({ work: createWork({ commitsAheadOfBase: 2 }) });
		expect(ahead.recoverable).toBe(false);
		expect(ahead.reason).toContain("commits of its own");

		const moved = await assess({ work: createWork({ headCommit: "ffff56789abcdef0123456789abcdef01234567" }) });
		expect(moved.recoverable).toBe(false);
		expect(moved.reason).toContain("no longer the saved baseline");

		const delivered = await assess({ deliveryReceipt: { status: "delivered" } as never });
		expect(delivered.recoverable).toBe(false);
		expect(delivered.reason).toContain("delivery receipt");

		const patched = await assess({ hasStoredPatch: true });
		expect(patched.recoverable).toBe(false);
		expect(patched.reason).toContain("stored patch");
	});

	it("sends a task with no prepared baseline back through the normal start", async () => {
		const assessment = await assess({ baseline: null });
		expect(assessment.recoverable).toBe(false);
		expect(assessment.reason).toContain("No prepared baseline");
	});

	it("explains a missing worktree instead of creating one", async () => {
		const assessment = await assess({ work: createWork({ worktreeExists: false, headCommit: null }) });
		expect(assessment.recoverable).toBe(false);
		expect(assessment.reason).toContain("worktree does not exist");
	});

	it("reports a card that is not on the board with no prompt to lose", async () => {
		const missing = await assess({ card: null });
		expect(missing.recoverable).toBe(false);
		expect(missing.prompt).toBe("");

		const empty = await assess({ card: createCard({ prompt: "   " }) });
		expect(empty.recoverable).toBe(false);
		expect(empty.reason).toContain("no prompt");
	});
});
