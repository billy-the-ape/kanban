import type {
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
	RuntimeWorktreeDeleteResponse,
} from "../core/api-contract";
import { listWorkspaceIndexEntries, loadWorkspaceState, saveWorkspaceState } from "../state/workspace-state";
import { isSettledPiSummaryWithoutProcess } from "../terminal/pi-session-restore";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { deleteTaskWorktree, removeTaskWorktreeSetupLock } from "../workspace/task-worktree";
import type { WorkspaceRegistry } from "./workspace-registry";
import { collectProjectWorktreeTaskIdsForRemoval } from "./workspace-registry";

export interface RuntimeShutdownCoordinatorDependencies {
	workspaceRegistry: Pick<WorkspaceRegistry, "listManagedWorkspaces">;
	warn: (message: string) => void;
	closeRuntimeServer: () => Promise<void>;
	skipSessionCleanup?: boolean;
	/** Test seam for the worktree removal itself; the real cleanup is the default. */
	removeTaskWorktree?: (input: { repoPath: string; taskId: string }) => Promise<RuntimeWorktreeDeleteResponse>;
}

/**
 * The only cards whose detached Pi session the task-detail terminal asks to be
 * reattached after a restart (see the guarded restore in `runtime-api.ts`).
 */
const RESTORABLE_CARD_COLUMNS: Set<string> = new Set(["in_progress", "review"]);

function collectRestorableCardIds(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		if (RESTORABLE_CARD_COLUMNS.has(column.id)) {
			for (const card of column.cards) {
				taskIds.add(card.id);
			}
		}
	}
	return taskIds;
}

interface PersistInterruptedSessionsResult {
	/** Interrupted tasks whose worktree can be removed. */
	worktreeTaskIds: string[];
	/** Tasks persisted as a restore-pending Pi session, so their worktree stays. */
	restorePendingTaskIds: Set<string>;
}

async function persistInterruptedSessions(
	workspacePath: string,
	interruptedTaskIds: string[],
	options: {
		workspaceState: RuntimeWorkspaceStateResponse;
		/** Tasks whose process this runtime was actually running (about to be stopped). */
		liveTaskIds: Set<string>;
		resolveSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
	},
): Promise<PersistInterruptedSessionsResult> {
	const result: PersistInterruptedSessionsResult = { worktreeTaskIds: [], restorePendingTaskIds: new Set() };
	if (interruptedTaskIds.length === 0) {
		return result;
	}
	const workspaceState = options.workspaceState;
	const worktreeTaskIds = collectProjectWorktreeTaskIdsForRemoval(workspaceState.board);
	const worktreeTaskIdsToCleanup = interruptedTaskIds.filter((taskId) => worktreeTaskIds.has(taskId));
	const restorableCardIds = collectRestorableCardIds(workspaceState.board);
	// B-5: interrupted cards stay in their current column. Their work is
	// preserved (and their worktrees kept or durably preserved), not discarded,
	// so no board change is made here.
	const nextSessions = {
		...workspaceState.sessions,
	};
	for (const taskId of interruptedTaskIds) {
		const summary = options.resolveSummary?.(taskId) ?? workspaceState.sessions[taskId] ?? null;
		if (!summary) {
			continue;
		}
		// A Pi session this runtime never ran and that claims no process already
		// ended on its own — an intentional Stop or a crash. Rewriting it to
		// `interrupted` would claim Kanban lost a live process, and reopening the
		// task after the restart would relaunch work the user deliberately stopped.
		if (!options.liveTaskIds.has(taskId) && isSettledPiSummaryWithoutProcess(summary)) {
			continue;
		}
		nextSessions[taskId] = {
			...summary,
			state: "interrupted",
			reviewReason: "interrupted",
			pid: null,
			updatedAt: Date.now(),
		};
		// A restore-pending Pi card is reattached by reopening the task, and the
		// guarded restore refuses to recreate the worktree it reattaches into. Its
		// work stays in place instead of being archived away by this shutdown.
		if (summary.agentId === "pi" && restorableCardIds.has(taskId)) {
			result.restorePendingTaskIds.add(taskId);
		}
	}
	await saveWorkspaceState(workspacePath, {
		board: workspaceState.board,
		sessions: nextSessions,
	});
	result.worktreeTaskIds = worktreeTaskIdsToCleanup.filter((taskId) => !result.restorePendingTaskIds.has(taskId));
	return result;
}

async function cleanupInterruptedTaskWorktrees(
	repoPath: string,
	taskIds: string[],
	warn: (message: string) => void,
	removeTaskWorktree: (input: { repoPath: string; taskId: string }) => Promise<RuntimeWorktreeDeleteResponse>,
): Promise<void> {
	if (taskIds.length === 0) {
		return;
	}
	const deletions = await Promise.all(
		taskIds.map(async (taskId) => ({
			taskId,
			deleted: await removeTaskWorktree({
				repoPath,
				taskId,
			}),
		})),
	);
	for (const { taskId, deleted } of deletions) {
		if (deleted.ok) {
			continue;
		}
		const blockedReason = deleted.blockedReason
			? ` Task work could not be preserved, so the worktree was kept: ${deleted.blockedReason}`
			: "";
		const message = deleted.error ?? `Could not delete task workspace for task "${taskId}" during shutdown.`;
		warn(`${message}${blockedReason}`);
	}
}

