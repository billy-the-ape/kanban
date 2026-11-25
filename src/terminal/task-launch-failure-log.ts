// AA-UNSUPPORTED: the server-side log line for a task launch that never produced
// a working agent session.
//
// A launch passes through several stages (settings validation, worktree
// preparation, model-capacity admission, adapter preparation, process spawn),
// and each one failed differently before: some were persisted, some were only
// returned to a caller that showed a transient toast. This module is the single
// operational log surface for all of them, so a report for "the card is in
// Progress with an empty terminal" can be answered from the server log alone.
//
// Lines carry the task id, the effective agent, the failing stage and the error
// message. They never carry prompts, arguments, environment or provider
// configuration — the launch environment holds API keys, and the error text is
// produced by adapters and the PTY layer, so it is truncated rather than passed
// through verbatim.
import type { RuntimeAgentId } from "../core/api-contract";

/** Where in the launch lifecycle a failure happened. */
export type TaskLaunchStage =
	/** The task's saved settings are not executable by the effective agent. */
	| "settings-validation"
	/** Base refresh / worktree creation failed. */
	| "worktree-preparation"
	/** Model-capacity admission (queue claim, queued spawn) failed. */
	| "capacity-admission"
	/** The agent adapter could not build a launch. */
	| "adapter-preparation"
	/** The CLI process could not be spawned. */
	| "process-spawn"
	/** An in-place recovery was refused because its evidence no longer holds. */
	| "recovery-precheck";

const MAX_LOG_MESSAGE_LENGTH = 500;

function singleLine(value: string): string {
	// Keep every failure on one log line so a report stays greppable.
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string): string {
	return value.length > MAX_LOG_MESSAGE_LENGTH ? `${value.slice(0, MAX_LOG_MESSAGE_LENGTH)}…` : value;
}

export function formatErrorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = singleLine(message);
	return normalized.length > 0 ? truncate(normalized) : "unknown error";
}

export interface TaskLaunchFailureLog {
	taskId: string;
	/** The agent that would have run the task, when it is already known. */
	agentId: RuntimeAgentId | null;
	stage: TaskLaunchStage;
	error: unknown;
	workspaceId?: string | null;
}

/**
 * Record one failed task launch. Written to stdout like the other operational
 * runtime logs (`logWorkspaceEvent`), because a launch that persisted nothing
 * would otherwise leave no trace at all.
 */
export function logTaskLaunchFailure(entry: TaskLaunchFailureLog): void {
	const parts = [
		`[kanban] task-launch-failed task=${entry.taskId}`,
		`stage=${entry.stage}`,
		`agent=${entry.agentId ?? "unknown"}`,
		`error=${formatErrorText(entry.error)}`,
	];
	if (entry.workspaceId) {
		parts.push(`workspace=${entry.workspaceId}`);
	}
	process.stdout.write(`${parts.join(" ")}\n`);
}

/** A launch failure the user must act on, phrased as one actionable sentence. */
export function formatTaskLaunchFailureMessage(stage: TaskLaunchStage, detail: string): string {
	switch (stage) {
		case "adapter-preparation":
			return `Could not prepare the agent launch: ${detail}`;
		case "process-spawn":
			return `Could not start the agent process: ${detail}`;
		case "capacity-admission":
			return `Could not admit this task to the model queue: ${detail}`;
		case "settings-validation":
			return detail;
		case "recovery-precheck":
			return detail;
		case "worktree-preparation":
			return `Could not prepare the task workspace: ${detail}`;
	}
}
