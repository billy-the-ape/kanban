import { deriveTaskTitleFromPrompt } from "@runtime-task-title";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import {
	normalizeStoredTaskAutoReviewMode,
	TASK_AUTO_REVIEW_ENABLED_STORAGE_KEY,
	TASK_AUTO_REVIEW_MODE_STORAGE_KEY,
	TASK_START_IN_PLAN_MODE_STORAGE_KEY,
} from "@/hooks/app-utils";
import type { RuntimeAgentId, RuntimeTaskClineSettings, RuntimeTaskInitialStartStatusResponse } from "@/runtime/types";
import { addTaskToColumnWithResult, findCardSelection, updateTask, updateTaskTitle } from "@/state/board-state";
import { toTelemetrySelectedAgentId, trackTaskCreated } from "@/telemetry/events";
import type { BoardCard, BoardData, TaskAutoReviewMode, TaskImage } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";
import { useBooleanLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";

/**
 * UPD-0: missing values normalize to true; an explicit false disables the
 * pre-start base refresh. New tasks start with the option checked.
 */
const DEFAULT_NEW_TASK_UPDATE_BASE_REF_BEFORE_START = true;

interface UseTaskEditorInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	currentProjectId: string | null;
	createTaskBranchOptions: Array<{ value: string; label: string }>;
	defaultTaskBranchRef: string;
	selectedAgentId: RuntimeAgentId | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	queueTaskStartAfterEdit?: (taskId: string) => void;
	/** UPD-1: server-derived initial-start status (baseline-fixed signal gates the edit checkbox). */
	getTaskInitialStartStatus: (taskId: string) => Promise<RuntimeTaskInitialStartStatusResponse | null>;
	/**
	 * PRTRACK-1: server-owned PR automation settings. The edit dialog takes a
	 * diff and saves ONLY changed fields through this revision-checked write
	 * (never through the whole-board draft), surfacing conflicts as a toast.
	 */
	setTaskPrSettingsForTask?: (
		taskId: string,
		settings: {
			autoAddressComments: boolean;
			autoFinishOnMerge: boolean;
			expectedSettingsRevision: number;
		},
	) => Promise<{ ok: boolean; reason?: string | null }>;
}

interface OpenEditTaskOptions {
	preserveDetailSelection?: boolean;
}

interface CreateTaskOptions {
	keepDialogOpen?: boolean;
}