async function cleanupTaskWorktreeSetupLocks(
	repoPaths: Iterable<string>,
	warn: (message: string) => void,
): Promise<void> {
	await Promise.all(
		Array.from(new Set(repoPaths)).map(async (repoPath) => {
			try {
				await removeTaskWorktreeSetupLock(repoPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warn(`Could not remove task worktree setup lock for ${repoPath} during shutdown cleanup. ${message}`);
			}
		}),
	);
}

function shouldInterruptSessionOnShutdown(summary: RuntimeTaskSessionSummary): boolean {
	if (summary.state === "running") {
		return true;
	}
	return summary.state === "awaiting_review";
}

function collectShutdownInterruptedTaskIds(
	interruptedSummaries: RuntimeTaskSessionSummary[],
	terminalManager: TerminalSessionManager,
): string[] {
	const taskIds = new Set(interruptedSummaries.map((summary) => summary.taskId));
	for (const summary of terminalManager.listSummaries()) {
		if (!shouldInterruptSessionOnShutdown(summary)) {
			continue;
		}
		taskIds.add(summary.taskId);
	}
	return Array.from(taskIds);
}

function collectWorkColumnTaskIds(workspaceState: RuntimeWorkspaceStateResponse): string[] {
	return Array.from(collectProjectWorktreeTaskIdsForRemoval(workspaceState.board));
}

export async function shutdownRuntimeServer(deps: RuntimeShutdownCoordinatorDependencies): Promise<void> {
	if (deps.skipSessionCleanup) {
		await deps.closeRuntimeServer();
		return;
	}

	const interruptedByWorkspace: Array<{
		workspacePath: string;
		interruptedTaskIds: string[];
		workspaceState: RuntimeWorkspaceStateResponse;
		/** Tasks whose process this runtime was running; the rest were already ended. */
		liveTaskIds: Set<string>;
		resolveSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
	}> = [];
	const managedWorkspacePaths = new Set<string>();

	for (const { workspacePath, terminalManager } of deps.workspaceRegistry.listManagedWorkspaces()) {
		const interrupted = terminalManager.markInterruptedAndStopAll();
		const interruptedTaskIds = new Set(collectShutdownInterruptedTaskIds(interrupted, terminalManager));
		if (!workspacePath) {
			continue;
		}
		managedWorkspacePaths.add(workspacePath);
		try {
			const workspaceState = await loadWorkspaceState(workspacePath);
			for (const taskId of collectWorkColumnTaskIds(workspaceState)) {
				interruptedTaskIds.add(taskId);
			}
			interruptedByWorkspace.push({
				workspacePath,
				interruptedTaskIds: Array.from(interruptedTaskIds),
				workspaceState,
				liveTaskIds: new Set(interrupted.map((summary) => summary.taskId)),
				resolveSummary: (taskId) => terminalManager.getSummary(taskId),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.warn(`Could not load workspace state for ${workspacePath} during shutdown cleanup. ${message}`);
		}
	}

	const indexedWorkspaces = await listWorkspaceIndexEntries();
	for (const workspace of indexedWorkspaces) {
		if (managedWorkspacePaths.has(workspace.repoPath)) {
			continue;
		}
		try {
			const workspaceState = await loadWorkspaceState(workspace.repoPath);
			const interruptedTaskIds = collectWorkColumnTaskIds(workspaceState);
			if (interruptedTaskIds.length === 0) {
				continue;
			}
			interruptedByWorkspace.push({
				workspacePath: workspace.repoPath,
				interruptedTaskIds,
				workspaceState,
				// Nothing runs in this runtime for an unmanaged workspace, so a
				// persisted Pi record can only have ended on its own.
				liveTaskIds: new Set<string>(),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.warn(`Could not load workspace state for ${workspace.repoPath} during shutdown cleanup. ${message}`);
		}
	}

	await Promise.all(
		interruptedByWorkspace.map(async (workspace) => {
			const persisted = await persistInterruptedSessions(workspace.workspacePath, workspace.interruptedTaskIds, {
				workspaceState: workspace.workspaceState,
				liveTaskIds: workspace.liveTaskIds,
				resolveSummary: workspace.resolveSummary,
			});
			await cleanupInterruptedTaskWorktrees(
				workspace.workspacePath,
				persisted.worktreeTaskIds,
				deps.warn,
				deps.removeTaskWorktree ?? deleteTaskWorktree,
			);
		}),
	);

	await deps.closeRuntimeServer();

	await cleanupTaskWorktreeSetupLocks(
		[...managedWorkspacePaths, ...indexedWorkspaces.map((workspace) => workspace.repoPath)],
		deps.warn,
	);
}
