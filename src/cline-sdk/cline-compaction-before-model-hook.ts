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
// with the same turn-based compactor the `compact` callback uses
// (compactConversationTurns in cline-compaction-turns.ts). The rewrite is request-scoped: the
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

import type { ClineCompactionObservedInfo } from "./cline-compaction-callback";
import { computeClineCompactionSafetyMarginTokens, estimateClineToolSchemaTokens } from "./cline-compaction-config";
import {
	COMPACTION_NOTICE_PREFIX,
	type CompactionMessageAdapter,
	compactConversationTurns,
} from "./cline-compaction-turns";
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
/** Minimum retained text length when truncating a part. */
const MIN_TRUNCATED_TEXT_CHARS = 16;

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
 * tokens (chars/4) fit `targetTokens`, with the same turn-based strategy the
 * persisted-message compactor uses (see compactConversationTurns). Pure: no
 * provider, SDK, or filesystem involvement.
 */
export function compactClineAgentMessages(
	inputMessages: readonly ClineSdkAgentMessage[],
	targetTokens: number,
	options: { logger?: ClineSdkBasicLogger } = {},
): CompactClineAgentMessagesResult {
	const { messages, changed, tokensBefore, tokensAfter } = compactConversationTurns(
		inputMessages,
		targetTokens,
		AGENT_MESSAGE_ADAPTER,
		{ logger: options.logger, logLabel: "Kanban agent-message compaction completed (estimates)" },
	);
	return { messages, changed, tokensBefore, tokensAfter };
}

const AGENT_MESSAGE_ADAPTER: CompactionMessageAdapter<ClineSdkAgentMessage> = {
	estimate: estimateAgentMessage,
	isAssistant: (message) => message.role === "assistant",
	isUser: (message) => message.role === "user",
	toolCalls: (message) =>
		message.role !== "assistant"
			? []
			: message.content.flatMap((part) =>
					part.type === "tool-call"
						? [{ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }]
						: [],
				),
	toolResults: (message) =>
		message.content.flatMap((part) =>
			part.type === "tool-result" ? [{ toolCallId: part.toolCallId, isError: part.isError === true }] : [],
		),
	userText: (message) =>
		message.content
			.flatMap((part) =>
				part.type === "text" && !part.text.startsWith(COMPACTION_NOTICE_PREFIX) ? [part.text] : [],
			)
			.join("\n"),
	pruneOrphanToolResults: (message, toolCallIds) => {
		const kept = message.content.filter((part) => part.type !== "tool-result" || toolCallIds.has(part.toolCallId));
		if (kept.length === message.content.length) {
			return message;
		}
		return kept.length > 0 ? { ...message, content: kept } : null;
	},
	truncate: truncateAgentMessageContent,
	stripNotice: (message) => {
		const [first, ...rest] = message.content;
		if (first?.type === "text" && first.text.startsWith(COMPACTION_NOTICE_PREFIX)) {
			return { message: { ...message, content: rest }, notice: first.text };
		}
		return { message, notice: null };
	},
	prependNotice: (message, notice) => ({ ...message, content: [{ type: "text", text: notice }, ...message.content] }),
};

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
	/**
	 * B-10.4: optional observer notified when the hook rewrote the request's
	 * messages. Must never throw — the hook wraps the notification
	 * defensively so a failing observer cannot break the model request path.
	 */
	onCompacted?: (info: ClineCompactionObservedInfo) => void;
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
		// B-10.4: observe after the rewrite is settled; a failing observer
		// must never break the model request path.
		const onCompacted = input.onCompacted;
		if (onCompacted) {
			try {
				onCompacted({
					messagesBefore: messages.length,
					messagesAfter: result.messages.length,
					tokensBefore: result.tokensBefore,
					tokensAfter: result.tokensAfter,
				});
			} catch {
				// Intentionally swallowed (see CreateClineCompactionBeforeModelHookInput).
			}
		}
		return { messages: result.messages };
	};
}
