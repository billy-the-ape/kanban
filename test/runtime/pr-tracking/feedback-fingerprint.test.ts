import { describe, expect, it } from "vitest";

import type { PrFeedbackEvent } from "../../../src/pr-tracking/feedback-fingerprint";
import {
	buildPrFeedbackTokens,
	computePrFeedbackFingerprint,
	findPrFeedbackPendingEvents,
	isSamePrFeedbackFingerprint,
	sortPrFeedbackEvents,
} from "../../../src/pr-tracking/feedback-fingerprint";

function makeEvent(overrides: Partial<PrFeedbackEvent> & { providerId: string }): PrFeedbackEvent {
	return {
		kind: "conversation",
		updatedAt: 1_000,
		bodyDigest: "d",
		body: "b",
		...overrides,
		providerId: overrides.providerId,
	};
}

describe("pr feedback fingerprint", () => {
	it("returns null for an empty aggregate", () => {
		expect(computePrFeedbackFingerprint([])).toBeNull();
	});

	it("is stable across event ordering (frozen token sort)", () => {
		const a = makeEvent({ providerId: "conversation-1", updatedAt: 100, bodyDigest: "aa" });
		const b = makeEvent({ kind: "inline", providerId: "inline-9", updatedAt: 200, bodyDigest: "bb" });
		const c = makeEvent({ kind: "review", providerId: "review-5", updatedAt: 150, bodyDigest: "cc" });
		const first = computePrFeedbackFingerprint([a, b, c]);
		const second = computePrFeedbackFingerprint([c, a, b]);
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(first?.digest).toBe(second?.digest);
		expect(first?.watermark).toBe(200);
		expect(first?.watermarkTokens).toEqual(second?.watermarkTokens);
		expect(isSamePrFeedbackFingerprint(first, second)).toBe(true);
	});

	it("sorts by kind, provider id, updatedAt (numeric), then body digest", () => {
		const events = sortPrFeedbackEvents([
			makeEvent({ kind: "review", providerId: "review-1", updatedAt: 300, bodyDigest: "z" }),
			makeEvent({ kind: "inline", providerId: "inline-1", updatedAt: 100, bodyDigest: "a" }),
			makeEvent({ kind: "review", providerId: "review-1", updatedAt: 200, bodyDigest: "a" }),
			makeEvent({ kind: "review", providerId: "review-1", updatedAt: 200, bodyDigest: "b" }),
		]);
		expect(events.map((event) => `${event.kind}:${event.updatedAt}:${event.bodyDigest}`)).toEqual([
			"inline:100:a",
			"review:200:a",
			"review:200:b",
			"review:300:z",
		]);
		expect(buildPrFeedbackTokens(events)).toHaveLength(4);
	});

	it("counts every event as pending when nothing was dispatched (first enable)", () => {
		const events = [makeEvent({ providerId: "conversation-1" }), makeEvent({ providerId: "conversation-2" })];
		expect(findPrFeedbackPendingEvents(events, null).map((event) => event.providerId)).toEqual([
			"conversation-1",
			"conversation-2",
		]);
	});

	it("keeps newer-than-watermark versions pending", () => {
		const old = makeEvent({ providerId: "conversation-1", updatedAt: 100, bodyDigest: "aa" });
		const fp = computePrFeedbackFingerprint([old]);
		expect(fp).not.toBeNull();
		const edited = makeEvent({ providerId: "conversation-1", updatedAt: 200, bodyDigest: "bb" });
		const pending = findPrFeedbackPendingEvents([old, edited], fp);
		expect(pending.map((event) => `${event.providerId}:${event.updatedAt}`)).toEqual(["conversation-1:200"]);
	});

	it("does not retrigger on duplicate polls or surviving old tokens", () => {
		const a = makeEvent({ providerId: "conversation-1", updatedAt: 100, bodyDigest: "aa" });
		const b = makeEvent({ kind: "inline", providerId: "inline-2", updatedAt: 200, bodyDigest: "bb" });
		const fp = computePrFeedbackFingerprint([a, b]);
		expect(fp).not.toBeNull();
		// Identical snapshot: nothing pending.
		expect(findPrFeedbackPendingEvents([a, b], fp)).toEqual([]);
		// Deletion alone (the older token disappears) does not retrigger.
		expect(findPrFeedbackPendingEvents([b], fp)).toEqual([]);
	});

	it("triggers on a new token at the exact watermark timestamp", () => {
		const a = makeEvent({ providerId: "conversation-1", updatedAt: 200, bodyDigest: "aa" });
		const fp = computePrFeedbackFingerprint([a]);
		expect(fp).not.toBeNull();
		const fresh = makeEvent({ kind: "inline", providerId: "inline-7", updatedAt: 200, bodyDigest: "bb" });
		const pending = findPrFeedbackPendingEvents([a, fresh], fp);
		expect(pending.map((event) => event.providerId)).toEqual(["inline-7"]);
	});

	it("keeps dispatched watermark so old surviving comments stay dispatched after deletion", () => {
		const dispatched = makeEvent({ providerId: "conversation-1", updatedAt: 300, bodyDigest: "aa" });
		const younger = makeEvent({ providerId: "conversation-2", updatedAt: 100, bodyDigest: "bb" });
		const fp = computePrFeedbackFingerprint([dispatched, younger]);
		expect(fp).not.toBeNull();
		// The dispatched event is removed; the surviving old comment must not
		// look new (its updatedAt is below the watermark and not a boundary token).
		expect(findPrFeedbackPendingEvents([younger], fp)).toEqual([]);
	});

	it("isSamePrFeedbackFingerprint compares digest, watermark, and boundary tokens", () => {
		const base = makeEvent({ providerId: "conversation-1", updatedAt: 100, bodyDigest: "aa" });
		const fp = computePrFeedbackFingerprint([base]);
		expect(isSamePrFeedbackFingerprint(fp, fp)).toBe(true);
		expect(isSamePrFeedbackFingerprint(null, null)).toBe(true);
		expect(isSamePrFeedbackFingerprint(fp, null)).toBe(false);
		// A new event at the same timestamp changes the boundary tokens.
		const extra = makeEvent({ providerId: "conversation-2", updatedAt: 100, bodyDigest: "bb" });
		const other = computePrFeedbackFingerprint([base, extra]);
		expect(isSamePrFeedbackFingerprint(fp, other)).toBe(false);
	});
});
