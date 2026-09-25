// B-3 — Safe bounded context-overflow recovery (regression suite).
//
// B-1.2 established deterministic overflow reproductions against the fake SDK
// host (no provider subprocess). B-3 replaced the retired message-halving
// fallback (cline-context-overflow-compaction.ts) with:
//
// - B-3.1: `isContextOverflowError` (src/cline-sdk/cline-context-recovery.ts)
//   classifies structured provider errors (provider error `code`, HTTP 413,
//   `cause` chains, `{ error: ... }` envelopes) and treats narrow message
//   patterns — each tying the failure to the model's context/input size — as
//   the last resort, so a UI error about a "context window panel" is never
//   retried as an overflow.
// - B-3.2: `compactClineConversationMessages` (src/cline-sdk/
//   cline-compaction-callback.ts) — the same deterministic, token-budget-aware
//   compactor the SDK `compact` callback and the local-mode beforeModel hook
//   use. It repairs orphaned tool_result blocks and prepends a compaction
//   notice to the surviving first message.
// - B-3.4: recovery pauses with an actionable reason when the original task
//   requirements (first user message) alone exceed the calibrated compaction
//   target, instead of silently truncating them.
// - B-3.5: the send-path recovery loop is bounded by
//   `contextRecoveryMaxAttempts` (default 3); each attempt re-reads the
//   persisted transcript (which includes the failed resend) and re-compacts
//   it, so the restarted request only gets smaller.
// - B-3.6: a canceled turn is never revived by recovery (config preservation
//   on the recovery restart is covered in session-restart-regression.test.ts).
// - B-3.7: recovery pauses with an actionable reason when the pinned request
//   material (system prompt + prompt + images) alone exceeds the effective
//   input budget, where no amount of history compaction can make the turn fit.
//
// The fake host persists the failed user prompt BEFORE invoking onTurn, so
// each overflow attempt's prompt is already in the persisted transcript when
// the next attempt re-reads it — the same property the real recovery relies
// on for shrink-only restarts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactClineConversationMessages } from "../../../src/cline-sdk/cline-compaction-callback";
import {
	evaluateClineContextRecoveryBudget,
	evaluateClineRecoveryRequirements,
	findClineUnresolvedToolCalls,
	isContextOverflowError,
} from "../../../src/cline-sdk/cline-context-recovery";
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

const workspaceStateMocks = vi.hoisted(() => ({
	getTaskWorktreesHomePath: vi.fn(),
}));

vi.mock("../../../src/state/workspace-state.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/state/workspace-state")>();
	return {
		...original,
		getTaskWorktreesHomePath: workspaceStateMocks.getTaskWorktreesHomePath,
	};
});

let worktreesHomePath = "";

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
	// Compaction event records (B-10.4) are durable per-task artifacts; point
	// them at a throwaway dir so the suite never writes into the real ~/.cline.
	worktreesHomePath = mkdtempSync(join(tmpdir(), "kanban-b3-overflow-home-"));
	workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(worktreesHomePath);
});

const LLAMA_CPP_OVERFLOW_ERROR =
	"request (60179 tokens) exceeds the available context size (60160 tokens), try increasing it";
const OPENAI_OVERFLOW_ERROR =
	"This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens (7000 in the messages, 2000 in the completion). Please shorten the messages or completion.";
const OPENAI_PROMPT_TOO_LONG_ERROR = "prompt is too long: 200000 > 131072";
const COMPACTION_NOTICE_PREFIX = "[Earlier conversation turns were removed to fit the context window.";

const services: TaskSessionServiceHarness[] = [];

