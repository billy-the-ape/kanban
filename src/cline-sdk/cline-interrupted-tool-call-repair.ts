// Request-scoped repair for tool calls interrupted before their result was
// recorded.
//
// When a run is aborted (stop, crash, Kanban restart) while a tool is
// executing, the persisted transcript keeps the assistant's `tool-call` part
// but never gets the matching `tool-result`. The AI SDK rejects any request
// whose history contains such a call ("Tool result is missing for tool call
// <id>." — AI_MissingToolResultsError), so every later follow-up or resume
// fails the same way and the task can never continue.
//
// The beforeModel hook built here inserts a synthetic error `tool-result`
// for each dangling call, directly after the assistant message (and any tool
// messages) that issued it. Like the compaction hook, the rewrite is
// request-scoped: the persisted transcript is left untouched, and the repair
// is deterministic, so every later request rebuilds the same history. The
// synthetic result tells the model the outcome is unknown instead of
// claiming success or failure, consistent with B-3.5 (never assume whether
// an interrupted tool ran).

import type {
	ClineSdkAgentBeforeModelContext,
	ClineSdkAgentBeforeModelHook,
	ClineSdkAgentBeforeModelResult,
	ClineSdkAgentMessage,
	ClineSdkAgentMessagePart,
	ClineSdkBasicLogger,
} from "./sdk-runtime-boundary";

export const INTERRUPTED_TOOL_CALL_RESULT =
	"This tool call was interrupted before its result was recorded, so it is unknown whether it ran or what it changed. " +
	"Verify its effects (files, processes, git state) before relying on it or running it again.";

export interface RepairInterruptedToolCallsResult {
	messages: ClineSdkAgentMessage[];
	repairedToolCallIds: string[];
}

function collectResolvedToolCallIds(messages: readonly ClineSdkAgentMessage[]): Set<string> {
	const resolved = new Set<string>();
	for (const message of messages) {
		for (const part of message.content) {
			if (part.type === "tool-result") {
				resolved.add(part.toolCallId);
			}
		}
	}
	return resolved;
}

function buildInterruptedToolResultMessage(
	source: ClineSdkAgentMessage,
	calls: readonly Extract<ClineSdkAgentMessagePart, { type: "tool-call" }>[],
): ClineSdkAgentMessage {
	return {
		id: `${source.id}-interrupted-tool-results`,
		role: "tool",
		createdAt: source.createdAt,
		content: calls.map((call) => ({
			type: "tool-result",
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			output: INTERRUPTED_TOOL_CALL_RESULT,
			isError: true,
		})),
	};
}

/**
 * Returns the messages with a synthetic error result for every tool call
 * that has no recorded result. Pure; `repairedToolCallIds` is empty when
 * nothing needed repair.
 */
export function repairInterruptedToolCalls(
	messages: readonly ClineSdkAgentMessage[],
): RepairInterruptedToolCallsResult {
	const resolved = collectResolvedToolCallIds(messages);
	const repaired: ClineSdkAgentMessage[] = [];
	const repairedToolCallIds: string[] = [];
	let index = 0;
	while (index < messages.length) {
		const message = messages[index];
		index += 1;
		if (!message) {
			continue;
		}
		repaired.push(message);
		if (message.role !== "assistant") {
			continue;
		}
		const dangling = message.content.flatMap((part) =>
			part.type === "tool-call" && !resolved.has(part.toolCallId) ? [part] : [],
		);
		if (dangling.length === 0) {
			continue;
		}
		// Keep the results that were recorded for this turn ahead of the
		// synthetic ones so the assistant/tool pairing stays contiguous.
		let next = messages[index];
		while (next?.role === "tool") {
			repaired.push(next);
			index += 1;
			next = messages[index];
		}
		repaired.push(buildInterruptedToolResultMessage(message, dangling));
		for (const call of dangling) {
			resolved.add(call.toolCallId);
			repairedToolCallIds.push(call.toolCallId);
		}
	}
	return { messages: repaired, repairedToolCallIds };
}

/**
 * Creates the beforeModel hook that repairs interrupted tool calls in the
 * assembled request. Returns undefined (no rewrite) when every call has a
 * result.
 */
export function createClineInterruptedToolCallRepairHook(
	input: { logger?: ClineSdkBasicLogger } = {},
): ClineSdkAgentBeforeModelHook {
	return function repairInterruptedToolCallsInRequest(
		context: ClineSdkAgentBeforeModelContext,
	): ClineSdkAgentBeforeModelResult | undefined {
		const messages = context.request.messages;
		if (!messages || messages.length === 0) {
			return undefined;
		}
		const result = repairInterruptedToolCalls(messages);
		if (result.repairedToolCallIds.length === 0) {
			return undefined;
		}
		input.logger?.log("Kanban repaired interrupted tool calls in model request", {
			repairedToolCallIds: result.repairedToolCallIds,
		});
		return { messages: result.messages };
	};
}
