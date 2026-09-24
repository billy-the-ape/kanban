import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { TerminalSessionManager } from "../terminal/session-manager";

/**
 * B-5.5/B-6.2: a task's worktree has an active writer while its native Cline
 * session or its terminal agent session is running. Review must not start and
 * cleanup must not remove the worktree while that is true.
 */
export function isTaskWriterActive(
	taskId: string,
	sessions: { clineTaskSessionService: ClineTaskSessionService; terminalManager: TerminalSessionManager },
): boolean {
	return (
		sessions.clineTaskSessionService.getSummary(taskId)?.state === "running" ||
		sessions.terminalManager.getSummary(taskId)?.state === "running"
	);
}