afterEach(async () => {
	await Promise.allSettled(services.splice(0).map((harness) => harness.service.dispose()));
	if (worktreesHomePath) {
		rmSync(worktreesHomePath, { recursive: true, force: true });
		worktreesHomePath = "";
	}
});
describe("B-3.1 isContextOverflowError classification", () => {
	it("classifies the OpenAI maximum-context-length error shape", () => {
		expect(isContextOverflowError(new Error(OPENAI_OVERFLOW_ERROR))).toBe(true);
	});

	it("classifies the llama.cpp request-shape error from upstream issue #504", () => {
		// The B-1 baseline missed this shape entirely ("exceeds the available
		// context size" matched no pattern); B-3.1 classifies it so the send
		// path can compact and restart instead of failing the turn.
		expect(isContextOverflowError(new Error(LLAMA_CPP_OVERFLOW_ERROR))).toBe(true);
	});

	it("classifies the OpenAI prompt-too-long error shape", () => {
		expect(isContextOverflowError(new Error(OPENAI_PROMPT_TOO_LONG_ERROR))).toBe(true);
	});

	it("classifies full-context-window and total-token messages", () => {
		expect(isContextOverflowError(new Error("Your context window is full, please start a new chat"))).toBe(true);
		expect(
			isContextOverflowError(new Error("total number of tokens (85000) exceeds the maximum allowed (8192)")),
		).toBe(true);
	});

	it("classifies structured provider error codes without any message match", () => {
		// B-3.1 defect 1 of the retired fallback: classification required
		// `instanceof Error` first, so structured payloads (plain JSON from
		// the API gateway or SDK) were never classified.
		expect(
			isContextOverflowError({
				name: "APIError",
				message: "upstream rejected the request",
				code: "context_length_exceeded",
			}),
		).toBe(true);
		// Provider codes are matched case-insensitively.
		expect(isContextOverflowError({ message: "weird", code: "PROMPT_TOO_LONG" })).toBe(true);
	});

	it("classifies provider envelopes with a structured code nested under `error`", () => {
		expect(
			isContextOverflowError({
				error: { message: "upstream rejected the request", code: "prompt_too_long" },
			}),
		).toBe(true);
	});

	it("classifies overflow errors nested in the `cause` chain", () => {
		// B-3.1 defect 1, part two: the retired fallback never walked `cause`.
		expect(isContextOverflowError(new Error("provider error", { cause: new Error("context length exceeded") }))).toBe(
			true,
		);
		// Envelope envelopes: the nested payload usually owns the rest of the chain.
		expect(
			isContextOverflowError({
				error: { message: "bad gateway", cause: { code: "max_context_length_exceeded" } },
			}),
		).toBe(true);
	});

	it("classifies HTTP 413 (payload too large) from the model endpoint", () => {
		expect(isContextOverflowError({ statusCode: 413, message: "payload rejected" })).toBe(true);
		expect(isContextOverflowError({ status: "413", message: "too large" })).toBe(true);
	});

	it("terminates on a self-referencing `cause` cycle and does not classify", () => {
		const cyclic = new Error("boom");
		(cyclic as { cause?: unknown }).cause = cyclic;
		expect(isContextOverflowError(cyclic)).toBe(false);
	});

	it("does not classify unrelated errors that merely mention the context window", () => {
		// B-3.1 defect 2 of the retired fallback: a bare /context
		// (window|length)/ pattern matched any message mentioning those words.
		expect(isContextOverflowError(new Error("The context window panel failed to resize: timeout after 30s"))).toBe(
			false,
		);
		expect(isContextOverflowError(new Error("Failed to save the context window file to disk: ENOSPC"))).toBe(false);
		expect(isContextOverflowError(new Error("Model is rate limited, please retry later"))).toBe(false);
	});

	it("does not classify generic provider failures", () => {
		expect(isContextOverflowError(new Error("provider returned 500: internal error"))).toBe(false);
		expect(isContextOverflowError({ statusCode: 500, message: "the request payload size is large" })).toBe(false);
	});
});
describe("B-3.2 compactClineConversationMessages", () => {
	/** Tool_result blocks whose tool_use owner is missing from the transcript. */
	function orphanToolResultIds(messages: ClineSdkPersistedMessage[]): string[] {
		const toolUseIds = new Set<string>();
		for (const message of messages) {
			if (message.role !== "assistant" || typeof message.content === "string") {
				continue;
			}
			for (const block of message.content) {
				if (block.type === "tool_use") {
					toolUseIds.add(block.id);
				}
			}
		}
		const orphans: string[] = [];
		for (const message of messages) {
			if (message.role !== "user" || typeof message.content === "string") {
				continue;
			}
			for (const block of message.content) {
				if (block.type === "tool_result" && !toolUseIds.has(block.tool_use_id)) {
					orphans.push(block.tool_use_id);
				}
			}
		}
		return orphans;
	}

	it("shrinks a few huge messages (small count, big content) to the target without growing", () => {
		const messages: ClineSdkPersistedMessage[] = [
			{ role: "user", content: "u".repeat(20_000) },
			{ role: "assistant", content: "a".repeat(20_000) },
		];

		const result = compactClineConversationMessages(messages, 1_000);

		// Two huge messages cannot fit: the last assistant is deleted and the
		// first user message (the original requirements) is truncated as a
		// last resort, with the compaction notice on the surviving message.
		expect(result.changed).toBe(true);
		expect(result.messages.length).toBe(1);
		expect(result.tokensBefore).toBeGreaterThanOrEqual(10_000);
		expect(result.tokensAfter).toBeLessThanOrEqual(1_000);
		// Compaction is shrink-only: the request never gets bigger.
		expect(result.tokensAfter).toBeLessThanOrEqual(result.tokensBefore);
		const content = String(result.messages[0]?.content ?? "");
		expect(content.startsWith(COMPACTION_NOTICE_PREFIX)).toBe(true);
		expect(content.length).toBeLessThan(20_000);
	});

	it("is a no-op when the transcript already fits the target (estimator drift)", () => {
		const messages: ClineSdkPersistedMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		];

		const result = compactClineConversationMessages(messages, 100_000);

		expect(result.changed).toBe(false);
		expect(result.tokensBefore).toBe(result.tokensAfter);
		expect(result.messages.map((message) => String(message.content))).toEqual(["hello", "hi"]);
	});

	it("is a no-op on an empty transcript", () => {
		expect(compactClineConversationMessages([], 1_000)).toEqual({
			messages: [],
			changed: false,
			tokensBefore: 0,
			tokensAfter: 0,
		});
	});

	it("drops a tool_use turn together with its tool_result and records it in the notice", () => {
		const messages: ClineSdkPersistedMessage[] = [
			{ role: "user", content: "Build the board" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Checking" },
					{ type: "tool_use", id: "t1", name: "read_file", input: { path: "/repo/board.ts" } },
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t1", content: "file body ".repeat(400) },
					{ type: "text", text: "old note" },
				],
			},
			{ role: "assistant", content: "Done" },
			{ role: "user", content: "Follow up" },
		];

		const result = compactClineConversationMessages(messages, 1_000);

		expect(result.changed).toBe(true);
		// The whole turn (tool_use and its tool_result message) is removed as
		// a unit, so no orphaned tool_result can reach the provider.
		expect(orphanToolResultIds(result.messages)).toEqual([]);
		const serialized = JSON.stringify(result.messages);
		expect(serialized).not.toContain('"id":"t1"');
		expect(serialized).not.toContain('"tool_use_id":"t1"');
		// The notice tells the model what the dropped turn did.
		const first = String(result.messages[0]?.content);
		expect(first.startsWith(COMPACTION_NOTICE_PREFIX)).toBe(true);
		expect(first).toContain("read_file(/repo/board.ts)");
		expect(result.messages.at(-1)?.content).toBe("Follow up");
	});

	it("drops a tool_result left orphaned by an interleaved user message", () => {
		const messages: ClineSdkPersistedMessage[] = [
			{ role: "user", content: "Requirements" },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }] },
			{ role: "user", content: "steer ".repeat(200) },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t1", content: "body" },
					{ type: "text", text: "late note" },
				],
			},
			{ role: "assistant", content: "ok" },
		];

		const result = compactClineConversationMessages(messages, 80);

		expect(result.changed).toBe(true);
		expect(orphanToolResultIds(result.messages)).toEqual([]);
		expect(JSON.stringify(result.messages)).not.toContain('"id":"t1"');
	});

	it("keeps paired tool_use/tool_result blocks intact when their messages survive", () => {
		const messages: ClineSdkPersistedMessage[] = [
			{ role: "user", content: "Requirements" },
			{ role: "user", content: "old ".repeat(100) },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "write_file", input: { path: "notes.txt" } }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "written" }] },
		];

		const result = compactClineConversationMessages(messages, 60);

		// The oversized old user message is deleted; the most recent
		// tool_use/tool_result pair survives verbatim and stays paired.
		expect(result.changed).toBe(true);
		const serialized = JSON.stringify(result.messages);
		expect(serialized).toContain('"id":"t1"');
		expect(serialized).toContain('"tool_use_id":"t1"');
		expect(serialized).not.toContain("old ".repeat(50));
		expect(orphanToolResultIds(result.messages)).toEqual([]);
	});
});
describe("B-3.5 unresolved tool calls (pure)", () => {
	it("reports tool_use blocks without a matching tool_result", () => {
		const messages: ClineSdkPersistedMessage[] = [
			{ role: "user", content: "Requirements" },
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "done", name: "read_files", input: {} },
					{ type: "tool_use", id: "pending", name: "run_commands", input: {} },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "done", content: "ok" }] },
		];
		expect(findClineUnresolvedToolCalls(messages)).toEqual([{ id: "pending", name: "run_commands" }]);
		expect(findClineUnresolvedToolCalls(messages.slice(0, 1))).toEqual([]);
	});
});

