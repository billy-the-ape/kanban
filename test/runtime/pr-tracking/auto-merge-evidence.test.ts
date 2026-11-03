import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoMergeEvidenceEnvelopeSchema } from "../../../src/core/api-contract";
import {
	collectAutoMergeEvidence,
	countUnresolvedActiveThreads,
	normalizeMergeReviews,
	selectEffectiveCheckRuns,
	selectEffectiveCommitStatuses,
} from "../../../src/pr-tracking/auto-merge-evidence";
import {
	type AccessScope,
	type CommitStatusesReadResult,
	createGitHubGhAdapter,
	type FeedbackReadResult,
	type GhAdapterFailure,
	type GhRunnerCommandResult,
	type GitHubGhAdapter,
	type MetadataReadResult,
	type RawRestListResult,
} from "../../../src/pr-tracking/github-gh-adapter";
import { InMemoryPrRecordStore } from "../../../src/pr-tracking/in-memory-pr-record-store";
import type { ParsedCanonicalPrKey } from "../../../src/pr-tracking/pr-identity";
import type { PrRecordStorePort } from "../../../src/pr-tracking/pr-record-store";
import type { PrThreadInfo } from "../../../src/pr-tracking/pr-snapshots";
import { normalizePrMetadata } from "../../../src/pr-tracking/pr-snapshots";
import { createPrTrackingCoordinator } from "../../../src/pr-tracking/pr-tracking-coordinator";

const NOW = 1_700_000_000_000;
const SCOPE: AccessScope = { accessScopeId: "scope-1", login: "me", tokenSource: "GH_TOKEN" };
const PARSED: ParsedCanonicalPrKey = {
	provider: "github",
	host: "github.com",
	repository: "cline/kanban",
	number: 49,
};
const HEAD = "abc123";
const BASE = "base-1";
const PR_ENDPOINT = "repos/cline/kanban/pulls/49";
const REVIEWS_ENDPOINT = "repos/cline/kanban/pulls/49/reviews";
const CHECK_RUNS_ENDPOINT = `repos/cline/kanban/commits/${HEAD}/check-runs`;
const STATUSES_ENDPOINT = `repos/cline/kanban/commits/${HEAD}/status`;

// --- Scripted gh runner dispatched by endpoint (deterministic under parallel reads) ---

interface ScriptedCall {
	kind: "rest" | "graphql";
	endpoint: string | null;
	page: number | null;
}

type RestHandler = (page: number, callIndex: number) => { stdout: string } | { stderr: string };
type RestHandlers = Record<string, RestHandler>;

