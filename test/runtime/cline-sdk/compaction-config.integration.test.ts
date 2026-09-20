// B-2.4 — Explicit compaction config reaches the SDK session start.
//
// Drives the real InMemoryClineTaskSessionService through the real
// InMemoryClineSessionRuntime against the in-memory fake session host, and
// asserts the `config.compaction` object the SDK receives: window, threshold,
// reserve, and the local (same-provider) summarizer. Also asserts the config
// survives the context-overflow restart path, which re-sends the captured
// start request.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildClineCompactionConfig,
	CLINE_COMPACTION_MIN_CALIBRATED_WINDOW_TOKENS,
	CLINE_COMPACTION_PRESERVE_RECENT_TOKENS,
	CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT,
	CLINE_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
	CLINE_COMPACTION_THRESHOLD_RATIO,
	computeClineCompactionSafetyMarginTokens,
} from "../../../src/cline-sdk/cline-compaction-config";
import type { ResolvedClineLaunchConfig } from "../../../src/cline-sdk/cline-provider-service";
import {
	createTaskSessionServiceHarness,
	type TaskSessionServiceHarness,
} from "../../utilities/cline-session-service-harness";

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
	deleteTaskTurnCheckpointRef: vi.fn(),
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
	deleteTaskTurnCheckpointRef: turnCheckpointMocks.deleteTaskTurnCheckpointRef,
}));

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

const services: TaskSessionServiceHarness[] = [];

afterEach(async () => {
	await Promise.allSettled(services.splice(0).map((harness) => harness.service.dispose()));
});

function makeLaunchConfig(overrides: Partial<ResolvedClineLaunchConfig> = {}): ResolvedClineLaunchConfig {
	return {
		providerId: "openrouter",
		modelId: "local/test-model",
		apiKey: "sk-test-key",
		baseUrl: "http://localhost:11434/v1",
		contextWindowTokens: 32_768,
		contextWindowSource: "provider-metadata",
		maxTokens: 4_096,
		...overrides,
	};
}

const OPENAI_OVERFLOW_ERROR =
	"This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens (7000 in the messages, 2000 in the completion). Please shorten the messages or completion.";

