// B-2-10 — B-2 acceptance matrix (B-2.md "Acceptance and tests").
//
// Covers the six B-2 acceptance scenarios against a fake OpenAI-compatible
// provider with its own tokenizer/limit accounting
// (test/utilities/fake-openai-provider.ts):
//
// S1 missing/mistaken provider metadata — the documented fallback governs
//    when no capacity is known; a mistaken *larger* metadata value is capped
//    by the operator override (most-restrictive rule); smaller metadata still
//    wins (provider-service level, hermetic fetch stubs).
// S2 an explicit smaller server limit — the persisted provider override and
//    the tier-0 global context budget both win over larger metadata, and the
//    explicit limit is recorded as the source on every session start (S3 e2e).
// S3 output reservations — the expected output is reserved and subtracted
//    exactly once across build → calibrate → beforeModel hook (no double
//    count); e2e: every provider request leaves the reserved output room.
// S4 tool-schema overhead — a large tool schema JSON shifts the compaction
//    trigger down by exactly the schema's estimated size (calibration +
//    beforeModel hook level).
// S5 a large next tool result — an oversized run_commands result is bounded
//    at ingestion (line excerpt + local artifact reference) so the follow-up
//    request fits the window and the provider never rejects it (real local
//    SDK session driven through a scripted SSE tool call).
// S6 near-limit history — 0.79/0.81 utilization matrix around the ~80%
//    trigger (deterministic hook level) plus a multi-round e2e session whose
//    un-compacted history would overflow the window: zero provider overflow
//    errors.
//
// @clinebot/core is PARTIALLY mocked: the real ClineCore class stays so S3/S5/
// S6 boot real local SDK session hosts (no fake host), while the
// provider-settings and model-catalog exports are stubbed so S1/S2 stay
// hermetic (no real HOME reads, no catalog network).
//
// All token values are chars/4 ESTIMATES (B-2.3 fallback estimator); the
// assertions and session logs label them as such. The e2e tests are slower
// than the rest of the directory because they boot a real SDK host and make
// real HTTP requests to a localhost provider — the timeouts below are
// intentional.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClineCore } from "@clinebot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClineCompactionBeforeModelHook } from "../../../src/cline-sdk/cline-compaction-before-model-hook";
import {
	buildClineCompactionConfig,
	type ClineCompactionToolSchema,
	calibrateClineCompactionConfig,
	computeClineCompactionSafetyMarginTokens,
	estimateClineToolSchemaTokens,
} from "../../../src/cline-sdk/cline-compaction-config";
import { estimateTextTokens } from "../../../src/cline-sdk/cline-context-budget";
import { CONTEXT_LIMIT_FALLBACK_TOKENS } from "../../../src/cline-sdk/cline-context-policy";
import {
	createClineProviderService,
	type ResolvedClineLaunchConfig,
} from "../../../src/cline-sdk/cline-provider-service";
import { createInMemoryClineSessionRuntime } from "../../../src/cline-sdk/cline-session-runtime";
import {
	type ClineTaskSessionService,
	createInMemoryClineTaskSessionService,
} from "../../../src/cline-sdk/cline-task-session-service";
import { computeToolResultBoundChars } from "../../../src/cline-sdk/cline-tool-result-bounding-hook";
import type {
	ClineSdkAgentBeforeModelContext,
	ClineSdkAgentMessage,
	ClineSdkAgentMessagePart,
} from "../../../src/cline-sdk/sdk-runtime-boundary";
import { readTaskContextArtifact } from "../../../src/workspace/task-artifacts";
import { createFakeMcpRuntimeService, createFakeRuntimeSetup } from "../../utilities/cline-session-service-harness";
import {
	createFakeOpenAiProvider,
	type FakeOpenAiProvider,
	type FakeOpenAiProviderOptions,
} from "../../utilities/fake-openai-provider";

const providerSettingsMocks = vi.hoisted(() => ({
	getProviderSettings: vi.fn(),
	getLastUsedProviderSettings: vi.fn(),
	saveProviderSettings: vi.fn(),
}));

const providerModelMocks = vi.hoisted(() => ({
	getLocalProviderModels: vi.fn(),
	resolveProviderConfig: vi.fn(),
	resolveProviderModelCatalogKeys: vi.fn(),
}));

const runtimeConfigMocks = vi.hoisted(() => ({
	readGlobalRuntimeContextBudget: vi.fn(),
}));

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
	deleteTaskTurnCheckpointRef: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
	getTaskWorktreesHomePath: vi.fn(),
}));

