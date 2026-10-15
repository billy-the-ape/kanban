import { buildProjectTaskListItems, compareProjectTaskListItems } from "@runtime-task-display-state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeProjectSummary,
	RuntimeProjectTaskListItem,
	RuntimeProjectTasksResponse,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import type { BoardData } from "@/types";

const AUTO_REFRESH_INTERVAL_MS = 1000;
const FIRST_LOAD_ERROR_MESSAGE = "Couldn't load tasks.";
const REFRESH_ERROR_MESSAGE = "Couldn't refresh tasks. Showing the last loaded tasks.";

export interface UseCrossProjectTasksInput {
	/** Whether the sidebar task list is visible; requests only run while enabled. */
	enabled: boolean;
	/** Raw runtime stream projects array (before UI-state overlays). */
	projects: RuntimeProjectSummary[];
	hasReceivedSnapshot: boolean;
	currentProjectId: string | null;
	canPersistWorkspaceState: boolean;
	board: BoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
}

export interface UseCrossProjectTasksResult {
	/** Merged, fully-ordered task rows; null before the first successful load. */
	tasks: RuntimeProjectTaskListItem[] | null;
	/** True only while a request is in flight. */
	isLoading: boolean;
	error: string | null;
	/** Project ids whose state could not be loaded, filtered to known projects. */
	unavailableProjectIds: string[];
	retry: () => void;
}

interface ActiveRequest {
	promise: Promise<RuntimeProjectTasksResponse>;
	generation: number;
}

/**
 * Loads the cross-project task list with bounded, coalesced refreshes:
 * - first enable/re-enable and manual retry fetch immediately;
 * - automatic refreshes start at most once per 1000 ms;
 * - raw stream project changes coalesce into a single trailing refresh;
 * - disable/unmount bump a generation so stale completions never apply data,
 *   and the in-flight slot stays held until the promise settles.
 */
