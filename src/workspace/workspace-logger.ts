/**
 * UPD-0.9: operational logging for the workspace layer. Direct console calls
 * are forbidden in src/ (grit/no-console); these plain stdout lines are the
 * runtime log surface the server process surfaces (fetch/refresh stage
 * progress must never be mistaken for task run state — see the caller sites).
 */
export function logWorkspaceEvent(message: string): void {
	process.stdout.write(`[kanban] ${message}\n`);
}