describe("B-2.4 — compaction config wiring", () => {
	it("passes the built compaction config to the SDK session start", async () => {
		const harness = createTaskSessionServiceHarness();
		services.push(harness);
		const { service, host } = harness;
		const launchConfig = makeLaunchConfig();
		const compaction = buildClineCompactionConfig({ launchConfig });

		await service.startTaskSession({
			taskId: "task-compaction-full",
			cwd: "/tmp/worktree",
			prompt: "First turn prompt",
			providerId: launchConfig.providerId,
			modelId: launchConfig.modelId,
			apiKey: launchConfig.apiKey,
			baseUrl: launchConfig.baseUrl,
			contextWindowTokens: launchConfig.contextWindowTokens,
			contextWindowSource: launchConfig.contextWindowSource,
			compaction,
		});
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(1);
		});

		const startedCompaction = host.startedConfigs[0]?.compaction;
		// B-2.5: the runtime calibrates the window/reserve against the
		// assembled request (system prompt + tool schemas + safety margin)
		// before the config reaches the SDK, so assert the calibrated shape:
		// unchanged fields, window reduced by the measured overhead, and the
		// reserve carrying the B-2.4 output reservation plus the margin.
		expect(startedCompaction).toMatchObject({
			enabled: true,
			strategy: "basic",
			thresholdRatio: CLINE_COMPACTION_THRESHOLD_RATIO,
			preserveRecentTokens: CLINE_COMPACTION_PRESERVE_RECENT_TOKENS,
			summarizer: {
				providerId: "openrouter",
				modelId: "local/test-model",
				apiKey: "sk-test-key",
				baseUrl: "http://localhost:11434/v1",
				maxOutputTokens: CLINE_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
			},
		});
		expect(startedCompaction?.contextWindowTokens).toBeLessThan(32_768);
		expect(startedCompaction?.contextWindowTokens).toBeGreaterThan(CLINE_COMPACTION_MIN_CALIBRATED_WINDOW_TOKENS);
		expect(startedCompaction?.reserveTokens).toBe(4_096 + computeClineCompactionSafetyMarginTokens(32_768));
	});

	it("falls back to the default reserve and omits absent credentials when metadata is unknown", async () => {
		const harness = createTaskSessionServiceHarness();
		services.push(harness);
		const { service, host } = harness;
		const launchConfig = makeLaunchConfig({
			apiKey: null,
			baseUrl: null,
			contextWindowTokens: 128_000,
			contextWindowSource: "fallback",
			maxTokens: null,
		});
		const compaction = buildClineCompactionConfig({ launchConfig });

		await service.startTaskSession({
			taskId: "task-compaction-fallback",
			cwd: "/tmp/worktree",
			prompt: "First turn prompt",
			compaction,
		});
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(1);
		});

		const startedCompaction = host.startedConfigs[0]?.compaction;
		// B-2.5 calibration: window reduced by the assembled-request
		// overhead; the default output reservation carries the margin on top.
		expect(startedCompaction?.contextWindowTokens).toBeLessThan(128_000);
		expect(startedCompaction?.contextWindowTokens).toBeGreaterThan(CLINE_COMPACTION_MIN_CALIBRATED_WINDOW_TOKENS);
		expect(startedCompaction?.reserveTokens).toBe(
			CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT + computeClineCompactionSafetyMarginTokens(128_000),
		);
		expect(startedCompaction?.summarizer).toMatchObject({
			providerId: "openrouter",
			modelId: "local/test-model",
			maxOutputTokens: CLINE_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
		});
		expect(startedCompaction?.summarizer).not.toHaveProperty("apiKey");
		expect(startedCompaction?.summarizer).not.toHaveProperty("baseUrl");
	});

	it("respects a Kanban-level strategy override", async () => {
		const harness = createTaskSessionServiceHarness();
		services.push(harness);
		const { service, host } = harness;
		const launchConfig = makeLaunchConfig();
		const compaction = buildClineCompactionConfig({ launchConfig, settings: { strategy: "agentic" } });

		await service.startTaskSession({
			taskId: "task-compaction-agentic",
			cwd: "/tmp/worktree",
			prompt: "First turn prompt",
			compaction,
		});
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(1);
		});

		expect(host.startedConfigs[0]?.compaction?.strategy).toBe("agentic");
	});

	it("leaves the SDK start config untouched when no compaction config is provided", async () => {
		const harness = createTaskSessionServiceHarness();
		services.push(harness);
		const { service, host } = harness;

		await service.startTaskSession({
			taskId: "task-compaction-absent",
			cwd: "/tmp/worktree",
			prompt: "First turn prompt",
		});
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(1);
		});

		// Boundary: without an explicit config the SDK applies its own
		// defaults; Kanban must not fabricate a partial one.
		expect(host.startedConfigs[0]?.compaction).toBeUndefined();
	});

	it("keeps the compaction config across the context-overflow restart", async () => {
		const harness = createTaskSessionServiceHarness({
			onTurn: (context) => {
				if (context.turnCount === 2) {
					throw new Error(OPENAI_OVERFLOW_ERROR);
				}
				return `reply ${context.turnCount}`;
			},
		});
		services.push(harness);
		const { service, host } = harness;
		const launchConfig = makeLaunchConfig();
		const compaction = buildClineCompactionConfig({ launchConfig });

		await service.startTaskSession({
			taskId: "task-compaction-restart",
			cwd: "/tmp/worktree",
			prompt: "First turn prompt",
			providerId: launchConfig.providerId,
			modelId: launchConfig.modelId,
			apiKey: launchConfig.apiKey,
			baseUrl: launchConfig.baseUrl,
			contextWindowTokens: launchConfig.contextWindowTokens,
			contextWindowSource: launchConfig.contextWindowSource,
			compaction,
		});
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBe(1);
		});
		await service.sendTaskSessionInput("task-compaction-restart", "Follow up prompt");
		// Turn 2 fails with overflow; recovery restarts (start #2) and resends
		// the follow-up as turn 3.
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBe(3);
		});

		expect(host.startedConfigs.length).toBe(2);
		// The restart re-sends the captured UNCALIBRATED config and the
		// runtime re-derives the same calibration (no double subtraction).
		expect(host.startedConfigs[1]?.compaction).toEqual(host.startedConfigs[0]?.compaction);
		expect(host.startedConfigs[0]?.compaction).toMatchObject({
			enabled: true,
			strategy: "basic",
			summarizer: { providerId: "openrouter", modelId: "local/test-model" },
		});
		expect(host.startedConfigs[0]?.compaction?.contextWindowTokens).toBeLessThan(32_768);
		expect(host.startedConfigs[0]?.compaction?.reserveTokens).toBe(
			4_096 + computeClineCompactionSafetyMarginTokens(32_768),
		);
		expect(service.getSummary("task-compaction-restart")?.reviewReason).not.toBe("error");
	});

	it("applies the context budget settings through calibration to the SDK config (B-2.9)", async () => {
		const harness = createTaskSessionServiceHarness();
		services.push(harness);
		const { service, host } = harness;
		// Large window so the calibrated reserve (user reserve + user margin)
		// is not clamped by the window floor.
		const launchConfig = makeLaunchConfig({
			contextWindowTokens: 131_072,
			contextWindowSource: "override",
			compactionSettings: {
				strategy: "agentic",
				thresholdRatio: 0.7,
				reserveTokens: 8_192,
				safetyMarginTokens: 6_000,
			},
		});
		const compaction = buildClineCompactionConfig({ launchConfig });

		await service.startTaskSession({
			taskId: "task-budget-compaction",
			cwd: "/tmp/worktree",
			prompt: "First turn prompt",
			providerId: launchConfig.providerId,
			modelId: launchConfig.modelId,
			apiKey: launchConfig.apiKey,
			baseUrl: launchConfig.baseUrl,
			contextWindowTokens: launchConfig.contextWindowTokens,
			contextWindowSource: launchConfig.contextWindowSource,
			compaction,
			compactionSafetyMarginTokens: launchConfig.compactionSettings?.safetyMarginTokens,
		});
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(1);
		});

		const startedCompaction = host.startedConfigs[0]?.compaction;
		// The budget's strategy and threshold reach the SDK config unchanged.
		expect(startedCompaction?.strategy).toBe("agentic");
		expect(startedCompaction?.thresholdRatio).toBe(0.7);
		// Calibration folds the USER margin (6_000) into the USER reserve
		// (8_192), not the computed margin (4_096 floor at 131_072).
		expect(startedCompaction?.reserveTokens).toBe(8_192 + 6_000);
		expect(service.getSummary("task-budget-compaction")?.reviewReason).not.toBe("error");
	});
});

