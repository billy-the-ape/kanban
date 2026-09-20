// B-2.3 — Unit tests for the pure context-budget estimator
// (src/cline-sdk/cline-context-budget.ts).
//
// Every value produced by the module is a labeled estimate (ESTIMATE):
// character-count heuristics stand in for a real tokenizer, and no provider,
// network, or SDK host is involved (unit-speed, table-driven only).
//
// Covers the B-2.md "Acceptance and tests" scenarios at the unit level:
// missing/mistaken metadata (fallback limit), an explicit smaller server
// limit, output reservations via the SDK reserve, tool-schema overhead, a
// single large next tool result, and near-limit history (0.79 vs 0.81
// utilization), plus the dedicated double-count rule test (the SDK reserve is
// the single source of truth for the output reservation).

import { describe, expect, it } from "vitest";
import {
	computeContextBudget,
	createFallbackMessageTokenEstimator,
	estimateRequestTokens,
	estimateTextTokens,
} from "../../../src/cline-sdk/cline-context-budget";
import {
	CONTEXT_LIMIT_FALLBACK_TOKENS,
	resolveEffectiveContextLimit,
} from "../../../src/cline-sdk/cline-context-policy";
import type { ClineSdkPersistedMessage } from "../../../src/cline-sdk/sdk-runtime-boundary";

type ClineSdkMessageBlocks = Extract<ClineSdkPersistedMessage["content"], unknown[]>;

const textMessage = (content: string): ClineSdkPersistedMessage => ({ role: "user", content });

const blockMessage = (blocks: ClineSdkMessageBlocks): ClineSdkPersistedMessage => ({ role: "user", content: blocks });

describe("estimateTextTokens (chars/4 estimate)", () => {
	it.each([
		[0, 0],
		[1, 1],
		[3, 1],
		[4, 1],
		[5, 2],
		[800, 200],
		[50_000, 12_500],
	] as const)("estimates %i characters as %i tokens (rounded up, estimate)", (chars, expectedTokens) => {
		expect(estimateTextTokens("x".repeat(chars))).toBe(expectedTokens);
	});
});

