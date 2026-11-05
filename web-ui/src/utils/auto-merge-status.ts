// AM-5: derive the operator-facing auto-merge status from the server's
// persisted facts (AM-3 eligibility summary + AM-4 attempt journal). The
// server is authoritative: this module only maps the frozen blocker codes
// and journal states to short, explicit UI text. Unknown evidence is never
// rendered as green: "merged" requires the remote-confirmed journal entry,
// and a stale eligible summary falls back to "waiting".

import type { RuntimeTaskTrackingStateResponse } from "@/runtime/types";

/** Mirrors the server's AUTO_MERGE_MAX_EVIDENCE_AGE_MS (2 minutes). */
export const AUTO_MERGE_EVIDENCE_BUDGET_MS = 2 * 60 * 1000;

export type AutoMergeUiTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface AutoMergeUiStatus {
	label: string;
	tone: AutoMergeUiTone;
	/** A short reason line; null when the label is self-explanatory. */
	detail: string | null;
	/** Last verified evidence instant (epoch ms); null when never verified. */
	verifiedAt: number | null;
	/** The current head SHA the status was verified against; null when unknown. */
	headSha: string | null;
}

/** Human-facing text for the frozen AM-3/AM-4 blocker codes (codes only). */
const BLOCKER_CODE_MESSAGES: Record<string, string> = {
	disabled: "Auto-merge is not enabled for this task.",
	not_armed: "The task is not armed against a repository policy revision.",
	inactive_task: "The task is not in In Progress or In Review.",
	no_policy: "The repository has no auto-merge policy.",
	policy_mismatch: "The repository policy changed after arming; re-enable to re-arm.",
	ambiguous_claim: "Another task also claims this PR for auto-merge.",
	auth: "GitHub authentication is unavailable.",
	access: "GitHub access is denied for this read.",
	unsupported_host: "This PR host is not supported for auto-merge.",
	malformed_key: "The recorded PR link cannot be parsed.",
	internal_error: "Evidence collection hit an internal error.",
	stale_scope: "The evidence scope is stale; re-reading.",
	head_unknown: "The PR's current head SHA is unknown.",
	base_unknown: "The PR's current base SHA is unknown.",
	pr_identity_mismatch: "The PR's identity does not match the task's repository.",
	pr_closed: "The PR is closed without merging.",
	pr_merged: "The PR is already merged.",
	merge_conflicts: "The current head does not merge cleanly into the base branch.",
	native_auto_merge: "GitHub native auto-merge is already enabled for this PR.",
	review_inconsistent: "Review ordering is inconsistent for a reviewer.",
	no_required_checks: "The policy's required-checks list is empty.",
	pr_draft: "The PR is still a draft.",
	pr_state_unknown: "The PR state could not be determined.",
	mergeability_unknown: "GitHub has not computed mergeability for the current head.",
	head_changed: "The head moved during evidence collection; a fresh read is pending.",
	evidence_incomplete: "Evidence is incomplete.",
	evidence_stale: "Evidence is older than the 2-minute budget; re-reading.",
	check_missing: "A required check has not run on the current head.",
	check_pending: "A required check is still running.",
	check_failed: "A required check failed or was cancelled.",
	changes_requested: "Unsuperseded changes requested.",
	no_approval: "No effective current-head approval yet.",
	unresolved_threads: "Unresolved review threads remain.",
	writer_active: "The task's writer is still active.",
	comment_repair_pending: "A comment-repair dispatch is still in flight.",
	pr_reserved: "The PR operation gate is reserved by another task.",
};

/** The journal's free-form reason tokens map onto the same messages when known. */
function humanizeReason(reason: string | null): string | null {
	if (reason === null) {
		return null;
	}
	const direct = BLOCKER_CODE_MESSAGES[reason];
	if (direct !== undefined) {
		return direct;
	}
	const prefix = reason.split(":")[0];
	if (prefix === undefined) {
		return reason;
	}
	return BLOCKER_CODE_MESSAGES[prefix] ?? reason;
}

/** Which waiting category the summary's codes fall into (deterministic order). */
function categorizeWaitingCodes(codes: readonly string[]): "approval" | "ci" | "repair" | "other" {
	const has = (code: string): boolean => codes.includes(code);
	if (
		has("no_approval") ||
		has("changes_requested") ||
		has("unresolved_threads") ||
		has("review_inconsistent") ||
		has("pr_draft")
	) {
		return "approval";
	}
	if (has("check_pending") || has("check_missing") || has("check_failed")) {
		return "ci";
	}
	if (has("writer_active") || has("comment_repair_pending") || has("pr_reserved")) {
		return "repair";
	}
	return "other";
}

