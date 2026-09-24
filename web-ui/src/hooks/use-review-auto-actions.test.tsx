import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import { resetWorkspaceMetadataStore, setTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { BoardColumnId, BoardData, ReviewTaskWorkspaceSnapshot } from "@/types";

function createBoard(autoReviewEnabled: boolean): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Test task",
						prompt: "Test task",
						startInPlanMode: false,
						autoReviewEnabled,
						autoReviewMode: "commit",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

const workspaceSnapshots: Record<string, ReviewTaskWorkspaceSnapshot> = {
	"task-1": {
		taskId: "task-1",
		path: "/tmp/task-1",
		branch: "task-1",
		isDetached: false,
		headCommit: "abc123",
		changedFiles: 3,
		additions: 10,
		deletions: 2,
	},
};

function HookHarness({
	board,
	runAutoReviewGitAction,
	requestCompleteTask,
	completeOnGitActionSuccess,
}: {
	board: BoardData;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
	requestCompleteTask: (taskId: string, fromColumnId: BoardColumnId) => Promise<void>;
	completeOnGitActionSuccess?: boolean;
}): null {
	setTaskWorkspaceSnapshot(workspaceSnapshots["task-1"] ?? null);
	useReviewAutoActions({
		board,
		taskGitActionLoadingByTaskId: {},
		runAutoReviewGitAction,
		requestCompleteTask,
		completeOnGitActionSuccess,
	});
	return null;
}

describe("useReviewAutoActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
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
		resetWorkspaceMetadataStore();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.useRealTimers();
	});

	it("cancels a scheduled auto review action when autoReviewEnabled is turned off", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestCompleteTask = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestCompleteTask={requestCompleteTask}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(false)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestCompleteTask={requestCompleteTask}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestCompleteTask).not.toHaveBeenCalled();
	});

	it("completes on a successful deterministic delivery even while the worktree still shows changes", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestCompleteTask = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestCompleteTask={requestCompleteTask}
					completeOnGitActionSuccess
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).toHaveBeenCalledWith("task-1", "commit");
		// B-5.1: the delivery receipt, not a clean tree (changedFiles is still 3), is the evidence.
		expect(requestCompleteTask).toHaveBeenCalledWith("task-1", "review", { skipWorkingChangeWarning: true });
	});

	it("does not complete when deterministic delivery did not succeed", async () => {
		const runAutoReviewGitAction = vi.fn(async () => false);
		const requestCompleteTask = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestCompleteTask={requestCompleteTask}
					completeOnGitActionSuccess
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).toHaveBeenCalled();
		expect(requestCompleteTask).not.toHaveBeenCalled();
	});
});