export interface UseTaskEditorResult {
	isInlineTaskCreateOpen: boolean;
	newTaskPrompt: string;
	setNewTaskPrompt: Dispatch<SetStateAction<string>>;
	newTaskImages: TaskImage[];
	setNewTaskImages: Dispatch<SetStateAction<TaskImage[]>>;
	newTaskStartInPlanMode: boolean;
	setNewTaskStartInPlanMode: Dispatch<SetStateAction<boolean>>;
	newTaskAutoReviewEnabled: boolean;
	setNewTaskAutoReviewEnabled: Dispatch<SetStateAction<boolean>>;
	newTaskAutoReviewMode: TaskAutoReviewMode;
	setNewTaskAutoReviewMode: Dispatch<SetStateAction<TaskAutoReviewMode>>;
	/** PRTRACK-1: PR automation preferences for new tasks (server-owned; default off). */
	newTaskPrAutoAddressComments: boolean;
	setNewTaskPrAutoAddressComments: Dispatch<SetStateAction<boolean>>;
	newTaskPrAutoFinishOnMerge: boolean;
	setNewTaskPrAutoFinishOnMerge: Dispatch<SetStateAction<boolean>>;
	isNewTaskStartInPlanModeDisabled: boolean;
	newTaskBranchRef: string;
	setNewTaskBranchRef: Dispatch<SetStateAction<string>>;
	/** UPD-1: new-task pre-start base refresh option (missing card values normalize to true). */
	newTaskUpdateBaseRefBeforeStart: boolean;
	setNewTaskUpdateBaseRefBeforeStart: Dispatch<SetStateAction<boolean>>;
	newTaskAgentId: RuntimeAgentId | undefined;
	setNewTaskAgentId: Dispatch<SetStateAction<RuntimeAgentId | undefined>>;
	newTaskClineSettings: RuntimeTaskClineSettings | undefined;
	setNewTaskClineSettings: Dispatch<SetStateAction<RuntimeTaskClineSettings | undefined>>;
	editingTaskId: string | null;
	editTaskPrompt: string;
	setEditTaskPrompt: Dispatch<SetStateAction<string>>;
	editTaskImages: TaskImage[];
	setEditTaskImages: Dispatch<SetStateAction<TaskImage[]>>;
	editTaskStartInPlanMode: boolean;
	setEditTaskStartInPlanMode: Dispatch<SetStateAction<boolean>>;
	editTaskAutoReviewEnabled: boolean;
	setEditTaskAutoReviewEnabled: Dispatch<SetStateAction<boolean>>;
	editTaskAutoReviewMode: TaskAutoReviewMode;
	setEditTaskAutoReviewMode: Dispatch<SetStateAction<TaskAutoReviewMode>>;
	/** PRTRACK-1: PR automation preferences for the edited task. */
	editTaskPrAutoAddressComments: boolean;
	setEditTaskPrAutoAddressComments: Dispatch<SetStateAction<boolean>>;
	editTaskPrAutoFinishOnMerge: boolean;
	setEditTaskPrAutoFinishOnMerge: Dispatch<SetStateAction<boolean>>;
	isEditTaskStartInPlanModeDisabled: boolean;
	editTaskBranchRef: string;
	setEditTaskBranchRef: Dispatch<SetStateAction<string>>;
	editTaskAgentId: RuntimeAgentId | undefined;
	setEditTaskAgentId: Dispatch<SetStateAction<RuntimeAgentId | undefined>>;
	editTaskClineSettings: RuntimeTaskClineSettings | undefined;
	setEditTaskClineSettings: Dispatch<SetStateAction<RuntimeTaskClineSettings | undefined>>;
	/** UPD-1: edit-task pre-start base refresh option (missing card values normalize to true). */
	editTaskUpdateBaseRefBeforeStart: boolean;
	setEditTaskUpdateBaseRefBeforeStart: Dispatch<SetStateAction<boolean>>;
	/** UPD-1: server-derived; a fixed initial-start baseline makes the checkbox read-only. */
	editTaskInitialBaselineFixed: boolean;
	handleOpenCreateTask: () => void;
	handleCancelCreateTask: () => void;
	handleOpenEditTask: (task: BoardCard, options?: OpenEditTaskOptions) => void;
	handleCancelEditTask: () => void;
	handleSaveEditedTask: () => string | null;
	handleSaveAndStartEditedTask: () => void;
	handleSaveTaskTitle: (taskId: string, title: string) => void;
	handleCreateTask: (options?: CreateTaskOptions) => string | null;
	handleCreateTasks: (prompts: string[], options?: CreateTaskOptions) => string[];
	resetTaskEditorState: () => void;
}

