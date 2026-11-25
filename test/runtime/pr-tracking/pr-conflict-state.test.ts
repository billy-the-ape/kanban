// PCR-1: the conflict-state resolution rule — provider snapshot precedence,
// `mergeable: null` never being green or red, the dirty hint being
// corroborating only, and the advisory local probe never claiming a clean
// merge Kanban cannot confirm.
import { describe, expect, it } from "vitest";
import type { GitHubPrMetadataSnapshot, GitHubPrTrackingRecord } from "../../../src/core/api-contract";
import { latestSnapshotFromRecord, resolvePrConflictState } from "../../../src/pr-tracking/pr-conflict-state";

const PR_KEY = "github|github.com|octo/repo|1";

function createSnapshot(overrides: Partial<GitHubPrMetadataSnapshot> = {}): GitHubPrMetadataSnapshot {
	return {
		accessScopeId: "scope-1",
		checkedAt: 1_000,
		state: "open",
		headRepository: "octo/repo",
		headRef: "feature",
		baseRepository: "octo/repo",
		baseRef: "main",
		headSha: "abc1234def5678",
		mergedAt: null,
		mergeCommitSha: null,
		additions: null,
		deletions: null,
		changedFiles: null,
		commits: null,
		comments: null,
		reviewComments: null,
		mergeableState: null,
		requestedReviewers: null,
		baseSha: "base1234",
		mergeable: null,
		authorLogin: null,
		autoMergePresent: null,
		...overrides,
	};
}

function createRecord(snapshots: Record<string, GitHubPrMetadataSnapshot>): GitHubPrTrackingRecord {
	return {
		snapshots,
	} as unknown as GitHubPrTrackingRecord;
}

describe("resolvePrConflictState", () => {
	it("maps provider mergeable false to a conflicting block with the identity fields", () => {
		const conflict = resolvePrConflictState({
			prKey: PR_KEY,
			snapshot: createSnapshot({ mergeable: false, mergeableState: "dirty" }),
			providerSupported: true,
		});
		expect(conflict).toMatchObject({
			state: "conflicting",
			source: "provider_snapshot",
			prKey: PR_KEY,
			headRef: "feature",
			baseRef: "main",
			headSha: "abc1234def5678",
			baseSha: "base1234",
			checkedAt: 1_000,
		});
		expect(conflict.note).toContain("does not merge cleanly");
	});

	it("maps provider mergeable true to clean", () => {
		const conflict = resolvePrConflictState({
			prKey: PR_KEY,
			snapshot: createSnapshot({ mergeable: true, mergeableState: "clean" }),
			providerSupported: true,
		});
		expect(conflict.state).toBe("clean");
		expect(conflict.source).toBe("provider_snapshot");
		expect(conflict.note).toBeNull();
	});

	it("treats null mergeability as unknown, never green and never a conflict", () => {
		const conflict = resolvePrConflictState({
			prKey: PR_KEY,
			snapshot: createSnapshot({ mergeable: null, mergeableState: "unknown" }),
			providerSupported: true,
		});
		expect(conflict.state).toBe("unknown");
		expect(conflict.source).toBe("provider_snapshot");
		expect(conflict.note).toContain("still computing mergeability");
	});

	it("reports a dirty merge-state hint as corroborating only — never as the conflict state", () => {
		const conflict = resolvePrConflictState({
			prKey: PR_KEY,
			snapshot: createSnapshot({ mergeable: null, mergeableState: "dirty" }),
			providerSupported: true,
		});
		expect(conflict.state).toBe("unknown");
		expect(conflict.note).toContain("dirty");
	});

	it("ignores the local probe while a provider snapshot exists (provider is authoritative)", () => {
		const conflict = resolvePrConflictState({
			prKey: PR_KEY,
			snapshot: createSnapshot({ mergeable: true }),
			providerSupported: true,
			probe: { outcome: "conflicting" },
		});
		expect(conflict.state).toBe("clean");
		expect(conflict.source).toBe("provider_snapshot");
	});

	it("surfaces an advisory local conflict with source local_probe when no snapshot exists", () => {
		const conflict = resolvePrConflictState({
			prKey: PR_KEY,
			snapshot: null,
			providerSupported: true,
			probe: { outcome: "conflicting", headSha: "abc1234", baseSha: "base1234", baseRef: "main", checkedAt: 2_000 },
		});
		expect(conflict.state).toBe("conflicting");
		expect(conflict.source).toBe("local_probe");
		expect(conflict.headSha).toBe("abc1234");
		expect(conflict.note).toContain("local merge probe");
	});

	it("never renders a local clean as a provider-confirmed clean merge", () => {
		const conflict = resolvePrConflictState({
			prKey: PR_KEY,
			snapshot: null,
			providerSupported: false,
			probe: { outcome: "clean", checkedAt: 2_000 },
		});
		expect(conflict.state).toBe("unknown");
		expect(conflict.source).toBe("local_probe");
		expect(conflict.note).toContain("has not confirmed mergeability");
	});

	it("reports unsupported with a note for a non-github host without a probe result", () => {
		const conflict = resolvePrConflictState({
			prKey: "github|ghe.example.com|octo/repo|1",
			snapshot: null,
			providerSupported: false,
		});
		expect(conflict.state).toBe("unsupported");
		expect(conflict.source).toBe("none");
		expect(conflict.note).toContain("Mergeability cannot be read");
	});

	it("falls back to unknown with a guidance note for a github host without any snapshot", () => {
		const conflict = resolvePrConflictState({ prKey: PR_KEY, snapshot: null, providerSupported: true });
		expect(conflict.state).toBe("unknown");
		expect(conflict.source).toBe("none");
		expect(conflict.note).toContain("No provider snapshot");
	});

	it("surfaces a failed probe error as the note", () => {
		const conflict = resolvePrConflictState({
			prKey: PR_KEY,
			snapshot: null,
			providerSupported: false,
			probe: { outcome: "failed", error: "No configured Git remote carries the base branch." },
		});
		expect(conflict.state).toBe("unsupported");
		expect(conflict.note).toContain("No configured Git remote");
	});
});

describe("latestSnapshotFromRecord", () => {
	it("picks the newest snapshot across access scopes", () => {
		const older = createSnapshot({ accessScopeId: "a", checkedAt: 500 });
		const newer = createSnapshot({ accessScopeId: "b", checkedAt: 900 });
		const latest = latestSnapshotFromRecord(createRecord({ a: older, b: newer }));
		expect(latest?.accessScopeId).toBe("b");
	});

	it("returns null for a missing record", () => {
		expect(latestSnapshotFromRecord(null)).toBeNull();
	});
});
