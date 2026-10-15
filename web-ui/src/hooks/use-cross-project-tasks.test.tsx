import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeProjectSummary, RuntimeProjectTaskListItem, RuntimeProjectTasksResponse } from "@/runtime/types";
import type { BoardData } from "@/types";
import {
	type UseCrossProjectTasksInput,
	type UseCrossProjectTasksResult,
	useCrossProjectTasks,
} from "./use-cross-project-tasks";

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: vi.fn(),
}));

function createDeferred<T>() {
	let resolver: ((value: T) => void) | null = null;
	let rejector: ((reason: unknown) => void) | null = null;
	const promise = new Promise<T>((resolve, reject) => {
		resolver = resolve;
		rejector = reject;
	});
	return {
		promise,
		resolve: (value: T) => {
			resolver?.(value);
		},
		reject: (reason: unknown) => {
			rejector?.(reason);
		},
	};
}

let activeDeferred: ReturnType<typeof createDeferred<RuntimeProjectTasksResponse>> =
	createDeferred<RuntimeProjectTasksResponse>();
const queryMock = vi.fn(() => activeDeferred.promise);
const mockedGetRuntimeTrpcClient = vi.mocked(getRuntimeTrpcClient);

function mockNextQuery(): ReturnType<typeof createDeferred<RuntimeProjectTasksResponse>> {
	activeDeferred = createDeferred<RuntimeProjectTasksResponse>();
	mockedGetRuntimeTrpcClient.mockReturnValue({
		projects: { listTasks: { query: queryMock } },
	} as unknown as ReturnType<typeof getRuntimeTrpcClient>);
	return activeDeferred;
}

function createProject(id: string): RuntimeProjectSummary {
	return {
		id,
		name: id,
		path: `/repos/${id}`,
		taskCounts: { backlog: 0, in_progress: 0, paused: 0, review: 0, done: 0, trash: 0 },
	};
}

function createTaskRow(projectId: string, taskId: string, lastActivityAt: number): RuntimeProjectTaskListItem {
	return {
		projectId,
		taskId,
		title: `Task ${taskId}`,
		projectName: projectId,
		displayState: "in_progress",
		lastActivityAt,
	};
}

const EMPTY_BOARD: BoardData = { columns: [], dependencies: [] };
const LOCAL_PROJECT_BOARD: BoardData = {
	columns: [
		{
			id: "in_progress",
			title: "In Progress",
			cards: [
				{
					id: "local-task",
					title: "Local task",
					prompt: "prompt",
					startInPlanMode: false,
					baseRef: "main",
					createdAt: 1,
					updatedAt: 999,
				},
			],
		},
	],
	dependencies: [],
};

const hookResultRef: { current: UseCrossProjectTasksResult | null } = { current: null };

function HookHarness(props: UseCrossProjectTasksInput): null {
	hookResultRef.current = useCrossProjectTasks(props);
	return null;
}

const BASE_INPUT: UseCrossProjectTasksInput = {
	enabled: false,
	projects: [],
	hasReceivedSnapshot: false,
	currentProjectId: null,
	canPersistWorkspaceState: true,
	board: EMPTY_BOARD,
	sessions: {},
};

