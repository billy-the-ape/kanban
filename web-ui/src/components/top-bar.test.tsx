import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TopBar } from "@/components/top-bar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskPullRequest } from "@/runtime/types";
import { replaceWorkspaceMetadata, resetWorkspaceMetadataStore } from "@/stores/workspace-metadata-store";

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
	descriptor?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TopBar script shortcut onboarding", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
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

	it("opens first-shortcut dialog from Run and saves when command is provided", async () => {
		const onCreateFirstShortcut = vi.fn(async () => ({ ok: true }));
		const onRunShortcut = vi.fn();

		await act(async () => {
			root.render(
				<TopBar
					openTargetOptions={[]}
					selectedOpenTargetId="vscode"
					onSelectOpenTarget={() => {}}
					onOpenWorkspace={() => {}}
					canOpenWorkspace={false}
					isOpeningWorkspace={false}
					shortcuts={[]}
					onRunShortcut={onRunShortcut}
					onCreateFirstShortcut={onCreateFirstShortcut}
				/>,
			);
		});

		const runButton = findButtonByText(container, "Run");
		expect(runButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			runButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			runButton?.click();
		});

		expect(document.body.textContent).toContain("Set up your first script shortcut");

		const commandInput = Array.from(document.body.querySelectorAll("input")).find(
			(input) => input.placeholder === "npm run dev",
		) as HTMLInputElement | undefined;
		expect(commandInput).toBeDefined();
		expect(commandInput?.value).toBe("");

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		expect(saveButton?.disabled).toBe(true);

		await act(async () => {
			if (!commandInput) {
				return;
			}
			setInputValue(commandInput, "pnpm dev");
		});
		expect(saveButton?.disabled).toBe(false);

		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});

		expect(onCreateFirstShortcut).toHaveBeenCalledWith({
			label: "Run",
			command: "pnpm dev",
			icon: "play",
		});
		expect(onRunShortcut).not.toHaveBeenCalled();
	});

	it("opens settings when the runtime hint is clicked", async () => {
		const onOpenSettings = vi.fn();

		await act(async () => {
			root.render(
				<TopBar
					openTargetOptions={[]}
					selectedOpenTargetId="vscode"
					onSelectOpenTarget={() => {}}
					onOpenWorkspace={() => {}}
					canOpenWorkspace={false}
					isOpeningWorkspace={false}
					runtimeHint="No agent configured"
					onOpenSettings={onOpenSettings}
				/>,
			);
		});

		const runtimeHintButton = findButtonByText(container, "No agent configured");
		expect(runtimeHintButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			runtimeHintButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			runtimeHintButton?.click();
		});

		expect(onOpenSettings).toHaveBeenCalledTimes(1);
	});
});

function createTaskPullRequest(number: number, overrides?: Partial<RuntimeTaskPullRequest>): RuntimeTaskPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "cline/kanban",
		number,
		url: `https://github.com/cline/kanban/pull/${number}`,
		source: "delivery",
		createdAt: 1,
		...overrides,
	};
}

function seedTaskWorkspace(): void {
	replaceWorkspaceMetadata({
		homeGitSummary: null,
		homeGitStateVersion: 0,
		taskWorkspaces: [
			{
				taskId: "task-pr-1",
				path: "/tmp/worktrees/task-pr-1",
				exists: true,
				baseRef: "main",
				branch: "feature/task-pr",
				isDetached: false,
				headCommit: "abc123def",
				changedFiles: 2,
				additions: 5,
				deletions: 1,
				stateVersion: 1,
			},
		],
	});
}

function renderTopBar(root: Root, props: Partial<Parameters<typeof TopBar>[0]>): void {
	root.render(
		<TooltipProvider>
			<TopBar
				openTargetOptions={[]}
				selectedOpenTargetId="vscode"
				onSelectOpenTarget={() => {}}
				onOpenWorkspace={() => {}}
				canOpenWorkspace={false}
				isOpeningWorkspace={false}
				{...props}
			/>
		</TooltipProvider>,
	);
}

