// Terminal agents prepare review feedback immediately before submitting to the
// task's idle terminal, then settle the dispatch using the agent's turn hooks.
import type { ClineTurnOutcome, ClineTurnPreparation } from "../cline-sdk/cline-turn-preparation";
import type { RuntimeTaskChatSendResponse, RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TerminalSessionManager } from "../terminal/session-manager";

const PI_READY_TIMEOUT_MS = 15_000;
const REPAIR_TURN_START_TIMEOUT_MS = 60_000;
const REPAIR_TURN_TIMEOUT_MS = 60 * 60_000;
const REPAIR_PASTE_SETTLE_MS = 200;

/**
 * Keep printable Unicode, tabs, and line breaks. Exclude terminal control
 * characters from untrusted GitHub feedback so they cannot break the
 * bracketed-paste frame or inject terminal shortcuts.
 */
function stripTerminalControls(prompt: string): string {
	return Array.from(prompt)
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code === 9 || code === 10 || (code >= 32 && code !== 127 && (code < 128 || code > 159));
		})
		.join("");
}

export interface PiPreparedRepairInput {
	manager: TerminalSessionManager;
	taskId: string;
	prepare: ClineTurnPreparation;
	/** Only exact-session restoration is allowed; never replay the last prompt. */
	restoreSavedSession: () => Promise<{ ok: boolean; error?: string }>;
	/**
	 * Model-capacity seam for the repair turn. The runtime hands in the shared Pi
	 * capacity gate so an automated repair waits behind the same per-model budget
	 * as a human turn instead of silently adding a third concurrent request to
	 * the model. Omitted only by harnesses that have no capacity queue.
	 */
	capacity?: PiRepairTurnCapacity;
}

type PiRepairTurnCapacity = (input: {
	taskId: string;
	manager: TerminalSessionManager;
	/**
	 * How the gate reports a queued repair that never reached Pi: the wait was
	 * canceled, the card moved on, or the paste failed. The caller was already
	 * answered, so this is the only way its durable receipt can settle.
	 */
	onNotRun: (reason: string) => void;
	run: () => Promise<RuntimeTaskSessionSummary>;
}) => Promise<void>;

function isReadyPi(
	summary: RuntimeTaskSessionSummary | null,
	manager: TerminalSessionManager,
	taskId: string,
): boolean {
	// A Pi paused on an extension dialog (`ui_prompt_start`) is also
	// `awaiting_review`, but pasting would answer the dialog instead of
	// starting a turn. Key on the live dialog hook, not `reviewReason`:
	// a session restored by `startTaskSession` is `awaiting_review` with
	// reason `attention` too, and process starts clear hook activity, so
	// restores stay eligible.
	return (
		summary?.agentId === "pi" &&
		manager.hasActiveProcess(taskId) &&
		summary.state === "awaiting_review" &&
		summary.latestHookActivity?.hookEventName !== "ui_prompt_start"
	);
}

function receivedPiStartupHook(summary: RuntimeTaskSessionSummary | null): boolean {
	return (
		summary !== null &&
		summary.startedAt !== null &&
		summary.lastHookAt !== null &&
		summary.lastHookAt >= summary.startedAt &&
		summary.latestHookActivity?.source === "pi"
	);
}

async function waitForPiStartup(manager: TerminalSessionManager, taskId: string): Promise<void> {
	if (receivedPiStartupHook(manager.getSummary(taskId))) return;
	await new Promise<void>((resolve, reject) => {
		let finished = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const release = manager.onSummary((summary) => {
			if (summary.taskId !== taskId || !receivedPiStartupHook(summary) || finished) return;
			finished = true;
			if (timer) clearTimeout(timer);
			release();
			resolve();
		});
		timer = setTimeout(() => {
			if (finished) return;
			finished = true;
			release();
			reject(new Error("Pi did not report a ready session; repair was not submitted."));
		}, PI_READY_TIMEOUT_MS);
	});
}

/**
 * Submit one already-deduplicated PR feedback batch to Pi. The caller owns the
 * durable dispatch record and must fail closed on uncertain outcomes.
 */
