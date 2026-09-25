// B-2.5 — Kanban's `compact` callback for the SDK's compaction trigger.
//
// The SDK fires compaction when the estimated apiMessages tokens exceed the
// calibrated trigger (contextWindowTokens - reserveTokens). Since B-2.5 that
// trigger is computed against the calibrated window (limit - system prompt -
// tool schemas, see cline-compaction-config.ts), so it effectively evaluates
// the full assembled request.
//
// Why a Kanban-side callback at all? The built-in "basic" strategy is
// deterministic too, but it is minified SDK-internal code. Registering
// Kanban's own model-free callback (localRuntime.compaction.compact) keeps
// the guard deterministic, unit-testable, and pinned to this codebase. The
// strategy itself is the turn-based compactor in cline-compaction-turns.ts
// (drop whole turns oldest-first, summarize them in the notice, truncate as a
// last resort); this file adapts it to persisted SDK messages.
//
// SDK contract (verified against @clinebot/core 0.0.38):
// - the callback completely replaces the built-in strategy; returning
//   `undefined` means NO compaction (there is no fallback), so this callback
//   always returns a `{ messages }` array.
// - when a result is returned, the SDK logs "Context compaction completed"
//   with before/after token counts via the session logger.
//
// All token math here uses the documented chars/4 fallback estimator from
// B-2.3 (cline-context-budget.ts) — the same approach the SDK trigger uses.
import {
	COMPACTION_NOTICE_PREFIX,
	type CompactionMessageAdapter,
	compactConversationTurns,
	splitLeadingCompactionNotice,
} from "./cline-compaction-turns";
import { createFallbackMessageTokenEstimator } from "./cline-context-budget";
import type {
	ClineSdkBasicLogger,
	ClineSdkCompactionContext,
	ClineSdkCompactionResult,
	ClineSdkPersistedMessage,
} from "./sdk-runtime-boundary";

/** Minimum retained text length when truncating a string or text block. */
const MIN_TRUNCATED_TEXT_CHARS = 16;

export interface CompactClineConversationMessagesResult {
	messages: ClineSdkPersistedMessage[];
	changed: boolean;
	/** Estimated message tokens before compaction. */
	tokensBefore: number;
	/** Estimated message tokens after compaction. */
	tokensAfter: number;
}

/** B-10.4: observable facts about a compaction that actually changed messages. */
export interface ClineCompactionObservedInfo {
	messagesBefore: number;
	messagesAfter: number;
	/** Estimated chars/4 message tokens before compaction. */
	tokensBefore: number;
	/** Estimated chars/4 message tokens after compaction. */
	tokensAfter: number;
}

/**
 * B-10.4: options for the compact callback factory. The observer is notified
 * after the callback ran when the compaction actually changed the transcript.
 * It must never throw — the callback wraps the notification defensively so a
 * failing observer cannot break the compaction pipeline.
 */
export interface ClineCompactionHookOptions {
	onCompacted?: (info: ClineCompactionObservedInfo) => void;
}

/**
 * Deterministically compacts a persisted conversation so its estimated
 * message tokens (chars/4) fit `targetTokens` (see compactConversationTurns
 * for the strategy). Used by the SDK `compact` callback (hub mode / future
 * SDK builds) and context-overflow recovery.
 */
export function compactClineConversationMessages(
	inputMessages: readonly ClineSdkPersistedMessage[],
	targetTokens: number,
	options: { logger?: ClineSdkBasicLogger } = {},
): CompactClineConversationMessagesResult {
	const { messages, changed, tokensBefore, tokensAfter } = compactConversationTurns(
		inputMessages,
		targetTokens,
		createPersistedMessageAdapter(),
		{ logger: options.logger, logLabel: "Kanban proactive compaction completed (estimates)" },
	);
	return { messages, changed, tokensBefore, tokensAfter };
}

function createPersistedMessageAdapter(): CompactionMessageAdapter<ClineSdkPersistedMessage> {
	const estimate = createFallbackMessageTokenEstimator();
	const blocksOf = (message: ClineSdkPersistedMessage) => (typeof message.content === "string" ? [] : message.content);
	return {
		estimate,
		isAssistant: (message) => message.role === "assistant",
		isUser: (message) => message.role === "user",
		toolCalls: (message) =>
			message.role !== "assistant"
				? []
				: blocksOf(message).flatMap((block) =>
						block.type === "tool_use" ? [{ toolCallId: block.id, toolName: block.name, input: block.input }] : [],
					),
		toolResults: (message) =>
			message.role !== "user"
				? []
				: blocksOf(message).flatMap((block) =>
						block.type === "tool_result"
							? [{ toolCallId: block.tool_use_id, isError: block.is_error === true }]
							: [],
					),
		userText: (message) => {
			if (typeof message.content === "string") {
				return splitLeadingCompactionNotice(message.content)?.rest ?? message.content;
			}
			return message.content
				.flatMap((block) =>
					block.type === "text" && !block.text.startsWith(COMPACTION_NOTICE_PREFIX) ? [block.text] : [],
				)
				.join("\n");
		},
		pruneOrphanToolResults: (message, toolCallIds) => {
			if (typeof message.content === "string") {
				return message;
			}
			const kept = message.content.filter(
				(block) => block.type !== "tool_result" || toolCallIds.has(block.tool_use_id),
			);
			if (kept.length === message.content.length) {
				return message;
			}
			return kept.length > 0 ? { ...message, content: kept } : null;
		},
		truncate: truncateMessageContent,
		stripNotice: (message) => {
			if (typeof message.content === "string") {
				const split = splitLeadingCompactionNotice(message.content);
				return split
					? { message: { ...message, content: split.rest }, notice: split.notice }
					: { message, notice: null };
			}
			const [first, ...rest] = message.content;
			if (first?.type === "text" && first.text.startsWith(COMPACTION_NOTICE_PREFIX)) {
				return { message: { ...message, content: rest }, notice: first.text };
			}
			return { message, notice: null };
		},
		prependNotice: (message, notice) => {
			if (typeof message.content === "string") {
				return { ...message, content: `${notice}\n\n${message.content}` };
			}
			return { ...message, content: [{ type: "text", text: notice }, ...message.content] };
		},
	};
}