// Partial mock: keep the REAL @clinebot/core (ClineCore, hooks, session
// runtime, ...) for the e2e scenarios; stub only the provider-settings and
// model-catalog surface so the S1/S2 provider-service tests stay hermetic.
vi.mock("@clinebot/core", async (importOriginal) => {
	const original = await importOriginal<typeof import("@clinebot/core")>();
	return {
		...original,
		getLocalProviderModels: providerModelMocks.getLocalProviderModels,
		resolveProviderConfig: providerModelMocks.resolveProviderConfig,
		Llms: {
			...original.Llms,
			resolveProviderModelCatalogKeys: providerModelMocks.resolveProviderModelCatalogKeys,
		},
		ProviderSettingsManager: class {
			saveProviderSettings = providerSettingsMocks.saveProviderSettings;
			getProviderSettings = providerSettingsMocks.getProviderSettings;
			getLastUsedProviderSettings = providerSettingsMocks.getLastUsedProviderSettings;
			getProviderConfig = vi.fn((providerId: string) => {
				const settings = providerSettingsMocks.getProviderSettings(providerId);
				if (!settings) {
					return undefined;
				}
				return {
					providerId: settings.provider,
					apiKey: settings.apiKey,
					modelId: settings.model,
					baseUrl: settings.baseUrl,
				};
			});
			getFilePath = vi.fn(() => "/tmp/context-budget-acceptance-provider-settings.json");
			read = vi.fn(() => ({ providers: {} }));
			write = vi.fn();
		},
	};
});

// B-2.9: resolveLaunchConfig reads the global context budget from the
// runtime config; keep the test hermetic (no real HOME reads).
vi.mock("../../../src/config/runtime-config", () => ({
	readGlobalRuntimeContextBudget: runtimeConfigMocks.readGlobalRuntimeContextBudget,
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
	deleteTaskTurnCheckpointRef: turnCheckpointMocks.deleteTaskTurnCheckpointRef,
}));

vi.mock("../../../src/state/workspace-state.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/state/workspace-state")>();
	return {
		...original,
		getTaskWorktreesHomePath: workspaceStateMocks.getTaskWorktreesHomePath,
	};
});

beforeEach(() => {
	turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
	turnCheckpointMocks.deleteTaskTurnCheckpointRef.mockReset();
	turnCheckpointMocks.captureTaskTurnCheckpoint.mockImplementation(
		async (input: { taskId: string; turn: number }) => ({
			turn: input.turn,
			ref: `refs/kanban/checkpoints/${input.taskId}/turn/${input.turn}`,
			commit: `commit-${input.turn}`,
			createdAt: input.turn,
		}),
	);
	turnCheckpointMocks.deleteTaskTurnCheckpointRef.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// S1 + S2 — context-limit resolution (provider-service level, hermetic).
// ---------------------------------------------------------------------------

function stubLiteLlmFetch(responses: Record<string, { status?: number; json?: unknown }>): void {
	const fetchMock = vi.fn(async (input: unknown) => {
		const url = String(input);
		const entry = Object.entries(responses).find(([pathname]) => url.endsWith(pathname));
		if (!entry) {
			throw new Error(`Unexpected fetch URL in test: ${url}`);
		}
		const { status = 200, json = {} } = entry[1];
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => json,
		} as unknown as Response;
	});
	vi.stubGlobal("fetch", fetchMock);
}

function setLastUsedLitellmSettings(settings: { model: string; contextWindow?: number }): void {
	const providerSettings = {
		provider: "litellm",
		model: settings.model,
		apiKey: "litellm-key",
		baseUrl: "http://127.0.0.1:4000",
		...(settings.contextWindow !== undefined ? { contextWindow: settings.contextWindow } : {}),
	};
	providerSettingsMocks.getProviderSettings.mockImplementation((providerId: string) =>
		providerId === "litellm" ? providerSettings : undefined,
	);
	providerSettingsMocks.getLastUsedProviderSettings.mockReturnValue(providerSettings);
}

describe("S1 + S2 — effective context-limit resolution (provider service)", () => {
	beforeEach(() => {
		providerSettingsMocks.getProviderSettings.mockReset();
		providerSettingsMocks.getLastUsedProviderSettings.mockReset();
		providerSettingsMocks.saveProviderSettings.mockReset();
		providerModelMocks.getLocalProviderModels.mockReset();
		providerModelMocks.resolveProviderConfig.mockReset();
		providerModelMocks.resolveProviderModelCatalogKeys.mockReset();
		runtimeConfigMocks.readGlobalRuntimeContextBudget.mockReset();
		providerModelMocks.getLocalProviderModels.mockResolvedValue({ providerId: "", models: [] });
		providerModelMocks.resolveProviderConfig.mockResolvedValue(undefined);
		providerModelMocks.resolveProviderModelCatalogKeys.mockImplementation((providerId: string) => [providerId]);
		providerSettingsMocks.getLastUsedProviderSettings.mockReturnValue(undefined);
		providerSettingsMocks.getProviderSettings.mockImplementation(() => undefined);
		runtimeConfigMocks.readGlobalRuntimeContextBudget.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("S1: missing provider metadata — the documented conservative fallback governs", async () => {
		const service = createClineProviderService();
		setLastUsedLitellmSettings({ model: "qwen3-32b" });
		stubLiteLlmFetch({
			"/models": { status: 404 },
			// Server reachable but reports no capacity for the model.
			"/model/info": { json: { data: [] } },
		});

		const config = await service.resolveLaunchConfig();

		expect(config.providerId).toBe("litellm");
		expect(config.modelId).toBe("qwen3-32b");
		expect(config.contextWindowTokens).toBe(CONTEXT_LIMIT_FALLBACK_TOKENS);
		expect(config.contextWindowSource).toBe("fallback");
	});

	it("S1: a mistaken LARGER metadata value is capped by the operator override (most-restrictive rule)", async () => {
		const service = createClineProviderService();
		// Operator override: the limit actually served by the local model.
		setLastUsedLitellmSettings({ model: "qwen3-32b", contextWindow: 131_072 });
		// Mistaken metadata: the model claims twice the served capacity.
		stubLiteLlmFetch({
			"/models": { status: 404 },
			"/model/info": {
				json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 262_144 }] },
			},
		});

		const config = await service.resolveLaunchConfig();

		expect(config.contextWindowTokens).toBe(131_072);
		expect(config.contextWindowSource).toBe("override");
	});

	it("S1: metadata smaller than the override still governs (most restrictive known limit wins)", async () => {
		const service = createClineProviderService();
		setLastUsedLitellmSettings({ model: "qwen3-32b", contextWindow: 131_072 });
		stubLiteLlmFetch({
			"/models": { status: 404 },
			"/model/info": {
				json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 32_768 }] },
			},
		});

		const config = await service.resolveLaunchConfig();

		expect(config.contextWindowTokens).toBe(32_768);
		expect(config.contextWindowSource).toBe("provider-metadata");
	});

	it("S2: an explicit smaller server limit (persisted override) governs over larger metadata", async () => {
		const service = createClineProviderService();
		setLastUsedLitellmSettings({ model: "qwen3-32b", contextWindow: 16_384 });
		stubLiteLlmFetch({
			"/models": { status: 404 },
			"/model/info": {
				json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 131_072 }] },
			},
		});

		const config = await service.resolveLaunchConfig();

		expect(config.contextWindowTokens).toBe(16_384);
		expect(config.contextWindowSource).toBe("override");
	});

	it("S2: the tier-0 global context budget override wins over every other tier", async () => {
		const service = createClineProviderService();
		setLastUsedLitellmSettings({ model: "qwen3-32b" });
		stubLiteLlmFetch({
			"/models": { status: 404 },
			"/model/info": {
				json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 131_072 }] },
			},
		});
		runtimeConfigMocks.readGlobalRuntimeContextBudget.mockResolvedValue({
			contextWindowOverrideTokens: 8_192,
		});

		const config = await service.resolveLaunchConfig();

		expect(config.contextWindowTokens).toBe(8_192);
		expect(config.contextWindowSource).toBe("override");
	});
});

