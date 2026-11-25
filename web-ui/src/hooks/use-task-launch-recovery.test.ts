import { describe, expect, it } from "vitest";

import { mayHaveUnstartedLaunch } from "@/hooks/use-task-launch-recovery";

// Asking the server costs a read of the baseline record, the worktree HEAD and
// the agent's own session evidence, so the card detail view only asks when the
// answer can change what it shows. These cases are the boundary: the states that
// look similar in the board ("idle", "no pid") but mean different things.

describe("mayHaveUnstartedLaunch (AA-UNSUPPORTED)", () => {
	it("asks for a card in progress with no session record at all", () => {
		// The whole reason the question exists: a launch that failed before it
		// persisted anything leaves no summary, and a missing summary is not a live
		// session.
		expect(mayHaveUnstartedLaunch({ columnId: "in_progress", sessionSummary: null })).toBe(true);
	});

	it("asks for a stopped session that never reported a process", () => {
		expect(
			mayHaveUnstartedLaunch({
				columnId: "in_progress",
				sessionSummary: { state: "idle", pid: null, reviewReason: null },
			}),
		).toBe(true);
		expect(
			mayHaveUnstartedLaunch({
				columnId: "review",
				sessionSummary: { state: "failed", pid: null, reviewReason: "error" },
			}),
		).toBe(true);
	});

	it("stays quiet while an agent is working", () => {
		expect(
			mayHaveUnstartedLaunch({
				columnId: "in_progress",
				sessionSummary: { state: "running", pid: 4242, reviewReason: null },
			}),
		).toBe(false);
		expect(
			mayHaveUnstartedLaunch({
				columnId: "in_progress",
				sessionSummary: { state: "idle", pid: 4242, reviewReason: null },
			}),
		).toBe(false);
	});

	it("leaves an interrupted card to Restore", () => {
		// Relaunching would begin a second conversation for a card whose own
		// conversation is waiting to be resumed.
		expect(
			mayHaveUnstartedLaunch({
				columnId: "review",
				sessionSummary: { state: "interrupted", pid: null, reviewReason: "interrupted" },
			}),
		).toBe(false);
		expect(
			mayHaveUnstartedLaunch({
				columnId: "in_progress",
				sessionSummary: { state: "awaiting_review", pid: null, reviewReason: "interrupted" },
			}),
		).toBe(false);
		// A review parked on a failed turn is a different story: nothing is waiting
		// to be resumed.
		expect(
			mayHaveUnstartedLaunch({
				columnId: "review",
				sessionSummary: { state: "awaiting_review", pid: null, reviewReason: "error" },
			}),
		).toBe(true);
	});

	it("does not ask about a card that cannot have a worktree yet", () => {
		expect(mayHaveUnstartedLaunch({ columnId: "backlog", sessionSummary: null })).toBe(false);
		expect(mayHaveUnstartedLaunch({ columnId: "done", sessionSummary: null })).toBe(false);
	});
});