export function sendPreparedPiRepair(input: PiPreparedRepairInput): Promise<RuntimeTaskChatSendResponse> {
	return sendPreparedTerminalRepair(input, "pi");
}

type OpenCodePreparedRepairInput = Pick<PiPreparedRepairInput, "manager" | "taskId" | "prepare">;

const openCodeRepairs = new WeakMap<TerminalSessionManager, Set<string>>();

export async function sendPreparedOpenCodeRepair(
	input: OpenCodePreparedRepairInput,
): Promise<RuntimeTaskChatSendResponse> {
	const { manager, taskId, prepare } = input;
	const tasks = openCodeRepairs.get(manager) ?? new Set<string>();
	const summary = manager.getSummary(taskId);
	if (tasks.has(taskId)) {
		return { ok: false, summary, error: "An OpenCode repair is already active for this task." };
	}
	tasks.add(taskId);
	openCodeRepairs.set(manager, tasks);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		tasks.delete(taskId);
	};
	const wrappedPrepare: ClineTurnPreparation = (context) => prepare(context);
	wrappedPrepare.onQueued = prepare.onQueued;
	wrappedPrepare.onSettled = async (outcome) => {
		try {
			await prepare.onSettled?.(outcome);
		} finally {
			release();
		}
	};
	try {
		const response = await sendPreparedTerminalRepair(
			{
				...input,
				prepare: wrappedPrepare,
				restoreSavedSession: async () => ({
					ok: false,
					error: "Resume the task’s OpenCode session and finish a turn before retrying PR repair.",
				}),
			},
			"opencode",
		);
		if (!response.ok) release();
		return response;
	} catch (error) {
		release();
		throw error;
	}
}