// ---------------------------------------------------------------------------
// S3 — output reservations (the expected output is reserved exactly once).
// ---------------------------------------------------------------------------

const WINDOW = 8_000;
const MAX_TOKENS = 500;
const SYSTEM_PROMPT = "You are a concise test assistant. Reply in one short sentence.";
const ROUNDS = 12;

describe("S3 — output reservations", () => {
	it("subtracts the expected output exactly once across build → calibrate → hook budget", () => {
		const launchConfig: ResolvedClineLaunchConfig = {
			providerId: "ollama",
			modelId: "probe-model",
			apiKey: "sk-test-key",
			baseUrl: "http://127.0.0.1:9/v1",
			contextWindowTokens: WINDOW,
			contextWindowSource: "override",
			maxTokens: MAX_TOKENS,
		};
		// B-2.4: when the provider reports max output tokens, the reserve is
		// that number (not the 16k documented default).
		const built = buildClineCompactionConfig({ launchConfig });
		expect(built.reserveTokens).toBe(MAX_TOKENS);
		const margin = computeClineCompactionSafetyMarginTokens(WINDOW);
		const { config: calibrated, breakdown } = calibrateClineCompactionConfig({
			config: built,
			systemPrompt: SYSTEM_PROMPT,
		});
		expect(breakdown).not.toBeNull();
		const b = breakdown!;
		// No double count: the output reserve appears exactly once, folded
		// with the safety margin (never twice the output). All estimates.
		expect(b.reserveTokens).toBe(MAX_TOKENS + margin);
		expect(b.contextWindowTokens).toBe(WINDOW - b.systemPromptTokens - b.toolSchemaTokens);
		expect(b.triggerTokens).toBe(b.contextWindowTokens - b.reserveTokens);
		expect(calibrated.reserveTokens).toBe(MAX_TOKENS + margin);
		// The beforeModel hook enforces the same budget:
		// limit - output reserve - safety margin (messages + system + tools).
		expect(b.triggerTokens + b.systemPromptTokens + b.toolSchemaTokens).toBe(WINDOW - MAX_TOKENS - margin);
	});

	it("S3 (e2e): every provider request leaves the reserved output room, and the explicit limit source is logged", async () => {
		const session = await runMultiRoundSession({
			taskId: "task-b210-s3",
			rounds: ROUNDS,
			reply: "The quick brown fox jumps over the lazy dog. ".repeat(80).trim(),
		});
		try {
			const { provider, logPath } = session;
			// Every request the provider received (its own chars/4 estimate)
			// fits the window WITH the reserved output (MAX_TOKENS) still in
			// it — the reserve covered the expected output.
			expect(provider.requests.length).toBeGreaterThanOrEqual(ROUNDS);
			for (const request of provider.requests) {
				expect(request.tokenCount + MAX_TOKENS).toBeLessThanOrEqual(WINDOW);
				expect(request.exceededContextLimit).toBe(false);
			}
			// The calibration log records the single-counted reserve
			// (output + margin, estimates) for the assembled request.
			const logEntries = readSessionLog(logPath);
			const calibration = logEntries.find((entry) =>
				entry.message?.includes("Cline compaction calibrated for the assembled request"),
			);
			expect(calibration?.metadata?.reserveTokens).toBe(
				MAX_TOKENS + computeClineCompactionSafetyMarginTokens(WINDOW),
			);
			// The session-start log records the explicit (override) limit and
			// its source — S2's small explicit limit governs the session.
			const start = logEntries.find((entry) =>
				entry.message?.includes("Cline session start: effective context metadata"),
			);
			expect(start?.metadata?.contextLimitTokens).toBe(WINDOW);
			expect(start?.metadata?.contextLimitSource).toBe("override");
			// No summarizer round-trip: in local mode the deterministic
			// compactor rewrites the request locally, so every provider
			// request is a user round (no extra model calls).
			for (const request of provider.requests) {
				expect(request.lastMessage).toMatch(/^Round \d+:/);
			}
		} finally {
			await session.dispose();
		}
	}, 150_000);
});

