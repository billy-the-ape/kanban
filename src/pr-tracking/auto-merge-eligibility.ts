// AM-3: pure auto-merge eligibility evaluation + the auto-merge consumer
// observer.
//
// The evaluator is a PURE function over (task facts, repository policy, the
// AM-2 authoritative evidence envelope, and the durable record state). It
// returns a structured `kind` ("eligible" | "waiting" | "blocked"), blocker
// codes with short messages, `evaluatedAt`, `headSha`, `baseSha`,
// `policyRevision`, and the evidence age. No I/O, no retries, no timer —
// the consumer observer below drives it from the coordinator's existing
// poll cadence (one evaluation per delivered observation), so read costs
// scale only with opted-in PRs.
//
// Eligibility semantics (v1, all must hold; any failure fails closed):
//   - the task's live card still opts in, is armed at the CURRENT repository
//     policy revision, and sits in in_progress/review;
//   - no other simultaneously-eligible task claims the same canonical PR;
//   - the selected automation PR is GitHub open and not draft, has a known
//     clean merge state, no conflicting native auto-merge, and no unknown
//     head/base identity;
//   - the evidence envelope is complete, fresh, and collected for the
//     current access scope;
//   - every policy-named check exists and its latest attempt on the current
//     head concludes success (neutral/skipped are non-success);
//   - at least one effective current-head approval exists from a non-author
//     reviewer (later CHANGES_REQUESTED blocks until that reviewer's valid
//     current-head approval or a GitHub dismissal);
//   - no unresolved review threads, no active writer, no outstanding
//     comment-repair dispatch, and no PR-gate reservation held by another task.
//
// "blocked" is a structural / permission / configuration problem; "waiting"
// is a normal pending condition. When eligible, the observer emits an
// internal handoff callback for the AM-4 executor (a no-op recorder until
// AM-4 binds the real merge operation).
import {
	AUTO_MERGE_ELIGIBILITY_SCHEMA_VERSION,
	type AutoMergeCheckEvidence,
	type AutoMergeEligibilityBlocker,
	type AutoMergeEligibilityKind,
	type AutoMergeEligibilityResult,
	type AutoMergeEligibilitySummary,
	type AutoMergeEvidenceEnvelope,
	type AutoMergePolicy,
	type AutoMergeReviewEvidence,
	type GitHubPrTrackingRecord,
	type RuntimeBoardCard,
	type RuntimeBoardColumnId,
} from "../core/api-contract";
import { isNewerCheckAttempt } from "./auto-merge-evidence";
import { PR_CONSUMER_READ_SOURCES, type PrConsumerObservation, type PrConsumerRegistry } from "./pr-consumer-registry";
import { PR_OWNER_ACTIVE_COLUMNS, type PrBoardSnapshot, resolveCardAutomationPrKey } from "./pr-owner-selection";
import type { PrRecordStorePort } from "./pr-record-store";
import type { PrTrackingCoordinator } from "./pr-tracking-coordinator";

/** Default evidence freshness budget: two poll intervals (60s cadence). */
export const AUTO_MERGE_MAX_EVIDENCE_AGE_MS = 2 * 60 * 1000;
/** The persisted summary keeps at most this many blocker codes. */
export const AUTO_MERGE_SUMMARY_CODE_LIMIT = 10;

/** Live task facts the evaluator needs (re-read from the board, never cached). */
export interface AutoMergeEligibilityTaskFacts {
	workspaceId: string;
	taskId: string;
	column: RuntimeBoardColumnId;
	/** The live `autoMergeWhenApproved` checkbox. */
	optIn: boolean;
	/** The armed repository-policy revision (null = opted in but never armed). */
	armedPolicyRevision: number | null;
	/** Repository recorded on the card's automation PR link (lowercase owner/repo). */
	expectedRepository: string | null;
	/** The card's expected target base ref (its `baseRef`). */
	expectedBaseRef: string | null;
}

