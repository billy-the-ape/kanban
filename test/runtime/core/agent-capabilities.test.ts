import { describe, expect, it } from "vitest";

import {
	describeAgentLaunchOperation,
	formatMissingAgentInstallError,
	formatUnsupportedAgentLaunchError,
	getRuntimeAgentCapabilities,
	getRuntimeAgentModelConfiguration,
	getUnsupportedAgentLaunchOperations,
} from "../../../src/core/agent-capabilities";
import { RUNTIME_AGENT_CATALOG } from "../../../src/core/agent-catalog";
import type { RuntimeAgentId } from "../../../src/core/api-contract";

const CATALOG_AGENT_IDS = RUNTIME_AGENT_CATALOG.map((entry) => entry.id);

describe("agent capabilities (AA-S1)", () => {
	it("describes every catalogued agent", () => {
		for (const agentId of CATALOG_AGENT_IDS) {
			const capabilities = getRuntimeAgentCapabilities(agentId);
			expect(capabilities.terminalPresentation).toBeTypeOf("boolean");
			expect(capabilities.explicitSessionResume).toBeTypeOf("boolean");
			expect(capabilities.images).toBeTypeOf("boolean");
			expect(capabilities.automatedDelivery).toBeTypeOf("boolean");
			expect(["cli-flag", "config-file", "prompt", "none"]).toContain(capabilities.planMode);
			expect(["cli-flag", "config-file", "prompt", "none"]).toContain(capabilities.approvalMode);
			expect(["hook", "exit-only"]).toContain(capabilities.completionSignal);

			const modelConfiguration = getRuntimeAgentModelConfiguration(agentId);
			expect(["kanban-settings", "agent-native", "unknown"]).toContain(modelConfiguration.source);
			expect(modelConfiguration.note.trim().length).toBeGreaterThan(0);
		}
	});

	it("only claims an exact previous session where the CLI really takes one", () => {
		// Cline resumes the stored task session, and AA-O1a added OpenCode
		// because its release publishes `--session <id>` for exactly that.
		// Everything else resumes “the most recent session”, which is not the
		// session Kanban started for this card.
		const exactResumeAgents = CATALOG_AGENT_IDS.filter(
			(agentId) => getRuntimeAgentCapabilities(agentId).explicitSessionResume,
		);
		expect(exactResumeAgents.sort()).toEqual(["cline", "opencode"]);
		expect(getRuntimeAgentCapabilities("claude").explicitSessionResume).toBe(false);
		expect(getRuntimeAgentCapabilities("codex").explicitSessionResume).toBe(false);
	});

	it("only presents Cline's provider settings as Kanban-owned model configuration", () => {
		expect(getRuntimeAgentModelConfiguration("cline").source).toBe("kanban-settings");
		for (const agentId of CATALOG_AGENT_IDS) {
			if (agentId === "cline") {
				continue;
			}
			// Kanban must never present the Cline provider as another agent's model.
			expect(getRuntimeAgentModelConfiguration(agentId).source).toBe("agent-native");
		}
	});

	it("keeps OpenCode model selection inside OpenCode's own configuration", () => {
		const modelConfiguration = getRuntimeAgentModelConfiguration("opencode");
		expect(modelConfiguration.source).toBe("agent-native");
		// AA-O1a: Kanban only passes `--model` for a model the user selected in
		// their own OpenCode configuration (or its documented override), never
		// one read out of OpenCode's auth store and never a hosted provider
		// preference - so the note has to say which of those it is.
		expect(modelConfiguration.note).toContain("--model");
		expect(modelConfiguration.note).toContain("auth");
		expect(modelConfiguration.configLocations.some((location) => location.includes("opencode"))).toBe(true);
		expect(modelConfiguration.configLocations.some((location) => location.includes("auth"))).toBe(false);
	});

	it("reports the requested options an agent cannot honor", () => {
		// AA-O1a: the pinned release publishes `--auto` and `--agent plan`, so
		// autonomy and planning are both supported. What OpenCode cannot do is
		// take attachments - only the one-shot `run` form has an attachment flag
		// and Kanban launches the interactive TUI - so that request is refused by
		// name instead of being dropped.
		expect(
			getUnsupportedAgentLaunchOperations("opencode", {
				autonomousModeRequested: true,
				startInPlanMode: true,
				imagesRequested: false,
			}),
		).toEqual([]);
		expect(getUnsupportedAgentLaunchOperations("opencode", { imagesRequested: true })).toEqual(["image-attachment"]);

		expect(
			getUnsupportedAgentLaunchOperations("claude", {
				autonomousModeRequested: true,
				imagesRequested: true,
				startInPlanMode: true,
			}),
		).toEqual([]);

		// Nothing is requested, so nothing can be unsupported.
		expect(getUnsupportedAgentLaunchOperations("kiro", {})).toEqual([]);
	});

	it("names the agent and the unsupported option in the launch error", () => {
		const message = formatUnsupportedAgentLaunchError("opencode", ["autonomous-mode", "explicit-resume"]);
		expect(message).not.toBeNull();
		expect(message ?? "").toContain("OpenCode");
		expect(message ?? "").toContain(describeAgentLaunchOperation("autonomous-mode"));
		expect(message ?? "").toContain(describeAgentLaunchOperation("explicit-resume"));

		expect(formatUnsupportedAgentLaunchError("claude", [])).toBeNull();
	});

	it("points at the install location for a missing binary instead of starting a phantom session", () => {
		const agentId = RUNTIME_AGENT_CATALOG.find((entry) => entry.id === "droid")?.id;
		if (agentId !== "droid") {
			throw new Error("expected the catalog to keep a droid entry for install guidance");
		}
		const message = formatMissingAgentInstallError(agentId satisfies RuntimeAgentId);
		expect(message).toContain("droid");
		expect(message).toContain(RUNTIME_AGENT_CATALOG.find((entry) => entry.id === "droid")?.installUrl ?? "");
	});
});
