import { describe, expect, it } from "vitest";

import { resolveTaskSettingNotices } from "@/hooks/task-setting-notices";
import type { RuntimeAgentId } from "@/runtime/types";

// The capability rows live in `src/core/agent-capabilities.ts`; these assert the
// shape the editor form shows, including the two cases a user can only discover
// by being told: a saved setting the new agent cannot honor, and attachments
// that would silently never arrive.

describe("resolveTaskSettingNotices (AA-UNSUPPORTED)", () => {
	it("disables plan mode and explains the agent instead of silently deselecting it", () => {
		const notices = resolveTaskSettingNotices({ agentId: "pi" as unknown as RuntimeAgentId });

		expect(notices.planModeDisabled).toBe(true);
		expect(notices.planModeNotice).toContain("plan mode");
		expect(notices.planModeNotice).toContain("Pi");
	});

	it("leaves the option usable for an agent that has a planning mode", () => {
		const notices = resolveTaskSettingNotices({
			agentId: "claude" as unknown as RuntimeAgentId,
			hasAttachments: true,
		});

		expect(notices.planModeDisabled).toBe(false);
		expect(notices.planModeNotice).toBeNull();
		// Claude receives images, so nothing may warn about them either.
		expect(notices.attachmentsNotice).toBeNull();
	});

	it("says when disabling the option clears a setting the card already saved", () => {
		const plain = resolveTaskSettingNotices({ agentId: "pi" as unknown as RuntimeAgentId });
		const saved = resolveTaskSettingNotices({
			agentId: "pi" as unknown as RuntimeAgentId,
			storedPlanModeRequested: true,
		});

		expect(plain.planModeNotice).not.toContain("Saved setting cleared");
		expect(saved.planModeNotice).toContain("Saved setting cleared");
	});

	it("marks attachments as undeliverable for an agent with no image input", () => {
		// OpenCode's interactive TUI has no attachment flag, so the ask has to be
		// refused out loud instead of dropping the images on the way in.
		const drafts = resolveTaskSettingNotices({
			agentId: "opencode" as unknown as RuntimeAgentId,
			hasAttachments: true,
		});
		const saved = resolveTaskSettingNotices({
			agentId: "opencode" as unknown as RuntimeAgentId,
			hasAttachments: true,
			storedAttachments: true,
		});

		expect(drafts.attachmentsNotice).toContain("These attachments cannot be sent");
		expect(drafts.attachmentsNotice).toContain("OpenCode");
		expect(saved.attachmentsNotice).toContain("Saved attachments cannot be sent");
	});

	it("disables nothing while no agent has been chosen", () => {
		// The missing selection is the agent picker's problem to report; the option
		// rows must not light up in response to it.
		const notices = resolveTaskSettingNotices({ agentId: null });

		expect(notices.planModeDisabled).toBe(false);
		expect(notices.planModeNotice).toBeNull();
		expect(notices.attachmentsNotice).toBeNull();
	});
});
