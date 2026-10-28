import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { TerminalSessionManager } from "../terminal/session-manager";

type TaskWriterSessions = {
	clineTaskSessionService: Pick<ClineTaskSessionService, "getSummary">;
	terminalManager: Pick<TerminalSessionManager, "getSummary" | "hasActiveProcess">;
};

/** Raw owners and process evidence, shared by admission checks and diagnostics. */
export function getTaskWriterActivity(taskId: string, sessions: TaskWriterSessions) {
	const clineSummary = sessions.clineTaskSessionService.getSummary(taskId);
	const terminalSummary = sessions.terminalManager.getSummary(taskId);
	const terminalHasActiveProcess = sessions.terminalManager.hasActiveProcess(taskId);
	return {
		clineSummary,
		terminalSummary,
		terminalHasActiveProcess,
		writerActive:
			clineSummary?.state === "running" || (terminalHasActiveProcess && terminalSummary?.state === "running"),
	};
}

/**
 * B-5.5/B-6.2: a task's worktree has an active writer while its native Cline
 * session or its terminal agent session is running. Review must not start and
 * cleanup must not remove the worktree while that is true.
 */
export function isTaskWriterActive(taskId: string, sessions: TaskWriterSessions): boolean {
	// The terminal manager also hydrates native Cline summaries from disk.
	// A restored "running" flag without a process cannot hold the worktree.
	return getTaskWriterActivity(taskId, sessions).writerActive;
}