describe("B-3.4/B-3.7 recovery budget verdicts (pure)", () => {
	describe("evaluateClineRecoveryRequirements (B-3.4)", () => {
		it("skips the check when the transcript carries no user message", () => {
			const verdict = evaluateClineRecoveryRequirements({
				messages: [{ role: "assistant", content: "no requirements here" }],
				targetTokens: 256,
			});
			expect(verdict.checked).toBe(false);
			expect(verdict.fits).toBe(true);
			expect(verdict.reason).toBeNull();
		});

		it("passes when the original requirements fit the compaction target", () => {
			const verdict = evaluateClineRecoveryRequirements({
				messages: [{ role: "user", content: "small requirements" }],
				targetTokens: 1_000,
			});
			expect(verdict.checked).toBe(true);
			expect(verdict.fits).toBe(true);
			expect(verdict.reason).toBeNull();
		});

		it("fails with an actionable reason when the requirements exceed the target", () => {
			const verdict = evaluateClineRecoveryRequirements({
				messages: [{ role: "user", content: "r".repeat(5_000) }],
				targetTokens: 256,
			});
			expect(verdict.checked).toBe(true);
			expect(verdict.fits).toBe(false);
			expect(verdict.firstUserMessageTokens).toBe(1_250);
			expect(verdict.targetTokens).toBe(256);
			expect(verdict.reason).toContain("cannot preserve the original task requirements");
			expect(verdict.reason).toContain("compaction target is 256 tokens");
			expect(verdict.reason).toContain("recovery will not silently truncate the original requirements");
		});
	});

	describe("evaluateClineContextRecoveryBudget (B-3.7)", () => {
		it("skips the check when no context window is known", () => {
			const verdict = evaluateClineContextRecoveryBudget({ prompt: "hi" });
			expect(verdict.checked).toBe(false);
			expect(verdict.fits).toBe(true);
			expect(verdict.reason).toBeNull();
		});

		it("passes when the pinned material fits the effective input budget", () => {
			const verdict = evaluateClineContextRecoveryBudget({
				contextWindowTokens: 100_000,
				reserveTokens: 1_000,
				systemPrompt: "test system prompt",
				prompt: "hi",
			});
			expect(verdict.checked).toBe(true);
			expect(verdict.fits).toBe(true);
			// margin = max(4096, 100000 * 0.1) = 10000 → 100000 - 1000 - 10000.
			expect(verdict.inputBudgetTokens).toBe(89_000);
			expect(verdict.reason).toBeNull();
		});

		it("fails with an actionable reason when the pinned material exceeds the budget", () => {
			const verdict = evaluateClineContextRecoveryBudget({
				contextWindowTokens: 8_192,
				reserveTokens: 4_096,
				systemPrompt: "test system prompt",
				prompt: "p".repeat(40_000),
			});
			expect(verdict.checked).toBe(true);
			expect(verdict.fits).toBe(false);
			// margin = max(4096, 819) = 4096 → 8192 - 4096 - 4096 = 0.
			expect(verdict.inputBudgetTokens).toBe(0);
			expect(verdict.pinnedRequestTokens).toBe(10_005);
			expect(verdict.reason).toContain("cannot fit this turn");
			expect(verdict.reason).toContain("~10005 tokens");
			expect(verdict.reason).toContain("effective input budget is 0 tokens");
			expect(verdict.reason).toContain("(window 8192, output reserve 4096, safety margin 4096)");
			expect(verdict.reason).toContain("removing conversation history cannot make this turn fit");
		});

		it("honors a user-set safety margin over the computed default", () => {
			const verdict = evaluateClineContextRecoveryBudget({
				contextWindowTokens: 10_000,
				reserveTokens: 0,
				safetyMarginTokens: 9_000,
				systemPrompt: "",
				prompt: "p".repeat(5_000),
			});
			expect(verdict.fits).toBe(false);
			expect(verdict.inputBudgetTokens).toBe(1_000);
			expect(verdict.pinnedRequestTokens).toBe(1_250);
		});
	});
});
describe("context overflow recovery through the task session service (B-3)", () => {
	/**
	 * The 8192/1024 compaction config calibrates to a 1770-token trigger
	 * (window 6890 after system prompt + built-in tool schemas, reserve
	 * 1024 + computed margin 4096), and the effective input budget is
	 * 3072 tokens — enough for these tests' small prompts.
	 */
	const SMALL_COMPACTION = { contextWindowTokens: 8_192, reserveTokens: 1_024 };

	/**
	 * Four seeded transcript messages (~16.5k tokens) that force recovery
	 * compaction at the 1770-token trigger. The first user message stays
	 * under the trigger (750 tokens) so the B-3.4 requirements check passes.
	 */
	function oversizedSeedMessages(): ClineSdkPersistedMessage[] {
		return [
			{ role: "user", content: "s".repeat(3_000) },
			{ role: "assistant", content: "a".repeat(30_000) },
			{ role: "user", content: "q".repeat(3_000) },
			{ role: "assistant", content: "b".repeat(30_000) },
		];
	}

	async function startFirstTurn(
		harness: TaskSessionServiceHarness,
		taskId: string,
		extra: {
			prompt?: string;
			initialMessages?: ClineSdkPersistedMessage[];
			compaction?: { contextWindowTokens: number; reserveTokens: number };
			compactionSafetyMarginTokens?: number;
		} = {},
	): Promise<void> {
		await harness.service.startTaskSession({
			taskId,
			cwd: "/tmp/worktree",
			prompt: extra.prompt ?? "First turn prompt",
			systemPrompt: "test system prompt",
			initialMessages: extra.initialMessages,
			compaction: extra.compaction,
			compactionSafetyMarginTokens: extra.compactionSafetyMarginTokens,
		});
		await vi.waitFor(() => {
			expect(harness.host.sentPrompts.length).toBe(1);
		});
	}

	/** Serialized size of a persisted transcript — the fake host's request-size proxy. */
	function transcriptChars(messages: ClineSdkPersistedMessage[]): number {
		return messages.reduce(
			(sum, message) =>
				sum +
				(typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length),
			0,
		);
	}

	function deferred(): { promise: Promise<void>; resolve: () => void } {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	it("recovers a follow-up overflow by compacting the persisted transcript (OpenAI shape)", async () => {
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
		const taskId = "task-b3-recover";

		await startFirstTurn(harness, taskId, {
			initialMessages: oversizedSeedMessages(),
			compaction: SMALL_COMPACTION,
		});
		await service.sendTaskSessionInput(taskId, "Follow up prompt");
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBe(3);
		});

		// One initial start + one recovery restart; the failed follow-up was
		// resent exactly once and the first-turn prompt was never replayed.
		expect(host.startedConfigs.length).toBe(2);
		expect(host.sentPrompts.map((entry) => entry.prompt)).toEqual([
			"First turn prompt",
			"Follow up prompt",
			"Follow up prompt",
		]);

		// B-3.2: the restarted session carries the compacted transcript —
		// strictly smaller than the failed original request, with the
		// compaction notice on the first surviving message and the original
		// requirements (first user message) preserved.
		const originalId = host.startedConfigs[0]?.sessionId ?? "";
		const restartedId = host.startedConfigs[1]?.sessionId ?? "";
		expect(transcriptChars(store.messagesFor(originalId))).toBeGreaterThan(
			transcriptChars(store.messagesFor(restartedId)),
		);
		const restarted = store.messagesFor(restartedId);
		expect(restarted.length).toBeGreaterThan(0);
		const firstContent = String(restarted[0]?.content ?? "");
		expect(firstContent.startsWith(COMPACTION_NOTICE_PREFIX)).toBe(true);
		expect(firstContent).toContain("s".repeat(100));

		expect(service.getSummary(taskId)?.reviewReason).not.toBe("error");
		// Recovery must not destroy workspace state: no turn checkpoint ref
		// is deleted on the recovery path.
		expect(turnCheckpointMocks.deleteTaskTurnCheckpointRef).not.toHaveBeenCalled();
	});

	it("recovers the llama.cpp overflow shape from upstream issue #504", async () => {
		const harness = createTaskSessionServiceHarness({
			onTurn: (context) => {
				if (context.turnCount === 2) {
					throw new Error(LLAMA_CPP_OVERFLOW_ERROR);
				}
				return `reply ${context.turnCount}`;
			},
		});
		services.push(harness);
		const { service, host, store } = harness;
		const taskId = "task-b3-llamacpp";

		await startFirstTurn(harness, taskId, { compaction: SMALL_COMPACTION });
		await service.sendTaskSessionInput(taskId, "Follow up prompt");
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBe(3);
		});

		// The B-1 baseline missed this shape entirely; B-3.1 classifies it,
		// so the follow-up is resent on a fresh session instead of failing.
		// The transcript is small enough that compaction is a no-op and the
		// history (no notice) carries over intact.
		expect(host.startedConfigs.length).toBe(2);
		expect(host.sentPrompts.at(-1)?.prompt).toBe("Follow up prompt");
		const restarted = store.messagesFor(host.startedConfigs[1]?.sessionId ?? "");
		expect(String(restarted[0]?.content ?? "")).toBe("First turn prompt");
		expect(service.getSummary(taskId)?.reviewReason).not.toBe("error");
	});
	it("bounds repeated overflow at the default 3 attempts with an actionable failure (B-3.5)", async () => {
		const harness = createTaskSessionServiceHarness({
			onTurn: (context) => {
				if (context.turnCount >= 2) {
					throw new Error(LLAMA_CPP_OVERFLOW_ERROR);
				}
				return `reply ${context.turnCount}`;
			},
		});
		services.push(harness);
		const { service, host, store } = harness;
		const taskId = "task-b3-bounded";

		await startFirstTurn(harness, taskId, {
			initialMessages: oversizedSeedMessages(),
			compaction: SMALL_COMPACTION,
		});
		await service.sendTaskSessionInput(taskId, "Follow up prompt");
		await vi.waitFor(() => {
			expect(service.getSummary(taskId)?.reviewReason).toBe("error");
		});

		// Default cap of 3: one initial start + exactly 3 recovery restarts,
		// one resend per attempt — never an unbounded retry loop.
		expect(host.startedConfigs.length).toBe(4);
		expect(host.sentPrompts.length).toBe(5);
		expect(host.sentPrompts.slice(1).map((entry) => entry.prompt)).toEqual([
			"Follow up prompt",
			"Follow up prompt",
			"Follow up prompt",
			"Follow up prompt",
		]);
		expect(service.getSummary(taskId)?.warningMessage).toBe(
			"Context overflow recovery failed after 3 attempts: the conversation still exceeds the context window after compaction. Reduce the conversation or task size, or use a model with a larger context window.",
		);

		// The first recovery restart's request is strictly smaller than the
		// failed original, and compaction is shrink-only: every later
		// transcript is at most the previous one plus the resent prompt
		// (the fake host persists each failed resend before the next attempt
		// re-reads the transcript).
		const chars = host.startedConfigs.map((config) => transcriptChars(store.messagesFor(config.sessionId ?? "")));
		expect(chars[1]).toBeLessThan(chars[0]);
		for (let k = 1; k < chars.length; k += 1) {
			expect(chars[k]).toBeLessThanOrEqual(chars[k - 1] + "Follow up prompt".length);
		}
	});

	it("honors a custom contextRecoveryMaxAttempts of 1 with the singular failure message", async () => {
		const harness = createTaskSessionServiceHarness({
			contextRecoveryMaxAttempts: 1,
			onTurn: (context) => {
				if (context.turnCount >= 2) {
					throw new Error(OPENAI_OVERFLOW_ERROR);
				}
				return `reply ${context.turnCount}`;
			},
		});
		services.push(harness);
		const { service, host } = harness;
		const taskId = "task-b3-one-attempt";

		await startFirstTurn(harness, taskId, { compaction: SMALL_COMPACTION });
		await service.sendTaskSessionInput(taskId, "Follow up prompt");
		await vi.waitFor(() => {
			expect(service.getSummary(taskId)?.reviewReason).toBe("error");
		});

		expect(host.startedConfigs.length).toBe(2);
		expect(host.sentPrompts.length).toBe(3);
		expect(service.getSummary(taskId)?.warningMessage).toBe(
			"Context overflow recovery failed after 1 attempt: the conversation still exceeds the context window after compaction. Reduce the conversation or task size, or use a model with a larger context window.",
		);
	});

	it("surfaces a non-overflow provider error immediately without recovery", async () => {
		const harness = createTaskSessionServiceHarness({
			onTurn: (context) => {
				if (context.turnCount === 2) {
					throw new Error("provider returned 500: internal error");
				}
				return `reply ${context.turnCount}`;
			},
		});
		services.push(harness);
		const { service, host } = harness;
		const taskId = "task-b3-non-overflow";

		await startFirstTurn(harness, taskId, { compaction: SMALL_COMPACTION });
		await service.sendTaskSessionInput(taskId, "Follow up prompt");
		await vi.waitFor(() => {
			expect(service.getSummary(taskId)?.reviewReason).toBe("error");
		});

		// Not classified as overflow (B-3.1): no restart, no resend, and the
		// original provider error — not a recovery message — is surfaced.
		expect(host.startedConfigs.length).toBe(1);
		expect(host.sentPrompts.length).toBe(2);
		expect(service.getSummary(taskId)?.warningMessage).toContain("provider returned 500: internal error");
	});

	it("surfaces a non-overflow failure during a recovery attempt without another retry", async () => {
		const harness = createTaskSessionServiceHarness({
			onTurn: (context) => {
				if (context.turnCount === 2) {
					throw new Error(OPENAI_OVERFLOW_ERROR);
				}
				if (context.turnCount === 3) {
					throw new Error("provider connection reset while streaming");
				}
				return `reply ${context.turnCount}`;
			},
		});
		services.push(harness);
		const { service, host } = harness;
		const taskId = "task-b3-recovery-failure";

		await startFirstTurn(harness, taskId, { compaction: SMALL_COMPACTION });
		await service.sendTaskSessionInput(taskId, "Follow up prompt");
		await vi.waitFor(() => {
			expect(service.getSummary(taskId)?.reviewReason).toBe("error");
		});

		// Exactly one recovery restart happened; the non-overflow failure
		// during the restarted turn surfaced immediately instead of burning
		// another bounded attempt.
		expect(host.startedConfigs.length).toBe(2);
		expect(host.sentPrompts.length).toBe(3);
		expect(service.getSummary(taskId)?.warningMessage).toContain("provider connection reset while streaming");
	});
	it("does not revive a canceled turn that overflows (B-3.6)", async () => {
		const overflowGate = deferred();
		const harness = createTaskSessionServiceHarness({
			onTurn: async (context) => {
				if (context.turnCount === 1) {
					return "reply 1";
				}
				// Hold the overflowing turn in flight so the test can cancel
				// it before the provider error surfaces.
				await overflowGate.promise;
				throw new Error(LLAMA_CPP_OVERFLOW_ERROR);
			},
		});
		services.push(harness);
		const { service, host } = harness;
		const taskId = "task-b3-canceled";

		await startFirstTurn(harness, taskId, { compaction: SMALL_COMPACTION });
		await service.sendTaskSessionInput(taskId, "Follow up prompt");
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBe(2);
		});

		const canceled = await service.cancelTaskTurn(taskId);
		expect(canceled?.state).toBe("idle");

		overflowGate.resolve();
		await vi.waitFor(() => {
			expect(service.getSummary(taskId)?.reviewReason).toBe("error");
		});

		// The overflow is still reported (the turn did fail), but recovery
		// was skipped: no restart, no resend — a canceled turn is never
		// revived.
		expect(host.startedConfigs.length).toBe(1);
		expect(host.sentPrompts.length).toBe(2);
		expect(service.getSummary(taskId)?.warningMessage).toContain("exceeds the available context size");
	});

	it("pauses with an actionable reason when the original requirements exceed the compaction target (B-3.4)", async () => {
		// 4000 chars = 1000 tokens of original requirements, above the
		// calibrated 256-token trigger below.
		const requirements = "Requirement line ".repeat(250);
		const harness = createTaskSessionServiceHarness({
			onTurn: (context) => {
				if (context.turnCount === 2) {
					throw new Error(OPENAI_OVERFLOW_ERROR);
				}
				return `reply ${context.turnCount}`;
			},
		});
		services.push(harness);
		const { service, host } = harness;
		const taskId = "task-b3-requirements";

		// Calibrated trigger = 256 tokens: window 65536, user margin 60000,
		// reserve capped at window-256 (the floor keeps the trigger at 256).
		await startFirstTurn(harness, taskId, {
			prompt: requirements,
			compaction: { contextWindowTokens: 65_536, reserveTokens: 4_096 },
			compactionSafetyMarginTokens: 60_000,
		});
		await service.sendTaskSessionInput(taskId, "Follow up prompt");
		await vi.waitFor(() => {
			expect(service.getSummary(taskId)?.reviewReason).toBe("error");
		});

		// Recovery must not silently truncate the original requirements: it
		// pauses before restarting, with the specific actionable reason.
		expect(host.startedConfigs.length).toBe(1);
		expect(host.sentPrompts.length).toBe(2);
		expect(service.getSummary(taskId)?.warningMessage).toContain(
			"Context overflow recovery cannot preserve the original task requirements",
		);
		expect(service.getSummary(taskId)?.warningMessage).toContain("compaction target is 256 tokens");
		expect(service.getSummary(taskId)?.warningMessage).toContain(
			"recovery will not silently truncate the original requirements",
		);
	});

	it("pauses with an actionable reason when the pinned restart material exceeds the input budget (B-3.7)", async () => {
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
		const taskId = "task-b3-pinned";

		// Effective input budget = 16384 - 4096 (reserve) - 4096 (margin)
		// = 8192 tokens.
		await startFirstTurn(harness, taskId, {
			compaction: { contextWindowTokens: 16_384, reserveTokens: 4_096 },
		});
		// 40_000 chars = 10_000 tokens of prompt, plus the system prompt:
		// no amount of history compaction can fit this turn.
		await service.sendTaskSessionInput(taskId, "p".repeat(40_000));
		await vi.waitFor(() => {
			expect(service.getSummary(taskId)?.reviewReason).toBe("error");
		});

		// The budget pause fires BEFORE any bounded attempt is burned.
		expect(host.startedConfigs.length).toBe(1);
		expect(host.sentPrompts.length).toBe(2);
		expect(service.getSummary(taskId)?.warningMessage).toContain("Context overflow recovery cannot fit this turn");
		expect(service.getSummary(taskId)?.warningMessage).toContain("~10005 tokens");
		expect(service.getSummary(taskId)?.warningMessage).toContain("effective input budget is 8192 tokens");
		expect(service.getSummary(taskId)?.warningMessage).toContain(
			"removing conversation history cannot make this turn fit",
		);
	});

	it("characterization: an oversized first turn is not retried on the start path", async () => {
		const harness = createTaskSessionServiceHarness({
			onTurn: () => {
				throw new Error(OPENAI_OVERFLOW_ERROR);
			},
		});
		services.push(harness);
		const { service, host } = harness;
		const taskId = "task-b3-start-path";

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
	it("surfaces an actionable error without blind retries when the context window is unknown", async () => {
		const harness = createTaskSessionServiceHarness({
			onTurn: (context) => {
				if (context.turnCount >= 2) {
					throw new Error(OPENAI_OVERFLOW_ERROR);
				}
				return `reply ${context.turnCount}`;
			},
		});
		services.push(harness);
		const { service, host } = harness;
		const taskId = "task-b3-unknown-window";

		// No compaction config: there is no target to compact to.
		await startFirstTurn(harness, taskId);
		await service.sendTaskSessionInput(taskId, "Follow up prompt");
		await vi.waitFor(() => {
			expect(service.getSummary(taskId)?.reviewReason).toBe("error");
		});

		expect(host.startedConfigs.length).toBe(1);
		expect(service.getSummary(taskId)?.warningMessage).toContain("context window is unknown");
	});

	it("compacts on overflow after a Kanban process restart using the reconstructed session config", async () => {
		const first = createTaskSessionServiceHarness();
		services.push(first);
		const taskId = "task-b3-after-restart";
		await startFirstTurn(first, taskId, {
			initialMessages: oversizedSeedMessages(),
			compaction: SMALL_COMPACTION,
		});
		await first.service.stopTaskSession(taskId);
		await first.service.dispose();
		services.splice(services.indexOf(first), 1);

		// The restarted process has no in-memory start request; the launch
		// policy (context window + compaction) is re-resolved live (B-2.8).
		const after = createTaskSessionServiceHarness({
			store: first.store,
			resolveClineLaunchConfig: async () => ({
				providerId: "cline",
				modelId: "test-model",
				apiKey: null,
				baseUrl: null,
				contextWindowTokens: SMALL_COMPACTION.contextWindowTokens,
				contextWindowSource: "provider-metadata",
				maxTokens: SMALL_COMPACTION.reserveTokens,
			}),
		});
		services.push(after);
		let overflowed = false;
		after.store.onTurn = (context) => {
			if (!overflowed) {
				overflowed = true;
				throw new Error(OPENAI_OVERFLOW_ERROR);
			}
			return `reply ${context.turnCount}`;
		};

		await after.service.reloadTaskSession(taskId);
		await after.service.sendTaskSessionInput(taskId, "Follow up after restart");
		await vi.waitFor(() => {
			expect(after.host.sentPrompts.filter((entry) => entry.prompt === "Follow up after restart").length).toBe(2);
		});

		const restartedId = after.host.startedConfigs.at(-1)?.sessionId ?? "";
		const restarted = after.store.messagesFor(restartedId);
		expect(String(restarted[0]?.content ?? "").startsWith(COMPACTION_NOTICE_PREFIX)).toBe(true);
		expect(after.service.getSummary(taskId)?.reviewReason).not.toBe("error");
	});
	it("pauses instead of resending when a tool call's completion is unknown (B-3.5)", async () => {
		const harness = createTaskSessionServiceHarness({
			onTurn: (context) => {
				if (context.turnCount >= 2) {
					throw new Error(OPENAI_OVERFLOW_ERROR);
				}
				return `reply ${context.turnCount}`;
			},
		});
		services.push(harness);
		const { service, host } = harness;
		const taskId = "task-b3-unresolved-tool";

		await startFirstTurn(harness, taskId, {
			compaction: SMALL_COMPACTION,
			initialMessages: [
				{ role: "user", content: "Requirements" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "t-pending", name: "run_commands", input: { commands: ["make"] } }],
				},
			],
		});
		await service.sendTaskSessionInput(taskId, "Follow up prompt");
		await vi.waitFor(() => {
			expect(service.getSummary(taskId)?.reviewReason).toBe("error");
		});

		expect(host.startedConfigs.length).toBe(1);
		expect(service.getSummary(taskId)?.warningMessage).toContain("no recorded result");
		expect(service.getSummary(taskId)?.warningMessage).toContain("run_commands");
	});
});
