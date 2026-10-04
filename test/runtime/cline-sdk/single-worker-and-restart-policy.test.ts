// Restart policy remains consistent across session phases; model turns share a bounded queue.
//
// Drives the real InMemoryClineTaskSessionService through the real
// InMemoryClineSessionRuntime against the in-memory fake session host and
// covers two guarantees:
//
// 1. Restart policy re-resolution: follow-ups (including review/repair
//    prompts such as the auto-commit flow) restart through
//    `lastStartRequestByTaskId` → `restartTaskSession`. The restart must
//    re-resolve the launch config (context limit, compaction policy,
//    credentials) from the current provider settings via the injected
//    resolver — not cache-and-replay the start-time snapshot — and the
//    restarted SDK session must carry the same compaction policy.
//
// 2. Capacity is held by running turns; excess tasks wait and can be canceled.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClineCompactionConfig } from "../../../src/cline-sdk/cline-compaction-config";
import type { ResolvedClineLaunchConfig } from "../../../src/cline-sdk/cline-provider-service";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import { ClineTurnScheduler } from "../../../src/cline-sdk/cline-turn-scheduler";
import {
	createTaskSessionServiceHarness,
	type TaskSessionServiceHarness,
} from "../../utilities/cline-session-service-harness";
import type { FakeClineSessionHost } from "../../utilities/fake-cline-session-host";

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

/**
 * Simulates a completed turn: the fake host never emits "ended" on its own,
 * so the test emits it (like the real SDK). The ended event clears the live
 * binding and moves the task to awaiting_review, so the next user message
 * goes through the restart path.
 */
async function endLastSession(
	service: ClineTaskSessionService,
	host: FakeClineSessionHost,
	taskId: string,
): Promise<void> {
	const sessionId = host.startedConfigs.at(-1)?.sessionId ?? "";
	host.emitEvent({ type: "ended", payload: { sessionId, reason: "completed" } });
	await vi.waitFor(() => {
		expect(service.getSummary(taskId)?.state).toBe("awaiting_review");
	});
}

// Mirrors the default auto-commit prompt template sent by the review/repair
// (auto-review) flow in web-ui/src/hooks/use-review-auto-actions.ts.
const AUTO_COMMIT_PROMPT = "Handle this commit action using the provided git context.";