/**
 * Creates the deterministic, model-free `compact` callback registered on
 * `localRuntime.compaction.compact` for every Kanban session with an explicit
 * compaction config. The callback completely replaces the SDK's built-in
 * strategy; returning `undefined` would mean NO compaction (there is no
 * fallback), so it always returns a `{ messages }` array (possibly unchanged
 * when the estimates already fit the target).
 */
export function createClineCompactionCompactCallback(
	logger?: ClineSdkBasicLogger,
	options: ClineCompactionHookOptions = {},
) {
	return function compactClineSessionMessages(context: ClineSdkCompactionContext): ClineSdkCompactionResult {
		const target = Math.max(1, Math.min(context.triggerTokens, context.contextWindowTokens));
		const result = compactClineConversationMessages(context.messages, target, { logger });
		if (result.changed && options.onCompacted) {
			// B-10.4: notify after the result is settled; a failing observer
			// must never break the compaction pipeline.
			try {
				options.onCompacted({
					messagesBefore: context.messages.length,
					messagesAfter: result.messages.length,
					tokensBefore: result.tokensBefore,
					tokensAfter: result.tokensAfter,
				});
			} catch {
				// Intentionally swallowed (see ClineCompactionHookOptions).
			}
		}
		return { messages: result.messages };
	};
}

interface CharBudget {
	remaining: number;
}

/** Shrinks one text field to fit the remaining char budget (front-to-back). */
function truncateTextToBudget(text: string, budget: CharBudget): string {
	if (budget.remaining <= 0 || text.length === 0) {
		return text;
	}
	const keep = Math.min(text.length, budget.remaining);
	budget.remaining -= keep;
	if (keep >= text.length) {
		return text;
	}
	return text.slice(0, Math.max(MIN_TRUNCATED_TEXT_CHARS, keep));
}

/**
 * Truncates a message's content to roughly `maxTokens` (chars/4 budget).
 * Only text-like blocks (text, thinking, file content, tool_result text) are
 * shrunk; tool_use and image blocks are preserved intact because slicing
 * them produces invalid provider payloads. Returns null when the message is
 * already within the budget or has nothing safe to shrink.
 */
function truncateMessageContent(message: ClineSdkPersistedMessage, maxTokens: number): ClineSdkPersistedMessage | null {
	const maxChars = Math.max(MIN_TRUNCATED_TEXT_CHARS, maxTokens * 4);
	if (typeof message.content === "string") {
		if (message.content.length <= maxChars) {
			return null;
		}
		return { ...message, content: message.content.slice(0, maxChars) };
	}

	const budget: CharBudget = { remaining: maxChars };
	let changed = false;
	const next = message.content.map((block) => {
		switch (block.type) {
			case "text": {
				const text = truncateTextToBudget(block.text, budget);
				if (text === block.text) {
					return block;
				}
				changed = true;
				return { ...block, text };
			}
			case "thinking": {
				const thinking = truncateTextToBudget(block.thinking, budget);
				if (thinking === block.thinking) {
					return block;
				}
				changed = true;
				return { ...block, thinking };
			}
			case "file": {
				const content = truncateTextToBudget(block.content, budget);
				if (content === block.content) {
					return block;
				}
				changed = true;
				return { ...block, content };
			}
			case "tool_result": {
				if (typeof block.content === "string") {
					const content = truncateTextToBudget(block.content, budget);
					if (content === block.content) {
						return block;
					}
					changed = true;
					return { ...block, content };
				}
				let partsChanged = false;
				const parts = block.content.map((part) => {
					if (part.type !== "text") {
						return part;
					}
					const text = truncateTextToBudget(part.text, budget);
					if (text === part.text) {
						return part;
					}
					partsChanged = true;
					return { ...part, text };
				});
				if (partsChanged) {
					changed = true;
					return { ...block, content: parts };
				}
				return block;
			}
			case "tool_use":
				budget.remaining -= Math.max(0, JSON.stringify(block).length);
				return block;
			case "image":
				budget.remaining -= Math.max(0, block.data.length);
				return block;
			case "redacted_thinking":
				budget.remaining -= Math.max(0, block.data.length);
				return block;
			default:
				return block;
		}
	});
	return changed ? { ...message, content: next } : null;
}
