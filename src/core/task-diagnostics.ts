// B-10.1 / B-10.3: pure reliable-completion phase and operator-action
// availability computation for task diagnostics.
//
// The phase model is a linear pipeline (B-6 review → B-8 delivery → B-9
// dispatch): implementing → reviewing → checking → committing → integrating →
// pushing → verifying_remote → done. `phase` reports where the task currently
// sits in that pipeline; `lastSuccessfulPhase` reports the last phase that
// durably completed. No I/O happens here — the caller gathers the lifecycle
// artifacts (delivery receipt, review verdict, dispatch record, preservation
// record, session state) and hands them in.

import type {
	RuntimeGitDeliveryStage,
	RuntimeGitDeliveryStatus,
	RuntimeTaskActionAvailability,
	RuntimeTaskDiagnosticsActions,
	RuntimeTaskDispatchStatus,
	RuntimeTaskPhase,
	RuntimeTaskReviewStatus,
} from "./api-contract";

/** The phase a delivery stage represents once it has completed successfully. */
const DELIVERY_STAGE_COMPLETED_PHASE: Record<RuntimeGitDeliveryStage, RuntimeTaskPhase> = {
	validated: "checking",
	staged: "checking",
	committed: "committing",
	integrated: "integrating",
	pushed: "pushing",
	verified: "verifying_remote",
	pr: "verifying_remote",
};

/** The phase in flight while an in-progress receipt sits at a delivery stage. */
const DELIVERY_STAGE_ACTIVE_PHASE: Record<RuntimeGitDeliveryStage, RuntimeTaskPhase> = {
	validated: "committing",
	staged: "committing",
	committed: "integrating",
	integrated: "pushing",
	pushed: "verifying_remote",
	verified: "verifying_remote",
	pr: "verifying_remote",
};

export interface TaskPhaseInput {
	/** A Cline session is live (running or awaiting review) for the task right now. */
	sessionActive: boolean;
	deliveryStatus: RuntimeGitDeliveryStatus | null;
	deliveryStage: RuntimeGitDeliveryStage | null;
	/** Receipt evidence trail (most recent last); used for failure detail. */
	deliveryEvidence: Array<{ stage: string; detail: string }>;
	reviewStatus: RuntimeTaskReviewStatus | null;
	reviewError: string | null;
	dispatchStatus: RuntimeTaskDispatchStatus | null;
	dispatchError: string | null;
	preservationStatus: "none" | "active" | "preserved" | "blocked";
	preservationBlockedReasons: string[];
	worktreeExists: boolean;
}

export interface TaskPhaseResult {
	phase: RuntimeTaskPhase;
	lastSuccessfulPhase: RuntimeTaskPhase | null;
	needsAttention: boolean;
	blockedReason: string | null;
	actions: RuntimeTaskDiagnosticsActions;
}

function lastDeliveryEvidenceDetail(evidence: Array<{ stage: string; detail: string }>): string | null {
	for (let i = evidence.length - 1; i >= 0; i -= 1) {
		const entry = evidence[i];
		if (entry.detail) {
			return entry.detail;
		}
	}
	return null;
}

/** A failed or paused receipt: delivery can resume from its last successful stage. */
export function isDeliveryResumable(status: RuntimeGitDeliveryStatus | null): boolean {
	return status === "failed" || status === "paused";
}

function availability(enabled: boolean, reasonWhenDisabled: string | null): RuntimeTaskActionAvailability {
	return { enabled, reason: enabled ? null : reasonWhenDisabled };
}

/**
 * Derive the operator-facing explanation for a task that needs attention.
 * Delivery problems outrank review/dispatch/preservation problems because the
 * delivery pipeline is the outermost (latest) stage of the pipeline.
 */
function resolveBlockedReason(input: TaskPhaseInput): string | null {
	const {
		deliveryStatus,
		deliveryStage,
		deliveryEvidence,
		reviewStatus,
		reviewError,
		dispatchStatus,
		dispatchError,
		preservationStatus,
		preservationBlockedReasons,
	} = input;
	if (deliveryStatus === "failed") {
		const detail = lastDeliveryEvidenceDetail(deliveryEvidence);
		return `Delivery failed at stage "${deliveryStage ?? "unknown"}"${detail ? `: ${detail}` : ""}`;
	}
	if (deliveryStatus === "paused") {
		const detail = lastDeliveryEvidenceDetail(deliveryEvidence);
		return `Delivery paused at stage "${deliveryStage ?? "unknown"}"${detail ? `: ${detail}` : ""} — resumable from the last successful stage`;
	}
	if (reviewStatus === "failed" || reviewStatus === "parse_failed") {
		return `Review ${reviewStatus}${reviewError ? `: ${reviewError}` : ""}`;
	}
	if (dispatchStatus === "exhausted") {
		return `Dispatch queue exhausted its attempt budget${dispatchError ? `: ${dispatchError}` : ""}`;
	}
	if (dispatchStatus === "failed") {
		return `Dispatch failed${dispatchError ? `: ${dispatchError}` : ""}`;
	}
	if (preservationStatus === "blocked") {
		return `Preserved work is blocked: ${
			preservationBlockedReasons.length > 0 ? preservationBlockedReasons.join("; ") : "unknown reason"
		}`;
	}
	return null;
}

