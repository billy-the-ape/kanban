import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeProjectTaskListItem } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { SidebarTasksPanel } from "./sidebar-tasks-panel";

function createItem(overrides: Partial<RuntimeProjectTaskListItem> = {}): RuntimeProjectTaskListItem {
	return {
		projectId: "a",
		projectName: "A",
		taskId: "t1",
		title: "Task 1",
		displayState: "in_progress",
		lastActivityAt: 1000,
		...overrides,
	};
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes(text),
	);
	if (!button) {
		throw new Error(`No button containing "${text}"`);
	}
	return button as HTMLButtonElement;
}

describe("SidebarTasksPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	const onRetry = vi.fn();
	const onSelectTask = vi.fn();

	beforeEach(() => {
		window.localStorage.clear();
		vi.clearAllMocks();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		window.localStorage.clear();
	});

	function renderPanel(props: Partial<Parameters<typeof SidebarTasksPanel>[0]> = {}): void {
		act(() => {
			root.render(
				<SidebarTasksPanel
					tasks={null}
					isLoading={false}
					error={null}
					unavailableProjectIds={[]}
					isVisible={true}
					onRetry={onRetry}
					onSelectTask={onSelectTask}
					{...props}
				/>,
			);
		});
	}

	it("shows only In progress rows by default and renders per-state chip counts", () => {
		renderPanel({
			tasks: [
				createItem({ taskId: "ip1" }),
				createItem({ taskId: "ip2", title: "Task 2" }),
				createItem({ taskId: "d1", title: "Done task", displayState: "done" }),
			],
		});
		expect(container.textContent).toContain("In Progress · 2");
		expect(container.textContent).toContain("Done · 1");
		buttonByText(container, "Task 1");
		buttonByText(container, "Task 2");
		expect(container.textContent).not.toContain("Done task");
	});

	it("toggles a state chip and shows its rows", () => {
		renderPanel({ tasks: [createItem({ taskId: "p1", title: "Paused task", displayState: "paused" })] });
		expect(container.textContent).not.toContain("Paused task");
		act(() => {
			buttonByText(container, "Paused · 1").click();
		});
		expect(container.textContent).toContain("Paused task");
	});

	it("shows three skeleton rows while loading for the first time", () => {
		renderPanel({ tasks: null, isLoading: true });
		expect(container.querySelectorAll(".kb-skeleton")).toHaveLength(12);
	});

	it("shows the first-load failure with a Retry button", () => {
		renderPanel({ tasks: null, error: "Couldn't load tasks." });
		expect(container.textContent).toContain("Couldn't load tasks.");
		act(() => {
			buttonByText(container, "Retry").click();
		});
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("keeps cached rows visible on a failed refetch", () => {
		renderPanel({ tasks: [createItem()], error: "Couldn't refresh tasks. Showing the last loaded tasks." });
		expect(container.textContent).toContain("Couldn't refresh tasks. Showing the last loaded tasks.");
		buttonByText(container, "Task 1");
	});

	it("shows the partial failure message with Retry", () => {
		renderPanel({ tasks: [createItem()], unavailableProjectIds: ["b"] });
		expect(container.textContent).toContain("Some projects couldn't be loaded.");
		act(() => {
			buttonByText(container, "Retry").click();
		});
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("shows the no-filter message when every state is turned off", () => {
		window.localStorage.setItem(LocalStorageKey.SidebarTasksFilter, "[]");
		renderPanel({ tasks: [createItem()] });
		expect(container.textContent).toContain("Select a state to show tasks.");
		expect(container.textContent).not.toContain("Task 1");
	});

	it("shows the no-match message when the selected state has no rows", () => {
		renderPanel({ tasks: [createItem({ displayState: "done", title: "Done task" })] });
		expect(container.textContent).toContain("No matching tasks.");
	});

	it("passes the clicked item to onSelectTask", () => {
		const item = createItem({ title: "Clickable task" });
		renderPanel({ tasks: [item] });
		act(() => {
			buttonByText(container, "Clickable task").click();
		});
		expect(onSelectTask).toHaveBeenCalledWith(item);
	});

	it("renders distinct rows for duplicate task ids across projects", () => {
		const fromA = createItem({ projectId: "a", taskId: "same", title: "From A" });
		const fromB = createItem({ projectId: "b", projectName: "B", taskId: "same", title: "From B" });
		renderPanel({ tasks: [fromA, fromB] });
		act(() => {
			buttonByText(container, "From A").click();
			buttonByText(container, "From B").click();
		});
		expect(onSelectTask).toHaveBeenNthCalledWith(1, fromA);
		expect(onSelectTask).toHaveBeenNthCalledWith(2, fromB);
	});

	it("refreshes ages once a minute while visible and freezes them while hidden", async () => {
		vi.useFakeTimers();
		try {
			const mountedAt = Date.now();
			renderPanel({ tasks: [createItem({ lastActivityAt: mountedAt - 2 * 60_000 })] });
			expect(container.textContent).toContain("2m ago");
			await act(async () => {
				await vi.advanceTimersByTimeAsync(60_000);
			});
			expect(container.textContent).toContain("3m ago");
			act(() => {
				root.render(
					<SidebarTasksPanel
						tasks={[createItem({ lastActivityAt: mountedAt - 2 * 60_000 })]}
						isLoading={false}
						error={null}
						unavailableProjectIds={[]}
						isVisible={false}
						onRetry={onRetry}
						onSelectTask={onSelectTask}
					/>,
				);
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(60_000);
			});
			expect(container.textContent).toContain("3m ago");
			expect(container.textContent).not.toContain("4m ago");
		} finally {
			vi.useRealTimers();
		}
	});
});
