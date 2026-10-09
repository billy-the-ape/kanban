import { describe, expect, it } from "vitest";

import {
	backoffBaseMs,
	createEmptyFeedbackCompleteness,
	feedbackBodyDigest,
	isPrSnapshotStale,
	normalizeConversationComments,
	normalizeInlineComments,
	normalizePrMetadata,
	normalizeReviews,
	PR_POLL_INTERVAL_MS,
	PR_POLL_JITTER_MAX_MS,
	PR_SNAPSHOT_STALE_AFTER_MS,
	PR_TERMINAL_RECONCILIATION_MAX_READS,
} from "../../../src/pr-tracking/pr-snapshots";

const NOW = 1_700_000_000_000;
const SCOPE = "scope-1";

describe("pr-snapshots", () => {
	it("stales snapshots after one poll interval plus jitter", () => {
		expect(PR_SNAPSHOT_STALE_AFTER_MS).toBe(PR_POLL_INTERVAL_MS + PR_POLL_JITTER_MAX_MS);
		expect(isPrSnapshotStale(NOW, NOW + PR_SNAPSHOT_STALE_AFTER_MS)).toBe(false);
		expect(isPrSnapshotStale(NOW, NOW + PR_SNAPSHOT_STALE_AFTER_MS + 1)).toBe(true);
	});

	it("backoff ladder is 60/120/240/480/900 capped at 900s", () => {
		expect(backoffBaseMs(0)).toBe(60_000);
		expect(backoffBaseMs(1)).toBe(60_000);
		expect(backoffBaseMs(2)).toBe(120_000);
		expect(backoffBaseMs(3)).toBe(240_000);
		expect(backoffBaseMs(4)).toBe(480_000);
		expect(backoffBaseMs(5)).toBe(900_000);
		expect(backoffBaseMs(9)).toBe(900_000);
	});

	it("normalizes PR metadata with state mapping and repo refs", () => {
		const metadata = normalizePrMetadata(
			{
				state: "open",
				head: { sha: "abc123", ref: "feature", repo: { full_name: "cline/kanban" } },
				base: { ref: "main", repo: { full_name: "cline/kanban" } },
			},
			SCOPE,
			NOW,
		);
		expect(metadata.state).toBe("open");
		expect(metadata.headSha).toBe("abc123");
		expect(metadata.headRef).toBe("feature");
		expect(metadata.baseRef).toBe("main");
		expect(metadata.checkedAt).toBe(NOW);
		expect(metadata.accessScopeId).toBe(SCOPE);
		expect(metadata.mergedAt).toBeNull();
	});

	it("maps merged PRs to state=merged with merge facts", () => {
		const metadata = normalizePrMetadata(
			{
				state: "closed",
				merged: true,
				draft: false,
				head: { sha: "abc123" },
				merged_at: "2026-10-06T00:00:00Z",
				merge_commit_sha: "m1",
			},
			SCOPE,
			NOW,
		);
		expect(metadata.state).toBe("merged");
		expect(metadata.mergedAt).toBe(Date.parse("2026-10-06T00:00:00Z"));
		expect(metadata.mergeCommitSha).toBe("m1");
	});

	it("classifies reviews with author kind, own account, and pending state flags", () => {
		const events = normalizeReviews(
			[
				{
					id: "r1",
					state: "COMMENTED",
					user: { login: "human", type: "User" },
					body: "please fix lint",
					updated_at: "2026-10-06T00:00:00Z",
				},
				{
					id: "r2",
					state: "APPROVED",
					user: { login: "me", type: "User" },
					body: "",
					updated_at: "2026-10-06T00:00:00Z",
				},
				{ id: "r3", state: "PENDING", user: { login: "bot[bot]", type: "Bot" }, body: null },
			],
			"me",
		);
		expect(events.map((event) => event.providerId)).toEqual(["r1", "r2", "r3"]);
		const r1 = events.find((event) => event.providerId === "r1");
		expect(r1?.authorKind).toBe("human");
		expect(r1?.isOwnAccount).toBe(false);
		expect(r1?.reviewState).toBe("submitted");
		expect(r1?.bodyDigest).toBe(feedbackBodyDigest("please fix lint"));
		const r2 = events.find((event) => event.providerId === "r2");
		expect(r2?.isOwnAccount).toBe(true);
		expect(r2?.reviewState).toBe("submitted");
		const r3 = events.find((event) => event.providerId === "r3");
		expect(r3?.reviewState).toBe("pending");
		expect(r3?.authorKind).toBe("bot");
	});

	it("classifies inline comments and attaches thread resolved/outdated flags", () => {
		// REST list items carry numeric ids + node ids; the thread map from
		// GraphQL is keyed by node id, so lookup must join on the node id.
		const events = normalizeInlineComments(
			[
				{
					id: 900001,
					node_id: "PRC_900001",
					user: { login: "human", type: "User" },
					body: "nit: rename",
					updated_at: "2026-10-06T00:00:00Z",
				},
				{ id: 900002, node_id: "PRC_900002", user: { login: "me", type: "User" }, body: "" },
				{ id: 900003, node_id: "PRC_900003", user: { login: "human", type: "User" }, body: "moved" },
			],
			"me",
			new Map([
				["PRC_900001", { resolved: true, outdated: false }],
				["PRC_900002", { resolved: false, outdated: false }],
				["PRC_900003", { resolved: false, outdated: true }],
			]),
		);
		expect(events).toHaveLength(3);
		expect(events[0]?.threadResolved).toBe(true);
		// threadDeleted is always null: GitHub exposes no deleted-thread
		// signal (a deleted comment disappears from the REST list).
		expect(events[0]?.threadDeleted).toBeNull();
		expect(events[1]?.threadDeleted).toBeNull();
		expect(events[0]?.threadOutdated).toBe(false);
		expect(events[0]?.bodyDigest).toBe(feedbackBodyDigest("nit: rename"));
		expect(events[1]?.isOwnAccount).toBe(true);
		expect(events[2]?.threadOutdated).toBe(true);
	});

	it("classifies conversation comments, keeping bots with classification metadata", () => {
		const events = normalizeConversationComments(
			[
				{
					id: "c1",
					user: { login: "human", type: "User" },
					body: "looks good",
					created_at: "2026-10-06T00:00:00Z",
				},
				{
					id: "c2",
					user: { login: "status-bot[bot]", type: "Bot" },
					body: "label added",
					created_at: "2026-10-06T00:00:00Z",
				},
				{ id: "c3", user: { login: "me", type: "User" }, body: "fixed", created_at: "2026-10-06T00:00:00Z" },
			],
			"me",
		);
		expect(events.map((event) => event.providerId)).toEqual(["c1", "c2", "c3"]);
		expect(events.find((event) => event.providerId === "c2")?.authorKind).toBe("bot");
		expect(events.find((event) => event.providerId === "c3")?.isOwnAccount).toBe(true);
	});

	it("exposes empty completeness and the reconciliation cap", () => {
		expect(createEmptyFeedbackCompleteness()).toEqual({
			reviews: false,
			conversationComments: false,
			inlineComments: false,
			threads: false,
		});
		expect(PR_TERMINAL_RECONCILIATION_MAX_READS).toBe(3);
	});
});
