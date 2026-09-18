// B-2.5 — Unit tests for compactClineConversationMessages (the deterministic
// compactor shared by the SDK compact callback) and the callback wrapper.
import { describe, expect, it } from "vitest";
import {
	compactClineConversationMessages,
	createClineCompactionCompactCallback,
} from "../../../src/cline-sdk/cline-compaction-callback";
import { estimateTextTokens } from "../../../src/cline-sdk/cline-context-budget";
import type { ClineSdkCompactionContext, ClineSdkPersistedMessage } from "../../../src/cline-sdk/sdk-runtime-boundary";

/** Builds a message whose estimated token size is ~`tokens` (chars/4). */
function textMessage(role: "user" | "assistant", tokens: number): ClineSdkPersistedMessage {
	return { role, content: "x".repeat(tokens * 4) };
}

function makeContext(messages: ClineSdkPersistedMessage[], triggerTokens = 100, contextWindowTokens = 10_000) {
	const context: ClineSdkCompactionContext = {
		agentId: "agent",
		conversationId: "conversation",
		parentAgentId: null,
		iteration: 1,
		messages,
		model: { id: "model", provider: "openrouter" },
		contextWindowTokens,
		triggerTokens,
		thresholdRatio: 0.5,
		utilizationRatio: 1,
	};
	return context;
}

describe("B-2.5 — compactClineConversationMessages", () => {
	it("returns empty input unchanged", () => {
		const result = compactClineConversationMessages([], 100);
		expect(result.messages).toEqual([]);
		expect(result.changed).toBe(false);
	});

	it("leaves messages alone when they already fit the target", () => {
		const messages = [textMessage("user", 50), textMessage("assistant", 50)];
		const result = compactClineConversationMessages(messages, 200);
		expect(result.changed).toBe(false);
		expect(result.messages).toEqual(messages);
	});

	it("deletes old messages oldest-first, keeps the first and last user message, and adds a notice", () => {
		const messages: ClineSdkPersistedMessage[] = [];
		for (let i = 0; i < 4; i += 1) {
			messages.push(textMessage("user", 100));
			messages.push(textMessage("assistant", 100));
		}
		const result = compactClineConversationMessages(messages, 300);
		expect(result.changed).toBe(true);
		expect(result.messages.length).toBeLessThan(messages.length);
		// First user message survives (with the notice prepended).
		const first = result.messages[0];
		expect(first?.role).toBe("user");
		expect(typeof first?.content).toBe("string");
		expect(first?.content).toContain("removed to fit the context window");
		// Last user message survives.
		const lastUser = [...result.messages].reverse().find((m) => m.role === "user");
		expect(lastUser?.content).toBe(messages[6]?.content);
		// Result fits the target (estimates).
		const estimate = (m: ClineSdkPersistedMessage) => estimateTextTokens(String(m.content));
		const total = result.messages.reduce((sum, m) => sum + estimate(m), 0);
		expect(total).toBeLessThanOrEqual(300);
	});

	it("drops orphan tool_result blocks whose tool_use was deleted", () => {
		const messages: ClineSdkPersistedMessage[] = [
			textMessage("user", 50),
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "/a" } }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents here" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
			},
			textMessage("user", 50),
		];
		const result = compactClineConversationMessages(messages, 60);
		const toolUseIds = new Set(
			result.messages
				.filter((m) => m.role === "assistant" && Array.isArray(m.content))
				.flatMap((m) =>
					(m.content as Array<{ type: string; id?: string }>)
						.filter((b) => b.type === "tool_use")
						.map((b) => b.id),
				),
		);
		const toolResults = result.messages.flatMap((m) =>
			typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result"),
		);
		for (const block of toolResults) {
			expect(toolUseIds.has(block.tool_use_id)).toBe(true);
		}
	});

	it("truncates a single oversized message as a last resort", () => {
		const messages = [textMessage("user", 5_000), textMessage("assistant", 40)];
		const result = compactClineConversationMessages(messages, 200);
		expect(result.changed).toBe(true);
		const estimate = (m: ClineSdkPersistedMessage) => estimateTextTokens(String(m.content));
		const total = result.messages.reduce((sum, m) => sum + estimate(m), 0);
		expect(total).toBeLessThanOrEqual(200);
	});

	it("deletes tool_use-carrying assistant messages whole; output never contains a sliced tool_use", () => {
		const toolUse: { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } = {
			type: "tool_use",
			id: "call-9",
			name: "run_command",
			input: { cmd: "x".repeat(4_000) },
		};
		const messages: ClineSdkPersistedMessage[] = [
			textMessage("user", 40),
			{ role: "assistant", content: [{ type: "text", text: "y".repeat(4_000) }, toolUse] },
		];
		const result = compactClineConversationMessages(messages, 100);
		expect(result.changed).toBe(true);
		// The tool_use-carrying assistant is deleted as a whole (deletion
		// precedes truncation), so no partially sliced tool_use can reach
		// the provider.
		const toolUses = result.messages.flatMap((m) =>
			typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_use"),
		);
		expect(toolUses).toEqual([]);
		const estimate = (m: ClineSdkPersistedMessage) => estimateTextTokens(String(m.content));
		const total = result.messages.reduce((sum, m) => sum + estimate(m), 0);
		expect(total).toBeLessThanOrEqual(100);
	});
});

describe("B-2.5 — createClineCompactionCompactCallback", () => {
	it("always returns a messages array (never undefined)", () => {
		const compact = createClineCompactionCompactCallback();
		const result = compact(makeContext([textMessage("user", 5_000)], 200, 10_000));
		expect(result).toBeDefined();
		expect(Array.isArray(result.messages)).toBe(true);
	});

	it("uses the calibrated trigger as the compaction target", () => {
		const compact = createClineCompactionCompactCallback();
		const messages: ClineSdkPersistedMessage[] = [];
		for (let i = 0; i < 6; i += 1) {
			messages.push(textMessage("user", 100));
			messages.push(textMessage("assistant", 100));
		}
		const result = compact(makeContext(messages, 300, 10_000));
		expect(result.messages.length).toBeLessThan(messages.length);
		const estimate = (m: ClineSdkPersistedMessage) => estimateTextTokens(String(m.content));
		const total = result.messages.reduce((sum, m) => sum + estimate(m), 0);
		expect(total).toBeLessThanOrEqual(300);
	});
});
