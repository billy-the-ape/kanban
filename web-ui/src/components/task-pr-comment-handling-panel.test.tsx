import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskPrCommentHandlingPanel } from "@/components/task-pr-comment-handling-panel";
import type { RuntimeTaskPrTrackingState, RuntimeTaskPullRequest } from "@/runtime/types";

const useTaskPrTrackingStateMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-task-pr-tracking-state", () => ({
	useTaskPrTrackingState: useTaskPrTrackingStateMock,
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			setTaskPrAutomationSettings: { mutate: async () => ({ ok: true, error: null }) },
			resumeTaskPrCommentHandling: { mutate: async () => ({ ok: true, dispatched: false }) },
		},
	}),
}));

const PR: RuntimeTaskPullRequest = {
	provider: "github",
	host: "github.com",
	repository: "octo/repo",
	number: 42,
	url: "https://github.com/octo/repo/pull/42",
	source: "manual",
	createdAt: 1,
};

function makeState(overrides: Partial<RuntimeTaskPrTrackingState>): RuntimeTaskPrTrackingState {
	return {
		enabled: true,
		supported: true,
		pr: PR,
		pendingCount: 0,
		pendingDeadline: null,
		dispatch: null,
		blocker: null,
		resumable: false,
		resumeRequiresAcknowledgment: false,
		...overrides,
	};
}

describe("TaskPrCommentHandlingPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		useTaskPrTrackingStateMock.mockReset();
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

	function render(state: RuntimeTaskPrTrackingState): void {
		useTaskPrTrackingStateMock.mockReturnValue({ state, isPending: false });
		act(() => {
			root.render(<TaskPrCommentHandlingPanel workspaceId="w1" taskId="t1" pullRequests={[PR]} />);
		});
	}

	it("keeps the blocker and Resume visible while feedback is still pending", () => {
		// Regression: the pending status line used to hide both the pause
		// reason and the Resume button, so a rate-limit or capture pause
		// could not be cleared from the UI.
		render(
			makeState({
				pendingCount: 1,
				pendingDeadline: Date.now() + 120_000,
				blocker: "Automatic comment handling is paused after 5 attempts in the last hour. Resume to continue.",
				resumable: true,
			}),
		);
		expect(document.querySelector('[data-testid="task-pr-comment-status-pending"]')).toBeNull();
		const blocked = document.querySelector('[data-testid="task-pr-comment-status-blocked"]');
		expect(blocked?.textContent).toContain("paused after 5 attempts");
		expect(document.querySelector('[data-testid="task-pr-comment-resume-button"]')).not.toBeNull();
	});

	it("renders the pending countdown when nothing is paused", () => {
		render(makeState({ pendingCount: 2, pendingDeadline: Date.now() + 120_000 }));
		const pending = document.querySelector('[data-testid="task-pr-comment-status-pending"]');
		expect(pending?.textContent).toContain("Waiting to address 2 new comments");
		expect(document.querySelector('[data-testid="task-pr-comment-status-blocked"]')).toBeNull();
	});
});
