import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trpcClientMocks = vi.hoisted(() => ({
	addTaskPullRequest: vi.fn(),
	removeTaskPullRequest: vi.fn(),
	refreshTaskPullRequests: vi.fn(),
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			addTaskPullRequest: { mutate: trpcClientMocks.addTaskPullRequest },
			removeTaskPullRequest: { mutate: trpcClientMocks.removeTaskPullRequest },
			refreshTaskPullRequests: { mutate: trpcClientMocks.refreshTaskPullRequests },
		},
	}),
}));

const appToasterMocks = vi.hoisted(() => ({
	showAppToast: vi.fn(),
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: appToasterMocks.showAppToast,
	notifyError: vi.fn(),
}));

import { TaskPullRequestManager } from "@/components/task-pull-request-manager";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskPullRequest } from "@/runtime/types";

function createTaskPullRequest(number: number): RuntimeTaskPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "cline/kanban",
		number,
		url: `https://github.com/cline/kanban/pull/${number}`,
		source: "manual",
		createdAt: 1,
	};
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
	descriptor?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function clickElement(element: Element): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

async function openPopover(container: HTMLDivElement): Promise<void> {
	const trigger = container.querySelector(
		"[data-testid='task-pr-link-pr-button'], [data-testid='task-pr-manage-button']",
	);
	expect(trigger).toBeTruthy();
	await clickElement(trigger as Element);
}

async function setUrl(input: HTMLInputElement, value: string): Promise<void> {
	await act(async () => {
		setInputValue(input, value);
	});
}

describe("TaskPullRequestManager", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	function renderManager(pullRequests: RuntimeTaskPullRequest[]): void {
		root.render(
			<TooltipProvider>
				<TaskPullRequestManager workspaceId="workspace-1" taskId="task-1" pullRequests={pullRequests} />
			</TooltipProvider>,
		);
	}

	beforeEach(() => {
		trpcClientMocks.addTaskPullRequest.mockReset();
		trpcClientMocks.removeTaskPullRequest.mockReset();
		trpcClientMocks.refreshTaskPullRequests.mockReset();
		appToasterMocks.showAppToast.mockReset();
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
	it("adds a PR link from the URL input and closes on success", async () => {
		trpcClientMocks.addTaskPullRequest.mockResolvedValue({
			ok: true,
			pullRequest: createTaskPullRequest(42),
		});

		await act(async () => {
			renderManager([]);
		});

		await openPopover(container);
		const input = document.body.querySelector("[data-testid='task-pr-url-input']") as HTMLInputElement | null;
		expect(input).toBeTruthy();
		if (!input) {
			return;
		}
		await setUrl(input, "https://github.com/cline/kanban/pull/42");

		const addButton = document.body.querySelector("[data-testid='task-pr-add-button']") as HTMLButtonElement | null;
		expect(addButton?.disabled).toBe(false);
		await clickElement(addButton as Element);

		expect(trpcClientMocks.addTaskPullRequest).toHaveBeenCalledWith({
			taskId: "task-1",
			url: "https://github.com/cline/kanban/pull/42",
		});
		// Popover closes on success and no error toast is shown.
		expect(document.body.querySelector("[data-testid='task-pr-url-input']")).toBeNull();
		expect(appToasterMocks.showAppToast).not.toHaveBeenCalled();
	});

	it("keeps the popover open and surfaces the server error on failure", async () => {
		trpcClientMocks.addTaskPullRequest.mockResolvedValue({
			ok: false,
			error: 'Task "task-1" not found',
			pullRequest: null,
		});
		await act(async () => {
			renderManager([]);
		});

		await openPopover(container);
		const input = document.body.querySelector("[data-testid='task-pr-url-input']") as HTMLInputElement | null;
		if (!input) {
			return;
		}
		await setUrl(input, "https://github.com/cline/kanban/pull/42");

		const addButton = document.body.querySelector("[data-testid='task-pr-add-button']") as HTMLButtonElement | null;
		await clickElement(addButton as Element);

		const formError = document.body.querySelector("[data-testid='task-pr-form-error']");
		expect(formError?.textContent).toBe('Task "task-1" not found');
		expect(document.body.querySelector("[data-testid='task-pr-url-input']")).toBeTruthy();
		expect(appToasterMocks.showAppToast).toHaveBeenCalledWith(
			expect.objectContaining({ intent: "danger", message: 'Task "task-1" not found' }),
		);
	});

	it("validates the URL shape client-side before submitting", async () => {
		await act(async () => {
			renderManager([]);
		});

		await openPopover(container);
		const input = document.body.querySelector("[data-testid='task-pr-url-input']") as HTMLInputElement | null;
		if (!input) {
			return;
		}
		await setUrl(input, "not a url");

		expect(document.body.querySelector("[data-testid='task-pr-url-validation-error']")).toBeTruthy();
		expect(
			(document.body.querySelector("[data-testid='task-pr-add-button']") as HTMLButtonElement | null)?.disabled,
		).toBe(true);
	});

	it("removes a recorded link and toasts on server failure", async () => {
		trpcClientMocks.removeTaskPullRequest.mockResolvedValue({
			ok: false,
			error: "No matching pull request is recorded for this task.",
			pullRequest: null,
		});

		await act(async () => {
			renderManager([createTaskPullRequest(12)]);
		});

		await openPopover(container);
		const removeButton = document.body.querySelector("[data-testid='task-pr-remove-12']");
		expect(removeButton).toBeTruthy();
		await clickElement(removeButton as Element);

		expect(trpcClientMocks.removeTaskPullRequest).toHaveBeenCalledWith({
			taskId: "task-1",
			url: "https://github.com/cline/kanban/pull/12",
		});
		expect(appToasterMocks.showAppToast).toHaveBeenCalledWith(expect.objectContaining({ intent: "danger" }));
	});

	it("runs the opt-in refresh and warns on failure", async () => {
		trpcClientMocks.refreshTaskPullRequests.mockResolvedValue({
			ok: false,
			updated: 0,
			error: "Refresh failed.",
		});

		await act(async () => {
			renderManager([]);
		});

		await openPopover(container);
		const refreshButton = document.body.querySelector("[data-testid='task-pr-refresh-button']");
		expect(refreshButton).toBeTruthy();
		await clickElement(refreshButton as Element);

		expect(trpcClientMocks.refreshTaskPullRequests).toHaveBeenCalledWith({ taskId: "task-1" });
		expect(appToasterMocks.showAppToast).toHaveBeenCalledWith(
			expect.objectContaining({ intent: "warning", message: "Refresh failed." }),
		);
	});
});
