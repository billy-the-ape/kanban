import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskPullRequestActions } from "@/hooks/use-task-pull-request-actions";
import type { RuntimeTaskPullRequest } from "@/runtime/types";
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderRow(pullRequest: RuntimeTaskPullRequest): void {
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
				canManage={false}
				actions={actions}
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
});
