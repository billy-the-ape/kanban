import { describe, expect, it, vi } from "vitest";
import type { ClineTurnOutcome, ClineTurnPreparation } from "../../../src/cline-sdk/cline-turn-preparation";
import { normalizePiHookMetadata } from "../../../src/commands/hook-events/pi-hook-events";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { sendPreparedOpenCodeRepair, sendPreparedPiRepair } from "../../../src/pr-tracking/terminal-repair-dispatch";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

const PI_PASTE_SETTLE_TEST_MS = 200;

function piActivity(
	hookEventName: string,
	notificationType: string | null = null,
): NonNullable<RuntimeTaskSessionSummary["latestHookActivity"]> {
	return {
		activityText: null,
		toolName: null,
		toolInputSummary: null,
		finalMessage: null,
		hookEventName,
		notificationType,
		source: "pi",
	};
}

function createPiManager(args: string[] = []) {
	let summary: RuntimeTaskSessionSummary = {
		taskId: "pi-task",
		state: "awaiting_review",
		agentId: "pi",
		workspacePath: "/tmp/pi-task",
		pid: 123,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		launchAttemptId: "attempt-1",
	};
	let active = true;
	const listeners = new Set<(next: RuntimeTaskSessionSummary) => void>();
	const writes: string[] = [];
	const manager = {
		getLaunchArgs: () => args,
		getSummary: (taskId: string) => (taskId === "pi-task" ? summary : null),
		hasActiveProcess: (taskId: string) => taskId === "pi-task" && active,
		onSummary: (listener: (next: RuntimeTaskSessionSummary) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		writeInput: (taskId: string, bytes: Buffer) => {
			if (taskId !== "pi-task" || !active) return null;
			writes.push(bytes.toString("utf8"));
			return summary;
		},
	} as unknown as TerminalSessionManager;
	return {
		manager,
		writes,
		emit: (change: Partial<RuntimeTaskSessionSummary>) => {
			summary = { ...summary, ...change, updatedAt: Date.now() };
			for (const listener of listeners) listener(summary);
		},
		setActive: (value: boolean) => {
			active = value;
		},
		listeners,
	};
}

function createPreparation(prompt: string | null = "Address the linked PR feedback.") {
	const settled = vi.fn(async (_outcome: ClineTurnOutcome) => {});
	const queued = vi.fn();
	const prepare: ClineTurnPreparation = Object.assign(
		vi.fn(async ({ cwd }: { cwd: string; signal: AbortSignal }) => {
			expect(cwd).toBe("/tmp/pi-task");
			return prompt;
		}),
		{ onQueued: queued, onSettled: settled },
	);
	return { prepare, settled, queued };
}

describe("sendPreparedPiRepair", () => {
	it("submits one prepared turn and settles only on the task's real Pi completion", async () => {
		const pi = createPiManager();
		const { prepare, queued, settled } = createPreparation("Fix review feedback\nAnd push the branch.");
		const restore = vi.fn(async () => ({ ok: true }));
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: restore,
		});
		expect(result.ok).toBe(true);
		expect(restore).not.toHaveBeenCalled();
		expect(queued).toHaveBeenCalledTimes(1);
		expect(pi.writes).toEqual(["\x1b[200~Fix review feedback\nAnd push the branch.\x1b[201~", "\r"]);
		expect(settled).not.toHaveBeenCalled();
		pi.emit({ state: "running", reviewReason: null });
		expect(settled).not.toHaveBeenCalled();
		pi.emit({
			state: "awaiting_review",
			reviewReason: "attention",
			lastHookAt: Date.now(),
			latestHookActivity: piActivity("ui_prompt_start", "permission_prompt"),
		});
		expect(settled).not.toHaveBeenCalled();
		pi.emit({ state: "running", reviewReason: null });
		pi.emit({ state: "awaiting_review", reviewReason: "hook" });
		expect(settled).not.toHaveBeenCalled();
		pi.emit({
			state: "awaiting_review",
			reviewReason: "hook",
			lastHookAt: Date.now(),
			latestHookActivity: piActivity("agent_settled"),
		});
		expect(settled).toHaveBeenCalledExactlyOnceWith({ status: "completed" });
		pi.emit({ state: "awaiting_review", reviewReason: "hook" });
		expect(settled).toHaveBeenCalledTimes(1);
		expect(pi.listeners.size).toBe(0);
	});

	it("settles a clean agent_settled even after stale error or aborted notifications", async () => {
		// Pi's extension sends `--notification-type error` for a routine failed
		// tool call and no notification on the successful `agent_settled`, and
		// an interrupted turn reports `aborted` once. The shared hook merge is
		// sticky, so replay that stream through the production normalizer and
		// the real `applyHookActivity`: the merged activity arriving with the
		// clean `agent_settled` must not carry the stale values, or a repair
		// turn that actually succeeded settles as failed (watermark rolled
		// back, feedback re-sent on Resume).
		const merge = new TerminalSessionManager();
		merge.hydrateFromRecord({
			"pi-task": {
				taskId: "pi-task",
				state: "awaiting_review",
				agentId: "pi",
				workspacePath: "/tmp/pi-task",
				pid: 123,
				startedAt: 1,
				updatedAt: 2,
				lastOutputAt: 2,
				reviewReason: "hook",
				exitCode: null,
				lastHookAt: 1,
				launchAttemptId: "attempt-1",
				latestHookActivity: {
					source: "pi",
					hookEventName: "agent_start",
					notificationType: null,
					activityText: "Pi is working",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
				},
			},
		});
		merge.applyHookActivity(
			"pi-task",
			normalizePiHookMetadata({
				event: "activity",
				sourceHint: "pi",
				flagMetadata: {},
				payload: { hook_event_name: "tool_execution_end", tool_name: "bash", notification_type: "error" },
			}) ?? {},
		);
		expect(merge.getSummary("pi-task")?.latestHookActivity?.notificationType).toBe("error");
		merge.applyHookActivity(
			"pi-task",
			normalizePiHookMetadata({
				event: "to_review",
				sourceHint: "pi",
				flagMetadata: {},
				payload: { hook_event_name: "agent_settled", notification_type: "aborted" },
			}) ?? {},
		);
		expect(merge.getSummary("pi-task")?.latestHookActivity?.notificationType).toBe("aborted");
		const cleanSettle = normalizePiHookMetadata({
			event: "to_review",
			sourceHint: "pi",
			flagMetadata: {},
			payload: { hook_event_name: "agent_settled", final_message: "Pushed the branch." },
		});
		merge.applyHookActivity("pi-task", cleanSettle ?? {});
		const merged = merge.getSummary("pi-task")?.latestHookActivity;
		expect(merged?.hookEventName).toBe("agent_settled");
		expect(merged?.notificationType).not.toBe("error");
		expect(merged?.notificationType).not.toBe("aborted");

		const pi = createPiManager();
		const { prepare, settled } = createPreparation("Fix review feedback");
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => ({ ok: true }),
		});
		expect(result.ok).toBe(true);
		pi.emit({ state: "running", reviewReason: null });
		pi.emit({
			state: "awaiting_review",
			reviewReason: "hook",
			lastHookAt: Date.now(),
			latestHookActivity: merged ?? null,
		});
		expect(settled).toHaveBeenCalledExactlyOnceWith({ status: "completed" });
	});

	it("strips terminal control characters from untrusted PR feedback before bracketed paste", async () => {
		const pi = createPiManager();
		const { prepare, settled } = createPreparation("Please fix\x03 and ignore\x1b[201~\r the issue.");
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => ({ ok: true }),
		});
		expect(result.ok).toBe(true);
		expect(pi.writes[0]).toBe("\x1b[200~Please fix and ignore[201~ the issue.\x1b[201~");
		pi.emit({ state: "running", reviewReason: null });
		pi.emit({
			state: "awaiting_review",
			reviewReason: "hook",
			lastHookAt: Date.now(),
			latestHookActivity: piActivity("agent_settled"),
		});
		expect(settled).toHaveBeenCalledWith({ status: "completed" });
	});

	it("waits for a model slot before pasting an automated repair", async () => {
		const pi = createPiManager();
		const { prepare } = createPreparation("Fix review feedback.");
		const waits: Array<() => Promise<unknown>> = [];
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => ({ ok: true }),
			capacity: async ({ run }) => {
				waits.push(run);
			},
		});
		// The prompt was built, but both model slots were busy, so the automated
		// repair waits behind the same budget as a human turn instead of silently
		// adding a third concurrent request to the model.
		expect(result.ok).toBe(true);
		expect(pi.writes).toEqual([]);
		expect(waits).toHaveLength(1);
		await waits[0]?.();
		expect(pi.writes).toEqual(["\x1b[200~Fix review feedback.\x1b[201~", "\r"]);
	});

	it("settles the receipt when a queued repair never reaches Pi", async () => {
		const pi = createPiManager();
		const { prepare, settled } = createPreparation("Fix review feedback.");
		const abandons: Array<(reason: string) => void> = [];
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => ({ ok: true }),
			capacity: async ({ onNotRun }) => {
				abandons.push(onNotRun);
			},
		});
		// The send returned while the repair still waited for a slot, so the only
		// thing that can close the durable receipt is the gate reporting that the
		// paste will never happen.
		expect(result.ok).toBe(true);
		expect(pi.writes).toEqual([]);
		expect(settled).not.toHaveBeenCalled();
		expect(abandons).toHaveLength(1);
		const listenersBefore = pi.listeners.size;
		expect(listenersBefore).toBeGreaterThan(0);

		abandons[0]?.("The turn was canceled before the model had capacity.");

		expect(settled).toHaveBeenCalledExactlyOnceWith({
			status: "failed",
			error: "The PR repair never reached Pi. The turn was canceled before the model had capacity.",
		});
		// Settling also releases the turn listener, which otherwise runs for the
		// life of the session.
		expect(pi.listeners.size).toBe(0);
	});

	it("fails the receipt if Pi ends with a hook error", async () => {
		const pi = createPiManager();
		const { prepare, settled } = createPreparation();
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => ({ ok: true }),
		});
		expect(result.ok).toBe(true);
		pi.emit({ state: "running", reviewReason: null });
		pi.emit({ state: "awaiting_review", reviewReason: "error" });
		expect(settled).toHaveBeenCalledExactlyOnceWith({
			status: "failed",
			error: "Pi failed during PR repair.",
		});
	});

	it("treats a manual Stop as a failed repair, never a successful review transition", async () => {
		const pi = createPiManager();
		const { prepare, settled } = createPreparation();
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => ({ ok: true }),
		});
		expect(result.ok).toBe(true);
		pi.emit({ state: "running", reviewReason: null });
		pi.setActive(false);
		pi.emit({ state: "awaiting_review", reviewReason: "exit", pid: null, exitCode: 0 });
		expect(settled).toHaveBeenCalledExactlyOnceWith({
			status: "failed",
			error: "Pi's task process stopped before the PR repair completed.",
		});
	});

	it("accepts a later startup hook when Pi session_start has already been superseded", async () => {
		const pi = createPiManager();
		pi.setActive(false);
		const { prepare, settled } = createPreparation();
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => {
				pi.setActive(true);
				pi.emit({
					lastHookAt: Date.now(),
					latestHookActivity: {
						source: "pi",
						hookEventName: "model_select",
						activityText: "Model selected",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						notificationType: null,
					},
				});
				return { ok: true };
			},
		});
		expect(result.ok).toBe(true);
		expect(pi.writes).toHaveLength(2);
		pi.emit({ state: "running", reviewReason: null });
		pi.emit({
			state: "awaiting_review",
			reviewReason: "hook",
			lastHookAt: Date.now(),
			latestHookActivity: piActivity("agent_settled"),
		});
		expect(settled).toHaveBeenCalledWith({ status: "completed" });
	});

	it("never sends feedback when exact-session restoration fails", async () => {
		const pi = createPiManager();
		pi.setActive(false);
		const { prepare, queued } = createPreparation();
		const restore = vi.fn(async () => ({ ok: false, error: "no matching JSONL" }));
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: restore,
		});
		expect(result).toMatchObject({ ok: false, error: "no matching JSONL" });
		expect(restore).toHaveBeenCalledOnce();
		expect(queued).not.toHaveBeenCalled();
		expect(pi.writes).toEqual([]);
	});

	it("holds feedback after a recovered mid-turn crash until a human reconciles it", async () => {
		const pi = createPiManager();
		pi.emit({ state: "interrupted", reviewReason: "interrupted" });
		const { prepare, queued } = createPreparation();
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => ({ ok: true }),
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not in Review");
		expect(queued).not.toHaveBeenCalled();
		expect(pi.writes).toEqual([]);
	});

	it("fails a turn that never starts, releasing its completion observer", async () => {
		vi.useFakeTimers();
		try {
			const pi = createPiManager();
			const { prepare, settled } = createPreparation();
			const resultPromise = sendPreparedPiRepair({
				manager: pi.manager,
				taskId: "pi-task",
				prepare,
				restoreSavedSession: async () => ({ ok: true }),
			});
			await vi.advanceTimersByTimeAsync(PI_PASTE_SETTLE_TEST_MS);
			const result = await resultPromise;
			expect(result.ok).toBe(true);
			expect(settled).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(60_001);
			expect(settled).toHaveBeenCalledWith({
				status: "failed",
				error: "Pi did not start the PR repair turn within 60 seconds.",
			});
			expect(pi.listeners.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails an interruption even when no agent_start hook arrived", async () => {
		const pi = createPiManager();
		const { prepare, settled } = createPreparation();
		const response = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => ({ ok: true }),
		});
		expect(response.ok).toBe(true);
		pi.emit({ state: "interrupted", reviewReason: "interrupted" });
		expect(settled).toHaveBeenCalledWith({
			status: "failed",
			error: "Pi's PR repair session was interrupted before completion.",
		});
	});

	it("does not inject into an agent already running a different turn", async () => {
		const pi = createPiManager();
		pi.emit({ state: "running", reviewReason: null });
		const { prepare, queued } = createPreparation();
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => ({ ok: true }),
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not in Review");
		expect(queued).not.toHaveBeenCalled();
		expect(pi.writes).toEqual([]);
	});

	it("does not inject a repair into a Pi extension dialog", async () => {
		const pi = createPiManager();
		pi.emit({
			state: "awaiting_review",
			reviewReason: "attention",
			lastHookAt: Date.now(),
			latestHookActivity: piActivity("ui_prompt_start", "permission_prompt"),
		});
		const { prepare, queued } = createPreparation();
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => ({ ok: true }),
		});
		expect(result.ok).toBe(false);
		expect(queued).not.toHaveBeenCalled();
		expect(pi.writes).toEqual([]);
	});

	it("awaits the durable settle before reporting a post-prepare send failure", async () => {
		// The service writes the failed dispatch the moment this function
		// returns; the `onSettled` watermark rollback must land first, or
		// `setDispatchFailed` sees a mismatched status, skips the rollback,
		// and the advanced watermark silently drops the batch on Resume.
		const pi = createPiManager();
		let rollbackLanded = false;
		const settled = vi.fn(async (_outcome: ClineTurnOutcome) => {
			await Promise.resolve();
			rollbackLanded = true;
		});
		const prepare: ClineTurnPreparation = Object.assign(
			vi.fn(async () => {
				// Preparation succeeded (the watermark advanced), then the user
				// typed in the PTY during the git refresh: Pi left Review.
				pi.setActive(false);
				return "Fix review feedback";
			}),
			{ onQueued: vi.fn(), onSettled: settled },
		);
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => ({ ok: true }),
		});
		expect(result.ok).toBe(false);
		expect(rollbackLanded).toBe(true);
		expect(settled).toHaveBeenCalledWith({
			status: "failed",
			error: "Pi began another turn or changed sessions during PR repair preparation.",
		});
		expect(pi.writes).toEqual([]);
	});

	it("skips an obsolete prepared prompt without sending terminal input", async () => {
		const pi = createPiManager();
		const { prepare, settled } = createPreparation(null);
		const result = await sendPreparedPiRepair({
			manager: pi.manager,
			taskId: "pi-task",
			prepare,
			restoreSavedSession: async () => ({ ok: true }),
		});
		expect(result.ok).toBe(true);
		expect(pi.writes).toEqual([]);
		expect(settled).toHaveBeenCalledExactlyOnceWith({ status: "skipped" });
	});
});

