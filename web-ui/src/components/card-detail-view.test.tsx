import { act, forwardRef, type ReactNode, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CardDetailView } from "@/components/card-detail-view";
import { TaskPrTrackingPanel } from "@/components/detail-panels/task-pr-tracking-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
	RuntimePrInstalledConsumer,
	RuntimeTaskPullRequest,
	RuntimeTaskSessionSummary,
	RuntimeTaskTrackingStateResponse,
} from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import type { BoardCard, BoardColumn, CardSelection } from "@/types";

const trpcClientMocks = vi.hoisted(() => ({
	addTaskPullRequest: vi.fn(),
	removeTaskPullRequest: vi.fn(),
	setPrimaryTaskPullRequest: vi.fn(),
	refreshTaskPullRequests: vi.fn(),
	refreshTaskPullRequestEntry: vi.fn(),
	refreshLinkedTaskPullRequests: vi.fn(),
	getTaskTrackingState: vi.fn(),
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			addTaskPullRequest: { mutate: trpcClientMocks.addTaskPullRequest },
			removeTaskPullRequest: { mutate: trpcClientMocks.removeTaskPullRequest },
			setPrimaryTaskPullRequest: { mutate: trpcClientMocks.setPrimaryTaskPullRequest },
			refreshTaskPullRequests: { mutate: trpcClientMocks.refreshTaskPullRequests },
			refreshTaskPullRequestEntry: { mutate: trpcClientMocks.refreshTaskPullRequestEntry },
			refreshLinkedTaskPullRequests: { mutate: trpcClientMocks.refreshLinkedTaskPullRequests },
			prTracking: {
				getTaskTrackingState: { query: trpcClientMocks.getTaskTrackingState },
			},
		},
	}),
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: vi.fn(),
	notifyError: vi.fn(),
}));

const mockUseRuntimeWorkspaceChanges = vi.fn();
const {
	mockAgentTerminalPanel,
	mockClineAgentChatPanel,
	mockDiffViewerPanel,
	mockFileTreePanel,
	mockClineAppendToDraft,
	mockClineSendText,
} = vi.hoisted(() => ({
	mockAgentTerminalPanel: vi.fn((_props: { panelBackgroundColor?: string; terminalBackgroundColor?: string }) => null),
	mockClineAgentChatPanel: vi.fn((..._args: unknown[]) => null),
	mockDiffViewerPanel: vi.fn((..._args: unknown[]) => null),
	mockFileTreePanel: vi.fn((..._args: unknown[]) => null),
	mockClineAppendToDraft: vi.fn(),
	mockClineSendText: vi.fn(async () => {}),
}));

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: () => {},
}));

// PRLINK-7: mutable so mobile-specific tests can enable the mobile breakpoint.
const mockIsMobile = vi.hoisted(() => ({ value: false }));

vi.mock("@/hooks/use-is-mobile", () => ({
	useIsMobile: () => mockIsMobile.value,
}));

vi.mock("@/components/detail-panels/agent-terminal-panel", () => ({
	AgentTerminalPanel: mockAgentTerminalPanel,
}));

vi.mock("@/components/detail-panels/cline-agent-chat-panel", () => ({
	ClineAgentChatPanel: forwardRef((props: unknown, ref) => {
		mockClineAgentChatPanel(props);
		useImperativeHandle(ref, () => ({
			appendToDraft: mockClineAppendToDraft,
			sendText: mockClineSendText,
		}));
		return <div data-testid="cline-agent-chat-panel" />;
	}),
}));

vi.mock("@/components/detail-panels/column-context-panel", () => ({
	ColumnContextPanel: () => <div data-testid="column-context-panel" />,
}));

vi.mock("@/components/detail-panels/diff-viewer-panel", () => ({
	DiffViewerPanel: (props: unknown) => {
		mockDiffViewerPanel(props);
		return <div data-testid="diff-viewer-panel" />;
	},
}));

vi.mock("@/components/detail-panels/file-tree-panel", () => ({
	FileTreePanel: (props: unknown) => {
		mockFileTreePanel(props);
		return <div data-testid="file-tree-panel" />;
	},
}));

vi.mock("@/resize/resizable-bottom-pane", () => ({
	ResizableBottomPane: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/runtime/use-runtime-workspace-changes", () => ({
	useRuntimeWorkspaceChanges: (...args: unknown[]) => mockUseRuntimeWorkspaceChanges(...args),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceStateVersionValue: () => 0,
}));

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutResetEffect: () => {},
}));

function createCard(id: string): BoardCard {
	return {
		id,
		title: `Task ${id}`,
		prompt: `Task ${id}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createTaskPullRequest(number: number, isPrimary = false): RuntimeTaskPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "cline/kanban",
		number,
		url: `https://github.com/cline/kanban/pull/${number}`,
		source: "manual",
		createdAt: 1,
		isPrimary,
	};
}

function createSelection(): CardSelection {
	const card = createCard("task-1");
	const columns: BoardColumn[] = [
		{
			id: "backlog",
			title: "Backlog",
			cards: [card],
		},
		{
			id: "in_progress",
			title: "In Progress",
			cards: [],
		},
		{
			id: "review",
			title: "Review",
			cards: [],
		},
		{
			id: "trash",
			title: "Done",
			cards: [],
		},
	];
	return {
		card,
		column: columns[0]!,
		allColumns: columns,
	};
}

type MockedDiffViewerProps = {
	onAddToTerminal?: (formatted: string) => void;
	onSendToTerminal?: (formatted: string) => void;
};

function getLastMockFirstArg<T>(mockFn: { mock: { calls: unknown[][] } }): T {
	const lastCall = mockFn.mock.calls.at(-1);
	expect(lastCall).toBeDefined();
	return lastCall?.[0] as T;
}