describe("createFallbackMessageTokenEstimator (documented chars/4 estimate fallback)", () => {
	const estimate = createFallbackMessageTokenEstimator();

	it("estimates string content by serialized length / 4", () => {
		expect(estimate(textMessage("x".repeat(800)))).toBe(200);
	});

	it.each([
		["a text block", () => blockMessage([{ type: "text", text: "x".repeat(800) }]), 200],
		[
			"a file block (path + content)",
			() => blockMessage([{ type: "file", path: "abcd", content: "x".repeat(795) }]),
			200,
		],
		[
			"a tool_use block (name + JSON input)",
			() => blockMessage([{ type: "tool_use", id: "t1", name: "abcd", input: {} }]),
			2,
		],
		[
			"a string tool_result",
			() => blockMessage([{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(800) }]),
			200,
		],
		[
			"a block tool_result (text + file)",
			() =>
				blockMessage([
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: [
							{ type: "text", text: "x".repeat(399) },
							{ type: "file", path: "abcd", content: "y".repeat(395) },
						],
					},
				]),
			200,
		],
		["a thinking block", () => blockMessage([{ type: "thinking", thinking: "x".repeat(800) }]), 200],
		[
			"a redacted_thinking block (encoded payload)",
			() => blockMessage([{ type: "redacted_thinking", data: "x".repeat(800) }]),
			200,
		],
		[
			"an image block (encoded payload)",
			() => blockMessage([{ type: "image", data: "x".repeat(800), mediaType: "image/png" }]),
			200,
		],
	] as const)("estimates %s as %i tokens", (_label, buildMessage, expectedTokens) => {
		expect(estimate(buildMessage())).toBe(expectedTokens);
	});

	describe("estimateRequestTokens (assembled request estimate)", () => {
		const fixedMessageEstimate = () => 50;

		it.each([
			[0, 0, 0, 0],
			[400, 0, 0, 100],
			[0, 800, 0, 200],
			[400, 800, 3, 450],
		] as const)(
			"system=%i chars + schemas=%i chars + %i messages → %i tokens (estimate)",
			(systemChars, schemaChars, messageCount, expectedTokens) => {
				const requestTokens = estimateRequestTokens({
					systemPrompt: "x".repeat(systemChars),
					toolSchemasJson: "y".repeat(schemaChars),
					messages: Array.from({ length: messageCount }, () => textMessage("z".repeat(200))),
					estimateMessageTokens: fixedMessageEstimate,
				});
				expect(requestTokens).toBe(expectedTokens);
			},
		);

		it("uses the injected estimator for messages and the chars/4 estimate for system and schemas", () => {
			const requestTokens = estimateRequestTokens({
				systemPrompt: "x".repeat(400), // → 100 tokens
				toolSchemasJson: "",
				messages: [textMessage("y".repeat(800))], // → 200 tokens via the fallback estimator
				estimateMessageTokens: createFallbackMessageTokenEstimator(),
			});
			expect(requestTokens).toBe(300);
		});
	});

	describe("computeContextBudget (estimate against the effective limit)", () => {
		it.each([
			["no reserve or margin", 100_000, 40_000, 10_000, 0, 0, 100_000, 60_000, true],
			[
				"fits at the inclusive boundary (request + next == budget)",
				100_000,
				40_000,
				60_000,
				0,
				0,
				100_000,
				60_000,
				true,
			],
			["does not fit one token past the boundary", 100_000, 40_000, 60_001, 0, 0, 100_000, 60_000, false],
			[
				"SDK reserve + safety margin shrink the input budget",
				100_000,
				40_000,
				10_000,
				16_384,
				4_000,
				79_616,
				39_616,
				true,
			],
			[
				"an over-budget request reports negative headroom",
				100_000,
				90_000,
				0,
				16_384,
				4_000,
				79_616,
				-10_384,
				false,
			],
		] as const)(
			"%s",
			(
				_,
				limitTokens,
				requestTokens,
				expectedNextInputTokens,
				sdkReserveTokens,
				safetyMarginTokens,
				expectedInputBudget,
				expectedHeadroom,
				expectedFits,
			) => {
				const budget = computeContextBudget({
					limitTokens,
					requestTokens,
					expectedNextInputTokens,
					sdkReserveTokens,
					safetyMarginTokens,
				});
				expect(budget.inputBudgetTokens).toBe(expectedInputBudget);
				expect(budget.headroomTokens).toBe(expectedHeadroom);
				expect(budget.fits).toBe(expectedFits);
			},
		);

		it.each([
			[100_000, 40_000, 0, 0, 0.4],
			[100_000, 79_000, 0, 0, 0.79],
			[100_000, 81_000, 0, 0, 0.81],
			[100_000, 40_000, 16_384, 4_000, 40_000 / 79_616],
		] as const)(
			"utilizationRatio estimate (limit=%i, request=%i, reserve=%i, margin=%i) → ≈%f",
			(limitTokens, requestTokens, sdkReserveTokens, safetyMarginTokens, expectedRatio) => {
				const budget = computeContextBudget({
					limitTokens,
					requestTokens,
					sdkReserveTokens,
					safetyMarginTokens,
				});
				expect(budget.utilizationRatio).toBeCloseTo(expectedRatio, 10);
			},
		);

		it("treats a non-positive input budget as fully utilized (no usable budget left)", () => {
			const budget = computeContextBudget({
				limitTokens: 16_000,
				requestTokens: 1_000,
				sdkReserveTokens: 16_384,
			});
			expect(budget.inputBudgetTokens).toBe(-384);
			expect(budget.headroomTokens).toBe(-1_384);
			expect(budget.utilizationRatio).toBe(Number.POSITIVE_INFINITY);
			expect(budget.fits).toBe(false);
		});
	});

	describe("B-2.md acceptance scenarios (deterministic unit cases, estimates)", () => {
		it("missing/mistaken metadata → the fallback limit (200k) still fits a large request", () => {
			const { limitTokens, source } = resolveEffectiveContextLimit({});
			expect(source).toBe("fallback");
			expect(limitTokens).toBe(CONTEXT_LIMIT_FALLBACK_TOKENS);
			const budget = computeContextBudget({ limitTokens, requestTokens: 175_000, expectedNextInputTokens: 15_000 });
			expect(budget.fits).toBe(true); // 190k estimate ≤ 200k
			expect(budget.utilizationRatio).toBeCloseTo(0.875, 10);
		});

		it("an explicit smaller server limit flips the same request to not-fit", () => {
			const { limitTokens, source } = resolveEffectiveContextLimit({ overrideTokens: 131_072 });
			expect(source).toBe("override");
			const budget = computeContextBudget({ limitTokens, requestTokens: 175_000, expectedNextInputTokens: 15_000 });
			expect(budget.fits).toBe(false); // 190k estimate > 131_072
		});

		it("an output reservation via sdkReserveTokens flips the same request to not-fit", () => {
			const limitTokens = resolveEffectiveContextLimit({ metadataTokens: 262_144 }).limitTokens;
			const withoutReserve = computeContextBudget({
				limitTokens,
				requestTokens: 175_000,
				expectedNextInputTokens: 80_000,
			});
			const withReserve = computeContextBudget({
				limitTokens,
				requestTokens: 175_000,
				expectedNextInputTokens: 80_000,
				sdkReserveTokens: 16_384,
			});
			expect(withoutReserve.fits).toBe(true); // 255k estimate ≤ 262_144
			expect(withReserve.fits).toBe(false); // 255k estimate > 245_760
			expect(withReserve.inputBudgetTokens).toBe(245_760);
		});

		it("tool-schema overhead (~50 KB schema JSON estimate) changes the decision", () => {
			const shared = {
				systemPrompt: "x".repeat(20_000), // → 5_000 tokens
				messages: [textMessage("y".repeat(720_000))], // → 180_000 tokens
				estimateMessageTokens: createFallbackMessageTokenEstimator(),
			};
			const limitTokens = resolveEffectiveContextLimit({}).limitTokens; // fallback 200k
			const requestWithoutSchemas = estimateRequestTokens({ ...shared, toolSchemasJson: "" });
			const requestWithSchemas = estimateRequestTokens({ ...shared, toolSchemasJson: "z".repeat(50_000) }); // → +12_500
			expect(requestWithoutSchemas).toBe(185_000);
			expect(requestWithSchemas).toBe(197_500);
			const budgetWithoutSchemas = computeContextBudget({
				limitTokens,
				requestTokens: requestWithoutSchemas,
				expectedNextInputTokens: 15_000,
			});
			const budgetWithSchemas = computeContextBudget({
				limitTokens,
				requestTokens: requestWithSchemas,
				expectedNextInputTokens: 15_000,
			});
			expect(budgetWithoutSchemas.fits).toBe(true); // 185k + 15k == 200k boundary
			expect(budgetWithSchemas.fits).toBe(false); // 197.5k + 15k > 200k
		});

		it("a single large next tool result (200k chars estimate) flips fits", () => {
			const limitTokens = resolveEffectiveContextLimit({}).limitTokens;
			const requestTokens = estimateRequestTokens({
				systemPrompt: "x".repeat(80_000), // → 20_000 tokens
				toolSchemasJson: "",
				messages: [textMessage("y".repeat(560_000))], // → 140_000 tokens
				estimateMessageTokens: createFallbackMessageTokenEstimator(),
			});
			expect(requestTokens).toBe(160_000);
			const withoutNext = computeContextBudget({ limitTokens, requestTokens });
			const withNext = computeContextBudget({
				limitTokens,
				requestTokens,
				expectedNextInputTokens: estimateTextTokens("q".repeat(200_000)), // → 50_000 tokens
			});
			expect(withoutNext.fits).toBe(true);
			expect(withNext.fits).toBe(false); // 160k + 50k > 200k
		});

		it.each([
			[158_000, 0.79, true],
			[162_000, 0.81, true],
		] as const)(
			"near-limit history: request=%i of the 200k fallback budget → utilizationRatio≈%f (estimate), fits=%s",
			(requestTokens, expectedRatio, expectedFits) => {
				const limitTokens = resolveEffectiveContextLimit({}).limitTokens;
				const budget = computeContextBudget({ limitTokens, requestTokens });
				expect(budget.utilizationRatio).toBeCloseTo(expectedRatio, 10);
				expect(budget.fits).toBe(expectedFits);
			},
		);
	});

	describe("double-count rule (the SDK reserve is the single source of truth for output)", () => {
		it("returns identical budgets with and without expectedOutputTokens for the same reserve", () => {
			const base = {
				limitTokens: 200_000,
				requestTokens: 150_000,
				expectedNextInputTokens: 20_000,
				sdkReserveTokens: 16_384,
			};
			const withoutExpectedOutput = computeContextBudget(base);
			const withExpectedOutput = computeContextBudget({ ...base, expectedOutputTokens: 32_000 });
			expect(withExpectedOutput.inputBudgetTokens).toBe(withoutExpectedOutput.inputBudgetTokens);
			expect(withExpectedOutput).toEqual(withoutExpectedOutput);
		});
	});
});
