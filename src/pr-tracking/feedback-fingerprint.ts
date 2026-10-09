// COMMENT-0: structured dedupe descriptors for eligible PR feedback.
//
// A fingerprint is not a bare string: it is the SHA-256 digest of the sorted
// event-version tokens, the latest `updatedAt` watermark, and the sorted
// version tokens at exactly that watermark timestamp. Tokens are
// kind + provider ID + updatedAt + body digest. Pending feedback is derived
// against the last dispatched fingerprint: a token newer than the watermark
// is pending; a token at the same watermark timestamp is pending unless it is
// one of the dispatched boundary tokens (so a new event at the same timestamp
// still triggers, while surviving old tokens or deletions alone do not).
import { createHash } from "node:crypto";

import type { RuntimePrFeedbackFingerprint } from "../core/api-contract";

export type PrFeedbackKind = "review" | "inline" | "conversation";

/**
 * One eligible piece of PR feedback, normalized for scheduling. `body` is
 * transient input only — never persisted to the durable workflow store.
 */
export interface PrFeedbackEvent {
	kind: PrFeedbackKind;
	/** Provider identifier of the feedback item (GitHub database id). */
	providerId: string;
	/** Latest update timestamp in epoch ms; GitHub edits advance versions. */
	updatedAt: number;
	/** SHA-256 (hex) of the raw feedback body. */
	bodyDigest: string;
	/** Transient raw body; not stored durably. */
	body: string;
}

const TOKEN_SEPARATOR = "\u001f";

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Token ordering is frozen: kind, provider id, updatedAt (numeric), body digest. */
export function sortPrFeedbackEvents(events: readonly PrFeedbackEvent[]): PrFeedbackEvent[] {
	return [...events].sort((a, b) => {
		if (a.kind !== b.kind) {
			return a.kind < b.kind ? -1 : 1;
		}
		if (a.providerId !== b.providerId) {
			return a.providerId < b.providerId ? -1 : 1;
		}
		if (a.updatedAt !== b.updatedAt) {
			return a.updatedAt - b.updatedAt;
		}
		if (a.bodyDigest !== b.bodyDigest) {
			return a.bodyDigest < b.bodyDigest ? -1 : 1;
		}
		return 0;
	});
}

export function buildPrFeedbackEventToken(event: PrFeedbackEvent): string {
	return [event.kind, event.providerId, String(event.updatedAt), event.bodyDigest].join(TOKEN_SEPARATOR);
}

/** Sorted event-version tokens for an aggregate. */
export function buildPrFeedbackTokens(events: readonly PrFeedbackEvent[]): string[] {
	return sortPrFeedbackEvents(events).map(buildPrFeedbackEventToken);
}

/**
 * Computes the structured fingerprint for an aggregate of eligible events.
 * Returns null for an empty aggregate.
 */
export function computePrFeedbackFingerprint(events: readonly PrFeedbackEvent[]): RuntimePrFeedbackFingerprint | null {
	if (events.length === 0) {
		return null;
	}
	const tokens = buildPrFeedbackTokens(events);
	const watermark = Math.max(...events.map((event) => event.updatedAt));
	const watermarkTokens = tokens.filter((token) => token.split(TOKEN_SEPARATOR)[2] === String(watermark));
	return {
		digest: sha256Hex(tokens.join("\n")),
		watermark,
		watermarkTokens,
	};
}

/**
 * Events pending against a last dispatched fingerprint: newer-than-watermark
 * versions, plus same-watermark tokens that were not part of the dispatched
 * boundary. With no dispatched fingerprint every event is pending (first
 * enable: currently published eligible feedback can form a batch).
 */
export function findPrFeedbackPendingEvents(
	events: readonly PrFeedbackEvent[],
	dispatched: RuntimePrFeedbackFingerprint | null,
): PrFeedbackEvent[] {
	if (dispatched === null) {
		return [...events];
	}
	const boundary = new Set(dispatched.watermarkTokens);
	return sortPrFeedbackEvents(events).filter((event) => {
		if (event.updatedAt > dispatched.watermark) {
			return true;
		}
		if (event.updatedAt === dispatched.watermark) {
			return !boundary.has(buildPrFeedbackEventToken(event));
		}
		return false;
	});
}

/** True when two fingerprints describe the exact same aggregate. */
export function isSamePrFeedbackFingerprint(
	left: RuntimePrFeedbackFingerprint | null,
	right: RuntimePrFeedbackFingerprint | null,
): boolean {
	if (left === null || right === null) {
		return left === right;
	}
	if (left.digest !== right.digest || left.watermark !== right.watermark) {
		return false;
	}
	if (left.watermarkTokens.length !== right.watermarkTokens.length) {
		return false;
	}
	return left.watermarkTokens.every((token, index) => token === right.watermarkTokens[index]);
}
