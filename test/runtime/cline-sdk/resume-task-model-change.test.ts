// Regression: a paused native Cline task must resume with the model the user
// saved on the card while it was paused — not the model it started with.
//
// Root cause under test: the restart boundary (`resolveRestartedLaunchPolicy`
// in src/cline-sdk/cline-session-runtime.ts) pinned the saved provider/model
// as overrides, so `createTaskChatMessageSender` resumes (the Resume button,
// chat follow-ups, and automation resumes all route through it) always
// re-launched the original model. The runtime now carries task identity into
// the launch-config resolver, and the workspace wiring
// (src/server/runtime-server.ts) wraps the provider service with
// `createTaskScopedClineLaunchConfigResolver`, which re-applies the fresh
// task-launch precedence from the persisted board card.
//
// These tests drive the real service + runtime against the fake session host
// and assert the ACTUAL SDK start config and scheduler capacity target — not
// just a UI label.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedClineLaunchConfig } from "../../../src/cline-sdk/cline-provider-service";
import {
	createTaskScopedClineLaunchConfigResolver,
	type TaskLaunchConfigCard,
	type TaskScopedLaunchConfigOverrides,
} from "../../../src/cline-sdk/cline-task-scoped-launch-config";
import { ClineTurnScheduler, type ClineTurnTarget } from "../../../src/cline-sdk/cline-turn-scheduler";
import type { RuntimeClineReasoningEffort } from "../../../src/core/api-contract";
import {
	createTaskSessionServiceHarness,
	type TaskSessionServiceHarness,
} from "../../utilities/cline-session-service-harness";
import type { FakeClineSessionStore } from "../../utilities/fake-cline-session-host";

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

interface FakeProviderProfile {
	modelId: string;
	apiKey: string;
	baseUrl: string;
	contextWindowTokens: number;
}

/** Provider settings "selected in Settings" for the fake host. */
const PROVIDER_A: FakeProviderProfile = {
	modelId: "model-a1",
	apiKey: "sk-provider-a",
	baseUrl: "http://provider-a.local:8080/v1",
	contextWindowTokens: 128_000,
};
const PROVIDER_B: FakeProviderProfile = {
	modelId: "model-b1",
	apiKey: "sk-provider-b",
	baseUrl: "http://provider-b.local:9090/v1",
	contextWindowTokens: 64_000,
};

function createFakeProviderSettings() {
	const calls: TaskScopedLaunchConfigOverrides[] = [];
	const resolve = async (overrides: TaskScopedLaunchConfigOverrides): Promise<ResolvedClineLaunchConfig> => {
		calls.push(overrides);
		const providerId = (overrides.providerIdOverride ?? "provider-a").trim().toLowerCase();
		const profile = providerId === "provider-b" ? PROVIDER_B : PROVIDER_A;
		const modelId = overrides.modelIdOverride?.trim() || profile.modelId;
		return {
			providerId,
			modelId,
			apiKey: profile.apiKey,
			baseUrl: profile.baseUrl,
			// Mirrors cline-provider-service.resolveLaunchConfig: an explicitly
			// passed reasoningEffortOverride (including null) is reported as
			// such; otherwise the provider settings' effort (unset here).
			reasoningEffort:
				"reasoningEffortOverride" in overrides ? (overrides.reasoningEffortOverride ?? null) : undefined,
			contextWindowTokens: profile.contextWindowTokens,
			contextWindowSource: "provider-metadata",
			maxTokens: 4_096,
		};
	};
	return { resolve, calls };
}

/** Mirrors the runtime-server wiring: task-scoped wrapper over the provider service. */
function createHarnessBoardResolver(board: { cardByTaskId: Map<string, TaskLaunchConfigCard> }) {
	const provider = createFakeProviderSettings();
	return {
		provider,
		resolver: createTaskScopedClineLaunchConfigResolver({
			resolveLaunchConfig: provider.resolve,
			loadTaskCard: async (taskId) => board.cardByTaskId.get(taskId) ?? null,
		}),
	};
}

function startRequest(taskId: string, config: ResolvedClineLaunchConfig, overrides: Record<string, unknown> = {}) {
	return {
		taskId,
		cwd: "/tmp/worktree",
		prompt: "Start prompt",
		providerId: config.providerId,
		modelId: config.modelId,
		apiKey: config.apiKey,
		baseUrl: config.baseUrl,
		...overrides,
	};
}

