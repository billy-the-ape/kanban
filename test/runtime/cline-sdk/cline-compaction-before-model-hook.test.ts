// B-2.5 — Unit tests for the local-mode beforeModel compaction hook and the
// agent-message compactor it uses.
import { describe, expect, it } from "vitest";
import {
	compactClineAgentMessages,
	createClineCompactionBeforeModelHook,
} from "../../../src/cline-sdk/cline-compaction-before-model-hook";
import { computeClineCompactionSafetyMarginTokens } from "../../../src/cline-sdk/cline-compaction-config";
import { estimateTextTokens } from "../../../src/cline-sdk/cline-context-budget";
import type {
	ClineSdkAgentBeforeModelContext,
	ClineSdkAgentMessage,
	ClineSdkAgentMessagePart,
} from "../../../src/cline-sdk/sdk-runtime-boundary";

let nextId = 0;
function agentMessage(role: ClineSdkAgentMessage["role"], content: ClineSdkAgentMessagePart[]): ClineSdkAgentMessage {
	nextId += 1;
	return { id: `msg-${nextId}`, role, content, createdAt: nextId };
}
function textPart(text: string): ClineSdkAgentMessagePart {
	return { type: "text", text };
}
/** Text part sized at ~`tokens` estimated tokens (chars/4). */
function sizedTextPart(tokens: number): ClineSdkAgentMessagePart {
	return textPart("x".repeat(tokens * 4));
}

function makeRequest(
	messages: ClineSdkAgentMessage[],
	overrides: { systemPrompt?: string; tools?: unknown[] } = {},
): ClineSdkAgentBeforeModelContext {
	const context = {
		snapshot: {
			agentId: "agent",
			status: "running",
			iteration: 1,
			messages,
			pendingToolCalls: [],
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		},
		request: {
			systemPrompt: overrides.systemPrompt ?? "system prompt",
			messages,
			tools: overrides.tools ?? [],
		},
	} as unknown as ClineSdkAgentBeforeModelContext;
	return context;
}

describe("B-2.5 — compactClineAgentMessages", () => {
	it("returns empty input unchanged", () => {
		const result = compactClineAgentMessages([], 100);
		expect(result.messages).toEqual([]);
		expect(result.changed).toBe(false);
	});

	it("leaves fitting messages unchanged without a notice", () => {
		const messages = [agentMessage("user", [sizedTextPart(50)]), agentMessage("assistant", [sizedTextPart(50)])];
		const result = compactClineAgentMessages(messages, 200);
		expect(result.changed).toBe(false);
		expect(result.messages).toEqual(messages);
	});

	it("deletes old messages, keeps first and last user message, and prepends a notice", () => {
		const messages: ClineSdkAgentMessage[] = [];
		for (let i = 0; i < 4; i += 1) {
			messages.push(agentMessage("user", [sizedTextPart(100)]));
			messages.push(agentMessage("assistant", [sizedTextPart(100)]));
		}
		const result = compactClineAgentMessages(messages, 300);
		expect(result.changed).toBe(true);
		expect(result.messages.length).toBeLessThan(messages.length);
		const firstPart = result.messages[0]?.content[0];
		expect(firstPart?.type).toBe("text");
		if (firstPart?.type === "text") {
			expect(firstPart.text).toContain("removed to fit the context window");
		}
		// The last user message content is preserved verbatim.
		const lastUser = [...result.messages].reverse().find((m) => m.role === "user");
		expect(lastUser?.content).toEqual(messages[6]?.content);
	});

	it("drops orphan tool-result parts whose tool-call was deleted", () => {
		const messages: ClineSdkAgentMessage[] = [
			agentMessage("user", [sizedTextPart(50)]),
			agentMessage("assistant", [
				{ type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "/a" } },
			]),
			agentMessage("user", [
				{ type: "tool-result", toolCallId: "call-1", toolName: "read_file", output: "contents" },
			]),
			agentMessage("assistant", [textPart("done")]),
			agentMessage("user", [sizedTextPart(50)]),
		];
		const result = compactClineAgentMessages(messages, 60);
		const toolCallIds = new Set(
			result.messages.flatMap((m) => m.content.filter((p) => p.type === "tool-call").map((p) => p.toolCallId)),
		);
		for (const message of result.messages) {
			for (const part of message.content) {
				if (part.type === "tool-result") {
					expect(toolCallIds.has(part.toolCallId)).toBe(true);
				}
			}
		}
	});

	it("deletes tool-call-carrying assistant messages whole; output never contains a sliced tool-call", () => {
		const toolCall: ClineSdkAgentMessagePart = {
			type: "tool-call",
			toolCallId: "call-9",
			toolName: "run_command",
			input: { cmd: "x".repeat(4_000) },
		};
		const messages = [
			agentMessage("user", [sizedTextPart(40)]),
			agentMessage("assistant", [sizedTextPart(1_000), toolCall]),
		];
		const result = compactClineAgentMessages(messages, 100);
		expect(result.changed).toBe(true);
		// The tool-call-carrying assistant is deleted as a whole (deletion
		// precedes truncation), so no partially sliced tool-call can reach
		// the provider.
		const toolCalls = result.messages.flatMap((m) => m.content.filter((p) => p.type === "tool-call"));
		expect(toolCalls).toEqual([]);
		const estimate = (m: ClineSdkAgentMessage) =>
			estimateTextTokens(m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"));
		const total = result.messages.reduce((sum, m) => sum + estimate(m), 0);
		expect(total).toBeLessThanOrEqual(100);
	});
});