describe("useCrossProjectTasks", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.useFakeTimers();
		queryMock.mockClear();
		hookResultRef.current = null;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("does not request while disabled and fetches immediately when enabled", async () => {
		await act(async () => {
			root.render(<HookHarness {...BASE_INPUT} />);
		});
		expect(queryMock.mock.calls.length).toBe(0);

		mockNextQuery();
		await act(async () => {
			root.render(<HookHarness {...BASE_INPUT} enabled={true} />);
		});
		expect(queryMock.mock.calls.length).toBe(1);
		expect(hookResultRef.current?.isLoading).toBe(true);
	});

	it("applies the response and clears the loading state", async () => {
		const deferred = mockNextQuery();
		await act(async () => {
			root.render(<HookHarness {...BASE_INPUT} enabled={true} />);
		});
		await act(async () => {
			deferred.resolve({ tasks: [createTaskRow("a", "t1", 100)], unavailableProjectIds: [] });
		});
		expect(hookResultRef.current?.isLoading).toBe(false);
		expect(hookResultRef.current?.tasks?.map((task) => task.taskId)).toEqual(["t1"]);
	});

	it("does not refresh automatically when nothing changes", async () => {
		const deferred = mockNextQuery();
		await act(async () => {
			root.render(<HookHarness {...BASE_INPUT} enabled={true} projects={[createProject("a")]} />);
		});
		await act(async () => {
			deferred.resolve({ tasks: [], unavailableProjectIds: [] });
		});
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(queryMock.mock.calls.length).toBe(1);
	});

	it("coalesces rapid project changes into a single trailing refresh", async () => {
		const first = mockNextQuery();
		await act(async () => {
			root.render(<HookHarness {...BASE_INPUT} enabled={true} projects={[createProject("a")]} />);
		});
		await act(async () => {
			first.resolve({ tasks: [], unavailableProjectIds: [] });
		});
		await act(async () => {
			root.render(
				<HookHarness {...BASE_INPUT} enabled={true} projects={[createProject("a"), createProject("b")]} />,
			);
		});
		await act(async () => {
			root.render(
				<HookHarness
					{...BASE_INPUT}
					enabled={true}
					projects={[createProject("a"), createProject("b"), createProject("c")]}
				/>,
			);
		});
		await act(async () => {
			root.render(
				<HookHarness {...BASE_INPUT} enabled={true} projects={[createProject("a"), createProject("c")]} />,
			);
		});
		expect(queryMock.mock.calls.length).toBe(1);
		const second = mockNextQuery();
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(queryMock.mock.calls.length).toBe(2);
		await act(async () => {
			second.resolve({ tasks: [], unavailableProjectIds: [] });
		});
		// No extra refresh after the coalesced one settles.
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(queryMock.mock.calls.length).toBe(2);
	});

	it("ignores stale responses and queues one current-generation refresh when re-enabled mid-flight", async () => {
		const stale = mockNextQuery();
		await act(async () => {
			root.render(<HookHarness {...BASE_INPUT} enabled={true} />);
		});
		await act(async () => {
			root.render(<HookHarness {...BASE_INPUT} enabled={false} />);
		});
		await act(async () => {
			root.render(<HookHarness {...BASE_INPUT} enabled={true} />);
		});
		expect(queryMock.mock.calls.length).toBe(1);
		const fresh = mockNextQuery();
		// The stale response must not apply, and one fresh request follows it.
		await act(async () => {
			stale.resolve({ tasks: [createTaskRow("a", "stale", 100)], unavailableProjectIds: [] });
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(queryMock.mock.calls.length).toBe(2);
		expect(hookResultRef.current?.tasks).toBeNull();
		await act(async () => {
			fresh.resolve({ tasks: [createTaskRow("a", "fresh", 200)], unavailableProjectIds: [] });
		});
		expect(hookResultRef.current?.tasks?.map((task) => task.taskId)).toEqual(["fresh"]);
	});

	it("reports a first-load failure without stale data", async () => {
		const deferred = mockNextQuery();
		await act(async () => {
			root.render(<HookHarness {...BASE_INPUT} enabled={true} />);
		});
		await act(async () => {
			deferred.reject(new Error("boom"));
		});
		expect(hookResultRef.current?.tasks).toBeNull();
		expect(hookResultRef.current?.error).toBe("Couldn't load tasks.");
	});

	it("keeps the last loaded rows and shows the refresh failure message on a failed refetch", async () => {
		const first = mockNextQuery();
		await act(async () => {
			root.render(<HookHarness {...BASE_INPUT} enabled={true} projects={[createProject("a")]} />);
		});
		await act(async () => {
			first.resolve({ tasks: [createTaskRow("a", "t1", 100)], unavailableProjectIds: [] });
		});
		await act(async () => {
			root.render(
				<HookHarness {...BASE_INPUT} enabled={true} projects={[createProject("a"), createProject("b")]} />,
			);
		});
		const second = mockNextQuery();
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		await act(async () => {
			second.reject(new Error("boom"));
		});
		expect(hookResultRef.current?.tasks?.map((task) => task.taskId)).toEqual(["t1"]);
		expect(hookResultRef.current?.error).toBe("Couldn't refresh tasks. Showing the last loaded tasks.");
	});

	it("overlays the open project's live local rows onto the server rows", async () => {
		const deferred = mockNextQuery();
		await act(async () => {
			root.render(
				<HookHarness
					{...BASE_INPUT}
					enabled={true}
					hasReceivedSnapshot={true}
					currentProjectId="a"
					projects={[createProject("a"), createProject("b")]}
					board={LOCAL_PROJECT_BOARD}
				/>,
			);
		});
		await act(async () => {
			deferred.resolve({
				tasks: [createTaskRow("b", "t-b", 300), createTaskRow("a", "stale-a", 50)],
				unavailableProjectIds: ["a"],
			});
		});
		const tasks = hookResultRef.current?.tasks ?? [];
		expect(tasks.map((task) => task.taskId)).toEqual(["local-task", "t-b"]);
		const localRow = tasks.find((task) => task.taskId === "local-task");
		expect(localRow?.projectId).toBe("a");
		expect(localRow?.title).toBe("Local task");
		// The open project's rows come from local state, so it cannot be unavailable.
		expect(hookResultRef.current?.unavailableProjectIds).toEqual([]);
	});

	it("drops rows for projects that are no longer known after the snapshot", async () => {
		const deferred = mockNextQuery();
		await act(async () => {
			root.render(
				<HookHarness {...BASE_INPUT} enabled={true} hasReceivedSnapshot={true} projects={[createProject("a")]} />,
			);
		});
		await act(async () => {
			deferred.resolve({
				tasks: [createTaskRow("a", "t-a", 100), createTaskRow("gone", "t-gone", 200)],
				unavailableProjectIds: ["gone"],
			});
		});
		expect(hookResultRef.current?.tasks?.map((task) => task.taskId)).toEqual(["t-a"]);
		expect(hookResultRef.current?.unavailableProjectIds).toEqual([]);
	});
});
