import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseTaskQualitySummaryResult, useTaskQualitySummary } from "@/hooks/use-task-quality-summary";
import type { RuntimeTaskQualitySummaryResponse } from "@/runtime/types";

const fetchTaskQualitySummaryMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/task-quality-summary", () => ({
	fetchTaskQualitySummary: fetchTaskQualitySummaryMock,
}));

type HookSnapshot = UseTaskQualitySummaryResult;

interface HookState {
	snapshot: HookSnapshot | null;
}

/** Non-null snapshot accessor (property-based state: survives TS control-flow resets). */
function latest(state: HookState, label: string): HookSnapshot {
	if (state.snapshot === null) {
		throw new Error(label);
	}
	return state.snapshot;
}

function createQualitySummaryResponse(
	overrides: Partial<RuntimeTaskQualitySummaryResponse> = {},
): RuntimeTaskQualitySummaryResponse {
	return {
		ok: true,
		taskId: "task-1",
		capturedAt: 1760246400000,
		reducerVersion: 1,
		coverage: { status: "complete", reasons: [], warnings: [] },
		timing: {
			firstRecordedStart: null,
			lastRecordedEnd: null,
			openSegmentCount: 0,
			invalidIntervalCount: 0,
			recordedSessionSpanMs: null,
			coveredSegmentCount: 0,
			totalSegmentCount: 0,
		},
		sessionCounts: { working: 1, review: 0, verificationRepair: 0, distinctSessions: 1 },
		ambiguities: [],
		models: { pairs: [], mixedModels: false },
		responses: { assistantResponses: 2, withReportedMetrics: 2, peakReportedInput: 100 },
		usage: {
			inputTokens: { total: 500, coverage: 1 },
			outputTokens: { total: 120, coverage: 1 },
			cacheReadTokens: { total: null, coverage: 0 },
			cacheWriteTokens: { total: null, coverage: 0 },
		},
		tools: {
			totalCalls: 3,
			byName: { editor: 2, run_commands: 1 },
			reportedFailures: 1,
			unmatchedCalls: 0,
			truncatedResults: 0,
		},
		retries: { unchangedFailedRetries: 1 },
		heuristicTags: {},
		liveTailExcluded: false,
		evidence: [],
		sessionSource: null,
		terminalSummaryAvailable: false,
		sourceWarning: null,
		error: null,
		...overrides,
	};
}

function HookHarness({
	workspaceId,
	taskId,
	state,
}: {
	workspaceId: string | null;
	taskId: string | null;
	state: HookState;
}): null {
	const snapshot = useTaskQualitySummary(workspaceId, taskId);

	useEffect(() => {
		state.snapshot = snapshot;
	}, [state, snapshot]);

	return null;
}