// ---------------------------------------------------------------------------
// S4 — tool-schema overhead (a large schema JSON changes the trigger).
// ---------------------------------------------------------------------------

describe("S4 — tool-schema overhead", () => {
	const LARGE_TOOL: ClineCompactionToolSchema = {
		name: "large_tool",
		description: "d".repeat(3_000),
		inputSchema: {
			type: "object",
			properties: Object.fromEntries(
				Array.from({ length: 40 }, (_, i) => [`prop_${i}`, { type: "string", description: "p".repeat(30) }]),
			),
		},
	};

	it("shifts the calibrated trigger down by exactly the schema's estimated size", () => {
		const launchConfig: ResolvedClineLaunchConfig = {
			providerId: "ollama",
			modelId: "probe-model",
			apiKey: "sk-test-key",
			baseUrl: "http://127.0.0.1:9/v1",
			contextWindowTokens: WINDOW,
			contextWindowSource: "override",
			maxTokens: MAX_TOKENS,
		};
		const built = buildClineCompactionConfig({ launchConfig });
		const base = calibrateClineCompactionConfig({ config: built, systemPrompt: SYSTEM_PROMPT });
		const withSchema = calibrateClineCompactionConfig({
			config: built,
			systemPrompt: SYSTEM_PROMPT,
			extraTools: [LARGE_TOOL],
		});
		// The large schema is well beyond the built-in tool-set estimate.
		const schemaTokens = estimateClineToolSchemaTokens([LARGE_TOOL]);
		expect(schemaTokens).toBeGreaterThan(1_000);
		// The trigger moves down by exactly the schema's estimated size
		// (chars/4 estimate) relative to the no-extra-tools calibration —
		// the same message history now compacts earlier. The no-tools
		// baseline estimates the empty extras array as "[]" (1 token), so
		// subtract that from the delta.
		const noExtraSchemaTokens = estimateClineToolSchemaTokens([]);
		const baseTrigger = base.breakdown?.triggerTokens ?? 0;
		const withSchemaTrigger = withSchema.breakdown?.triggerTokens ?? 0;
		expect(withSchemaTrigger).toBe(baseTrigger - (schemaTokens - noExtraSchemaTokens));
		expect(withSchemaTrigger).toBeLessThan(baseTrigger);
	});

	it("compacts the same history only when the large schema is present (beforeModel hook)", async () => {
		const hook = createClineCompactionBeforeModelHook({
			limitTokens: WINDOW,
			outputReserveTokens: MAX_TOKENS,
		});
		// 10 messages × 300 estimated tokens = 3_000 tokens of conversation —
		// fits the hook's request budget when no schema overhead is present,
		// but not once the large schema's estimate is subtracted.
		const messages: ClineSdkAgentMessage[] = [];
		for (let i = 0; i < 10; i += 1) {
			messages.push(agentMessage(i % 2 === 0 ? "user" : "assistant", [sizedTextPart(300)]));
		}
		expect(await hook(makeBeforeModelRequest(messages, { systemPrompt: "system", tools: [] }))).toBeUndefined();

		const bigTools: ClineCompactionToolSchema[] = [
			{ name: "big", description: "d".repeat(4_700), inputSchema: { type: "object", properties: {} } },
		];
		const result = await hook(makeBeforeModelRequest(messages, { systemPrompt: "system", tools: bigTools }));
		expect(result).toBeDefined();
		expect(result?.messages?.length ?? 0).toBeLessThan(messages.length);
		// The rewritten messages fit the shrunken budget:
		// limit - output reserve - safety margin - system - tool schemas (estimates).
		const budget =
			WINDOW -
			MAX_TOKENS -
			computeClineCompactionSafetyMarginTokens(WINDOW) -
			estimateTextTokens("system") -
			estimateClineToolSchemaTokens(bigTools);
		expect(sumAgentMessageTokens(result?.messages ?? [])).toBeLessThanOrEqual(budget);
	});
});

