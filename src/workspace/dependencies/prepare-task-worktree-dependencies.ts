import { getTaskWorktreesHomePath } from "../../state/workspace-state";
import { clearInitialStartLiveStage, setInitialStartLiveStage } from "../task-initial-start";
import { ensureWorktreeDependencies } from "./ensure-worktree-dependencies";
import type { DependencyTransferStrategy, WorktreeDependenciesReport } from "./types";

/**
 * WORKTREE-PACKAGES: the task-start entry point. Dependencies are prepared
 * immediately before the agent is launched, so "the worktree is ready" means
 * the agent can run the project's scripts without burning turns on an install.
 *
 * Two guards matter here. First, this only ever runs in a task worktree: the
 * workspace checkout is the user's own working copy and Kanban never installs
 * into it. Second, a dependency problem is never a launch failure — every
 * failure mode (no snapshot, no package manager, install error) is reported and
 * the session starts anyway, which is exactly the pre-feature behavior.
 */

export interface PrepareTaskWorktreeDependenciesOptions {
	/** Workspace checkout (the user's own working copy). */
	workspacePath: string;
	taskId: string;
	/** Resolved task cwd handed to the agent. */
	taskCwd: string;
	transferStrategy?: DependencyTransferStrategy;
	installTimeoutMs?: number;
	allowInstall?: boolean;
}

function isTaskWorktreePath(workspacePath: string, taskCwd: string): boolean {
	if (taskCwd.length === 0 || taskCwd === workspacePath) {
		return false;
	}
	const root = getTaskWorktreesHomePath();
	// Compare with a separator so a sibling like `~/.cline/worktrees-evil` is
	// never mistaken for the task worktree root.
	return taskCwd === root || taskCwd.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export async function prepareTaskWorktreeDependencies(
	options: PrepareTaskWorktreeDependenciesOptions,
): Promise<WorktreeDependenciesReport | null> {
	if (!isTaskWorktreePath(options.workspacePath, options.taskCwd)) {
		return null;
	}
	// The live stage is polled by the card while the start is in flight, so a
	// cold install is visible instead of looking like a stuck launch.
	setInitialStartLiveStage(options.taskId, "preparing_dependencies");
	try {
		return await ensureWorktreeDependencies({
			repoPath: options.workspacePath,
			worktreePath: options.taskCwd,
			taskId: options.taskId,
			transferStrategy: options.transferStrategy,
			installTimeoutMs: options.installTimeoutMs,
			allowInstall: options.allowInstall,
		});
	} catch (error) {
		// Defensive: `ensureWorktreeDependencies` already contains its own
		// failures. A launch must never be lost to the dependency layer.
		return {
			ok: false,
			worktreePath: options.taskCwd,
			units: [],
			durationMs: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearInitialStartLiveStage(options.taskId);
	}
}
