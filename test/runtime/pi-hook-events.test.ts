// AA-P1: Pi reports structured fields from Kanban's own extension, so this
// normalizer must read those fields instead of guessing from Claude- or
// Codex-shaped payloads.
import { describe, expect, it } from "vitest";
import { normalizePiHookMetadata } from "../../src/commands/hook-events/pi-hook-events";

describe("normalizePiHookMetadata", () => {
	it("describes a settled turn from the payload alone", () => {
		const metadata = normalizePiHookMetadata({
			event: "to_review",
			sourceHint: "pi",
			flagMetadata: {},
			payload: {
				source: "pi",
				hook_event_name: "agent_settled",
				final_message: "Fixed  the   flaky test.\nCommit is ready.",
				pi_session_id: "kanban-abc",
			},
		});

		expect(metadata).toMatchObject({
			source: "pi",
			hookEventName: "agent_settled",
			notificationType: null,
			finalMessage: "Fixed the flaky test. Commit is ready.",
			activityText: "Final: Fixed the flaky test. Commit is ready.",
		});
	});

	it("keeps a failed turn labelled as an error", () => {
		const metadata = normalizePiHookMetadata({
			event: "activity",
			sourceHint: "pi",
			flagMetadata: { source: "pi", hookEventName: "agent_settled", notificationType: "error" },
			payload: { pi_error: "upstream 502" },
		});

		expect(metadata).toMatchObject({
			source: "pi",
			hookEventName: "agent_settled",
			notificationType: "error",
			activityText: "Pi stopped: upstream 502",
		});
	});

	it("names the tool a completed run finished with", () => {
		const completed = normalizePiHookMetadata({
			event: "activity",
			sourceHint: "pi",
			flagMetadata: {},
			payload: { hook_event_name: "tool_execution_end", tool_name: "bash" },
		});
		const failed = normalizePiHookMetadata({
			event: "activity",
			sourceHint: "pi",
			flagMetadata: {},
			payload: { hook_event_name: "tool_execution_end", tool_name: "bash", notification_type: "error" },
		});

		expect(completed).toMatchObject({ toolName: "bash", activityText: "Completed bash" });
		expect(failed).toMatchObject({ notificationType: "error", activityText: "Failed bash" });
	});

	it("describes a session that switched away from the card", () => {
		const metadata = normalizePiHookMetadata({
			event: "activity",
			sourceHint: "pi",
			flagMetadata: { hookEventName: "session_changed" },
			payload: null,
		});

		expect(metadata?.activityText).toBe("Pi switched away from the Kanban session; this card no longer follows it");
	});

	it("prefers the flags the extension sent over anything inferred", () => {
		const metadata = normalizePiHookMetadata({
			event: "activity",
			sourceHint: "pi",
			flagMetadata: { activityText: "Model: vllm/Qwen3-Coder", hookEventName: "model_select" },
			payload: { hook_event_name: "model_select", pi_model: "other/model" },
		});

		expect(metadata).toMatchObject({
			hookEventName: "model_select",
			activityText: "Model: vllm/Qwen3-Coder",
		});
	});

	it("never repeats raw Pi payload text it cannot label", () => {
		const metadata = normalizePiHookMetadata({
			event: "activity",
			sourceHint: "pi",
			flagMetadata: {},
			payload: { hook_event_name: "some_future_pi_event", detail: "a wall of unrelated text" },
		});

		expect(metadata).toMatchObject({ hookEventName: "some_future_pi_event" });
		expect(metadata?.activityText).toBeNull();
	});
});
