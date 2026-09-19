// B-2.4 — Explicit compaction config for every native Cline session start.
//
// Without an explicit config, the SDK applies its own defaults (fixed 200k
// window, generic reserve) regardless of the local model's real limits.
// buildClineCompactionConfig turns the B-2.2 resolved launch config into a
// CoreCompactionConfig so Kanban controls the compaction window, threshold,
// reserve, and summarizer:
//
// - contextWindowTokens: the resolved effective limit (override → provider
//   metadata → documented conservative fallback).
// - reserveTokens: the provider's max output tokens when known, so the
//   compaction threshold never double-counts the expected output (B-2.3
//   ownership rule); a documented default otherwise.
// - summarizer: the same local provider/model/credentials as the session
//   itself, so summarization never leaves the user's local provider
//   (requirement: no cloud model for compaction).
//
// The `compact` callback is only set on the SDK's local runtime compaction
// object, never on session start input, so the builder omits it.
//
// B-2.5 — Calibration of that config for the ASSEMBLED request.
//
// The SDK trigger (verified against the @clinebot/core 0.0.38 bundle) counts
// only the conversation's apiMessages — the system prompt and tool schemas
// are excluded — and, whenever `reserveTokens` is a number (including 0),
// ignores `thresholdRatio` entirely, firing at `window - reserveTokens`.
// (Both behaviors are recorded as upstream SDK bugs in docs/plans/B-2-5.md.)
//
// So to make the message-only trigger effectively evaluate the full
// assembled request (system prompt + tools + messages + expected output
// <= limit), calibrateClineCompactionConfig rewrites two fields:
//
// - contextWindowTokens := limit - est(systemPrompt) - est(toolSchemas)
//   (the SDK's built-in tools plus any Kanban MCP tools; every estimate is a
//   chars/4 ESTIMATE, so a safety margin absorbs estimator drift)
// - reserveTokens := (B-2.4 output reservation) + safetyMargin
//
// The trigger then fires at messages > limit - sys - tools - output - margin,
// i.e. once the full assembled request would reach `limit - margin`. The
// output reservation stays the single place expected output is subtracted
// (B-2.3 double-count rule). The (currently inert) thresholdRatio field is
// left in place for upstream parity.

import { estimateTextTokens } from "./cline-context-budget";
import { toPositiveTokenCount } from "./cline-context-policy";
import type { ResolvedClineLaunchConfig } from "./cline-provider-service";
import { SDK_DEFAULT_MODEL_ID } from "./sdk-provider-boundary";
import {
	type ClineSdkCompactionConfig,
	type ClineSdkCompactionStrategy,
	getClineDefaultSystemPrompt,
} from "./sdk-runtime-boundary";

/** Compaction fires once the context usage reaches this fraction of the window. */
export const CLINE_COMPACTION_THRESHOLD_RATIO = 0.8;
/**
 * Reserve used when the provider does not report max output tokens. Mirrors
 * the SDK's own generic fallback so Kanban's config does not regress behavior
 * for metadata-less providers.
 */
export const CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT = 16_384;
/** Messages within this recent-token window are preserved verbatim. */
export const CLINE_COMPACTION_PRESERVE_RECENT_TOKENS = 20_000;
/** Max tokens the summarizer may emit for a compaction summary. */
export const CLINE_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS = 1_024;

/** CoreCompactionConfig minus the host-side `compact` callback. */
export type ClineCompactionConfig = Omit<ClineSdkCompactionConfig, "compact">;

/**
 * Kanban-level compaction overrides. B-2.9: resolved from the user's global
 * context budget settings (runtimeConfig.contextBudget) and carried on the
 * launch config, so every session start picks up the persisted strategy,
 * trigger threshold, output reserve, and safety margin. Field names mirror
 * `CoreCompactionConfig` (strategy / thresholdRatio / reserveTokens);
 * safetyMarginTokens has no SDK field and only feeds the Kanban-side
 * calibration and beforeModel hook. Explicit per-call `settings` win over
 * these.
 */
export interface ClineCompactionSettings {
	strategy?: ClineSdkCompactionStrategy;
	/** Compaction trigger as a fraction of the effective context window (0, 1]. */
	thresholdRatio?: number;
	/** Output reserve in tokens. */
	reserveTokens?: number;
	/** Safety margin in tokens (compaction trigger budget headroom). */
	safetyMarginTokens?: number;
}

export interface BuildClineCompactionConfigInput {
	/**
	 * B-2.2 resolved launch config. Carries the effective context limit
	 * (`contextWindowTokens`), max output tokens (`maxTokens`), the context
	 * budget compaction settings (B-2.9, `compactionSettings`), and the local
	 * provider credentials for the summarizer.
	 */
	launchConfig: ResolvedClineLaunchConfig;
	/** Optional per-call overrides that win over the launch-config budget. */
	settings?: ClineCompactionSettings;
}