async function sendPreparedTerminalRepair(
	input: PiPreparedRepairInput,
	agentId: "pi" | "opencode",
): Promise<RuntimeTaskChatSendResponse> {
	const { manager, taskId, prepare, capacity } = input;
	const agentName = agentId === "pi" ? "Pi" : "OpenCode";
	const isReady = (summary: RuntimeTaskSessionSummary | null) => {
		if (agentId === "pi") return isReadyPi(summary, manager, taskId);
		return (
			summary?.agentId === "opencode" &&
			manager.hasActiveProcess(taskId) &&
			summary.state === "awaiting_review" &&
			summary.reviewReason === "hook" &&
			Boolean(summary.externalSessionId) &&
			!manager
				.getLaunchArgs(taskId)
				?.some((arg, index, args) => arg === "--agent=plan" || (arg === "--agent" && args[index + 1] === "plan"))
		);
	};
	let summary = manager.getSummary(taskId);
	let restored = false;
	if (!manager.hasActiveProcess(taskId)) {
		const result = await input.restoreSavedSession();
		if (!result.ok) {
			return {
				ok: false,
				summary: manager.getSummary(taskId),
				error: result.error ?? "Pi session could not be restored.",
			};
		}
		restored = true;
		summary = manager.getSummary(taskId);
	}
	if (!isReady(summary)) {
		return {
			ok: false,
			summary,
			error:
				agentId === "pi"
					? "Pi is not in Review with an idle task session. Resolve an interrupted turn before resuming PR repairs."
					: "OpenCode needs an idle Build session after a completed turn. Finish the current turn or resume the task before retrying PR repair.",
		};
	}
	if (restored && agentId === "pi") {
		try {
			await waitForPiStartup(manager, taskId);
		} catch (error) {
			return { ok: false, summary: manager.getSummary(taskId), error: String(error) };
		}
	}
	const controller = new AbortController();
	let accepted = false;
	let sawTurnStart = false;
	let finished = false;
	let sentAt = 0;
	let startTimeout: ReturnType<typeof setTimeout> | null = null;
	let completionTimeout: ReturnType<typeof setTimeout> | null = null;
	const attemptId = manager.getSummary(taskId)?.launchAttemptId ?? null;
	let unsubscribe = () => {};
	// Returns the settle promise. Paths that hand control back to the caller
	// (the service) must await it: once `prepare()` returned, the feedback
	// watermark is already advanced, and the service writes the failed
	// dispatch the moment send returns. The durable watermark rollback in
	// `onSettled` has to land before that write, or `setDispatchFailed` sees
	// a status mismatch and skips the rollback — silently dropping the batch.
	const settle = (outcome: ClineTurnOutcome): Promise<void> => {
		if (finished) return Promise.resolve();
		finished = true;
		if (startTimeout) clearTimeout(startTimeout);
		if (completionTimeout) clearTimeout(completionTimeout);
		unsubscribe();
		// Invokes `onSettled` synchronously (the async IIFE still runs the
		// call in this tick) while surfacing its promise for awaited paths.
		return (async () => prepare.onSettled?.(outcome))().catch((error: unknown) => {
			process.stderr.write(`[terminal-repair] could not persist turn completion: ${String(error)}\n`);
		});
	};
	try {
		prepare.onQueued?.();
		const cwd = manager.getSummary(taskId)?.workspacePath;
		if (!cwd) throw new Error(`${agentName} task worktree is unavailable.`);
		const prompt = await prepare({ cwd, signal: controller.signal });
		if (prompt === null) {
			// Await the settle so the dispatch/skip record is durable before the
			// service stamps its ok:true turnRef on top of it.
			await settle({ status: "skipped" });
			return { ok: true, summary: manager.getSummary(taskId), message: null };
		}
		const beforeSend = manager.getSummary(taskId);
		if (
			!isReady(beforeSend) ||
			beforeSend?.launchAttemptId !== attemptId ||
			(agentId === "opencode" && beforeSend?.externalSessionId !== summary?.externalSessionId)
		) {
			throw new Error(`${agentName} began another turn or changed sessions during PR repair preparation.`);
		}
		unsubscribe = manager.onSummary((next) => {
			if (!accepted || next.taskId !== taskId) return;
			if (next.launchAttemptId !== attemptId) {
				if (agentId === "opencode")
					void settle({ status: "failed", error: "OpenCode changed sessions during PR repair." });
				return;
			}
			const activity = next.latestHookActivity;
			const freshOpenCodeHook =
				agentId === "opencode" &&
				activity?.source === "opencode" &&
				(next.lastHookAt ?? 0) >= sentAt &&
				next.externalSessionId === beforeSend?.externalSessionId;
			if (
				agentId === "pi"
					? (next.state === "running" && next.updatedAt >= sentAt) ||
						(activity?.hookEventName === "agent_start" && (next.lastHookAt ?? 0) >= sentAt)
					: freshOpenCodeHook && next.state === "running" && activity?.notificationType === "turn.started"
			) {
				sawTurnStart = true;
				if (startTimeout) clearTimeout(startTimeout);
				startTimeout = null;
			}
			if (freshOpenCodeHook && activity?.hookEventName === "session.error") {
				void settle({ status: "failed", error: "OpenCode reported an error during PR repair." });
				return;
			}
			if (
				agentId === "pi" &&
				next.latestHookActivity?.hookEventName === "agent_settled" &&
				next.latestHookActivity.notificationType === "error" &&
				(next.lastHookAt ?? 0) >= sentAt
			) {
				void settle({ status: "failed", error: "Pi reported a failed PR repair turn." });
				return;
			}
			if (
				agentId === "pi" &&
				next.latestHookActivity?.hookEventName === "agent_settled" &&
				next.latestHookActivity.notificationType === "aborted" &&
				(next.lastHookAt ?? 0) >= sentAt
			) {
				void settle({ status: "failed", error: "Pi aborted its PR repair turn." });
				return;
			}
			if (next.pid === null || !manager.hasActiveProcess(taskId)) {
				void settle({
					status: "failed",
					error: `${agentName}'s task process stopped before the PR repair completed.`,
				});
				return;
			}
			if (next.state === "interrupted" || next.state === "failed") {
				void settle({
					status: "failed",
					error: `${agentName}'s PR repair session was interrupted before completion.`,
				});
				return;
			}
			if (sawTurnStart && next.state === "awaiting_review") {
				// Only the agent's turn completion event closes the durable receipt. Other
				// `to_review` hooks (or a summary re-emitted when a dialog
				// resolves with stale activity) are pauses, not completion.
				if (
					next.reviewReason === "hook" &&
					(agentId === "pi"
						? activity?.hookEventName === "agent_settled" && (next.lastHookAt ?? 0) >= sentAt
						: freshOpenCodeHook && activity?.notificationType === "turn.completed")
				) {
					void settle({ status: "completed" });
				} else if (next.reviewReason === "error") {
					void settle({ status: "failed", error: `${agentName} failed during PR repair.` });
				}
			}
		});
		/**
		 * Pastes the prompt and starts Pi's turn. Runs immediately when a model slot
		 * is free, or from the capacity gate in the background once one frees, which
		 * is why both turn timers start here rather than before admission: they must
		 * only measure a turn Pi actually received.
		 */
		const submitRepair = async (): Promise<void> => {
			if (agentId === "pi") {
				sentAt = Date.now();
				accepted = true;
			}
			// Paste as a single multiline prompt (not individual terminal commands).
			// Strip control characters that could terminate the bracketed-paste frame.
			const safePrompt = stripTerminalControls(prompt);
			if (!manager.writeInput(taskId, Buffer.from(`\x1b[200~${safePrompt}\x1b[201~`, "utf8"))) {
				throw new Error(`${agentName} terminal process disappeared before the repair was submitted.`);
			}
			await new Promise<void>((resolve) => setTimeout(resolve, REPAIR_PASTE_SETTLE_MS));
			const current = manager.getSummary(taskId);
			if (
				!manager.hasActiveProcess(taskId) ||
				current?.launchAttemptId !== attemptId ||
				(agentId === "opencode" && !isReady(current))
			) {
				throw new Error(`${agentName} task process exited before the submitted repair could start.`);
			}
			if (agentId === "opencode") {
				sentAt = Date.now();
				accepted = true;
			}
			if (!manager.writeInput(taskId, Buffer.from("\r", "utf8"))) {
				throw new Error(`${agentName} did not accept the repair prompt.`);
			}
			if (!finished) {
				if (!sawTurnStart) {
					startTimeout = setTimeout(() => {
						if (!sawTurnStart) {
							void settle({
								status: "failed",
								error: `${agentName} did not start the PR repair turn within 60 seconds.`,
							});
						}
					}, REPAIR_TURN_START_TIMEOUT_MS);
				}
				completionTimeout = setTimeout(() => {
					void settle({
						status: "failed",
						error: `${agentName} PR repair exceeded the one-hour execution timeout.`,
					});
				}, REPAIR_TURN_TIMEOUT_MS);
			}
		};
		const reportSubmitted = (): RuntimeTaskSessionSummary => {
			const submitted = manager.getSummary(taskId);
			if (!submitted) {
				throw new Error("Pi's task session disappeared before the repair was submitted.");
			}
			return submitted;
		};
		if (capacity) {
			await capacity({
				taskId,
				manager,
				// The gate answers a queued repair as soon as it is queued, so nothing
				// here is still waiting when the paste later fails or is canceled. The
				// turn listener cannot report it either: it ignores everything until the
				// paste is written. Settling here is what rolls the feedback watermark
				// back and releases the live dispatch entry, instead of leaving the card
				// skipped as `waiting` until a runtime restart.
				onNotRun: (reason) => {
					void settle({ status: "failed", error: `The PR repair never reached Pi. ${reason}` });
				},
				run: async () => {
					await submitRepair();
					return reportSubmitted();
				},
			});
		} else {
			await submitRepair();
		}
		return { ok: true, summary: manager.getSummary(taskId), message: null };
	} catch (error) {
		controller.abort();
		const message = error instanceof Error ? error.message : String(error);
		// Await the durable rollback (watermark + failed status) before handing
		// control back: the service writes the failed dispatch immediately.
		await settle({ status: "failed", error: message });
		return { ok: false, summary: manager.getSummary(taskId), error: message };
	}
}
