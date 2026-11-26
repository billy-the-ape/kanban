import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskPullRequestActions } from "@/hooks/use-task-pull-request-actions";
import type { RuntimePrConflictState, RuntimeTaskConflictRepairRecord, RuntimeTaskPullRequest } from "@/runtime/types";
import { TaskPullRequestRow } from "./task-pull-request-row";

const noop = () => {};
const asyncNoop = async () => {};
const asyncTrue = async () => true;

const actions: TaskPullRequestActions = {
	adding: false,
	addError: null,
	clearAddError: noop,
	addPullRequest: asyncTrue,
	removingKey: null,
	removePullRequest: asyncNoop,
	primaryPendingKey: null,
	makePrimary: asyncNoop,
	clearPrimary: asyncNoop,
	refreshingKey: null,
	refreshEntry: asyncNoop,
	linkedRefreshing: false,
	refreshLinked: asyncNoop,
	branchLookupPending: false,
	findBranchPullRequests: asyncNoop,
	refreshAllPending: false,
	refreshAll: asyncNoop,
	repairPendingKey: null,
	recheckPendingKey: null,
	repairError: null,
	clearRepairError: noop,
	resolveConflicts: async () => true,
	recheckConflict: asyncNoop,
};

function createPullRequest(overrides?: Partial<RuntimeTaskPullRequest>): RuntimeTaskPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "octo/repo",
		number: 42,
		url: "https://github.com/octo/repo/pull/42",
		source: "manual",
		createdAt: 1_800_000_000_000,
		...overrides,
	};
}

const HEAD_SHA = "abc123def4567890abc123def4567890abc123de";
const PR_KEY = "github|github.com|octo/repo|42";

function makeConflict(overrides?: Partial<RuntimePrConflictState>): RuntimePrConflictState {
	return {
		state: "conflicting",
		source: "provider_snapshot",
		note: null,
		prKey: "github|github.com|octo/repo|42",
		headRef: "feature",
		baseRef: "main",
		headSha: HEAD_SHA,
		baseSha: null,
		checkedAt: 1_800_000_000_000,
		...overrides,
	};
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderRow(
	pullRequest: RuntimeTaskPullRequest,
	options: {
		canManage?: boolean;
		conflict?: RuntimePrConflictState | null;
		conflictRepair?: RuntimeTaskConflictRepairRecord | null;
		actions?: TaskPullRequestActions;
	} = {},
): void {
	const activeRoot = root;
	if (!activeRoot || !container) {
		throw new Error("test root not initialized");
	}
	act(() => {
		activeRoot.render(
			<TaskPullRequestRow
				pullRequest={pullRequest}
				isWinner={false}
				isExplicitPrimary={false}
				isAutomationPr={false}
				canManage={options.canManage === true}
				actions={options.actions ?? actions}
				conflict={options.conflict}
				conflictRepair={options.conflictRepair}
				mobile={false}
			/>,
		);
	});
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	const activeRoot = root;
	if (activeRoot) {
		act(() => {
			activeRoot.unmount();
		});
	}
	container?.remove();
	container = null;
	root = null;
});

