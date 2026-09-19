// B-2.5 — Local-mode proactive compaction via the agent-runtime beforeModel
// hook.
//
// Verified against @clinebot/core 0.0.38: the SDK's own compaction pipeline
// (trigger + basic/agentic strategies + the `compact` callback) is wired
// through the agent config's `prepareTurn`, but no agent runtime in this
// version ever invokes `prepareTurn` (upstream bug recorded in
// docs/plans/B-2-5.md). In local mode the compaction config and callback are
// therefore inert, and a long session would still overflow the provider
// reactively.
//
// The agent runtime DOES invoke `hooks.beforeModel` before every model
// request, passing the fully assembled request (system prompt, tool schemas,
// and conversation messages). This hook evaluates that assembled request
// against the calibrated budget and, when it would exceed
// `limit - outputReserve - safetyMargin`, rewrites the request's messages
// with the same deterministic compactor the `compact` callback uses
// (compactClineConversationMessages). The rewrite is request-scoped: the
// provider sees a fitting request every turn, while the persisted session
// transcript stays complete for review.
//
// In hub mode `hooks` is a local-only session-config key (it never crosses
// the hub boundary); there the `compact` session capability registered on
// localRuntime.compaction.compact provides the same guard instead. When the
// upstream prepare-turn bug is fixed, the hook and the SDK trigger share the
// same calibrated numbers, so the hook keeps the request under budget and
// the SDK trigger never fires — no double compaction.
//
// All token values are chars/4 ESTIMATES (B-2.3 fallback estimator); logs
// label them as such.
import { computeClineCompactionSafetyMarginTokens, estimateClineToolSchemaTokens } from "./cline-compaction-config";
import { estimateTextTokens } from "./cline-context-budget";
import { toPositiveTokenCount } from "./cline-context-policy";
import type {
	ClineSdkAgentBeforeModelContext,
	ClineSdkAgentBeforeModelHook,
	ClineSdkAgentBeforeModelResult,
	ClineSdkAgentMessage,
	ClineSdkAgentMessagePart,
	ClineSdkBasicLogger,
} from "./sdk-runtime-boundary";

/** Floor for the message-token target (matches the calibrated config floor). */
const MIN_MESSAGE_TARGET_TOKENS = 256;
/** Mirrors the minimum truncated-message size used by the compact callback. */
const MIN_TRUNCATED_MESSAGE_TOKENS = 16;
/** Minimum retained text length when truncating a part. */
const MIN_TRUNCATED_TEXT_CHARS = 16;

const COMPACTION_NOTICE_TEXT =
	"[Earlier conversation turns were removed to fit the context window. " +
	"Infer prior actions from the current environment state.]";

function serializeAgentPart(part: ClineSdkAgentMessagePart): string {
	switch (part.type) {
		case "text":
			return part.text;
		case "reasoning":
			return part.redacted ? "[redacted reasoning]" : part.text;
		case "image":
			return typeof part.image === "string" ? part.image : `[image:${part.mediaType ?? "unknown"}]`;
		case "file":
			return `${part.path}\n${part.content}`;
		case "tool-call":
			return `${part.toolName} ${JSON.stringify(part.input ?? {})}`;
		case "tool-result":
			return typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? "");
		default:
			return "";
	}
}

function estimateAgentMessage(message: ClineSdkAgentMessage): number {
	return estimateTextTokens(message.content.map(serializeAgentPart).join("\n"));
}

export interface CompactClineAgentMessagesResult {
	messages: ClineSdkAgentMessage[];
	changed: boolean;
	/** Estimated message tokens before compaction. */
	tokensBefore: number;
	/** Estimated message tokens after compaction. */
	tokensAfter: number;
}

interface CharBudget {
	remaining: number;
}

/** Shrinks one text field to fit the remaining char budget (front-to-back). */
function truncateTextField(text: string, budget: CharBudget): string {
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
 * Truncates an agent message's parts to roughly `maxTokens` (chars/4
 * budget). Only text-like parts (text, reasoning, file content, string
 * tool-result output) are shrunk; tool-call and image parts are preserved
 * intact because slicing them produces invalid provider payloads. Returns
 * null when nothing was shrunk.
 */
