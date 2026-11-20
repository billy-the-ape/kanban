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

	it("never claims an agent resumes the exact session it started, except Cline", () => {
		for (const agentId of CATALOG_AGENT_IDS) {
			if (agentId === "cline") {
				continue;
			}
			// CLI-launched agents resume “the most recent session”, which is not
			// the session Kanban started for this card.
			expect(getRuntimeAgentCapabilities(agentId).explicitSessionResume).toBe(false);
		}
		expect(getRuntimeAgentCapabilities("cline").explicitSessionResume).toBe(true);
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

	it("reports the requested options an agent cannot honor", () => {
		// OpenCode has no approval-bypass switch, so an autonomous request is
		// refused instead of silently falling through to another agent's flags.
		expect(
			getUnsupportedAgentLaunchOperations("opencode", {
				autonomousModeRequested: true,
				imagesRequested: false,
				startInPlanMode: false,
			}),
		).toEqual(["autonomous-mode"]);

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
