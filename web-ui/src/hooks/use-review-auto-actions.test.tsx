import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import type { RuntimeTaskPullRequest } from "@/runtime/types";
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

function linkedPr(overrides?: Partial<RuntimeTaskPullRequest>): RuntimeTaskPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "owner/repo",
		number: 12,
		url: "https://github.com/owner/repo/pull/12",
		source: "manual",
		createdAt: 1,
		...overrides,
	};
}

function createBoardWithPrMode(pullRequests?: RuntimeTaskPullRequest[]): BoardData {
	const board = createBoard(true);
	const reviewColumn = board.columns.find((column) => column.id === "review");
	const task = reviewColumn?.cards[0];
	if (!reviewColumn || !task) {
		throw new Error("Missing test card or column");
	}
	task.autoReviewMode = "pr";
	task.pullRequests = pullRequests;
	return board;
}

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
		window.localStorage.clear();
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
		window.localStorage.clear();
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

	it("does not resend an accepted prompt after the hook remounts with a dirty worktree", async () => {
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
			vi.advanceTimersByTime(1000);
		});
		expect(runAutoReviewGitAction).toHaveBeenCalledTimes(1);

		await act(async () => {
			root.render(null);
		});
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
			vi.advanceTimersByTime(1000);
		});
		expect(runAutoReviewGitAction).toHaveBeenCalledTimes(1);
	});

	it("does not resend Auto-PR after the accepted instruction moves through In Progress", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestCompleteTask = vi.fn(async () => {});
		const reviewBoard = createBoard(true);
		const reviewColumn = reviewBoard.columns.find((column) => column.id === "review");
		const inProgressColumn = reviewBoard.columns.find((column) => column.id === "in_progress");
		const task = reviewColumn?.cards[0];
		if (!reviewColumn || !inProgressColumn || !task) {
			throw new Error("Missing test card or column");
		}
		task.autoReviewMode = "pr";

		await act(async () => {
			root.render(
				<HookHarness
					board={reviewBoard}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestCompleteTask={requestCompleteTask}
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(runAutoReviewGitAction).toHaveBeenCalledTimes(1);

		const runningBoard = createBoard(true);
		const runningReview = runningBoard.columns.find((column) => column.id === "review");
		const runningColumn = runningBoard.columns.find((column) => column.id === "in_progress");
		const runningTask = runningReview?.cards.shift();
		if (!runningColumn || !runningTask) {
			throw new Error("Missing test card or column");
		}
		runningTask.autoReviewMode = "pr";
		runningColumn.cards.push(runningTask);
		await act(async () => {
			root.render(
				<HookHarness
					board={runningBoard}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestCompleteTask={requestCompleteTask}
				/>,
			);
		});
		await act(async () => {
			root.render(null);
		});
		await act(async () => {
			root.render(
				<HookHarness
					board={reviewBoard}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestCompleteTask={requestCompleteTask}
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(runAutoReviewGitAction).toHaveBeenCalledTimes(1);
	});

	it("does not re-arm a sent prompt after a transient clean snapshot", async () => {
		const snapshot = workspaceSnapshots["task-1"];
		if (!snapshot) {
			throw new Error("Missing task workspace snapshot");
		}
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
			vi.advanceTimersByTime(1000);
		});
		expect(runAutoReviewGitAction).toHaveBeenCalledTimes(1);

		await act(async () => {
			setTaskWorkspaceSnapshot({ ...snapshot, changedFiles: 0 });
			setTaskWorkspaceSnapshot(snapshot);
		});
		await act(async () => {
			root.render(null);
		});
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
			vi.advanceTimersByTime(1000);
		});
		expect(runAutoReviewGitAction).toHaveBeenCalledTimes(1);
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

	it("does not schedule or send an Auto-PR when the task already has a linked PR", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestCompleteTask = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoardWithPrMode([
						linkedPr({ provider: "gitlab", host: "gitlab.example.com", source: "manual" }),
					])}
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

	it("cancels a pending Auto-PR when a linked PR is added while the timer is pending", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestCompleteTask = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoardWithPrMode()}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestCompleteTask={requestCompleteTask}
				/>,
			);
		});
		// The 500 ms Auto-PR timer is pending but has not fired yet.
		await act(async () => {
			vi.advanceTimersByTime(200);
		});
		expect(runAutoReviewGitAction).not.toHaveBeenCalled();

		// A board update links a PR to the task; the pending timer must be
		// cleared and the prompt must not be sent.
		await act(async () => {
			root.render(
				<HookHarness
					board={createBoardWithPrMode([linkedPr()])}
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

	it("honors a linked PR that appears in the latest card state before dispatch", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestCompleteTask = vi.fn(async () => {});
		const board = createBoardWithPrMode();
		const reviewColumn = board.columns.find((column) => column.id === "review");
		const task = reviewColumn?.cards[0];
		if (!reviewColumn || !task) {
			throw new Error("Missing test card or column");
		}

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestCompleteTask={requestCompleteTask}
				/>,
			);
		});

		// The board prop reference stays the same, so the dispatch callback is
		// the only place that observes the link appearing in the latest state.
		task.pullRequests = [linkedPr()];

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestCompleteTask).not.toHaveBeenCalled();
	});

	it("keeps Auto-commit eligible when a PR is linked", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestCompleteTask = vi.fn(async () => {});
		const board = createBoard(true);
		const reviewColumn = board.columns.find((column) => column.id === "review");
		const task = reviewColumn?.cards[0];
		if (!reviewColumn || !task) {
			throw new Error("Missing test card or column");
		}
		task.pullRequests = [linkedPr()];

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestCompleteTask={requestCompleteTask}
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).toHaveBeenCalledWith("task-1", "commit");
	});

	it("still sends Auto-PR when no PR is linked", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestCompleteTask = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoardWithPrMode()}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestCompleteTask={requestCompleteTask}
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).toHaveBeenCalledTimes(1);
		expect(runAutoReviewGitAction).toHaveBeenCalledWith("task-1", "pr");
	});
});