function resolveActions(input: TaskPhaseInput): RuntimeTaskDiagnosticsActions {
	const { deliveryStatus, sessionActive, preservationStatus, worktreeExists } = input;
	const receiptTerminal = deliveryStatus === "delivered" || deliveryStatus === "no_op";
	const receiptInProgress = deliveryStatus === "in_progress";
	const receiptBroken = isDeliveryResumable(deliveryStatus);
	const reviewBroken = input.reviewStatus === "failed" || input.reviewStatus === "parse_failed";

	// retry_phase: re-run the current phase after a failure. For a broken
	// delivery receipt that means re-running the delivery pipeline from the
	// last successful stage (the receipt drives the resume); for a failed
	// review it means starting a fresh review pass. A running or finished
	// delivery outranks a stale review failure: there is nothing to retry.
	let retryAvailability: RuntimeTaskActionAvailability;
	if (receiptInProgress) {
		retryAvailability = availability(false, "Delivery is already in progress.");
	} else if (receiptTerminal) {
		retryAvailability = availability(false, "Task is already delivered.");
	} else if (receiptBroken || reviewBroken) {
		retryAvailability = availability(true, null);
	} else {
		retryAvailability = availability(false, "No failed phase to retry.");
	}

	// resume_repair: continue a paused/failed delivery from the last stage that
	// completed. Only meaningful when a receipt exists.
	let resumeAvailability: RuntimeTaskActionAvailability;
	if (receiptBroken) {
		resumeAvailability = availability(true, null);
	} else if (receiptInProgress) {
		resumeAvailability = availability(false, "Delivery is already in progress.");
	} else if (receiptTerminal) {
		resumeAvailability = availability(false, "Task is already delivered.");
	} else {
		resumeAvailability = availability(false, "No delivery to resume.");
	}

	return {
		retry_phase: retryAvailability,
		resume_repair: resumeAvailability,
		cancel: sessionActive ? availability(true, null) : availability(false, "No active session to cancel."),
		recover_workspace:
			preservationStatus === "none"
				? availability(false, "No preserved work for this task.")
				: worktreeExists
					? availability(false, "Task worktree already exists.")
					: availability(true, null),
	};
}

/**
 * Compute the task's current reliable-completion phase, the last phase that
 * durably completed, the attention flag + explanation, and per-action
 * availability. Deterministic and pure.
 */
export function computeTaskPhase(input: TaskPhaseInput): TaskPhaseResult {
	const { sessionActive, deliveryStatus, deliveryStage, reviewStatus, dispatchStatus, worktreeExists } = input;

	const blockedReason = resolveBlockedReason(input);
	const needsAttention = blockedReason !== null;
	const receiptTerminal = deliveryStatus === "delivered" || deliveryStatus === "no_op";

	let phase: RuntimeTaskPhase;
	if (receiptTerminal) {
		// A complete durable receipt outranks everything: the pipeline finished.
		phase = "done";
	} else if (needsAttention) {
		phase = "needs_attention";
	} else if (deliveryStatus === "in_progress" && deliveryStage) {
		phase = DELIVERY_STAGE_ACTIVE_PHASE[deliveryStage];
	} else if (sessionActive || dispatchStatus === "dispatching" || dispatchStatus === "dispatched") {
		// A live session (or an active dispatch record) means implementation
		// work is in flight.
		phase = "implementing";
	} else if (reviewStatus === "ready") {
		// Review verdict is ready but no delivery has run yet: the task sits at
		// the review → delivery boundary.
		phase = "reviewing";
	} else if (reviewStatus !== null || worktreeExists) {
		// A review handoff exists (implementation was handed off) or a live
		// worktree is present: the task's working phase is implementation.
		phase = "implementing";
	} else {
		phase = "idle";
	}

	let lastSuccessfulPhase: RuntimeTaskPhase | null = null;
	if (deliveryStatus !== null && deliveryStage) {
		// The receipt only advances `stage` after a stage succeeds, so the
		// recorded stage is the last successfully completed one even when the
		// receipt later failed or paused.
		lastSuccessfulPhase = DELIVERY_STAGE_COMPLETED_PHASE[deliveryStage];
	} else if (reviewStatus === "ready") {
		lastSuccessfulPhase = "reviewing";
	} else if (reviewStatus !== null) {
		// A review handoff exists: implementation finished and was handed off,
		// but the review phase itself has not succeeded.
		lastSuccessfulPhase = "implementing";
	}

	return {
		phase,
		lastSuccessfulPhase,
		needsAttention,
		blockedReason,
		actions: resolveActions(input),
	};
}