describe("B-2.8 — restart policy re-resolution", () => {
	it("keeps the same compaction policy across the follow-up restart (stable launch config)", async () => {
		const launchConfig = makeLaunchConfig();
		const resolveClineLaunchConfig = vi.fn(async () => launchConfig);
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig });
		services.push(harness);
		const { service, host } = harness;

		await service.startTaskSession({
			taskId: "task-restart-policy",
			cwd: "/tmp/worktree",
			prompt: "First turn prompt",
			providerId: launchConfig.providerId,
			modelId: launchConfig.modelId,
			apiKey: launchConfig.apiKey,
			baseUrl: launchConfig.baseUrl,
			contextWindowTokens: launchConfig.contextWindowTokens,
			contextWindowSource: launchConfig.contextWindowSource,
			compaction: buildClineCompactionConfig({ launchConfig }),
		});
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBe(1);
		});
		await endLastSession(service, host, "task-restart-policy");

		// Follow-up after the binding cleared → restart path.
		await service.sendTaskSessionInput("task-restart-policy", "Follow up prompt");
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(2);
		});

		// The restarted SDK start carries the same (calibrated) compaction
		// policy as the original start.
		expect(host.startedConfigs[1]?.compaction).toBeDefined();
		expect(host.startedConfigs[1]?.compaction).toEqual(host.startedConfigs[0]?.compaction);
		expect(host.startedConfigs[0]?.compaction).toMatchObject({
			enabled: true,
			strategy: "basic",
			summarizer: { providerId: "openrouter", modelId: "local/test-model" },
		});
		// Re-resolution is pinned to the saved provider/model so the
		// conversation continues with the same model.
		expect(resolveClineLaunchConfig).toHaveBeenCalledWith({
			providerIdOverride: "openrouter",
			modelIdOverride: "local/test-model",
		});
		expect(service.getSummary("task-restart-policy")?.reviewReason).not.toBe("error");
	});

	it("picks up the current launch config on restart instead of replaying the snapshot", async () => {
		let current = makeLaunchConfig();
		const resolveClineLaunchConfig = vi.fn(async () => current);
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig });
		services.push(harness);
		const { service, host } = harness;

		await service.startTaskSession({
			taskId: "task-restart-current",
			cwd: "/tmp/worktree",
			prompt: "First turn prompt",
			providerId: current.providerId,
			modelId: current.modelId,
			apiKey: current.apiKey,
			baseUrl: current.baseUrl,
			contextWindowTokens: current.contextWindowTokens,
			contextWindowSource: current.contextWindowSource,
			compaction: buildClineCompactionConfig({ launchConfig: current }),
		});
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBe(1);
		});
		await endLastSession(service, host, "task-restart-current");

		// Provider settings change between turns: larger context override
		// and a rotated key (OAuth refresh / user edit).
		current = makeLaunchConfig({ contextWindowTokens: 65_536, apiKey: "sk-rotated-key" });
		await service.sendTaskSessionInput("task-restart-current", "Follow up prompt");
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(2);
		});

		// The restart uses the CURRENT launch config, not the start-time
		// snapshot: fresh credentials and a larger calibrated window.
		expect(host.startedConfigs[1]?.apiKey).toBe("sk-rotated-key");
		expect(host.startedConfigs[1]?.compaction?.contextWindowTokens).toBeGreaterThan(
			host.startedConfigs[0]?.compaction?.contextWindowTokens ?? 0,
		);
		// Same model and provider for the summarizer.
		expect(host.startedConfigs[1]?.compaction?.summarizer).toEqual({
			providerId: "openrouter",
			modelId: "local/test-model",
			apiKey: "sk-rotated-key",
			baseUrl: "http://localhost:11434/v1",
			maxOutputTokens: 1024,
		});
		expect(service.getSummary("task-restart-current")?.reviewReason).not.toBe("error");
	});

	it("fails explicitly and recoverably when the restart cannot re-resolve the launch config", async () => {
		let resolverError: Error | null = null;
		const resolveClineLaunchConfig = vi.fn(async () => {
			if (resolverError) {
				throw resolverError;
			}
			return makeLaunchConfig();
		});
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig });
		services.push(harness);
		const { service, host } = harness;
		const launchConfig = makeLaunchConfig();

		await service.startTaskSession({
			taskId: "task-restart-unresolved",
			cwd: "/tmp/worktree",
			prompt: "First turn prompt",
			providerId: launchConfig.providerId,
			modelId: launchConfig.modelId,
			apiKey: launchConfig.apiKey,
			baseUrl: launchConfig.baseUrl,
			contextWindowTokens: launchConfig.contextWindowTokens,
			contextWindowSource: launchConfig.contextWindowSource,
			compaction: buildClineCompactionConfig({ launchConfig }),
		});
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBe(1);
		});
		await endLastSession(service, host, "task-restart-unresolved");

		resolverError = new Error(
			"No native Cline provider is configured. Open Settings, choose a provider, and then start the task again.",
		);
		await service.sendTaskSessionInput("task-restart-unresolved", "Follow up prompt");
		await vi.waitFor(() => {
			expect(service.getSummary("task-restart-unresolved")?.reviewReason).toBe("error");
		});
		// Explicit, user-readable failure; no orphaned half-start.
		expect(service.getSummary("task-restart-unresolved")?.warningMessage).toContain(
			"No native Cline provider is configured",
		);
		expect(host.startedConfigs.length).toBe(1);

		// Recoverable once the provider resolves again.
		resolverError = null;
		await service.sendTaskSessionInput("task-restart-unresolved", "Retry follow up prompt");
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(2);
		});
		expect(service.getSummary("task-restart-unresolved")?.reviewReason).not.toBe("error");
	});
});

