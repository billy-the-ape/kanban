// B-2.3 (part 1 of 2) — Pure token-budget math for the next assembled request.
//
// Given the effective context limit (resolved by B-2.2,
// src/cline-sdk/cline-context-policy.ts) and an estimate of the assembled
// request (system prompt, serialized tool schemas, current messages, expected
// next input), this module answers: does the request fit, and how full is the
// input budget? It is pure and dependency-free so the math can be unit-tested
// without any provider, settings, network, or SDK host involvement.
//
// All outputs are ESTIMATES. Token counts come from character-count heuristics
// or a caller-injected estimator; a provider tokenizer is never consulted.
// Consumers must present them as estimates (B-2.md acceptance: "Label
// approximate estimates as estimates").
//
// DOUBLE-COUNT RULE — single source of truth for the output reservation:
// the SDK compaction reserve (`CoreCompactionConfig.reserveTokens`, wired in
// B-2.4) is the only place expected output is subtracted from the limit, via
// `sdkReserveTokens`. If that reserve covers the expected output, this module
// must NOT subtract `expectedOutputTokens` a second time; the parameter is
// accepted for reporting only and never enters the math.
//
// ESTIMATOR PROVENANCE (gap recorded per docs/plans/B-2-3.md):
// @clinebot/core 0.0.38 declares `estimateTokens` / `createTokenEstimator` in
// `dist/extensions/context/compaction-shared.d.ts`, but neither is re-exported
// from the public package entry (verified in dist/index.d.ts), and deep
// `dist/` imports are disallowed. This module therefore provides a documented
// chars/4 fallback (`estimateTextTokens` + `createFallbackMessageTokenEstimator`)
// that mirrors the SDK's approach. When the SDK publishes a public estimator,
// swap the fallback for it.

import type { ClineSdkPersistedMessage } from "./sdk-runtime-boundary";

/**
 * Per-message token estimator, injected by the caller so the budget math
 * stays pure and unit-testable. This mirrors the SDK's private
 * `EstimateMessageTokens` (dist/extensions/context/compaction-shared.d.ts),
 * which is not publicly exported; use `createFallbackMessageTokenEstimator`
 * until a public SDK estimator exists.
 */
export type ClineSdkEstimateMessageTokens = (message: ClineSdkPersistedMessage) => number;

export interface EstimateRequestTokensInput {
	/** Assembled system prompt text. */
	systemPrompt: string;
	/** Serialized tool-schema JSON exactly as it will be sent to the provider. */
	toolSchemasJson: string;
	/** Current conversation history (as persisted by the SDK). */
	messages: ClineSdkPersistedMessage[];
	/** Per-message token estimator (see `ClineSdkEstimateMessageTokens`). */
	estimateMessageTokens: ClineSdkEstimateMessageTokens;
}

export interface ComputeContextBudgetInput {
	/** Effective context limit in tokens (from `resolveEffectiveContextLimit`). */
	limitTokens: number;
	/** Estimated tokens of the assembled request (from `estimateRequestTokens`). */
	requestTokens: number;
	/** Estimated tokens of the expected next input (e.g. an incoming tool result). */
	expectedNextInputTokens?: number;
	/**
	 * Expected output in tokens. REPORTING ONLY: the SDK reserve
	 * (`sdkReserveTokens`) is the single source of truth for the output
	 * reservation, so this value is never subtracted here (double-count rule).
	 */
	expectedOutputTokens?: number;
	/** Extra safety margin in tokens, subtracted from the limit. */
	safetyMarginTokens?: number;
	/**
	 * The SDK compaction reserve (`CoreCompactionConfig.reserveTokens`, B-2.4)
	 * in tokens. When it covers the expected output, expected output must not
	 * be subtracted a second time (double-count rule).
	 */
	sdkReserveTokens?: number;
}

export interface ContextBudget {
	/** `limitTokens - sdkReserveTokens - safetyMarginTokens`; tokens available to the assembled request. */
	inputBudgetTokens: number;
	/** `inputBudgetTokens - requestTokens`; negative means the request is already over budget. */
	headroomTokens: number;
	/** `requestTokens / inputBudgetTokens`; `Infinity` when the input budget is not positive (nothing usable left — treat as fully utilized). */
	utilizationRatio: number;
	/** `requestTokens + expectedNextInputTokens <= inputBudgetTokens` (inclusive boundary). */
	fits: boolean;
}

