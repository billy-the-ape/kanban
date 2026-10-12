import type { RuntimeTaskSessionSummary } from "./api-contract";

interface TerminalSessionSource {
	listSummaries(): RuntimeTaskSessionSummary[];
	hasActiveProcess(taskId: string): boolean;
}

export function reconcileOrphanedSessionSummary(
	summary: RuntimeTaskSessionSummary,
	hasActiveProcess: boolean,
): RuntimeTaskSessionSummary {
	if (summary.state !== "running" || hasActiveProcess) return summary;
	return {
		...summary,
		state: "interrupted",
		reviewReason: "interrupted",
		pid: null,
		updatedAt: Math.max(Date.now(), summary.updatedAt + 1),
	};
}

/** Resolve live owners before exposing or saving persisted session summaries. */
export function resolveWorkspaceSessionSummaries(
	persisted: Record<string, RuntimeTaskSessionSummary>,
	terminal: TerminalSessionSource,
	clineSummaries: RuntimeTaskSessionSummary[],
): Record<string, RuntimeTaskSessionSummary> {
	const sessions = { ...persisted };
	for (const summary of terminal.listSummaries()) {
		const existing = sessions[summary.taskId];
		if (terminal.hasActiveProcess(summary.taskId) || !existing || summary.updatedAt > existing.updatedAt) {
			sessions[summary.taskId] = summary;
		}
	}
	for (const [taskId, summary] of Object.entries(sessions)) {
		// A disk record has no executing turn. Keep history/workspace/checkpoints,
		// but give clients a newer stopped summary that supersedes the stale flag.
		sessions[taskId] = reconcileOrphanedSessionSummary(summary, terminal.hasActiveProcess(taskId));
	}
	// Native Cline entries belong to the current runtime, including idle/review
	// states. A hydrated terminal copy must never override their owner.
	for (const summary of clineSummaries) {
		if (!terminal.hasActiveProcess(summary.taskId)) {
			sessions[summary.taskId] = summary;
		}
	}
	return sessions;
}