// ---------------------------------------------------------------------------
// S5 — a large next tool result (bound + compaction before rejection).
// ---------------------------------------------------------------------------

const S5_TASK_ID = "task-b210-s5";
const HEAD_MARKER = "B210-HEAD-MARKER";
const TAIL_MARKER = "B210-TAIL-MARKER";
const MIDDLE_LINE = `line-4000 ${"m".repeat(90)}`;
// ~800 KB of command output: far beyond the bounded excerpt (and under the
// SDK executor's 1 MB maxOutputBytes), so an unbounded result would overflow
// the 8k provider window many times over on the follow-up request.
const BIG_COMMAND_OUTPUT = [
	HEAD_MARKER,
	...Array.from({ length: 7_998 }, (_, index) =>
		index + 2 === 4_000 ? MIDDLE_LINE : `line-${index + 2} ${"m".repeat(90)}`,
	),
	TAIL_MARKER,
].join("\n");

describe("S5 — a large next tool result (real local SDK session)", () => {
	it("bounds the oversized result before the follow-up request can overflow the provider", async () => {
		// 10% of the 8k window is 800 tokens (3_200 chars) — below the 4_000
		// floor, so the floor governs for this window.
		const boundChars = computeToolResultBoundChars(WINDOW);
		expect(boundChars).toBe(4_000);

		const session = await startToolFlowSession();
		try {
			const { provider, service } = session;
			// 1. Zero overflow: the provider never rejected, and the follow-up
			//    request (which would carry ~800 KB unbounded) fits the window.
			expect(provider.requests.length).toBeGreaterThanOrEqual(2);
			for (const request of provider.requests) {
				expect(request.exceededContextLimit).toBe(false);
				expect(request.tokenCount + MAX_TOKENS).toBeLessThanOrEqual(WINDOW);
			}
			// 2. What the provider saw as the tool result is the bounded
			//    excerpt: head + tail markers present, the middle absent, a
			//    local artifact reference, and at most the bounded length.
			const followUp = provider.requests[1];
			const seen = followUp?.lastMessage ?? "";
			expect(seen).toContain(HEAD_MARKER);
			expect(seen).toContain(TAIL_MARKER);
			expect(seen).not.toContain(MIDDLE_LINE);
			expect(seen).toMatch(/\[truncated \d+ lines; full output: [^\]]+\]/);
			expect(seen.length).toBeLessThanOrEqual(boundChars + 512);
			// 3. The persisted transcript carries the same bounded excerpt.
			const toolMessages = service
				.listMessages(S5_TASK_ID)
				.filter((message) => message.role === "tool" && message.meta?.toolName === "run_commands");
			expect(toolMessages.length).toBe(1);
			const content = toolMessages[0]!.content;
			expect(content).toContain("Command 1/1: cat ");
			expect(content).toContain("Exit status: success");
			expect(content).toContain(HEAD_MARKER);
			expect(content).toContain(TAIL_MARKER);
			expect(content).not.toContain(MIDDLE_LINE);
			expect(content).toMatch(/\.\.\. \[truncated \d+ lines; full output: [^\]]+\]/);
			expect(content.length).toBeLessThanOrEqual(boundChars + 512);
			// 4. The full output is preserved as a local artifact — including
			//    the middle lines the excerpt dropped.
			const reference = content.match(/\[truncated \d+ lines; full output: ([^\]]+)\]/)![1]!.trim();
			const artifact = JSON.parse(await readTaskContextArtifact(reference)) as Array<{
				query: string;
				result?: string;
				success?: boolean;
			}>;
			expect(artifact).toHaveLength(1);
			expect(artifact[0]?.query).toContain("cat ");
			expect(artifact[0]?.success).toBe(true);
			expect(artifact[0]?.result).toContain(MIDDLE_LINE);
			expect(artifact[0]?.result?.length).toBeGreaterThan(700_000);
			// 5. The session stayed healthy through the whole flow.
			const summary = service.getSummary(S5_TASK_ID);
			expect(["running", "awaiting_review", "idle"]).toContain(summary?.state);
			expect(summary?.reviewReason).not.toBe("error");
		} finally {
			await session.dispose();
		}
	}, 150_000);
});

// ---------------------------------------------------------------------------
// S6 — near-limit history (0.79/0.81 matrix, no provider overflow error).
// ---------------------------------------------------------------------------