function truncateAgentMessageContent(message: ClineSdkAgentMessage, maxTokens: number): ClineSdkAgentMessage | null {
	const budget: CharBudget = { remaining: Math.max(MIN_TRUNCATED_TEXT_CHARS, maxTokens * 4) };
	let changed = false;
	const next = message.content.map((part) => {
		switch (part.type) {
			case "text": {
				const text = truncateTextField(part.text, budget);
				if (text === part.text) {
					return part;
				}
				changed = true;
				return { ...part, text };
			}
			case "reasoning": {
				if (part.redacted) {
					budget.remaining -= 18;
					return part;
				}
				const text = truncateTextField(part.text, budget);
				if (text === part.text) {
					return part;
				}
				changed = true;
				return { ...part, text };
			}
			case "file": {
				const content = truncateTextField(part.content, budget);
				if (content === part.content) {
					return part;
				}
				changed = true;
				return { ...part, content };
			}
			case "tool-result": {
				if (typeof part.output === "string") {
					const output = truncateTextField(part.output, budget);
					if (output === part.output) {
						return part;
					}
					changed = true;
					return { ...part, output };
				}
				budget.remaining -= Math.max(0, JSON.stringify(part.output ?? "").length);
				return part;
			}
			case "tool-call":
				budget.remaining -= Math.max(0, `${part.toolName} ${JSON.stringify(part.input ?? {})}`.length);
				return part;
			case "image":
				budget.remaining -= typeof part.image === "string" ? part.image.length : 64;
				return part;
			default:
				return part;
		}
	});
	return changed ? { ...message, content: next } : null;
}

/**
 * Deterministically compacts agent-runtime messages so their estimated
 * tokens (chars/4) fit `targetTokens`. Same strategy as
 * compactClineConversationMessages (the MessageWithMetadata domain used by
 * the SDK compact callback): delete old assistant messages, then old user
 * messages, then the last assistant/user; repair orphaned tool-result parts;
 * truncate from the back; and prepend a compaction notice to the surviving
 * first message when anything changed. The first user message is never
 * deleted (only truncated as a last resort). Pure: no provider, SDK, or
 * filesystem involvement.
 */
export function compactClineAgentMessages(
	inputMessages: readonly ClineSdkAgentMessage[],
	targetTokens: number,
	options: { logger?: ClineSdkBasicLogger } = {},
): CompactClineAgentMessagesResult {
	const logger = options.logger;
	const original = inputMessages;
	const target = Math.max(1, targetTokens);
	let messages: ClineSdkAgentMessage[] = [...original];
	const tokensBefore = messages.reduce((sum, message) => sum + estimateAgentMessage(message), 0);
	if (messages.length === 0) {
		return { messages, changed: false, tokensBefore: 0, tokensAfter: 0 };
	}
	// Budget for the notice up front, like the MessageWithMetadata compactor.
	const budget = Math.max(1, target - estimateTextTokens(COMPACTION_NOTICE_TEXT));
	let remaining = tokensBefore;
	if (remaining <= budget) {
		return { messages, changed: false, tokensBefore, tokensAfter: remaining };
	}

	const firstUser = messages.find((message) => message.role === "user");
	const lastUser = [...messages].reverse().find((message) => message.role === "user");
	const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");

	const passes: Array<(message: ClineSdkAgentMessage) => boolean> = [
		(message) => message.role === "assistant" && message !== lastAssistant,
		(message) =>
			(message.role === "user" || message.role === "tool") && message !== firstUser && message !== lastUser,
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
			remaining -= estimateAgentMessage(candidate);
			messages.splice(index, 1);
			changed = true;
			index -= 1;
		}
	}

	// Tool pairing repair: drop tool-result parts whose tool-call part is no
	// longer present (providers reject requests with orphan tool results).
	const toolCallIds = new Set<string>();
	for (const message of messages) {
		for (const part of message.content) {
			if (part.type === "tool-call") {
				toolCallIds.add(part.toolCallId);
			}
		}
	}
	const pruned = messages.flatMap((message) => {
		const kept = message.content.filter((part) => part.type !== "tool-result" || toolCallIds.has(part.toolCallId));
		return kept.length > 0 ? [{ ...message, content: kept }] : [];
	});
	if (pruned.length !== messages.length || pruned.some((message, index) => message !== messages[index])) {
		messages = pruned;
		remaining = messages.reduce((sum, message) => sum + estimateAgentMessage(message), 0);
		changed = true;
	}

	// Truncation pass: from the back, shrink messages in place; the first
	// user message is only touched as a last resort.
	if (remaining > budget) {
		for (let index = messages.length - 1; index >= 0 && remaining > budget; index -= 1) {
			const message = messages[index];
			if (message === firstUser) {
				continue;
			}
			const current = estimateAgentMessage(message);
			const reducedTokens = Math.max(MIN_TRUNCATED_MESSAGE_TOKENS, current - (remaining - budget));
			if (reducedTokens >= current) {
				continue;
			}
			const truncated = truncateAgentMessageContent(message, reducedTokens);
			if (truncated) {
				remaining -= current - estimateAgentMessage(truncated);
				messages[index] = truncated;
				changed = true;
			}
		}
		if (remaining > budget && firstUser) {
			const firstUserIndex = messages.indexOf(firstUser);
			if (firstUserIndex >= 0) {
				const current = estimateAgentMessage(firstUser);
				const reducedTokens = Math.max(1, current - (remaining - budget));
				const truncated = reducedTokens < current ? truncateAgentMessageContent(firstUser, reducedTokens) : null;
				if (truncated) {
					remaining -= current - estimateAgentMessage(truncated);
					messages[firstUserIndex] = truncated;
					changed = true;
				}
			}
		}
	}

	if (changed) {
		messages[0] = {
			...messages[0],
			content: [{ type: "text", text: COMPACTION_NOTICE_TEXT }, ...messages[0].content],
		};
	}
	const tokensAfter = messages.reduce((sum, message) => sum + estimateAgentMessage(message), 0);
	if (changed) {
		logger?.debug("Kanban agent-message compaction completed (estimates)", {
			messagesBefore: original.length,
			messagesAfter: messages.length,
			messageTokensBefore: tokensBefore,
			messageTokensAfter: tokensAfter,
			target,
		});
	}
	return { messages, changed, tokensBefore, tokensAfter };
}

