// B-10.4: context usage reports what the model sees.
import { describe, expect, it } from "vitest";

import { buildTaskContextUsage, estimateTaskContextMessageTokens } from "../../../src/cline-sdk/cline-context-usage";
import type { RuntimeClineContextCompactionEvent } from "../../../src/core/api-contract";

const messages = Array.from({ length: 4 }, (_, index) => ({ content: `message ${index} `.repeat(200) }));

function createCompaction(
	overrides: Partial<RuntimeClineContextCompactionEvent> = {},
): RuntimeClineContextCompactionEvent {
	return {
		at: "2026-09-25T00:00:00.000Z",
		trigger: "proactive",
		tokensBefore: 5000,
		tokensAfter: 400,
		messagesBefore: messages.length,
		messagesAfter: 2,
		...overrides,
	};
}

describe("buildTaskContextUsage", () => {
	it("measures the stored transcript when nothing was compacted", () => {
		const usage = buildTaskContextUsage({
			messages,
			effectiveCapacityTokens: 10_000,
			triggerTokens: 8_000,
			lastCompaction: null,
		});
		expect(usage.messageCount).toBe(messages.length);
		expect(usage.estimatedMessageTokens).toBe(estimateTaskContextMessageTokens(messages));
		expect(usage.historyOmitted).toBe(false);
	});

	it("reports the compacted request when the latest compaction covered the whole transcript", () => {
		const usage = buildTaskContextUsage({
			messages,
			effectiveCapacityTokens: 1_000,
			triggerTokens: 800,
			lastCompaction: createCompaction(),
		});
		expect(usage.messageCount).toBe(2);
		expect(usage.estimatedMessageTokens).toBe(400);
		expect(usage.utilizationRatio).toBe(0.4);
		expect(usage.historyOmitted).toBe(true);
	});

	it("measures the transcript when it was replaced after the compaction", () => {
		const usage = buildTaskContextUsage({
			messages,
			effectiveCapacityTokens: 10_000,
			triggerTokens: 8_000,
			lastCompaction: createCompaction({ trigger: "overflow", messagesBefore: 30 }),
		});
		expect(usage.messageCount).toBe(messages.length);
		expect(usage.estimatedMessageTokens).toBe(estimateTaskContextMessageTokens(messages));
	});
});