function makeScriptedRunner(
	handlers: RestHandlers,
	graphqlStdout?: string | ((graphqlCallIndex: number) => string),
	graphqlFailure?: (graphqlCallIndex: number) => boolean,
) {
	const calls: ScriptedCall[] = [];
	const perEndpoint = new Map<string, number>();
	const runner = async (args: string[], _cwd: string): Promise<GhRunnerCommandResult> => {
		const endpointRaw = args[3] ?? "";
		if (endpointRaw === "graphql") {
			calls.push({ kind: "graphql", endpoint: null, page: null });
			const graphqlCallIndex = calls.filter((call) => call.kind === "graphql").length;
			if (graphqlFailure?.(graphqlCallIndex)) {
				return { ok: false, stdout: "", stderr: "HTTP 304: Not Modified", exitCode: 1, missingBinary: false };
			}
			return {
				ok: true,
				stdout:
					(typeof graphqlStdout === "function" ? graphqlStdout(graphqlCallIndex) : graphqlStdout) ??
					JSON.stringify({
						data: { node: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
					}),
				stderr: "",
				exitCode: 0,
				missingBinary: false,
			};
		}
		const [path, query] = endpointRaw.split("?");
		const callIndex = perEndpoint.get(path) ?? 0;
		perEndpoint.set(path, callIndex + 1);
		const page = Number(new URLSearchParams(query ?? "").get("page") ?? "1");
		calls.push({ kind: "rest", endpoint: path, page });
		const handler = handlers[path];
		if (!handler) {
			return { ok: false, stdout: "", stderr: "HTTP 404: Not Found", exitCode: 1, missingBinary: false };
		}
		const result = handler(page, callIndex);
		if ("stderr" in result) {
			return { ok: false, stdout: "", stderr: result.stderr, exitCode: 1, missingBinary: false };
		}
		return { ok: true, stdout: result.stdout, stderr: "", exitCode: 0, missingBinary: false };
	};
	return { runner, calls };
}

function adapterFor(
	handlers: RestHandlers,
	graphqlStdout?: string | ((graphqlCallIndex: number) => string),
	graphqlFailure?: (graphqlCallIndex: number) => boolean,
) {
	const scripted = makeScriptedRunner(handlers, graphqlStdout, graphqlFailure);
	return {
		adapter: createGitHubGhAdapter({ ghRunner: scripted.runner, now: () => NOW, cwd: "/tmp/fake-repo" }),
		calls: scripted.calls,
	};
}

async function collect(
	handlers: RestHandlers,
	options: {
		declaredHeadSha?: string;
		graphqlStdout?: string | ((graphqlCallIndex: number) => string);
		graphqlFailure?: (graphqlCallIndex: number) => boolean;
	} = {},
) {
	const { adapter, calls } = adapterFor(handlers, options.graphqlStdout, options.graphqlFailure);
	const result = await collectAutoMergeEvidence(adapter, PARSED, SCOPE, {
		policyRevision: 7,
		declaredHeadSha: options.declaredHeadSha ?? null,
		now: () => NOW,
	});
	return { envelope: result.envelope, calls };
}

function prMetadataBody(overrides: Record<string, unknown> = {}, headSha: string = HEAD): string {
	return JSON.stringify({
		node_id: "PR_49",
		state: "open",
		draft: false,
		mergeable: true,
		mergeable_state: "clean",
		user: { login: "author-1", type: "User" },
		head: { sha: headSha, ref: "feature-branch" },
		base: { sha: BASE, ref: "main", repo: { full_name: "cline/kanban" } },
		auto_merge: { enabled_at: "2026-01-01T00:00:00Z" },
		...overrides,
	});
}

function reviewItem(
	id: number,
	state: string,
	login: string,
	commitId: string | null,
	submittedAt: string | null,
	type: "User" | "Bot" = "User",
) {
	return { id, node_id: `RV_${id}`, state, user: { login, type }, commit_id: commitId, submitted_at: submittedAt };
}

function checkRunItem(
	id: number,
	name: string,
	headSha: string,
	status: string,
	conclusion: string | null,
	startedAt: string,
	completedAt: string | null,
	appId: number,
) {
	return {
		id,
		head_sha: headSha,
		name,
		status,
		conclusion,
		started_at: startedAt,
		completed_at: completedAt,
		app: { id: appId },
	};
}

function statusItem(id: number, context: string, state: string, updatedAt: string, creator: string) {
	return {
		id,
		context,
		state,
		description: "",
		created_at: updatedAt,
		updated_at: updatedAt,
		creator: { login: creator },
	};
}

function threadsStdout(threads: Array<{ id: string; resolved: boolean; outdated: boolean }>): string {
	return JSON.stringify({
		data: {
			node: {
				reviewThreads: {
					pageInfo: { hasNextPage: false, endCursor: null },
					nodes: threads.map((thread) => ({
						id: thread.id,
						isResolved: thread.resolved,
						isOutdated: thread.outdated,
						comments: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [{ id: `${thread.id}_c1`, databaseId: 1000 }],
						},
					})),
				},
			},
		},
	});
}

function endpointCalls(calls: ScriptedCall[], endpoint: string): number {
	return calls.filter((call) => call.kind === "rest" && call.endpoint === endpoint).length;
}

