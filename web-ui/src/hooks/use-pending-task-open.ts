import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import type { RuntimeProjectSummary } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import type { BoardData } from "@/types";

export const PENDING_TASK_OPEN_PROJECT_UNAVAILABLE_MESSAGE = "That project is no longer available.";
export const PENDING_TASK_OPEN_TASK_UNAVAILABLE_MESSAGE = "That task no longer exists.";

interface PendingTaskOpen {
	projectId: string;
	taskId: string;
}

export interface UsePendingTaskOpenInput {
	currentProjectId: string | null;
	/** The project switch in flight (or the settled target). */
	requestedProjectId: string | null;
	projects: RuntimeProjectSummary[];
	hasReceivedSnapshot: boolean;
	board: BoardData;
	canPersistWorkspaceState: boolean;
	isInitialRuntimeLoad: boolean;
	isProjectSwitching: boolean;
	isAwaitingWorkspaceSnapshot: boolean;
	isWorkspaceMetadataPending: boolean;
	streamError: string | null;
	handleSelectProject: (projectId: string) => void;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
}

/**
 * Pending cross-project task selection. A task clicked in another project is
 * opened once the project switch completes; a task clicked in the current
 * project while it is still hydrating is opened once it becomes hydrated.
 *
 * The pending selection is cancelled (never auto-opened) when:
 * - the user requests a different project before the switch settles;
 * - the pending project disappears from the known project list;
 * - a new stream error appears after the pending switch was requested
 *   (pre-existing errors from the source project do not count);
 * - the task is missing from the target board at settle time.
 */
export function usePendingTaskOpen({
	currentProjectId,
	requestedProjectId,
	projects,
	hasReceivedSnapshot,
	board,
	canPersistWorkspaceState,
	isInitialRuntimeLoad,
	isProjectSwitching,
	isAwaitingWorkspaceSnapshot,
	isWorkspaceMetadataPending,
	streamError,
	handleSelectProject,
	setSelectedTaskId,
}: UsePendingTaskOpenInput): { openTask: (projectId: string, taskId: string) => void } {
	const [pendingOpen, setPendingOpen] = useState<PendingTaskOpen | null>(null);
	// Stream error at the moment the pending selection was created: only a
	// *new* error afterwards signals a failed switch.
	const streamErrorBaselineRef = useRef<string | null>(streamError);
	const previousRequestedProjectIdRef = useRef<string | null | undefined>(undefined);

	const openTask = useCallback(
		(projectId: string, taskId: string) => {
			if (hasReceivedSnapshot && !projects.some((project) => project.id === projectId)) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: PENDING_TASK_OPEN_PROJECT_UNAVAILABLE_MESSAGE,
					timeout: 5000,
				});
				return;
			}
			const effectiveProjectId = requestedProjectId ?? currentProjectId;
			if (projectId === effectiveProjectId) {
				const isCurrentProjectHydrated =
					canPersistWorkspaceState &&
					!isInitialRuntimeLoad &&
					!isProjectSwitching &&
					!isAwaitingWorkspaceSnapshot &&
					!isWorkspaceMetadataPending;
				if (isCurrentProjectHydrated) {
					if (findCardSelection(board, taskId)) {
						setSelectedTaskId(taskId);
					} else {
						showAppToast({
							intent: "warning",
							icon: "warning-sign",
							message: PENDING_TASK_OPEN_TASK_UNAVAILABLE_MESSAGE,
							timeout: 5000,
						});
					}
					return;
				}
				// Same-project click while the project is still hydrating: wait
				// for the readiness effect below; no project switch is needed.
				streamErrorBaselineRef.current = streamError;
				setPendingOpen({ projectId, taskId });
				return;
			}
			streamErrorBaselineRef.current = streamError;
			setPendingOpen({ projectId, taskId });
			handleSelectProject(projectId);
		},
		[
			board,
			canPersistWorkspaceState,
			currentProjectId,
			handleSelectProject,
			hasReceivedSnapshot,
			isAwaitingWorkspaceSnapshot,
			isInitialRuntimeLoad,
			isProjectSwitching,
			isWorkspaceMetadataPending,
			projects,
			requestedProjectId,
			setSelectedTaskId,
			streamError,
		],
	);

	// Resolve: the pending project is loaded, hydrated, and the task exists.
	useEffect(() => {
		if (!pendingOpen) {
			return;
		}
		if (currentProjectId !== pendingOpen.projectId) {
			return;
		}
		if (
			!canPersistWorkspaceState ||
			isInitialRuntimeLoad ||
			isProjectSwitching ||
			isAwaitingWorkspaceSnapshot ||
			isWorkspaceMetadataPending
		) {
			return;
		}
		if (findCardSelection(board, pendingOpen.taskId)) {
			setSelectedTaskId(pendingOpen.taskId);
		} else {
			showAppToast({
				intent: "warning",
				icon: "warning-sign",
				message: PENDING_TASK_OPEN_TASK_UNAVAILABLE_MESSAGE,
				timeout: 5000,
			});
		}
		setPendingOpen(null);
	}, [
		board,
		canPersistWorkspaceState,
		currentProjectId,
		isAwaitingWorkspaceSnapshot,
		isInitialRuntimeLoad,
		isProjectSwitching,
		isWorkspaceMetadataPending,
		pendingOpen,
		setSelectedTaskId,
	]);

	// Cancel when the user requests a different project before the switch
	// settles (a pending selection for the newly requested project survives).
	useEffect(() => {
		const previous = previousRequestedProjectIdRef.current;
		previousRequestedProjectIdRef.current = requestedProjectId;
		if (previous === undefined || previous === requestedProjectId) {
			return;
		}
		setPendingOpen((current) => {
			if (current && current.projectId !== requestedProjectId) {
				return null;
			}
			return current;
		});
	}, [requestedProjectId]);

	// Cancel when the pending project disappears from the known list.
	useEffect(() => {
		if (!pendingOpen || !hasReceivedSnapshot) {
			return;
		}
		if (projects.some((project) => project.id === pendingOpen.projectId)) {
			return;
		}
		setPendingOpen(null);
		showAppToast({
			intent: "warning",
			icon: "warning-sign",
			message: PENDING_TASK_OPEN_PROJECT_UNAVAILABLE_MESSAGE,
			timeout: 5000,
		});
	}, [hasReceivedSnapshot, pendingOpen, projects]);

	// Cancel when a *new* stream error appears after the pending selection was
	// created; the existing navigation error UI explains the failure. Pre-
	// existing errors from the source project and unrelated reconnect failures
	// never open the pending task.
	useEffect(() => {
		if (!pendingOpen) {
			return;
		}
		if (streamError && streamError !== streamErrorBaselineRef.current) {
			setPendingOpen(null);
		}
	}, [pendingOpen, streamError]);

	return { openTask };
}
