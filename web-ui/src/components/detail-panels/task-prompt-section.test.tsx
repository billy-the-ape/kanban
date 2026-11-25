import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskPromptSection } from "@/components/detail-panels/task-prompt-section";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/components/app-toaster", () => ({
	showAppToast: vi.fn(),
	notifyError: vi.fn(),
}));

const LONG_PROMPT = [
	"Investigate the flaky suite",
	"",
	"Reproduce it with `npx vitest run test/runtime/trpc/runtime-api.test.ts`, then:",
	"1. find the seed",
	"2. fix the ordering",
	"3. add a regression test that fails without the fix",
	"",
	"Background: the suite used to be deterministic, and the regression arrived with a change to how " +
		"sessions are hydrated after a restart, so the ordering of two awaits swapped under load. Read the " +
		"prior investigation notes before changing anything, and keep the public API of the coordinator as " +
		"it is - other callers depend on the current signature.",
	"",
	"Leave the dispatch behaviour alone.",
].join("\n");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	writeText = vi.fn(async () => {});
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true, writable: true });
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.clearAllMocks();
});

function render(props: Parameters<typeof TaskPromptSection>[0]) {
	act(() =>
		root.render(
			<TooltipProvider>
				<TaskPromptSection {...props} />
			</TooltipProvider>,
		),
	);
}

function expand(): void {
	const trigger = container.querySelector("button[aria-expanded]");
	expect(trigger).toBeTruthy();
	act(() => {
		(trigger as HTMLButtonElement).click();
	});
}

describe("TaskPromptSection (AA-UNSUPPORTED)", () => {
	it("shows the stored prompt with no agent session in sight", () => {
		// The prompt lives on the card, so it survives every state a failed launch
		// leaves behind: no terminal, no Cline transcript, no agent at all.
		render({ prompt: "Fix the login redirect", columnLabel: "In Progress" });

		expect(container.textContent).toContain("Task prompt");
		expect(container.textContent).toContain("In Progress");
		expect(container.textContent).toContain("Fix the login redirect");
	});

	it("keeps a long prompt folded until it is asked for", () => {
		render({ prompt: LONG_PROMPT });

		// Collapsed by default: the detail view must not be swallowed by the prompt
		// the agent already has.
		expect(container.querySelector('[data-testid="task-prompt-text"]')).toBeNull();
		expand();
		const text = container.querySelector('[data-testid="task-prompt-text"]');
		// Expanded shows the whole thing, not a truncated preview.
		expect(text?.textContent).toBe(LONG_PROMPT);
	});

	it("copies the complete prompt", () => {
		render({ prompt: LONG_PROMPT });
		expand();
		act(() => {
			(container.querySelector('button[aria-label="Copy task prompt"]') as HTMLButtonElement).click();
		});

		expect(writeText).toHaveBeenCalledWith(LONG_PROMPT);
	});

	it("offers the edit affordance only for a task that may still be corrected", () => {
		render({ prompt: "Fix the login redirect", canEdit: false, onEdit: vi.fn() });
		expect(container.querySelector('button[aria-label="Edit task prompt and settings"]')).toBeNull();

		render({ prompt: "Fix the login redirect", canEdit: true, onEdit: vi.fn() });
		const edit = container.querySelector('button[aria-label="Edit task prompt and settings"]');
		expect(edit).toBeTruthy();
		act(() => {
			(edit as HTMLButtonElement).click();
		});
	});

	it("renders nothing when the card has no prompt", () => {
		render({ prompt: "   " });
		expect(container.innerHTML).toBe("");
	});
});
