// B-1.7 — Deterministic regression for the September 16 restart defect:
// after a Kanban service restart, the persisted transcript is still visible
// but any follow-up (or board reload) fails with
// "No previous Cline session config is available for task ...".
//
// Root cause under test: InMemoryClineSessionRuntime keeps the restart
// configuration (provider, model, cwd, system prompt, ...) only in the
// in-memory `lastStartRequestByTaskId` map (src/cline-sdk/cline-session-runtime.ts).
// A fresh process has an empty map, so restartTaskSession throws
// (cline-session-runtime.ts:289-292) and the follow-up path in
// InMemoryClineTaskSessionService surfaces the failure instead of
// reconstructing configuration from the persisted session record + task state.
//
// Tests marked "[B-1 repro]" assert the DESIRED behavior and FAIL on baseline
// abd4912. They are skipped on the baseline (it.skip) so the suite stays
// green; REMOVE the skip when B-4 reconstructs restart configuration and the
// tests pass. See the evidence report in docs/plans/B-1.md.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createTaskSessionServiceHarness,
	type TaskSessionServiceHarness,
} from "../../utilities/cline-session-service-harness";

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
	deleteTaskTurnCheckpointRef: vi.fn(),
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
	deleteTaskTurnCheckpointRef: turnCheckpointMocks.deleteTaskTurnCheckpointRef,
}));

beforeEach(() => {
	turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
	turnCheckpointMocks.deleteTaskTurnCheckpointRef.mockReset();
	turnCheckpointMocks.captureTaskTurnCheckpoint.mockImplementation(
		async (input: { taskId: string; turn: number }) => ({
			turn: input.turn,
			ref: `refs/kanban/checkpoints/${input.taskId}/turn/${input.turn}`,
			commit: `commit-${input.turn}`,
			createdAt: input.turn,
		}),
	);
	turnCheckpointMocks.deleteTaskTurnCheckpointRef.mockResolvedValue(undefined);
});

const RESTART_TASK_ID = "task-restart-1";

const services: TaskSessionServiceHarness[] = [];

afterEach(async () => {
	await Promise.allSettled(services.splice(0).map((harness) => harness.service.dispose()));
});

/**
 * Simulates a Kanban service restart: service A runs one full turn against
 * the shared store (the persisted session data), then is disposed. The second
 * harness is a fresh service + runtime whose in-memory maps are empty but
 * whose fake host reads the same persisted records.
 */
async function restartService(
	firstHarness: TaskSessionServiceHarness,
): Promise<{ before: TaskSessionServiceHarness; after: TaskSessionServiceHarness }> {
	const { service, host } = firstHarness;
	await service.startTaskSession({
		taskId: RESTART_TASK_ID,
		cwd: "/tmp/worktree",
		prompt: "First turn before restart",
		systemPrompt: "test system prompt",
		taskTitle: "B-1.7 restart repro",
	});
	await vi.waitFor(() => {
		expect(host.sentPrompts.length).toBe(1);
	});
	await service.stopTaskSession(RESTART_TASK_ID);
	await service.dispose();
	services.splice(services.indexOf(firstHarness), 1);

	const after = createTaskSessionServiceHarness({ store: firstHarness.store });
	services.push(after);
	return { before: firstHarness, after };
}
describe("service restart with a persisted session (B-1.7)", () => {
	it("keeps the persisted transcript visible after restart", async () => {
		const first = createTaskSessionServiceHarness();
		services.push(first);
		const { after } = await restartService(first);

		const messages = await after.service.loadTaskSessionMessages(RESTART_TASK_ID);

		// Observed behavior preserved: the original messages remain visible.
		expect(messages.map((message) => message.content)).toContain("First turn before restart");
	});

	it.skip("[B-1 repro] board reload after restart does not surface the missing session config error", async () => {
		const first = createTaskSessionServiceHarness();
		services.push(first);
		const { after } = await restartService(first);

		const summary = await after.service.reloadTaskSession(RESTART_TASK_ID);

		// Desired: the persisted session is rebound and the task is usable
		// again without the in-memory start request.
		expect(summary).not.toBeNull();
		expect(summary?.reviewReason).not.toBe("error");
		expect(summary?.warningMessage ?? "").not.toContain("No previous Cline session config");
	});

	it.skip("[B-1 repro] a follow-up sent after restart reaches the session instead of failing", async () => {
		const first = createTaskSessionServiceHarness();
		services.push(first);
		const { after } = await restartService(first);

		// The board reload creates the hydrated entry; then the user follows up.
		await after.service.reloadTaskSession(RESTART_TASK_ID);
		await after.service.sendTaskSessionInput(RESTART_TASK_ID, "Follow up after restart");
		// Wait for either delivery (desired) or the baseline error state.
		await vi.waitFor(() => {
			expect(
				after.host.sentPrompts.length >= 1 || after.service.getSummary(RESTART_TASK_ID)?.reviewReason === "error",
			).toBe(true);
		});

		// Desired: the follow-up is delivered to the (restarted) session and
		// the task is not left in an error state.
		expect(after.host.sentPrompts.map((entry) => entry.prompt)).toContain("Follow up after restart");
		expect(after.service.getSummary(RESTART_TASK_ID)?.reviewReason).not.toBe("error");
	});

	it("characterization: on baseline the reload fails with the missing session config error", async () => {
		const first = createTaskSessionServiceHarness();
		services.push(first);
		const { after } = await restartService(first);

		const summary = await after.service.reloadTaskSession(RESTART_TASK_ID);

		// Observed baseline behavior (the deployed restart defect): the fresh
		// runtime has no lastStartRequestByTaskId entry, so the restart path
		// throws and the reload lands in an error state.
		expect(summary?.reviewReason).toBe("error");
		expect(summary?.warningMessage).toContain(
			`No previous Cline session config is available for task ${RESTART_TASK_ID}`,
		);
	});

	it("characterization: follow-ups in the same process still restart with the in-memory config", async () => {
		const harness = createTaskSessionServiceHarness();
		services.push(harness);
		const { service, host } = harness;

		await service.startTaskSession({
			taskId: RESTART_TASK_ID,
			cwd: "/tmp/worktree",
			prompt: "First turn before stop",
			systemPrompt: "test system prompt",
		});
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBe(1);
		});
		// The real host emits "ended" when a turn completes; that clears the
		// live binding and moves the task to awaiting_review, so the next user
		// message goes through the restart path.
		const firstSessionId = host.startedConfigs[0]?.sessionId ?? "";
		host.emitEvent({ type: "ended", payload: { sessionId: firstSessionId, reason: "completed" } });
		await vi.waitFor(() => {
			expect(service.getSummary(RESTART_TASK_ID)?.state).toBe("awaiting_review");
		});
		await service.sendTaskSessionInput(RESTART_TASK_ID, "Follow up in process");
		await vi.waitFor(() => {
			expect(host.sentPrompts.length).toBe(2);
		});

		// Within one process the in-memory lastStartRequestByTaskId entry
		// exists, so the restart path works. This isolates the defect to the
		// process boundary (B-1.7).
		expect(host.startedConfigs.length).toBe(2);
		expect(host.sentPrompts.at(-1)?.prompt).toBe("Follow up in process");
		expect(service.getSummary(RESTART_TASK_ID)?.reviewReason).not.toBe("error");
	});
});
