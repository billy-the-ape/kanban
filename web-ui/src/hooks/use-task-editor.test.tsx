import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskEditor } from "@/hooks/use-task-editor";
import type { RuntimeAgentId, RuntimeTaskClineSettings, RuntimeTaskInitialStartStatusResponse } from "@/runtime/types";
import type { BoardCard, BoardData, TaskAutoReviewMode, TaskImage } from "@/types";

function createTask(taskId: string, prompt: string, createdAt: number, overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: taskId,
		title: prompt,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
		...overrides,
	};
}

function createBoard(tasks: BoardCard[] = []): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: tasks },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

interface HookSnapshot {
	board: BoardData;
	isInlineTaskCreateOpen: boolean;
	newTaskPrompt: string;
	newTaskImages: TaskImage[];
	newTaskBranchRef: string;
	newTaskUpdateBaseRefBeforeStart: boolean;
	setNewTaskUpdateBaseRefBeforeStart: (value: boolean) => void;
	newTaskAgentId: RuntimeAgentId | undefined;
	newTaskClineSettings: RuntimeTaskClineSettings | undefined;
	editingTaskId: string | null;
	editTaskPrompt: string;
	editTaskUpdateBaseRefBeforeStart: boolean;
	editTaskInitialBaselineFixed: boolean;
	editTaskStartInPlanMode: boolean;
	isEditTaskStartInPlanModeDisabled: boolean;
	handleOpenCreateTask: () => void;
	handleCreateTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleCreateTasks: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	setNewTaskPrompt: (value: string) => void;
	setNewTaskImages: (value: TaskImage[]) => void;
	handleOpenEditTask: (task: BoardCard) => void;
	handleSaveEditedTask: () => string | null;
	handleSaveAndStartEditedTask: () => void;
	setEditTaskPrompt: (value: string) => void;
	setEditTaskAutoReviewEnabled: (value: boolean) => void;
	setEditTaskAutoReviewMode: (value: TaskAutoReviewMode) => void;
	setNewTaskAgentId: (value: RuntimeAgentId | undefined) => void;
	setNewTaskClineSettings: (value: RuntimeTaskClineSettings | undefined) => void;
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}

function HookHarness({
	initialBoard,
	onSnapshot,
	queueTaskStartAfterEdit,
	getTaskInitialStartStatus = async () => null,
}: {
	initialBoard: BoardData;
	onSnapshot: (snapshot: HookSnapshot) => void;
	queueTaskStartAfterEdit?: (taskId: string) => void;
	getTaskInitialStartStatus?: (taskId: string) => Promise<RuntimeTaskInitialStartStatusResponse | null>;
}): null {
	const [board, setBoard] = useState<BoardData>(initialBoard);
	const [, setSelectedTaskId] = useState<string | null>(null);
	const editor = useTaskEditor({
		board,
		setBoard,
		currentProjectId: "project-1",
		createTaskBranchOptions: [{ value: "main", label: "main" }],
		defaultTaskBranchRef: "main",
		selectedAgentId: null,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
		getTaskInitialStartStatus,
	});

	useEffect(() => {
		onSnapshot({
			board,
			isInlineTaskCreateOpen: editor.isInlineTaskCreateOpen,
			newTaskPrompt: editor.newTaskPrompt,
			newTaskImages: editor.newTaskImages,
			newTaskBranchRef: editor.newTaskBranchRef,
			newTaskUpdateBaseRefBeforeStart: editor.newTaskUpdateBaseRefBeforeStart,
			setNewTaskUpdateBaseRefBeforeStart: editor.setNewTaskUpdateBaseRefBeforeStart,
			newTaskAgentId: editor.newTaskAgentId,
			newTaskClineSettings: editor.newTaskClineSettings,
			editingTaskId: editor.editingTaskId,
			editTaskPrompt: editor.editTaskPrompt,
			editTaskUpdateBaseRefBeforeStart: editor.editTaskUpdateBaseRefBeforeStart,
			editTaskInitialBaselineFixed: editor.editTaskInitialBaselineFixed,
			editTaskStartInPlanMode: editor.editTaskStartInPlanMode,
			isEditTaskStartInPlanModeDisabled: editor.isEditTaskStartInPlanModeDisabled,
			handleOpenCreateTask: editor.handleOpenCreateTask,
			handleCreateTask: editor.handleCreateTask,
			handleCreateTasks: editor.handleCreateTasks,
			setNewTaskPrompt: editor.setNewTaskPrompt,
			setNewTaskImages: editor.setNewTaskImages,
			handleOpenEditTask: editor.handleOpenEditTask,
			handleSaveEditedTask: editor.handleSaveEditedTask,
			handleSaveAndStartEditedTask: editor.handleSaveAndStartEditedTask,
			setEditTaskPrompt: editor.setEditTaskPrompt,
			setEditTaskAutoReviewEnabled: editor.setEditTaskAutoReviewEnabled,
			setEditTaskAutoReviewMode: editor.setEditTaskAutoReviewMode,
			setNewTaskAgentId: editor.setNewTaskAgentId,
			setNewTaskClineSettings: editor.setNewTaskClineSettings,
		});
	}, [
		board,
		editor.editTaskUpdateBaseRefBeforeStart,
		editor.editTaskInitialBaselineFixed,
		editor.handleCreateTask,
		editor.handleCreateTasks,
		editor.handleOpenCreateTask,
		editor.editTaskPrompt,
		editor.editTaskStartInPlanMode,
		editor.editingTaskId,
		editor.handleOpenEditTask,
		editor.handleSaveEditedTask,
		editor.handleSaveAndStartEditedTask,
		editor.isEditTaskStartInPlanModeDisabled,
		editor.isInlineTaskCreateOpen,
		editor.newTaskPrompt,
		editor.newTaskImages,
		editor.newTaskBranchRef,
		editor.newTaskAgentId,
		editor.newTaskClineSettings,
		editor.setEditTaskAutoReviewEnabled,
		editor.setEditTaskAutoReviewMode,
		editor.setEditTaskPrompt,
		editor.setNewTaskImages,
		editor.setNewTaskPrompt,
		onSnapshot,
	]);

	return null;
}

