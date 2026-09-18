// B-2.5 — Pure math for calibrating the compaction config against the
// assembled request (system prompt + tool schemas + messages + output +
// margin <= limit). No SDK, provider, or filesystem involvement.
import { describe, expect, it } from "vitest";
import {
	CLINE_BUILTIN_TOOLS_ESTIMATED_TOKENS,
	CLINE_COMPACTION_MIN_CALIBRATED_WINDOW_TOKENS,
	CLINE_COMPACTION_MIN_TRIGGER_TOKENS,
	CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT,
	CLINE_COMPACTION_SAFETY_MARGIN_MIN_TOKENS,
	CLINE_COMPACTION_SAFETY_MARGIN_RATIO,
	type ClineCompactionConfig,
	calibrateClineCompactionConfig,
	computeClineCompactionSafetyMarginTokens,
	estimateClineSystemPromptTokens,
	estimateClineToolSchemaTokens,
} from "../../../src/cline-sdk/cline-compaction-config";
import { estimateTextTokens } from "../../../src/cline-sdk/cline-context-budget";

function makeConfig(overrides: Partial<ClineCompactionConfig> = {}): ClineCompactionConfig {
	return {
		enabled: true,
		contextWindowTokens: 32_768,
		strategy: "basic",
		thresholdRatio: 0.8,
		reserveTokens: 4_096,
		preserveRecentTokens: 20_000,
		summarizer: {
			providerId: "openrouter",
			modelId: "local/test-model",
			maxOutputTokens: 1_024,
		},
		...overrides,
	};
}

describe("B-2.5 — compaction calibration math", () => {
	it("applies the safety margin floor for small limits and the ratio for large ones", () => {
		expect(computeClineCompactionSafetyMarginTokens(8_000)).toBe(CLINE_COMPACTION_SAFETY_MARGIN_MIN_TOKENS);
		expect(computeClineCompactionSafetyMarginTokens(200_000)).toBe(200_000 * CLINE_COMPACTION_SAFETY_MARGIN_RATIO);
	});

	it("rewrites window and reserve so the trigger fires at limit - overhead - output - margin", () => {
		const systemPrompt = "x".repeat(4_000); // 1,000 estimated tokens
		const { config, breakdown } = calibrateClineCompactionConfig({
			config: makeConfig(),
			systemPrompt,
			providerId: "openrouter",
			extraTools: [],
		});

		expect(breakdown).not.toBeNull();
		const b = breakdown as NonNullable<typeof breakdown>;
		expect(b.systemPromptTokens).toBe(estimateTextTokens(systemPrompt));
		// BUILTIN + estimateClineToolSchemaTokens([]): serializing an empty
		// tool list still costs one estimated token ("[]").
		expect(b.toolSchemaTokens).toBe(CLINE_BUILTIN_TOOLS_ESTIMATED_TOKENS + estimateClineToolSchemaTokens([]));
		expect(b.safetyMarginTokens).toBe(4_096); // floor: 10% of 32768 is 3276.8
		// window = limit - system - tools
		expect(b.contextWindowTokens).toBe(32_768 - b.systemPromptTokens - b.toolSchemaTokens);
		// reserve = B-2.4 output reservation + margin (output stays the single
		// place expected output is subtracted — B-2.3 double-count rule)
		expect(b.reserveTokens).toBe(4_096 + 4_096);
		// trigger = window - reserve
		expect(b.triggerTokens).toBe(b.contextWindowTokens - b.reserveTokens);

		expect(config.contextWindowTokens).toBe(b.contextWindowTokens);
		expect(config.reserveTokens).toBe(b.reserveTokens);
	});

	it("preserves the other compaction fields", () => {
		const { config, breakdown } = calibrateClineCompactionConfig({
			config: makeConfig(),
			systemPrompt: "short prompt",
		});
		expect(breakdown).not.toBeNull();
		expect(config.enabled).toBe(true);
		expect(config.strategy).toBe("basic");
		expect(config.thresholdRatio).toBe(0.8);
		expect(config.preserveRecentTokens).toBe(20_000);
		expect(config.summarizer).toEqual({
			providerId: "openrouter",
			modelId: "local/test-model",
			maxOutputTokens: 1_024,
		});
	});

	it("adds extra MCP tool schemas to the built-in tool estimate", () => {
		const extraTools = [{ name: "my_tool", description: "does a thing", inputSchema: { type: "object" } }];
		const { breakdown } = calibrateClineCompactionConfig({
			config: makeConfig(),
			systemPrompt: "prompt",
			extraTools,
		});
		const extraTokens = estimateClineToolSchemaTokens(extraTools);
		expect(extraTokens).toBeGreaterThan(0);
		expect(breakdown?.toolSchemaTokens).toBe(CLINE_BUILTIN_TOOLS_ESTIMATED_TOKENS + extraTokens);
	});

	it("falls back to the SDK default prompt estimate when no prompt is supplied", () => {
		const first = estimateClineSystemPromptTokens(undefined, "openrouter");
		const second = estimateClineSystemPromptTokens(null, "openrouter");
		expect(first).toBeGreaterThan(0);
		// Deterministic: same provider → same estimate.
		expect(second).toBe(first);
	});

	it("passes the config through unchanged when no explicit window is set", () => {
		const config = makeConfig();
		delete config.contextWindowTokens;
		const { config: result, breakdown } = calibrateClineCompactionConfig({ config, systemPrompt: "prompt" });
		expect(breakdown).toBeNull();
		expect(result).toBe(config);
	});

	it("floors the window and trigger when overhead plus margin exceeds the limit", () => {
		const systemPrompt = "x".repeat(16_000); // 4,000 estimated tokens > limit
		const { breakdown } = calibrateClineCompactionConfig({
			config: makeConfig({ contextWindowTokens: 2_000, reserveTokens: 500 }),
			systemPrompt,
		});
		expect(breakdown?.contextWindowTokens).toBe(CLINE_COMPACTION_MIN_CALIBRATED_WINDOW_TOKENS);
		// reserve is clamped so the trigger stays at the documented floor
		expect(breakdown?.reserveTokens).toBe(
			CLINE_COMPACTION_MIN_CALIBRATED_WINDOW_TOKENS - CLINE_COMPACTION_MIN_TRIGGER_TOKENS,
		);
		expect(breakdown?.triggerTokens).toBe(CLINE_COMPACTION_MIN_TRIGGER_TOKENS);
	});

	it("uses the documented default reserve when the config has none", () => {
		const { breakdown } = calibrateClineCompactionConfig({
			config: makeConfig({ reserveTokens: undefined }),
			systemPrompt: "prompt",
		});
		expect(breakdown?.reserveTokens).toBe(CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT + 4_096);
	});
});
