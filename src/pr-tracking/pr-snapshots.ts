// PRTRACK-0: normalized transient snapshots and freshness helpers.
//
// The foundation normalizes full feedback and carries classification
// metadata (author kind, own-account, review state, thread flags, updatedAt,
// body digest). The bot/eligibility policy is applied downstream (COMMENT-0),
// never here. Durable storage keeps only the access-scoped metadata snapshot
// and aggregate fingerprints — never bodies or per-comment state.
import { createHash } from "node:crypto";

import type {
	GitHubPrFeedbackCompleteness,
	GitHubPrMetadataSnapshot,
	GitHubPrNormalizedFeedbackEvent,
} from "../core/api-contract";

/** One poll interval: eligible PRs are observed every 60 seconds. */
export const PR_POLL_INTERVAL_MS = 60_000;
/** Bounded jitter added to each scheduled poll (named constant). */
export const PR_POLL_JITTER_MAX_MS = 5_000;
/**
 * Snapshots are stale once older than one poll interval plus the full jitter
 * window — the maximum a healthy scheduler can fall behind.
 */
export const PR_SNAPSHOT_STALE_AFTER_MS = PR_POLL_INTERVAL_MS + PR_POLL_JITTER_MAX_MS;
/** Terminal reconciliation permits at most three remote reads per episode. */
export const PR_TERMINAL_RECONCILIATION_MAX_READS = 3;
/** Backoff ladder for transient failures; capped at 900 seconds. */
export const PR_BACKOFF_STEPS_MS = [60_000, 120_000, 240_000, 480_000, 900_000] as const;

export function sha256Digest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** SHA-256 digest of a feedback body (bodies themselves stay transient). */
export function feedbackBodyDigest(body: string): string {
	return sha256Digest(body);
}

export function isPrSnapshotStale(checkedAt: number, now: number): boolean {
	return now - checkedAt > PR_SNAPSHOT_STALE_AFTER_MS;
}

/** Backoff base for the given number of consecutive failures (0 = normal). */
export function backoffBaseMs(consecutiveFailures: number): number {
	if (consecutiveFailures <= 0) {
		return PR_POLL_INTERVAL_MS;
	}
	const index = Math.min(consecutiveFailures, PR_BACKOFF_STEPS_MS.length) - 1;
	return PR_BACKOFF_STEPS_MS[index] ?? PR_BACKOFF_STEPS_MS[PR_BACKOFF_STEPS_MS.length - 1];
}

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

function authorInfo(value: unknown): { login: string; kind: "human" | "bot" } {
	const author = typeof value === "object" && value !== null ? (value as RawObject) : null;
	return {
		login: asString(author?.login) ?? "unknown",
		kind: author?.type === "Bot" ? "bot" : "human",
	};
}

/** Map a raw REST PR object to the durable, access-scoped metadata snapshot. */
export function normalizePrMetadata(raw: unknown, accessScopeId: string, checkedAt: number): GitHubPrMetadataSnapshot {
	const pr = typeof raw === "object" && raw !== null ? (raw as RawObject) : {};
	const head = typeof pr.head === "object" && pr.head !== null ? (pr.head as RawObject) : null;
	const base = typeof pr.base === "object" && pr.base !== null ? (pr.base as RawObject) : null;
	const headRepo = typeof head?.repo === "object" && head.repo !== null ? (head.repo as RawObject) : null;
	const baseRepo = typeof base?.repo === "object" && base.repo !== null ? (base.repo as RawObject) : null;
	const merged = pr.merged === true;
	const draft = pr.draft === true;
	// Closed wins over draft: GitHub keeps `draft: true` on closed draft PRs,
	// and a closed-unmerged PR must never read as pollable "draft".
	const state: GitHubPrMetadataSnapshot["state"] = merged
		? "merged"
		: pr.state === "closed"
			? "closed"
			: draft
				? "draft"
				: "open";
	return {
		accessScopeId,
		checkedAt,
		state,
		headRepository: asString(headRepo?.full_name),
		headRef: asString(head?.ref),
		baseRepository: asString(baseRepo?.full_name),
		baseRef: asString(base?.ref),
		headSha: asString(head?.sha),
		mergedAt: merged ? (asIsoMs(pr.merged_at) ?? checkedAt) : null,
		mergeCommitSha: merged ? (asString(pr.merge_commit_sha) ?? null) : null,
	};
}

