// B-2.2 — Effective context-limit resolution.
//
// The effective limit is always the most restrictive *known, provided* limit:
// `effective = min(known positive values)` over the tiers
// {override (persisted provider settings), provider-metadata (model list)}.
// `source` names the tier that supplied the minimum; on a tie the explicit
// override wins because it is the operator's deliberate choice. When neither
// tier provides a usable value, the documented conservative fallback applies
// (see B-2.md requirement #8 and docs/plans/B-2-2.md).
//
// This module is pure and dependency-free so the policy can be unit-tested
// without any provider, settings, or network involvement.

export const CONTEXT_LIMIT_FALLBACK_TOKENS = 200_000;

export type ContextLimitSource = "override" | "provider-metadata" | "fallback";

export interface EffectiveContextLimit {
	limitTokens: number;
	source: ContextLimitSource;
}

// Only positive integers count as "known". Zero, negative, fractional, or
// non-numeric values are treated as unknown — never as "unlimited". B-2.9
// reuses this for user-supplied context budget token fields.
export function toPositiveTokenCount(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return null;
	}
	return value;
}

export function resolveEffectiveContextLimit(input: {
	overrideTokens?: number | null;
	metadataTokens?: number | null;
}): EffectiveContextLimit {
	const override = toPositiveTokenCount(input.overrideTokens);
	const metadata = toPositiveTokenCount(input.metadataTokens);
	// Most-restrictive rule: the smaller known limit wins; a tie resolves to
	// the explicit override.
	if (override !== null && (metadata === null || override <= metadata)) {
		return { limitTokens: override, source: "override" };
	}
	if (metadata !== null) {
		return { limitTokens: metadata, source: "provider-metadata" };
	}
	// Conservative fallback matching the SDK's unconfigured default
	// (CLINE_SDK_DEFAULT_CONTEXT_WINDOW_TOKENS in sdk-runtime-boundary.ts).
	// The 262k figure in B-2.md is a reported operational ceiling and is never
	// used as the fallback.
	return { limitTokens: CONTEXT_LIMIT_FALLBACK_TOKENS, source: "fallback" };
}

/**
 * B-2.9: tier-0 context budget override from the user's global context
 * budget settings. Unlike the persisted provider-settings override (which is
 * reconciled against provider metadata by the most-restrictive rule), the
 * user's explicit budget wins outright over every other tier.
 * Returns null when no positive-integer override is set.
 */
export function resolveContextBudgetOverride(
	budgetOverrideTokens: number | null | undefined,
): EffectiveContextLimit | null {
	const limitTokens = toPositiveTokenCount(budgetOverrideTokens);
	return limitTokens === null ? null : { limitTokens, source: "override" };
}