export function useTaskEditor({
	board,
	setBoard,
	currentProjectId,
	createTaskBranchOptions,
	defaultTaskBranchRef,
	selectedAgentId,
	setSelectedTaskId,
	queueTaskStartAfterEdit,
	getTaskInitialStartStatus,
	setTaskPrSettingsForTask,
}: UseTaskEditorInput): UseTaskEditorResult {
	const [isInlineTaskCreateOpen, setIsInlineTaskCreateOpen] = useState(false);
	const [newTaskPrompt, setNewTaskPrompt] = useState("");
	const [newTaskImages, setNewTaskImages] = useState<TaskImage[]>([]);
	const [newTaskStartInPlanMode, setNewTaskStartInPlanMode] = useBooleanLocalStorageValue(
		TASK_START_IN_PLAN_MODE_STORAGE_KEY,
		false,
	);
	const [newTaskAutoReviewEnabled, setNewTaskAutoReviewEnabled] = useBooleanLocalStorageValue(
		TASK_AUTO_REVIEW_ENABLED_STORAGE_KEY,
		false,
	);
	const [newTaskAutoReviewMode, setNewTaskAutoReviewMode] = useRawLocalStorageValue<TaskAutoReviewMode>(
		TASK_AUTO_REVIEW_MODE_STORAGE_KEY,
		"commit",
		normalizeStoredTaskAutoReviewMode,
	);
	const [newTaskPrAutoAddressComments, setNewTaskPrAutoAddressComments] = useState(false);
	const [newTaskPrAutoFinishOnMerge, setNewTaskPrAutoFinishOnMerge] = useState(false);
	const isNewTaskStartInPlanModeDisabled = false;
	const [newTaskBranchRef, setNewTaskBranchRef] = useState("");
	const [lastCreatedTaskBranchByProjectId, setLastCreatedTaskBranchByProjectId] = useState<Record<string, string>>({});
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
	const [editTaskPrompt, setEditTaskPrompt] = useState("");
	const [editTaskImages, setEditTaskImages] = useState<TaskImage[]>([]);
	const [editTaskStartInPlanMode, setEditTaskStartInPlanMode] = useState(false);
	const [editTaskAutoReviewEnabled, setEditTaskAutoReviewEnabled] = useState(false);
	const [editTaskAutoReviewMode, setEditTaskAutoReviewMode] = useState<TaskAutoReviewMode>("commit");
	const [editTaskPrAutoAddressComments, setEditTaskPrAutoAddressComments] = useState(false);
	const [editTaskPrAutoFinishOnMerge, setEditTaskPrAutoFinishOnMerge] = useState(false);
	const isEditTaskStartInPlanModeDisabled = false;
	const [editTaskBranchRef, setEditTaskBranchRef] = useState("");
	const [newTaskUpdateBaseRefBeforeStart, setNewTaskUpdateBaseRefBeforeStart] = useState(
		DEFAULT_NEW_TASK_UPDATE_BASE_REF_BEFORE_START,
	);
	const [editTaskUpdateBaseRefBeforeStart, setEditTaskUpdateBaseRefBeforeStart] = useState(
		DEFAULT_NEW_TASK_UPDATE_BASE_REF_BEFORE_START,
	);
	// UPD-1: server-derived baseline-fixed signal (durable and reload-safe). A
	// failed query stays false so the checkbox remains editable; the server
	// still gates the actual refresh on its own signal.
	const [editTaskInitialBaselineFixed, setEditTaskInitialBaselineFixed] = useState(false);
	const editInitialStartStatusTaskIdRef = useRef<string | null>(null);

	const [newTaskAgentId, setNewTaskAgentId] = useState<RuntimeAgentId | undefined>(undefined);
	const [newTaskClineSettings, setNewTaskClineSettings] = useState<RuntimeTaskClineSettings | undefined>(undefined);
	const [editTaskAgentId, setEditTaskAgentId] = useState<RuntimeAgentId | undefined>(undefined);
	const [editTaskClineSettings, setEditTaskClineSettings] = useState<RuntimeTaskClineSettings | undefined>(undefined);

	const lastCreatedTaskBranchRef = useMemo(() => {
		if (!currentProjectId) {
			return null;
		}
		return lastCreatedTaskBranchByProjectId[currentProjectId] ?? null;
	}, [currentProjectId, lastCreatedTaskBranchByProjectId]);

	const resolvedDefaultTaskBranchRef = useMemo(() => {
		if (
			lastCreatedTaskBranchRef &&
			createTaskBranchOptions.some((option) => option.value === lastCreatedTaskBranchRef)
		) {
			return lastCreatedTaskBranchRef;
		}
		return defaultTaskBranchRef;
	}, [createTaskBranchOptions, defaultTaskBranchRef, lastCreatedTaskBranchRef]);

	useEffect(() => {
		const isCurrentValid = createTaskBranchOptions.some((option) => option.value === newTaskBranchRef);
		if (isCurrentValid) {
			return;
		}
		setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
	}, [createTaskBranchOptions, newTaskBranchRef, resolvedDefaultTaskBranchRef]);

	useEffect(() => {
		if (!isInlineTaskCreateOpen) {
			return;
		}
		if (!newTaskBranchRef) {
			setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
		}
	}, [isInlineTaskCreateOpen, newTaskBranchRef, resolvedDefaultTaskBranchRef]);

	useEffect(() => {
		if (!isNewTaskStartInPlanModeDisabled || !newTaskStartInPlanMode) {
			return;
		}
		setNewTaskStartInPlanMode(false);
	}, [isNewTaskStartInPlanModeDisabled, newTaskStartInPlanMode, setNewTaskStartInPlanMode]);

	useEffect(() => {
		if (!isEditTaskStartInPlanModeDisabled || !editTaskStartInPlanMode) {
			return;
		}
		setEditTaskStartInPlanMode(false);
	}, [editTaskStartInPlanMode, isEditTaskStartInPlanModeDisabled]);

	useEffect(() => {
		if (!editingTaskId) {
			return;
		}
		const isCurrentValid = createTaskBranchOptions.some((option) => option.value === editTaskBranchRef);
		if (isCurrentValid) {
			return;
		}
		setEditTaskBranchRef(resolvedDefaultTaskBranchRef);
	}, [createTaskBranchOptions, editTaskBranchRef, editingTaskId, resolvedDefaultTaskBranchRef]);

	useEffect(() => {
		if (!editingTaskId) {
			return;
		}
		const selection = findCardSelection(board, editingTaskId);
		if (selection?.column.id !== "backlog") {
			setEditingTaskId(null);
			editInitialStartStatusTaskIdRef.current = null;

			setEditTaskPrompt("");
			setEditTaskStartInPlanMode(false);
			setEditTaskAutoReviewEnabled(false);
			setEditTaskAutoReviewMode("commit");
			setEditTaskImages([]);
			setEditTaskBranchRef("");
			setEditTaskUpdateBaseRefBeforeStart(DEFAULT_NEW_TASK_UPDATE_BASE_REF_BEFORE_START);
			setEditTaskInitialBaselineFixed(false);
		}
	}, [board, editingTaskId]);

	const handleOpenCreateTask = useCallback(() => {
		setEditingTaskId(null);
		editInitialStartStatusTaskIdRef.current = null;
		setEditTaskPrompt("");
		setEditTaskImages([]);

		setNewTaskAgentId(undefined);
		setNewTaskClineSettings(undefined);
		setNewTaskUpdateBaseRefBeforeStart(DEFAULT_NEW_TASK_UPDATE_BASE_REF_BEFORE_START);
		setIsInlineTaskCreateOpen(true);
	}, []);

	const handleCancelCreateTask = useCallback(() => {
		setIsInlineTaskCreateOpen(false);

		setNewTaskPrompt("");
		setNewTaskImages([]);
		setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
		setNewTaskAgentId(undefined);
		setNewTaskClineSettings(undefined);
		setNewTaskUpdateBaseRefBeforeStart(DEFAULT_NEW_TASK_UPDATE_BASE_REF_BEFORE_START);
	}, [resolvedDefaultTaskBranchRef]);

	const handleOpenEditTask = useCallback(
		(task: BoardCard, options?: OpenEditTaskOptions) => {
			if (!options?.preserveDetailSelection) {
				setSelectedTaskId(null);
			}
			setIsInlineTaskCreateOpen(false);

			setNewTaskPrompt("");
			setNewTaskImages([]);
			const taskPrompt = task.prompt.trim();
			setEditingTaskId(task.id);

			setEditTaskPrompt(taskPrompt);
			setEditTaskImages(task.images ? task.images.map((image) => ({ ...image })) : []);
			setEditTaskStartInPlanMode(task.startInPlanMode);
			setEditTaskAutoReviewEnabled(task.autoReviewEnabled === true);
			setEditTaskAutoReviewMode(resolveTaskAutoReviewMode(task.autoReviewMode));
			setEditTaskPrAutoAddressComments(task.autoAddressComments === true);
			setEditTaskPrAutoFinishOnMerge(task.autoFinishOnMerge === true);
			const fallbackBranch = task.baseRef || resolvedDefaultTaskBranchRef;
			setEditTaskBranchRef(fallbackBranch);
			setEditTaskAgentId(task.agentId);
			setEditTaskClineSettings(task.clineSettings);
			// UPD-1: load the persisted policy (missing values normalize to
			// true) and ask the server whether the initial start baseline is
			// already fixed; a fixed baseline makes the checkbox read-only.
			setEditTaskUpdateBaseRefBeforeStart(task.updateBaseRefBeforeStart !== false);
			setEditTaskInitialBaselineFixed(false);
			const statusTaskId = task.id;
			editInitialStartStatusTaskIdRef.current = statusTaskId;
			void getTaskInitialStartStatus(statusTaskId).then((status) => {
				if (status?.ok && editInitialStartStatusTaskIdRef.current === statusTaskId) {
					setEditTaskInitialBaselineFixed(status.initialStartBaselineFixed === true);
				}
			});
		},
		[getTaskInitialStartStatus, resolvedDefaultTaskBranchRef, setSelectedTaskId],
	);

	const handleCancelEditTask = useCallback(() => {
		setEditingTaskId(null);
		editInitialStartStatusTaskIdRef.current = null;

		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskPrAutoAddressComments(false);
		setEditTaskPrAutoFinishOnMerge(false);
		setEditTaskImages([]);
		setEditTaskBranchRef("");
		setEditTaskUpdateBaseRefBeforeStart(DEFAULT_NEW_TASK_UPDATE_BASE_REF_BEFORE_START);
		setEditTaskInitialBaselineFixed(false);
	}, []);

	const handleSaveEditedTask = useCallback((): string | null => {
		if (!editingTaskId) {
			return null;
		}
		const prompt = editTaskPrompt.trim();
		if (!prompt) {
			return null;
		}
		if (!(editTaskBranchRef || resolvedDefaultTaskBranchRef)) {
			return null;
		}

		const baseRef = editTaskBranchRef || resolvedDefaultTaskBranchRef;
		const savedTaskId = editingTaskId;

		// PRTRACK-1: the PR automation checkboxes are server-owned settings,
		// not part of the whole-board draft. Diff against the current card and
		// save only changed fields through the revision-checked settings
		// write (conflicts are surfaced, never silently overwritten).
		const currentCard = board.columns.flatMap((column) => column.cards).find((card) => card.id === savedTaskId);
		const prSettingsChanged =
			currentCard !== undefined &&
			(editTaskPrAutoAddressComments !== (currentCard.autoAddressComments === true) ||
				editTaskPrAutoFinishOnMerge !== (currentCard.autoFinishOnMerge === true));

		setBoard((currentBoard) => {
			const boardCard = currentBoard.columns.flatMap((c) => c.cards).find((c) => c.id === savedTaskId);
			const title = boardCard?.title ?? "";
			const updated = updateTask(currentBoard, savedTaskId, {
				title,
				prompt,
				startInPlanMode: editTaskStartInPlanMode,
				autoReviewEnabled: editTaskAutoReviewEnabled,
				autoReviewMode: editTaskAutoReviewMode,
				images: editTaskImages,
				agentId: editTaskAgentId,
				clineSettings: editTaskClineSettings,
				baseRef,
				// UPD-1: once the baseline is fixed the option no longer
				// applies; keep the persisted value untouched.
				updateBaseRefBeforeStart: editTaskInitialBaselineFixed ? undefined : editTaskUpdateBaseRefBeforeStart,
			});
			return updated.updated ? updated.board : currentBoard;
		});
		setEditingTaskId(null);
		editInitialStartStatusTaskIdRef.current = null;

		if (prSettingsChanged && currentCard !== undefined && setTaskPrSettingsForTask) {
			const expectedSettingsRevision = currentCard.settingsRevision ?? 0;
			void setTaskPrSettingsForTask(savedTaskId, {
				autoAddressComments: editTaskPrAutoAddressComments,
				autoFinishOnMerge: editTaskPrAutoFinishOnMerge,
				expectedSettingsRevision,
			}).then((result) => {
				if (!result.ok && result.reason === "conflict") {
					showAppToast({
						intent: "warning",
						message:
							"The task's PR tracking settings changed while you were editing; open the edit dialog again to review them.",
					});
				}
			});
		}

		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskImages([]);
		setEditTaskBranchRef("");
		setEditTaskAgentId(undefined);
		setEditTaskClineSettings(undefined);
		setEditTaskUpdateBaseRefBeforeStart(DEFAULT_NEW_TASK_UPDATE_BASE_REF_BEFORE_START);
		setEditTaskInitialBaselineFixed(false);
		return savedTaskId;
	}, [
		editTaskAgentId,
		editTaskAutoReviewEnabled,
		editTaskAutoReviewMode,
		editTaskPrAutoAddressComments,
		editTaskPrAutoFinishOnMerge,
		editTaskBranchRef,
		editTaskClineSettings,
		editTaskInitialBaselineFixed,
		editTaskPrompt,
		editTaskImages,
		editTaskStartInPlanMode,
		editTaskUpdateBaseRefBeforeStart,
		editingTaskId,
		resolvedDefaultTaskBranchRef,
		board,
		setBoard,
		setTaskPrSettingsForTask,
	]);

	const handleSaveAndStartEditedTask = useCallback(() => {
		const taskId = handleSaveEditedTask();
		if (!taskId) {
			return;
		}
		queueTaskStartAfterEdit?.(taskId);
	}, [handleSaveEditedTask, queueTaskStartAfterEdit]);

	const handleSaveTaskTitle = useCallback(
		(taskId: string, title: string) => {
			setBoard((currentBoard) => {
				const updated = updateTaskTitle(currentBoard, taskId, title);
				return updated.updated ? updated.board : currentBoard;
			});
		},
		[setBoard],
	);

	const handleCreateTask = useCallback(
		(options?: CreateTaskOptions): string | null => {
			const prompt = newTaskPrompt.trim();
			if (!prompt) {
				return null;
			}
			if (!(newTaskBranchRef || resolvedDefaultTaskBranchRef)) {
				return null;
			}
			const baseRef = newTaskBranchRef || resolvedDefaultTaskBranchRef;
			const title = deriveTaskTitleFromPrompt(prompt);
			const created = addTaskToColumnWithResult(board, "backlog", {
				title,
				prompt,
				startInPlanMode: newTaskStartInPlanMode,
				autoReviewEnabled: newTaskAutoReviewEnabled,
				autoReviewMode: newTaskAutoReviewMode,
				images: newTaskImages,
				agentId: newTaskAgentId,
				clineSettings: newTaskClineSettings,
				baseRef,
				// UPD-1: persist an explicit policy (unchecked must survive as false).
				updateBaseRefBeforeStart: newTaskUpdateBaseRefBeforeStart,
				// PRTRACK-1: server-owned PR automation preferences.
				autoAddressComments: newTaskPrAutoAddressComments,
				autoFinishOnMerge: newTaskPrAutoFinishOnMerge,
			});
			setBoard(created.board);
			trackTaskCreated({
				selected_agent_id: toTelemetrySelectedAgentId(newTaskAgentId ?? selectedAgentId),
				start_in_plan_mode: newTaskStartInPlanMode,
				...(newTaskAutoReviewEnabled ? { auto_review_mode: newTaskAutoReviewMode } : {}),
				prompt_character_count: prompt.length,
			});
			if (currentProjectId) {
				setLastCreatedTaskBranchByProjectId((current) => ({
					...current,
					[currentProjectId]: baseRef,
				}));
			}

			setNewTaskPrompt("");
			setNewTaskImages([]);
			setNewTaskBranchRef(baseRef);
			setNewTaskAgentId(undefined);
			setNewTaskClineSettings(undefined);
			if (!options?.keepDialogOpen) {
				setIsInlineTaskCreateOpen(false);
			}
			return created.task.id;
		},
		[
			board,
			currentProjectId,
			newTaskAgentId,
			newTaskAutoReviewEnabled,
			newTaskAutoReviewMode,
			newTaskPrAutoAddressComments,
			newTaskPrAutoFinishOnMerge,
			newTaskBranchRef,
			newTaskClineSettings,
			newTaskImages,
			newTaskPrompt,
			newTaskStartInPlanMode,
			newTaskUpdateBaseRefBeforeStart,
			resolvedDefaultTaskBranchRef,
			selectedAgentId,
			setBoard,
			setNewTaskAgentId,
			setNewTaskClineSettings,
		],
	);

	const handleCreateTasks = useCallback(
		(prompts: string[], options?: CreateTaskOptions): string[] => {
			const validPrompts = prompts.map((p) => p.trim()).filter(Boolean);
			if (validPrompts.length === 0) {
				return [];
			}
			if (!(newTaskBranchRef || resolvedDefaultTaskBranchRef)) {
				return [];
			}
			const baseRef = newTaskBranchRef || resolvedDefaultTaskBranchRef;
			const createdTaskIds: string[] = [];
			let updatedBoard = board;
			for (const prompt of validPrompts) {
				const created = addTaskToColumnWithResult(updatedBoard, "backlog", {
					prompt,
					startInPlanMode: newTaskStartInPlanMode,
					autoReviewEnabled: newTaskAutoReviewEnabled,
					autoReviewMode: newTaskAutoReviewMode,
					images: newTaskImages,
					agentId: newTaskAgentId,
					clineSettings: newTaskClineSettings,
					baseRef,
					// UPD-1: persist an explicit policy (unchecked must survive as false).
					updateBaseRefBeforeStart: newTaskUpdateBaseRefBeforeStart,
					// PRTRACK-1: server-owned PR automation preferences.
					autoAddressComments: newTaskPrAutoAddressComments,
					autoFinishOnMerge: newTaskPrAutoFinishOnMerge,
				});
				updatedBoard = created.board;
				createdTaskIds.push(created.task.id);
			}
			setBoard(updatedBoard);
			for (const prompt of validPrompts) {
				trackTaskCreated({
					selected_agent_id: toTelemetrySelectedAgentId(newTaskAgentId ?? selectedAgentId),
					start_in_plan_mode: newTaskStartInPlanMode,
					...(newTaskAutoReviewEnabled ? { auto_review_mode: newTaskAutoReviewMode } : {}),
					prompt_character_count: prompt.length,
				});
			}
			if (currentProjectId) {
				setLastCreatedTaskBranchByProjectId((current) => ({
					...current,
					[currentProjectId]: baseRef,
				}));
			}

			setNewTaskPrompt("");
			setNewTaskImages([]);
			setNewTaskBranchRef(baseRef);
			setNewTaskAgentId(undefined);
			setNewTaskClineSettings(undefined);
			if (!options?.keepDialogOpen) {
				setIsInlineTaskCreateOpen(false);
			}
			return createdTaskIds;
		},
		[
			board,
			currentProjectId,
			newTaskAgentId,
			newTaskAutoReviewEnabled,
			newTaskAutoReviewMode,
			newTaskPrAutoAddressComments,
			newTaskPrAutoFinishOnMerge,
			newTaskBranchRef,
			newTaskClineSettings,
			newTaskImages,
			newTaskStartInPlanMode,
			newTaskUpdateBaseRefBeforeStart,
			resolvedDefaultTaskBranchRef,
			selectedAgentId,
			setBoard,
			setNewTaskAgentId,
			setNewTaskClineSettings,
		],
	);

	const resetTaskEditorState = useCallback(() => {
		setIsInlineTaskCreateOpen(false);
		setEditingTaskId(null);
		editInitialStartStatusTaskIdRef.current = null;

		setNewTaskPrompt("");
		setNewTaskUpdateBaseRefBeforeStart(DEFAULT_NEW_TASK_UPDATE_BASE_REF_BEFORE_START);

		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskImages([]);
		setEditTaskBranchRef("");
		setEditTaskUpdateBaseRefBeforeStart(DEFAULT_NEW_TASK_UPDATE_BASE_REF_BEFORE_START);
		setEditTaskInitialBaselineFixed(false);
		setEditTaskAgentId(undefined);
		setEditTaskClineSettings(undefined);
		setNewTaskImages([]);
		setNewTaskAgentId(undefined);
		setNewTaskClineSettings(undefined);
	}, []);

	return {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskStartInPlanMode,
		setNewTaskStartInPlanMode,
		newTaskAutoReviewEnabled,
		setNewTaskAutoReviewEnabled,
		newTaskAutoReviewMode,
		setNewTaskAutoReviewMode,
		newTaskPrAutoAddressComments,
		setNewTaskPrAutoAddressComments,
		newTaskPrAutoFinishOnMerge,
		setNewTaskPrAutoFinishOnMerge,
		isNewTaskStartInPlanModeDisabled,
		newTaskBranchRef,
		setNewTaskBranchRef,
		newTaskUpdateBaseRefBeforeStart,
		setNewTaskUpdateBaseRefBeforeStart,
		newTaskAgentId,
		setNewTaskAgentId,
		newTaskClineSettings,
		setNewTaskClineSettings,
		editingTaskId,
		editTaskPrompt,
		setEditTaskPrompt,
		editTaskImages,
		setEditTaskImages,
		editTaskStartInPlanMode,
		setEditTaskStartInPlanMode,
		editTaskAutoReviewEnabled,
		setEditTaskAutoReviewEnabled,
		editTaskAutoReviewMode,
		setEditTaskAutoReviewMode,
		editTaskPrAutoAddressComments,
		setEditTaskPrAutoAddressComments,
		editTaskPrAutoFinishOnMerge,
		setEditTaskPrAutoFinishOnMerge,
		isEditTaskStartInPlanModeDisabled,
		editTaskBranchRef,
		setEditTaskBranchRef,
		editTaskUpdateBaseRefBeforeStart,
		setEditTaskUpdateBaseRefBeforeStart,
		editTaskInitialBaselineFixed,
		editTaskAgentId,
		setEditTaskAgentId,
		editTaskClineSettings,
		setEditTaskClineSettings,
		handleOpenCreateTask,
		handleCancelCreateTask,
		handleOpenEditTask,
		handleCancelEditTask,
		handleSaveEditedTask,
		handleSaveAndStartEditedTask,
		handleSaveTaskTitle,
		handleCreateTask,
		handleCreateTasks,
		resetTaskEditorState,
	};
}
