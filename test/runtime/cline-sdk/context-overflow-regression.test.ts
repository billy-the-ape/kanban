// B-1.2 — Deterministic context-overflow reproductions (no SDK subprocess).
//
// Baseline: abd4912 (Kanban 0.1.70) with @clinebot/core 0.0.38.
// Tests marked "[B-1 repro]" assert the DESIRED behavior and FAIL on the
// baseline. They are skipped on the baseline (it.skip) so the suite stays
// green; REMOVE the skip when B-2 repairs context handling and the tests
// pass. See the evidence report in docs/plans/B-1.md.
//
// The llama.cpp error string below is the exact shape reported in upstream
// cline/kanban issue #504 ("llama.cpp context overflow compaction fails").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	compactPersistedMessagesForContextOverflow,
	isContextOverflowError,
} from "../../../src/cline-sdk/cline-context-overflow-compaction";
import type { ClineSdkPersistedMessage } from "../../../src/cline-sdk/sdk-runtime-boundary";
import {
	createTaskSessionServiceHarness,
	type TaskSessionServiceHarness,
} from "../../utilities/cline-session-service-harness";

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
	deleteTaskTurnCheckpointRef: vi.fn(),
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
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

const LLAMA_CPP_OVERFLOW_ERROR =
	"request (60179 tokens) exceeds the available context size (60160 tokens), try increasing it";
const OPENAI_OVERFLOW_ERROR =
	"This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens (7000 in the messages, 2000 in the completion). Please shorten the messages or completion.";

const services: TaskSessionServiceHarness[] = [];

afterEach(async () => {
	await Promise.allSettled(services.splice(0).map((harness) => harness.service.dispose()));
});

describe("isContextOverflowError classification", () => {
	it("classifies OpenAI maximum-context-length errors", () => {
		expect(isContextOverflowError(new Error(OPENAI_OVERFLOW_ERROR))).toBe(true);
	});

	it.skip("[B-1 repro] classifies the llama.cpp request-shape error from upstream issue #504", () => {
		// Desired: recognized as context overflow so retryAfterContextOverflow
		// can compact and restart. Baseline: returns false because no pattern
		// matches "exceeds the available context size".
		expect(isContextOverflowError(new Error(LLAMA_CPP_OVERFLOW_ERROR))).toBe(true);
	});

	it.skip("[B-1 repro] does not classify unrelated errors that merely mention the context window", () => {
		// Desired: not an overflow. Baseline: the bare /\bcontext\s*(?:length|window)\b/i
		// pattern over-matches any message containing those words.
		expect(isContextOverflowError(new Error("The context window panel failed to resize: timeout after 30s"))).toBe(
			false,
		);
	});

	it.skip("[B-1 repro] classifies structured (non-Error) provider error objects", () => {
		// Desired: SDK provider errors are not always `instanceof Error`.
		// Baseline: isContextOverflowError returns false for anything that is
		// not an Error instance.
		expect(
			isContextOverflowError({
				name: "APIError",
				message: "prompt is too long: 200000 > 131072",
			}),
		).toBe(true);
	});
});