function blockerMessages(codes: readonly string[], limit: number): string {
	const seen = new Set<string>();
	const messages: string[] = [];
	for (const code of codes) {
		const message = BLOCKER_CODE_MESSAGES[code] ?? `Blocked: ${code}.`;
		if (seen.has(message)) {
			continue;
		}
		seen.add(message);
		messages.push(message);
		if (messages.length >= limit) {
			break;
		}
	}
	return messages.join(" ");
}

/**
 * Derive the operator-facing auto-merge status for one tracking state.
 * Returns null when the task has not opted in ("off" is the checkbox state).
 *
 * Precedence (all server-persisted): the AM-4 attempt journal > the AM-3
 * eligibility summary — but only when the journal belongs to the SAME
 * evidence identity the summary describes (head SHA, base SHA, policy
 * revision), exactly as the executor treats `needs_attention`/`waiting`
 * journal entries as binding only for their own attemptId. A journal entry
 * left over from an older head/policy revision must never paint the new
 * evidence red or "merging". `merged_confirmed` is unconditional: once
 * GitHub confirms the merge for a task, that is the state. An eligible
 * summary older than the evidence budget is never shown as merging: the
 * executor only ever merged from a fresh evaluation, so a stale summary
 * means the next verification is pending.
 */
export function deriveAutoMergeStatus(
	tracking: RuntimeTaskTrackingStateResponse,
	now: number = Date.now(),
): AutoMergeUiStatus | null {
	if (tracking.autoMergeWhenApproved !== true) {
		return null;
	}
	const attempt = tracking.autoMergeAttempt ?? null;
	const summary = tracking.autoMergeEligibility ?? null;
	const verifiedAt = summary?.evidenceCheckedAt ?? attempt?.finishedAt ?? summary?.evaluatedAt ?? null;
	const headSha = summary?.headSha ?? attempt?.headSha ?? null;
	const evidenceStale = summary !== null && verifiedAt !== null && now - verifiedAt > AUTO_MERGE_EVIDENCE_BUDGET_MS;

	if (attempt?.state === "merged_confirmed") {
		return {
			label: "merged",
			tone: "success",
			detail: attempt.mergeCommitSha !== null ? `Merged as ${attempt.mergeCommitSha.slice(0, 7)}` : null,
			verifiedAt,
			headSha,
		};
	}
	// A journal entry only overrides the current eligibility summary when it
	// describes the SAME evidence (head SHA, base SHA, policy revision). The
	// executor treats needs_attention/waiting entries as binding only for
	// their own attemptId, so an entry left over from an older head or policy
	// revision must fall through to the summary.
	const attemptMatchesCurrentEvidence =
		attempt !== null &&
		summary !== null &&
		attempt.headSha === summary.headSha &&
		attempt.baseSha === summary.baseSha &&
		attempt.policyRevision === summary.policyRevision;
	if (attemptMatchesCurrentEvidence && attempt.state === "needs_attention") {
		return {
			label: "needs attention",
			tone: "danger",
			detail: humanizeReason(attempt.reason),
			verifiedAt,
			headSha,
		};
	}
	if (attemptMatchesCurrentEvidence && attempt.state === "attempting") {
		return { label: "merging", tone: "warning", detail: "The fenced merge write is in flight.", verifiedAt, headSha };
	}
	if (attemptMatchesCurrentEvidence && attempt.state === "waiting") {
		return {
			label: "waiting",
			tone: "warning",
			detail: humanizeReason(attempt.reason),
			verifiedAt,
			headSha,
		};
	}
	if (summary === null) {
		return { label: "waiting", tone: "neutral", detail: "Waiting for the first verification.", verifiedAt, headSha };
	}
	if (summary.kind === "eligible") {
		// Never green on stale evidence: a merge only fires from a fresh read.
		if (evidenceStale) {
			return {
				label: "waiting",
				tone: "neutral",
				detail: "Eligible, but the evidence is stale; the next verification re-reads it.",
				verifiedAt,
				headSha,
			};
		}
		return {
			label: "merging",
			tone: "warning",
			detail: "Verified eligible; the merge is being executed.",
			verifiedAt,
			headSha,
		};
	}
	if (summary.kind === "blocked") {
		return { label: "blocked", tone: "danger", detail: blockerMessages(summary.codes, 3), verifiedAt, headSha };
	}
	const category = categorizeWaitingCodes(summary.codes);
	const label =
		category === "approval"
			? "waiting: approval"
			: category === "ci"
				? "waiting: CI"
				: category === "repair"
					? "waiting: writer/comment repair"
					: "waiting";
	const detail = evidenceStale ? "Evidence is stale; re-reading." : blockerMessages(summary.codes, 2);
	return { label, tone: "neutral", detail, verifiedAt, headSha };
}

/** `abc1234` for display; null-safe. */
export function shortSha(sha: string | null | undefined): string | null {
	return sha && sha.length > 0 ? sha.slice(0, 7) : null;
}