describe("B-2.9 — context budget compaction settings on the launch config", () => {
	it("applies the budget's strategy, threshold, and reserve from the launch config", () => {
		const launchConfig = makeLaunchConfig({
			compactionSettings: {
				strategy: "agentic",
				thresholdRatio: 0.7,
				reserveTokens: 8_192,
				safetyMarginTokens: 6_000,
			},
		});
		const compaction = buildClineCompactionConfig({ launchConfig });
		expect(compaction.strategy).toBe("agentic");
		expect(compaction.thresholdRatio).toBe(0.7);
		// The user's budget reserve wins over the model's maxTokens.
		expect(compaction.reserveTokens).toBe(8_192);
	});

	it("keeps the documented defaults when the launch config carries no budget", () => {
		const compaction = buildClineCompactionConfig({ launchConfig: makeLaunchConfig() });
		expect(compaction.strategy).toBe("basic");
		expect(compaction.thresholdRatio).toBe(CLINE_COMPACTION_THRESHOLD_RATIO);
		// Model maxTokens feeds the reserve when no budget reserve is set.
		expect(compaction.reserveTokens).toBe(4_096);
	});

	it("lets explicit per-call settings win over the launch-config budget", () => {
		const launchConfig = makeLaunchConfig({
			compactionSettings: { strategy: "agentic", thresholdRatio: 0.7 },
		});
		const compaction = buildClineCompactionConfig({ launchConfig, settings: { strategy: "basic" } });
		expect(compaction.strategy).toBe("basic");
		expect(compaction.thresholdRatio).toBe(0.7);
	});
});
