// Guards for reattaching a saved Pi conversation after a Kanban restart.
//
// A Pi task's conversation lives in a JSONL session file that outlives the
// runtime, but its persisted summary is the only signal saying whether that
// record describes a session Kanban merely *lost* (graceful shutdown, SIGKILL,
// power loss) or one that already ended on its own. Reattaching the first is
// recovery; reattaching the second would relaunch a finished, crashed, or
// intentionally stopped agent, so every attach path uses this one predicate.
import type { RuntimeTaskSessionSummary } from "../core/api-contract";

/**
 * Whether a summary still describes a Pi conversation that the guarded
 * exact-session restore is allowed to reattach. The web UI mirrors this rule
 * when it decides whether opening a task detail may ask for a restore.
 */
export function isDetachedPiRestoreCandidate(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	if (!summary || summary.agentId !== "pi") {
		return false;
	}
	// `interrupted` is written by Kanban itself when it lost a live process, and
	// by the stale-record recovery below. Either way the conversation is intact.
	if (summary.state === "interrupted") {
		return true;
	}
	// A record that still claims a pid predates the runtime answering it, so the
	// process is gone regardless; only the guarded restore may reattach it.
	if (summary.state === "running" || summary.state === "awaiting_review") {
		return summary.pid !== null;
	}
	// `idle`/`failed` never had a turn to resume, and a session whose process
	// already exited (pid null) ended on its own: a stop or crash stays one.
	return false;
}

/**
 * The summary a detached Pi record is normalized into when something needs to
 * settle it before a restore lands (the terminal websocket attaching first, for
 * example). Only the process identity is dropped: the card keeps its lane, its
 * last output, and its turn checkpoints, and the summary stays restorable, so
 * both attach orders converge on the same shape instead of racing.
 */
export function buildRestorePendingPiPatch(): Pick<
	RuntimeTaskSessionSummary,
	"state" | "reviewReason" | "pid" | "exitCode"
> {
	return {
		state: "interrupted",
		reviewReason: "interrupted",
		pid: null,
		exitCode: null,
	};
}

/**
 * Whether the shutdown coordinator is looking at a Pi session that has no
 * process to interrupt: `idle`, `failed`, or a turn that already ended by
 * itself (an intentional stop, a crash, or a finished Review). Such a session
 * keeps the state it has instead of being rewritten into a restore that the
 * user never asked for.
 */
export function isSettledPiSummaryWithoutProcess(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	if (!summary || summary.agentId !== "pi") {
		return false;
	}
	return summary.pid === null && summary.state !== "running";
}