/** Normalize published review events (pending/unpublished are kept, flagged). */
export function normalizeReviews(rawItems: unknown[], ownAccountLogin: string): GitHubPrNormalizedFeedbackEvent[] {
	const events: GitHubPrNormalizedFeedbackEvent[] = [];
	for (const item of rawItems) {
		const review = typeof item === "object" && item !== null ? (item as RawObject) : null;
		const id = asString(review?.id) ?? asString(review?.node_id);
		if (!id) {
			continue;
		}
		const author = authorInfo(review?.user);
		const updatedAt =
			asIsoMs(review?.updated_at) ?? asIsoMs(review?.submitted_at) ?? asIsoMs(review?.created_at) ?? 0;
		// REST review states are uppercase (PENDING, APPROVED, ...); compare
		// case-insensitively so unpublished reviews are flagged correctly.
		const pending = String(review?.state ?? "").toUpperCase() === "PENDING";
		events.push({
			kind: "review",
			providerId: id,
			authorLogin: author.login,
			authorKind: author.kind,
			isOwnAccount: author.login === ownAccountLogin,
			reviewState: pending ? "pending" : "submitted",
			threadResolved: null,
			threadDeleted: null,
			threadOutdated: null,
			updatedAt,
			bodyDigest: feedbackBodyDigest(asString(review?.body) ?? ""),
		});
	}
	return events;
}

/**
 * GraphQL-derived thread state keyed by inline comment id. The map is keyed
 * by BOTH the GraphQL node id (`comments.nodes.id`) and the numeric
 * `databaseId` (equal to the REST comment `id` as a string), because the
 * REST list and the GraphQL thread query expose different id spaces.
 * `outdated` (diff moved under the comment) is distinct from `deleted`.
 */
export interface PrThreadInfo {
	resolved: boolean;
	outdated: boolean;
	deleted: boolean;
}

/**
 * Normalize inline review comments, attaching thread flags. The thread map
 * may be keyed by GraphQL node id or by numeric database id; look the comment
 * up by `node_id` first, then by its REST numeric id. A comment present in
 * the REST list is by definition not deleted, so `threadDeleted` is only
 * populated from an explicit thread signal (null when unknown).
 */
export function normalizeInlineComments(
	rawItems: unknown[],
	ownAccountLogin: string,
	threadsById: Map<string, PrThreadInfo>,
): GitHubPrNormalizedFeedbackEvent[] {
	const events: GitHubPrNormalizedFeedbackEvent[] = [];
	for (const item of rawItems) {
		const comment = typeof item === "object" && item !== null ? (item as RawObject) : null;
		const id = asString(comment?.id) ?? asString(comment?.node_id);
		if (!id) {
			continue;
		}
		const author = authorInfo(comment?.user);
		const thread =
			threadsById.get(asString(comment?.node_id) ?? "") ??
			(typeof comment?.id === "number" ? threadsById.get(String(comment.id)) : undefined);
		events.push({
			kind: "inline_comment",
			providerId: id,
			authorLogin: author.login,
			authorKind: author.kind,
			isOwnAccount: author.login === ownAccountLogin,
			reviewState: null,
			threadResolved: thread ? thread.resolved : null,
			threadDeleted: thread ? thread.deleted : null,
			threadOutdated: thread ? thread.outdated : null,
			updatedAt: asIsoMs(comment?.updated_at) ?? asIsoMs(comment?.created_at) ?? 0,
			bodyDigest: feedbackBodyDigest(asString(comment?.body) ?? ""),
		});
	}
	return events;
}

/** Normalize PR conversation comments. */
export function normalizeConversationComments(
	rawItems: unknown[],
	ownAccountLogin: string,
): GitHubPrNormalizedFeedbackEvent[] {
	const events: GitHubPrNormalizedFeedbackEvent[] = [];
	for (const item of rawItems) {
		const comment = typeof item === "object" && item !== null ? (item as RawObject) : null;
		const id = asString(comment?.id) ?? asString(comment?.node_id);
		if (!id) {
			continue;
		}
		const author = authorInfo(comment?.user);
		events.push({
			kind: "conversation_comment",
			providerId: id,
			authorLogin: author.login,
			authorKind: author.kind,
			isOwnAccount: author.login === ownAccountLogin,
			reviewState: null,
			threadResolved: null,
			threadDeleted: null,
			threadOutdated: null,
			updatedAt: asIsoMs(comment?.updated_at) ?? asIsoMs(comment?.created_at) ?? 0,
			bodyDigest: feedbackBodyDigest(asString(comment?.body) ?? ""),
		});
	}
	return events;
}

export function createEmptyFeedbackCompleteness(): GitHubPrFeedbackCompleteness {
	return {
		reviews: false,
		conversationComments: false,
		inlineComments: false,
		threads: false,
	};
}
