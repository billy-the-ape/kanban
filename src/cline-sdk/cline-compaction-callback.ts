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
// the guard deterministic, unit-testable, and pinned to this codebase. It
// mirrors the proven SDK basic strategy (delete old assistant messages, then
// old user messages, then the last assistant/user, then truncate from the
// back) and adds two safety improvements:
//
// - tool pairing repair: deletion can orphan tool_result blocks whose
//   tool_use assistant message was removed; orphan tool results are dropped
//   (providers reject requests that contain them).
// - a compaction notice is prepended to the surviving first message so the
//   model knows earlier turns were removed.
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
import { createFallbackMessageTokenEstimator } from "./cline-context-budget";
import type {
	ClineSdkBasicLogger,
	ClineSdkCompactionContext,
	ClineSdkCompactionResult,
	ClineSdkPersistedMessage,
} from "./sdk-runtime-boundary";

/** Mirrors the SDK's minimum truncated-message size (16 tokens). */
const MIN_TRUNCATED_MESSAGE_TOKENS = 16;
/** Minimum retained text length when truncating a string or text block. */
const MIN_TRUNCATED_TEXT_CHARS = 16;

const COMPACTION_NOTICE =
	"[Earlier conversation turns were removed to fit the context window. " +
	"Infer prior actions from the current environment state.]";

/**
 * Deterministically compacts a conversation so its estimated message tokens
 * (chars/4) fit `targetTokens`. Mirrors the SDK's proven basic-strategy
 * order — delete old assistant messages, then old user messages, then the
 * last assistant, then the last user, then truncate from the back — and adds
 * tool-pairing repair plus a compaction notice on the surviving first
 * message. The first user message is never deleted (only truncated as a last
 * resort). Pure: no provider, SDK, or filesystem involvement.
 *
 * Shared by the SDK `compact` callback (hub mode / future SDK builds) and
 * the local-mode beforeModel hook (see cline-compaction-before-model-hook).
 */
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

export function compactClineConversationMessages(
	inputMessages: readonly ClineSdkPersistedMessage[],
	targetTokens: number,
	options: { logger?: ClineSdkBasicLogger } = {},
): CompactClineConversationMessagesResult {
	const logger = options.logger;
	const estimate = createFallbackMessageTokenEstimator();
	const totalTokens = (candidate: readonly ClineSdkPersistedMessage[]) =>
		candidate.reduce((sum, message) => sum + estimate(message), 0);

	const original = inputMessages;
	const target = Math.max(1, targetTokens);
	let messages = [...original];
	if (messages.length === 0) {
		return { messages, changed: false, tokensBefore: 0, tokensAfter: 0 };
	}

	// The trigger fired per the SDK's estimator; the notice costs tokens,
	// so budget for it up front. The string-content prepend also inserts a
	// "\n\n" separator, so reserve its cost too — otherwise the final
	// estimate can overshoot the target by one token.
	const noticeTokens = estimate({ role: "user", content: `${COMPACTION_NOTICE}\n\n` });
	const budget = Math.max(1, target - noticeTokens);
	let remaining = totalTokens(messages);
	if (remaining <= budget) {
		// Estimator drift: the caller's trigger fired, but under the same
		// chars/4 estimate the messages already fit — no rewrite.
		logger?.debug("Kanban proactive compaction: messages already under target (estimates)", {
			target,
			messageTokens: remaining,
		});
		return { messages, changed: false, tokensBefore: remaining, tokensAfter: remaining };
	}

	const firstUser = messages.find((message) => message.role === "user");
	const lastUser = [...messages].reverse().find((message) => message.role === "user");
	const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");

	// Deletion passes in the SDK basic strategy's order: oldest first,
	// protecting the first user message, the last user message, and (until
	// pass 3) the last assistant message.
	const passes: Array<(message: ClineSdkPersistedMessage) => boolean> = [
		(message) => message.role === "assistant" && message !== lastAssistant,
		(message) => message.role === "user" && message !== firstUser && message !== lastUser,
		(message) => message.role === "assistant" && message === lastAssistant,
		(message) => message.role === "user" && message === lastUser && message !== firstUser,
	];
	let changed = false;
	for (const isDeletable of passes) {
		for (let index = 0; index < messages.length && remaining > budget; index += 1) {
			const candidate = messages[index];
			if (!isDeletable(candidate)) {
				continue;
			}
			remaining -= estimate(candidate);
			messages.splice(index, 1);
			changed = true;
			index -= 1;
		}
	}
	// Tool pairing repair: drop orphan tool_result blocks (and messages
	// left empty by the pruning) whose tool_use was deleted above.
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
	const pruned = messages.flatMap((message) => {
		if (message.role !== "user" || typeof message.content === "string") {
			return [message];
		}
		const kept = message.content.filter((block) => block.type !== "tool_result" || toolUseIds.has(block.tool_use_id));
		return kept.length > 0 ? [{ ...message, content: kept }] : [];
	});
	if (pruned.length !== messages.length || pruned.some((message, index) => message !== messages[index])) {
		messages = pruned;
		remaining = totalTokens(pruned);
		changed = true;
	}

	// Truncation pass (SDK Mh equivalent): from the back of the
	// conversation, shrink messages in place; the first user message is
	// only touched as a last resort.
	if (remaining > budget) {
		for (let index = messages.length - 1; index >= 0 && remaining > budget; index -= 1) {
			const message = messages[index];
			if (message === firstUser) {
				continue;
			}
			const current = estimate(message);
			const reducedTokens = Math.max(MIN_TRUNCATED_MESSAGE_TOKENS, current - (remaining - budget));
			if (reducedTokens >= current) {
				continue;
			}
			const truncated = truncateMessageContent(message, reducedTokens);
			if (truncated) {
				remaining -= current - estimate(truncated);
				messages[index] = truncated;
				changed = true;
			}
		}
		if (remaining > budget && firstUser) {
			const firstUserIndex = messages.indexOf(firstUser);
			if (firstUserIndex >= 0) {
				const current = estimate(firstUser);
				const reducedTokens = Math.max(1, current - (remaining - budget));
				const truncated = reducedTokens < current ? truncateMessageContent(firstUser, reducedTokens) : null;
				if (truncated) {
					remaining -= current - estimate(truncated);
					messages[firstUserIndex] = truncated;
					changed = true;
				}
			}
		}
	}

	// Prepend the notice to the surviving first message so the model knows
	// earlier turns were removed (mirrors the B-2.2 overflow fallback's
	// notice approach; that one previews the first user message because it
	// discards it, which this path never does).
	if (changed) {
		messages[0] = prependCompactionNotice(messages[0]);
	}

	const tokensBefore = totalTokens(original);
	const tokensAfter = totalTokens(messages);
	if (changed) {
		logger?.debug("Kanban proactive compaction completed (estimates)", {
			messagesBefore: original.length,
			messagesAfter: messages.length,
			messageTokensBefore: tokensBefore,
			messageTokensAfter: tokensAfter,
			target,
		});
	}
	return { messages, changed, tokensBefore, tokensAfter };
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

function prependCompactionNotice(message: ClineSdkPersistedMessage): ClineSdkPersistedMessage {
	if (typeof message.content === "string") {
		return { ...message, content: `${COMPACTION_NOTICE}\n\n${message.content}` };
	}
	return { ...message, content: [{ type: "text", text: COMPACTION_NOTICE }, ...message.content] };
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
