import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { buildShellCommandLine } from "../../../src/core/shell";
import { MODEL_CAPACITY_WAIT_HOOK_EVENT_NAME } from "../../../src/core/task-display-state";
import { isDetachedPiRestoreCandidate } from "../../../src/terminal/pi-session-restore";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import type { HookReviewReason } from "../../../src/terminal/session-state-machine";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

describe("TerminalSessionManager", () => {
	it("clears trust prompt state when transitioning to review", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ state: "running", reviewReason: null }),
			active: {
				workspaceTrustBuffer: "trust this folder",
				awaitingCodexPromptAfterEnter: true,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		const applySessionEvent = (
			manager as unknown as {
				applySessionEvent: (
					sessionEntry: unknown,
					event: { type: "hook.to_review"; reason: HookReviewReason },
				) => RuntimeTaskSessionSummary;
			}
		).applySessionEvent;
		const nextSummary = applySessionEvent(entry, { type: "hook.to_review", reason: "hook" });
		expect(nextSummary.state).toBe("awaiting_review");
		expect(nextSummary.reviewReason).toBe("hook");
		expect(entry.active.workspaceTrustBuffer).toBe("");
	});

	it("parks a hook review with the reason the integration reported", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({ "task-1": createSummary({ state: "running" }) });

		// A parked approval and a failed turn are different things to the human, and
		// both have to leave the running state. Accepting the reason at the door and
		// then dropping it made these two calls silent no-ops, so the card kept
		// reading as a working task while the agent waited or had already failed.
		const attention = manager.transitionToReview("task-1", "attention");
		expect(attention?.state).toBe("awaiting_review");
		expect(attention?.reviewReason).toBe("attention");

		// Answering the approval has to be able to move the card again, and that only
		// works while the recorded reason is one a paused turn may return from.
		const resumed = manager.transitionToRunning("task-1");
		expect(resumed?.state).toBe("running");
		expect(resumed?.reviewReason).toBeNull();

		const failed = manager.transitionToReview("task-1", "error");
		expect(failed?.state).toBe("awaiting_review");
		expect(failed?.reviewReason).toBe("error");

		// An ordinary finished turn keeps the reason it always had.
		manager.transitionToRunning("task-1");
		expect(manager.transitionToReview("task-1", "hook")?.reviewReason).toBe("hook");
	});

	it("records only a new bounded external session id", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({ "task-1": createSummary({ state: "running" }) });

		expect(manager.applyExternalSessionId("task-1", " ses_08f7c2a9b1eF4d ")?.externalSessionId).toBe(
			"ses_08f7c2a9b1eF4d",
		);

		// Re-reporting the same conversation is a no-op, and so is anything unusable:
		// a misbehaving integration must not grow the state file or blank the session
		// the card resumes by.
		for (const unusableId of ["ses_08f7c2a9b1eF4d", "   ", "x".repeat(201)]) {
			expect(manager.applyExternalSessionId("task-1", unusableId)?.externalSessionId).toBe("ses_08f7c2a9b1eF4d");
		}
	});

	it("builds shell kickoff command lines with quoted arguments", () => {
		const commandLine = buildShellCommandLine("cline", ["--auto-approve-all", "hello world"]);
		expect(commandLine).toContain("cline");
		expect(commandLine).toContain("--auto-approve-all");
		expect(commandLine).toContain("hello world");
	});

	it("stores hook activity metadata on sessions", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const updated = manager.applyHookActivity("task-1", {
			source: "claude",
			activityText: "Using Read",
			toolName: "Read",
		});

		expect(updated?.latestHookActivity?.source).toBe("claude");
		expect(updated?.latestHookActivity?.activityText).toBe("Using Read");
		expect(updated?.latestHookActivity?.toolName).toBe("Read");
		expect(typeof updated?.lastHookAt).toBe("number");
	});

	it("resets stale running sessions without active processes", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const recovered = manager.recoverStaleSession("task-1");

		expect(recovered?.state).toBe("idle");
		expect(recovered?.pid).toBeNull();
		expect(recovered?.agentId).toBe("claude");
		expect(recovered?.workspacePath).toBeNull();
		expect(recovered?.reviewReason).toBeNull();
	});
	it("records a capacity wait as an idle waiting summary and settles it", () => {
		const manager = new TerminalSessionManager();
		const emitted: RuntimeTaskSessionSummary[] = [];
		manager.onSummary((summary) => {
			emitted.push(summary);
		});

		const waiting = manager.recordModelCapacityWait({
			taskId: "task-1",
			agentId: "pi",
			workspacePath: "/tmp/worktree",
			queuePosition: 2,
		});
		expect(waiting.state).toBe("idle");
		expect(waiting.pid).toBeNull();
		expect(waiting.agentId).toBe("pi");
		expect(waiting.warningMessage).toContain("model slot");
		// The record says why the card is idle, in the vocabulary a queued
		// Cline turn already uses. Only a Cline queue may hand a card back to
		// Backlog, so the Pi wait never advertises that affordance.
		expect(waiting.latestHookActivity?.hookEventName).toBe("concurrency_waiting");
		expect(waiting.latestHookActivity?.queuePosition).toBe(2);
		expect(waiting.latestHookActivity?.canReturnToBacklog).toBe(false);
		// The card, the terminal viewer, and Stop all read this record, so it has
		// to reach the browser through the same summary stream a real launch uses.
		expect(emitted.at(-1)?.warningMessage).toBe(waiting.warningMessage);
		// A process-less waiting record must never look like a Pi conversation the
		// guarded exact-session restore is allowed to reattach.
		expect(isDetachedPiRestoreCandidate(waiting)).toBe(false);

		// A queued CLI that could not spawn has to say so on the card, while the
		// Stop that canceled a wait is a plain idle card, not a failure.
		const failed = manager.settleModelCapacityWait("task-1", "Failed to launch pi.");
		expect(failed?.state).toBe("failed");
		expect(failed?.reviewReason).toBe("error");
		expect(failed?.warningMessage).toBe("Failed to launch pi.");
		const canceled = manager.settleModelCapacityWait("task-1", null);
		expect(canceled?.state).toBe("idle");
		expect(canceled?.reviewReason).toBeNull();
		expect(canceled?.warningMessage).toBeNull();
		// Either way the wait is over, so nothing may keep claiming the card is
		// queued: that marker is what the card and diagnostics read.
		expect(failed?.latestHookActivity).toBeNull();
		expect(canceled?.latestHookActivity).toBeNull();
		expect(manager.settleModelCapacityWait("missing-task", null)).toBeNull();
	});

	it("marks a live session waiting for model capacity without ending its turn", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({ "task-1": createSummary({ agentId: "pi", state: "running", pid: 4242 }) });
		const emitted: RuntimeTaskSessionSummary[] = [];
		manager.onSummary((summary) => {
			emitted.push(summary);
		});

		const waiting = manager.markTurnCapacityWait({ taskId: "task-1", queuePosition: 2 });

		// A follow-up waits on a real running session, unlike a queued initial start
		// that has no process yet: state and pid have to survive the annotation or
		// the card would read as ended while its CLI is still there.
		expect(waiting.state).toBe("running");
		expect(waiting.pid).toBe(4242);
		expect(waiting.latestHookActivity?.hookEventName).toBe(MODEL_CAPACITY_WAIT_HOOK_EVENT_NAME);
		expect(waiting.latestHookActivity?.queuePosition).toBe(2);
		expect(waiting.warningMessage).toContain("Waiting");
		expect(emitted).toHaveLength(1);

		// Once Pi's own turn hook lands the marker is gone, and a late clear from
		// the capacity gate must never erase the activity that replaced it - only
		// the warning the wait itself wrote.
		// Pi derives its own activity text from the hook event, so this is what a
		// real Pi tool hook leaves behind a few milliseconds after the write.
		manager.applyHookActivity("task-1", { source: "pi", hookEventName: "tool_execution_end", toolName: "Read" });
		const resumed = manager.clearTurnCapacityWait("task-1");
		expect(resumed?.latestHookActivity?.hookEventName).toBe("tool_execution_end");
		expect(resumed?.latestHookActivity?.toolName).toBe("Read");
		expect(resumed?.warningMessage).toBeNull();

		// A canceled or failed wait clears only its own marker and reports why.
		manager.markTurnCapacityWait({ taskId: "task-1", queuePosition: 1 });
		const failed = manager.clearTurnCapacityWait("task-1", "Task session is not running.");
		expect(failed?.latestHookActivity).toBeNull();
		expect(failed?.warningMessage).toBe("Task session is not running.");
		expect(manager.clearTurnCapacityWait("missing-task")).toBeNull();
	});

	it("keeps a hydrated Pi record restorable when the terminal attaches first", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({
				agentId: "pi",
				state: "running",
				latestTurnCheckpoint: {
					turn: 3,
					ref: "refs/kanban/checkpoints/task-1/turn/3",
					commit: "abc1234",
					createdAt: 3,
				},
				previousTurnCheckpoint: null,
			}),
		});

		// Opening the task detail attaches the terminal websocket in the same render
		// that asks the runtime API to reattach the saved Pi conversation, so this
		// recovery usually runs first. Wiping the record to `idle` stranded the card
		// on "No interrupted Pi process exists"; it now settles into the same
		// restore-pending shape a graceful shutdown writes.
		const recovered = manager.recoverStaleSession("task-1");

		expect(recovered?.state).toBe("interrupted");
		expect(recovered?.reviewReason).toBe("interrupted");
		expect(recovered?.pid).toBeNull();
		expect(recovered?.workspacePath).toBe("/tmp/worktree");
		expect(recovered?.latestTurnCheckpoint?.commit).toBe("abc1234");
		expect(isDetachedPiRestoreCandidate(recovered)).toBe(true);
	});

	it("still resets a hydrated Pi record whose process already ended", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ agentId: "pi", state: "awaiting_review", reviewReason: "exit", pid: null }),
		});

		// An intentional Stop is not a session Kanban lost, so the destructive
		// reset still applies and the guarded restore keeps refusing.
		const recovered = manager.recoverStaleSession("task-1");

		expect(recovered?.state).toBe("idle");
		expect(recovered?.agentId).toBe("pi");
		expect(isDetachedPiRestoreCandidate(recovered)).toBe(false);
	});

	it("tracks only the latest two turn checkpoints", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		manager.applyTurnCheckpoint("task-1", {
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: 1,
		});
		manager.applyTurnCheckpoint("task-1", {
			turn: 2,
			ref: "refs/kanban/checkpoints/task-1/turn/2",
			commit: "2222222",
			createdAt: 2,
		});

		const summary = manager.getSummary("task-1");
		expect(summary?.latestTurnCheckpoint?.turn).toBe(2);
		expect(summary?.previousTurnCheckpoint?.turn).toBe(1);
	});

	it("does not replay raw PTY history when attaching an output listener", () => {
		const manager = new TerminalSessionManager();
		const onOutput = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-probe", state: "running" }),
			active: {
				session: {},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-probe", entry);

		manager.attach("task-probe", {
			onOutput,
		});

		expect(onOutput).not.toHaveBeenCalled();
		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(false);
	});

	it("keeps the startup probe filter enabled when only a non-output listener attaches", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ taskId: "task-control-first", state: "running" }),
			active: {
				session: {
					write: vi.fn(),
				},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-control-first", entry);

		manager.attach("task-control-first", {
			onState: vi.fn(),
			onExit: vi.fn(),
		});

		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(true);
		expect(entry.active.terminalProtocolFilter.pendingChunk).toBeNull();
	});

	it("forwards pixel dimensions through resize when provided", () => {
		const manager = new TerminalSessionManager();
		const resizeSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-resize", state: "running" }),
			active: {
				session: {
					resize: resizeSpy,
				},
				cols: 80,
				rows: 24,
			},
			terminalStateMirror: {
				resize: resizeMirrorSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-resize", entry);

		const resized = manager.resize("task-resize", 100, 30, 1200, 720);
		expect(resized).toBe(true);
		expect(resizeSpy).toHaveBeenCalledWith(100, 30, 1200, 720);
		expect(resizeMirrorSpy).toHaveBeenCalledWith(100, 30);
	});

	it("returns the latest terminal restore snapshot when available", async () => {
		const manager = new TerminalSessionManager();
		const getSnapshotSpy = vi.fn(async () => ({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		}));
		const entry = {
			summary: createSummary({ taskId: "task-restore", state: "running" }),
			active: null,
			terminalStateMirror: {
				getSnapshot: getSnapshotSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-restore", entry);

		const snapshot = await manager.getRestoreSnapshot("task-restore");

		expect(snapshot).toEqual({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		});
		expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
	});

	it("asks the workspace to drop queued claims when every session is stopped", () => {
		// A capacity wait has no process, so bulk stop cannot reach it. The listener
		// (paired with the Pi capacity gate in the composition root) runs
		// synchronously here, before a stopped process can free a model slot and
		// admit a new CLI against a manager that is being torn down.
		const manager = new TerminalSessionManager();
		let drops = 0;
		manager.setOnBulkStop(() => {
			drops += 1;
		});
		expect(drops).toBe(0);
		expect(manager.markInterruptedAndStopAll()).toEqual([]);
		expect(drops).toBe(1);
	});
});
