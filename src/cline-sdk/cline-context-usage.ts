// B-10.4: pure context-usage computation for task diagnostics.
//
// Every token figure is a chars/4 estimate (B-2.3 fallback estimator) — the
// API never reports exact provider token counts, and neither do we claim to.
import type { RuntimeClineContextCompactionEvent, RuntimeClineContextUsageResponse } from "../core/api-contract";
import { estimateTextTokens } from "./cline-context-budget";

/** Flat message shape the usage computation needs (content only). */
export interface TaskContextMessageLike {
	content: string;
}

/** Estimated chars/4 tokens across a flat message list. */
export function estimateTaskContextMessageTokens(messages: readonly TaskContextMessageLike[]): number {
	let total = 0;
	for (const message of messages) {
		total += estimateTextTokens(message.content);
	}
	return total;
}

export const OMITTED_HISTORY_NOTICE =
	"Compaction removed or truncated earlier turns in what the model sees. The full " +
	"transcript is still shown here, but the model only has the most recent turns plus " +
	"the first request, so details from the removed turns are lost to it.";

/**
 * B-10.4: assemble the context-usage diagnostics payload from a message
 * snapshot and the resolved capacity. Pure — no I/O, no provider access.
 * `messages` is null when no transcript is available at all (vs. [] for an
 * empty one); both report `source: "unavailable"`.
 *
 * Usage reports what the model sees. The local-mode beforeModel hook
 * compacts each request without shortening the stored transcript, so when
 * the latest compaction covered the whole current transcript
 * (`messagesBefore` equals its length) its `after` figures are what the model
 * saw; otherwise (no compaction, or the transcript itself was replaced by
 * overflow recovery / SDK compaction) the transcript is measured directly.
 */
export function buildTaskContextUsage(input: {
	messages: readonly TaskContextMessageLike[] | null;
	effectiveCapacityTokens: number | null;
	triggerTokens: number | null;
	lastCompaction: RuntimeClineContextCompactionEvent | null;
}): RuntimeClineContextUsageResponse {
	const { messages, effectiveCapacityTokens, triggerTokens, lastCompaction } = input;
	const hasMessages = messages !== null && messages.length > 0;
	const requestScopedCompaction =
		hasMessages && lastCompaction !== null && lastCompaction.messagesBefore === messages.length;
	const estimatedMessageTokens = !hasMessages
		? null
		: requestScopedCompaction
			? lastCompaction.tokensAfter
			: estimateTaskContextMessageTokens(messages);
	const messageCount = !hasMessages ? null : requestScopedCompaction ? lastCompaction.messagesAfter : messages.length;
	const historyOmitted = lastCompaction !== null;
	const utilizationRatio =
		estimatedMessageTokens !== null && effectiveCapacityTokens !== null && effectiveCapacityTokens > 0
			? Math.round((estimatedMessageTokens / effectiveCapacityTokens) * 10000) / 10000
			: null;
	return {
		ok: true,
		source: estimatedMessageTokens !== null ? "estimated" : "unavailable",
		messageCount,
		estimatedMessageTokens,
		effectiveCapacityTokens,
		triggerTokens,
		utilizationRatio,
		lastCompaction,
		historyOmitted,
		omittedHistoryNotice: historyOmitted ? OMITTED_HISTORY_NOTICE : null,
		error: null,
	};
}