describe("useTaskQualitySummary", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		fetchTaskQualitySummaryMock.mockReset();
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

	function renderHarness(workspaceId: string | null, taskId: string | null, state: HookState): void {
		root.render(<HookHarness workspaceId={workspaceId} taskId={taskId} state={state} />);
	}

	it("fetches nothing on mount and loads the summary on demand", async () => {
		fetchTaskQualitySummaryMock.mockResolvedValue(createQualitySummaryResponse());
		const state: HookState = { snapshot: null };

		await act(async () => {
			renderHarness("workspace-1", "task-1", state);
			await Promise.resolve();
		});

		// On-demand only: no fetch on mount.
		expect(fetchTaskQualitySummaryMock).not.toHaveBeenCalled();
		expect(state.snapshot?.summary).toBeNull();
		expect(state.snapshot?.isLoading).toBe(false);

		await act(async () => {
			latest(state, "Expected a hook snapshot.").load();
			await Promise.resolve();
		});

		expect(fetchTaskQualitySummaryMock).toHaveBeenCalledWith("workspace-1", "task-1");
		const loaded = latest(state, "Expected a loaded summary.");
		expect(loaded.summary?.taskId).toBe("task-1");
		expect(loaded.summary?.coverage.status).toBe("complete");
		expect(loaded.summary?.tools.totalCalls).toBe(3);
		expect(loaded.error).toBeNull();
		expect(loaded.isLoading).toBe(false);
	});

	it("surfaces a transport failure as an explicit error without inventing data", async () => {
		fetchTaskQualitySummaryMock.mockResolvedValue(null);
		const state: HookState = { snapshot: null };

		await act(async () => {
			renderHarness("workspace-1", "task-1", state);
			await Promise.resolve();
		});

		await act(async () => {
			latest(state, "Expected a hook snapshot.").load();
			await Promise.resolve();
		});
		const failed = latest(state, "Expected a hook snapshot.");
		expect(failed.summary).toBeNull();
		expect(failed.error).toBe("The recorded summary request failed.");
		expect(failed.isLoading).toBe(false);
	});

	it("ignores a stale response after the task changes while a request is pending", async () => {
		let releaseFirst: (response: RuntimeTaskQualitySummaryResponse) => void = () => {};
		const firstGate = new Promise<RuntimeTaskQualitySummaryResponse>((resolve) => {
			releaseFirst = resolve;
		});
		fetchTaskQualitySummaryMock.mockImplementation((_workspaceId: string | null, taskId: string) => {
			if (taskId === "task-1") {
				return firstGate;
			}
			return Promise.resolve(
				createQualitySummaryResponse({
					taskId: "task-2",
					sessionCounts: { working: 2, review: 0, verificationRepair: 0, distinctSessions: 2 },
				}),
			);
		});
		const state: HookState = { snapshot: null };

		await act(async () => {
			renderHarness("workspace-1", "task-1", state);
			await Promise.resolve();
		});

		await act(async () => {
			latest(state, "Expected a hook snapshot.").load();
			await Promise.resolve();
		});
		expect(fetchTaskQualitySummaryMock).toHaveBeenCalledTimes(1);

		// The operator switches tasks while task-1's analysis is in flight.
		await act(async () => {
			renderHarness("workspace-1", "task-2", state);
			await Promise.resolve();
		});
		// The pending summary is reset for the new selection.
		expect(state.snapshot?.summary).toBeNull();

		await act(async () => {
			latest(state, "Expected a hook snapshot.").load();
			await Promise.resolve();
		});
		expect(fetchTaskQualitySummaryMock).toHaveBeenCalledTimes(2);
		expect(state.snapshot?.summary?.taskId).toBe("task-2");

		// Resolve the stale task-1 response: it must be ignored.
		await act(async () => {
			releaseFirst(createQualitySummaryResponse({ taskId: "task-1" }));
			await Promise.resolve();
		});
		expect(state.snapshot?.summary?.taskId).toBe("task-2");
	});

	it("refreshes an existing snapshot in place (isRefreshing) and resets on workspace change", async () => {
		const releases: Array<(response: RuntimeTaskQualitySummaryResponse) => void> = [];
		fetchTaskQualitySummaryMock.mockImplementation(
			() =>
				new Promise<RuntimeTaskQualitySummaryResponse>((resolve) => {
					releases.push(resolve);
				}),
		);
		const state: HookState = { snapshot: null };

		await act(async () => {
			renderHarness("workspace-1", "task-1", state);
			await Promise.resolve();
		});
		await act(async () => {
			latest(state, "Expected a hook snapshot.").load();
			releases[0]?.(createQualitySummaryResponse());
			await Promise.resolve();
		});
		expect(state.snapshot?.summary).not.toBeNull();
		expect(state.snapshot?.isRefreshing).toBe(false);

		// A second load while a summary is present is a refresh.
		await act(async () => {
			latest(state, "Expected a hook snapshot.").load();
		});
		expect(state.snapshot?.isRefreshing).toBe(true);
		expect(state.snapshot?.summary).not.toBeNull();

		await act(async () => {
			releases[1]?.(createQualitySummaryResponse());
			await Promise.resolve();
		});
		expect(state.snapshot?.isRefreshing).toBe(false);
		expect(state.snapshot?.summary).not.toBeNull();

		// Switching workspaces resets the snapshot.
		await act(async () => {
			renderHarness("workspace-2", "task-1", state);
			await Promise.resolve();
		});
		expect(state.snapshot?.summary).toBeNull();
	});
});
