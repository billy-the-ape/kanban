import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStateStreamTaskReadyForReviewMessage, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardData } from "@/types";
import { useReviewReadyNotifications } from "./use-review-ready-notifications";

function createBoard(): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

interface HookProbeProps {
	activeWorkspaceId: string | null;
	board: BoardData;
	isDocumentVisible: boolean;
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	readyForReviewNotificationsEnabled: boolean;
	selectedTaskTitle: string | null;
	workspacePath: string | null;
}

function HookProbe(props: HookProbeProps): null {
	useReviewReadyNotifications(props);
	return null;
}

interface RenderHookOptions {
	selectedTaskTitle?: string | null;
	workspacePath?: string | null;
	latestTaskReadyForReview?: RuntimeStateStreamTaskReadyForReviewMessage | null;
	readyForReviewNotificationsEnabled?: boolean;
	isDocumentVisible?: boolean;
}

describe("useReviewReadyNotifications document title", () => {
	let container: HTMLDivElement;
	let root: Root;

	const renderHook = (options: RenderHookOptions = {}): void => {
		act(() => {
			root.render(
				<HookProbe
					activeWorkspaceId="workspace-1"
					board={createBoard()}
					isDocumentVisible={options.isDocumentVisible ?? true}
					latestTaskReadyForReview={options.latestTaskReadyForReview ?? null}
					taskSessions={{}}
					readyForReviewNotificationsEnabled={options.readyForReviewNotificationsEnabled ?? false}
					selectedTaskTitle={options.selectedTaskTitle ?? null}
					workspacePath={options.workspacePath ?? null}
				/>,
			);
		});
	};

	beforeEach(() => {
		window.localStorage.clear();
		document.title = "";
		// Drop any own-property override left behind by the pending-count test.
		delete (document as { visibilityState?: string }).visibilityState;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.restoreAllMocks();
	});

	it("shows the project name when no task is selected", () => {
		renderHook({ workspacePath: "/home/user/projects/my-project" });
		expect(document.title).toBe("my-project");
	});

	it("shows the task title with the project name when a task detail is open", () => {
		renderHook({ selectedTaskTitle: "Fix login bug", workspacePath: "/home/user/projects/my-project" });
		expect(document.title).toBe("Fix login bug • my-project");
	});

	it("falls back to Kanban when no workspace path is available", () => {
		renderHook({ workspacePath: null });
		expect(document.title).toBe("Kanban");
	});

	it("shows the task title with the Kanban fallback when no workspace path is available", () => {
		renderHook({ selectedTaskTitle: "Fix login bug", workspacePath: null });
		expect(document.title).toBe("Fix login bug • Kanban");
	});

	it("clears the task title when the detail view is closed", () => {
		renderHook({ selectedTaskTitle: "Fix login bug", workspacePath: "/home/user/projects/my-project" });
		expect(document.title).toBe("Fix login bug • my-project");
		renderHook({ selectedTaskTitle: null, workspacePath: "/home/user/projects/my-project" });
		expect(document.title).toBe("my-project");
	});

	it("prefixes pending review-ready counts onto the task and project title", () => {
		// Keep the app inactive so the ready event increments the pending count.
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
		renderHook({
			selectedTaskTitle: "Fix login bug",
			workspacePath: "/home/user/projects/my-project",
			readyForReviewNotificationsEnabled: true,
		});
		renderHook({
			selectedTaskTitle: "Fix login bug",
			workspacePath: "/home/user/projects/my-project",
			latestTaskReadyForReview: {
				type: "task_ready_for_review",
				workspaceId: "workspace-1",
				taskId: "task-1",
				triggeredAt: 123,
			},
			readyForReviewNotificationsEnabled: true,
		});
		expect(document.title).toBe("(1) Fix login bug • my-project");
	});
});
