// B-2.2 — Unit tests for the pure effective-context-limit resolver
// (src/cline-sdk/cline-context-policy.ts): effective = min(known positive
// values) over {override, provider-metadata}; ties resolve to the explicit
// override; when neither tier is known the documented conservative fallback
// applies. Invalid values (zero, negative, fractional, non-numeric) are
// treated as unknown, never as "unlimited".

import { describe, expect, it } from "vitest";
import {
	CONTEXT_LIMIT_FALLBACK_TOKENS,
	resolveContextBudgetOverride,
	resolveEffectiveContextLimit,
} from "../../../src/cline-sdk/cline-context-policy";

describe("CONTEXT_LIMIT_FALLBACK_TOKENS", () => {
	it("is the documented conservative fallback, not the 262k operational ceiling", () => {
		expect(CONTEXT_LIMIT_FALLBACK_TOKENS).toBe(200_000);
	});
});

describe("resolveEffectiveContextLimit", () => {
	it("uses the smaller override when it is more restrictive than the metadata", () => {
		expect(resolveEffectiveContextLimit({ overrideTokens: 128_000, metadataTokens: 262_144 })).toEqual({
			limitTokens: 128_000,
			source: "override",
		});
	});

	it("uses the smaller metadata when it is more restrictive than the override", () => {
		expect(resolveEffectiveContextLimit({ overrideTokens: 200_000, metadataTokens: 131_072 })).toEqual({
			limitTokens: 131_072,
			source: "provider-metadata",
		});
	});

	it("resolves an exact tie to the explicit override", () => {
		expect(resolveEffectiveContextLimit({ overrideTokens: 131_072, metadataTokens: 131_072 })).toEqual({
			limitTokens: 131_072,
			source: "override",
		});
	});

	it("uses the override alone when the metadata tier is unknown", () => {
		expect(resolveEffectiveContextLimit({ overrideTokens: 64_000 })).toEqual({
			limitTokens: 64_000,
			source: "override",
		});
		expect(resolveEffectiveContextLimit({ overrideTokens: 64_000, metadataTokens: null })).toEqual({
			limitTokens: 64_000,
			source: "override",
		});
	});

	it("uses the metadata alone when the override tier is unknown", () => {
		expect(resolveEffectiveContextLimit({ metadataTokens: 262_144 })).toEqual({
			limitTokens: 262_144,
			source: "provider-metadata",
		});
		expect(resolveEffectiveContextLimit({ overrideTokens: null, metadataTokens: 262_144 })).toEqual({
			limitTokens: 262_144,
			source: "provider-metadata",
		});
	});

	it("falls back to the conservative limit when neither tier is known", () => {
		expect(resolveEffectiveContextLimit({})).toEqual({
			limitTokens: CONTEXT_LIMIT_FALLBACK_TOKENS,
			source: "fallback",
		});
		expect(resolveEffectiveContextLimit({ overrideTokens: null, metadataTokens: null })).toEqual({
			limitTokens: 200_000,
			source: "fallback",
		});
	});

	it.each([
		[0, 128_000, { limitTokens: 128_000, source: "provider-metadata" }],
		[-5, 128_000, { limitTokens: 128_000, source: "provider-metadata" }],
		[12.5, 128_000, { limitTokens: 128_000, source: "provider-metadata" }],
		[128_000, 0, { limitTokens: 128_000, source: "override" }],
		[128_000, -1, { limitTokens: 128_000, source: "override" }],
		[128_000, 7.25, { limitTokens: 128_000, source: "override" }],
	] as const)(
		"treats an invalid value as unknown (override=%s, metadata=%s)",
		(overrideTokens, metadataTokens, expected) => {
			expect(resolveEffectiveContextLimit({ overrideTokens, metadataTokens })).toEqual(expected);
		},
	);

	it("falls back when both tiers are invalid", () => {
		expect(resolveEffectiveContextLimit({ overrideTokens: 0, metadataTokens: -1 })).toEqual({
			limitTokens: 200_000,
			source: "fallback",
		});
	});
});

describe("resolveContextBudgetOverride (B-2.9 tier 0)", () => {
	it("returns an override-sourced limit for a positive integer budget override", () => {
		expect(resolveContextBudgetOverride(131_072)).toEqual({ limitTokens: 131_072, source: "override" });
	});

	it("returns null when no budget override is set", () => {
		expect(resolveContextBudgetOverride(null)).toBeNull();
		expect(resolveContextBudgetOverride(undefined)).toBeNull();
	});

	it.each([[0], [-5], [1.5], [Number.POSITIVE_INFINITY], [Number.NaN]] as const)(
		"treats an invalid budget override (%s) as unset",
		(value) => {
			expect(resolveContextBudgetOverride(value)).toBeNull();
		},
	);
});