describe("compactPersistedMessagesForContextOverflow", () => {
	it("keeps roughly the latter half, starts at a user message, and prepends the first-user-message preview", () => {
		const messages: ClineSdkPersistedMessage[] = [
			{ role: "user", content: "Original task prompt about the kanban board" },
			{ role: "assistant", content: "Working on it" },
			{ role: "user", content: "Follow up question" },
			{ role: "assistant", content: "Answer to the follow up" },
		];

		const compacted = compactPersistedMessagesForContextOverflow(messages);

		expect(compacted?.length).toBe(2);
		expect(String((compacted?.[0] as { content: unknown }).content)).toContain(
			"[Previous conversation history was removed due to context window limits.",
		);
		expect(String((compacted?.[0] as { content: unknown }).content)).toContain(
			"Original task prompt about the kanban board",
		);
	});

	it("returns null when the history cannot be reduced", () => {
		expect(compactPersistedMessagesForContextOverflow([])).toBeNull();
		expect(compactPersistedMessagesForContextOverflow([{ role: "user", content: "only" }])).toBeNull();
	});
});
describe("context overflow recovery through the task session service", () => {
	async function startFirstTurn(harness: TaskSessionServiceHarness, taskId: string): Promise<void> {
		const { service, host } = harness;
		await service.startTaskSession({
			taskId,
			cwd: "/tmp/worktree",
			prompt: "First turn prompt",
			systemPrompt: "test system prompt",
		});
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBe(1);
		});
	}

	it("recovers a follow-up turn that fails with a recognized overflow error (OpenAI shape)", async () => {
		const harness = createTaskSessionServiceHarness({
			onTurn: (context) => {
				if (context.turnCount === 2) {
					throw new Error(OPENAI_OVERFLOW_ERROR);
				}
				return `reply ${context.turnCount}`;
			},
		});
		services.push(harness);
		const { service, host, store } = harness;
		const taskId = "task-overflow-openai";

		await startFirstTurn(harness, taskId);
		await service.sendTaskSessionInput(taskId, "Follow up prompt");
		// Turn 2 fails with overflow; recovery restarts (start #2) and resends
		// the follow-up as turn 3.
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBe(3);
		});

		expect(host.startedConfigs.length).toBe(2);
		const restartedMessages = store.messagesFor(host.startedConfigs[1]?.sessionId ?? "");
		expect(restartedMessages.length).toBeGreaterThan(0);
		const firstMessageContent = String(restartedMessages[0]?.content ?? "");
		expect(firstMessageContent).toContain("[Previous conversation history was removed due to context window limits.");
		expect(firstMessageContent).toContain("First turn prompt");
		expect(host.sentPrompts.at(-1)?.prompt).toBe("Follow up prompt");
		expect(service.getSummary(taskId)?.reviewReason).not.toBe("error");
	});

	it.skip("[B-1 repro] recovers a follow-up turn that fails with the llama.cpp error shape (upstream issue #504)", async () => {
		const harness = createTaskSessionServiceHarness({
			onTurn: (context) => {
				if (context.turnCount === 2) {
					throw new Error(LLAMA_CPP_OVERFLOW_ERROR);
				}
				return `reply ${context.turnCount}`;
			},
		});
		services.push(harness);
		const { service, host } = harness;
		const taskId = "task-overflow-llamacpp";

		await startFirstTurn(harness, taskId);
		await service.sendTaskSessionInput(taskId, "Follow up prompt");
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBeGreaterThanOrEqual(2);
		});

		// Desired: the llama.cpp overflow is classified, history is compacted,
		// and the session restarts with the follow-up resent.
		expect(host.startedConfigs.length).toBe(2);
		expect(service.getSummary(taskId)?.reviewReason).not.toBe("error");
	});

	it("characterization: an oversized first turn is not retried at all on the start path", async () => {
		const harness = createTaskSessionServiceHarness({
			onTurn: () => {
				throw new Error(OPENAI_OVERFLOW_ERROR);
			},
		});
		services.push(harness);
		const { service, host } = harness;
		const taskId = "task-overflow-first-turn";

		await service.startTaskSession({
			taskId,
			cwd: "/tmp/worktree",
			prompt: "Oversized first prompt",
			systemPrompt: "test system prompt",
		});
		await vi.waitFor(() => {
			expect(service.getSummary(taskId)?.reviewReason).toBe("error");
		});

		// Boundary: only the send path attempts overflow recovery; the start
		// path surfaces the provider error directly with no restart.
		expect(host.startedConfigs.length).toBe(1);
		expect(host.sentPrompts.length).toBe(1);
		expect(service.getSummary(taskId)?.warningMessage).toContain("maximum context length");
	});
});