describe("sendPreparedOpenCodeRepair", () => {
	it("accepts one repair and requires a completed hook from the same session", async () => {
		const terminal = createPiManager();
		const { prepare, settled } = createPreparation();
		const input = { manager: terminal.manager, taskId: "pi-task", prepare };
		terminal.emit({ agentId: "opencode", externalSessionId: "ses_opencode" });
		expect((await sendPreparedOpenCodeRepair(input)).ok).toBe(true);
		expect((await sendPreparedOpenCodeRepair(input)).ok).toBe(false);

		const hook = (notificationType: string) => ({
			...piActivity("session.status", notificationType),
			source: "opencode",
		});
		terminal.emit({ state: "running", lastHookAt: Date.now(), latestHookActivity: hook("turn.started") });
		terminal.emit({
			state: "awaiting_review",
			reviewReason: "attention",
			lastHookAt: Date.now(),
			latestHookActivity: hook("permission.asked"),
		});
		expect(settled).not.toHaveBeenCalled();
		terminal.emit({
			externalSessionId: "ses_other",
			reviewReason: "hook",
			lastHookAt: Date.now(),
			latestHookActivity: hook("turn.completed"),
		});
		expect(settled).not.toHaveBeenCalled();
		terminal.emit({ externalSessionId: "ses_opencode", lastHookAt: Date.now() });
		expect(settled).toHaveBeenCalledExactlyOnceWith({ status: "completed" });
		expect(terminal.writes).toHaveLength(2);
	});

	it("leaves the prompt untouched in a plan session", async () => {
		const terminal = createPiManager(["--agent", "plan"]);
		const { prepare } = createPreparation();
		terminal.emit({ agentId: "opencode", externalSessionId: "ses_opencode" });
		const response = await sendPreparedOpenCodeRepair({ manager: terminal.manager, taskId: "pi-task", prepare });
		expect(response.ok).toBe(false);
		expect(prepare).not.toHaveBeenCalled();
		expect(terminal.writes).toEqual([]);
	});
});
