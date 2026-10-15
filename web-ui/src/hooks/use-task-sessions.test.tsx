import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskSessions } from "@/hooks/use-task-sessions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard } from "@/types";

const startTaskSessionMutateMock = vi.hoisted(() => vi.fn());
const ensureWorktreeMutateMock = vi.hoisted(() => vi.fn());
const trackTaskResumedFromTrashMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			ensureWorktree: {
				mutate: ensureWorktreeMutateMock,
			},
		},
		runtime: {
			startTaskSession: {
				mutate: startTaskSessionMutateMock,
			},
		},
	}),
}));

vi.mock("@/runtime/task-session-geometry", () => ({
	estimateTaskSessionGeometry: () => ({ cols: 120, rows: 40 }),
}));

vi.mock("@/telemetry/events", () => ({
	trackTaskResumedFromTrash: trackTaskResumedFromTrashMock,
}));

interface HookSnapshot {
	startTaskSession: ReturnType<typeof useTaskSessions>["startTaskSession"];
	ensureTaskWorkspace: ReturnType<typeof useTaskSessions>["ensureTaskWorkspace"];
}

function createTask(): BoardCard {
	return {
		id: "task-1",
		title: "Resume me",
		prompt: "Resume me",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function HookHarness({ onSnapshot }: { onSnapshot: (snapshot: HookSnapshot) => void }): null {
	const sessions = useTaskSessions({
		currentProjectId: "project-1",
		setSessions: () => {},
	});

	useEffect(() => {
		onSnapshot({
			startTaskSession: sessions.startTaskSession,
			ensureTaskWorkspace: sessions.ensureTaskWorkspace,
		});
	}, [onSnapshot, sessions.startTaskSession, sessions.ensureTaskWorkspace]);

	return null;
}

function createSessionSummary(
	taskId: string,
	updatedAt: number,
	finalMessage: string | null,
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: finalMessage ? "awaiting_review" : "running",
		agentId: "cline",
		workspacePath: "/tmp/task-1",
		pid: null,
		startedAt: updatedAt - 100,
		updatedAt,
		lastOutputAt: updatedAt,
		reviewReason: finalMessage ? "hook" : null,
		exitCode: null,
		lastHookAt: updatedAt,
		latestHookActivity: finalMessage
			? {
					activityText: `Final: ${finalMessage}`,
					toolName: null,
					toolInputSummary: null,
					finalMessage,
					hookEventName: "agent_end",
					notificationType: null,
					source: "cline-sdk",
				}
			: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

function StatefulSessionHarness({
	onSessions,
	onUpsert,
}: {
	onSessions: (sessions: Record<string, RuntimeTaskSessionSummary>) => void;
	onUpsert: (upsertSession: (summary: RuntimeTaskSessionSummary) => void) => void;
}): null {
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const hook = useTaskSessions({
		currentProjectId: "project-1",
		setSessions,
	});

	useEffect(() => {
		onSessions(sessions);
	}, [onSessions, sessions]);

	useEffect(() => {
		onUpsert(hook.upsertSession);
	}, [hook.upsertSession, onUpsert]);

	return null;
}

describe("useTaskSessions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		startTaskSessionMutateMock.mockReset();
		ensureWorktreeMutateMock.mockReset();
		trackTaskResumedFromTrashMock.mockReset();
		startTaskSessionMutateMock.mockResolvedValue({
			ok: true,
			summary: {
				taskId: "task-1",
				state: "running",
				agentId: "codex",
				workspacePath: "/tmp/task-1",
				pid: 123,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
			},
		});
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

	it("tracks successful resume-from-trash starts", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession(createTask(), { resumeFromTrash: true });
		});

		expect(trackTaskResumedFromTrashMock).toHaveBeenCalledTimes(1);
	});

	it("treats the never-started ensure refusal as ok so the start can create the worktree", async () => {
		ensureWorktreeMutateMock.mockResolvedValue({
			ok: false,
			path: null,
			baseRef: "main",
			baseCommit: null,
			category: "initial_start_preparation_required",
			error: "Start the task to create its worktree.",
		});
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		let result: Awaited<ReturnType<HookSnapshot["ensureTaskWorkspace"]>> | null = null;
		await act(async () => {
			result = (await latestSnapshot?.ensureTaskWorkspace(createTask())) ?? null;
		});

		expect(result).toEqual({ ok: true });
	});

	it("still reports other ensure failures", async () => {
		ensureWorktreeMutateMock.mockResolvedValue({
			ok: false,
			path: null,
			baseRef: "main",
			baseCommit: null,
			error: "boom",
		});
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		let result: Awaited<ReturnType<HookSnapshot["ensureTaskWorkspace"]>> | null = null;
		await act(async () => {
			result = (await latestSnapshot?.ensureTaskWorkspace(createTask())) ?? null;
		});

		expect(result).toEqual({ ok: false, message: "boom" });
	});

	it("does not track regular task starts", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession(createTask());
		});

		expect(trackTaskResumedFromTrashMock).not.toHaveBeenCalled();
	});

	it("forwards start-in-plan-mode from the task card when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				startInPlanMode: true,
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith({
			taskId: "task-1",
			prompt: "Resume me",
			taskTitle: "Resume me",
			images: undefined,
			startInPlanMode: true,
			resumeFromTrash: undefined,
			baseRef: "main",
			cols: 120,
			rows: 40,
			agentId: undefined,
			clineSettings: undefined,
			// UPD-1: the persisted policy is forwarded; missing values normalize to true.
			updateBaseRefBeforeStart: true,
		});
	});

	it("forwards an explicit false base refresh policy when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				updateBaseRefBeforeStart: false,
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				updateBaseRefBeforeStart: false,
			}),
		);
	});

	it("forwards task images when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			}),
		);
	});

	it("forwards task-level Cline reasoning effort overrides when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				agentId: "cline",
				clineSettings: {
					providerId: "openrouter",
					modelId: "anthropic/claude-opus-4.6",
					reasoningEffort: "low",
				},
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				clineSettings: {
					providerId: "openrouter",
					modelId: "anthropic/claude-opus-4.6",
					reasoningEffort: "low",
				},
			}),
		);
	});

	it("forwards reasoning-only overrides even when provider/model remain inherited", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				clineSettings: {
					reasoningEffort: "high",
				},
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				clineSettings: {
					reasoningEffort: "high",
				},
			}),
		);
	});

	it("lets an incoming summary win an equal-timestamp tie on upsert", () => {
		let latestSessions: Record<string, RuntimeTaskSessionSummary> = {};
		const upsertRef: { current: ((summary: RuntimeTaskSessionSummary) => void) | null } = { current: null };

		act(() => {
			root.render(
				<StatefulSessionHarness
					onSessions={(sessions) => {
						latestSessions = sessions;
					}}
					onUpsert={(upsertSession) => {
						upsertRef.current = upsertSession;
					}}
				/>,
			);
		});

		const upsertSession =
			upsertRef.current ??
			(() => {
				throw new Error("Expected an upsertSession callback.");
			});

		const existing = createSessionSummary("task-1", 1000, null);
		const incoming = createSessionSummary("task-1", 1000, "Tie output");
		act(() => {
			upsertSession(existing);
			upsertSession(incoming);
		});

		expect(latestSessions["task-1"]).toBe(incoming);
	});

	it("does not let a placeholder summary replace a newer real one on upsert", () => {
		let latestSessions: Record<string, RuntimeTaskSessionSummary> = {};
		const upsertRef: { current: ((summary: RuntimeTaskSessionSummary) => void) | null } = { current: null };

		act(() => {
			root.render(
				<StatefulSessionHarness
					onSessions={(sessions) => {
						latestSessions = sessions;
					}}
					onUpsert={(upsertSession) => {
						upsertRef.current = upsertSession;
					}}
				/>,
			);
		});

		const upsertSession =
			upsertRef.current ??
			(() => {
				throw new Error("Expected an upsertSession callback.");
			});

		const real = createSessionSummary("task-1", 1000, null);
		const placeholder: RuntimeTaskSessionSummary = {
			taskId: "task-1",
			state: "idle",
			agentId: null,
			workspacePath: null,
			pid: null,
			startedAt: null,
			updatedAt: 5000,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		};
		act(() => {
			upsertSession(real);
			upsertSession(placeholder);
		});

		expect(latestSessions["task-1"]).toBe(real);
	});
});
