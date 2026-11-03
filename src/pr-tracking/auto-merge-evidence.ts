// AM-2: bounded, read-only GitHub merge-evidence reader.
//
// Collects complete-or-explicitly-incomplete evidence for ONE canonical PR,
// one access scope, and one exact head SHA: authoritative PR metadata
// (state/draft/base/head/mergeable/author/native-auto-merge), ALL pages of
// submitted reviews with raw state/actor/commit-id facts, check runs and
// commit statuses for the exact head, and review-thread resolution (raw
// bodies never leave the provider). The collection is coherent: metadata is
// re-read after the sources, and any head/base identity change discards the
// evidence (retry next eligible cycle).
//
// This module NEVER merges, arms, writes to GitHub, or starts a timer. The
// coordinator exposes it as a consumer-requested read that coalesces
// concurrent requests per (PR, scope); unrelated tasks never trigger
// these reads. The normalization layer is pure and injectable (tests script
// the adapter's gh runner).
import type { AutoMergeCheckEvidence, AutoMergeEvidenceEnvelope, AutoMergeReviewEvidence } from "../core/api-contract";
import { AUTO_MERGE_EVIDENCE_SCHEMA_VERSION } from "../core/api-contract";
import type {
	AccessScope,
	CommitStatusesReadResult,
	FeedbackReadResult,
	GhAdapterFailure,
	GitHubGhAdapter,
	MetadataReadResult,
	RawRestListResult,
} from "./github-gh-adapter";
import type { ParsedCanonicalPrKey } from "./pr-identity";
import type { PrThreadInfo } from "./pr-snapshots";

type RawObject = Record<string, unknown>;

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asIsoMs(value: unknown): number | null {
	const raw = asString(value);
	if (!raw) {
		return null;
	}
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : null;
}

function asObject(value: unknown): RawObject | null {
	return typeof value === "object" && value !== null ? (value as RawObject) : null;
}

function authorInfo(value: unknown): { login: string; kind: "human" | "bot" } {
	const author = asObject(value);
	return {
		login: asString(author?.login) ?? "unknown",
		kind: author?.type === "Bot" ? "bot" : "human",
	};
}

/**
 * Normalize GitHub review events for merge approval evidence. Unlike the
 * feedback `normalizeReviews` (which reduces state to pending/submitted),
 * this keeps the RAW review state plus the authoritative approval facts:
 * actor, head commit the review was submitted against (`commit_id`), and
 * submission time. No inference from (absent) body text: a COMMENTED review
 * with approving prose is still just a comment.
 */
export function normalizeMergeReviews(rawItems: unknown[], ownAccountLogin: string): AutoMergeReviewEvidence[] {
	const reviews: AutoMergeReviewEvidence[] = [];
	for (const item of rawItems) {
		const review = asObject(item);
		const id = asString(review?.id) ?? asString(review?.node_id);
		if (!id) {
			continue;
		}
		const author = authorInfo(review?.user);
		reviews.push({
			id,
			state: asString(review?.state)?.toUpperCase() ?? "",
			authorLogin: author.login,
			authorKind: author.kind,
			isOwnAccount: author.login === ownAccountLogin,
			commitId: asString(review?.commit_id),
			submittedAt: asIsoMs(review?.submitted_at),
		});
	}
	return reviews;
}

/**
 * Latest-attempt ordering for duplicate check names: a later
 * completion/started timestamp always wins, then the higher provider run id.
 * An older success therefore never masks a newer failing or pending attempt
 * (a pending attempt's later `started_at` outranks an older completed
 * success's `completed_at`).
 */
export function isNewerCheckAttempt(candidate: AutoMergeCheckEvidence, current: AutoMergeCheckEvidence): boolean {
	if (candidate.occurredAt !== current.occurredAt) {
		return candidate.occurredAt > current.occurredAt;
	}
	const candidateId = Number(candidate.runId);
	const currentId = Number(current.runId);
	if (Number.isFinite(candidateId) && Number.isFinite(currentId)) {
		return candidateId > currentId;
	}
	return candidate.runId > current.runId;
}