describe("B-2.5 — createClineCompactionBeforeModelHook", () => {
	// limit - outputReserve - margin(6_000)=4_096 → request budget of 1_404,
	// well above the 256 message-target floor but far below the 3_200-token
	// conversation below.
	const limit = 6_000;
	const outputReserve = 500;
	const hook = createClineCompactionBeforeModelHook({ limitTokens: limit, outputReserveTokens: outputReserve });
	const requestBudget = limit - outputReserve - computeClineCompactionSafetyMarginTokens(limit);

	it("returns undefined when the assembled request fits the budget", async () => {
		const messages = [agentMessage("user", [sizedTextPart(200)])];
		const context = makeRequest(messages, { systemPrompt: "tiny", tools: [] });
		expect(await hook(context)).toBeUndefined();
	});

	it("rewrites oversized requests back under the calibrated budget", async () => {
		const messages: ClineSdkAgentMessage[] = [];
		for (let i = 0; i < 8; i += 1) {
			messages.push(agentMessage("user", [sizedTextPart(200)]));
			messages.push(agentMessage("assistant", [sizedTextPart(200)]));
		}
		const context = makeRequest(messages, { systemPrompt: "system", tools: [] });
		const result = await hook(context);
		expect(result).toBeDefined();
		const rewritten = result?.messages;
		expect(rewritten?.length).toBeLessThan(messages.length);
		// Rewritten messages fit the request budget (system + tools are
		// negligible here, and the hook subtracts them anyway).
		const estimate = (m: ClineSdkAgentMessage) =>
			estimateTextTokens(m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"));
		const total = (rewritten ?? []).reduce((sum, m) => sum + estimate(m), 0);
		expect(total).toBeLessThanOrEqual(requestBudget);
		// The compaction notice was prepended to the surviving first message.
		const firstPart = rewritten?.[0]?.content[0];
		expect(firstPart?.type).toBe("text");
		if (firstPart?.type === "text") {
			expect(firstPart.text).toContain("removed to fit the context window");
		}
		// The original array is not mutated.
		expect(messages.length).toBe(16);
	});

	it("returns undefined for empty request messages", async () => {
		const context = makeRequest([], { systemPrompt: "s", tools: [] });
		expect(await hook(context)).toBeUndefined();
	});
});
