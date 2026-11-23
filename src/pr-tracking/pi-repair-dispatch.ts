// Pi implementation for the shared PR-feedback dispatch contract.
// The Cline path uses ClineTurnPreparation at model admission. Pi has an
// interactive PTY instead, so perform the same preparation immediately before
// writing to that idle task-owned session, then settle from its native hooks.
import type { ClineTurnOutcome, ClineTurnPreparation } from "../cline-sdk/cline-turn-preparation";
import type { RuntimeTaskChatSendResponse, RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TerminalSessionManager } from "../terminal/session-manager";

const PI_READY_TIMEOUT_MS = 15_000;
const PI_TURN_START_TIMEOUT_MS = 60_000;
const PI_REPAIR_TURN_TIMEOUT_MS = 60 * 60_000;
const PI_PASTE_SETTLE_MS = 200;

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
}

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
export async function sendPreparedPiRepair(input: PiPreparedRepairInput): Promise<RuntimeTaskChatSendResponse> {
	const { manager, taskId, prepare } = input;
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
	if (!isReadyPi(summary, manager, taskId)) {
		return {
			ok: false,
			summary,
			error: "Pi is not in Review with an idle task session. Resolve an interrupted turn before resuming PR repairs.",
		};
	}
	if (restored) {
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
	const settle = (outcome: ClineTurnOutcome) => {
		if (finished) return;
		finished = true;
		if (startTimeout) clearTimeout(startTimeout);
		if (completionTimeout) clearTimeout(completionTimeout);
		unsubscribe();
		void prepare.onSettled?.(outcome).catch((error: unknown) => {
			process.stderr.write(`[pi-repair] could not persist turn completion: ${String(error)}\n`);
		});
	};
	try {
		prepare.onQueued?.();
		const cwd = manager.getSummary(taskId)?.workspacePath;
		if (!cwd) throw new Error("Pi task worktree is unavailable.");
		const prompt = await prepare({ cwd, signal: controller.signal });
		if (prompt === null) {
			settle({ status: "skipped" });
			return { ok: true, summary: manager.getSummary(taskId), message: null };
		}
		const beforeSend = manager.getSummary(taskId);
		if (!isReadyPi(beforeSend, manager, taskId) || beforeSend?.launchAttemptId !== attemptId) {
			throw new Error("Pi began another turn or changed sessions during PR repair preparation.");
		}
		unsubscribe = manager.onSummary((next) => {
			if (!accepted || next.taskId !== taskId || next.launchAttemptId !== attemptId) return;
			if (
				(next.state === "running" && next.updatedAt >= sentAt) ||
				(next.latestHookActivity?.hookEventName === "agent_start" && (next.lastHookAt ?? 0) >= sentAt)
			) {
				sawTurnStart = true;
				if (startTimeout) clearTimeout(startTimeout);
				startTimeout = null;
			}
			if (
				next.latestHookActivity?.hookEventName === "agent_settled" &&
				next.latestHookActivity.notificationType === "error" &&
				(next.lastHookAt ?? 0) >= sentAt
			) {
				settle({ status: "failed", error: "Pi reported a failed PR repair turn." });
				return;
			}
			if (
				next.latestHookActivity?.hookEventName === "agent_settled" &&
				next.latestHookActivity.notificationType === "aborted" &&
				(next.lastHookAt ?? 0) >= sentAt
			) {
				settle({ status: "failed", error: "Pi aborted its PR repair turn." });
				return;
			}
			if (next.pid === null || !manager.hasActiveProcess(taskId)) {
				settle({ status: "failed", error: "Pi's task process stopped before the PR repair completed." });
				return;
			}
			if (next.state === "interrupted" || next.state === "failed") {
				settle({ status: "failed", error: "Pi's PR repair session was interrupted before completion." });
				return;
			}
			if (sawTurnStart && next.state === "awaiting_review") {
				// Only Pi's real settle event closes the durable receipt. Other
				// `to_review` hooks (or a summary re-emitted when a dialog
				// resolves with stale activity) are pauses, not completion.
				if (
					next.reviewReason === "hook" &&
					next.latestHookActivity?.hookEventName === "agent_settled" &&
					(next.lastHookAt ?? 0) >= sentAt
				) {
					settle({ status: "completed" });
				} else if (next.reviewReason === "error") {
					settle({ status: "failed", error: "Pi failed during PR repair." });
				}
			}
		});
		sentAt = Date.now();
		accepted = true;
		// Paste as a single multiline prompt (not individual terminal commands).
		// Strip control characters that could terminate the bracketed-paste frame.
		const safePrompt = stripTerminalControls(prompt);
		if (!manager.writeInput(taskId, Buffer.from(`\x1b[200~${safePrompt}\x1b[201~`, "utf8"))) {
			throw new Error("Pi's terminal process disappeared before the repair was submitted.");
		}
		await new Promise<void>((resolve) => setTimeout(resolve, PI_PASTE_SETTLE_MS));
		if (!manager.hasActiveProcess(taskId) || manager.getSummary(taskId)?.launchAttemptId !== attemptId) {
			throw new Error("Pi's task process exited before the submitted repair could start.");
		}
		if (!manager.writeInput(taskId, Buffer.from("\r", "utf8"))) {
			throw new Error("Pi did not accept the repair prompt.");
		}
		if (!finished) {
			if (!sawTurnStart) {
				startTimeout = setTimeout(() => {
					if (!sawTurnStart) {
						settle({ status: "failed", error: "Pi did not start the PR repair turn within 60 seconds." });
					}
				}, PI_TURN_START_TIMEOUT_MS);
			}
			completionTimeout = setTimeout(() => {
				settle({ status: "failed", error: "Pi PR repair exceeded the one-hour execution timeout." });
			}, PI_REPAIR_TURN_TIMEOUT_MS);
		}
		return { ok: true, summary: manager.getSummary(taskId), message: null };
	} catch (error) {
		controller.abort();
		const message = error instanceof Error ? error.message : String(error);
		settle({ status: "failed", error: message });
		return { ok: false, summary: manager.getSummary(taskId), error: message };
	}
}