function requireResizeSeparator(container: HTMLElement): HTMLElement {
	const separator = container.querySelector('[aria-label="Resize agent and diff panels"]');
	if (!(separator instanceof HTMLElement)) {
		throw new Error("Expected a resize separator.");
	}
	return separator;
}

function requireAgentPanel(container: HTMLElement): HTMLElement {
	const separator = requireResizeSeparator(container);
	const panel = separator.previousElementSibling;
	if (!(panel instanceof HTMLElement)) {
		throw new Error("Expected an agent panel element.");
	}
	return panel;
}

function requireDetailDiffSeparator(container: HTMLElement): HTMLElement {
	const separator = container.querySelector('[aria-label="Resize detail diff panels"]');
	if (!(separator instanceof HTMLElement)) {
		throw new Error("Expected a detail diff resize separator.");
	}
	return separator;
}

function requireDetailDiffFileTreePanel(container: HTMLElement): HTMLElement {
	const separator = requireDetailDiffSeparator(container);
	const panel = separator.nextElementSibling;
	if (!(panel instanceof HTMLElement)) {
		throw new Error("Expected a detail diff file tree panel element.");
	}
	return panel;
}

describe("CardDetailView", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		window.localStorage.clear();
		mockIsMobile.value = false;
		trpcClientMocks.addTaskPullRequest.mockReset();
		trpcClientMocks.removeTaskPullRequest.mockReset();
		trpcClientMocks.setPrimaryTaskPullRequest.mockReset();
		trpcClientMocks.refreshTaskPullRequests.mockReset();
		trpcClientMocks.refreshTaskPullRequestEntry.mockReset();
		trpcClientMocks.refreshLinkedTaskPullRequests.mockReset();
		trpcClientMocks.getTaskTrackingState.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockAgentTerminalPanel.mockClear();
		mockClineAgentChatPanel.mockClear();
		mockDiffViewerPanel.mockClear();
		mockFileTreePanel.mockClear();
		mockClineAppendToDraft.mockClear();
		mockClineSendText.mockClear();
		mockUseRuntimeWorkspaceChanges.mockReturnValue({
			changes: {
				files: [
					{
						path: "src/example.ts",
						status: "modified",
						additions: 1,
						deletions: 0,
						oldText: "before\n",
						newText: "after\n",
					},
				],
			},
			isRuntimeAvailable: true,
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		mockUseRuntimeWorkspaceChanges.mockReset();
		mockAgentTerminalPanel.mockClear();
		mockClineAgentChatPanel.mockClear();
		mockDiffViewerPanel.mockClear();
		mockFileTreePanel.mockClear();
		mockClineAppendToDraft.mockClear();
		mockClineSendText.mockClear();
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it.each(["running", "idle", "interrupted"] as const)(
		"shows completion for stopped in-progress cards (%s)",
		async (state) => {
			const selection = createSelection();
			selection.column = { ...selection.column, id: "in_progress" };
			const summary: RuntimeTaskSessionSummary = {
				taskId: selection.card.id,
				state,
				agentId: "cline",
				pid: null,
				workspacePath: "/tmp/task",
				startedAt: 1,
				updatedAt: 2,
				lastOutputAt: 2,
				reviewReason: null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
			};
			await act(async () => {
				root.render(
					<CardDetailView
						selection={selection}
						currentProjectId="workspace-1"
						sessionSummary={summary}
						taskSessions={{ [summary.taskId]: summary }}
						onSessionSummary={() => {}}
						onCardSelect={() => {}}
						onTaskDragEnd={() => {}}
						onMoveToTrash={() => {}}
						onComplete={() => {}}
						bottomTerminalOpen={false}
						bottomTerminalTaskId={null}
						bottomTerminalSummary={null}
						onBottomTerminalClose={() => {}}
					/>,
				);
			});
			expect(getLastMockFirstArg<{ showComplete: boolean }>(mockClineAgentChatPanel).showComplete).toBe(
				state !== "running",
			);
		},
	);

	it("collapses the expanded diff on Escape without closing the detail view", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const expandButton = container.querySelector('button[aria-label="Expand split diff view"]');
		expect(expandButton).toBeInstanceOf(HTMLButtonElement);
		if (!(expandButton instanceof HTMLButtonElement)) {
			throw new Error("Expected an expand diff button.");
		}

		await act(async () => {
			expandButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			expandButton.click();
		});

		const toolbarButtons = Array.from(container.querySelectorAll("button"));
		const collapseButton = toolbarButtons.find(
			(button) => button.getAttribute("aria-label") === "Collapse expanded diff view",
		);
		expect(collapseButton).toBeDefined();
		expect(toolbarButtons.some((button) => button.textContent?.trim() === "All Changes")).toBe(true);
		expect(toolbarButtons.some((button) => button.textContent?.trim() === "Last Turn")).toBe(true);
		expect(container.querySelector('button[aria-label="Expand split diff view"]')).toBeNull();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(container.querySelector('button[aria-label="Collapse expanded diff view"]')).toBeNull();
		expect(container.querySelector('button[aria-label="Expand split diff view"]')).toBeInstanceOf(HTMLButtonElement);
	});

	it("clears stale diff content when switching from all changes to last turn", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const lastTurnButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Last Turn",
		);
		expect(lastTurnButton).toBeInstanceOf(HTMLButtonElement);
		if (!(lastTurnButton instanceof HTMLButtonElement)) {
			throw new Error("Expected a Last Turn button.");
		}

		await act(async () => {
			lastTurnButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			lastTurnButton.click();
		});

		const lastCall = mockUseRuntimeWorkspaceChanges.mock.calls.at(-1);
		expect(lastCall?.[3]).toBe("last_turn");
		expect(lastCall?.[7]).toBe(true);
	});

	it("keeps the active diff mode visually highlighted", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const getDiffModeButton = (label: string): HTMLButtonElement => {
			const button = Array.from(container.querySelectorAll("button")).find(
				(candidate) => candidate.textContent?.trim() === label,
			);
			if (!(button instanceof HTMLButtonElement)) {
				throw new Error(`Expected a ${label} button.`);
			}
			return button;
		};

		const allChangesButton = getDiffModeButton("All Changes");
		const lastTurnButton = getDiffModeButton("Last Turn");

		expect(allChangesButton.getAttribute("aria-pressed")).toBe("true");
		expect(allChangesButton.getAttribute("style")).toContain(
			"background-color: color-mix(in srgb, var(--color-surface-3) 80%, var(--color-text-primary))",
		);
		expect(lastTurnButton.getAttribute("aria-pressed")).toBe("false");
		expect(lastTurnButton.style.backgroundColor).toBe("");

		await act(async () => {
			lastTurnButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			lastTurnButton.click();
		});

		expect(getDiffModeButton("All Changes").getAttribute("aria-pressed")).toBe("false");
		expect(getDiffModeButton("All Changes").style.backgroundColor).toBe("");
		expect(getDiffModeButton("Last Turn").getAttribute("aria-pressed")).toBe("true");
		expect(getDiffModeButton("Last Turn").getAttribute("style")).toContain(
			"background-color: color-mix(in srgb, var(--color-surface-3) 80%, var(--color-text-primary))",
		);
	});

	it("closes git history before handling other Escape behavior", async () => {
		const onCloseGitHistory = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					gitHistoryPanel={<div data-testid="git-history-panel">Git history</div>}
					onCloseGitHistory={onCloseGitHistory}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const input = document.createElement("input");
		container.appendChild(input);
		input.focus();

		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(onCloseGitHistory).toHaveBeenCalledTimes(1);
	});

	it("renders native chat panel for cline agent", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="cline-agent-chat-panel"]')).toBeInstanceOf(HTMLDivElement);
		expect(container.querySelector('[data-testid="agent-terminal-panel"]')).toBeNull();
	});

	it("does not render native chat panel when the task explicitly uses a non-cline agent", async () => {
		const selection = createSelection();
		selection.card.agentId = "codex";

		await act(async () => {
			root.render(
				<CardDetailView
					selection={selection}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="cline-agent-chat-panel"]')).toBeNull();
	});

	it("shows cline chat panel when task session agentId is cline even if global agent is claude", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="claude"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "cline",
						workspacePath: null,
						pid: null,
						startedAt: null,
						updatedAt: Date.now(),
						lastOutputAt: null,
						reviewReason: null,
						exitCode: null,
						lastHookAt: null,
						latestHookActivity: null,
						warningMessage: null,
					}}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="cline-agent-chat-panel"]')).toBeInstanceOf(HTMLDivElement);
	});

	it("shows terminal panel when task session agentId is claude even if global agent is cline", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "claude",
						workspacePath: null,
						pid: null,
						startedAt: null,
						updatedAt: Date.now(),
						lastOutputAt: null,
						reviewReason: null,
						exitCode: null,
						lastHookAt: null,
						latestHookActivity: null,
						warningMessage: null,
					}}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="cline-agent-chat-panel"]')).toBeNull();
		expect(mockAgentTerminalPanel).toHaveBeenCalled();
	});

	it("uses surface-primary colors for the detail terminal panel", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="claude"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const lastCall = mockAgentTerminalPanel.mock.calls.at(-1);
		expect(lastCall?.[0]).toMatchObject({
			panelBackgroundColor: "var(--color-surface-0)",
			terminalBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
		});
	});

	it("queues Add diff comments into the cline composer without sending them", async () => {
		const onAddReviewComments = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					onAddReviewComments={onAddReviewComments}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const diffProps = getLastMockFirstArg<MockedDiffViewerProps>(mockDiffViewerPanel);
		expect(diffProps.onAddToTerminal).toBeTypeOf("function");

		await act(async () => {
			diffProps.onAddToTerminal?.("src/example.ts:4 | value\n> Add tests");
		});

		expect(onAddReviewComments).not.toHaveBeenCalled();
		expect(mockClineAppendToDraft).toHaveBeenCalledWith("src/example.ts:4 | value\n> Add tests");
	});

	it("routes Send diff comments through the mounted cline panel", async () => {
		const onSendReviewComments = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					onSendReviewComments={onSendReviewComments}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const diffProps = getLastMockFirstArg<MockedDiffViewerProps>(mockDiffViewerPanel);
		expect(diffProps.onSendToTerminal).toBeTypeOf("function");

		await act(async () => {
			diffProps.onSendToTerminal?.("src/example.ts:8 | done\n> Ship this");
			await Promise.resolve();
		});

		expect(onSendReviewComments).not.toHaveBeenCalled();
		expect(mockClineSendText).toHaveBeenCalledWith("src/example.ts:8 | done\n> Ship this");
	});

	it("loads the saved agent-to-diff panel ratio from local storage", async () => {
		window.localStorage.setItem(LocalStorageKey.DetailAgentPanelRatio, "0.62");

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(requireAgentPanel(container).style.width).toBe("62%");
	});

	it("persists the resized agent-to-diff panel ratio globally", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const separator = requireResizeSeparator(container);
		const dragHandle = separator.firstElementChild;
		expect(dragHandle).toBeInstanceOf(HTMLDivElement);
		if (!(dragHandle instanceof HTMLDivElement)) {
			throw new Error("Expected a draggable resize handle.");
		}

		await act(async () => {
			dragHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 160 }));
		});
		await act(async () => {
			window.dispatchEvent(new MouseEvent("mousemove", { clientX: 320 }));
			window.dispatchEvent(new MouseEvent("mouseup", { clientX: 320 }));
		});

		const savedRatioRaw = window.localStorage.getItem(LocalStorageKey.DetailAgentPanelRatio);
		expect(savedRatioRaw).not.toBeNull();
		const savedRatio = Number(savedRatioRaw);
		expect(savedRatio).toBeGreaterThan(0.4);
		expect(savedRatio).toBeLessThanOrEqual(0.75);
		expect(requireAgentPanel(container).style.width).not.toBe("40%");
	});

	it("keeps the saved divider position after leaving and reopening task detail", async () => {
		const renderDetail = async (): Promise<void> => {
			await act(async () => {
				root.render(
					<CardDetailView
						selection={createSelection()}
						currentProjectId="workspace-1"
						sessionSummary={null}
						taskSessions={{}}
						onSessionSummary={() => {}}
						onCardSelect={() => {}}
						onTaskDragEnd={() => {}}
						onMoveToTrash={() => {}}
						bottomTerminalOpen={false}
						bottomTerminalTaskId={null}
						bottomTerminalSummary={null}
						onBottomTerminalClose={() => {}}
					/>,
				);
			});
		};

		await renderDetail();

		const separator = requireResizeSeparator(container);
		const dragHandle = separator.firstElementChild;
		expect(dragHandle).toBeInstanceOf(HTMLDivElement);
		if (!(dragHandle instanceof HTMLDivElement)) {
			throw new Error("Expected a draggable resize handle.");
		}

		await act(async () => {
			dragHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 200 }));
			window.dispatchEvent(new MouseEvent("mouseup", { clientX: 420 }));
		});

		const expectedRatio = window.localStorage.getItem(LocalStorageKey.DetailAgentPanelRatio);
		expect(expectedRatio).not.toBeNull();

		await act(async () => {
			root.unmount();
			root = createRoot(container);
		});

		await renderDetail();

		const restoredWidth = requireAgentPanel(container).style.width;
		const restoredRatio = Number.parseFloat(restoredWidth) / 100;
		expect(restoredRatio).toBeCloseTo(Number(expectedRatio), 2);
	});

	it("uses separate file-tree ratios for collapsed and expanded diff layouts", async () => {
		window.localStorage.setItem(LocalStorageKey.DetailDiffFileTreePanelRatio, "0.42");
		window.localStorage.setItem(LocalStorageKey.DetailExpandedDiffFileTreePanelRatio, "0.18");

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(requireDetailDiffFileTreePanel(container).style.flex).toBe("0 0 42%");

		const expandButton = container.querySelector('button[aria-label="Expand split diff view"]');
		expect(expandButton).toBeInstanceOf(HTMLButtonElement);
		if (!(expandButton instanceof HTMLButtonElement)) {
			throw new Error("Expected an expand diff button.");
		}

		await act(async () => {
			expandButton.click();
		});

		expect(requireDetailDiffFileTreePanel(container).style.flex).toBe("0 0 18%");
	});

	// ---- PRLINK-7: mobile PR anchor + manager in the detail tab bar ----

	function renderMobileDetail(selection: CardSelection, workspaceId: string | null = "workspace-1"): void {
		mockIsMobile.value = true;
		root.render(
			<TooltipProvider>
				<CardDetailView
					selection={selection}
					currentProjectId={workspaceId}
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					onComplete={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>
			</TooltipProvider>,
		);
	}

	async function clickElement(element: Element): Promise<void> {
		await act(async () => {
			element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	}

	it("shows a Link PR trigger on mobile when the task has no linked pull requests", async () => {
		const selection = createSelection();

		await act(async () => {
			renderMobileDetail(selection);
		});

		const linkPrButton = container.querySelector("[data-testid='mobile-task-pr-link-pr-button']");
		expect(linkPrButton).toBeInstanceOf(HTMLButtonElement);
		expect(container.querySelector("a[data-testid='mobile-task-pr-primary-anchor']")).toBeNull();
		expect(container.querySelector("[data-testid='mobile-task-pr-manage-button']")).toBeNull();

		if (!(linkPrButton instanceof Element)) {
			throw new Error("Expected a Link PR button.");
		}
		await clickElement(linkPrButton);

		expect(document.body.querySelector("[data-testid='task-pr-url-input']")).not.toBeNull();
	});

	it("renders the primary anchor and the manage button for a linked task on mobile", async () => {
		const selection = createSelection();
		selection.card.pullRequests = [createTaskPullRequest(12, true), createTaskPullRequest(99)];

		await act(async () => {
			renderMobileDetail(selection);
		});

		const anchor = container.querySelector(
			"a[data-testid='mobile-task-pr-primary-anchor']",
		) as HTMLAnchorElement | null;
		expect(anchor?.href).toBe("https://github.com/cline/kanban/pull/12");
		expect(anchor?.getAttribute("aria-label")).toContain("PR #12");
		expect(anchor?.className).toContain("min-h-11");

		const manageButton = container.querySelector("[data-testid='mobile-task-pr-manage-button']");
		expect(manageButton).toBeInstanceOf(HTMLButtonElement);

		if (!(manageButton instanceof Element)) {
			throw new Error("Expected a manage button.");
		}
		await clickElement(manageButton);

		expect(document.body.querySelector("[data-testid='task-pr-url-input']")).not.toBeNull();
		expect(document.body.querySelector("[data-testid='task-pr-row-meta-12']")).not.toBeNull();
		expect(document.body.querySelector("[data-testid='task-pr-row-meta-99']")).not.toBeNull();
		const removeButton = document.body.querySelector("[data-testid='task-pr-remove-12']") as HTMLButtonElement | null;
		expect(removeButton?.className).toContain("min-h-11");
	});

	it("keeps the active tab when the mobile PR anchor is tapped", async () => {
		const selection = createSelection();
		selection.card.pullRequests = [createTaskPullRequest(12, true)];

		await act(async () => {
			renderMobileDetail(selection);
		});

		const anchor = container.querySelector("a[data-testid='mobile-task-pr-primary-anchor']");
		expect(anchor).toBeInstanceOf(HTMLAnchorElement);
		if (!(anchor instanceof HTMLAnchorElement)) {
			throw new Error("Expected a primary anchor.");
		}

		await act(async () => {
			anchor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		const chatButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Chat",
		);
		const diffButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Diff",
		);
		expect(chatButton?.className).toContain("text-accent");
		expect(diffButton?.className).not.toContain("text-accent");
	});

	it("renders the anchor but no manage trigger on mobile when there is no workspace", async () => {
		const selection = createSelection();
		selection.card.pullRequests = [createTaskPullRequest(12, true)];

		await act(async () => {
			renderMobileDetail(selection, null);
		});

		const anchor = container.querySelector("a[data-testid='mobile-task-pr-primary-anchor']");
		expect(anchor).toBeInstanceOf(HTMLAnchorElement);
		expect(container.querySelector("[data-testid='mobile-task-pr-manage-button']")).toBeNull();
		expect(container.querySelector("[data-testid='mobile-task-pr-link-pr-button']")).toBeNull();
	});

	it("closes the PR manager and drops task A state when switching tasks on mobile", async () => {
		const selection = createSelection();
		selection.card.pullRequests = [createTaskPullRequest(12, true)];

		await act(async () => {
			renderMobileDetail(selection);
		});

		const manageButton = container.querySelector("[data-testid='mobile-task-pr-manage-button']");
		expect(manageButton).toBeInstanceOf(HTMLElement);
		if (!(manageButton instanceof Element)) {
			throw new Error("Expected a manage button.");
		}
		await clickElement(manageButton);
		expect(document.body.querySelector("[data-testid='task-pr-url-input']")).not.toBeNull();

		const nextSelection = createSelection();
		nextSelection.card = {
			...nextSelection.card,
			id: "task-2",
			pullRequests: [createTaskPullRequest(99, true)],
		};

		await act(async () => {
			renderMobileDetail(nextSelection);
		});

		expect(document.body.querySelector("[data-testid='task-pr-url-input']")).toBeNull();
		const anchor = container.querySelector(
			"a[data-testid='mobile-task-pr-primary-anchor']",
		) as HTMLAnchorElement | null;
		expect(anchor?.href).toBe("https://github.com/cline/kanban/pull/99");
	});

	it("keeps task B's manager open when task A's add response lands late", async () => {
		let resolveAdd: () => void = () => {};
		trpcClientMocks.addTaskPullRequest.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveAdd = () => resolve({ ok: true, pullRequest: null });
				}),
		);

		const selection = createSelection();
		selection.card.pullRequests = [createTaskPullRequest(12, true)];

		await act(async () => {
			renderMobileDetail(selection);
		});

		const manageButton = container.querySelector("[data-testid='mobile-task-pr-manage-button']");
		expect(manageButton).toBeInstanceOf(HTMLElement);
		if (!(manageButton instanceof Element)) {
			throw new Error("Expected a manage button.");
		}
		await clickElement(manageButton);

		// Submit an add for task A; the mutation stays pending.
		const urlInput = document.body.querySelector("[data-testid='task-pr-url-input']");
		expect(urlInput).toBeInstanceOf(HTMLInputElement);
		if (!(urlInput instanceof HTMLInputElement)) {
			throw new Error("Expected a URL input.");
		}
		await act(async () => {
			const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
			descriptor?.set?.call(urlInput, "https://github.com/cline/kanban/pull/555");
			urlInput.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const addButton = document.body.querySelector("[data-testid='task-pr-add-button']");
		expect(addButton).toBeInstanceOf(HTMLButtonElement);
		if (!(addButton instanceof Element)) {
			throw new Error("Expected an Add button.");
		}
		await clickElement(addButton);

		// Switch to task B and open its manager.
		const nextSelection = createSelection();
		nextSelection.card = {
			...nextSelection.card,
			id: "task-2",
			pullRequests: [createTaskPullRequest(99, true)],
		};
		await act(async () => {
			renderMobileDetail(nextSelection);
		});
		const manageButtonB = container.querySelector("[data-testid='mobile-task-pr-manage-button']");
		expect(manageButtonB).toBeInstanceOf(HTMLElement);
		if (!(manageButtonB instanceof Element)) {
			throw new Error("Expected a manage button for task B.");
		}
		await clickElement(manageButtonB);
		expect(document.body.querySelector("[data-testid='task-pr-url-input']")).not.toBeNull();

		// Task A's late add response arrives; task B's manager must stay open.
		await act(async () => {
			resolveAdd();
		});

		expect(document.body.querySelector("[data-testid='task-pr-url-input']")).not.toBeNull();
	});

	// ---- PRLINK-10: PRs view in the detail toolbar ----

	function renderDesktopDetail(selection: CardSelection, options: { isDocumentVisible?: boolean } = {}): void {
		root.render(
			<TooltipProvider>
				<CardDetailView
					selection={selection}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
					isDocumentVisible={options.isDocumentVisible ?? true}
				/>
			</TooltipProvider>,
		);
	}

	function findToolbarButton(label: string): HTMLButtonElement {
		const button = Array.from(container.querySelectorAll("button")).find(
			(candidate) => candidate.textContent?.trim() === label,
		);
		if (!(button instanceof HTMLButtonElement)) {
			throw new Error(`Expected a ${label} button.`);
		}
		return button;
	}

	function lastDiffHookCall(): unknown[] {
		const lastCall = mockUseRuntimeWorkspaceChanges.mock.calls.at(-1);
		expect(lastCall).toBeDefined();
		return lastCall as unknown[];
	}

	it("shows the stored PR count on the PRs toolbar segment", async () => {
		const selection = createSelection();
		selection.card.pullRequests = [createTaskPullRequest(12, true), createTaskPullRequest(99)];

		await act(async () => {
			renderDesktopDetail(selection);
		});

		const prsButton = findToolbarButton("PRs (2)");
		expect(prsButton.getAttribute("aria-pressed")).toBe("false");
		// The default view is the changes view: the file tree renders and the
		// PRs view does not.
		expect(container.querySelector('[data-testid="file-tree-panel"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="task-pr-view"]')).toBeNull();
		// A visible changes view schedules the initial read and the poll.
		const call = lastDiffHookCall();
		expect(call[3]).toBe("working_copy");
		expect(call[5]).toBe(1_000);
		expect(call[8]).toBe(true);
	});

	it("switching to the PRs view stops the diff reads without changing the diff mode", async () => {
		const selection = createSelection();
		selection.card.pullRequests = [createTaskPullRequest(12, true), createTaskPullRequest(99)];

		await act(async () => {
			renderDesktopDetail(selection);
		});

		await clickElement(findToolbarButton("PRs (2)"));

		expect(container.querySelector('[data-testid="task-pr-view"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="file-tree-panel"]')).toBeNull();
		// The remembered diff mode is untouched and no diff reads are scheduled.
		const call = lastDiffHookCall();
		expect(call[3]).toBe("working_copy");
		expect(call[5]).toBeNull();
		expect(call[8]).toBe(false);
		// The PRs segment is the active one; All Changes is no longer pressed.
		expect(findToolbarButton("All Changes").getAttribute("aria-pressed")).toBe("false");
		expect(findToolbarButton("PRs (2)").getAttribute("aria-pressed")).toBe("true");
	});

	it("returns to the remembered diff mode when leaving the PRs view", async () => {
		const selection = createSelection();
		selection.card.pullRequests = [createTaskPullRequest(12, true)];

		await act(async () => {
			renderDesktopDetail(selection);
		});

		await clickElement(findToolbarButton("PRs (1)"));
		await clickElement(findToolbarButton("Last Turn"));

		const call = lastDiffHookCall();
		expect(call[3]).toBe("last_turn");
		expect(call[8]).toBe(true);
		expect(container.querySelector('[data-testid="task-pr-view"]')).toBeNull();
		expect(findToolbarButton("PRs (1)").getAttribute("aria-pressed")).toBe("false");

		await clickElement(findToolbarButton("All Changes"));
		const backToAllChanges = lastDiffHookCall();
		expect(backToAllChanges[3]).toBe("working_copy");
	});

	it("resets the detail view to All Changes when switching tasks", async () => {
		const selection = createSelection();
		selection.card.pullRequests = [createTaskPullRequest(12, true)];

		await act(async () => {
			renderDesktopDetail(selection);
		});

		await clickElement(findToolbarButton("PRs (1)"));
		expect(container.querySelector('[data-testid="task-pr-view"]')).not.toBeNull();

		const nextSelection = createSelection();
		nextSelection.card = { ...nextSelection.card, id: "task-2" };
		await act(async () => {
			renderDesktopDetail(nextSelection);
		});

		expect(container.querySelector('[data-testid="task-pr-view"]')).toBeNull();
		expect(findToolbarButton("All Changes").getAttribute("aria-pressed")).toBe("true");
		expect(findToolbarButton("PRs (0)").getAttribute("aria-pressed")).toBe("false");
		const call = lastDiffHookCall();
		expect(call[3]).toBe("working_copy");
		expect(call[8]).toBe(true);
	});

	it("does not schedule diff reads when the document is hidden, and keeps the one-time read for trashed tasks", async () => {
		await act(async () => {
			renderDesktopDetail(createSelection(), { isDocumentVisible: false });
		});
		const hiddenCall = lastDiffHookCall();
		expect(hiddenCall[5]).toBeNull();
		expect(hiddenCall[8]).toBe(false);

		// Trashed tasks keep the one-time initial read (so the changes view
		// resolves instead of showing a pending panel forever) but never poll.
		const trashedSelection = createSelection();
		trashedSelection.column = { ...trashedSelection.column, id: "trash" };
		await act(async () => {
			renderDesktopDetail(trashedSelection);
		});
		const trashedCall = lastDiffHookCall();
		expect(trashedCall[5]).toBeNull();
		expect(trashedCall[8]).toBe(true);
	});

	it("gates the PRs view diff reads on the active mobile tab", async () => {
		const selection = createSelection();
		selection.card.pullRequests = [createTaskPullRequest(12, true)];

		await act(async () => {
			renderMobileDetail(selection);
		});
		// Chat tab: no diff reads.
		expect(lastDiffHookCall()[8]).toBe(false);

		await clickElement(findToolbarButton("Diff"));
		// Diff tab (changes view): reads resume.
		expect(lastDiffHookCall()[8]).toBe(true);

		await clickElement(findToolbarButton("PRs (1)"));
		expect(container.querySelector('[data-testid="task-pr-view"]')).not.toBeNull();
		expect(lastDiffHookCall()[8]).toBe(false);

		await clickElement(findToolbarButton("Files"));
		// The Files tab always loads the changes data (it renders the shared
		// file tree), even while the active view is still PRs.
		expect(container.querySelector('[data-testid="task-pr-view"]')).not.toBeNull();
		expect(lastDiffHookCall()[8]).toBe(true);

		// Back on the Diff tab, the PRs view is still active: no diff reads.
		await clickElement(findToolbarButton("Diff"));
		expect(lastDiffHookCall()[8]).toBe(false);
	});

	it("selecting a file on the mobile Files tab returns the Diff tab to the changes view", async () => {
		const selection = createSelection();
		selection.card.pullRequests = [createTaskPullRequest(12, true)];

		await act(async () => {
			renderMobileDetail(selection);
		});

		await clickElement(findToolbarButton("Diff"));
		await clickElement(findToolbarButton("PRs (1)"));
		await clickElement(findToolbarButton("Files"));

		const lastFileTreeProps = mockFileTreePanel.mock.calls.at(-1)?.[0] as
			| { onSelectPath?: (path: string) => void }
			| undefined;
		expect(lastFileTreeProps?.onSelectPath).toBeTypeOf("function");

		await act(async () => {
			lastFileTreeProps?.onSelectPath?.("src/example.ts");
		});

		// The Diff tab is active again and shows the changes view, not the
		// PRs view; diff reads are enabled.
		expect(container.querySelector('[data-testid="task-pr-view"]')).toBeNull();
		expect(container.querySelector('[data-testid="file-tree-panel"]')).not.toBeNull();
		const call = lastDiffHookCall();
		expect(call[3]).toBe("working_copy");
		expect(call[8]).toBe(true);
	});
});