describe("S6 — near-limit history", () => {
	// With the B-2.9 user-set margin, the trigger sits at ~80% utilization:
	// request budget = 10_000 - 500 (output reserve) - 1_500 (margin) = 8_000.
	const S6_LIMIT = 10_000;
	const S6_OUTPUT_RESERVE = 500;
	const S6_MARGIN = 1_500;
	const S6_SYSTEM_PROMPT = "system prompt";

	function makeS6Hook() {
		return createClineCompactionBeforeModelHook({
			limitTokens: S6_LIMIT,
			outputReserveTokens: S6_OUTPUT_RESERVE,
			safetyMarginTokens: S6_MARGIN,
		});
	}

	// 21 messages (first user 16 tokens, then 20 equal-sized): single text
	// parts with lengths that are multiples of 4, so the chars/4 estimate is
	// exact.
	function sizedHistory(totalTokens: number): ClineSdkAgentMessage[] {
		const rest = (totalTokens - 16) / 20;
		const messages: ClineSdkAgentMessage[] = [];
		for (let i = 0; i < 21; i += 1) {
			messages.push(agentMessage(i % 2 === 0 ? "user" : "assistant", [sizedTextPart(i === 0 ? 16 : rest)]));
		}
		return messages;
	}

	it("0.79 utilization: the request fits the budget, so no compaction fires", async () => {
		const hook = makeS6Hook();
		const assembled = Math.round(S6_LIMIT * 0.79); // 7_900 estimated tokens
		const messages = sizedHistory(assembled - estimateTextTokens(S6_SYSTEM_PROMPT));
		expect(sumAgentMessageTokens(messages)).toBe(assembled - estimateTextTokens(S6_SYSTEM_PROMPT));

		expect(
			await hook(makeBeforeModelRequest(messages, { systemPrompt: S6_SYSTEM_PROMPT, tools: [] })),
		).toBeUndefined();
	});

	it("0.81 utilization: compaction fires and the rewritten request leaves the reserve in the window", async () => {
		const hook = makeS6Hook();
		const assembled = Math.round(S6_LIMIT * 0.81); // 8_100 estimated tokens
		const messages = sizedHistory(assembled - estimateTextTokens(S6_SYSTEM_PROMPT));

		const result = await hook(makeBeforeModelRequest(messages, { systemPrompt: S6_SYSTEM_PROMPT, tools: [] }));
		expect(result).toBeDefined();
		expect(result?.messages?.length ?? 0).toBeLessThan(messages.length);
		// The compaction notice was prepended to the surviving first message.
		const firstPart = result?.messages?.[0]?.content[0];
		expect(firstPart?.type).toBe("text");
		if (firstPart?.type === "text") {
			expect(firstPart.text).toContain("removed to fit the context window");
		}
		// Rewritten assembled request + reserved output stays under the
		// limit minus the margin (all chars/4 estimates).
		const after = sumAgentMessageTokens(result?.messages ?? []);
		expect(after + estimateTextTokens(S6_SYSTEM_PROMPT) + S6_OUTPUT_RESERVE).toBeLessThanOrEqual(
			S6_LIMIT - S6_MARGIN,
		);
	});

	it("S6 (e2e): a multi-round near-limit session ends with zero provider overflow errors", async () => {
		const reply = "The quick brown fox jumps over the lazy dog. ".repeat(80).trim();
		const replyTokens = Math.ceil(reply.length / 4);
		// Without compaction the message history alone would cross the window
		// (each round adds the reply plus the next round's prompt, estimates):
		expect(ROUNDS * (replyTokens + 16)).toBeGreaterThan(WINDOW);

		const session = await runMultiRoundSession({
			taskId: "task-b210-s6",
			rounds: ROUNDS,
			reply,
		});
		try {
			const { provider, service, taskId } = session;
			// Zero provider overflow rejections across enough rounds that the
			// un-compacted history would definitely have exceeded the window.
			expect(provider.requests.length).toBeGreaterThanOrEqual(ROUNDS);
			expect(provider.requests.every((request) => !request.exceededContextLimit)).toBe(true);
			// The beforeModel hook kept every request near the calibrated
			// budget, far below the window (estimates on both sides).
			const maxPromptTokens = Math.max(...provider.requests.map((request) => request.tokenCount));
			expect(maxPromptTokens + MAX_TOKENS).toBeLessThanOrEqual(WINDOW);
			expect(maxPromptTokens).toBeLessThan(WINDOW / 2);
			// The persisted transcript stays complete (the rewrite is
			// request-scoped) and the session remains healthy.
			expect(service.listMessages(taskId).length).toBeGreaterThanOrEqual(ROUNDS);
			const summary = service.getSummary(taskId);
			expect(["running", "awaiting_review", "idle"]).toContain(summary?.state);
			expect(summary?.reviewReason).not.toBe("error");
		} finally {
			await session.dispose();
		}
	}, 150_000);
});

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

let nextMessageId = 0;
function agentMessage(role: ClineSdkAgentMessage["role"], content: ClineSdkAgentMessagePart[]): ClineSdkAgentMessage {
	nextMessageId += 1;
	return { id: `msg-${nextMessageId}`, role, content, createdAt: nextMessageId };
}
function textPart(text: string): ClineSdkAgentMessagePart {
	return { type: "text", text };
}
/** Text part sized at exactly `tokens` in the chars/4 estimate. */
function sizedTextPart(tokens: number): ClineSdkAgentMessagePart {
	return textPart("x".repeat(tokens * 4));
}