/**
 * Rough token estimate for a string: assumes ~4 characters per token and
 * rounds up, so it never under-estimates the string's share. This is an
 * ESTIMATE — a real tokenizer may differ in either direction, and length is
 * counted in UTF-16 code units, so non-ASCII text is estimated less
 * accurately (CJK in particular).
 */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Serializes one persisted message's content into the text that dominates its
 * request size, following the SDK boundary block shapes
 * (`ClineSdkPersistedMessage` = @clinebot/shared `MessageWithMetadata`, see
 * src/cline-sdk/sdk-runtime-boundary.ts). Image and redacted-thinking blocks
 * carry base64 payloads that travel verbatim in the request, so their encoded
 * length is estimated directly (actual vision token cost is provider-specific
 * — still an estimate). Small wrapper fields (ids, signatures, call ids) are
 * not modeled.
 */
function serializeMessageContent(message: ClineSdkPersistedMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "file":
					return `${block.path}\n${block.content}`;
				case "tool_use":
					return `${block.name} ${JSON.stringify(block.input)}`;
				case "tool_result":
					return typeof block.content === "string"
						? block.content
						: block.content
								.map((part) => {
									switch (part.type) {
										case "text":
											return part.text;
										case "file":
											return `${part.path}\n${part.content}`;
										case "image":
											return part.data;
										default: {
											const exhaustive: never = part;
											return exhaustive;
										}
									}
								})
								.join("\n");
				case "thinking":
					return block.thinking;
				case "redacted_thinking":
					return block.data;
				case "image":
					return block.data;
				default: {
					// Exhaustiveness check: if the SDK boundary adds a block
					// type, this stops compiling until it is handled above.
					const exhaustive: never = block;
					return exhaustive;
				}
			}
		})
		.join("\n");
}

/**
 * Creates the documented chars/4 fallback per-message estimator: serialize
 * the message content (SDK boundary block shapes) and estimate the serialized
 * length at ~4 characters per token. This is an ESTIMATE. It mirrors the SDK's
 * private `createTokenEstimator()` (not publicly exported in 0.0.38); swap for
 * the SDK estimator when it is exported from the public entry.
 */
export function createFallbackMessageTokenEstimator(): ClineSdkEstimateMessageTokens {
	return (message: ClineSdkPersistedMessage) => estimateTextTokens(serializeMessageContent(message));
}

/**
 * Estimates the total token size of the next assembled request:
 * system prompt + serialized tool-schema JSON + the sum of the per-message
 * estimates. Every term is an ESTIMATE (see module header).
 */
export function estimateRequestTokens(input: EstimateRequestTokensInput): number {
	const messageTokens = input.messages.reduce((total, message) => total + input.estimateMessageTokens(message), 0);
	return estimateTextTokens(input.systemPrompt) + estimateTextTokens(input.toolSchemasJson) + messageTokens;
}

/**
 * Compares an estimated assembled request against the effective context limit.
 *
 * Formulas (all values are ESTIMATES):
 * - `inputBudgetTokens = limitTokens - sdkReserveTokens - safetyMarginTokens`
 *   (the SDK reserve already covers expected output — double-count rule;
 *   `expectedOutputTokens` is accepted for reporting only)
 * - `headroomTokens = inputBudgetTokens - requestTokens`
 * - `utilizationRatio = requestTokens / inputBudgetTokens` (Infinity when the
 *   budget is not positive)
 * - `fits = requestTokens + expectedNextInputTokens <= inputBudgetTokens`
 *   (equivalently `headroomTokens >= expectedNextInputTokens`)
 */
export function computeContextBudget(input: ComputeContextBudgetInput): ContextBudget {
	const expectedNextInputTokens = input.expectedNextInputTokens ?? 0;
	const sdkReserveTokens = input.sdkReserveTokens ?? 0;
	const safetyMarginTokens = input.safetyMarginTokens ?? 0;
	const inputBudgetTokens = input.limitTokens - sdkReserveTokens - safetyMarginTokens;
	const headroomTokens = inputBudgetTokens - input.requestTokens;
	const utilizationRatio = inputBudgetTokens > 0 ? input.requestTokens / inputBudgetTokens : Number.POSITIVE_INFINITY;
	const fits = input.requestTokens + expectedNextInputTokens <= inputBudgetTokens;
	return { inputBudgetTokens, headroomTokens, utilizationRatio, fits };
}
