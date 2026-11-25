import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskLaunchFailureBanner } from "@/components/detail-panels/task-launch-failure-banner";
import type { RuntimeTaskLaunchRecoveryResponse } from "@/runtime/types";

vi.mock("@/components/app-toaster", () => ({
	showAppToast: vi.fn(),
	notifyError: vi.fn(),
}));

function createRecovery(overrides: Partial<RuntimeTaskLaunchRecoveryResponse> = {}): RuntimeTaskLaunchRecoveryResponse {
	return {
		ok: true,
		taskId: "task-1",
		recoverable: true,
		neverLaunched: true,
		agentId: "pi",
		prompt: "Investigate the flaky suite",
		reason: null,
		settingsError: null,
		launchFailure: null,
		...overrides,
	};
}

function buttonTexts(): string[] {
	return Array.from(container.querySelectorAll("button")).map((entry) => entry.textContent ?? "");
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.clearAllMocks();
});

function renderBanner(props: Parameters<typeof TaskLaunchFailureBanner>[0]) {
	act(() => root.render(<TaskLaunchFailureBanner {...props} />));
}

describe("TaskLaunchFailureBanner (AA-UNSUPPORTED)", () => {
	it("names the state instead of leaving a prepared task looking paused", () => {
		renderBanner({
			recovery: createRecovery(),
			onRecover: vi.fn(),
			onEditSettings: vi.fn(),
		});

		// The whole point: a card with a worktree and no agent session says so out
		// loud, and offers the recovery that reuses that worktree.
		expect(container.textContent).toContain("never started an agent");
		expect(buttonTexts().some((text) => text.includes("Start with saved prompt"))).toBe(true);
		expect(container.textContent).toContain("saved baseline");
	});

	it("relaunches on request", () => {
		const onRecover = vi.fn(async () => true);
		renderBanner({
			recovery: createRecovery(),
			onRecover,
			onEditSettings: vi.fn(),
		});

		const button = Array.from(container.querySelectorAll("button")).find((entry) =>
			entry.textContent?.includes("Start with saved prompt"),
		);
		expect(button).toBeDefined();
		act(() => {
			button?.click();
		});
		expect(onRecover).toHaveBeenCalledTimes(1);
	});

	it("points at the setting that has to be corrected first", () => {
		renderBanner({
			recovery: createRecovery({
				recoverable: false,
				settingsError:
					"Pi does not support plan mode. Remove it from this task, or pick an agent that supports it.",
				reason:
					"Fix the task settings first: Pi does not support plan mode. Remove it from this task, or pick an agent that supports it.",
			}),
			onRecover: vi.fn(),
			onEditSettings: vi.fn(),
		});

		expect(container.textContent).toContain("plan mode");
		// The correction is a task edit, and that button is the way there — the
		// doomed launch is not offered again.
		expect(buttonTexts().some((text) => text.includes("Edit launch settings"))).toBe(true);
		expect(buttonTexts().some((text) => text.includes("Start with saved prompt"))).toBe(false);
	});

	it("keeps an interrupted session out of the unstarted path", () => {
		// A conversation to restore is not an unstarted task: relaunching would
		// begin a second conversation, and the terminal already offers Restore.
		renderBanner({
			recovery: createRecovery({
				recoverable: false,
				neverLaunched: false,
				reason: "This task has an agent conversation to restore; use Restore instead of relaunching.",
			}),
			onRecover: vi.fn(),
			onEditSettings: vi.fn(),
		});

		expect(container.innerHTML).toBe("");
	});

	it("shows a persisted launch failure that outlived the toast", () => {
		renderBanner({
			recovery: null,
			launchFailure: 'Agent failed to start: could not run "pi" - command not found.',
		});

		expect(container.textContent).toContain("The agent session failed");
		expect(container.textContent).toContain("command not found");
	});

	it("renders nothing for a task that is working normally", () => {
		renderBanner({
			recovery: createRecovery({ recoverable: false, neverLaunched: false, reason: null }),
			onRecover: vi.fn(),
			onEditSettings: vi.fn(),
		});

		expect(container.innerHTML).toBe("");
	});
});
