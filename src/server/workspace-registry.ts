import { type RuntimeConfigState, toGlobalRuntimeConfigState } from "../config/runtime-config";
import type {
	RuntimeBoardData,
	RuntimeProjectSummary,
	RuntimeProjectTaskCounts,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { countTasksByDisplayState, createEmptyTaskCounts } from "../core/task-display-state";
import { resolveWorkspaceSessionSummaries } from "../core/workspace-session-summaries";
import {
	listWorkspaceIndexEntries,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	loadWorkspaceSessionsById,
	loadWorkspaceState,
	type RuntimeWorkspaceIndexEntry,
} from "../state/workspace-state";
import { TerminalSessionManager } from "../terminal/session-manager";

export interface WorkspaceRegistryScope {
	workspaceId: string;
	workspacePath: string;
}

export interface CreateWorkspaceRegistryDependencies {
	cwd: string;
	loadGlobalRuntimeConfig: () => Promise<RuntimeConfigState>;
	loadRuntimeConfig: (cwd: string) => Promise<RuntimeConfigState>;
	hasGitRepository: (path: string) => boolean;
	pathIsDirectory: (path: string) => Promise<boolean>;
	/** Read live Cline task session summaries for tracked services only. */
	getClineTaskSessionSummaries?: (workspaceId: string) => RuntimeTaskSessionSummary[];
	onTerminalManagerReady?: (workspaceId: string, manager: TerminalSessionManager) => void;
}

export interface DisposeWorkspaceRegistryOptions {
	stopTerminalSessions?: boolean;
}

export interface ResolvedWorkspaceStreamTarget {
	workspaceId: string | null;
	workspacePath: string | null;
	unavailableRequestedWorkspaceMessage: string | null;
}

export interface WorkspaceRegistry {
	getActiveWorkspaceId: () => string | null;
	getActiveWorkspacePath: () => string | null;
	getWorkspacePathById: (workspaceId: string) => string | null;
	rememberWorkspace: (workspaceId: string, repoPath: string) => void;
	getActiveRuntimeConfig: () => RuntimeConfigState;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	loadScopedRuntimeConfig: (scope: WorkspaceRegistryScope) => Promise<RuntimeConfigState>;
	getTerminalManagerForWorkspace: (workspaceId: string) => TerminalSessionManager | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	setActiveWorkspace: (workspaceId: string, repoPath: string) => Promise<void>;
	clearActiveWorkspace: () => void;
	disposeWorkspace: (
		workspaceId: string,
		options?: DisposeWorkspaceRegistryOptions,
	) => {
		terminalManager: TerminalSessionManager | null;
		workspacePath: string | null;
	};
	summarizeProjectTaskCounts: (workspaceId: string, repoPath: string) => Promise<RuntimeProjectTaskCounts>;
	createProjectSummary: (input: {
		workspaceId: string;
		repoPath: string;
		taskCounts: RuntimeProjectTaskCounts;
	}) => RuntimeProjectSummary;
	buildWorkspaceStateSnapshot: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	buildProjectsPayload: (preferredCurrentProjectId: string | null) => Promise<{
		currentProjectId: string | null;
		projects: RuntimeProjectSummary[];
	}>;
	resolveWorkspaceForStream: (requestedWorkspaceId: string | null) => Promise<ResolvedWorkspaceStreamTarget>;
	listManagedWorkspaces: () => Array<{
		workspaceId: string;
		workspacePath: string | null;
		terminalManager: TerminalSessionManager;
	}>;
}

export function collectProjectWorktreeTaskIdsForRemoval(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function toProjectSummary(project: {
	workspaceId: string;
	repoPath: string;
	taskCounts: RuntimeProjectTaskCounts;
}): RuntimeProjectSummary {
	const normalized = project.repoPath.replaceAll("\\", "/").replace(/\/+$/g, "");
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	const name = segments[segments.length - 1] ?? normalized;
	return {
		id: project.workspaceId,
		path: project.repoPath,
		name,
		taskCounts: project.taskCounts,
	};
}

export async function createWorkspaceRegistry(deps: CreateWorkspaceRegistryDependencies): Promise<WorkspaceRegistry> {
	const launchedFromGitRepo = deps.hasGitRepository(deps.cwd);
	const initialWorkspace = launchedFromGitRepo ? await loadWorkspaceContext(deps.cwd) : null;
	let indexedWorkspace: RuntimeWorkspaceIndexEntry | null = null;
	if (!initialWorkspace) {
		const indexedWorkspaces = await listWorkspaceIndexEntries();
		indexedWorkspace = indexedWorkspaces[0] ?? null;
	}

	let activeWorkspaceId: string | null = initialWorkspace?.workspaceId ?? indexedWorkspace?.workspaceId ?? null;
	let activeWorkspacePath: string | null = initialWorkspace?.repoPath ?? indexedWorkspace?.repoPath ?? null;
	let globalRuntimeConfig = await deps.loadGlobalRuntimeConfig();
	let activeRuntimeConfig = activeWorkspacePath
		? await deps.loadRuntimeConfig(activeWorkspacePath)
		: globalRuntimeConfig;
	const workspacePathsById = new Map<string, string>(
		activeWorkspaceId && activeWorkspacePath ? [[activeWorkspaceId, activeWorkspacePath]] : [],
	);
	const projectTaskCountsByWorkspaceId = new Map<string, RuntimeProjectTaskCounts>();
	const terminalManagersByWorkspaceId = new Map<string, TerminalSessionManager>();
	const terminalManagerLoadPromises = new Map<string, Promise<TerminalSessionManager>>();

	const rememberWorkspace = (workspaceId: string, repoPath: string): void => {
		workspacePathsById.set(workspaceId, repoPath);
	};

	const notifyTerminalManagerReady = (workspaceId: string, manager: TerminalSessionManager): void => {
		deps.onTerminalManagerReady?.(workspaceId, manager);
	};

	const getTerminalManagerForWorkspace = (workspaceId: string): TerminalSessionManager | null => {
		return terminalManagersByWorkspaceId.get(workspaceId) ?? null;
	};

	const ensureTerminalManagerForWorkspace = async (
		workspaceId: string,
		repoPath: string,
	): Promise<TerminalSessionManager> => {
		rememberWorkspace(workspaceId, repoPath);
		const existing = terminalManagersByWorkspaceId.get(workspaceId);
		if (existing) {
			notifyTerminalManagerReady(workspaceId, existing);
			return existing;
		}
		const pending = terminalManagerLoadPromises.get(workspaceId);
		if (pending) {
			const loaded = await pending;
			notifyTerminalManagerReady(workspaceId, loaded);
			return loaded;
		}
		const loading = (async () => {
			const manager = new TerminalSessionManager();
			try {
				const existingWorkspace = await loadWorkspaceState(repoPath);
				manager.hydrateFromRecord(existingWorkspace.sessions);
			} catch {
				// Workspace state will be created on demand.
			}
			terminalManagersByWorkspaceId.set(workspaceId, manager);
			return manager;
		})().finally(() => {
			terminalManagerLoadPromises.delete(workspaceId);
		});
		terminalManagerLoadPromises.set(workspaceId, loading);
		const loaded = await loading;
		notifyTerminalManagerReady(workspaceId, loaded);
		return loaded;
	};

	const setActiveWorkspace = async (workspaceId: string, repoPath: string): Promise<void> => {
		activeWorkspaceId = workspaceId;
		activeWorkspacePath = repoPath;
		rememberWorkspace(workspaceId, repoPath);
		await ensureTerminalManagerForWorkspace(workspaceId, repoPath);
		activeRuntimeConfig = await deps.loadRuntimeConfig(repoPath);
		globalRuntimeConfig = toGlobalRuntimeConfigState(activeRuntimeConfig);
	};

	const clearActiveWorkspace = (): void => {
		activeWorkspaceId = null;
		activeWorkspacePath = null;
		activeRuntimeConfig = globalRuntimeConfig;
	};

	const disposeWorkspace = (
		workspaceId: string,
		options?: DisposeWorkspaceRegistryOptions,
	): { terminalManager: TerminalSessionManager | null; workspacePath: string | null } => {
		const terminalManager = getTerminalManagerForWorkspace(workspaceId);
		if (terminalManager) {
			if (options?.stopTerminalSessions !== false) {
				terminalManager.markInterruptedAndStopAll();
			}
			terminalManagersByWorkspaceId.delete(workspaceId);
			terminalManagerLoadPromises.delete(workspaceId);
		}
		projectTaskCountsByWorkspaceId.delete(workspaceId);
		const workspacePath = workspacePathsById.get(workspaceId) ?? null;
		workspacePathsById.delete(workspaceId);
		return {
			terminalManager,
			workspacePath,
		};
	};

	// Read-only merge of persisted sessions, the tracked terminal manager's
	// live summaries, and registered live Cline summaries. Reuses the landed
	// live-owner resolution so untracked projects stay untracked (never
	// instantiates a manager or Cline service).
	const loadEffectiveTaskSessions = (
		workspaceId: string,
		persistedSessions: Record<string, RuntimeTaskSessionSummary>,
	): Record<string, RuntimeTaskSessionSummary> => {
		const terminalManager = getTerminalManagerForWorkspace(workspaceId);
		return resolveWorkspaceSessionSummaries(
			persistedSessions,
			terminalManager ?? { listSummaries: () => [], hasActiveProcess: () => false },
			deps.getClineTaskSessionSummaries?.(workspaceId) ?? [],
		);
	};

	const loadProjectTaskSnapshot = async (
		workspaceId: string,
	): Promise<{ board: RuntimeBoardData; sessions: Record<string, RuntimeTaskSessionSummary> }> => {
		const [board, persistedSessions] = await Promise.all([
			loadWorkspaceBoardById(workspaceId),
			loadWorkspaceSessionsById(workspaceId),
		]);
		return { board, sessions: loadEffectiveTaskSessions(workspaceId, persistedSessions) };
	};

	const summarizeProjectTaskCounts = async (
		workspaceId: string,
		_repoPath: string,
	): Promise<RuntimeProjectTaskCounts> => {
		try {
			const snapshot = await loadProjectTaskSnapshot(workspaceId);
			const nextCounts = countTasksByDisplayState(snapshot.board, snapshot.sessions);
			projectTaskCountsByWorkspaceId.set(workspaceId, nextCounts);
			return nextCounts;
		} catch {
			return projectTaskCountsByWorkspaceId.get(workspaceId) ?? createEmptyTaskCounts();
		}
	};

	const buildWorkspaceStateSnapshot = async (
		workspaceId: string,
		workspacePath: string,
	): Promise<RuntimeWorkspaceStateResponse> => {
		const response = await loadWorkspaceState(workspacePath);
		// Keep the existing manager initialization; only summaries are merged.
		await ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
		response.sessions = await loadEffectiveTaskSessions(workspaceId, response.sessions);
		return response;
	};

	const buildProjectsPayload = async (preferredCurrentProjectId: string | null) => {
		const projects = await listWorkspaceIndexEntries();
		const fallbackProjectId =
			projects.find((project) => project.workspaceId === activeWorkspaceId)?.workspaceId ??
			projects[0]?.workspaceId ??
			null;
		const resolvedCurrentProjectId =
			(preferredCurrentProjectId &&
				projects.some((project) => project.workspaceId === preferredCurrentProjectId) &&
				preferredCurrentProjectId) ||
			fallbackProjectId;
		const projectSummaries = await Promise.all(
			projects.map(async (project) => {
				const taskCounts = await summarizeProjectTaskCounts(project.workspaceId, project.repoPath);
				return toProjectSummary({
					workspaceId: project.workspaceId,
					repoPath: project.repoPath,
					taskCounts,
				});
			}),
		);
		return {
			currentProjectId: resolvedCurrentProjectId,
			projects: projectSummaries,
		};
	};

	const resolveWorkspaceForStream = async (
		requestedWorkspaceId: string | null,
	): Promise<ResolvedWorkspaceStreamTarget> => {
		const allProjects = await listWorkspaceIndexEntries();
		const existingProjects: RuntimeWorkspaceIndexEntry[] = [];
		let unavailableRequestedWorkspaceMessage: string | null = null;

		for (const project of allProjects) {
			let unavailableMessage: string | null = null;
			if (!(await deps.pathIsDirectory(project.repoPath))) {
				unavailableMessage = `Project directory is unavailable: ${project.repoPath}`;
			} else if (!deps.hasGitRepository(project.repoPath)) {
				unavailableMessage = `Project Git validation failed: ${project.repoPath}`;
			}

			if (!unavailableMessage) {
				existingProjects.push(project);
				continue;
			}

			// Validation can fail transiently (permissions, mounts, or Git config).
			// Only explicit project removal may delete saved state or dispose sessions.
			if (project.workspaceId === requestedWorkspaceId) {
				unavailableRequestedWorkspaceMessage = `${unavailableMessage}. Project and task data retained. Repair the repository and retry.`;
			}
		}

		const activeWorkspaceMissing = !existingProjects.some((project) => project.workspaceId === activeWorkspaceId);
		if (activeWorkspaceMissing) {
			if (existingProjects[0]) {
				await setActiveWorkspace(existingProjects[0].workspaceId, existingProjects[0].repoPath);
			} else {
				clearActiveWorkspace();
			}
		}

		if (unavailableRequestedWorkspaceMessage) {
			return {
				workspaceId: null,
				workspacePath: null,
				unavailableRequestedWorkspaceMessage,
			};
		}

		if (requestedWorkspaceId) {
			const requestedWorkspace = existingProjects.find((project) => project.workspaceId === requestedWorkspaceId);
			if (requestedWorkspace) {
				if (
					activeWorkspaceId !== requestedWorkspace.workspaceId ||
					activeWorkspacePath !== requestedWorkspace.repoPath
				) {
					await setActiveWorkspace(requestedWorkspace.workspaceId, requestedWorkspace.repoPath);
				}
				return {
					workspaceId: requestedWorkspace.workspaceId,
					workspacePath: requestedWorkspace.repoPath,
					unavailableRequestedWorkspaceMessage,
				};
			}
		}

		const fallbackWorkspace =
			existingProjects.find((project) => project.workspaceId === activeWorkspaceId) ?? existingProjects[0] ?? null;
		if (!fallbackWorkspace) {
			return {
				workspaceId: null,
				workspacePath: null,
				unavailableRequestedWorkspaceMessage,
			};
		}
		return {
			workspaceId: fallbackWorkspace.workspaceId,
			workspacePath: fallbackWorkspace.repoPath,
			unavailableRequestedWorkspaceMessage,
		};
	};

	if (initialWorkspace) {
		await ensureTerminalManagerForWorkspace(initialWorkspace.workspaceId, initialWorkspace.repoPath);
	}

	return {
		getActiveWorkspaceId: () => activeWorkspaceId,
		getActiveWorkspacePath: () => activeWorkspacePath,
		getWorkspacePathById: (workspaceId: string) => workspacePathsById.get(workspaceId) ?? null,
		rememberWorkspace,
		getActiveRuntimeConfig: () => activeRuntimeConfig,
		setActiveRuntimeConfig: (config: RuntimeConfigState) => {
			globalRuntimeConfig = toGlobalRuntimeConfigState(config);
			activeRuntimeConfig = activeWorkspaceId ? config : globalRuntimeConfig;
		},
		loadScopedRuntimeConfig: async (scope: WorkspaceRegistryScope) => {
			if (scope.workspaceId === activeWorkspaceId) {
				return activeRuntimeConfig;
			}
			return await deps.loadRuntimeConfig(scope.workspacePath);
		},
		getTerminalManagerForWorkspace,
		ensureTerminalManagerForWorkspace,
		setActiveWorkspace,
		clearActiveWorkspace,
		disposeWorkspace,
		summarizeProjectTaskCounts,
		createProjectSummary: toProjectSummary,
		buildWorkspaceStateSnapshot,
		buildProjectsPayload,
		resolveWorkspaceForStream,
		listManagedWorkspaces: () => {
			return Array.from(terminalManagersByWorkspaceId.entries()).map(([workspaceId, terminalManager]) => ({
				workspaceId,
				workspacePath: workspacePathsById.get(workspaceId) ?? null,
				terminalManager,
			}));
		},
	};
}
