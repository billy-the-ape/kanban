import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

const ensurePersistentTerminalMock = vi.hoisted(() => vi.fn());
const disposePersistentTerminalMock = vi.hoisted(() => vi.fn());
const registerTerminalControllerMock = vi.hoisted(() => vi.fn());

vi.mock("@/terminal/persistent-terminal-manager", () => ({
	ensurePersistentTerminal: ensurePersistentTerminalMock,
	disposePersistentTerminal: disposePersistentTerminalMock,
}));

vi.mock("@/terminal/terminal-controller-registry", () => ({
	registerTerminalController: registerTerminalControllerMock,
}));

function createPersistentTerminalMock() {
	return {
		subscribe: vi.fn(() => vi.fn()),
		mount: vi.fn(),
		unmount: vi.fn(),
		reset: vi.fn(),
		input: vi.fn(() => true),
		paste: vi.fn(() => true),
		waitForLikelyPrompt: vi.fn(async () => true),
		clear: vi.fn(),
		stop: vi.fn(async () => {}),
	};
}

type PersistentTerminalMock = ReturnType<typeof createPersistentTerminalMock>;

function createSummary(state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state,
		agentId: "claude",
		pid: 4321,
		workspacePath: "/tmp/task",
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

function requireElement<T extends HTMLElement>(container: HTMLElement, selector: string): T {
	const element = container.querySelector<T>(selector);
	if (!element) {
		throw new Error(`Expected an element for ${selector}.`);
	}
	return element;
}

function requireStopButton(container: HTMLElement): HTMLButtonElement {
	return requireElement<HTMLButtonElement>(container, 'button[aria-label="Stop session"]');
}

function requireButtonLabelled(container: HTMLElement, label: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === label,
	);
	if (!button) {
		throw new Error(`Expected a "${label}" button.`);
	}
	return button;
}

function clickElement(element: HTMLElement): void {
	act(() => {
		element.click();
	});
}

describe("AgentTerminalPanel stop control", () => {
	let container: HTMLDivElement;
	let root: Root;
	let terminal: PersistentTerminalMock;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		terminal = createPersistentTerminalMock();
		ensurePersistentTerminalMock.mockReturnValue(terminal);
		ensurePersistentTerminalMock.mockClear();
		disposePersistentTerminalMock.mockClear();
		registerTerminalControllerMock.mockClear();
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderPanel(props: Parameters<typeof AgentTerminalPanel>[0]): Promise<void> {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel {...props} />
				</TooltipProvider>,
			);
		});
	}

	it("stops the running session through the shared stopTerminal path", async () => {
		await renderPanel({
			taskId: "task-1",
			workspaceId: "workspace-1",
			summary: createSummary("running"),
			showSessionToolbar: false,
			showStopControl: true,
		});

		const stopButton = requireStopButton(container);
		expect(stopButton.disabled).toBe(false);

		clickElement(stopButton);

		await act(async () => {
			await Promise.resolve();
		});
		expect(terminal.stop).toHaveBeenCalledTimes(1);
	});

	it("shows the session status in the compact header that replaces the session toolbar", async () => {
		await renderPanel({
			taskId: "task-1",
			workspaceId: "workspace-1",
			summary: createSummary("awaiting_review"),
			showSessionToolbar: false,
			showStopControl: true,
		});

		expect(container.textContent).toContain("Ready for review");
		expect(requireStopButton(container).disabled).toBe(false);
	});

	it.each(["idle", "interrupted", "failed"] as const)(
		"disables Stop when the %s session is not active",
		async (state) => {
			await renderPanel({
				taskId: "task-1",
				workspaceId: "workspace-1",
				summary: createSummary(state),
				showSessionToolbar: false,
				showStopControl: true,
			});

			const stopButton = requireStopButton(container);
			expect(stopButton.disabled).toBe(true);

			clickElement(stopButton);

			await act(async () => {
				await Promise.resolve();
			});
			expect(terminal.stop).not.toHaveBeenCalled();
		},
	);

	it("disables Stop when the task has no session yet", async () => {
		await renderPanel({
			taskId: "task-1",
			workspaceId: "workspace-1",
			summary: null,
			showSessionToolbar: false,
			showStopControl: true,
		});

		expect(container.textContent).toContain("No session yet");
		const stopButton = requireStopButton(container);
		expect(stopButton.disabled).toBe(true);

		clickElement(stopButton);

		await act(async () => {
			await Promise.resolve();
		});
		expect(terminal.stop).not.toHaveBeenCalled();
	});

	it("keeps Stop disabled while the stop request is in flight", async () => {
		let resolveStop: () => void = () => {};
		terminal.stop.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveStop = resolve;
				}),
		);

		await renderPanel({
			taskId: "task-1",
			workspaceId: "workspace-1",
			summary: createSummary("running"),
			showSessionToolbar: false,
			showStopControl: true,
		});

		const stopButton = requireStopButton(container);
		clickElement(stopButton);
		expect(stopButton.disabled).toBe(true);

		await act(async () => {
			resolveStop();
			await Promise.resolve();
		});
		expect(stopButton.disabled).toBe(false);
	});

	it("hides the stop control when the panel does not opt in", async () => {
		await renderPanel({
			taskId: "task-1",
			workspaceId: "workspace-1",
			summary: createSummary("running"),
			showSessionToolbar: false,
		});

		expect(container.querySelector('button[aria-label="Stop session"]')).toBeNull();
	});

	it("keeps the existing minimal header controls beside Stop", async () => {
		const onClose = vi.fn();
		const onToggleExpand = vi.fn();

		await renderPanel({
			taskId: "task-1",
			workspaceId: "workspace-1",
			summary: createSummary("running"),
			showSessionToolbar: false,
			showStopControl: true,
			minimalHeaderTitle: "Terminal",
			onClose,
			onToggleExpand,
		});

		expect(container.textContent).toContain("Terminal");
		clickElement(requireElement<HTMLElement>(container, 'button[aria-label="Close terminal"]'));
		clickElement(requireElement<HTMLElement>(container, 'button[aria-label="Expand terminal"]'));

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onToggleExpand).toHaveBeenCalledTimes(1);
		expect(requireStopButton(container).disabled).toBe(false);
	});

	it("keeps the labelled Stop button in the full session toolbar", async () => {
		await renderPanel({
			taskId: "task-1",
			workspaceId: "workspace-1",
			summary: createSummary("running"),
			showSessionToolbar: true,
		});

		const stopButton = requireButtonLabelled(container, "Stop");
		expect(stopButton.disabled).toBe(false);

		clickElement(stopButton);

		await act(async () => {
			await Promise.resolve();
		});
		expect(terminal.stop).toHaveBeenCalledTimes(1);
	});
});