export interface AutoMergeEligibilityInput {
	task: AutoMergeEligibilityTaskFacts;
	/** The CURRENT repository policy (null when the repository has none). */
	policy: AutoMergePolicy | null;
	envelope: AutoMergeEvidenceEnvelope;
	/** Other simultaneously-eligible opted-in tasks claiming this canonical PR. */
	otherClaimantCount: number;
	/** The durable PR record state (reservation, comment dispatch, ...). */
	record: GitHubPrTrackingRecord;
	/** True while the task's own writer (terminal/Cline/review session) is live. */
	writerActive: boolean;
	/** The access scope that produced the observation the envelope was read for. */
	accessScopeId: string;
	/** The wall-clock instant of this evaluation. */
	now: number;
	/** Maximum tolerated evidence age (defaults to AUTO_MERGE_MAX_EVIDENCE_AGE_MS). */
	maxEvidenceAgeMs?: number;
}

/**
 * Blocker codes with their priority order. `blocked` codes precede
 * `waiting` codes; within each group the order below is fixed and
 * deterministic (used for tests and the persisted summary).
 */
export const AUTO_MERGE_BLOCKED_CODES = [
	"disabled",
	"not_armed",
	"inactive_task",
	"no_policy",
	"policy_mismatch",
	"ambiguous_claim",
	"auth",
	"access",
	"unsupported_host",
	"malformed_key",
	"internal_error",
	"stale_scope",
	"head_unknown",
	"base_unknown",
	"pr_identity_mismatch",
	"pr_closed",
	"pr_merged",
	"merge_conflicts",
	"native_auto_merge",
	"review_inconsistent",
	"no_required_checks",
] as const;

/** Envelope reason tokens that map to `blocked` (permission/configuration). */
const BLOCKED_EVIDENCE_REASONS = new Set<string>(["auth", "access", "unsupported_host", "malformed_key"]);
/** Envelope reason tokens that map to the waiting `head_changed` code. */
const HEAD_CHANGED_REASONS = new Set<string>(["head_changed", "declared_head_mismatch"]);

function normalizeRepo(repo: string): string {
	return repo.toLowerCase();
}

// ── Review classification ─────────────────────────────────────────────────────

export interface AutoMergeReviewVerdict {
	/** Non-author reviewers with an effective current-head approval. */
	approvers: string[];
	/** Reviewers whose CHANGES_REQUESTED is not superseded. */
	blockingChangeRequests: string[];
	/** Reviewers whose decisions tie on timestamps (inconsistent ordering). */
	inconsistent: string[];
}

function sortReviewsDescending(a: AutoMergeReviewEvidence, b: AutoMergeReviewEvidence): number {
	const aTs = a.submittedAt ?? -1;
	const bTs = b.submittedAt ?? -1;
	if (aTs !== bTs) {
		return bTs - aTs;
	}
	return b.id.localeCompare(a.id);
}

/**
 * Pure per-reviewer classification over the provider's full review list.
 *
 * Per reviewer (non-author): the LATEST submitted non-dismissed decision
 * review wins. A `CHANGES_REQUESTED` blocks until that reviewer's own valid
 * current-head approval (strictly later, or a GitHub dismissal of the CR)
 * supersedes it. Approvals are only valid when they target the CURRENT head
 * SHA and the reviewer identity is known and non-author; stale-head,
 * pending-only, dismissed-only, and self-approvals never count.
 */