/**
 * Effective latest check-run attempt per check name for the exact head SHA.
 * Runs whose `head_sha` differs from the declared head are never evidence
 * for this head and are dropped.
 */
export function selectEffectiveCheckRuns(rawItems: unknown[], headSha: string): AutoMergeCheckEvidence[] {
	const effective = new Map<string, AutoMergeCheckEvidence>();
	for (const item of rawItems) {
		const run = asObject(item);
		const name = asString(run?.name);
		if (!name) {
			continue;
		}
		if (asString(run?.head_sha) !== headSha) {
			continue;
		}
		const app = asObject(run?.app);
		const runId = typeof run?.id === "number" ? String(run.id) : (asString(run?.external_id) ?? "");
		const candidate: AutoMergeCheckEvidence = {
			kind: "check_run",
			name,
			sourceId: typeof app?.id === "number" ? String(app.id) : (asString(run?.external_id) ?? null),
			status: asString(run?.status),
			conclusion: asString(run?.conclusion),
			sha: headSha,
			runId,
			occurredAt: asIsoMs(run?.completed_at) ?? asIsoMs(run?.started_at) ?? 0,
		};
		const current = effective.get(name);
		if (!current || isNewerCheckAttempt(candidate, current)) {
			effective.set(name, candidate);
		}
	}
	return [...effective.values()];
}

/**
 * Effective latest commit status per context for the exact head SHA.
 * The status `state` is carried as `conclusion`; `status` is the mapped
 * phase (`completed` for terminal states, `in_progress` for pending, null
 * for unknown provider states).
 */
export function selectEffectiveCommitStatuses(rawItems: unknown[], headSha: string): AutoMergeCheckEvidence[] {
	const effective = new Map<string, AutoMergeCheckEvidence>();
	for (const item of rawItems) {
		const status = asObject(item);
		const name = asString(status?.context);
		if (!name) {
			continue;
		}
		const state = asString(status?.state);
		const creator = authorInfo(status?.creator);
		const runId = typeof status?.id === "number" ? String(status.id) : "";
		const candidate: AutoMergeCheckEvidence = {
			kind: "commit_status",
			name,
			sourceId: creator.login === "unknown" ? null : creator.login,
			status:
				state === "pending"
					? "in_progress"
					: state === "success" || state === "error" || state === "failure"
						? "completed"
						: null,
			conclusion: state,
			sha: headSha,
			runId,
			occurredAt: asIsoMs(status?.updated_at) ?? asIsoMs(status?.created_at) ?? 0,
		};
		const current = effective.get(name);
		if (!current || isNewerCheckAttempt(candidate, current)) {
			effective.set(name, candidate);
		}
	}
	return [...effective.values()];
}

/**
 * Unresolved, non-outdated (ACTIVE) review threads from the thread map.
 * The map is keyed per comment id, so distinct thread info objects are
 * counted by identity (one count per thread).
 */
export function countUnresolvedActiveThreads(threads: Map<string, PrThreadInfo>): number {
	const seen = new Set<PrThreadInfo>();
	for (const info of threads.values()) {
		if (info.resolved || info.outdated) {
			continue;
		}
		seen.add(info);
	}
	return seen.size;
}

export interface AutoMergeEvidenceOptions {
	/** Repository policy revision this evidence was read for (envelope fact). */
	policyRevision: number;
	/**
	 * Optional caller-expected head SHA. When present and different from
	 * the live head, the evidence is discarded immediately
	 * (`declared_head_mismatch`) without further reads.
	 */
	declaredHeadSha?: string | null;
	now?: () => number;
}

/**
 * Result of one evidence collection. `failures` is a non-schema side
 * channel carrying the ORIGINAL adapter failure objects (in source order),
 * so consumers retain provider facts — notably `rateLimitResetAt` — that
 * the envelope's reason tokens discard.
 */
export interface AutoMergeEvidenceResult {
	envelope: AutoMergeEvidenceEnvelope;
	failures: GhAdapterFailure[];
}