describe("auto-merge-evidence normalization", () => {
	it("keeps raw review state, actor, head commit and submission time (no body inference)", () => {
		const reviews = normalizeMergeReviews(
			[
				reviewItem(1, "APPROVED", "approver", HEAD, "2026-01-02T00:00:00Z"),
				reviewItem(2, "PENDING", "waiter", HEAD, null),
				reviewItem(3, "DISMISSED", "old-approver", "old-sha", "2026-01-01T00:00:00Z"),
				reviewItem(4, "COMMENTED", "text-only", HEAD, "2026-01-03T00:00:00Z"),
				reviewItem(5, "APPROVED", "me", HEAD, "2026-01-04T00:00:00Z"),
				reviewItem(6, "CHANGES_REQUESTED", "bot", HEAD, "2026-01-05T00:00:00Z", "Bot"),
			],
			"me",
		);
		expect(reviews).toHaveLength(6);
		const [approved, pending, dismissed, commented, own, bot] = reviews;
		expect(approved?.state).toBe("APPROVED");
		expect(approved?.commitId).toBe(HEAD);
		expect(approved?.submittedAt).toBe(Date.parse("2026-01-02T00:00:00Z"));
		// PENDING is never normalized into an approval.
		expect(pending?.state).toBe("PENDING");
		expect(pending?.submittedAt).toBeNull();
		// DISMISSED stays DISMISSED with its original head commit.
		expect(dismissed?.state).toBe("DISMISSED");
		expect(dismissed?.commitId).toBe("old-sha");
		// A prose-only comment is never reclassified as an approval.
		expect(commented?.state).toBe("COMMENTED");
		expect(own?.isOwnAccount).toBe(true);
		expect(approved?.isOwnAccount).toBe(false);
		expect(bot?.authorKind).toBe("bot");
		expect(bot?.state).toBe("CHANGES_REQUESTED");
	});

	it("picks the latest check-run attempt per name; an older success never masks a newer attempt", () => {
		const runs = [
			// Older success for "ci".
			checkRunItem(1, "ci", HEAD, "completed", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z", 10),
			// Newer failure for "ci" — must win over the older success.
			checkRunItem(2, "ci", HEAD, "completed", "failure", "2026-01-02T00:00:00Z", "2026-01-02T00:05:00Z", 11),
			// Newer PENDING attempt for "lint" (no completion yet) — must mask nothing older,
			// and beat an older completed success for the same name.
			checkRunItem(3, "lint", HEAD, "completed", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z", 12),
			checkRunItem(4, "lint", HEAD, "in_progress", null, "2026-01-03T00:00:00Z", null, 13),
			// A run for a DIFFERENT head sha is never evidence for this head.
			checkRunItem(
				5,
				"other-head",
				"old-sha",
				"completed",
				"success",
				"2026-01-01T00:00:00Z",
				"2026-01-01T00:02:00Z",
				14,
			),
		];
		// Add a stale-head "ci" success that must be dropped.
		runs.push(
			checkRunItem(6, "ci", "old-sha", "completed", "success", "2026-01-02T00:00:00Z", "2026-01-02T00:09:00Z", 15),
		);
		const effective = selectEffectiveCheckRuns(runs, HEAD);
		const byName = new Map(effective.map((check) => [check.name, check]));
		expect(byName.get("ci")?.conclusion).toBe("failure");
		expect(byName.get("lint")?.conclusion).toBeNull();
		expect(byName.get("lint")?.status).toBe("in_progress");
		// The stale-head run's name never appears (its only attempt was for "old-sha").
		expect(effective.map((check) => check.name).sort()).toEqual(["ci", "lint"]);
	});

	it("breaks attempt ties by the higher provider run id", () => {
		const runs = [
			{
				id: 20,
				head_sha: HEAD,
				name: "tie",
				status: "completed",
				conclusion: "success",
				started_at: "2026-01-01T00:00:00Z",
				completed_at: "2026-01-01T00:05:00Z",
				app: { id: 1 },
			},
			{
				id: 21,
				head_sha: HEAD,
				name: "tie",
				status: "completed",
				conclusion: "failure",
				started_at: "2026-01-01T00:00:00Z",
				completed_at: "2026-01-01T00:05:00Z",
				app: { id: 2 },
			},
		];
		const effective = selectEffectiveCheckRuns(runs, HEAD);
		expect(effective).toHaveLength(1);
		expect(effective[0]?.runId).toBe("21");
		expect(effective[0]?.conclusion).toBe("failure");
	});

	it("picks the latest commit status per context and maps states to phases", () => {
		const statuses = [
			statusItem(1, "coverage", "success", "2026-01-01T00:00:00Z", "svc-a"),
			statusItem(2, "coverage", "failure", "2026-01-02T00:00:00Z", "svc-a"),
			statusItem(3, "docs", "pending", "2026-01-03T00:00:00Z", "svc-b"),
		];
		const effective = selectEffectiveCommitStatuses(statuses, HEAD);
		const byName = new Map(effective.map((check) => [check.name, check]));
		expect(byName.get("coverage")?.conclusion).toBe("failure");
		expect(byName.get("coverage")?.status).toBe("completed");
		expect(byName.get("docs")?.conclusion).toBe("pending");
		expect(byName.get("docs")?.status).toBe("in_progress");
		expect(byName.get("docs")?.sourceId).toBe("svc-b");
	});

	it("counts only unresolved, non-outdated threads (deduped per thread)", () => {
		const resolved = { resolved: true, outdated: false };
		const active = { resolved: false, outdated: false };
		const outdated = { resolved: false, outdated: true };
		const threads = new Map<string, PrThreadInfo>();
		// Two comment keys map to the same active thread object.
		threads.set("node-a", active);
		threads.set("1000", active);
		threads.set("node-r", resolved);
		threads.set("node-o", outdated);
		expect(countUnresolvedActiveThreads(threads)).toBe(1);
	});
});

describe("auto-merge-evidence reader", () => {
	it("collects complete exact-head evidence across multi-page reads", async () => {
		const reviewsPage1Items = Array.from({ length: 100 }, (_, i) =>
			reviewItem(1000 + i, "COMMENTED", `reviewer-${i}`, HEAD, "2026-01-01T00:00:00Z"),
		);
		const reviewsPage2Items = [
			reviewItem(1100, "APPROVED", "approver", HEAD, "2026-01-02T00:00:00Z"),
			reviewItem(1101, "APPROVED", "approver-2", "old-sha", "2026-01-01T00:00:00Z"),
			reviewItem(1102, "CHANGES_REQUESTED", "critic", "old-sha", "2026-01-01T00:00:00Z"),
		];
		const reviews: Record<string, RestHandler> = {
			[PR_ENDPOINT]: () => ({ stdout: prMetadataBody({ mergeable_state: "clean" }) }),
			[REVIEWS_ENDPOINT]: (page) =>
				page === 1 ? { stdout: JSON.stringify(reviewsPage1Items) } : { stdout: JSON.stringify(reviewsPage2Items) },
			[CHECK_RUNS_ENDPOINT]: () => ({
				stdout: JSON.stringify({
					total_count: 3,
					check_runs: [
						checkRunItem(
							1,
							"ci",
							HEAD,
							"completed",
							"success",
							"2026-01-01T00:00:00Z",
							"2026-01-01T00:05:00Z",
							10,
						),
						checkRunItem(
							2,
							"ci",
							HEAD,
							"completed",
							"failure",
							"2026-01-02T00:00:00Z",
							"2026-01-02T00:05:00Z",
							11,
						),
						// Stale head: never evidence for this head.
						checkRunItem(
							3,
							"ci",
							"old-sha",
							"completed",
							"success",
							"2026-01-01T00:00:00Z",
							"2026-01-01T00:06:00Z",
							12,
						),
					],
				}),
			}),
			[STATUSES_ENDPOINT]: () => ({
				stdout: JSON.stringify({
					state: "failure",
					total_count: 2,
					statuses: [
						statusItem(1, "coverage", "success", "2026-01-01T00:00:00Z", "svc-a"),
						statusItem(2, "docs", "failure", "2026-01-02T00:00:00Z", "svc-b"),
					],
				}),
			}),
		};
		const { envelope, calls } = await collect(reviews, {
			graphqlStdout: threadsStdout([
				{ id: "t-resolved", resolved: true, outdated: false },
				{ id: "t-active", resolved: false, outdated: false },
				{ id: "t-outdated", resolved: false, outdated: true },
			]),
		});
		expect(autoMergeEvidenceEnvelopeSchema.safeParse(envelope).success).toBe(true);
		expect(envelope.complete).toBe(true);
		expect(envelope.reasons).toEqual([]);
		expect(envelope.sources).toEqual({
			prMetadata: true,
			reviews: true,
			checkRuns: true,
			commitStatuses: true,
			reviewThreads: true,
		});
		expect(envelope.policyRevision).toBe(7);
		expect(envelope.accessScopeId).toBe("scope-1");
		expect(envelope.checkedAt).toBe(NOW);
		expect(envelope.headSha).toBe(HEAD);
		expect(envelope.baseSha).toBe(BASE);
		expect(envelope.baseRef).toBe("main");
		expect(envelope.baseRepository).toBe("cline/kanban");
		expect(envelope.headRef).toBe("feature-branch");
		expect(envelope.prState).toBe("open");
		expect(envelope.draft).toBe(false);
		expect(envelope.mergeable).toBe(true);
		expect(envelope.authorLogin).toBe("author-1");
		expect(envelope.autoMergePresent).toBe(true);
		expect(envelope.unresolvedActiveThreads).toBe(1);
		// 103 reviews in provider order, authoritative facts preserved.
		expect(envelope.reviews).toHaveLength(103);
		const currentApprovals = envelope.reviews.filter(
			(review) => review.state === "APPROVED" && review.commitId === HEAD,
		);
		expect(currentApprovals.map((review) => review.authorLogin)).toEqual(["approver"]);
		// Effective latest attempt per name; the stale-head run is excluded.
		const byName = new Map(envelope.checks.map((check) => [check.name, check]));
		expect(envelope.checks).toHaveLength(1);
		expect(byName.get("ci")?.conclusion).toBe("failure");
		expect(byName.get("ci")?.sourceId).toBe("11");
		// Commit statuses per context.
		expect(envelope.statuses).toHaveLength(2);
		// Bounded reads: two metadata reads (start + coherent re-read), two review
		// pages, one check-run page, one status page, one threads query.
		expect(endpointCalls(calls, PR_ENDPOINT)).toBe(2);
		expect(endpointCalls(calls, REVIEWS_ENDPOINT)).toBe(2);
		expect(endpointCalls(calls, CHECK_RUNS_ENDPOINT)).toBe(1);
		expect(endpointCalls(calls, STATUSES_ENDPOINT)).toBe(1);
		expect(calls.filter((call) => call.kind === "graphql")).toHaveLength(1);
	});

	it("reports incomplete (never truncated) when a later reviews page fails", async () => {
		const reviewsPage1 = Array.from({ length: 100 }, (_, i) =>
			reviewItem(1000 + i, "COMMENTED", `r-${i}`, HEAD, null),
		);
		const { envelope, calls } = await collect({
			[PR_ENDPOINT]: () => ({ stdout: prMetadataBody() }),
			[REVIEWS_ENDPOINT]: (page) =>
				page === 1 ? { stdout: JSON.stringify(reviewsPage1) } : { stderr: "HTTP 502: Bad Gateway" },
			[CHECK_RUNS_ENDPOINT]: () => ({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) }),
			[STATUSES_ENDPOINT]: () => ({ stdout: JSON.stringify({ state: "success", total_count: 0, statuses: [] }) }),
		});
		expect(envelope.complete).toBe(false);
		expect(envelope.sources.reviews).toBe(false);
		expect(envelope.reasons).toContain("reviews_incomplete");
		// A mid-list failure is an explicit partial page, never a truncation.
		expect(envelope.reasons).toContain("partial_page");
		// The other sources still read to completion.
		expect(envelope.sources.checkRuns).toBe(true);
		expect(envelope.sources.commitStatuses).toBe(true);
		expect(envelope.sources.reviewThreads).toBe(true);
		expect(endpointCalls(calls, REVIEWS_ENDPOINT)).toBe(2);
	});

	it("fails closed when the check-runs body is not the wrapped list shape", async () => {
		// GitHub returns { total_count, check_runs: [...] }; a bare array (or
		// any other body) must fail closed, never read as an empty list.
		const { envelope } = await collect({
			[PR_ENDPOINT]: () => ({ stdout: prMetadataBody() }),
			[REVIEWS_ENDPOINT]: () => ({ stdout: "[]" }),
			[CHECK_RUNS_ENDPOINT]: () => ({
				stdout: JSON.stringify([
					checkRunItem(1, "ci", HEAD, "completed", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z", 10),
				]),
			}),
			[STATUSES_ENDPOINT]: () => ({ stdout: JSON.stringify({ state: "success", total_count: 0, statuses: [] }) }),
		});
		expect(envelope.complete).toBe(false);
		expect(envelope.sources.checkRuns).toBe(false);
		expect(envelope.checks).toEqual([]);
		expect(envelope.reasons).toContain("check_runs_incomplete");
		expect(envelope.reasons).toContain("partial_page");
	});

	it("reports a short page below total_count as partial, never complete", async () => {
		const { envelope } = await collect({
			[PR_ENDPOINT]: () => ({ stdout: prMetadataBody() }),
			[REVIEWS_ENDPOINT]: () => ({ stdout: "[]" }),
			[CHECK_RUNS_ENDPOINT]: () => ({
				stdout: JSON.stringify({
					total_count: 5,
					check_runs: [
						checkRunItem(
							1,
							"ci",
							HEAD,
							"completed",
							"failure",
							"2026-01-01T00:00:00Z",
							"2026-01-01T00:05:00Z",
							10,
						),
						checkRunItem(2, "lint", HEAD, "in_progress", null, "2026-01-02T00:00:00Z", null, 11),
					],
				}),
			}),
			[STATUSES_ENDPOINT]: () => ({ stdout: JSON.stringify({ state: "success", total_count: 0, statuses: [] }) }),
		});
		expect(envelope.complete).toBe(false);
		expect(envelope.sources.checkRuns).toBe(false);
		expect(envelope.reasons).toContain("check_runs_incomplete");
		expect(envelope.reasons).toContain("partial_page");
	});

	it("fails closed when a bare-array list endpoint returns an object body", async () => {
		const { envelope } = await collect({
			[PR_ENDPOINT]: () => ({ stdout: prMetadataBody() }),
			[REVIEWS_ENDPOINT]: () => ({ stdout: JSON.stringify({ not: "a list" }) }),
			[CHECK_RUNS_ENDPOINT]: () => ({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) }),
			[STATUSES_ENDPOINT]: () => ({ stdout: JSON.stringify({ state: "success", total_count: 0, statuses: [] }) }),
		});
		expect(envelope.complete).toBe(false);
		expect(envelope.sources.reviews).toBe(false);
		expect(envelope.reasons).toContain("reviews_incomplete");
		expect(envelope.reasons).toContain("partial_page");
	});

	it("discards evidence when the head or base changes during collection", async () => {
		const { envelope } = await collect({
			[PR_ENDPOINT]: (_page, callIndex) => ({ stdout: prMetadataBody({}, callIndex === 0 ? HEAD : "def456") }),
			[REVIEWS_ENDPOINT]: () => ({ stdout: JSON.stringify([reviewItem(1, "APPROVED", "approver", HEAD, null)]) }),
			[CHECK_RUNS_ENDPOINT]: () => ({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) }),
			[STATUSES_ENDPOINT]: () => ({ stdout: JSON.stringify({ state: "success", total_count: 0, statuses: [] }) }),
		});
		expect(envelope.complete).toBe(false);
		expect(envelope.sources.prMetadata).toBe(false);
		expect(envelope.reasons).toContain("head_changed");
	});

	it("discards immediately when the declared head differs from the live head", async () => {
		const { envelope, calls } = await collect(
			{
				[PR_ENDPOINT]: () => ({ stdout: prMetadataBody() }),
				[REVIEWS_ENDPOINT]: () => ({ stdout: "[]" }),
				[CHECK_RUNS_ENDPOINT]: () => ({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) }),
				[STATUSES_ENDPOINT]: () => ({ stdout: JSON.stringify({ state: "success", total_count: 0, statuses: [] }) }),
			},
			{ declaredHeadSha: "stale-sha" },
		);

		expect(envelope.complete).toBe(false);
		expect(envelope.reasons).toEqual(["declared_head_mismatch"]);
		expect(envelope.headSha).toBe(HEAD);
		// Bounded: only the initial metadata read, no source reads.
		expect(endpointCalls(calls, PR_ENDPOINT)).toBe(1);
		expect(endpointCalls(calls, REVIEWS_ENDPOINT)).toBe(0);
	});

	it("surfaces unauthorized reads as explicit unknown without further reads", async () => {
		const { envelope, calls } = await collect({
			[PR_ENDPOINT]: () => ({ stderr: "HTTP 403: permission denied" }),
		});
		expect(envelope.complete).toBe(false);
		expect(envelope.headSha).toBeNull();
		expect(envelope.prState).toBe("unknown");
		expect(envelope.sources.prMetadata).toBe(false);
		expect(envelope.reasons).toContain("access");
		expect(endpointCalls(calls, REVIEWS_ENDPOINT)).toBe(0);
	});

	it("reports unknown mergeability explicitly (never assumed green)", async () => {
		const body = JSON.parse(prMetadataBody());
		delete body.mergeable;
		const { envelope } = await collect({
			[PR_ENDPOINT]: () => ({ stdout: JSON.stringify(body) }),
			[REVIEWS_ENDPOINT]: () => ({ stdout: "[]" }),
			[CHECK_RUNS_ENDPOINT]: () => ({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) }),
			[STATUSES_ENDPOINT]: () => ({ stdout: JSON.stringify({ state: "success", total_count: 0, statuses: [] }) }),
		});
		expect(envelope.complete).toBe(false);
		expect(envelope.reasons).toContain("mergeability_unknown");
		expect(envelope.mergeable).toBeNull();
		expect(envelope.sources).toEqual({
			prMetadata: true,
			reviews: true,
			checkRuns: true,
			commitStatuses: true,
			reviewThreads: true,
		});
	});

	it("distinguishes complete-empty evidence from missing evidence", async () => {
		const { envelope } = await collect({
			[PR_ENDPOINT]: () => ({ stdout: prMetadataBody() }),
			[REVIEWS_ENDPOINT]: () => ({ stdout: "[]" }),
			[CHECK_RUNS_ENDPOINT]: () => ({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) }),
			[STATUSES_ENDPOINT]: () => ({ stdout: JSON.stringify({ state: "success", total_count: 0, statuses: [] }) }),
		});
		expect(envelope.complete).toBe(true);
		expect(envelope.reasons).toEqual([]);
		expect(envelope.reviews).toEqual([]);
		expect(envelope.checks).toEqual([]);
		expect(envelope.statuses).toEqual([]);
		expect(envelope.unresolvedActiveThreads).toBe(0);
		expect(envelope.sources.reviewThreads).toBe(true);
	});
	it("treats a 304 thread read as unknown (never complete)", async () => {
		const { envelope } = await collect(
			{
				[PR_ENDPOINT]: () => ({ stdout: prMetadataBody() }),
				[REVIEWS_ENDPOINT]: () => ({ stdout: "[]" }),
				[CHECK_RUNS_ENDPOINT]: () => ({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) }),
				[STATUSES_ENDPOINT]: () => ({ stdout: JSON.stringify({ state: "success", total_count: 0, statuses: [] }) }),
			},
			{ graphqlFailure: () => true },
		);
		expect(envelope.complete).toBe(false);
		expect(envelope.reasons).toContain("review_threads_unknown");
		expect(envelope.sources.reviewThreads).toBe(false);
		expect(envelope.unresolvedActiveThreads).toBeNull();
	});

	it("leaves the poller's conditional-read cache untouched (poll, change, evidence, poll)", async () => {
		// Poll 1 reads establish the adapter's conditional digests; then the
		// provider changes (merged at a new head, new thread data); then an
		// evidence read; then the poll must still see the changed bodies and
		// never a shadowed `not_modified` from a digest the evidence read
		// recorded.
		const { adapter } = adapterFor(
			{
				[PR_ENDPOINT]: (_page, callIndex) => ({
					stdout: callIndex === 0 ? prMetadataBody() : prMetadataBody({ state: "closed", merged: true }, "def456"),
				}),
				[REVIEWS_ENDPOINT]: () => ({ stdout: "[]" }),
				[CHECK_RUNS_ENDPOINT]: () => ({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) }),
				[STATUSES_ENDPOINT]: () => ({ stdout: JSON.stringify({ state: "success", total_count: 0, statuses: [] }) }),
			},
			(graphqlCallIndex) =>
				threadsStdout(
					graphqlCallIndex === 1
						? [{ id: "t-old", resolved: false, outdated: false }]
						: [{ id: "t-new", resolved: false, outdated: false }],
				),
		);

		const poll1 = await adapter.readPrMetadata(PARSED, SCOPE);
		expect(poll1.kind).toBe("ok");
		const threads1 = await adapter.readReviewThreads(PARSED, SCOPE, "PR_49");
		expect(threads1.kind).toBe("ok_threads");

		// The evidence read observes the merged PR without recording digests.
		const { envelope } = await collectAutoMergeEvidence(adapter, PARSED, SCOPE, {
			policyRevision: 7,
			declaredHeadSha: null,
			now: () => NOW,
		});
		expect(envelope.prState).toBe("merged");
		expect(envelope.headSha).toBe("def456");

		// The next poll's non-fresh reads must see the change.
		const poll2 = await adapter.readPrMetadata(PARSED, SCOPE);
		expect(poll2.kind).toBe("ok");
		if (poll2.kind === "ok") {
			expect(poll2.metadata.state).toBe("merged");
			expect(poll2.metadata.headSha).toBe("def456");
		}
		const threads2 = await adapter.readReviewThreads(PARSED, SCOPE, "PR_49");
		expect(threads2.kind).toBe("ok_threads");
	});
});

