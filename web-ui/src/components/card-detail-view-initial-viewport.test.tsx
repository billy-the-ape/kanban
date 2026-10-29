import { act, forwardRef, type ReactNode, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CardDetailView } from "@/components/card-detail-view";
import type { BoardCard, BoardColumn, CardSelection } from "@/types";

/**
 * Regression tests for the initial viewport render of the task detail view.
 *
 * Unlike card-detail-view.test.tsx, this file does NOT mock use-is-mobile:
 * it uses the real hook with a realistic window.matchMedia mock so that the
 * very first render is exercised. The mocked ColumnContextPanel records its
 * render calls, which catches the original bug (desktop layout mounted
 * before the media query effect corrected isMobile) even though React 18
 * flushes effects synchronously inside act().
 */

type MediaQueryChangeCallback = (event: Event) => void;

function createViewportMediaMock(initialWidth: number) {
	const listeners = new Set<MediaQueryChangeCallback>();
	let viewportWidth = initialWidth;

	const evaluate = (query: string): boolean => {
		const maxWidth = /\(max-width:\s*([\d.]+)px\)/.exec(query);
		if (!maxWidth) {
			return false;
		}
		return viewportWidth <= Number(maxWidth[1]);
	};

	const matchMedia = (query: string): MediaQueryList => ({
		// Like a real MediaQueryList, `matches` is live and re-evaluated.
		get matches() {
			return evaluate(query);
		},
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
			if (typeof listener === "function") {
				listeners.add(listener as MediaQueryChangeCallback);
			}
		},
		removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
			if (typeof listener === "function") {
				listeners.delete(listener as MediaQueryChangeCallback);
			}
		},
		dispatchEvent: () => true,
	});

	return {
		matchMedia,
		resizeTo(width: number) {
			viewportWidth = width;
			const event = new Event("change");
			listeners.forEach((listener) => {
				listener(event);
			});
		},
	};
}

const trpcClientMocks = vi.hoisted(() => ({
	addTaskPullRequest: vi.fn(),
	removeTaskPullRequest: vi.fn(),
	setPrimaryTaskPullRequest: vi.fn(),
	refreshTaskPullRequests: vi.fn(),
	refreshTaskPullRequestEntry: vi.fn(),
	refreshLinkedTaskPullRequests: vi.fn(),
	getTaskTrackingState: vi.fn(),
}));

const {
	mockColumnContextPanel,
	mockAgentTerminalPanel,
	mockClineAgentChatPanel,
	mockDiffViewerPanel,
	mockFileTreePanel,
	mockClineAppendToDraft,
	mockClineSendText,
	mockUseRuntimeWorkspaceChanges,
} = vi.hoisted(() => ({
	mockColumnContextPanel: vi.fn(() => <div data-testid="column-context-panel" />),
	mockAgentTerminalPanel: vi.fn(() => null),
	mockClineAgentChatPanel: vi.fn((..._args: unknown[]) => null),
	mockDiffViewerPanel: vi.fn(() => null),
	mockFileTreePanel: vi.fn(() => null),
	mockClineAppendToDraft: vi.fn(),
	mockClineSendText: vi.fn(async () => {}),
	mockUseRuntimeWorkspaceChanges: vi.fn(),
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

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: () => {},
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
	ColumnContextPanel: mockColumnContextPanel,
}));

vi.mock("@/components/detail-panels/diff-viewer-panel", () => ({
	DiffViewerPanel: mockDiffViewerPanel,
}));

vi.mock("@/components/detail-panels/file-tree-panel", () => ({
	FileTreePanel: mockFileTreePanel,
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

function createSelection(): CardSelection {
	const card: BoardCard = {
		id: "task-1",
		title: "Task 1",
		prompt: "Task 1",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
	const columns: BoardColumn[] = [
		{ id: "backlog", title: "Backlog", cards: [card] },
		{ id: "in_progress", title: "In Progress", cards: [] },
		{ id: "review", title: "Review", cards: [] },
		{ id: "trash", title: "Done", cards: [] },
	];
	return { card, column: columns[0]!, allColumns: columns };
}

function findTabButton(container: HTMLElement, label: string): HTMLButtonElement | null {
	const button = Array.from(container.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === label,
	);
	return button instanceof HTMLButtonElement ? button : null;
}

describe("CardDetailView initial viewport rendering", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let mediaMock: ReturnType<typeof createViewportMediaMock>;
	let previousMatchMedia: typeof window.matchMedia;

	beforeEach(() => {
		window.localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		previousMatchMedia = window.matchMedia;
		mediaMock = createViewportMediaMock(1280);
		window.matchMedia = mediaMock.matchMedia;
		mockColumnContextPanel.mockClear();
		mockAgentTerminalPanel.mockClear();
		mockClineAgentChatPanel.mockClear();
		mockDiffViewerPanel.mockClear();
		mockFileTreePanel.mockClear();
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
		window.matchMedia = previousMatchMedia;
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

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

	const expectMobileLayout = (): void => {
		expect(findTabButton(container, "Chat")).not.toBeNull();
		expect(container.querySelector('[data-testid="column-context-panel"]')).toBeNull();
		expect(container.querySelector('[aria-label="Resize task cards and detail panels"]')).toBeNull();
	};

	const expectDesktopLayout = (): void => {
		expect(container.querySelector('[data-testid="column-context-panel"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Resize agent and diff panels"]')).not.toBeNull();
	};

	it("renders the mobile layout on the first render and never mounts ColumnContextPanel (iPhone viewport)", async () => {
		mediaMock.resizeTo(390);

		await renderDetail();

		expectMobileLayout();
		// The core regression: with the previous implementation the desktop
		// layout (and therefore ColumnContextPanel) mounted first and was
		// only removed once the media query effect ran.
		expect(mockColumnContextPanel).not.toHaveBeenCalled();
	});

	it("renders the desktop layout immediately on a desktop viewport", async () => {
		mediaMock.resizeTo(1280);

		await renderDetail();

		expectDesktopLayout();
		expect(mockColumnContextPanel).toHaveBeenCalled();
	});

	it("switches to the mobile layout without remounting desktop panels when the viewport shrinks", async () => {
		mediaMock.resizeTo(1280);

		await renderDetail();
		expectDesktopLayout();
		const desktopRenderCount = mockColumnContextPanel.mock.calls.length;
		expect(desktopRenderCount).toBeGreaterThan(0);

		act(() => {
			mediaMock.resizeTo(390);
		});

		expectMobileLayout();
		// No additional renders of the desktop panel after the transition.
		expect(mockColumnContextPanel.mock.calls.length).toBe(desktopRenderCount);
	});

	it("switches to the desktop layout and mounts ColumnContextPanel when the viewport grows", async () => {
		mediaMock.resizeTo(390);

		await renderDetail();
		expectMobileLayout();
		expect(mockColumnContextPanel).not.toHaveBeenCalled();

		act(() => {
			mediaMock.resizeTo(1280);
		});

		expectDesktopLayout();
		expect(mockColumnContextPanel).toHaveBeenCalled();
	});
});
