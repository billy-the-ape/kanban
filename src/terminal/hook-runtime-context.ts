import { randomUUID } from "node:crypto";

export const KANBAN_HOOK_TASK_ID_ENV = "KANBAN_HOOK_TASK_ID";
export const KANBAN_HOOK_WORKSPACE_ID_ENV = "KANBAN_HOOK_WORKSPACE_ID";
/**
 * AA-S1: ownership token minted per launch attempt and echoed back by the hook
 * integration. It is a secret-ish capability: it travels through the agent
 * environment and the ingest request only, and never into public diagnostics.
 */
export const KANBAN_HOOK_ATTEMPT_ID_ENV = "KANBAN_HOOK_ATTEMPT_ID";

export interface HookRuntimeContext {
	taskId: string;
	workspaceId: string;
	/** Absent for integrations and persisted sessions predating AA-S1. */
	attemptId?: string | undefined;
}

function requireTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
	return value;
}

function readOptionalTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const value = env[key]?.trim();
	return value ? value : undefined;
}

export function createHookRuntimeEnv(context: HookRuntimeContext): Record<string, string> {
	const env: Record<string, string> = {
		[KANBAN_HOOK_TASK_ID_ENV]: context.taskId,
		[KANBAN_HOOK_WORKSPACE_ID_ENV]: context.workspaceId,
	};
	if (context.attemptId) {
		env[KANBAN_HOOK_ATTEMPT_ID_ENV] = context.attemptId;
	}
	return env;
}

export function parseHookRuntimeContextFromEnv(env: NodeJS.ProcessEnv = process.env): HookRuntimeContext {
	const taskId = requireTrimmedEnv(env, KANBAN_HOOK_TASK_ID_ENV);
	const workspaceId = requireTrimmedEnv(env, KANBAN_HOOK_WORKSPACE_ID_ENV);
	const attemptId = readOptionalTrimmedEnv(env, KANBAN_HOOK_ATTEMPT_ID_ENV);
	return {
		taskId,
		workspaceId,
		...(attemptId ? { attemptId } : {}),
	};
}

/**
 * AA-S1: minimal attempt-token check at the hook boundary. An event is stale
 * only when both the session and the event carry a token and they differ, so a
 * session launched before AA-S1 (or an integration that has not been updated)
 * keeps working untouched.
 */
export function isStaleHookAttempt(input: {
	eventAttemptId: string | null | undefined;
	sessionAttemptId: string | null | undefined;
}): boolean {
	const eventAttemptId = input.eventAttemptId?.trim();
	const sessionAttemptId = input.sessionAttemptId?.trim();
	if (!eventAttemptId || !sessionAttemptId) {
		return false;
	}
	return eventAttemptId !== sessionAttemptId;
}

/**
 * Mints the ownership token for one launch attempt. Every start (including an
 * automatic restart and a deliberate resume) mints a fresh token, which is what
 * makes events from a superseded child or plugin rejectable.
 */
export function createLaunchAttemptId(): string {
	return randomUUID();
}