/** Synthetic beforeModel context in the shape the hook consumes. */
function makeBeforeModelRequest(
	messages: ClineSdkAgentMessage[],
	overrides: { systemPrompt?: string; tools?: unknown[] } = {},
): ClineSdkAgentBeforeModelContext {
	return {
		snapshot: {
			agentId: "agent",
			status: "running",
			iteration: 1,
			messages,
			pendingToolCalls: [],
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		},
		request: {
			systemPrompt: overrides.systemPrompt ?? "system prompt",
			messages,
			tools: overrides.tools ?? [],
		},
	} as unknown as ClineSdkAgentBeforeModelContext;
}

/** Sum of the per-message chars/4 estimates (the same formula the hook uses). */
function sumAgentMessageTokens(messages: readonly ClineSdkAgentMessage[]): number {
	return messages.reduce((sum, message) => {
		const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		return sum + Math.ceil(text.length / 4);
	}, 0);
}

interface SessionLogEntry {
	message?: string;
	metadata?: Record<string, unknown>;
}

function readSessionLog(logPath: string): SessionLogEntry[] {
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as SessionLogEntry);
}

/**
 * The provider's own token accounting (an ESTIMATE): message content plus the
 * serialized tool schemas at chars/4 — closer to what a real backend counts
 * than the message-only default.
 */
const countingTokens: NonNullable<FakeOpenAiProviderOptions["countTokens"]> = (body) => {
	let chars = 0;
	for (const message of body.messages ?? []) {
		const content = (message as { content?: unknown } | null)?.content;
		if (typeof content === "string") {
			chars += content.length;
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === "object" && "text" in block) {
					chars += String((block as { text?: unknown }).text ?? "").length;
				}
			}
		}
	}
	chars += JSON.stringify((body as { tools?: unknown[] }).tools ?? []).length;
	return Math.ceil(chars / 4);
};