export function useCrossProjectTasks({
	enabled,
	projects,
	hasReceivedSnapshot,
	currentProjectId,
	canPersistWorkspaceState,
	board,
	sessions,
}: UseCrossProjectTasksInput): UseCrossProjectTasksResult {
	const [serverTasks, setServerTasks] = useState<RuntimeProjectTaskListItem[] | null>(null);
	const [serverUnavailable, setServerUnavailable] = useState<string[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Mutable scheduler state lives in a ref: request callbacks fire long after
	// the render that scheduled them, and must never act on stale closures.
	const scheduler = useRef({
		enabled: false,
		unmounted: false,
		generation: 0,
		dirty: false,
		immediatePending: false,
		lastStartAt: 0,
		active: null as ActiveRequest | null,
		trailingTimeout: null as ReturnType<typeof setTimeout> | null,
		// Mirror of the applied server rows, readable inside settle callbacks.
		appliedTasks: null as RuntimeProjectTaskListItem[] | null,
	}).current;

	const clearTrailingTimeout = useCallback(() => {
		if (scheduler.trailingTimeout !== null) {
			clearTimeout(scheduler.trailingTimeout);
			scheduler.trailingTimeout = null;
		}
	}, [scheduler]);

	const startRequest = useCallback(
		(generation: number) => {
			const promise = getRuntimeTrpcClient(null).projects.listTasks.query();
			const active: ActiveRequest = { promise, generation };
			scheduler.active = active;
			scheduler.lastStartAt = Date.now();
			setIsLoading(true);
			void promise.then(
				(response) => {
					if (scheduler.active !== active) {
						// A newer request owns the slot (and the loading state).
						return;
					}
					scheduler.active = null;
					setIsLoading(false);
					if (active.generation === scheduler.generation && !scheduler.unmounted) {
						scheduler.appliedTasks = response.tasks;
						setServerTasks(response.tasks);
						setServerUnavailable(response.unavailableProjectIds);
						setError(null);
					}
					scheduleFollowUpAfterSettle();
				},
				() => {
					if (scheduler.active !== active) {
						return;
					}
					scheduler.active = null;
					setIsLoading(false);
					if (active.generation === scheduler.generation && !scheduler.unmounted) {
						// Keep the last successful rows on a refetch failure.
						setError(scheduler.appliedTasks === null ? FIRST_LOAD_ERROR_MESSAGE : REFRESH_ERROR_MESSAGE);
					}
					scheduleFollowUpAfterSettle();
				},
			);
			// eslint-disable-next-line react-hooks/exhaustive-deps
		},
		[scheduler],
	);

	function scheduleFollowUpAfterSettle() {
		if (scheduler.unmounted || !scheduler.enabled || scheduler.active !== null) {
			return;
		}
		if (!scheduler.dirty && !scheduler.immediatePending) {
			return;
		}
		scheduleTrailing(0);
	}

	function scheduleTrailing(delayMs: number) {
		if (scheduler.trailingTimeout !== null) {
			clearTimeout(scheduler.trailingTimeout);
		}
		scheduler.trailingTimeout = setTimeout(() => {
			scheduler.trailingTimeout = null;
			if (scheduler.unmounted || !scheduler.enabled || scheduler.active !== null) {
				// A newer request started in the meantime; its settle handler
				// is responsible for the follow-up.
				return;
			}
			const immediate = scheduler.immediatePending;
			scheduler.immediatePending = false;
			scheduler.dirty = false;
			if (immediate) {
				// Explicit intent bypasses the automatic interval.
				startRequest(scheduler.generation);
				return;
			}
			const remaining = Math.max(0, AUTO_REFRESH_INTERVAL_MS - (Date.now() - scheduler.lastStartAt));
			if (remaining <= 0) {
				startRequest(scheduler.generation);
			} else {
				scheduleTrailing(remaining);
			}
		}, delayMs);
	}

	const markDirty = useCallback(() => {
		if (scheduler.unmounted || !scheduler.enabled) {
			return;
		}
		scheduler.dirty = true;
		if (scheduler.active !== null) {
			// The settle handler will run the coalesced trailing refresh.
			return;
		}
		const remaining = Math.max(0, AUTO_REFRESH_INTERVAL_MS - (Date.now() - scheduler.lastStartAt));
		scheduleTrailing(remaining);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scheduler]);

	useEffect(() => {
		scheduler.enabled = enabled;
		if (!enabled) {
			// Bump the generation so an in-flight request becomes stale: its data
			// never applies, and the slot is released only when it settles.
			scheduler.generation += 1;
			scheduler.dirty = false;
			scheduler.immediatePending = false;
			clearTrailingTimeout();
			return;
		}
		if (scheduler.active !== null) {
			// A stale request still holds the in-flight slot; queue one
			// current-generation refresh after it settles.
			scheduler.immediatePending = true;
			return;
		}
		// First enable/re-enable is an explicit refresh: it bypasses the
		// automatic interval but never the in-flight guard (checked above).
		startRequest(scheduler.generation);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, clearTrailingTimeout, startRequest, scheduler]);

	// Raw stream project changes mark the data dirty (except the initial
	// appearance, which would duplicate the enable request).
	const projectsSignature = projects.map((project) => project.id).join("|");
	const hasSeenProjectsRef = useRef(false);
	useEffect(() => {
		if (!hasSeenProjectsRef.current) {
			hasSeenProjectsRef.current = true;
			return;
		}
		markDirty();
	}, [projectsSignature, markDirty]);

	useEffect(() => {
		return () => {
			scheduler.unmounted = true;
			scheduler.enabled = false;
			scheduler.generation += 1;
			scheduler.dirty = false;
			scheduler.immediatePending = false;
			clearTrailingTimeout();
		};
	}, [clearTrailingTimeout, scheduler]);

	const retry = useCallback(() => {
		if (scheduler.unmounted || !scheduler.enabled) {
			return;
		}
		if (scheduler.active !== null) {
			// Coalesce into the in-flight request's settle follow-up.
			scheduler.immediatePending = true;
			return;
		}
		scheduler.dirty = false;
		startRequest(scheduler.generation);
	}, [scheduler, startRequest]);

	const merged = useMemo(() => {
		if (serverTasks === null) {
			return { tasks: null as RuntimeProjectTaskListItem[] | null, unavailable: [] as string[] };
		}
		let rows = serverTasks;
		let unavailable = serverUnavailable;
		const knownProjectIds = new Set(projects.map((project) => project.id));
		// Once the known project list arrives, dropped projects must not leave
		// clickable stale rows behind.
		if (hasReceivedSnapshot) {
			rows = rows.filter((row) => knownProjectIds.has(row.projectId));
			unavailable = unavailable.filter((projectId) => knownProjectIds.has(projectId));
		}
		// The open project always renders from the freshest browser state.
		if (canPersistWorkspaceState && currentProjectId && knownProjectIds.has(currentProjectId)) {
			const currentProject = projects.find((project) => project.id === currentProjectId);
			if (currentProject) {
				const localRows = buildProjectTaskListItems(
					{ id: currentProject.id, name: currentProject.name },
					board,
					sessions,
				);
				rows = [...rows.filter((row) => row.projectId !== currentProject.id), ...localRows];
				rows = rows.sort(compareProjectTaskListItems);
				if (unavailable.includes(currentProject.id)) {
					unavailable = unavailable.filter((projectId) => projectId !== currentProject.id);
				}
			}
		}
		return { tasks: rows, unavailable };
	}, [
		board,
		canPersistWorkspaceState,
		currentProjectId,
		hasReceivedSnapshot,
		projects,
		serverTasks,
		serverUnavailable,
		sessions,
	]);

	return {
		tasks: merged.tasks,
		isLoading,
		error,
		unavailableProjectIds: merged.unavailable,
		retry,
	};
}