describe("TaskPullRequestRow", () => {
	it("renders the provider detail line when details are stored", () => {
		renderRow(
			createPullRequest({
				headSha: "abc123def456789",
				additions: 120,
				deletions: 34,
				changedFiles: 12,
				commits: 7,
				comments: 3,
				reviewComments: 5,
				labels: ["bug"],
				mergeableState: "dirty",
				requestedReviewers: ["reviewer-a"],
				openedAt: 1_799_000_000_000,
				updatedAt: 1_799_500_000_000,
			}),
		);
		const details = container?.querySelector('[data-testid="task-pr-view-details-42"]');
		expect(details).not.toBeNull();
		expect(details?.textContent).toContain("+120 -34 (12 files)");
		expect(details?.textContent).toContain("7 commits");
		expect(details?.textContent).toContain("3 comments · 5 review comments");
		expect(details?.textContent).toContain("Head abc123d");
		expect(details?.textContent).toContain("Merge conflicts");
		expect(details?.textContent).toContain("Labels: bug");
		expect(details?.textContent).toContain("Reviewers: reviewer-a");
		expect(details?.textContent).toContain("Opened ");
		expect(details?.textContent).toContain("Updated ");
	});

	it("omits the detail line when no provider details are stored", () => {
		renderRow(createPullRequest());
		expect(container?.querySelector('[data-testid="task-pr-view-details-42"]')).toBeNull();
	});

	it("shows the Resolve conflicts action for a provider-confirmed conflict", () => {
		const resolveConflicts = vi.fn(async () => true);
		renderRow(createPullRequest(), {
			canManage: true,
			conflict: makeConflict(),
			actions: { ...actions, resolveConflicts },
		});
		const state = container?.querySelector('[data-testid="task-pr-view-conflict-state-42"]');
		expect(state?.textContent).toContain("does not merge cleanly");
		const button = container?.querySelector(
			'[data-testid="task-pr-view-resolve-conflicts-42"]',
		) as HTMLButtonElement | null;
		expect(button).not.toBeNull();
		expect(button?.disabled).toBe(false);
		act(() => {
			button?.click();
		});
		expect(resolveConflicts).toHaveBeenCalledTimes(1);
	});

	it("hides the repair action for read-only viewers and non-conflicting states", () => {
		renderRow(createPullRequest(), { canManage: false, conflict: makeConflict() });
		expect(container?.querySelector('[data-testid="task-pr-view-resolve-conflicts-42"]')).toBeNull();
		renderRow(createPullRequest(), {
			canManage: true,
			conflict: makeConflict({ state: "clean", source: "provider_snapshot", note: null }),
		});
		expect(container?.querySelector('[data-testid="task-pr-view-resolve-conflicts-42"]')).toBeNull();
		// A clean block never claims local knowledge and never offers repair.
		expect(container?.querySelector('[data-testid="task-pr-view-conflict-42"]')?.textContent).toContain("clean");
	});

	it("offers Re-check for the unknown state — never a silent guess", () => {
		const recheckConflict = vi.fn(async () => {});
		renderRow(createPullRequest(), {
			canManage: true,
			conflict: makeConflict({ state: "unknown", source: "none", note: "provider is still computing mergeability" }),
			actions: { ...actions, recheckConflict },
		});
		const button = container?.querySelector('[data-testid="task-pr-view-recheck-42"]') as HTMLButtonElement | null;
		expect(button).not.toBeNull();
		expect(container?.querySelector('[data-testid="task-pr-view-conflict-state-42"]')?.textContent).toContain(
			"still computing",
		);
		act(() => {
			button?.click();
		});
		expect(recheckConflict).toHaveBeenCalledTimes(1);
	});

	it("disables repair and explains the outstanding dispatch for the same head", () => {
		const conflict = makeConflict();
		renderRow(createPullRequest(), {
			canManage: true,
			conflict,
			conflictRepair: {
				prKey: PR_KEY,
				headSha: HEAD_SHA,
				dispatchedAt: 1_800_000_000_000,
				status: "dispatched",
			},
		});
		const button = container?.querySelector(
			'[data-testid="task-pr-view-resolve-conflicts-42"]',
		) as HTMLButtonElement | null;
		expect(button?.disabled).toBe(true);
		expect(container?.querySelector('[data-testid="task-pr-view-conflict-42"]')?.textContent).toContain(
			"repair dispatched",
		);
	});

	it("surfaces a failed repair and keeps the retry lane open", () => {
		const conflict = makeConflict();
		renderRow(createPullRequest(), {
			canManage: true,
			conflict,
			conflictRepair: {
				prKey: PR_KEY,
				headSha: HEAD_SHA,
				dispatchedAt: 1_800_000_000_000,
				status: "failed",
				error: "Cline is starting. Stop it before sending a message.",
			},
		});
		const button = container?.querySelector(
			'[data-testid="task-pr-view-resolve-conflicts-42"]',
		) as HTMLButtonElement | null;
		expect(button?.disabled).toBe(false);
		expect(container?.querySelector('[data-testid="task-pr-view-conflict-42"]')?.textContent).toContain(
			"repair failed",
		);
	});
});
