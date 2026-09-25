import { listWorkspaceIndexEntries, loadWorkspaceBoardById } from "../state/workspace-state";
import { readTaskDeliveryReceipt } from "../workspace/git-delivery";
import { runTaskWorkspaceMaintenance } from "../workspace/task-workspace-maintenance";

/**
 * B-5.7/B-5.9: at runtime startup, run workspace maintenance for every indexed
 * project — retry cleanups a crash or restart left behind, dispose delivered
 * Done worktrees, and apply preservation retention. No agent session is
 * running yet, so there is no active writer to wait for. Failures are
 * reported, never fatal.
 */
export async function runStartupTaskWorkspaceMaintenance(warn: (message: string) => void): Promise<void> {
	const entries = await listWorkspaceIndexEntries().catch(() => []);
	for (const entry of entries) {
		try {
			const report = await runTaskWorkspaceMaintenance({
				repoPath: entry.repoPath,
				board: await loadWorkspaceBoardById(entry.workspaceId),
				readDeliveryReceipt: readTaskDeliveryReceipt,
			});
			for (const blocked of report.blockedCleanups) {
				warn(`Task "${blocked.taskId}" worktree cleanup is still blocked in ${entry.repoPath}: ${blocked.reason}`);
			}
			for (const flagged of report.flaggedPreservation) {
				warn(
					`Preserved work ${flagged.taskId === "*" ? "" : `for task "${flagged.taskId}" `}in ${entry.repoPath}: ${flagged.reason}`,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warn(`Workspace maintenance failed for ${entry.repoPath}: ${message}`);
		}
	}
}