function deferredTurn() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("model turn scheduling", () => {
	it("runs two turns and queues a third without an error, then releases on turn completion", async () => {
		const gate = deferredTurn();
		const scheduler = new ClineTurnScheduler(async () => 2);
		const harness = createTaskSessionServiceHarness({
			turnScheduler: scheduler,
			onTurn: async () => {
				await gate.promise;
				return "done";
			},
		});
		services.push(harness);
		try {
			for (const taskId of ["a", "b", "c"]) {
				await harness.service.startTaskSession({ taskId, cwd: "/tmp/worktree", prompt: taskId });
			}
			await vi.waitFor(() => expect(harness.host.sentPrompts).toHaveLength(2));
			await vi.waitFor(() =>
				expect(harness.service.getSummary("c")?.latestHookActivity?.activityText).toBe(
					"Waiting for model capacity",
				),
			);
			expect(harness.service.getSummary("c")?.reviewReason).not.toBe("error");
			gate.resolve();
			await vi.waitFor(() => expect(harness.host.sentPrompts).toHaveLength(3));
			// All SDK sessions remain bound in this fake host, but idle sessions do not block a new turn.
			await harness.service.startTaskSession({ taskId: "d", cwd: "/tmp/worktree", prompt: "next" });
			await vi.waitFor(() => expect(harness.host.sentPrompts).toHaveLength(4));
		} finally {
			gate.resolve();
		}
	});

	it("cancels a queued task on pause so it never starts later", async () => {
		const gate = deferredTurn();
		const harness = createTaskSessionServiceHarness({
			onTurn: async () => {
				await gate.promise;
				return "done";
			},
		});
		services.push(harness);
		try {
			await harness.service.startTaskSession({ taskId: "active", cwd: "/tmp/worktree", prompt: "active" });
			await vi.waitFor(() => expect(harness.host.sentPrompts).toHaveLength(1));
			await harness.service.startTaskSession({ taskId: "queued", cwd: "/tmp/worktree", prompt: "queued" });
			await vi.waitFor(() =>
				expect(harness.service.getSummary("queued")?.latestHookActivity?.hookEventName).toBe("concurrency_waiting"),
			);
			await harness.service.stopTaskSession("queued");
			gate.resolve();
			await harness.service.startTaskSession({ taskId: "next", cwd: "/tmp/worktree", prompt: "next" });
			await vi.waitFor(() => expect(harness.host.sentPrompts).toHaveLength(2));
			expect(harness.host.startedConfigs).toHaveLength(2);
			expect(harness.service.getSummary("queued")?.state).toBe("interrupted");
		} finally {
			gate.resolve();
		}
	});

	it("cancels a restart while launch policy is being resolved", async () => {
		const policyGate = deferredTurn();
		const resolving = vi.fn();
		const harness = createTaskSessionServiceHarness({
			resolveClineLaunchConfig: async () => {
				resolving();
				await policyGate.promise;
				return makeLaunchConfig();
			},
		});
		services.push(harness);
		try {
			await harness.service.startTaskSession({ taskId: "restart", cwd: "/tmp/worktree", prompt: "initial" });
			await vi.waitFor(() => expect(harness.host.sentPrompts).toHaveLength(1));
			await endLastSession(harness.service, harness.host, "restart");
			await harness.service.sendTaskSessionInput("restart", "resume");
			await vi.waitFor(() => expect(resolving).toHaveBeenCalled());
			await harness.service.stopTaskSession("restart");
			policyGate.resolve();
			await harness.service.startTaskSession({ taskId: "next", cwd: "/tmp/worktree", prompt: "next" });
			await vi.waitFor(() => expect(harness.host.sentPrompts).toHaveLength(2));
			expect(harness.host.startedConfigs).toHaveLength(2);
			expect(harness.service.getSummary("restart")?.state).toBe("interrupted");
		} finally {
			policyGate.resolve();
		}
	});

	it("queues a follow-up while another turn is active, then delivers it with the restart policy", async () => {
		const gate = deferredTurn();
		const launchConfig = makeLaunchConfig();
		const harness = createTaskSessionServiceHarness({
			resolveClineLaunchConfig: async () => launchConfig,
			onTurn: async ({ prompt }) => {
				if (prompt === "Background") await gate.promise;
				return "done";
			},
		});
		services.push(harness);
		try {
			await harness.service.startTaskSession({
				taskId: "review",
				cwd: "/tmp/worktree",
				prompt: "Implement",
				providerId: launchConfig.providerId,
				modelId: launchConfig.modelId,
				baseUrl: launchConfig.baseUrl,
				compaction: buildClineCompactionConfig({ launchConfig }),
			});
			await vi.waitFor(() => expect(harness.host.sentPrompts).toHaveLength(1));
			await endLastSession(harness.service, harness.host, "review");
			await harness.service.startTaskSession({
				taskId: "active",
				cwd: "/tmp/worktree",
				prompt: "Background",
				providerId: launchConfig.providerId,
				modelId: launchConfig.modelId,
				baseUrl: launchConfig.baseUrl,
			});
			await vi.waitFor(() => expect(harness.host.sentPrompts).toHaveLength(2));
			await harness.service.sendTaskSessionInput("review", AUTO_COMMIT_PROMPT);
			await vi.waitFor(() =>
				expect(harness.service.getSummary("review")?.latestHookActivity?.hookEventName).toBe("concurrency_waiting"),
			);
			gate.resolve();
			await vi.waitFor(() => expect(harness.host.sentPrompts).toHaveLength(3));
			expect(harness.host.sentPrompts.at(-1)?.prompt).toBe(AUTO_COMMIT_PROMPT);
			expect(harness.host.startedConfigs.at(-1)?.compaction).toBeDefined();
		} finally {
			gate.resolve();
		}
	});
});