function userContents(store: FakeClineSessionStore, sessionId: string): string[] {
	return store
		.messagesFor(sessionId)
		.filter((message) => message.role === "user")
		.map((message) => {
			if (typeof message.content !== "string") {
				throw new Error("Expected plain-string user content in the fake transcript");
			}
			return message.content;
		});
}

describe("resume after saving a new model on the card", () => {
	it("start A → pause → save B → resume: SDK launch AND scheduler receive B, history retained", async () => {
		const taskId = "task-resume-model-1";
		const board = {
			cardByTaskId: new Map<string, TaskLaunchConfigCard>([
				[taskId, { clineSettings: { providerId: "provider-a", modelId: "model-a1" } }],
			]),
		};
		const { resolver } = createHarnessBoardResolver(board);
		const schedulerTargets: ClineTurnTarget[] = [];
		const harness = createTaskSessionServiceHarness({
			resolveClineLaunchConfig: resolver,
			turnScheduler: new ClineTurnScheduler(async (target) => {
				schedulerTargets.push(target);
				return 1;
			}),
		});
		services.push(harness);
		const { service, host, store } = harness;

		await service.startTaskSession(
			startRequest(taskId, {
				providerId: "provider-a",
				modelId: "model-a1",
				apiKey: PROVIDER_A.apiKey,
				baseUrl: PROVIDER_A.baseUrl,
				contextWindowTokens: PROVIDER_A.contextWindowTokens,
				contextWindowSource: "provider-metadata",
				maxTokens: 4_096,
			}),
		);
		await vi.waitFor(() => expect(host.sentPrompts).toHaveLength(1));
		const firstSessionId = host.startedConfigs[0]?.sessionId ?? "";
		expect(host.startedConfigs[0]?.modelId).toBe("model-a1");

		// Pause the card.
		await service.stopTaskSession(taskId);
		expect(service.getSummary(taskId)?.state).toBe("interrupted");

		// User saves model B on the card (board persistence is the source of truth).
		board.cardByTaskId.set(taskId, { clineSettings: { providerId: "provider-b", modelId: "model-b2" } });

		// Resume button sends "Resume" as a chat message.
		await service.sendTaskSessionInput(taskId, "Resume");
		await vi.waitFor(() => expect(host.startedConfigs).toHaveLength(2));

		// The SDK launch config — not just a label — is provider B / model B2.
		const restarted = host.startedConfigs[1];
		expect(restarted).toBeDefined();
		expect(restarted?.providerId).toBe("provider-b");
		expect(restarted?.modelId).toBe("model-b2");
		expect(restarted?.apiKey).toBe(PROVIDER_B.apiKey);
		expect(restarted?.baseUrl).toBe(PROVIDER_B.baseUrl);
		// Compaction (context capacity + summarizer) follows the new config.
		expect(restarted?.compaction?.summarizer).toMatchObject({
			providerId: "provider-b",
			modelId: "model-b2",
			apiKey: PROVIDER_B.apiKey,
		});

		// The concurrency scheduler admits the resumed turn under the NEW model.
		const lastTarget = schedulerTargets.at(-1);
		expect(lastTarget?.providerId).toBe("provider-b");
		expect(lastTarget?.modelId).toBe("model-b2");

		// History survives into the recreated session; the resume produced
		// exactly one send.
		expect(restarted?.sessionId).not.toBe(firstSessionId);
		expect(userContents(store, restarted?.sessionId ?? "")).toEqual(["Start prompt", "Resume"]);
		expect(host.sentPrompts.filter((entry) => entry.prompt === "Resume")).toHaveLength(1);
		expect(service.getSummary(taskId)?.reviewReason).not.toBe("error");
	});

	it("works after a Kanban process restart (persisted record + board card)", async () => {
		const taskId = "task-resume-model-2";
		const board = {
			cardByTaskId: new Map<string, TaskLaunchConfigCard>([
				[taskId, { clineSettings: { providerId: "provider-a", modelId: "model-a1" } }],
			]),
		};
		const firstBoard = createHarnessBoardResolver(board);
		const first = createTaskSessionServiceHarness({ resolveClineLaunchConfig: firstBoard.resolver });
		services.push(first);
		await first.service.startTaskSession(
			startRequest(taskId, {
				providerId: "provider-a",
				modelId: "model-a1",
				apiKey: PROVIDER_A.apiKey,
				baseUrl: PROVIDER_A.baseUrl,
				contextWindowTokens: PROVIDER_A.contextWindowTokens,
				contextWindowSource: "provider-metadata",
				maxTokens: 4_096,
			}),
		);
		await vi.waitFor(() => expect(first.host.sentPrompts).toHaveLength(1));
		await first.service.stopTaskSession(taskId);
		await first.service.dispose();
		services.splice(services.indexOf(first), 1);

		// The Kanban process restarts: fresh runtime maps rebuilt from the
		// durable record; the user has meanwhile saved model B on the card.
		board.cardByTaskId.set(taskId, { clineSettings: { providerId: "provider-b", modelId: "model-b2" } });
		const secondBoard = createHarnessBoardResolver(board);
		const second = createTaskSessionServiceHarness({
			store: first.store,
			resolveClineLaunchConfig: secondBoard.resolver,
		});
		services.push(second);

		await second.service.rebindPersistedTaskSession(taskId);
		await second.service.sendTaskSessionInput(taskId, "Resume");
		await vi.waitFor(() => expect(second.host.startedConfigs).toHaveLength(1));

		const restarted = second.host.startedConfigs[0];
		expect(restarted?.providerId).toBe("provider-b");
		expect(restarted?.modelId).toBe("model-b2");
		expect(restarted?.apiKey).toBe(PROVIDER_B.apiKey);
		expect(userContents(second.store, restarted?.sessionId ?? "")).toEqual(["Start prompt", "Resume"]);
		expect(second.host.sentPrompts).toHaveLength(1);
		expect(second.service.getSummary(taskId)?.reviewReason).not.toBe("error");
	});

	it("resume without settings changes retains the original model (one send, history retained)", async () => {
		const taskId = "task-resume-stable";
		const board = {
			cardByTaskId: new Map<string, TaskLaunchConfigCard>([
				[taskId, { clineSettings: { providerId: "provider-a", modelId: "model-a1" } }],
			]),
		};
		const { resolver } = createHarnessBoardResolver(board);
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: resolver });
		services.push(harness);
		const { service, host, store } = harness;

		await service.startTaskSession(
			startRequest(taskId, {
				providerId: "provider-a",
				modelId: "model-a1",
				apiKey: PROVIDER_A.apiKey,
				baseUrl: PROVIDER_A.baseUrl,
				contextWindowTokens: PROVIDER_A.contextWindowTokens,
				contextWindowSource: "provider-metadata",
				maxTokens: 4_096,
			}),
		);
		await vi.waitFor(() => expect(host.sentPrompts).toHaveLength(1));
		await service.stopTaskSession(taskId);

		await service.sendTaskSessionInput(taskId, "Resume");
		await vi.waitFor(() => expect(host.startedConfigs).toHaveLength(2));

		expect(host.startedConfigs[1]?.providerId).toBe("provider-a");
		expect(host.startedConfigs[1]?.modelId).toBe("model-a1");
		expect(host.startedConfigs[1]?.apiKey).toBe(PROVIDER_A.apiKey);
		expect(userContents(store, host.startedConfigs[1]?.sessionId ?? "")).toEqual(["Start prompt", "Resume"]);
		expect(host.sentPrompts).toHaveLength(2);
	});

	it("card overrides win over global defaults; clearing the override follows fresh-launch semantics and rebuilds provider-dependent instructions", async () => {
		const taskId = "task-resume-clear-override";
		const board = {
			cardByTaskId: new Map<string, TaskLaunchConfigCard>([
				[taskId, { clineSettings: { providerId: "provider-b", modelId: "model-b2" } }],
			]),
		};
		const { resolver, provider } = createHarnessBoardResolver(board);
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: resolver });
		services.push(harness);
		const { service, host } = harness;

		await service.startTaskSession(
			startRequest(
				taskId,
				{
					providerId: "provider-b",
					modelId: "model-b2",
					apiKey: PROVIDER_B.apiKey,
					baseUrl: PROVIDER_B.baseUrl,
					contextWindowTokens: PROVIDER_B.contextWindowTokens,
					contextWindowSource: "provider-metadata",
					maxTokens: 4_096,
				},
				{ systemPrompt: "provider-b specific start-time prompt" },
			),
		);
		await vi.waitFor(() => expect(host.sentPrompts).toHaveLength(1));
		await service.stopTaskSession(taskId);

		// Clear the card override: fresh-launch semantics fall through to the
		// current global provider settings (provider A selected in Settings).
		board.cardByTaskId.set(taskId, {});
		await service.sendTaskSessionInput(taskId, "Resume");
		await vi.waitFor(() => expect(host.startedConfigs).toHaveLength(2));

		const restarted = host.startedConfigs[1];
		expect(restarted?.providerId).toBe("provider-a");
		expect(restarted?.modelId).toBe("model-a1");
		expect(restarted?.apiKey).toBe(PROVIDER_A.apiKey);
		// The saved system prompt embeds provider-B-specific guidance; the
		// restart must rebuild workspace instructions for the new provider.
		expect(restarted?.systemPrompt).not.toContain("provider-b specific start-time prompt");
		expect(restarted?.systemPrompt).toContain("test rules");
		// The wrapper resolved from the card (no pin), then the fallback-less
		// global path.
		expect(provider.calls.at(-1)).toEqual({
			providerIdOverride: undefined,
			modelIdOverride: undefined,
		});
	});

	it("reasoning effort follows the card, including an explicit clear", async () => {
		const taskId = "task-resume-reasoning";
		const board = {
			cardByTaskId: new Map<string, TaskLaunchConfigCard>([
				[taskId, { clineSettings: { providerId: "provider-a", modelId: "model-a1", reasoningEffort: "low" } }],
			]),
		};
		const { resolver } = createHarnessBoardResolver(board);
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: resolver });
		services.push(harness);
		const { service, host } = harness;

		await service.startTaskSession(
			startRequest(
				taskId,
				{
					providerId: "provider-a",
					modelId: "model-a1",
					apiKey: PROVIDER_A.apiKey,
					baseUrl: PROVIDER_A.baseUrl,
					contextWindowTokens: PROVIDER_A.contextWindowTokens,
					contextWindowSource: "provider-metadata",
					maxTokens: 4_096,
				},
				{ reasoningEffort: "low" satisfies RuntimeClineReasoningEffort },
			),
		);
		await vi.waitFor(() => expect(host.sentPrompts).toHaveLength(1));
		await service.stopTaskSession(taskId);

		// Raise reasoning on the card while paused.
		board.cardByTaskId.set(taskId, {
			clineSettings: { providerId: "provider-a", modelId: "model-a1", reasoningEffort: "high" },
		});
		await service.sendTaskSessionInput(taskId, "Resume");
		await vi.waitFor(() => expect(host.startedConfigs).toHaveLength(2));
		expect(host.startedConfigs[1]?.reasoningEffort).toBe("high");

		// Explicitly clear reasoning on the card (override object without an
		// effort) → the resumed session runs with reasoning disabled.
		await service.stopTaskSession(taskId);
		board.cardByTaskId.set(taskId, { clineSettings: { providerId: "provider-a", modelId: "model-a1" } });
		await service.sendTaskSessionInput(taskId, "Resume again");
		await vi.waitFor(() => expect(host.startedConfigs).toHaveLength(3));
		expect(host.startedConfigs[2]?.reasoningEffort).toBe("none");
	});

	it("sessions without a board card keep the pinned restart config (review/repair roles unchanged)", async () => {
		const baseTaskId = "task-pin-base";
		const reviewTaskId = `${baseTaskId}::review`;
		// A card exists for the BASE task with model B, but the restarting
		// session id (review role) has no card of its own → the pin wins.
		const board = {
			cardByTaskId: new Map<string, TaskLaunchConfigCard>([
				[baseTaskId, { clineSettings: { providerId: "provider-b", modelId: "model-b2" } }],
			]),
		};
		const { resolver, provider } = createHarnessBoardResolver(board);
		const harness = createTaskSessionServiceHarness({ resolveClineLaunchConfig: resolver });
		services.push(harness);
		const { service, host } = harness;

		await service.startTaskSession(
			startRequest(reviewTaskId, {
				providerId: "provider-a",
				modelId: "model-a1",
				apiKey: PROVIDER_A.apiKey,
				baseUrl: PROVIDER_A.baseUrl,
				contextWindowTokens: PROVIDER_A.contextWindowTokens,
				contextWindowSource: "provider-metadata",
				maxTokens: 4_096,
			}),
		);
		await vi.waitFor(() => expect(host.sentPrompts).toHaveLength(1));
		const sessionId = host.startedConfigs[0]?.sessionId ?? "";
		host.emitEvent({ type: "ended", payload: { sessionId, reason: "completed" } });
		await vi.waitFor(() => expect(service.getSummary(reviewTaskId)?.state).toBe("awaiting_review"));

		await service.sendTaskSessionInput(reviewTaskId, "Repair prompt");
		await vi.waitFor(() => expect(host.startedConfigs).toHaveLength(2));

		expect(host.startedConfigs[1]?.providerId).toBe("provider-a");
		expect(host.startedConfigs[1]?.modelId).toBe("model-a1");
		// The wrapper strips task identity on the pin path; the provider
		// service receives exactly the saved overrides.
		expect(provider.calls.at(-1)).toEqual({
			providerIdOverride: "provider-a",
			modelIdOverride: "model-a1",
		});
	});
});

