import { describe, expect, it } from "vitest";

import {
	createHookRuntimeEnv,
	createLaunchAttemptId,
	isStaleHookAttempt,
	KANBAN_HOOK_ATTEMPT_ID_ENV,
	KANBAN_HOOK_TASK_ID_ENV,
	KANBAN_HOOK_WORKSPACE_ID_ENV,
	parseHookRuntimeContextFromEnv,
} from "../../../src/terminal/hook-runtime-context";

describe("hook-runtime-context", () => {
	it("creates expected environment variables", () => {
		const env = createHookRuntimeEnv({
			taskId: "task-1",
			workspaceId: "workspace-1",
		});
		expect(env).toEqual({
			[KANBAN_HOOK_TASK_ID_ENV]: "task-1",
			[KANBAN_HOOK_WORKSPACE_ID_ENV]: "workspace-1",
		});
	});

	it("parses hook runtime context from env", () => {
		const parsed = parseHookRuntimeContextFromEnv({
			[KANBAN_HOOK_TASK_ID_ENV]: "task-2",
			[KANBAN_HOOK_WORKSPACE_ID_ENV]: "workspace-2",
		});
		expect(parsed).toEqual({
			taskId: "task-2",
			workspaceId: "workspace-2",
		});
	});

	it("throws when required env vars are missing", () => {
		expect(() => parseHookRuntimeContextFromEnv({})).toThrow(
			`Missing required environment variable: ${KANBAN_HOOK_TASK_ID_ENV}`,
		);
	});
	it("includes the launch attempt token when the caller supplies one", () => {
		const env = createHookRuntimeEnv({
			taskId: "task-1",
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
		});
		expect(env).toEqual({
			[KANBAN_HOOK_TASK_ID_ENV]: "task-1",
			[KANBAN_HOOK_WORKSPACE_ID_ENV]: "workspace-1",
			[KANBAN_HOOK_ATTEMPT_ID_ENV]: "attempt-1",
		});
	});

	it("reads the attempt token back out of the agent environment", () => {
		const env = createHookRuntimeEnv({
			taskId: "task-1",
			workspaceId: "workspace-1",
			attemptId: "  attempt-1  ",
		});
		expect(parseHookRuntimeContextFromEnv(env)).toEqual({
			taskId: "task-1",
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
		});
	});

	it("only rejects an event whose token differs from the running attempt", () => {
		const withoutToken = parseHookRuntimeContextFromEnv({
			[KANBAN_HOOK_TASK_ID_ENV]: "task-1",
			[KANBAN_HOOK_WORKSPACE_ID_ENV]: "workspace-1",
		});
		expect(withoutToken.attemptId).toBeUndefined();
		// An integration that never sends a token cannot be proven stale.
		expect(isStaleHookAttempt({ eventAttemptId: undefined, sessionAttemptId: "attempt-2" })).toBe(false);
		// Neither can any event for a session started before tokens existed.
		expect(isStaleHookAttempt({ eventAttemptId: "attempt-1", sessionAttemptId: null })).toBe(false);
		// The attempt that is running owns its own events.
		expect(isStaleHookAttempt({ eventAttemptId: "attempt-2", sessionAttemptId: "attempt-2" })).toBe(false);
		// A superseded attempt may not move the card again.
		expect(isStaleHookAttempt({ eventAttemptId: "attempt-1", sessionAttemptId: "attempt-2" })).toBe(true);
	});

	it("mints a distinct attempt token for every launch", () => {
		const first = createLaunchAttemptId();
		const second = createLaunchAttemptId();
		expect(first).not.toBe(second);
		expect(first.trim().length).toBeGreaterThan(8);
	});
});
