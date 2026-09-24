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
	"Compaction removed earlier turns from what the model can see. The conversation " +
	"continues from a summary, so the visible history is a partial record — summaries " +
	"are lossy and do not preserve every detail.";

/**
 * B-10.4: assemble the context-usage diagnostics payload from a message
 * snapshot and the resolved capacity. Pure — no I/O, no provider access.
 * `messages` is null when no transcript is available at all (vs. [] for an
 * empty one); both report `source: "unavailable"`.
 */
export function buildTaskContextUsage(input: {
	messages: readonly TaskContextMessageLike[] | null;
	effectiveCapacityTokens: number | null;
	triggerTokens: number | null;
	lastCompaction: RuntimeClineContextCompactionEvent | null;
}): RuntimeClineContextUsageResponse {
	const { messages, effectiveCapacityTokens, triggerTokens, lastCompaction } = input;
	const hasMessages = messages !== null && messages.length > 0;
	const estimatedMessageTokens = hasMessages ? estimateTaskContextMessageTokens(messages) : null;
	const historyOmitted = lastCompaction !== null;
	const utilizationRatio =
		estimatedMessageTokens !== null && effectiveCapacityTokens !== null && effectiveCapacityTokens > 0
			? Math.round((estimatedMessageTokens / effectiveCapacityTokens) * 10000) / 10000
			: null;
	return {
		ok: true,
		source: estimatedMessageTokens !== null ? "estimated" : "unavailable",
		messageCount: hasMessages ? messages.length : null,
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
