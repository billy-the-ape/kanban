import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";

import { showAppToast } from "@/components/app-toaster";
import { getDetailTerminalTaskId } from "@/hooks/use-terminal-panels";
import type { RuntimeTaskDependentsUnlock, RuntimeWorktreeDeleteResponse } from "@/runtime/types";
import {
	addTaskDependency,
	completeTaskAndGetReadyLinkedTaskIds,
	findCardSelection,
	getReadyLinkedTaskIdsForTaskInDone,
	moveTaskToColumn,
	removeTaskDependency,
	trashTaskAndGetReadyLinkedTaskIds,
} from "@/state/board-state";
import { trackTaskDependencyCreated, trackTasksAutoStartedFromDependency } from "@/telemetry/events";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { getNextDetailTaskIdAfterTrashMove } from "@/utils/detail-view-task-order";

interface RequestMoveTaskToTrashOptions {
	optimisticMoveApplied?: boolean;
	skipWorkingChangeWarning?: boolean;
}

export function useLinkedBacklogTaskActions({
	board,
	setBoard,
	setSelectedTaskId,
	stopTaskSession,
	cleanupTaskWorkspace,
	maybeRequestNotificationPermissionForTaskStart,
	kickoffTaskInProgress,
	startBacklogTaskWithAnimation,
	waitForBacklogStartAnimationAvailability,
	checkDependentsUnlock,
	isBackendTaskDispatchEnabled = false,
	onTaskCompleted,
}: {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	stopTaskSession: (taskId: string) => Promise<void>;
	cleanupTaskWorkspace: (taskId: string) => Promise<RuntimeWorktreeDeleteResponse | null>;
	maybeRequestNotificationPermissionForTaskStart: () => void;
	kickoffTaskInProgress: (
		task: BoardCard,
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: { optimisticMove?: boolean },
	) => Promise<boolean>;
	startBacklogTaskWithAnimation?: (task: BoardCard) => Promise<boolean>;
	waitForBacklogStartAnimationAvailability?: () => Promise<void>;
	/** B-5.9: whether a completed task's dependents may start (delivery evidence); absent means always. */
	checkDependentsUnlock?: (taskId: string) => Promise<RuntimeTaskDependentsUnlock>;
	/** B-9.5: backend task dispatch is enabled — unblocked tasks are queued for the backend queue, not auto-started locally. */
	isBackendTaskDispatchEnabled?: boolean;
	/** Called after a task has been completed and its session stopped. */
	onTaskCompleted?: (taskId: string) => void;
}): {
	handleCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	handleDeleteDependency: (dependencyId: string) => void;
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: RequestMoveTaskToTrashOptions,
	) => Promise<void>;
	requestCompleteTask: (
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: RequestMoveTaskToTrashOptions,
	) => Promise<void>;
} {
	const boardRef = useRef(board);

	useEffect(() => {
		boardRef.current = board;
	}, [board]);

	const handleCreateDependency = useCallback(
		(fromTaskId: string, toTaskId: string) => {
			const result = addTaskDependency(boardRef.current, fromTaskId, toTaskId);
			if (!result.added) {
				const message =
					result.reason === "same_task"
						? "A task cannot be linked to itself."
						: result.reason === "duplicate"
							? "Link already exists."
							: result.reason === "trash_task"
								? "Links cannot include done tasks."
								: result.reason === "non_backlog"
									? "Links must include at least one Backlog task."
									: "Could not create link.";
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message,
					timeout: 3000,
				});
				return;
			}

			setBoard((currentBoard) => {
				const latestResult = addTaskDependency(currentBoard, fromTaskId, toTaskId);
				return latestResult.added ? latestResult.board : currentBoard;
			});
			trackTaskDependencyCreated();
		},
		[setBoard],
	);

	const handleDeleteDependency = useCallback(
		(dependencyId: string) => {
			setBoard((currentBoard) => {
				const removed = removeTaskDependency(currentBoard, dependencyId);
				return removed.removed ? removed.board : currentBoard;
			});
		},
		[setBoard],
	);

	const startReadyLinkedTasks = useCallback(
		async (readyTasks: BoardCard[]): Promise<void> => {
			if (readyTasks.length === 0) {
				return;
			}
			maybeRequestNotificationPermissionForTaskStart();
			let startedTaskCount = 0;
			if (startBacklogTaskWithAnimation) {
				const startedTaskPromises: Promise<boolean>[] = [];
				for (const [index, readyTask] of readyTasks.entries()) {
					startedTaskPromises.push(startBacklogTaskWithAnimation(readyTask));
					if (index < readyTasks.length - 1) {
						await waitForBacklogStartAnimationAvailability?.();
					}
				}
				const startedTasks = await Promise.all(startedTaskPromises);
				startedTaskCount = startedTasks.filter(Boolean).length;
			} else {
				setBoard((currentBoardState) => {
					let nextBoardState = currentBoardState;
					for (const readyTask of readyTasks) {
						const moved = moveTaskToColumn(nextBoardState, readyTask.id, "in_progress", {
							insertAtTop: true,
						});
						if (moved.moved) {
							nextBoardState = moved.board;
						}
					}
					return nextBoardState;
				});
				for (const readyTask of readyTasks) {
					const started = await kickoffTaskInProgress(readyTask, readyTask.id, "backlog", {
						optimisticMove: true,
					});
					if (started) {
						startedTaskCount += 1;
					}
				}
			}
			if (startedTaskCount > 0) {
				trackTasksAutoStartedFromDependency(startedTaskCount);
			}
		},
		[
			kickoffTaskInProgress,
			maybeRequestNotificationPermissionForTaskStart,
			setBoard,
			startBacklogTaskWithAnimation,
			waitForBacklogStartAnimationAvailability,
		],
	);

	const cleanupTaskWorktree = useCallback(
		async (taskId: string): Promise<void> => {
			const cleanupResult = await cleanupTaskWorkspace(taskId);
			// B-5.9: any cleanup that did not complete stays visible; it is retried
			// by runtime maintenance and flagged on the Trash card.
			const blockedReason =
				cleanupResult?.blockedReason ?? (cleanupResult?.ok === false ? cleanupResult.error : null);
			if (cleanupResult && !cleanupResult.removed && blockedReason) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: `Task worktree kept: ${blockedReason}`,
					timeout: 7000,
				});
			}
		},
		[cleanupTaskWorkspace],
	);

	const performMoveTaskToTrash = useCallback(
		async (task: BoardCard, currentBoard?: BoardData): Promise<void> => {
			const boardBeforeTrash = currentBoard ?? boardRef.current;
			const trashed = trashTaskAndGetReadyLinkedTaskIds(boardBeforeTrash, task.id);
			if (!trashed.moved) {
				await stopTaskSession(task.id);
				await cleanupTaskWorktree(task.id);
				return;
			}

			setBoard((currentBoardState) => {
				const latestTrashResult = trashTaskAndGetReadyLinkedTaskIds(currentBoardState, task.id);
				return latestTrashResult.moved ? latestTrashResult.board : currentBoardState;
			});
			setSelectedTaskId((currentSelectedTaskId) =>
				currentSelectedTaskId === task.id
					? getNextDetailTaskIdAfterTrashMove(boardBeforeTrash, task.id)
					: currentSelectedTaskId,
			);

			// Discarding a task never unblocks its linked backlog tasks.
			await Promise.all([stopTaskSession(task.id), stopTaskSession(getDetailTerminalTaskId(task.id))]);
			await cleanupTaskWorktree(task.id);
		},
		[cleanupTaskWorktree, setBoard, setSelectedTaskId, stopTaskSession],
	);

	const performCompleteTask = useCallback(
		async (task: BoardCard, currentBoard?: BoardData): Promise<void> => {
			const boardBeforeComplete = currentBoard ?? boardRef.current;
			const completed = completeTaskAndGetReadyLinkedTaskIds(boardBeforeComplete, task.id);
			if (completed.moved) {
				setBoard((currentBoardState) => {
					const latestCompleteResult = completeTaskAndGetReadyLinkedTaskIds(currentBoardState, task.id);
					return latestCompleteResult.moved ? latestCompleteResult.board : currentBoardState;
				});
			}
			setSelectedTaskId((currentSelectedTaskId) =>
				currentSelectedTaskId === task.id
					? getNextDetailTaskIdAfterTrashMove(boardBeforeComplete, task.id)
					: currentSelectedTaskId,
			);

			// Completing a task unblocks its linked backlog tasks. When the move
			// was already applied optimistically, recompute the ready list from
			// the board state where the task sits in the done column.
			const readyTaskIds = completed.moved
				? completed.readyTaskIds
				: getReadyLinkedTaskIdsForTaskInDone(boardBeforeComplete, task.id);
			const readyTasks = readyTaskIds
				.map(
					(readyTaskId) =>
						findCardSelection(completed.moved ? completed.board : boardBeforeComplete, readyTaskId)?.card ?? null,
				)
				.filter((readyTask): readyTask is BoardCard => readyTask !== null);
			// B-5.9/B-8.8: dependents start only once delivery evidence exists.
			const unlock =
				readyTasks.length > 0 && checkDependentsUnlock
					? await checkDependentsUnlock(task.id)
					: { allowed: true, reason: null };
			if (unlock.allowed) {
				if (isBackendTaskDispatchEnabled) {
					// B-9.5: with backend dispatch enabled the browser must not
					// auto-start newly unblocked tasks — the queue pass fired by
					// the board save launches them deterministically with fresh context.
					showAppToast({
						intent: "success",
						icon: "rocket",
						message: "Linked task queued for automatic dispatch.",
						timeout: 4000,
					});
				} else {
					await startReadyLinkedTasks(readyTasks);
				}
			} else {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: `Linked tasks were not started: ${unlock.reason ?? "no delivery evidence yet."}`,
					timeout: 7000,
				});
			}

			// Completing a task never deletes its worktree. Stop the session
			// best-effort so no live session lingers behind a terminal card.
			await Promise.all([stopTaskSession(task.id), stopTaskSession(getDetailTerminalTaskId(task.id))]);
			onTaskCompleted?.(task.id);
		},
		[
			checkDependentsUnlock,
			isBackendTaskDispatchEnabled,
			onTaskCompleted,
			setBoard,
			setSelectedTaskId,
			startReadyLinkedTasks,
			stopTaskSession,
		],
	);

	const requestMoveTaskToTrash = useCallback(
		async (taskId: string, _fromColumnId: BoardColumnId, options?: RequestMoveTaskToTrashOptions): Promise<void> => {
			const boardSnapshot = boardRef.current;
			const selection = findCardSelection(boardSnapshot, taskId);
			if (!selection) {
				return;
			}

			const moveSelectionIfOptimisticMoveIsConfirmed = () => {
				if (!options?.optimisticMoveApplied) {
					return;
				}
				setSelectedTaskId((currentSelectedTaskId) =>
					currentSelectedTaskId === taskId
						? getNextDetailTaskIdAfterTrashMove(boardSnapshot, taskId)
						: currentSelectedTaskId,
				);
			};

			if (options?.skipWorkingChangeWarning) {
				moveSelectionIfOptimisticMoveIsConfirmed();
				await performMoveTaskToTrash(selection.card, boardSnapshot);
				return;
			}

			moveSelectionIfOptimisticMoveIsConfirmed();
			await performMoveTaskToTrash(selection.card, boardSnapshot);
		},
		[performMoveTaskToTrash, setSelectedTaskId],
	);

	const requestCompleteTask = useCallback(
		async (taskId: string, _fromColumnId: BoardColumnId, _options?: RequestMoveTaskToTrashOptions): Promise<void> => {
			const boardSnapshot = boardRef.current;
			const selection = findCardSelection(boardSnapshot, taskId);
			if (!selection) {
				return;
			}
			await performCompleteTask(selection.card, boardSnapshot);
		},
		[performCompleteTask],
	);

	return {
		handleCreateDependency,
		handleDeleteDependency,
		confirmMoveTaskToTrash: async (task: BoardCard, currentBoard?: BoardData) => {
			await performMoveTaskToTrash(task, currentBoard);
		},
		requestMoveTaskToTrash,
		requestCompleteTask,
	};
}