describe("TopBar pull request links", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		seedTaskWorkspace();
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
		resetWorkspaceMetadataStore();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("renders up to 3 PR links between the branch button and the diff summary", async () => {
		const pullRequests = [1, 2, 3].map((number) => createTaskPullRequest(number));

		await act(async () => {
			renderTopBar(root, {
				onToggleGitHistory: () => {},
				selectedTaskId: "task-pr-1",
				selectedTaskBaseRef: "main",
				selectedTaskPullRequests: pullRequests,
			});
		});

		const anchors = Array.from(container.querySelectorAll("a"));
		expect(anchors.map((anchor) => anchor.textContent)).toEqual(["PR #1", "PR #2", "PR #3"]);
		for (const anchor of anchors) {
			expect(anchor.getAttribute("target")).toBe("_blank");
			expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
		}

		const branchButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("feature/task-pr"),
		);
		expect(branchButton).toBeTruthy();
		const firstAnchor = anchors[0] as HTMLAnchorElement | null;
		const prGroup = firstAnchor?.parentElement as HTMLElement | null;
		expect(prGroup).toBeTruthy();
		const diffSummary = Array.from(container.querySelectorAll("span")).find((span) =>
			span.textContent?.startsWith("(2 files"),
		);
		expect(diffSummary).toBeTruthy();
		expect(
			branchButton && prGroup ? branchButton.compareDocumentPosition(prGroup) & Node.DOCUMENT_POSITION_FOLLOWING : 0,
		).toBeTruthy();
		expect(
			prGroup && diffSummary ? prGroup.compareDocumentPosition(diffSummary) & Node.DOCUMENT_POSITION_FOLLOWING : 0,
		).toBeTruthy();
	});

	it("collapses more than 3 PRs into the latest 2 links plus a +N popover", async () => {
		const pullRequests = [1, 2, 3, 4, 5].map((number) => createTaskPullRequest(number));

		await act(async () => {
			renderTopBar(root, {
				onToggleGitHistory: () => {},
				selectedTaskId: "task-pr-1",
				selectedTaskBaseRef: "main",
				selectedTaskPullRequests: pullRequests,
			});
		});

		const inlineAnchors = Array.from(container.querySelectorAll("a"));
		expect(inlineAnchors.map((anchor) => anchor.textContent)).toEqual(["PR #4", "PR #5"]);

		const overflowButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "+3",
		);
		expect(overflowButton).toBeInstanceOf(HTMLButtonElement);
		expect(overflowButton?.getAttribute("aria-label")).toBe("Show 3 more pull requests");

		await act(async () => {
			overflowButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			overflowButton?.click();
		});

		const allAnchors = Array.from(document.body.querySelectorAll("a"));
		expect(allAnchors.map((anchor) => anchor.textContent)).toEqual(["PR #4", "PR #5", "PR #1", "PR #2", "PR #3"]);
	});

	it("renders GitLab pull requests with the MR prefix", async () => {
		await act(async () => {
			renderTopBar(root, {
				onToggleGitHistory: () => {},
				selectedTaskId: "task-pr-1",
				selectedTaskBaseRef: "main",
				selectedTaskPullRequests: [
					createTaskPullRequest(77, {
						provider: "gitlab",
						host: "gitlab.com",
						url: "https://gitlab.com/cline/kanban/-/merge_requests/77",
					}),
				],
			});
		});

		const anchors = Array.from(container.querySelectorAll("a"));
		expect(anchors.map((anchor) => anchor.textContent)).toEqual(["MR !77"]);
		expect(anchors[0]?.getAttribute("href")).toBe("https://gitlab.com/cline/kanban/-/merge_requests/77");
	});

	it("applies the merged state tint to recorded PR links", async () => {
		await act(async () => {
			renderTopBar(root, {
				onToggleGitHistory: () => {},
				selectedTaskId: "task-pr-1",
				selectedTaskBaseRef: "main",
				selectedTaskPullRequests: [
					createTaskPullRequest(12, {
						title: "Fix the bug",
						state: "merged",
						stateCheckedAt: Date.now(),
					}),
				],
			});
		});

		const anchor = container.querySelector("a");
		expect(anchor?.classList.contains("text-status-purple")).toBe(true);
		expect(anchor?.classList.contains("text-accent")).toBe(false);
	});

	it("renders no PR links on the home branch summary", async () => {
		replaceWorkspaceMetadata({
			homeGitSummary: {
				currentBranch: "main",
				upstreamBranch: "origin/main",
				changedFiles: 1,
				additions: 2,
				deletions: 0,
				aheadCount: 0,
				behindCount: 1,
			},
			homeGitStateVersion: 1,
			taskWorkspaces: [],
		});

		await act(async () => {
			renderTopBar(root, {
				showHomeGitSummary: true,
				selectedTaskPullRequests: [createTaskPullRequest(1)],
			});
		});

		expect(container.textContent).toContain("main");
		expect(container.querySelectorAll("a").length).toBe(0);
	});
	it("shows the link-PR affordance when the task and workspace are scoped", async () => {
		await act(async () => {
			renderTopBar(root, {
				onToggleGitHistory: () => {},
				selectedTaskId: "task-pr-1",
				selectedTaskBaseRef: "main",
				workspaceId: "workspace-1",
			});
		});

		expect(container.querySelector("[data-testid='task-pr-link-pr-button']")).toBeTruthy();
	});

	it("shows the manage button instead of Link PR when PRs are recorded", async () => {
		await act(async () => {
			renderTopBar(root, {
				onToggleGitHistory: () => {},
				selectedTaskId: "task-pr-1",
				selectedTaskBaseRef: "main",
				workspaceId: "workspace-1",
				selectedTaskPullRequests: [createTaskPullRequest(1)],
			});
		});

		expect(container.querySelector("[data-testid='task-pr-manage-button']")).toBeTruthy();
		expect(container.querySelector("[data-testid='task-pr-link-pr-button']")).toBeNull();
	});

	it("hides the manual link affordance when the workspace scope is missing", async () => {
		await act(async () => {
			renderTopBar(root, {
				onToggleGitHistory: () => {},
				selectedTaskId: "task-pr-1",
				selectedTaskBaseRef: "main",
				selectedTaskPullRequests: [createTaskPullRequest(1)],
			});
		});

		expect(container.querySelector("[data-testid='task-pr-manage-button']")).toBeNull();
		expect(container.querySelector("[data-testid='task-pr-link-pr-button']")).toBeNull();
	});
});
