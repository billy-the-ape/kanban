import { beforeEach, describe, expect, it, vi } from "vitest";

const commandDiscoveryMocks = vi.hoisted(() => ({
	isBinaryAvailableOnPath: vi.fn(),
}));

vi.mock("../../../src/terminal/command-discovery.js", () => ({
	isBinaryAvailableOnPath: commandDiscoveryMocks.isBinaryAvailableOnPath,
}));

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import { RUNTIME_AGENT_CATALOG } from "../../../src/core/agent-catalog";
import {
	buildRuntimeConfigResponse,
	describeUnrunnableAgent,
	detectInstalledCommands,
	resolveAgentCommand,
} from "../../../src/terminal/agent-registry";

function createRuntimeConfigState(overrides: Partial<RuntimeConfigState> = {}): RuntimeConfigState {
	return {
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		...overrides,
	};
}

beforeEach(() => {
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReset();
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(false);
	delete process.env.KANBAN_DEBUG_MODE;
	delete process.env.DEBUG_MODE;
	delete process.env.debug_mode;
});

describe("agent-registry", () => {
	it("detects installed commands from the inherited PATH", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const detected = detectInstalledCommands();

		expect(detected).toEqual(["claude"]);
		// Every catalogued agent is probed on PATH (plus the `npx` shell-only
		// candidate), so adding one (AA-P1: `pi`) must not silently leave a
		// binary undiscovered.
		expect(commandDiscoveryMocks.isBinaryAvailableOnPath).toHaveBeenCalledTimes(RUNTIME_AGENT_CATALOG.length + 1);
	});

	it("treats shell-only agents as unavailable", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "npx");

		const resolved = resolveAgentCommand(createRuntimeConfigState({ selectedAgentId: "claude" }));

		expect(resolved).toBeNull();
	});

	it("names the missing CLI and its install page when a selected agent is not installed", () => {
		// A card that selected an agent the machine never installed has to learn
		// which CLI to install, not just that nothing is configured.
		const message = describeUnrunnableAgent(createRuntimeConfigState({ selectedAgentId: "pi" }));

		expect(message).toContain("Pi is not installed");
		expect(message).toContain("`pi` on PATH");
		expect(message ?? "").toContain("https://github.com/earendil-works/pi");
	});

	it("explains nothing when the selected CLI exists or the native agent is chosen", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");
		expect(describeUnrunnableAgent(createRuntimeConfigState({ selectedAgentId: "claude" }))).toBeNull();
		// Cline runs through the SDK session, so a missing `cline` binary is not
		// its story and the generic "nothing configured" answer stays correct.
		expect(describeUnrunnableAgent(createRuntimeConfigState({ selectedAgentId: "cline" }))).toBeNull();
		// An agent Kanban does not launch at all has no CLI to install here.
		expect(describeUnrunnableAgent(createRuntimeConfigState({ selectedAgentId: "gemini" }))).toBeNull();
	});
});

describe("buildRuntimeConfigResponse", () => {
	it("keeps curated agent default args independent of autonomous mode", () => {
		const config = createRuntimeConfigState({
			agentAutonomousModeEnabled: true,
		});

		const response = buildRuntimeConfigResponse(config, {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});

		expect(response.agentAutonomousModeEnabled).toBe(true);
		expect(response.agents.map((agent) => agent.id)).toEqual([
			"claude",
			"codex",
			"cline",
			"opencode",
			"droid",
			"kiro",
			"pi",
		]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "cline")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "droid")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "kiro")?.defaultArgs).toEqual(["chat"]);
		// AA-O1a: OpenCode joins the launchable set with no base arguments of its
		// own; `--auto` is added per launch, not baked into the default command.
		expect(response.agents.find((agent) => agent.id === "opencode")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "opencode")?.capabilities.explicitSessionResume).toBe(true);
		expect(response.agents.find((agent) => agent.id === "cline")?.installed).toBe(true);

		// AA-P1: Pi owns its model and has no plan or approval switch, so the
		// API must not describe Kanban as configuring either for it.
		const pi = response.agents.find((agent) => agent.id === "pi");
		expect(pi?.defaultArgs).toEqual([]);
		expect(pi?.command).toBe("pi");
		expect(pi?.modelConfiguration.source).toBe("agent-native");
		expect(pi?.capabilities.planMode).toBe("none");
		expect(pi?.capabilities.approvalMode).toBe("none");
	});

	it("omits autonomous flags from curated agent commands when disabled", () => {
		const config = createRuntimeConfigState({
			agentAutonomousModeEnabled: false,
		});
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const response = buildRuntimeConfigResponse(config, {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});

		expect(response.agentAutonomousModeEnabled).toBe(false);
		expect(response.agents.map((agent) => agent.id)).toEqual([
			"claude",
			"codex",
			"cline",
			"opencode",
			"droid",
			"kiro",
			"pi",
		]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "cline")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "droid")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "kiro")?.defaultArgs).toEqual(["chat"]);
		expect(response.agents.find((agent) => agent.id === "cline")?.installed).toBe(true);
		expect(response.agents.find((agent) => agent.id === "claude")?.command).toBe("claude");
		expect(response.agents.find((agent) => agent.id === "codex")?.command).toBe("codex");
		expect(response.agents.find((agent) => agent.id === "droid")?.command).toBe("droid");
		expect(response.agents.find((agent) => agent.id === "kiro")?.command).toBe("kiro-cli chat");
		// OpenCode's autonomous `--auto` comes from the launch, so the settings
		// command stays the bare binary either way.
		expect(response.agents.find((agent) => agent.id === "opencode")?.command).toBe("opencode");
		expect(response.agents.find((agent) => agent.id === "opencode")?.installed).toBe(false);
	});

	it("sets debug mode from runtime environment variables", () => {
		process.env.KANBAN_DEBUG_MODE = "true";
		const response = buildRuntimeConfigResponse(createRuntimeConfigState(), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});
		expect(response.debugModeEnabled).toBe(true);
	});

	it("supports debug_mode fallback env name", () => {
		process.env.debug_mode = "1";
		const response = buildRuntimeConfigResponse(createRuntimeConfigState(), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});
		expect(response.debugModeEnabled).toBe(true);
	});

	it("surfaces the stored context budget and caller-computed effective window (B-2.9)", () => {
		const config = createRuntimeConfigState({
			contextBudget: {
				contextWindowOverrideTokens: 131_072,
				compactionStrategy: "agentic",
			},
		});

		const response = buildRuntimeConfigResponse(
			config,
			{
				providerId: "litellm",
				modelId: "qwen3-32b",
				baseUrl: "http://127.0.0.1:4000",
				apiKeyConfigured: true,
				oauthProvider: null,
				oauthAccessTokenConfigured: false,
				oauthRefreshTokenConfigured: false,
				oauthAccountId: null,
				oauthExpiresAt: null,
			},
			{
				effectiveContextWindow: { limitTokens: 131_072, source: "override" },
			},
		);

		expect(response.contextBudget).toEqual({
			contextWindowOverrideTokens: 131_072,
			compactionStrategy: "agentic",
		});
		expect(response.effectiveContextWindow).toEqual({ limitTokens: 131_072, source: "override" });
	});

	it("defaults the context budget fields to null when unset", () => {
		const response = buildRuntimeConfigResponse(createRuntimeConfigState(), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});

		expect(response.contextBudget).toBeNull();
		expect(response.effectiveContextWindow).toBeNull();
	});
});
