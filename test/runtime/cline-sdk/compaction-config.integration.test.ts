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
	CLINE_COMPACTION_PRESERVE_RECENT_TOKENS,
	CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT,
	CLINE_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
	CLINE_COMPACTION_THRESHOLD_RATIO,
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
		expect(startedCompaction).toEqual({
			enabled: true,
			contextWindowTokens: 32_768,
			strategy: "basic",
			thresholdRatio: CLINE_COMPACTION_THRESHOLD_RATIO,
			reserveTokens: 4_096,
			preserveRecentTokens: CLINE_COMPACTION_PRESERVE_RECENT_TOKENS,
			summarizer: {
				providerId: "openrouter",
				modelId: "local/test-model",
				apiKey: "sk-test-key",
				baseUrl: "http://localhost:11434/v1",
				maxOutputTokens: CLINE_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
			},
		});
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
		expect(startedCompaction?.contextWindowTokens).toBe(128_000);
		expect(startedCompaction?.reserveTokens).toBe(CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT);
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
		expect(host.startedConfigs[0]?.compaction).toEqual(compaction);
		expect(host.startedConfigs[1]?.compaction).toEqual(compaction);
		expect(service.getSummary("task-compaction-restart")?.reviewReason).not.toBe("error");
	});
});
