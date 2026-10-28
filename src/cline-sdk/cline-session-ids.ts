// Session-id roles for Cline task sessions. Plain task ids are the
// publication-capable coding sessions; review and verification-repair
// session ids carry bounded roles (publication is denied by the review
// tool policy), and home-agent session ids are the sidebar-only role.
import { isHomeAgentSessionId } from "../core/home-agent-session";

/** Suffix that makes the review session id distinct from the task's working session. */
export const REVIEW_SESSION_SUFFIX = "::review";
/** B-7.5: each verification repair round runs in its own fresh session. */
export const VERIFICATION_REPAIR_SESSION_SUFFIX = "::verification-repair-";

/** B-6.2: the review session id is derived from (and distinct from) the task id. */
export function reviewSessionIdForTask(taskId: string): string {
	return `${taskId}${REVIEW_SESSION_SUFFIX}`;
}

/** True for bounded review and verification-repair session ids. */
export function isReviewSessionId(sessionId: string): boolean {
	return sessionId.endsWith(REVIEW_SESSION_SUFFIX) || sessionId.includes(VERIFICATION_REPAIR_SESSION_SUFFIX);
}

/**
 * B-11.2: the base task id for a review session id (review or
 * verification-repair sessions); null for plain task sessions. Review work
 * holds the base task's model worker slot, so budgets scope sessions by it.
 */
export function baseTaskIdForReviewSessionId(sessionId: string): string | null {
	if (sessionId.endsWith(REVIEW_SESSION_SUFFIX)) {
		return sessionId.slice(0, -REVIEW_SESSION_SUFFIX.length);
	}
	const repairIndex = sessionId.indexOf(VERIFICATION_REPAIR_SESSION_SUFFIX);
	if (repairIndex > 0) {
		return sessionId.slice(0, repairIndex);
	}
	return null;
}

/**
 * AR-5: publication-capable native coding sessions are the plain task
 * sessions. Bounded review/verification-repair sessions are denied
 * publication by the review tool policy, and home-agent sessions are
 * sidebar-only, so neither receives the publication guidance.
 */
export function isPublicationCapableSessionId(sessionId: string): boolean {
	return !isHomeAgentSessionId(sessionId) && !isReviewSessionId(sessionId);
}