describe("TaskPrTrackingPanel (PRs view)", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	function createTrackingState(): RuntimeTaskTrackingStateResponse {
		return {
			ok: true,
			taskId: "task-1",
			settingsRevision: 1,
			staleRevision: false,
			autoAddressComments: false,
			autoFinishOnMerge: true,
			selectedAutomationPrKey: null,
			eligible: false,
			legacyCompletionGated: false,
			mergeFinishesInReview: false,
			blockers: [],
			installedConsumers: [{ kind: "mergeCompletion", requiredReadSources: [] }],
			commentsSupportedForTask: false,
			owner: null,
			ownerLabel: null,
			ownerCandidates: [],
			reservation: { state: "none", reservedBy: null, reservedOperation: null, fencingGeneration: 0 },
			snapshot: null,
			terminalStop: null,
			error: null,
		};
	}

	function renderPanel(
		options: {
			workspaceId?: string | null;
			pullRequests?: RuntimeTaskPullRequest[];
			installedConsumers?: RuntimePrInstalledConsumer[];
			visible?: boolean;
			mobile?: boolean;
		} = {},
	): void {
		root.render(
			<TooltipProvider>
				<TaskPrTrackingPanel
					workspaceId={options.workspaceId === undefined ? "workspace-1" : options.workspaceId}
					taskId="task-1"
					card={{ ...createCard("task-1"), pullRequests: options.pullRequests ?? [] }}
					installedConsumers={options.installedConsumers ?? []}
					visible={options.visible ?? true}
					mobile={options.mobile ?? false}
				/>
			</TooltipProvider>,
		);
	}

	beforeEach(() => {
		trpcClientMocks.addTaskPullRequest.mockReset();
		trpcClientMocks.removeTaskPullRequest.mockReset();
		trpcClientMocks.setPrimaryTaskPullRequest.mockReset();
		trpcClientMocks.refreshTaskPullRequests.mockReset();
		trpcClientMocks.refreshTaskPullRequestEntry.mockReset();
		trpcClientMocks.refreshLinkedTaskPullRequests.mockReset();
		trpcClientMocks.getTaskTrackingState.mockReset();
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
	});

	it("renders the empty state, footer actions, and the disabled settings pair without consumers", async () => {
		await act(async () => {
			renderPanel({ pullRequests: [] });
		});

		expect(container.querySelector('[data-testid="task-pr-view-count"]')?.textContent).toBe(
			"Linked pull requests (0)",
		);
		expect(container.querySelector('[data-testid="task-pr-view-empty-state"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="task-pr-view-url-input"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="task-pr-view-add-button"]')).not.toBeNull();
		const refreshLinkedButton = container.querySelector(
			"[data-testid='task-pr-view-refresh-linked-button']",
		) as HTMLButtonElement | null;
		expect(refreshLinkedButton?.disabled).toBe(true);
		expect(container.querySelector('[data-testid="task-pr-view-find-branch-button"]')).not.toBeNull();

		// Zero installed consumers: the settings section degrades to the
		// disabled checkbox pair and never reads tracking state.
		expect(container.querySelector('[data-testid="task-pr-view-settings-title"]')).not.toBeNull();
		expect(document.body.textContent).toContain("Feature unavailable");
		expect(trpcClientMocks.getTaskTrackingState).not.toHaveBeenCalled();
	});

	it("renders stored links with metadata and order, without a provider round-trip", async () => {
		const primary = createTaskPullRequest(12);
		primary.isPrimary = true;
		primary.state = "open";
		primary.title = "Fix the flaky login test";
		const merged = createTaskPullRequest(99);

		await act(async () => {
			renderPanel({ pullRequests: [merged, primary] });
		});

		const rowPrimary = container.querySelector('[data-testid="task-pr-view-row-12"]');
		const rowMerged = container.querySelector('[data-testid="task-pr-view-row-99"]');
		expect(rowPrimary).not.toBeNull();
		expect(rowMerged).not.toBeNull();
		// The display primary (winner) sorts first even though it was recorded
		// second.
		expect(rowPrimary?.compareDocumentPosition(rowMerged as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

		expect(container.querySelector('[data-testid="task-pr-view-primary-label"]')).not.toBeNull();
		const anchor = container.querySelector('[data-testid="task-pr-view-open-12"]') as HTMLAnchorElement | null;
		expect(anchor?.href).toBe("https://github.com/cline/kanban/pull/12");
		expect(container.querySelector('[data-testid="task-pr-view-title-12"]')?.textContent).toBe(
			"Fix the flaky login test",
		);
		const meta = container.querySelector('[data-testid="task-pr-view-meta-12"]');
		expect(meta?.textContent).toContain("State: open");
		expect(meta?.textContent).toContain("Source: manual");
		expect(meta?.textContent).toContain("First recorded");
	});

	it("degrades to stored information without a workspace scope", async () => {
		await act(async () => {
			renderPanel({ workspaceId: null, pullRequests: [createTaskPullRequest(12)] });
		});

		expect(container.querySelector('[data-testid="task-pr-view-row-12"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="task-pr-view-open-12"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="task-pr-view-no-workspace"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="task-pr-view-url-input"]')).toBeNull();
		const refreshLinkedButton = container.querySelector(
			"[data-testid='task-pr-view-refresh-linked-button']",
		) as HTMLButtonElement | null;
		expect(refreshLinkedButton?.disabled).toBe(true);
		// No workspace: the row action buttons do not render.
		expect(container.querySelector('[data-testid="task-pr-view-make-primary-12"]')).toBeNull();
		expect(container.querySelector('[data-testid="task-pr-view-remove-12"]')).toBeNull();
	});

	it("validates the URL shape and surfaces the server error", async () => {
		await act(async () => {
			renderPanel({ pullRequests: [] });
		});

		const input = container.querySelector('[data-testid="task-pr-view-url-input"]') as HTMLInputElement;
		await act(async () => {
			const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
			descriptor?.set?.call(input, "not a url");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});

		expect(container.querySelector('[data-testid="task-pr-view-url-validation-error"]')).not.toBeNull();
		const addButton = container.querySelector("[data-testid='task-pr-view-add-button']") as HTMLButtonElement;
		expect(addButton.disabled).toBe(true);

		trpcClientMocks.addTaskPullRequest.mockResolvedValue({
			ok: false,
			error: "Duplicate link.",
			pullRequest: null,
		});
		await act(async () => {
			const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
			descriptor?.set?.call(input, "https://github.com/cline/kanban/pull/55");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			addButton.click();
		});

		expect(trpcClientMocks.addTaskPullRequest).toHaveBeenCalledWith({
			taskId: "task-1",
			url: "https://github.com/cline/kanban/pull/55",
		});
		expect(container.querySelector('[data-testid="task-pr-view-form-error"]')?.textContent).toBe("Duplicate link.");
	});

	it("adds a PR from the form and clears the input on success", async () => {
		trpcClientMocks.addTaskPullRequest.mockResolvedValue({ ok: true, pullRequest: null });

		await act(async () => {
			renderPanel({ pullRequests: [] });
		});

		const input = container.querySelector('[data-testid="task-pr-view-url-input"]') as HTMLInputElement;
		await act(async () => {
			const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
			descriptor?.set?.call(input, "https://github.com/cline/kanban/pull/66");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			(container.querySelector("[data-testid='task-pr-view-add-button']") as HTMLButtonElement).click();
		});

		expect(trpcClientMocks.addTaskPullRequest).toHaveBeenCalledWith({
			taskId: "task-1",
			url: "https://github.com/cline/kanban/pull/66",
		});
		expect((container.querySelector("[data-testid='task-pr-view-url-input']") as HTMLInputElement).value).toBe("");
	});

	it("refreshes the linked PR metadata when Refresh linked PRs is clicked", async () => {
		trpcClientMocks.refreshLinkedTaskPullRequests.mockResolvedValue({ ok: true, updated: 0, outcomes: [] });

		await act(async () => {
			renderPanel({ pullRequests: [createTaskPullRequest(12)] });
		});

		const button = container.querySelector("[data-testid='task-pr-view-refresh-linked-button']") as HTMLButtonElement;
		await act(async () => {
			button.click();
		});

		expect(trpcClientMocks.refreshLinkedTaskPullRequests).toHaveBeenCalledWith({ taskId: "task-1" });
	});

	it("runs the branch lookup when Find PRs for branch is clicked", async () => {
		trpcClientMocks.refreshTaskPullRequests.mockResolvedValue({ ok: true, updated: 0, reason: "unchanged" });

		await act(async () => {
			renderPanel({ pullRequests: [] });
		});

		const button = container.querySelector("[data-testid='task-pr-view-find-branch-button']") as HTMLButtonElement;
		await act(async () => {
			button.click();
		});

		expect(trpcClientMocks.refreshTaskPullRequests).toHaveBeenCalledWith({ taskId: "task-1" });
	});

	it("disables the row refresh for unsupported provider hosts with a visible reason", async () => {
		const supported = createTaskPullRequest(12);
		const unsupported = createTaskPullRequest(34);
		unsupported.host = "ghe.example.com";
		unsupported.url = "https://ghe.example.com/acme/widgets/pull/34";

		await act(async () => {
			renderPanel({ pullRequests: [supported, unsupported] });
		});

		const supportedRefresh = container.querySelector(
			"[data-testid='task-pr-view-refresh-12']",
		) as HTMLButtonElement | null;
		expect(supportedRefresh?.disabled).toBe(false);
		const unsupportedRefresh = container.querySelector(
			"[data-testid='task-pr-view-refresh-34']",
		) as HTMLButtonElement | null;
		expect(unsupportedRefresh?.disabled).toBe(true);
		expect(container.querySelector('[data-testid="task-pr-view-refresh-note-34"]')).not.toBeNull();
	});

	it("queries the tracking state only for a visible view with installed consumers", async () => {
		trpcClientMocks.getTaskTrackingState.mockResolvedValue(createTrackingState());

		await act(async () => {
			renderPanel({
				installedConsumers: [{ kind: "mergeCompletion", requiredReadSources: [] }],
				pullRequests: [],
			});
		});

		expect(trpcClientMocks.getTaskTrackingState).toHaveBeenCalledWith({ taskId: "task-1" });
	});

	it("does not query the tracking state when the view is hidden", async () => {
		trpcClientMocks.getTaskTrackingState.mockResolvedValue(createTrackingState());

		await act(async () => {
			renderPanel({
				visible: false,
				installedConsumers: [{ kind: "mergeCompletion", requiredReadSources: [] }],
				pullRequests: [],
			});
		});

		expect(trpcClientMocks.getTaskTrackingState).not.toHaveBeenCalled();
	});
});