function baseEnvelope(
	accessScopeId: string,
	checkedAt: number,
	policyRevision: number,
	headSha: string | null,
): AutoMergeEvidenceEnvelope {
	return {
		schemaVersion: AUTO_MERGE_EVIDENCE_SCHEMA_VERSION,
		accessScopeId,
		checkedAt,
		policyRevision,
		headSha,
		baseSha: null,
		baseRepository: null,
		baseRef: null,
		headRepository: null,
		headRef: null,
		prState: "unknown",
		draft: false,
		mergeable: null,
		mergeableState: null,
		authorLogin: null,
		autoMergePresent: null,
		sources: {
			prMetadata: false,
			reviews: false,
			checkRuns: false,
			commitStatuses: false,
			reviewThreads: false,
		},
		unresolvedActiveThreads: null,
		complete: false,
		reasons: [],
		reviews: [],
		checks: [],
		statuses: [],
	};
}

function addReason(reasons: string[], reason: string): void {
	if (!reasons.includes(reason)) {
		reasons.push(reason);
	}
}

/**
 * Collect one coherent exact-head evidence snapshot. Always resolves to an
 * envelope: `complete: true` only when every source read to completion and
 * the head/base identity did not change between the first and final
 * metadata reads. Every failure mode lands in `reasons` with stable tokens
 * (never "green").
 */
