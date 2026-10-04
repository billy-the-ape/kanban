// UPD-0.7 — preparation-state contract: while a start is pending the live
// stage is observable (the "held fetch" case) via the pollable status, and
// the durable record (prepared/blocked) is the source of truth once a
// preparation has finished. The query doubles as the reconnect/reload
// snapshot.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	clearInitialStartLiveStage,
	getTaskInitialStartEvidence,
	getTaskInitialStartStatus,
	setInitialStartLiveStage,
	writeTaskInitialStartRecord,
} from "../../src/workspace/task-initial-start";
import { createTempDir } from "../utilities/temp-dir";

describe("task initial-start status (UPD-0.7)", () => {
	let tempHome: string;
	let cleanupHome: () => void;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;

	beforeEach(() => {
		const dir = createTempDir("kanban-initial-start-home-");
		tempHome = dir.path;
		cleanupHome = dir.cleanup;
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterEach(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanupHome();
	});

	it("exposes the live stage while a preparation is pending, before it resolves", async () => {
		// Simulate a held fetch: the start is in flight and nothing has been
		// persisted yet. A client polling the status must observe the stage
		// without waiting for the start promise to settle.
		setInitialStartLiveStage("task-held", "refreshing");
		const status = await getTaskInitialStartStatus({ taskId: "task-held" });
		expect(status.ok).toBe(true);
		expect(status.stage).toBe("refreshing");
		expect(status.baselineSha).toBeNull();
		expect(status.failure).toBeNull();
		clearInitialStartLiveStage("task-held");
	});

	it("transitions through the live stages and falls back to the idle snapshot", async () => {
		setInitialStartLiveStage("task-stages", "refreshing");
		expect((await getTaskInitialStartStatus({ taskId: "task-stages" })).stage).toBe("refreshing");

		setInitialStartLiveStage("task-stages", "creating_worktree");
		expect((await getTaskInitialStartStatus({ taskId: "task-stages" })).stage).toBe("creating_worktree");

		clearInitialStartLiveStage("task-stages");
		const settled = await getTaskInitialStartStatus({ taskId: "task-stages" });
		expect(settled.stage).toBe("idle");
		expect(settled.initialStartBaselineFixed).toBe(false);
	});

	it("reports the durable prepared baseline as ready after completion", async () => {
		await writeTaskInitialStartRecord({
			taskId: "task-prepared",
			baseRef: "main",
			updateBaseRefBeforeStart: true,
			state: "prepared",
			baselineSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
			failure: null,
			updatedAt: Date.now(),
		});

		const status = await getTaskInitialStartStatus({ taskId: "task-prepared" });
		expect(status.stage).toBe("ready");
		expect(status.baselineSha).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
		// A prepared record alone fixes the baseline (re-derivable after a
		// reload with no in-memory state).
		expect(status.initialStartBaselineFixed).toBe(true);
		const evidence = await getTaskInitialStartEvidence("task-prepared");
		expect(evidence.preparedBaselineSha).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
	});

	it("reports a blocked preparation with the structured failure", async () => {
		await writeTaskInitialStartRecord({
			taskId: "task-blocked",
			baseRef: "main",
			updateBaseRefBeforeStart: true,
			state: "blocked",
			baselineSha: null,
			failure: {
				category: "auth_or_network_timeout",
				reason: "Fetching the origin failed",
				remedy: "Check network access and origin credentials, then start the task again.",
				selectedRef: "main",
			},
			updatedAt: Date.now(),
		});

		const status = await getTaskInitialStartStatus({ taskId: "task-blocked" });
		expect(status.stage).toBe("blocked");
		expect(status.baselineSha).toBeNull();
		expect(status.failure?.category).toBe("auth_or_network_timeout");
		expect(status.error).toContain("Fetching the origin failed");
		expect(status.error).toContain("Check network access");
	});

	it("prefers the live stage over a stale durable record while in flight", async () => {
		await writeTaskInitialStartRecord({
			taskId: "task-retry",
			baseRef: "main",
			updateBaseRefBeforeStart: true,
			state: "blocked",
			baselineSha: null,
			failure: null,
			updatedAt: Date.now(),
		});
		// A retry is now running: the in-flight stage is what a polling client
		// sees until the retry settles.
		setInitialStartLiveStage("task-retry", "refreshing");
		const inFlight = await getTaskInitialStartStatus({ taskId: "task-retry" });
		expect(inFlight.stage).toBe("refreshing");
		expect(inFlight.failure).toBeNull();
		clearInitialStartLiveStage("task-retry");
		const settled = await getTaskInitialStartStatus({ taskId: "task-retry" });
		expect(settled.stage).toBe("blocked");
	});
});