describe("createTaskScopedClineLaunchConfigResolver contract", () => {
	it("passes card settings as overrides, mirroring fresh-launch precedence", async () => {
		const provider = createFakeProviderSettings();
		const resolver = createTaskScopedClineLaunchConfigResolver({
			resolveLaunchConfig: provider.resolve,
			loadTaskCard: async () => ({
				clineSettings: { providerId: "provider-b", modelId: "model-b2", reasoningEffort: "high" },
			}),
		});
		await resolver({ taskId: "task-x", providerIdOverride: "provider-a", modelIdOverride: "model-a1" });
		expect(provider.calls.at(-1)).toEqual({
			providerIdOverride: "provider-b",
			modelIdOverride: "model-b2",
			reasoningEffortOverride: "high",
		});
	});

	it("an override object without reasoningEffort explicitly clears reasoning", async () => {
		const provider = createFakeProviderSettings();
		const resolver = createTaskScopedClineLaunchConfigResolver({
			resolveLaunchConfig: provider.resolve,
			loadTaskCard: async () => ({ clineSettings: {} }),
		});
		await resolver({ taskId: "task-x", providerIdOverride: "provider-a", modelIdOverride: "model-a1" });
		const call = provider.calls.at(-1);
		expect(call).toEqual({
			providerIdOverride: undefined,
			modelIdOverride: undefined,
			reasoningEffortOverride: null,
		});
	});

	it("a card without a clineSettings object falls through to global provider settings", async () => {
		const provider = createFakeProviderSettings();
		const resolver = createTaskScopedClineLaunchConfigResolver({
			resolveLaunchConfig: provider.resolve,
			loadTaskCard: async () => ({}),
		});
		await resolver({ taskId: "task-x", providerIdOverride: "provider-a", modelIdOverride: "model-a1" });
		const call = provider.calls.at(-1);
		expect(call).toEqual({ providerIdOverride: undefined, modelIdOverride: undefined });
		expect(call && "reasoningEffortOverride" in call).toBe(false);
	});

	it("falls back to the pinned saved config when no card owns the session or the board read fails", async () => {
		const missing = createFakeProviderSettings();
		const missingResolver = createTaskScopedClineLaunchConfigResolver({
			resolveLaunchConfig: missing.resolve,
			loadTaskCard: async () => null,
		});
		await missingResolver({
			taskId: "__home_agent__:ws:cline",
			providerIdOverride: "provider-a",
			modelIdOverride: "model-a1",
		});
		expect(missing.calls.at(-1)).toEqual({ providerIdOverride: "provider-a", modelIdOverride: "model-a1" });

		const failing = createFakeProviderSettings();
		const failingResolver = createTaskScopedClineLaunchConfigResolver({
			resolveLaunchConfig: failing.resolve,
			loadTaskCard: async () => {
				throw new Error("board read failed");
			},
		});
		await failingResolver({ taskId: "task-x", providerIdOverride: "provider-a", modelIdOverride: "model-a1" });
		expect(failing.calls.at(-1)).toEqual({ providerIdOverride: "provider-a", modelIdOverride: "model-a1" });
	});
});
