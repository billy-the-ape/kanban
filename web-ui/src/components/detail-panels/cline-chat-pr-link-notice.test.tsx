import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trpcClientMocks = vi.hoisted(() => ({
	addTaskPullRequest: vi.fn(),
	removeTaskPullRequest: vi.fn(),
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			addTaskPullRequest: { mutate: trpcClientMocks.addTaskPullRequest },
			removeTaskPullRequest: { mutate: trpcClientMocks.removeTaskPullRequest },
		},
	}),
}));

import { ClineChatPrLinkNotice } from "@/components/detail-panels/cline-chat-pr-link-notice";
import type { RuntimeTaskChatPrLinking, RuntimeTaskChatPrLinkingLink } from "@/runtime/types";

function createLink(overrides: Partial<RuntimeTaskChatPrLinkingLink> = {}): RuntimeTaskChatPrLinkingLink {
	return {
		provider: "github",
		host: "github.com",
		repository: "owner/repo",
		number: 12,
		url: "https://github.com/owner/repo/pull/12",
		alreadyLinked: false,
		...overrides,
	};
}

function createLinking(
	status: RuntimeTaskChatPrLinking["status"],
	links: RuntimeTaskChatPrLinkingLink[],
): RuntimeTaskChatPrLinking {
	return { status, links, ...(status === "failed" ? { error: "Could not save the PR link." } : {}) };
}

async function clickButton(container: HTMLElement, text: string): Promise<void> {
	const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
	if (!button) {
		throw new Error(`Expected a button containing "${text}"`);
	}
	await act(async () => {
		button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

describe("ClineChatPrLinkNotice", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		trpcClientMocks.addTaskPullRequest.mockReset();
		trpcClientMocks.removeTaskPullRequest.mockReset();
		trpcClientMocks.addTaskPullRequest.mockResolvedValue({ ok: true, pullRequest: null });
		trpcClientMocks.removeTaskPullRequest.mockResolvedValue({ ok: true, pullRequest: null });
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

	it("renders a linked confirmation with a working Remove link action", async () => {
		const onDismiss = vi.fn();
		await act(async () => {
			root.render(
				<ClineChatPrLinkNotice
					taskId="task-1"
					linking={createLinking("linked", [createLink()])}
					workspaceId="workspace-1"
					onDismiss={onDismiss}
				/>,
			);
		});

		expect(container.textContent).toContain("Linked owner/repo#12");
		expect(container.textContent).not.toContain("Link owner/repo#12 to this task");

		await clickButton(container, "Remove link");
		expect(trpcClientMocks.removeTaskPullRequest).toHaveBeenCalledWith({
			taskId: "task-1",
			url: "https://github.com/owner/repo/pull/12",
		});
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("renders per-link Link buttons for suggestions and a plain label for already-linked", async () => {
		await act(async () => {
			root.render(
				<ClineChatPrLinkNotice
					taskId="task-1"
					linking={createLinking("suggestions", [
						createLink({ number: 13, url: "https://github.com/owner/repo/pull/13", alreadyLinked: true }),
						createLink(),
					])}
					workspaceId="workspace-1"
					onDismiss={vi.fn()}
				/>,
			);
		});

		expect(container.textContent).toContain("Already linked owner/repo#13");
		expect(container.textContent).toContain("Link owner/repo#12 to this task");
		// Already-linked identities never get a duplicate button.
		expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
			"Link owner/repo#12 to this task",
		]);

		await clickButton(container, "Link owner/repo#12 to this task");
		expect(trpcClientMocks.addTaskPullRequest).toHaveBeenCalledWith({
			taskId: "task-1",
			url: "https://github.com/owner/repo/pull/12",
		});
		expect(container.textContent).toContain("Linked owner/repo#12");
	});

	it("keeps the message sent on a failed auto-link and offers the normal Add action", async () => {
		await act(async () => {
			root.render(
				<ClineChatPrLinkNotice
					taskId="task-1"
					linking={createLinking("failed", [createLink()])}
					workspaceId="workspace-1"
					onDismiss={vi.fn()}
				/>,
			);
		});

		expect(container.textContent).toContain("Message sent; PR link could not be saved.");
		expect(container.textContent).toContain("Could not save the PR link.");

		await clickButton(container, "Link owner/repo#12 to this task");
		expect(trpcClientMocks.addTaskPullRequest).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("Linked owner/repo#12");
	});

	it("shows the sanitized error when an action fails", async () => {
		trpcClientMocks.addTaskPullRequest.mockResolvedValue({
			ok: false,
			error: "PR link already exists for this task.",
		});
		await act(async () => {
			root.render(
				<ClineChatPrLinkNotice
					taskId="task-1"
					linking={createLinking("suggestions", [createLink()])}
					workspaceId="workspace-1"
					onDismiss={vi.fn()}
				/>,
			);
		});

		await clickButton(container, "Link owner/repo#12 to this task");
		expect(container.textContent).toContain("PR link already exists for this task.");
	});

	it("ignores a stale remove response after the workspace scope changes", async () => {
		const onDismiss = vi.fn();
		let resolveRemove: ((value: { ok: boolean; pullRequest: null }) => void) | null = null;
		const pending = new Promise<{ ok: boolean; pullRequest: null }>((resolve) => {
			resolveRemove = resolve;
		});
		trpcClientMocks.removeTaskPullRequest.mockReturnValue(pending);

		const render = (workspaceId: string) => (
			<ClineChatPrLinkNotice
				taskId="task-1"
				linking={createLinking("linked", [createLink()])}
				workspaceId={workspaceId}
				onDismiss={onDismiss}
			/>
		);

		await act(async () => {
			root.render(render("workspace-1"));
		});
		await act(async () => {
			container.querySelector("button:not([disabled])")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		// Scope changes before the stale response settles.
		await act(async () => {
			root.render(render("workspace-2"));
		});
		await act(async () => {
			if (!resolveRemove) {
				throw new Error("Expected a resolvable remove promise.");
			}
			resolveRemove({ ok: true, pullRequest: null });
			await pending;
		});

		expect(onDismiss).not.toHaveBeenCalled();
	});
});
