import { describe, expect, it } from "vitest";
import {
	createClineInterruptedToolCallRepairHook,
	INTERRUPTED_TOOL_CALL_RESULT,
	repairInterruptedToolCalls,
} from "../../../src/cline-sdk/cline-interrupted-tool-call-repair";
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
function text(value: string): ClineSdkAgentMessagePart {
	return { type: "text", text: value };
}
function toolCall(toolCallId: string): ClineSdkAgentMessagePart {
	return { type: "tool-call", toolCallId, toolName: "run_commands", input: { commands: ["ls"] } };
}
function toolResult(toolCallId: string): ClineSdkAgentMessagePart {
	return { type: "tool-result", toolCallId, toolName: "run_commands", output: "ok" };
}
function makeContext(messages: ClineSdkAgentMessage[]): ClineSdkAgentBeforeModelContext {
	return {
		snapshot: { agentId: "agent", status: "running", iteration: 1, messages, pendingToolCalls: [] },
		request: { systemPrompt: "system", messages, tools: [] },
	} as unknown as ClineSdkAgentBeforeModelContext;
}

describe("repairInterruptedToolCalls", () => {
	it("leaves a well-formed history unchanged", () => {
		const messages = [
			agentMessage("user", [text("task")]),
			agentMessage("assistant", [toolCall("a")]),
			agentMessage("tool", [toolResult("a")]),
			agentMessage("assistant", [text("done")]),
		];
		const result = repairInterruptedToolCalls(messages);
		expect(result.repairedToolCallIds).toEqual([]);
		expect(result.messages).toEqual(messages);
	});

	it("inserts a synthetic error result right after an interrupted call, before later user messages", () => {
		const user = agentMessage("user", [text("task")]);
		const interrupted = agentMessage("assistant", [text("Run tests"), toolCall("dangling")]);
		const resume = agentMessage("user", [text("Resume")]);
		const result = repairInterruptedToolCalls([user, interrupted, resume, agentMessage("user", [text("Resume")])]);

		expect(result.repairedToolCallIds).toEqual(["dangling"]);
		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user", "user"]);
		expect(result.messages[2]?.content).toEqual([
			{
				type: "tool-result",
				toolCallId: "dangling",
				toolName: "run_commands",
				output: INTERRUPTED_TOOL_CALL_RESULT,
				isError: true,
			},
		]);
		expect(result.messages[3]).toBe(resume);
	});

	it("repairs a trailing interrupted call and keeps recorded sibling results first", () => {
		const assistant = agentMessage("assistant", [toolCall("done"), toolCall("lost")]);
		const recorded = agentMessage("tool", [toolResult("done")]);
		const result = repairInterruptedToolCalls([agentMessage("user", [text("task")]), assistant, recorded]);

		expect(result.repairedToolCallIds).toEqual(["lost"]);
		expect(result.messages.slice(1, 3)).toEqual([assistant, recorded]);
		expect(result.messages[3]?.content).toMatchObject([{ type: "tool-result", toolCallId: "lost", isError: true }]);
	});
});

describe("createClineInterruptedToolCallRepairHook", () => {
	it("returns undefined when nothing needs repair", async () => {
		const hook = createClineInterruptedToolCallRepairHook();
		const messages = [agentMessage("user", [text("task")]), agentMessage("assistant", [text("hi")])];
		expect(await hook(makeContext(messages))).toBeUndefined();
	});

	it("rewrites the request messages when a call is interrupted", async () => {
		const hook = createClineInterruptedToolCallRepairHook();
		const messages = [agentMessage("assistant", [toolCall("x")]), agentMessage("user", [text("Resume")])];
		const result = await hook(makeContext(messages));
		expect(result?.messages?.map((message) => message.role)).toEqual(["assistant", "tool", "user"]);
	});
});