export interface CreateClineCompactionBeforeModelHookInput {
	/** Effective context limit in tokens (the uncalibrated compaction window). */
	limitTokens: number;
	/**
	 * Expected output reservation in tokens — the B-2.4 compaction reserve
	 * BEFORE the safety margin is folded in (single source of truth for the
	 * output reservation, per the B-2.3 double-count rule).
	 */
	outputReserveTokens: number;
	/**
	 * B-2.9: user-set safety margin in tokens. Wins over the computed margin
	 * (fixed floor + proportional ratio); invalid/absent values fall back to
	 * the computed margin so both this hook and the config calibration keep
	 * using the same margin.
	 */
	safetyMarginTokens?: number;
	logger?: ClineSdkBasicLogger;
}

/**
 * Creates the beforeModel hook that keeps every assembled local-mode request
 * within the calibrated budget. Returns undefined (no rewrite) when the
 * request already fits.
 */
export function createClineCompactionBeforeModelHook(
	input: CreateClineCompactionBeforeModelHookInput,
): ClineSdkAgentBeforeModelHook {
	const { limitTokens, outputReserveTokens, logger } = input;
	// B-2.9: the user's context budget safety margin wins when set; the
	// computed margin (fixed floor + proportional ratio) is the default.
	const safetyMarginTokens =
		toPositiveTokenCount(input.safetyMarginTokens) ?? computeClineCompactionSafetyMarginTokens(limitTokens);
	const requestBudgetTokens = limitTokens - outputReserveTokens - safetyMarginTokens;

	return function compactClineModelRequest(
		context: ClineSdkAgentBeforeModelContext,
	): ClineSdkAgentBeforeModelResult | undefined {
		const messages = context.request.messages;
		if (!messages || messages.length === 0) {
			return undefined;
		}
		// The hook sees the actual assembled request, so the system prompt and
		// tool schemas are measured from the request itself instead of the
		// start-time estimates used by the config calibration.
		const systemPromptTokens = estimateTextTokens(context.request.systemPrompt ?? "");
		const toolSchemaTokens = estimateClineToolSchemaTokens(context.request.tools);
		const messageTargetTokens = Math.max(
			MIN_MESSAGE_TARGET_TOKENS,
			requestBudgetTokens - systemPromptTokens - toolSchemaTokens,
		);

		const result = compactClineAgentMessages(messages, messageTargetTokens, { logger });
		if (!result.changed) {
			return undefined;
		}
		logger?.debug("Kanban beforeModel compaction applied to model request (estimates)", {
			limitTokens,
			requestBudgetTokens,
			systemPromptTokens,
			toolSchemaTokens,
			messageTokensBefore: result.tokensBefore,
			messageTokensAfter: result.tokensAfter,
			messagesBefore: messages.length,
			messagesAfter: result.messages.length,
		});
		return { messages: result.messages };
	};
}