describe("useTaskEditor", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		localStorage.clear();
	});

	it("returns the edited task id when saving a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([createTask("task-1", "Initial prompt", 1)]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const task = initialSnapshot.board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			initialSnapshot.handleOpenEditTask(task);
		});

		requireSnapshot(latestSnapshot);

		await act(async () => {
			latestSnapshot?.setEditTaskPrompt("Updated prompt");
		});

		let savedTaskId: string | null = null;
		await act(async () => {
			savedTaskId = latestSnapshot?.handleSaveEditedTask() ?? null;
		});

		expect(savedTaskId).toBe("task-1");
		expect(requireSnapshot(latestSnapshot).editingTaskId).toBeNull();
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.prompt).toBe("Updated prompt");
	});

	it("does not disable start in plan mode when auto review is enabled while editing", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([
			createTask("task-1", "Initial prompt", 1, {
				startInPlanMode: true,
			}),
		]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const task = initialSnapshot.board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			initialSnapshot.handleOpenEditTask(task);
		});

		await act(async () => {
			latestSnapshot?.setEditTaskAutoReviewEnabled(true);
			latestSnapshot?.setEditTaskAutoReviewMode("commit");
		});

		expect(requireSnapshot(latestSnapshot).isEditTaskStartInPlanModeDisabled).toBe(false);
	});

	it("queues the saved task id when saving and starting an edited task", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const queueTaskStartAfterEdit = vi.fn();
		const initialBoard = createBoard([createTask("task-1", "Initial prompt", 1)]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					queueTaskStartAfterEdit={queueTaskStartAfterEdit}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const task = initialSnapshot.board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			initialSnapshot.handleOpenEditTask(task);
		});

		await act(async () => {
			latestSnapshot?.setEditTaskPrompt("Updated prompt");
		});

		await act(async () => {
			latestSnapshot?.handleSaveAndStartEditedTask();
		});

		expect(queueTaskStartAfterEdit).toHaveBeenCalledWith("task-1");
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.prompt).toBe("Updated prompt");
	});

	it("keeps the create dialog open when requested after creating a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Create another task");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskAgentId("codex");
			requireSnapshot(latestSnapshot).setNewTaskClineSettings({
				providerId: "provider-abc",
				modelId: "model-xyz",
				reasoningEffort: "low",
			});
		});

		await act(async () => {});
		expect(requireSnapshot(latestSnapshot).newTaskPrompt).toBe("Create another task");
		expect(requireSnapshot(latestSnapshot).newTaskBranchRef).toBe("main");

		let createdTaskId: string | null = null;
		await act(async () => {
			createdTaskId = requireSnapshot(latestSnapshot).handleCreateTask({ keepDialogOpen: true });
		});

		const snapshot = requireSnapshot(latestSnapshot);
		expect(createdTaskId).toBeTruthy();
		expect(snapshot.isInlineTaskCreateOpen).toBe(true);
		expect(snapshot.newTaskPrompt).toBe("");
		expect(snapshot.newTaskBranchRef).toBe("main");
		expect(snapshot.newTaskAgentId).toBeUndefined();
		expect(snapshot.newTaskClineSettings).toBeUndefined();
		expect(snapshot.board.columns[0]?.cards.some((card) => card.prompt === "Create another task")).toBe(true);
	});
	it("copies attached images to each split task and clears the draft images", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			latestSnapshot?.setNewTaskImages([
				{
					id: "img-1",
					data: "abc123",
					mimeType: "image/png",
				},
			]);
		});

		let createdTaskIds: string[] = [];
		await act(async () => {
			createdTaskIds = latestSnapshot?.handleCreateTasks(["First task", "Second task"]) ?? [];
		});

		expect(createdTaskIds).toHaveLength(2);
		const backlogCards = requireSnapshot(latestSnapshot).board.columns[0]?.cards ?? [];
		expect(backlogCards).toHaveLength(2);
		expect(backlogCards.map((card) => card.images)).toEqual([
			[
				{
					id: "img-1",
					data: "abc123",
					mimeType: "image/png",
				},
			],
			[
				{
					id: "img-1",
					data: "abc123",
					mimeType: "image/png",
				},
			],
		]);
		expect(requireSnapshot(latestSnapshot).newTaskImages).toEqual([]);
	});

	it("persists reasoning-only task overrides when model/provider stay inherited", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Reasoning override only");
			requireSnapshot(latestSnapshot).setNewTaskClineSettings({
				reasoningEffort: "low",
			});
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});

		const createdCard = requireSnapshot(latestSnapshot).board.columns[0]?.cards[0];
		expect(createdCard?.clineSettings).toEqual({
			reasoningEffort: "low",
		});
	});

	it("preserves per-task agent/model override fields on each split task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskAgentId("codex");
			requireSnapshot(latestSnapshot).setNewTaskClineSettings({
				providerId: "provider-abc",
				modelId: "model-xyz",
				reasoningEffort: "medium",
			});
		});

		let createdTaskIds: string[] = [];
		await act(async () => {
			createdTaskIds = requireSnapshot(latestSnapshot).handleCreateTasks(["Task A", "Task B", "Task C"]);
		});

		expect(createdTaskIds).toHaveLength(3);
		const backlogCards = requireSnapshot(latestSnapshot).board.columns[0]?.cards ?? [];
		expect(backlogCards).toHaveLength(3);
		for (const card of backlogCards) {
			expect(card.agentId).toBe("codex");
			expect(card.clineSettings).toEqual({
				providerId: "provider-abc",
				modelId: "model-xyz",
				reasoningEffort: "medium",
			});
		}
	});

	it("defaults the new-task base refresh option to checked and persists the explicit choice", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});
		// UPD-1.1: the dialog defaults to checked.
		expect(requireSnapshot(latestSnapshot).newTaskUpdateBaseRefBeforeStart).toBe(true);

		// Unchecking must persist as an explicit false, not vanish as "missing".
		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskUpdateBaseRefBeforeStart(false);
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Refactor the settings panel");
		});
		let createdId: string | null = null;
		await act(async () => {
			createdId = requireSnapshot(latestSnapshot).handleCreateTask();
		});
		expect(createdId).toBeTruthy();
		const createdCard = requireSnapshot(latestSnapshot)
			.board.columns.find((column) => column.id === "backlog")
			?.cards.find((card) => card.id === createdId);
		expect(createdCard?.updateBaseRefBeforeStart).toBe(false);
		// The user's explicit choice stays in the form for follow-up tasks
		// ("Create more"), consistent with the other create-form options.
		expect(requireSnapshot(latestSnapshot).newTaskUpdateBaseRefBeforeStart).toBe(false);
	});

	it("seeds the edit form from the persisted policy, normalizing missing values to true", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const missingCard = createTask("task-missing", "Missing policy", 1);
		const uncheckedCard = createTask("task-unchecked", "Unchecked policy", 2, { updateBaseRefBeforeStart: false });
		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard([missingCard, uncheckedCard])}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		// UPD-1.2: missing value normalizes to checked.
		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(missingCard);
		});
		expect(requireSnapshot(latestSnapshot).editTaskUpdateBaseRefBeforeStart).toBe(true);
		expect(requireSnapshot(latestSnapshot).editTaskInitialBaselineFixed).toBe(false);

		// A persisted false is preserved.
		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(uncheckedCard);
		});
		expect(requireSnapshot(latestSnapshot).editTaskUpdateBaseRefBeforeStart).toBe(false);

		await act(async () => {
			requireSnapshot(latestSnapshot).handleSaveEditedTask();
		});
		const savedCard = requireSnapshot(latestSnapshot)
			.board.columns.find((column) => column.id === "backlog")
			?.cards.find((card) => card.id === "task-unchecked");
		expect(savedCard?.updateBaseRefBeforeStart).toBe(false);
	});

	it("keeps the persisted policy untouched when the initial-start baseline is already fixed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const fixedCard = createTask("task-fixed", "Fixed baseline", 1, { updateBaseRefBeforeStart: true });
		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard([fixedCard])}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
					getTaskInitialStartStatus={async (taskId) => ({
						ok: true,
						taskId,
						stage: "ready",
						baselineSha: null,
						initialStartBaselineFixed: true,
						failure: null,
					})}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(fixedCard);
		});
		// The server signal flips the checkbox into read-only mode.
		expect(requireSnapshot(latestSnapshot).editTaskInitialBaselineFixed).toBe(true);
		expect(requireSnapshot(latestSnapshot).editTaskUpdateBaseRefBeforeStart).toBe(true);

		// Saving with the fixed-baseline guard must leave the card value intact.
		await act(async () => {
			requireSnapshot(latestSnapshot).handleSaveEditedTask();
		});
		const savedCard = requireSnapshot(latestSnapshot)
			.board.columns.find((column) => column.id === "backlog")
			?.cards.find((card) => card.id === "task-fixed");
		expect(savedCard?.updateBaseRefBeforeStart).toBe(true);
	});
});
