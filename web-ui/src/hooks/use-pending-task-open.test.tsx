import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { showAppToast } from "@/components/app-toaster";
import type { RuntimeProjectSummary } from "@/runtime/types";
import type { BoardData } from "@/types";
import {
	PENDING_TASK_OPEN_PROJECT_UNAVAILABLE_MESSAGE,
	PENDING_TASK_OPEN_TASK_UNAVAILABLE_MESSAGE,
	type UsePendingTaskOpenInput,
	usePendingTaskOpen,
} from "./use-pending-task-open";

vi.mock("@/components/app-toaster", () => ({
	showAppToast: vi.fn(),
}));

function createProject(id: string): RuntimeProjectSummary {
	return {
		id,
		name: id,
		path: `/repos/${id}`,
		taskCounts: { backlog: 0, in_progress: 0, paused: 0, review: 0, done: 0, trash: 0 },
	};
}

function createBoard(taskIds: string[]): BoardData {
	return {
		columns: [
			{
				id: "in_progress",
				title: "In Progress",
				cards: taskIds.map((taskId) => ({
					id: taskId,
					title: `Task ${taskId}`,
					prompt: "prompt",
					startInPlanMode: false,
					baseRef: "main",
					createdAt: 1,
					updatedAt: 100,
				})),
			},
		],
		dependencies: [],
	};
}

const hookResultRef: { current: ReturnType<typeof usePendingTaskOpen> | null } = { current: null };

function HookHarness(props: UsePendingTaskOpenInput): null {
	hookResultRef.current = usePendingTaskOpen(props);
	return null;
}

function createBaseInput(overrides: Partial<UsePendingTaskOpenInput> = {}): UsePendingTaskOpenInput {
	return {
		currentProjectId: "a",
		requestedProjectId: "a",
		projects: [createProject("a"), createProject("b")],
		hasReceivedSnapshot: true,
		board: createBoard(["t-a"]),
		canPersistWorkspaceState: true,
		isInitialRuntimeLoad: false,
		isProjectSwitching: false,
		isAwaitingWorkspaceSnapshot: false,
		isWorkspaceMetadataPending: false,
		streamError: null,
		handleSelectProject: vi.fn(),
		setSelectedTaskId: vi.fn(),
		...overrides,
	};
}

describe("usePendingTaskOpen", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		hookResultRef.current = null;
		vi.clearAllMocks();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("opens a same-project task immediately when the project is hydrated", async () => {
		const input = createBaseInput();
		await act(async () => {
			root.render(<HookHarness {...input} />);
		});
		await act(async () => {
			hookResultRef.current?.openTask("a", "t-a");
		});
		expect(input.setSelectedTaskId).toHaveBeenCalledWith("t-a");
		expect(input.handleSelectProject).not.toHaveBeenCalled();
	});

	it("waits for hydration before opening a same-project task", async () => {
		const input = createBaseInput({ isAwaitingWorkspaceSnapshot: true });
		await act(async () => {
			root.render(<HookHarness {...input} />);
		});
		await act(async () => {
			hookResultRef.current?.openTask("a", "t-a");
		});
		expect(input.setSelectedTaskId).not.toHaveBeenCalled();
		expect(input.handleSelectProject).not.toHaveBeenCalled();
		await act(async () => {
			root.render(<HookHarness {...input} isAwaitingWorkspaceSnapshot={false} />);
		});
		expect(input.setSelectedTaskId).toHaveBeenCalledWith("t-a");
	});

	it("starts the project switch and opens the task once the target project settles", async () => {
		const input = createBaseInput();
		await act(async () => {
			root.render(<HookHarness {...input} />);
		});
		await act(async () => {
			hookResultRef.current?.openTask("b", "t-b");
		});
		expect(input.handleSelectProject).toHaveBeenCalledWith("b");
		expect(input.setSelectedTaskId).not.toHaveBeenCalled();
		await act(async () => {
			root.render(
				<HookHarness {...input} currentProjectId="b" requestedProjectId="b" board={createBoard(["t-b"])} />,
			);
		});
		expect(input.setSelectedTaskId).toHaveBeenCalledWith("t-b");
	});

	it("is cancelled by a new stream error that appears after the pending switch", async () => {
		const input = createBaseInput();
		await act(async () => {
			root.render(<HookHarness {...input} />);
		});
		await act(async () => {
			hookResultRef.current?.openTask("b", "t-b");
		});
		await act(async () => {
			root.render(<HookHarness {...input} streamError="stream failed" />);
		});
		// Even once the target project is ready, the pending selection is gone.
		await act(async () => {
			root.render(
				<HookHarness
					{...input}
					currentProjectId="b"
					requestedProjectId="b"
					streamError="stream failed"
					board={createBoard(["t-b"])}
				/>,
			);
		});
		expect(input.setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("is not cancelled by a pre-existing stream error from the source project", async () => {
		const input = createBaseInput({ streamError: "old error" });
		await act(async () => {
			root.render(<HookHarness {...input} />);
		});
		await act(async () => {
			hookResultRef.current?.openTask("b", "t-b");
		});
		await act(async () => {
			root.render(
				<HookHarness {...input} currentProjectId="b" requestedProjectId="b" board={createBoard(["t-b"])} />,
			);
		});
		expect(input.setSelectedTaskId).toHaveBeenCalledWith("t-b");
	});

	it("cancels and warns when the pending project disappears from the known list", async () => {
		const input = createBaseInput();
		await act(async () => {
			root.render(<HookHarness {...input} />);
		});
		await act(async () => {
			hookResultRef.current?.openTask("b", "t-b");
		});
		await act(async () => {
			root.render(<HookHarness {...input} projects={[createProject("a")]} />);
		});
		expect(showAppToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: PENDING_TASK_OPEN_PROJECT_UNAVAILABLE_MESSAGE }),
		);
		await act(async () => {
			root.render(
				<HookHarness
					{...input}
					projects={[createProject("a")]}
					currentProjectId="b"
					requestedProjectId="b"
					board={createBoard(["t-b"])}
				/>,
			);
		});
		expect(input.setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("warns when the pending task is missing from the target board at settle time", async () => {
		const input = createBaseInput();
		await act(async () => {
			root.render(<HookHarness {...input} />);
		});
		await act(async () => {
			hookResultRef.current?.openTask("b", "t-b");
		});
		await act(async () => {
			root.render(<HookHarness {...input} currentProjectId="b" requestedProjectId="b" board={createBoard([])} />);
		});
		expect(showAppToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: PENDING_TASK_OPEN_TASK_UNAVAILABLE_MESSAGE }),
		);
		expect(input.setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("warns immediately when clicking a task in a project that is no longer available", async () => {
		const input = createBaseInput({ projects: [createProject("a")] });
		await act(async () => {
			root.render(<HookHarness {...input} />);
		});
		await act(async () => {
			hookResultRef.current?.openTask("gone", "t-gone");
		});
		expect(showAppToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: PENDING_TASK_OPEN_PROJECT_UNAVAILABLE_MESSAGE }),
		);
		expect(input.handleSelectProject).not.toHaveBeenCalled();
		expect(input.setSelectedTaskId).not.toHaveBeenCalled();
	});
});
