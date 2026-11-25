import { describe, expect, it } from "vitest";

import {
	agentSupportsAutonomousMode,
	agentSupportsImages,
	agentSupportsPlanMode,
	checkTaskLaunchRequirements,
	describeUnsupportedTaskSetting,
	getUnsupportedTaskLaunchOperations,
	imagesUnsupported,
	planModeUnsupported,
	resolveEffectiveTaskAgentId,
} from "../../../src/core/task-launch-requirements";

describe("task launch requirements (AA-UNSUPPORTED)", () => {
	it("refuses a plan-mode request for an agent that has no planning mode", () => {
		const check = checkTaskLaunchRequirements("pi", { startInPlanMode: true });
		expect(check.ok).toBe(false);
		expect(check.unsupportedOperations).toEqual(["plan-mode"]);
		// The message names the agent and the option, so the fix is in the error.
		expect(check.error).toContain("Pi");
		expect(check.error).toContain("plan mode");
	});

	it("accepts the same request for an agent that does support it", () => {
		expect(checkTaskLaunchRequirements("cline", { startInPlanMode: true }).ok).toBe(true);
		expect(checkTaskLaunchRequirements("claude", { startInPlanMode: true }).ok).toBe(true);
		// `prompt` means the agent plans through instructions, which is a plan run.
		expect(checkTaskLaunchRequirements("kiro", { startInPlanMode: true }).ok).toBe(true);
	});

	it("refuses attachments for an agent whose CLI cannot receive them", () => {
		const check = checkTaskLaunchRequirements("opencode", { imagesRequested: true });
		expect(check.ok).toBe(false);
		expect(check.unsupportedOperations).toEqual(["image-attachment"]);
		expect(check.error).toContain("image attachments");
	});

	it("reports nothing when the task asks for no option", () => {
		for (const agentId of ["pi", "cline", "claude", "codex", "opencode", "droid", "kiro"] as const) {
			expect(getUnsupportedTaskLaunchOperations(agentId, {})).toEqual([]);
			expect(checkTaskLaunchRequirements(agentId, {}).ok).toBe(true);
		}
	});

	it("lists every unsupported option at once", () => {
		const check = checkTaskLaunchRequirements("opencode", {
			startInPlanMode: false,
			imagesRequested: true,
		});
		expect(check.unsupportedOperations).toEqual(["image-attachment"]);
		expect(
			checkTaskLaunchRequirements("pi", { startInPlanMode: true, imagesRequested: true }).unsupportedOperations,
		).toEqual(["plan-mode"]);
	});

	it("explains a disabled option in one sentence, and only when it is unavailable", () => {
		expect(describeUnsupportedTaskSetting("pi", "plan-mode")).toBe("Pi does not support plan mode.");
		expect(describeUnsupportedTaskSetting("cline", "plan-mode")).toBeNull();
		expect(describeUnsupportedTaskSetting("opencode", "image-attachment")).toBe(
			"OpenCode cannot receive image attachments.",
		);
		// Nothing selected yet: the agent picker reports that, not the checkbox.
		expect(describeUnsupportedTaskSetting(null, "plan-mode")).toBeNull();
	});

	it("exposes capability checks the UI can call directly", () => {
		expect(agentSupportsPlanMode("pi")).toBe(false);
		expect(agentSupportsPlanMode("cline")).toBe(true);
		expect(agentSupportsImages("opencode")).toBe(false);
		expect(agentSupportsImages("pi")).toBe(true);
		// Pi has no approval prompt, so there is nothing for the toggle to bypass.
		expect(agentSupportsAutonomousMode("pi")).toBe(false);
		expect(agentSupportsAutonomousMode("claude")).toBe(true);
	});

	it("does not disable a setting while no agent is selected", () => {
		expect(planModeUnsupported(null)).toBe(false);
		expect(planModeUnsupported(undefined)).toBe(false);
		expect(planModeUnsupported("pi")).toBe(true);
		expect(imagesUnsupported(null)).toBe(false);
		expect(imagesUnsupported("opencode")).toBe(true);
	});

	it("resolves the effective agent with the same precedence the launcher uses", () => {
		expect(resolveEffectiveTaskAgentId({ taskAgentId: "pi", defaultAgentId: "cline" })).toBe("pi");
		expect(resolveEffectiveTaskAgentId({ defaultAgentId: "cline" })).toBe("cline");
		// A session-recorded agent (trash resume) outranks the card override.
		expect(
			resolveEffectiveTaskAgentId({ taskAgentId: "claude", defaultAgentId: "cline", sessionAgentId: "pi" }),
		).toBe("pi");
		expect(resolveEffectiveTaskAgentId({})).toBeNull();
	});
});
