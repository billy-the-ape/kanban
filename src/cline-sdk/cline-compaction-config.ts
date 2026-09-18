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
import type { ResolvedClineLaunchConfig } from "./cline-provider-service";
import { SDK_DEFAULT_MODEL_ID } from "./sdk-provider-boundary";
import type { ClineSdkCompactionConfig, ClineSdkCompactionStrategy } from "./sdk-runtime-boundary";

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
 * Kanban-level compaction overrides. B-2-9 will surface a persisted strategy
 * choice here; until then only the default ("basic") applies.
 */
export interface ClineCompactionSettings {
	strategy?: ClineSdkCompactionStrategy;
}

export interface BuildClineCompactionConfigInput {
	/**
	 * B-2.2 resolved launch config. Carries the effective context limit
	 * (`contextWindowTokens`), max output tokens (`maxTokens`), and the local
	 * provider credentials for the summarizer.
	 */
	launchConfig: ResolvedClineLaunchConfig;
	/** Optional Kanban-level overrides (defaults until B-2-9 persists settings). */
	settings?: ClineCompactionSettings;
}

export function buildClineCompactionConfig(input: BuildClineCompactionConfigInput): ClineCompactionConfig {
	const { launchConfig, settings } = input;
	const apiKey = launchConfig.apiKey?.trim() ?? "";
	const baseUrl = launchConfig.baseUrl?.trim() ?? "";
	return {
		enabled: true,
		contextWindowTokens: launchConfig.contextWindowTokens,
		strategy: settings?.strategy ?? "basic",
		thresholdRatio: CLINE_COMPACTION_THRESHOLD_RATIO,
		reserveTokens: launchConfig.maxTokens ?? CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT,
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
