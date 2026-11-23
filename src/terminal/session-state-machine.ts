import type { RuntimeTaskSessionReviewReason, RuntimeTaskSessionSummary } from "../core/api-contract";

/**
 * The only reasons an integration may report through a hook review. `attention`
 * is a pause that waits for the human, `error` is a turn that failed, and `hook`
 * is an ordinary finished turn. Every other reason comes from the process
 * lifecycle rather than from an agent, so it cannot be claimed here.
 */
export type HookReviewReason = Extract<RuntimeTaskSessionReviewReason, "attention" | "error" | "hook">;

export type SessionTransitionEvent =
	| { type: "hook.to_review"; reason: HookReviewReason }
	| { type: "hook.to_in_progress" }
	| { type: "agent.prompt-ready" }
	| { type: "process.exit"; exitCode: number | null; interrupted: boolean };

export interface SessionTransitionResult {
	changed: boolean;
	patch: Partial<RuntimeTaskSessionSummary>;
	clearAttentionBuffer: boolean;
}

function canReturnToRunning(reason: RuntimeTaskSessionReviewReason): boolean {
	return reason === "attention" || reason === "hook" || reason === "error";
}

function asReviewState(reason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionSummary["state"] {
	if (reason === "interrupted") {
		return "interrupted";
	}
	return "awaiting_review";
}

export function reduceSessionTransition(
	summary: RuntimeTaskSessionSummary,
	event: SessionTransitionEvent,
): SessionTransitionResult {
	switch (event.type) {
		case "hook.to_review": {
			if (summary.state !== "running") {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			// The reported reason is carried into the summary instead of every hook
			// review being labelled `hook`: a turn that failed or a turn parked on an
			// approval must stay distinguishable from a finished one, because a card
			// that says "ready for review" for a failed turn reads as a completed
			// task. `canReturnToRunning` below is what lets the same integration move
			// the card again once the pause ends.
			return {
				changed: true,
				patch: {
					state: asReviewState(event.reason),
					reviewReason: event.reason,
				},
				clearAttentionBuffer: true,
			};
		}
		case "hook.to_in_progress":
		case "agent.prompt-ready": {
			if (summary.state !== "awaiting_review" || !canReturnToRunning(summary.reviewReason)) {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "running",
					reviewReason: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "process.exit": {
			let reason: RuntimeTaskSessionReviewReason = event.exitCode === 0 ? "exit" : "error";
			if (event.interrupted) {
				reason = "interrupted";
			}
			return {
				changed: true,
				patch: {
					state: asReviewState(reason),
					reviewReason: reason,
					exitCode: event.exitCode,
					pid: null,
				},
				clearAttentionBuffer: false,
			};
		}
		default: {
			return { changed: false, patch: {}, clearAttentionBuffer: false };
		}
	}
}
