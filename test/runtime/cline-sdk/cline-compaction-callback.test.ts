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

	it("drops whole old turns oldest-first, keeps the first prompt, latest instruction, and latest turn, and adds a notice", () => {
		const messages: ClineSdkPersistedMessage[] = [
			textMessage("user", 100),
			textMessage("assistant", 100),
			textMessage("user", 100),
			textMessage("assistant", 100),
			textMessage("user", 100),
			{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_files", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "x".repeat(400) }] },
		];
		const result = compactClineConversationMessages(messages, 400);
		expect(result.changed).toBe(true);
		expect(result.tokensAfter).toBeLessThanOrEqual(400);
		// First user message survives with the notice prepended.
		const first = result.messages[0];
		expect(first?.role).toBe("user");
		expect(typeof first?.content).toBe("string");
		expect(first?.content).toContain("removed to fit the context window");
		expect(String(first?.content).endsWith(String(messages[0]?.content))).toBe(true);
		// The most recent user instruction and the latest turn survive verbatim.
		expect(result.messages.slice(1)).toEqual(messages.slice(4));
	});

	it("merges an earlier persisted notice instead of nesting a second one", () => {
		const turn = (id: string, path: string): ClineSdkPersistedMessage[] => [
			{ role: "assistant", content: [{ type: "tool_use", id, name: "editor", input: { command: "create", path } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(4_000) }] },
		];
		const messages: ClineSdkPersistedMessage[] = [textMessage("user", 50)];
		for (let i = 0; i < 12; i += 1) {
			messages.push(...turn(`c${i}`, `/repo/f${i}.ts`));
		}
		const once = compactClineConversationMessages(messages, 10_000);
		for (let i = 12; i < 20; i += 1) {
			once.messages.push(...turn(`c${i}`, `/repo/f${i}.ts`));
		}
		const twice = compactClineConversationMessages(once.messages, 10_000);
		const content = String(twice.messages[0]?.content);
		expect(content.split("[Earlier conversation turns").length).toBe(2);
		// Actions from both compactions appear once each, oldest first.
		expect(content).toContain("editor(create /repo/f0.ts)");
		// The oldest turn kept by the first compaction is dropped by the second
		// and appended after the carried-over lines.
		const firstKeptOnce = once.messages
			.flatMap((m) => (typeof m.content === "string" ? [] : m.content))
			.find((b) => b.type === "tool_use");
		const firstKeptPath = `/repo/f${firstKeptOnce?.type === "tool_use" ? firstKeptOnce.id.slice(1) : ""}.ts`;
		expect(content.indexOf("/repo/f0.ts")).toBeGreaterThan(-1);
		expect(content.indexOf(firstKeptPath)).toBeGreaterThan(content.indexOf("/repo/f0.ts"));
		expect(content.split("/repo/f0.ts").length).toBe(2);
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