export function classifyAutoMergeReviews(
	reviews: AutoMergeReviewEvidence[],
	headSha: string | null,
	authorLogin: string | null,
): AutoMergeReviewVerdict {
	const verdict: AutoMergeReviewVerdict = { approvers: [], blockingChangeRequests: [], inconsistent: [] };
	if (headSha === null || authorLogin === null) {
		// Unknown head or unknown PR author: no approval can be validated.
		return verdict;
	}
	const byReviewer = new Map<string, AutoMergeReviewEvidence[]>();
	for (const review of reviews) {
		// Self-reviews never count (the author cannot review own PR; a record
		// that does is not a valid approval and not a valid CR).
		if (review.authorLogin === authorLogin) {
			continue;
		}
		if (review.state === "PENDING" || review.state === "DISMISSED") {
			continue;
		}
		const list = byReviewer.get(review.authorLogin) ?? [];
		list.push(review);
		byReviewer.set(review.authorLogin, list);
	}
	for (const [reviewer, list] of [...byReviewer.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const changeRequests = list.filter((review) => review.state === "CHANGES_REQUESTED");
		const approvals = list.filter(
			(review) =>
				review.state === "APPROVED" &&
				review.submittedAt !== null &&
				review.commitId === headSha &&
				reviewer !== "unknown",
		);
		const latestCR = changeRequests.length > 0 ? changeRequests.sort(sortReviewsDescending)[0] : null;
		const latestApproval = approvals.length > 0 ? approvals.sort(sortReviewsDescending)[0] : null;
		if (latestCR && latestApproval && latestCR.submittedAt === latestApproval.submittedAt) {
			// Tied timestamps: the ordering between the two decisions is
			// unverifiable — never guess.
			verdict.inconsistent.push(reviewer);
			continue;
		}
		if (latestApproval && (!latestCR || (latestCR.submittedAt ?? -1) < (latestApproval.submittedAt ?? -1))) {
			verdict.approvers.push(reviewer);
			continue;
		}
		if (latestCR) {
			verdict.blockingChangeRequests.push(reviewer);
		}
	}
	return verdict;
}

// ── Check classification ──────────────────────────────────────────────────────

export type AutoMergeRequiredCheckOutcome = "success" | "pending" | "failed" | "missing";

export interface AutoMergeRequiredCheckVerdict {
	/** The policy check name (case-sensitive exact name). */
	name: string;
	outcome: AutoMergeRequiredCheckOutcome;
}

/** Classify one effective attempt (latest-by-occurredAt, then runId). */
function classifyCheckAttempt(entry: AutoMergeCheckEvidence): Exclude<AutoMergeRequiredCheckOutcome, "missing"> {
	if (entry.kind === "check_run") {
		if (entry.status === "completed") {
			return entry.conclusion === "success" ? "success" : "failed";
		}
		// Queued / in-progress / unknown status: the attempt is still open.
		return "pending";
	}
	// commit_status: the state is carried in `conclusion`.
	if (entry.conclusion === "success") {
		return "success";
	}
	if (entry.conclusion === "failure" || entry.conclusion === "error") {
		return "failed";
	}
	return "pending";
}

/**
 * Pure per-required-check classification. Both evidence sources (check runs
 * and commit statuses) are combined by exact name; the effective attempt is
 * the latest by (occurredAt, runId), so a newer pending/failed attempt can
 * never be masked by an older success. Unrelated checks are ignored: only
 * the policy's named checks gate eligibility.
 */
export function classifyRequiredChecks(
	policy: AutoMergePolicy | null,
	envelope: AutoMergeEvidenceEnvelope,
): AutoMergeRequiredCheckVerdict[] {
	const verdicts: AutoMergeRequiredCheckVerdict[] = [];
	if (policy === null) {
		return verdicts;
	}
	const all: AutoMergeCheckEvidence[] = [...envelope.checks, ...envelope.statuses];
	for (const name of policy.requiredChecks) {
		const candidates = all.filter((entry) => entry.name === name);
		if (candidates.length === 0) {
			verdicts.push({ name, outcome: "missing" });
			continue;
		}
		// Effective attempt: the AM-2 isNewerCheckAttempt ordering (latest
		// occurredAt, then numeric run id), so this tie-break agrees exactly
		// with the evidence collector's own selection.
		const effective = candidates.reduce((best, candidate) =>
			isNewerCheckAttempt(candidate, best) ? candidate : best,
		);
		verdicts.push({ name, outcome: classifyCheckAttempt(effective) });
	}
	return verdicts;
}

// ── The pure eligibility evaluation ──────────────────────────────────────────

/**
 * Evaluate auto-merge eligibility for one task against one evidence envelope.
 * Pure: no I/O, deterministic, fail-closed. Blocker order is fixed (blocked
 * codes first, then waiting codes, each in the order documented above).
 */
export function evaluateAutoMergeEligibility(input: AutoMergeEligibilityInput): AutoMergeEligibilityResult {
	const { task, policy, envelope, record, now } = input;
	const blockers: AutoMergeEligibilityBlocker[] = [];
	const add = (code: string, message: string): void => {
		blockers.push({ code, message });
	};

	// Phase A: task / policy / claim.
	if (!task.optIn) {
		add("disabled", "Auto-merge is not enabled for this task.");
	} else if (task.armedPolicyRevision === null) {
		add("not_armed", "The task is not armed against a repository policy revision.");
	}
	if (!PR_OWNER_ACTIVE_COLUMNS.has(task.column)) {
		add("inactive_task", "The task is not in In Progress or In Review.");
	}
	if (policy === null) {
		add("no_policy", "The repository has no auto-merge policy.");
	} else if (task.armedPolicyRevision !== null && policy.revision !== task.armedPolicyRevision) {
		add(
			"policy_mismatch",
			`Armed against policy revision ${task.armedPolicyRevision}; the current revision is ${policy.revision}. Re-enable to re-arm.`,
		);
	}
	if (input.otherClaimantCount > 0) {
		add("ambiguous_claim", `${input.otherClaimantCount} other task(s) also claim this PR for auto-merge.`);
	}

	// Phase B: evidence identity / auth.
	const reasons = new Set(envelope.reasons);
	for (const token of reasons) {
		if (BLOCKED_EVIDENCE_REASONS.has(token)) {
			add(token, `Evidence read blocked by the provider: ${token}.`);
		}
	}
	if (envelope.reasons.some((token) => token.startsWith("internal_error:"))) {
		add("internal_error", "Evidence collection hit an internal error.");
	}
	if (envelope.accessScopeId !== input.accessScopeId) {
		add("stale_scope", "The evidence was collected under a different access scope; re-reading.");
	}
	if (envelope.headSha === null) {
		add("head_unknown", "The PR's current head SHA is unknown.");
	}
	if (envelope.baseSha === null) {
		add("base_unknown", "The PR's current base SHA is unknown.");
	}
	if (
		envelope.baseRepository !== null &&
		task.expectedRepository !== null &&
		normalizeRepo(envelope.baseRepository) !== normalizeRepo(task.expectedRepository)
	) {
		add("pr_identity_mismatch", "The PR's base repository does not match the task's repository.");
	}
	if (task.expectedBaseRef !== null && envelope.baseRef !== null && envelope.baseRef !== task.expectedBaseRef) {
		add(
			"pr_identity_mismatch",
			`The PR targets base '${envelope.baseRef}'; the task expects '${task.expectedBaseRef}'.`,
		);
	}

	// Phase C: PR state.
	if (envelope.prState === "closed") {
		add("pr_closed", "The PR is closed without merging.");
	} else if (envelope.prState === "merged") {
		add("pr_merged", "The PR is already merged.");
	}
	if (envelope.draft || envelope.prState === "draft") {
		add("pr_draft", "The PR is still a draft.");
	}
	if (envelope.prState === "unknown") {
		add("pr_state_unknown", "The PR state could not be determined.");
	}
	if (envelope.mergeable === null) {
		add("mergeability_unknown", "GitHub has not computed mergeability for the current head.");
	}
	if (envelope.mergeable === false) {
		add("merge_conflicts", "The current head does not merge cleanly into the base branch.");
	}
	if (envelope.autoMergePresent === true) {
		add("native_auto_merge", "GitHub native auto-merge is already enabled for this PR.");
	}

	// Phase D: evidence completeness / freshness.
	if (reasons.has("head_changed") || reasons.has("declared_head_mismatch")) {
		add("head_changed", "The head moved during evidence collection; a fresh read is pending.");
	}
	const incompleteReasons = [...reasons]
		.filter(
			(token) =>
				!BLOCKED_EVIDENCE_REASONS.has(token) &&
				!HEAD_CHANGED_REASONS.has(token) &&
				!token.startsWith("internal_error:"),
		)
		.sort();
	if (!envelope.complete || incompleteReasons.length > 0) {
		add(
			"evidence_incomplete",
			`Evidence is incomplete: ${incompleteReasons.join(", ") || "unknown source failure"}.`,
		);
	}
	const evidenceAgeMs = Math.max(0, now - envelope.checkedAt);
	const maxEvidenceAgeMs = input.maxEvidenceAgeMs ?? AUTO_MERGE_MAX_EVIDENCE_AGE_MS;
	if (evidenceAgeMs > maxEvidenceAgeMs) {
		add(
			"evidence_stale",
			`Evidence is ${Math.floor(evidenceAgeMs / 1000)}s old (budget ${Math.floor(maxEvidenceAgeMs / 1000)}s).`,
		);
	}

	// Phase E: policy-named checks on the current head.
	let requiredVerdicts: AutoMergeRequiredCheckVerdict[] = [];
	if (policy !== null) {
		if (policy.requiredChecks.length === 0) {
			add("no_required_checks", "The policy's required-checks list is empty; refusing to merge without gates.");
		} else {
			requiredVerdicts = classifyRequiredChecks(policy, envelope);
			const names = (outcome: AutoMergeRequiredCheckOutcome): string[] =>
				requiredVerdicts.filter((verdict) => verdict.outcome === outcome).map((verdict) => verdict.name);
			const missing = names("missing");
			if (missing.length > 0) {
				add("check_missing", `No check run for: ${missing.join(", ")}.`);
			}
			const pending = names("pending");
			if (pending.length > 0) {
				add("check_pending", `Check run(s) still in progress: ${pending.join(", ")}.`);
			}
			const failed = names("failed");
			if (failed.length > 0) {
				add("check_failed", `Check run(s) failed or were cancelled: ${failed.join(", ")}.`);
			}
		}
	}

	// Phase F: reviews and threads.
	const reviewVerdict = classifyAutoMergeReviews(envelope.reviews, envelope.headSha, envelope.authorLogin);
	if (reviewVerdict.inconsistent.length > 0) {
		add("review_inconsistent", `Review ordering is inconsistent for: ${reviewVerdict.inconsistent.join(", ")}.`);
	}
	if (reviewVerdict.blockingChangeRequests.length > 0) {
		add(
			"changes_requested",
			`Unsuperseded changes requested by: ${reviewVerdict.blockingChangeRequests.join(", ")}.`,
		);
	}
	if (reviewVerdict.approvers.length === 0) {
		add("no_approval", "No effective current-head approval from a non-author reviewer yet.");
	}
	if (envelope.unresolvedActiveThreads !== null && envelope.unresolvedActiveThreads > 0) {
		add("unresolved_threads", `${envelope.unresolvedActiveThreads} unresolved review thread(s) remain.`);
	}

	// Phase G: competing operations on the record.
	if (input.writerActive) {
		add("writer_active", "The task's writer is still active; waiting for it to settle.");
	}
	const dispatch = record.commentAutomation.dispatch;
	if (
		dispatch !== null &&
		dispatch.status !== "completed" &&
		record.commentAutomation.pendingFeedbackFingerprint !== null
	) {
		add("comment_repair_pending", `A comment-repair dispatch is still ${dispatch.status} with pending feedback.`);
	}
	const reservation = record.reservation;
	if (reservation.state === "reserved") {
		const heldByOther =
			reservation.reservedBy === null ||
			reservation.reservedBy.workspaceId !== task.workspaceId ||
			reservation.reservedBy.taskId !== task.taskId;
		if (heldByOther) {
			add("pr_reserved", "The PR operation gate is reserved by another task.");
		}
	}

	const hasBlocked = blockers.some((blocker) =>
		(AUTO_MERGE_BLOCKED_CODES as readonly string[]).includes(blocker.code),
	);
	const kind: AutoMergeEligibilityKind = hasBlocked ? "blocked" : blockers.length > 0 ? "waiting" : "eligible";
	return {
		schemaVersion: AUTO_MERGE_ELIGIBILITY_SCHEMA_VERSION,
		kind,
		blockers,
		evaluatedAt: now,
		headSha: envelope.headSha,
		baseSha: envelope.baseSha,
		policyRevision: task.armedPolicyRevision ?? 0,
		evidenceCheckedAt: envelope.checkedAt,
		evidenceAgeMs,
	};
}

/** Project a full evaluation result to the small persisted summary. */
export function toAutoMergeEligibilitySummary(result: AutoMergeEligibilityResult): AutoMergeEligibilitySummary {
	return {
		schemaVersion: AUTO_MERGE_ELIGIBILITY_SCHEMA_VERSION,
		kind: result.kind,
		codes: result.blockers.map((blocker) => blocker.code).slice(0, AUTO_MERGE_SUMMARY_CODE_LIMIT),
		evaluatedAt: result.evaluatedAt,
		headSha: result.headSha,
		baseSha: result.baseSha,
		policyRevision: result.policyRevision,
		evidenceCheckedAt: result.evidenceCheckedAt,
	};
}
// ── The auto-merge consumer observer ──────────────────────────────────────────

/**
 * The internal handoff emitted when a task becomes eligible. AM-4 binds the
 * real merge operation to this callback; until then production installs a
 * no-op recorder. The handoff carries only verified, fresh facts.
 */
export interface AutoMergeEligibilityHandoff {
	workspaceId: string;
	taskId: string;
	canonicalPrKey: string;
	headSha: string;
	baseSha: string;
	policy: AutoMergePolicy;
	accessScopeId: string;
	evaluatedAt: number;
}

export interface AutoMergeConsumerDeps {
	store: PrRecordStorePort;
	/** Lazy coordinator accessor (evidence reads + poll-state reuse). */
	getCoordinator: () => PrTrackingCoordinator | null;
	/** Single-task live board read (fresh card state, never cached). */
	getTaskCard: (
		workspaceId: string,
		taskId: string,
	) => Promise<{ card: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null>;
	listBoards: () => Promise<PrBoardSnapshot[]>;
	loadPolicy: (repository: string) => Promise<AutoMergePolicy | null>;
	/** Live writer liveness for the task (defaults to inactive). */
	isTaskWriterActive?: (workspaceId: string, taskId: string) => Promise<boolean> | boolean;
	/**
	 * The AM-4 executor seam. AM-3 installs a no-op recorder; the real merge
	 * reservation/execution lands with AM-4.
	 */
	onEligible?: (handoff: AutoMergeEligibilityHandoff) => void | Promise<void>;
	warn?: (message: string) => void;
	now?: () => number;
}

/**
 * Count other tasks that currently claim the same canonical PR for
 * auto-merge (active column + live opt-in + armed + resolvable to this PR).
 * The caller's own task is excluded.
 */
async function countOtherEligibleClaimants(
	canonicalPrKey: string,
	task: { workspaceId: string; taskId: string },
	listBoards: () => Promise<PrBoardSnapshot[]>,
): Promise<number> {
	const boards = await listBoards();
	let count = 0;
	for (const { board } of boards) {
		for (const column of board.columns) {
			if (!PR_OWNER_ACTIVE_COLUMNS.has(column.id)) {
				continue;
			}
			for (const card of column.cards) {
				if (card.id === task.taskId) {
					continue;
				}
				if (card.autoMergeWhenApproved !== true || card.armedAutoMergePolicyRevision === undefined) {
					continue;
				}
				if (resolveCardAutomationPrKey(card).key === canonicalPrKey) {
					count += 1;
				}
			}
		}
	}
	return count;
}

/**
 * The auto-merge consumer observation hook. Runs once per delivered poll
 * observation for the task: re-reads the live card (opt-in / column /
 * selection), reads the authoritative evidence envelope through the
 * coordinator (coalesced with the poll's own reads), evaluates the pure
 * eligibility function, persists the small summary on the task binding,
 * and emits the eligibility handoff when (and only when) eligible.
 *
 * Idempotent: re-evaluating the same state only refreshes the summary and
 * re-arms the handoff (AM-4 reserves before any merge write, so a duplicate
 * handoff cannot double-merge).
 */
export async function reconcileAutoMergeEligibility(
	observation: PrConsumerObservation,
	deps: AutoMergeConsumerDeps,
): Promise<void> {
	const task = observation.task;
	const found = await deps.getTaskCard(task.workspaceId, task.taskId);
	if (!found) {
		return;
	}
	const card = found.card;
	const resolved = resolveCardAutomationPrKey(card);
	// The observation's PR is stale for this card (selection changed, link
	// removed): the reconcile pass is already re-deriving demand; do not
	// evaluate against the wrong PR.
	if (resolved.key !== observation.record.canonicalPrKey) {
		return;
	}
	// Disabling is immediate: no evaluation, no record write, no handoff.
	// The subscription's autoMerge consumer flag drops on the next reconcile.
	if (card.autoMergeWhenApproved !== true || card.armedAutoMergePolicyRevision === undefined) {
		return;
	}
	const coordinator = deps.getCoordinator();
	if (!coordinator) {
		return;
	}
	const armedRevision = card.armedAutoMergePolicyRevision;
	const accessScopeId = observation.snapshot.accessScopeId;
	const [policy, otherClaimantCount, writerRaw] = await Promise.all([
		deps.loadPolicy(observation.record.repository),
		countOtherEligibleClaimants(observation.record.canonicalPrKey, task, deps.listBoards),
		Promise.resolve(deps.isTaskWriterActive?.(task.workspaceId, task.taskId)),
	]);
	const writerActive = writerRaw === true;
	// The evidence read is consumer-requested and coalesced per (PR, scope,
	// options) — never a new timer, never duplicated within a poll.
	const envelope = await coordinator.readAutoMergeEvidence(observation.record.canonicalPrKey, accessScopeId, {
		policyRevision: armedRevision,
	});
	const result = evaluateAutoMergeEligibility({
		task: {
			workspaceId: task.workspaceId,
			taskId: task.taskId,
			column: found.columnId,
			optIn: card.autoMergeWhenApproved === true,
			armedPolicyRevision: armedRevision,
			expectedRepository: observation.record.repository,
			expectedBaseRef: card.baseRef ?? null,
		},
		policy,
		envelope,
		otherClaimantCount,
		record: observation.record,
		writerActive,
		accessScopeId,
		now: (deps.now ?? Date.now)(),
	});
	// Persist the small summary/diagnostic (best-effort: a failed write is
	// retried on the next observation; the handoff re-verifies state itself).
	await deps.store
		.updateTaskBinding(observation.record.canonicalPrKey, task, undefined, (item) => ({
			...item,
			autoMerge: toAutoMergeEligibilitySummary(result),
		}))
		.then((write) => {
			if (!write.ok) {
				deps.warn?.(`Auto-merge eligibility summary write failed (${write.reason}); will retry`);
			}
		})
		.catch((error: unknown) => {
			deps.warn?.(`Auto-merge eligibility summary write failed: ${String(error)}`);
		});
	if (result.kind !== "eligible") {
		return;
	}
	if (result.headSha === null || result.baseSha === null || policy === null) {
		// Defensive: the evaluator never reports eligible without these.
		return;
	}
	const handoff: AutoMergeEligibilityHandoff = {
		workspaceId: task.workspaceId,
		taskId: task.taskId,
		canonicalPrKey: observation.record.canonicalPrKey,
		headSha: result.headSha,
		baseSha: result.baseSha,
		policy,
		accessScopeId,
		evaluatedAt: result.evaluatedAt,
	};
	try {
		await deps.onEligible?.(handoff);
	} catch (error) {
		deps.warn?.(`Auto-merge eligibility handoff failed for ${task.taskId}: ${String(error)}`);
	}
}

/**
 * Register the auto-merge eligibility consumer on the installed-consumer
 * registry. The kind's default read sources apply (metadata only: it rides
 * the poll that delivers observations).
 */
export function registerAutoMergeConsumer(registry: PrConsumerRegistry, deps: AutoMergeConsumerDeps): void {
	registry.register({
		kind: "autoMerge",
		requiredReadSources: PR_CONSUMER_READ_SOURCES.autoMerge,
		onObservation: (observation) => reconcileAutoMergeEligibility(observation, deps),
	});
}