export async function collectAutoMergeEvidence(
	adapter: GitHubGhAdapter,
	parsed: ParsedCanonicalPrKey,
	scope: AccessScope,
	options: AutoMergeEvidenceOptions,
): Promise<AutoMergeEvidenceResult> {
	const now = options.now ?? Date.now;
	const policyRevision = options.policyRevision;
	const repo = parsed.repository;
	const number = parsed.number;
	const failures: GhAdapterFailure[] = [];

	// Cache-neutral conditional reads: `recordDigest: false` keeps this read
	// from recording digests into the adapter's shared cache, which the
	// poller relies on for its own `not_modified` short-circuits.
	const initial: MetadataReadResult = await adapter.readPrMetadata(parsed, scope, {
		fresh: true,
		recordDigest: false,
	});
	if (initial.kind !== "ok") {
		if (initial.kind === "failed") {
			failures.push(initial.failure);
		}
		const envelope = baseEnvelope(scope.accessScopeId, now(), policyRevision, options.declaredHeadSha ?? null);
		addReason(envelope.reasons, initial.kind === "failed" ? initial.failure.category : "metadata_unreadable");
		return { envelope, failures };
	}
	const headSha = initial.metadata.headSha;
	if (headSha === null) {
		const envelope = baseEnvelope(scope.accessScopeId, now(), policyRevision, null);
		addReason(envelope.reasons, "head_unknown");
		return { envelope, failures };
	}
	const start = {
		headSha,
		baseSha: initial.metadata.baseSha,
		baseRef: initial.metadata.baseRef,
		baseRepository: initial.metadata.baseRepository,
		headRef: initial.metadata.headRef,
		headRepository: initial.metadata.headRepository,
	};
	if (options.declaredHeadSha && options.declaredHeadSha !== headSha) {
		// The caller's expected head is not the live head: this evidence is
		// for the wrong commit. Discard immediately (bounded, no further
		// reads); the next eligible cycle re-requests with the live head.
		const envelope = baseEnvelope(scope.accessScopeId, now(), policyRevision, headSha);
		Object.assign(envelope, {
			baseSha: start.baseSha ?? null,
			baseRef: start.baseRef,
			baseRepository: start.baseRepository,
			headRef: start.headRef,
			headRepository: start.headRepository,
			prState: initial.metadata.state,
			draft: initial.metadata.state === "draft",
			mergeable: initial.metadata.mergeable ?? null,
			mergeableState: initial.metadata.mergeableState ?? null,
			authorLogin: initial.metadata.authorLogin ?? null,
			autoMergePresent: initial.metadata.autoMergePresent ?? null,
		});
		addReason(envelope.reasons, "declared_head_mismatch");
		return { envelope, failures };
	}

	const nodeId = initial.nodeId;
	const [reviews, checkRuns, statuses, threads] = (await Promise.all([
		adapter.readRawRestList(`repos/${repo}/pulls/${number}/reviews`),
		adapter.readRawRestList(`repos/${repo}/commits/${headSha}/check-runs`, "check_runs"),
		adapter.readCommitStatuses(`repos/${repo}/commits/${headSha}/status`),
		nodeId
			? adapter.readReviewThreads(parsed, scope, nodeId, { fresh: true, recordDigest: false })
			: Promise.resolve<FeedbackReadResult>({
					kind: "failed",
					failure: { category: "network", message: "missing PR node id", at: now() },
				}),
	])) as [RawRestListResult, RawRestListResult, CommitStatusesReadResult, FeedbackReadResult];

	// Coherent-snapshot check: re-read the authoritative identity and discard
	// if ANY of head/base changed while the sources were being collected.
	const final: MetadataReadResult = await adapter.readPrMetadata(parsed, scope, {
		fresh: true,
		recordDigest: false,
	});
	const envelope = baseEnvelope(scope.accessScopeId, now(), policyRevision, headSha);
	Object.assign(envelope, {
		baseSha: start.baseSha ?? null,
		baseRef: start.baseRef,
		baseRepository: start.baseRepository,
		headRef: start.headRef,
		headRepository: start.headRepository,
		prState: initial.metadata.state,
		draft: initial.metadata.state === "draft",
		mergeable: initial.metadata.mergeable ?? null,
		mergeableState: initial.metadata.mergeableState ?? null,
		authorLogin: initial.metadata.authorLogin ?? null,
		autoMergePresent: initial.metadata.autoMergePresent ?? null,
	});
	let metadataCoherent = false;
	if (final.kind === "ok") {
		const m = final.metadata;
		if (m.headSha === start.headSha && m.baseSha === start.baseSha) {
			metadataCoherent = true;
			// The final read is the freshest identity truth for the window.
			envelope.mergeable = m.mergeable ?? null;
			envelope.mergeableState = m.mergeableState ?? null;
		} else {
			addReason(envelope.reasons, "head_changed");
		}
	} else {
		// A failed or 304 re-read cannot re-verify identity: never complete.
		if (final.kind === "failed") {
			failures.push(final.failure);
		}
		addReason(envelope.reasons, final.kind === "failed" ? final.failure.category : "metadata_unreadable");
	}
	envelope.sources.prMetadata = metadataCoherent;

	if (reviews.kind === "ok") {
		envelope.sources.reviews = true;
		envelope.reviews = normalizeMergeReviews(reviews.items, scope.login);
	} else if (reviews.kind === "failed") {
		failures.push(reviews.failure);
		addReason(envelope.reasons, "reviews_incomplete");
		addReason(envelope.reasons, reviews.failure.category);
	}
	if (checkRuns.kind === "ok") {
		envelope.sources.checkRuns = true;
		envelope.checks = selectEffectiveCheckRuns(checkRuns.items, headSha);
	} else if (checkRuns.kind === "failed") {
		failures.push(checkRuns.failure);
		addReason(envelope.reasons, "check_runs_incomplete");
		addReason(envelope.reasons, checkRuns.failure.category);
	}
	if (statuses.kind === "ok") {
		envelope.sources.commitStatuses = true;
		envelope.statuses = selectEffectiveCommitStatuses(statuses.statuses, headSha);
	} else if (statuses.kind === "failed") {
		failures.push(statuses.failure);
		addReason(envelope.reasons, "commit_statuses_incomplete");
		addReason(envelope.reasons, statuses.failure.category);
	}
	if (threads.kind === "ok_threads") {
		envelope.sources.reviewThreads = true;
		envelope.unresolvedActiveThreads = countUnresolvedActiveThreads(threads.threads);
	} else if (threads.kind === "failed") {
		failures.push(threads.failure);
		addReason(envelope.reasons, "review_threads_unknown");
		addReason(envelope.reasons, threads.failure.category);
	}
	// Mergeability that GitHub has not computed is an explicit unknown, never
	// an assumed green.
	if (envelope.mergeable === null) {
		addReason(envelope.reasons, "mergeability_unknown");
	}
	envelope.complete = envelope.reasons.length === 0;
	return { envelope, failures };
}