export function buildClineCompactionConfig(input: BuildClineCompactionConfigInput): ClineCompactionConfig {
	const { launchConfig } = input;
	// B-2.9: the global context budget (resolved on the launch config) feeds
	// strategy / threshold / reserve; explicit per-call settings win.
	const settings: ClineCompactionSettings = { ...launchConfig.compactionSettings, ...input.settings };
	const apiKey = launchConfig.apiKey?.trim() ?? "";
	const baseUrl = launchConfig.baseUrl?.trim() ?? "";
	return {
		enabled: true,
		contextWindowTokens: launchConfig.contextWindowTokens,
		strategy: settings.strategy ?? "basic",
		thresholdRatio: settings.thresholdRatio ?? CLINE_COMPACTION_THRESHOLD_RATIO,
		reserveTokens: settings.reserveTokens ?? launchConfig.maxTokens ?? CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT,
		preserveRecentTokens: CLINE_COMPACTION_PRESERVE_RECENT_TOKENS,
		summarizer: {
			// Same local provider and model as the session itself: normalization
			// mirrors InMemoryClineTaskSessionService so the summarizer always
			// matches the session's resolved model config.
			providerId: launchConfig.providerId,
			modelId: launchConfig.modelId?.trim() || SDK_DEFAULT_MODEL_ID,
			...(apiKey ? { apiKey } : {}),
			...(baseUrl ? { baseUrl } : {}),
			maxOutputTokens: CLINE_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
		},
	};
}

// ---------------------------------------------------------------------------
// B-2.5 — Assembled-request calibration
// ---------------------------------------------------------------------------

/**
 * Estimated token cost of the SDK's built-in tool schemas (5 tools:
 * read_files, search_codebase, run_commands, fetch_web_content, editor) as
 * measured from the serialized JSON of a real @clinebot/core 0.0.38 session
 * request: 5,186 chars → 1,297 tokens at chars/4. Re-measure when the SDK
 * version or its built-in tool set changes (see docs/plans/B-2-5.md).
 */
export const CLINE_BUILTIN_TOOLS_ESTIMATED_TOKENS = 1_297;
/**
 * Fixed floor for the safety margin. Estimator (chars/4) error does not
 * shrink proportionally, so small windows still get this absolute margin.
 */
export const CLINE_COMPACTION_SAFETY_MARGIN_MIN_TOKENS = 4_096;
/**
 * Proportional safety margin, applied to the effective limit. chars/4
 * under-counts dense JSON (tool schemas) by a noticeable margin, and
 * provider tokenizers disagree with the estimate; the margin absorbs that
 * drift so the calibrated trigger fires before the provider's real limit.
 */
export const CLINE_COMPACTION_SAFETY_MARGIN_RATIO = 0.1;
/**
 * Floor for the calibrated window so the trigger always has a positive
 * target even when the non-message overhead (system prompt + tools) already
 * approaches the limit. Below that, no compaction can make the request fit
 * and the B-2.2 context-overflow recovery restart remains the backstop.
 */
export const CLINE_COMPACTION_MIN_CALIBRATED_WINDOW_TOKENS = 1_024;
/** Floor for the message-token trigger point (the SDK clamps it to >= 0). */
export const CLINE_COMPACTION_MIN_TRIGGER_TOKENS = 256;

/**
 * Minimal tool definition shape for schema-size estimation. Structurally
 * compatible with the SDK's `AgentTool`/`SdkMcpTool` values that carry an
 * `execute` function.
 */
export interface ClineCompactionToolSchema {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/**
 * Safety margin for a given effective limit: max of the fixed floor and the
 * proportional ratio (see the constants above). Shared by the compaction
 * config calibration and the beforeModel compaction hook so both use the same
 * margin.
 */
export function computeClineCompactionSafetyMarginTokens(limitTokens: number): number {
	return Math.max(
		CLINE_COMPACTION_SAFETY_MARGIN_MIN_TOKENS,
		Math.round(limitTokens * CLINE_COMPACTION_SAFETY_MARGIN_RATIO),
	);
}

/**
 * Estimates the system prompt's token size (chars/4 ESTIMATE). Falls back to
 * the SDK's default Cline prompt for the provider when the caller does not
 * supply one — the session runtime receives an already-resolved prompt, but
 * direct runtime consumers may not.
 */
export function estimateClineSystemPromptTokens(systemPrompt: string | null | undefined, providerId: string): number {
	const prompt = systemPrompt?.trim()
		? systemPrompt
		: getClineDefaultSystemPrompt({
				ide: "Kanban",
				rootPath: "<workspace>",
				providerId,
				metadata: "",
				rules: "",
			});
	return estimateTextTokens(prompt);
}

/**
 * Estimates the serialized tool-schema JSON token size (chars/4 ESTIMATE).
 * The serialization mirrors the provider wire shape (type/function wrappers)
 * so the estimate tracks what is actually sent.
 */
export function estimateClineToolSchemaTokens(tools: readonly ClineCompactionToolSchema[] = []): number {
	const serialized = JSON.stringify(
		tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description ?? "",
				parameters: tool.inputSchema ?? {},
			},
		})),
	);
	return estimateTextTokens(serialized);
}

