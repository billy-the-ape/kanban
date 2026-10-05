import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { TaskPhaseBadge } from "./task-phase-badge";

function session(patch: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task",
		state: "awaiting_review",
		agentId: "cline",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: "error",
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		warningMessage: "Tool recovery exhausted",
		...patch,
	};
}

describe("TaskPhaseBadge errors", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});
	async function render(element: ReactElement) {
		await act(async () => root.render(<TooltipProvider>{element}</TooltipProvider>));
	}

	it("replaces stale impl with red err, including cards moved to review", async () => {
		await render(
			<TaskPhaseBadge
				summary={{ phase: "implementing", needsAttention: false, blockedReason: null }}
				sessionSummary={session()}
				columnId="review"
			/>,
		);
		expect(container.querySelector('[aria-label="Task error"]')?.textContent).toBe("err");
		expect(container.querySelector('[aria-label="Task error"]')?.className).toContain("text-status-red");
		expect(container.textContent).not.toContain("impl");
	});
	it("shows errors without a delivery phase", async () => {
		await render(<TaskPhaseBadge summary={null} sessionSummary={session({ state: "failed", reviewReason: null })} />);
		expect(container.textContent).toBe("err");
	});
	it("clears err when the user starts another turn", async () => {
		await render(<TaskPhaseBadge summary={null} sessionSummary={session()} />);
		await render(
			<TaskPhaseBadge
				summary={{ phase: "implementing", needsAttention: false, blockedReason: null }}
				sessionSummary={session({ state: "running", reviewReason: null, warningMessage: null })}
				columnId="in_progress"
			/>,
		);
		expect(container.textContent).toBe("impl");
	});
});
