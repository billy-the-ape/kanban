// B-10.3: operator-action availability derived from lifecycle records.
import { describe, expect, it } from "vitest";

import { computeTaskPhase, type TaskPhaseInput } from "../../../src/core/task-diagnostics";

function createInput(overrides: Partial<TaskPhaseInput> = {}): TaskPhaseInput {
	return {
		sessionActive: false,
		sessionRunning: false,
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

describe("computeTaskPhase current phase", () => {
	it("shows implementation only while the agent is running or dispatch is starting", () => {
		expect(computeTaskPhase(createInput({ sessionActive: true, sessionRunning: true })).phase).toBe("implementing");
		expect(computeTaskPhase(createInput({ dispatchStatus: "dispatching" })).phase).toBe("implementing");
	});

	it("does not call an awaiting session, retained worktree, or old dispatch record implementation", () => {
		const phase = computeTaskPhase(
			createInput({
				sessionActive: true,
				sessionRunning: false,
				worktreeExists: true,
				dispatchStatus: "dispatched",
			}),
		);
		expect(phase.phase).toBe("idle");
		expect(phase.actions.cancel.enabled).toBe(true);
	});

	it("reports a review verdict or active delivery phase after implementation", () => {
		expect(computeTaskPhase(createInput({ reviewStatus: "ready", worktreeExists: true })).phase).toBe("reviewing");
		expect(computeTaskPhase(createInput({ deliveryStatus: "in_progress", deliveryStage: "staged" })).phase).toBe(
			"committing",
		);
		expect(computeTaskPhase(createInput({ deliveryStatus: "delivered", dispatchStatus: "dispatched" })).phase).toBe(
			"done",
		);
	});
});
