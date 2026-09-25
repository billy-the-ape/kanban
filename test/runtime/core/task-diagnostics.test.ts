// B-10.3: operator-action availability derived from lifecycle records.
import { describe, expect, it } from "vitest";

import { computeTaskPhase, type TaskPhaseInput } from "../../../src/core/task-diagnostics";

function createInput(overrides: Partial<TaskPhaseInput> = {}): TaskPhaseInput {
	return {
		sessionActive: false,
		deliveryStatus: null,
		deliveryStage: null,
		deliveryEvidence: [],
		reviewStatus: null,
		reviewError: null,
		dispatchStatus: null,
		dispatchError: null,
		preservationStatus: "none",
		preservationBlockedReasons: [],
		worktreeExists: false,
		...overrides,
	};
}

describe("computeTaskPhase retry availability", () => {
	it("offers retry for a failed review with no delivery", () => {
		const result = computeTaskPhase(createInput({ reviewStatus: "failed", reviewError: "model error" }));
		expect(result.actions.retry_phase.enabled).toBe(true);
	});

	it("offers retry and resume for a paused delivery", () => {
		const result = computeTaskPhase(createInput({ deliveryStatus: "paused", deliveryStage: "committed" }));
		expect(result.actions.retry_phase.enabled).toBe(true);
		expect(result.actions.resume_repair.enabled).toBe(true);
	});

	it("does not offer retry for a stale review failure once delivery finished", () => {
		const result = computeTaskPhase(
			createInput({ reviewStatus: "failed", deliveryStatus: "delivered", deliveryStage: "verified" }),
		);
		expect(result.actions.retry_phase).toEqual({ enabled: false, reason: "Task is already delivered." });
	});

	it("does not offer retry for a review failure while delivery is in progress", () => {
		const result = computeTaskPhase(
			createInput({ reviewStatus: "parse_failed", deliveryStatus: "in_progress", deliveryStage: "committed" }),
		);
		expect(result.actions.retry_phase).toEqual({ enabled: false, reason: "Delivery is already in progress." });
	});

	it("offers cancel only while a session is active", () => {
		expect(computeTaskPhase(createInput({ sessionActive: true })).actions.cancel.enabled).toBe(true);
		expect(computeTaskPhase(createInput()).actions.cancel.enabled).toBe(false);
	});
});