/** Breakdown of a calibrated compaction config (all values are estimates). */
export interface ClineCompactionCalibrationBreakdown {
	/** The effective limit the config was calibrated from (uncalibrated window). */
	limitTokens: number;
	/** Estimated system prompt tokens (chars/4 estimate). */
	systemPromptTokens: number;
	/** Estimated total tool schema tokens, built-in + extra (chars/4 estimate). */
	toolSchemaTokens: number;
	/** Safety margin applied (max of fixed floor and proportional ratio). */
	safetyMarginTokens: number;
	/** Calibrated window the SDK trigger sees: limit - system - tools. */
	contextWindowTokens: number;
	/** SDK reserve: B-2.4 output reservation + safety margin. */
	reserveTokens: number;
	/** Message token count at which compaction fires: window - reserve. */
	triggerTokens: number;
}

export interface CalibrateClineCompactionConfigInput {
	/** Pre-calibration config (typically from buildClineCompactionConfig). */
	config: ClineCompactionConfig;
	/** Assembled system prompt for this session (SDK default when omitted). */
	systemPrompt?: string | null;
	/** Provider id, used to estimate the SDK default prompt when omitted. */
	providerId?: string;
	/** Kanban MCP tools added to the SDK's built-in tool set. */
	extraTools?: readonly ClineCompactionToolSchema[];
	/**
	 * B-2.9: user-set safety margin in tokens. Wins over the computed margin
	 * (fixed floor + proportional ratio); invalid/absent values fall back to
	 * the computed margin.
	 */
	safetyMarginTokens?: number;
}

export interface ClineCompactionCalibrationResult {
	config: ClineCompactionConfig;
	/**
	 * null when no calibration was possible (the config carried no positive
	 * explicit window, so the SDK would fall back to model metadata / its 200k
	 * default and there is no limit to calibrate against). The config is then
	 * returned unchanged.
	 */
	breakdown: ClineCompactionCalibrationBreakdown | null;
}

/**
 * Rewrites a compaction config's window and reserve so the SDK's message-only
 * trigger fires when the full assembled request would reach
 * `limit - safetyMargin`. See the module header for the full derivation.
 *
 * Pure function: no SDK, provider, or filesystem involvement.
 */
export function calibrateClineCompactionConfig(
	input: CalibrateClineCompactionConfigInput,
): ClineCompactionCalibrationResult {
	const limit = input.config.contextWindowTokens;
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
		return { config: input.config, breakdown: null };
	}

	const systemPromptTokens = estimateClineSystemPromptTokens(input.systemPrompt, input.providerId ?? "");
	const toolSchemaTokens = CLINE_BUILTIN_TOOLS_ESTIMATED_TOKENS + estimateClineToolSchemaTokens(input.extraTools);
	// B-2.9: the user's context budget safety margin wins when set; the
	// computed margin (fixed floor + proportional ratio) is the default.
	const safetyMarginTokens =
		toPositiveTokenCount(input.safetyMarginTokens) ?? computeClineCompactionSafetyMarginTokens(limit);
	const contextWindowTokens = Math.max(
		CLINE_COMPACTION_MIN_CALIBRATED_WINDOW_TOKENS,
		limit - systemPromptTokens - toolSchemaTokens,
	);
	const outputReserve = input.config.reserveTokens ?? CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT;
	const reserveTokens = Math.max(
		0,
		Math.min(outputReserve + safetyMarginTokens, contextWindowTokens - CLINE_COMPACTION_MIN_TRIGGER_TOKENS),
	);
	const triggerTokens = Math.max(CLINE_COMPACTION_MIN_TRIGGER_TOKENS, contextWindowTokens - reserveTokens);

	const breakdown: ClineCompactionCalibrationBreakdown = {
		limitTokens: limit,
		systemPromptTokens,
		toolSchemaTokens,
		safetyMarginTokens,
		contextWindowTokens,
		reserveTokens,
		triggerTokens,
	};
	return {
		config: { ...input.config, contextWindowTokens, reserveTokens },
		breakdown,
	};
}