// --- AM-2: coordinator wiring (consumer-requested evidence reads) ---

const PR49 = "github|github.com|cline/kanban|49";

/** Per-test temp dir for the harness scheduler-lock request (set in beforeEach). */
let evidenceRoot: string;

interface EvidenceHarnessConfig {
	scope?: AccessScope;
	metadata?: () => MetadataReadResult;
	rest?: (endpoint: string, callIndex: number) => { items?: unknown[]; failure?: GhAdapterFailure };
	statuses?: () => {
		statuses?: unknown[];
		aggregateState?: string | null;
		totalCount?: number | null;
		failure?: GhAdapterFailure;
	};
	threads?: () => { threads?: PrThreadInfo[]; failure?: GhAdapterFailure };
}

function defaultMetadata(scopeId: string): MetadataReadResult {
	return {
		kind: "ok",
		metadata: normalizePrMetadata(
			{
				state: "open",
				merged: false,
				node_id: "PR_49",
				user: { login: "author-1", type: "User" },
				head: { sha: HEAD, ref: "feature-branch" },
				base: { sha: BASE, ref: "main" },
				mergeable: true,
			},
			scopeId,
			1,
		),
		nodeId: "PR_49",
		bodyDigest: "digest-open-49",
	};
}

function makeEvidenceHarness(config: EvidenceHarnessConfig = {}) {
	const scope = config.scope ?? { accessScopeId: "scope-A", login: "alice", tokenSource: "GH_TOKEN" };
	const counts = { scope: 0, metadata: 0, rest: [] as string[], statuses: 0, threads: 0 };
	const restIndexes = new Map<string, number>();
	const fake = {
		resolveAccessScope: async () => {
			counts.scope += 1;
			return { ok: true, scope } as const;
		},
		readPrMetadata: async (
			_parsed: unknown,
			_scope: AccessScope,
			_options?: { fresh?: boolean },
		): Promise<MetadataReadResult> => {
			counts.metadata += 1;
			return config.metadata?.() ?? defaultMetadata(scope.accessScopeId);
		},
		readRawRestList: async (endpoint: string): Promise<RawRestListResult> => {
			const callIndex = restIndexes.get(endpoint) ?? 0;
			restIndexes.set(endpoint, callIndex + 1);
			counts.rest.push(endpoint);
			const result = config.rest?.(endpoint, callIndex) ?? {};
			return result.failure
				? { kind: "failed", failure: result.failure }
				: { kind: "ok", items: result.items ?? [] };
		},
		readCommitStatuses: async (): Promise<CommitStatusesReadResult> => {
			counts.statuses += 1;
			const result = config.statuses?.() ?? { statuses: [], aggregateState: "success", totalCount: 0 };
			return result.failure
				? { kind: "failed", failure: result.failure }
				: {
						kind: "ok",
						aggregateState: result.aggregateState ?? null,
						totalCount: result.totalCount ?? null,
						statuses: result.statuses ?? [],
					};
		},
		readReviewThreads: async (): Promise<FeedbackReadResult> => {
			counts.threads += 1;
			const result = config.threads?.() ?? { threads: [] };
			if (result.failure) {
				return { kind: "failed", failure: result.failure };
			}
			const threads = new Map<string, PrThreadInfo>();
			(result.threads ?? []).forEach((info, index) => {
				threads.set(`t-${index}`, info);
			});
			return { kind: "ok_threads", threads };
		},
	};
	const store: PrRecordStorePort = new InMemoryPrRecordStore({ now: () => Date.now() });
	const coordinator = createPrTrackingCoordinator({
		adapter: fake as unknown as GitHubGhAdapter,
		store,
		listManagedWorkspaceBoards: async () => [],
		now: () => Date.now(),
		random: () => 0,
		schedulerLockRequest: {
			path: join(evidenceRoot, "lock-evidence"),
			type: "directory" as const,
			lockfilePath: join(evidenceRoot, "lock-evidence", ".scheduler.lock"),
		},
	});
	return { coordinator, counts };
}