/** Sandboxes the SDK storage and captures the Kanban session log. */
function sandboxSdkEnv(): { probeDir: string; logPath: string; restore: () => void } {
	const probeDir = mkdtempSync(join(tmpdir(), "kanban-b210-"));
	const savedEnv: Record<string, string | undefined> = {
		CLINE_DIR: process.env.CLINE_DIR,
		CLINE_LOG_ENABLED: process.env.CLINE_LOG_ENABLED,
		CLINE_LOG_LEVEL: process.env.CLINE_LOG_LEVEL,
		CLINE_LOG_PATH: process.env.CLINE_LOG_PATH,
	};
	process.env.CLINE_DIR = probeDir;
	process.env.CLINE_LOG_ENABLED = "1";
	process.env.CLINE_LOG_LEVEL = "debug";
	const logPath = join(probeDir, "kanban.log");
	process.env.CLINE_LOG_PATH = logPath;
	execFileSync("git", ["init", "-q"], { cwd: probeDir });
	// Task state (worktrees + context artifacts) lives under the probe dir so
	// the whole session is self-contained and cleaned up on dispose.
	workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(join(probeDir, "worktrees-home"));
	return {
		probeDir,
		logPath,
		restore: () => {
			for (const [key, value] of Object.entries(savedEnv)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			rmSync(probeDir, { recursive: true, force: true });
		},
	};
}

function createAcceptanceService(): ClineTaskSessionService {
	return createInMemoryClineTaskSessionService({
		createSessionRuntime: (runtimeOptions) =>
			createInMemoryClineSessionRuntime({
				...runtimeOptions,
				createSessionHost: async () =>
					await ClineCore.create({ clientName: "kanban-b210-acceptance", backendMode: "local" }),
				createMcpRuntimeService: () => createFakeMcpRuntimeService(),
			}),
		createRuntimeSetup: async () => createFakeRuntimeSetup(),
	});
}

/**
 * Starts a session carrying Kanban's calibrated compaction config (built from
 * the launch config below) plus the beforeModel/afterTool hooks the runtime
 * wires from it. The explicit (override) 8k limit is the S2 small server
 * limit that governs every e2e scenario here.
 */
function startSessionWithCompaction(
	service: ClineTaskSessionService,
	taskId: string,
	probeDir: string,
	baseUrl: string,
	prompt: string,
): Promise<Awaited<ReturnType<ClineTaskSessionService["startTaskSession"]>>> {
	const launchConfig: ResolvedClineLaunchConfig = {
		providerId: "ollama",
		modelId: "probe-model",
		apiKey: "sk-test-key",
		baseUrl,
		contextWindowTokens: WINDOW,
		contextWindowSource: "override",
		maxTokens: MAX_TOKENS,
	};
	const compaction = buildClineCompactionConfig({ launchConfig });
	return service.startTaskSession({
		taskId,
		cwd: probeDir,
		prompt,
		providerId: "ollama",
		modelId: "probe-model",
		apiKey: "sk-test-key",
		baseUrl,
		systemPrompt: SYSTEM_PROMPT,
		contextWindowTokens: WINDOW,
		contextWindowSource: "override",
		compaction,
	});
}

async function waitForRequestCount(
	provider: FakeOpenAiProvider,
	service: ClineTaskSessionService,
	taskId: string,
	minRequests: number,
	timeoutMs: number,
): Promise<void> {
	// The task session service starts and sends turns fire-and-forget, so the
	// tests poll the provider's request counter (a request N+1 cannot exist
	// before response N completed) instead of relying on service promises.
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (provider.requests.length >= minRequests) {
			return;
		}
		const summary = service.getSummary(taskId);
		if (summary && (summary.state === "failed" || summary.state === "interrupted")) {
			throw new Error(
				`session entered ${summary.state} before request ${minRequests}: ${summary.warningMessage ?? summary.reviewReason ?? "no detail"}`,
			);
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for request ${minRequests} (requests=${provider.requests.length})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

async function waitForSettled(service: ClineTaskSessionService, taskId: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const summary = service.getSummary(taskId);
		if (summary && (summary.state === "failed" || summary.state === "interrupted")) {
			throw new Error(
				`session entered ${summary.state}: ${summary.warningMessage ?? summary.reviewReason ?? "no detail"}`,
			);
		}
		if (summary && summary.state !== "running") {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for the session to settle (state=${summary?.state ?? "unknown"})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

interface AcceptanceSession {
	provider: FakeOpenAiProvider;
	service: ClineTaskSessionService;
	logPath: string;
	taskId: string;
	dispose(): Promise<void>;
}

/** A real local SDK session answering text every round (S3/S6 e2e). */
async function runMultiRoundSession(options: {
	taskId: string;
	rounds: number;
	reply: string;
}): Promise<AcceptanceSession> {
	const sandbox = sandboxSdkEnv();
	const provider = createFakeOpenAiProvider({
		modelId: "probe-model",
		contextLimitTokens: WINDOW,
		errorShape: "llama.cpp",
		countTokens: countingTokens,
		respondWith: () => options.reply,
	});
	await provider.start();
	const service = createAcceptanceService();
	const session: AcceptanceSession = {
		provider,
		service,
		logPath: sandbox.logPath,
		taskId: options.taskId,
		dispose: async () => {
			await service.dispose();
			await provider.stop().catch(() => {});
			sandbox.restore();
		},
	};
	try {
		await startSessionWithCompaction(
			service,
			options.taskId,
			sandbox.probeDir,
			provider.baseUrl,
			"Round 1: reply with the fox sentence",
		);
		// The start runs fire-and-forget; wait until the first model turn
		// fully completed (host created, first request answered).
		await waitForRequestCount(provider, service, options.taskId, 1, 120_000);
		for (let round = 2; round <= options.rounds; round += 1) {
			await service.sendTaskSessionInput(options.taskId, `Round ${round}: reply with the fox sentence`);
			await waitForRequestCount(provider, service, options.taskId, round, 30_000);
		}
		await waitForSettled(service, options.taskId, 60_000);
	} catch (error) {
		await session.dispose();
		throw error;
	}
	return session;
}

/** A real local SDK session scripted to run one large `run_commands` (S5 e2e). */
async function startToolFlowSession(): Promise<AcceptanceSession> {
	const sandbox = sandboxSdkEnv();
	const bigOutputPath = join(sandbox.probeDir, "big-command-output.txt");
	writeFileSync(bigOutputPath, BIG_COMMAND_OUTPUT, "utf8");
	// Scripted model: first accepted request → the run_commands tool call;
	// every later request → the final text answer.
	let toolCallIssued = false;
	const provider = createFakeOpenAiProvider({
		modelId: "probe-model",
		contextLimitTokens: WINDOW,
		errorShape: "llama.cpp",
		countTokens: countingTokens,
		replyWith: () => {
			if (!toolCallIssued) {
				toolCallIssued = true;
				return {
					kind: "tool-call" as const,
					toolCallId: "call-b210-cat",
					toolName: "run_commands",
					arguments: { commands: [`cat ${bigOutputPath}`] },
				};
			}
			return {
				kind: "text" as const,
				text: "The command output was reviewed; the head and tail markers are present.",
			};
		},
	});
	await provider.start();
	const service = createAcceptanceService();
	const session: AcceptanceSession = {
		provider,
		service,
		logPath: sandbox.logPath,
		taskId: S5_TASK_ID,
		dispose: async () => {
			await service.dispose();
			await provider.stop().catch(() => {});
			sandbox.restore();
		},
	};
	try {
		await startSessionWithCompaction(
			service,
			S5_TASK_ID,
			sandbox.probeDir,
			provider.baseUrl,
			`Run \`cat ${bigOutputPath}\` and then report the head and tail lines you see.`,
		);
		// Two model requests: (1) the prompt that gets the tool call, (2) the
		// follow-up carrying the (bounded) tool result.
		await waitForRequestCount(provider, service, S5_TASK_ID, 2, 120_000);
		await waitForSettled(service, S5_TASK_ID, 60_000);
	} catch (error) {
		await session.dispose();
		throw error;
	}
	return session;
}
