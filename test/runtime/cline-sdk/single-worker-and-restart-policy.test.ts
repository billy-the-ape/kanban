// B-2.8 — Same policy across all session phases; serialized local-model usage.
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
// 2. Single-worker guard: while a Cline session is active, a start for a
//    different task fails with an explicit, user-readable error, leaves no
//    orphaned state, and is recoverable once the active session is stopped.
//    (Queuing / parallel scheduling is B-11, deliberately out of scope.)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClineCompactionConfig } from "../../../src/cline-sdk/cline-compaction-config";
import type { ResolvedClineLaunchConfig } from "../../../src/cline-sdk/cline-provider-service";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
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

describe("B-2.8 — single-worker guard", () => {
	it("blocks a second start while a Cline session is active and recovers after stop", async () => {
		const harness = createTaskSessionServiceHarness();
		services.push(harness);
		const { service, host } = harness;

		await service.startTaskSession({
			taskId: "task-worker-a",
			cwd: "/tmp/worktree",
			prompt: "Worker A prompt",
		});
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(1);
		});

		await service.startTaskSession({
			taskId: "task-worker-b",
			cwd: "/tmp/worktree",
			prompt: "Worker B prompt",
		});
		await vi.waitFor(() => {
			expect(service.getSummary("task-worker-b")?.reviewReason).toBe("error");
		});

		const blockedSummary = service.getSummary("task-worker-b");
		expect(blockedSummary?.warningMessage).toContain("Another Cline session is already active");
		expect(blockedSummary?.warningMessage).toContain("task-worker-a");
		// No orphaned half-start: only A's session was created, and A is
		// unaffected.
		expect(host.startedConfigs.length).toBe(1);
		expect(service.getSummary("task-worker-a")?.reviewReason).not.toBe("error");

		// Recoverable: stop the active session, clear the blocked task's
		// failed entry (the same /clear path the UI exposes), and start it.
		await service.stopTaskSession("task-worker-a");
		await service.clearTaskSession("task-worker-b");
		await service.startTaskSession({
			taskId: "task-worker-b",
			cwd: "/tmp/worktree",
			prompt: "Worker B prompt (retry)",
		});
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(2);
		});
		expect(service.getSummary("task-worker-b")?.reviewReason).not.toBe("error");
	});

	it("starts exactly one session for two overlapping starts", async () => {
		const harness = createTaskSessionServiceHarness();
		services.push(harness);
		const { service, host } = harness;

		await Promise.all([
			service.startTaskSession({
				taskId: "task-race-a",
				cwd: "/tmp/worktree",
				prompt: "Race A prompt",
			}),
			service.startTaskSession({
				taskId: "task-race-b",
				cwd: "/tmp/worktree",
				prompt: "Race B prompt",
			}),
		]);
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(1);
		});
		await vi.waitFor(() => {
			const a = service.getSummary("task-race-a");
			const b = service.getSummary("task-race-b");
			expect((a?.reviewReason === "error") !== (b?.reviewReason === "error")).toBe(true);
		});

		const aSummary = service.getSummary("task-race-a");
		const bSummary = service.getSummary("task-race-b");
		const blocked = aSummary?.reviewReason === "error" ? aSummary : bSummary;
		const winnerTaskId = aSummary?.reviewReason === "error" ? "task-race-b" : "task-race-a";
		const loserTaskId = aSummary?.reviewReason === "error" ? "task-race-a" : "task-race-b";
		// Exactly one explicit guard failure, naming the blocking task.
		expect(blocked?.warningMessage).toContain("Another Cline session is already active");
		expect(blocked?.warningMessage).toContain(winnerTaskId);
		expect(host.startedConfigs.length).toBe(1);

		// Recoverable: stop the winner, clear the loser's failed entry, start it.
		await service.stopTaskSession(winnerTaskId);
		await service.clearTaskSession(loserTaskId);
		await service.startTaskSession({
			taskId: loserTaskId,
			cwd: "/tmp/worktree",
			prompt: "Loser retry prompt",
		});
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(2);
		});
		expect(service.getSummary(loserTaskId)?.reviewReason).not.toBe("error");
	});

	it("blocks a review/repair prompt restart while another session is active, then lands the prompt on a policy-carrying session", async () => {
		const launchConfig = makeLaunchConfig();
		const resolveClineLaunchConfig = vi.fn(async () => launchConfig);
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig });
		services.push(harness);
		const { service, host } = harness;

		// Task under review: implementation turn completes, session ends.
		await service.startTaskSession({
			taskId: "task-review",
			cwd: "/tmp/worktree",
			prompt: "Implement the fix",
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
		await endLastSession(service, host, "task-review");

		// Another task becomes the active worker.
		await service.startTaskSession({
			taskId: "task-active",
			cwd: "/tmp/worktree",
			prompt: "Background work",
		});
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(2);
		});

		// The auto-commit (review/repair) prompt reaches the review task
		// while the other session is active → explicit guard failure.
		await service.sendTaskSessionInput("task-review", AUTO_COMMIT_PROMPT);
		await vi.waitFor(() => {
			expect(service.getSummary("task-review")?.reviewReason).toBe("error");
		});
		const blockedSummary = service.getSummary("task-review");
		expect(blockedSummary?.warningMessage).toContain("Another Cline session is already active");
		expect(blockedSummary?.warningMessage).toContain("task-active");
		expect(host.startedConfigs.length).toBe(2);

		// Once the active session is stopped, the same prompt restarts the
		// review session — carrying the same compaction policy.
		await service.stopTaskSession("task-active");
		await service.sendTaskSessionInput("task-review", AUTO_COMMIT_PROMPT);
		await vi.waitFor(() => {
			expect(host.startedConfigs.length).toBe(3);
		});
		expect(host.startedConfigs[2]?.compaction).toBeDefined();
		expect(host.startedConfigs[2]?.compaction).toEqual(host.startedConfigs[0]?.compaction);
		expect(host.sentPrompts.at(-1)?.prompt).toBe(AUTO_COMMIT_PROMPT);
		expect(service.getSummary("task-review")?.reviewReason).not.toBe("error");
	});
});