describe("pr-tracking-coordinator auto-merge evidence reads", () => {
	let root: string;
	const coordinators: ReturnType<typeof createPrTrackingCoordinator>[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "kanban-evidence-"));
		evidenceRoot = root;
	});

	afterEach(async () => {
		for (const coordinator of coordinators.splice(0)) {
			await coordinator.stop();
		}
		rmSync(root, { recursive: true, force: true });
	});

	function track(coordinator: ReturnType<typeof createPrTrackingCoordinator>) {
		coordinators.push(coordinator);
		return coordinator;
	}

	it("reads complete evidence on demand (no subscription, no writes)", async () => {
		const harness = makeEvidenceHarness();
		const coordinator = track(harness.coordinator);
		const envelope = await coordinator.readAutoMergeEvidence(PR49, undefined, { policyRevision: 3 });
		expect(envelope.complete).toBe(true);
		expect(envelope.reasons).toEqual([]);
		expect(envelope.policyRevision).toBe(3);
		expect(envelope.accessScopeId).toBe("scope-A");
		expect(envelope.headSha).toBe(HEAD);
		expect(envelope.sources).toEqual({
			prMetadata: true,
			reviews: true,
			checkRuns: true,
			commitStatuses: true,
			reviewThreads: true,
		});
		expect(harness.counts.scope).toBe(1);
		expect(harness.counts.metadata).toBe(2);
		expect(harness.counts.rest).toContain(REVIEWS_ENDPOINT);
		expect(harness.counts.rest).toContain(CHECK_RUNS_ENDPOINT);
		expect(harness.counts.statuses).toBe(1);
	});

	it("coalesces concurrent requests for the same (PR, scope) into one collection", async () => {
		const harness = makeEvidenceHarness();
		const coordinator = track(harness.coordinator);
		const [first, second] = await Promise.all([
			coordinator.readAutoMergeEvidence(PR49, undefined, { policyRevision: 1 }),
			coordinator.readAutoMergeEvidence(PR49, undefined, { policyRevision: 1 }),
		]);
		expect(first).toBe(second);
		expect(first.complete).toBe(true);
		expect(harness.counts.metadata).toBe(2);
		expect(harness.counts.rest.filter((endpoint) => endpoint === REVIEWS_ENDPOINT)).toHaveLength(1);
	});

	it("reports rate limits and short-circuits subsequent reads (never retries)", async () => {
		// The reset is well beyond the 15-minute fallback: the deadline must
		// use the REAL provider reset time, not the guess.
		const resetAt = Date.now() + 3_600_000;
		const harness = makeEvidenceHarness({
			rest: (endpoint) =>
				endpoint === CHECK_RUNS_ENDPOINT
					? {
							failure: {
								category: "rate_limit",
								message: "API rate limit exceeded",
								at: 1,
								rateLimitResetAt: resetAt,
							},
						}
					: { items: [] },
		});
		const coordinator = track(harness.coordinator);
		const envelope = await coordinator.readAutoMergeEvidence(PR49, undefined, { policyRevision: 1 });
		expect(envelope.complete).toBe(false);
		expect(envelope.reasons).toContain("check_runs_incomplete");
		expect(envelope.reasons).toContain("rate_limit");
		const deadline = harness.coordinator.getState().polls[0]?.rateLimitDeadline ?? 0;
		expect(deadline).toBe(resetAt);
		const second = await coordinator.readAutoMergeEvidence(PR49, undefined, { policyRevision: 1 });
		expect(second.complete).toBe(false);
		expect(second.reasons).toEqual(["rate_limited"]);
		// No further GitHub reads after the deadline is active.
		expect(harness.counts.metadata).toBe(2);
		expect(harness.counts.rest.filter((endpoint) => endpoint === CHECK_RUNS_ENDPOINT)).toHaveLength(1);
	});

	it("surfaces auth failures through the shared blocker state", async () => {
		const harness = makeEvidenceHarness({
			rest: () => ({ failure: { category: "auth", message: "you must be logged in", at: 1 } }),
		});
		const coordinator = track(harness.coordinator);
		const envelope = await coordinator.readAutoMergeEvidence(PR49, undefined, { policyRevision: 1 });
		expect(envelope.complete).toBe(false);
		expect(envelope.reasons).toContain("auth");
		expect(harness.coordinator.getState().authBlocker).not.toBeNull();
	});

	it("enforces the requested access scope", async () => {
		const harness = makeEvidenceHarness();
		const envelope = await harness.coordinator.readAutoMergeEvidence(PR49, "other-scope", { policyRevision: 1 });
		expect(envelope.complete).toBe(false);
		expect(envelope.reasons).toEqual(["scope"]);
		expect(harness.counts.metadata).toBe(0);
	});

	it("rejects malformed keys and unsupported hosts before any reads", async () => {
		const harness = makeEvidenceHarness();
		const coordinator = track(harness.coordinator);
		const malformed = await coordinator.readAutoMergeEvidence("not-a-key", undefined, { policyRevision: 1 });
		expect(malformed.complete).toBe(false);
		expect(malformed.reasons).toEqual(["malformed_key"]);
		const unsupported = await coordinator.readAutoMergeEvidence("bitbucket|bitbucket.org|owner/repo|3", undefined, {
			policyRevision: 1,
		});
		expect(unsupported.complete).toBe(false);
		expect(unsupported.reasons).toEqual(["unsupported_host"]);
		expect(harness.counts.scope).toBe(0);
	});
});
