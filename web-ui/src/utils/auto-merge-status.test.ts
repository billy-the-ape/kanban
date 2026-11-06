// AM-5: unit tests for the operator-facing auto-merge status derivation.
// The mapping is pure and server-facts-driven: journal state wins over the
// eligibility summary, and stale evidence never reads as merging/merged.
import { describe, expect, it } from "vitest";
import type { AutoMergeAttempt, AutoMergeEligibilitySummary, RuntimeTaskTrackingStateResponse } from "@/runtime/types";
import { AUTO_MERGE_EVIDENCE_BUDGET_MS, deriveAutoMergeStatus, shortSha } from "./auto-merge-status";

const NOW = 1_700_000_000_000;
const HEAD_SHA = "1111111111111111111111111111111111111111";

function makeTracking(overrides: Partial<RuntimeTaskTrackingStateResponse> = {}): RuntimeTaskTrackingStateResponse {
	return {
		ok: true,
		taskId: "task-1",
		settingsRevision: 1,
		staleRevision: false,
		autoAddressComments: false,
		autoFinishOnMerge: true,
		autoMergeWhenApproved: false,
		armedAutoMergePolicyRevision: null,
		selectedAutomationPrKey: null,
		explicitAutomationPrKey: null,
		eligible: false,
		legacyCompletionGated: false,
		mergeFinishesInReview: false,
		blockers: [],
		commentsSupportedForTask: false,
		owner: null,
		ownerLabel: null,
		ownerCandidates: [],
		reservation: { state: "none", reservedBy: null, reservedOperation: null, fencingGeneration: 0 },
		snapshot: null,
		terminalStop: null,
		autoMergeEligibility: null,
		autoMergeAttempt: null,
		error: null,
		...overrides,
	};
}

function makeSummary(kind: AutoMergeEligibilitySummary["kind"], codes: string[]): AutoMergeEligibilitySummary {
	return {
		schemaVersion: 1,
		kind,
		codes,
		evaluatedAt: NOW,
		headSha: HEAD_SHA,
		baseSha: "2222222222222222222222222222222222222222",
		policyRevision: 1,
		evidenceCheckedAt: NOW,
	};
}

function makeAttempt(state: AutoMergeAttempt["state"], overrides: Partial<AutoMergeAttempt> = {}): AutoMergeAttempt {
	return {
		schemaVersion: 1,
		attemptId: "a".repeat(64),
		canonicalPrKey: "github|github.com|cline/kanban|49",
		headSha: HEAD_SHA,
		baseSha: "2222222222222222222222222222222222222222",
		policyRevision: 1,
		mergeMethod: "squash",
		startedAt: NOW - 1000,
		state,
		reason: null,
		mergeCommitSha: null,
		finishedAt: null,
		...overrides,
	};
}

describe("deriveAutoMergeStatus", () => {
	it("returns null while the task has not opted in", () => {
		expect(deriveAutoMergeStatus(makeTracking(), NOW)).toBeNull();
	});

	it("reports a neutral wait before the first evaluation", () => {
		const status = deriveAutoMergeStatus(makeTracking({ autoMergeWhenApproved: true }), NOW);
		expect(status?.label).toBe("waiting");
		expect(status?.tone).toBe("neutral");
	});

	it("reports merging for a fresh eligible summary", () => {
		const status = deriveAutoMergeStatus(
			makeTracking({ autoMergeWhenApproved: true, autoMergeEligibility: makeSummary("eligible", []) }),
			NOW,
		);
		expect(status?.label).toBe("merging");
		expect(status?.headSha).toBe(HEAD_SHA);
	});

	it("never shows a stale eligible summary as merging", () => {
		const staleSummary: AutoMergeEligibilitySummary = {
			...makeSummary("eligible", []),
			evidenceCheckedAt: NOW - AUTO_MERGE_EVIDENCE_BUDGET_MS - 1,
		};
		const status = deriveAutoMergeStatus(
			makeTracking({ autoMergeWhenApproved: true, autoMergeEligibility: staleSummary }),
			NOW,
		);
		expect(status?.label).toBe("waiting");
	});

	it("categorizes waiting summaries into approval / CI / repair", () => {
		expect(
			deriveAutoMergeStatus(
				makeTracking({
					autoMergeWhenApproved: true,
					autoMergeEligibility: makeSummary("waiting", ["no_approval"]),
				}),
				NOW,
			)?.label,
		).toBe("waiting: approval");
		expect(
			deriveAutoMergeStatus(
				makeTracking({
					autoMergeWhenApproved: true,
					autoMergeEligibility: makeSummary("waiting", ["check_pending"]),
				}),
				NOW,
			)?.label,
		).toBe("waiting: CI");
		expect(
			deriveAutoMergeStatus(
				makeTracking({
					autoMergeWhenApproved: true,
					autoMergeEligibility: makeSummary("waiting", ["writer_active"]),
				}),
				NOW,
			)?.label,
		).toBe("waiting: writer/comment repair");
	});

	it("reports blocked summaries with their codes", () => {
		const status = deriveAutoMergeStatus(
			makeTracking({ autoMergeWhenApproved: true, autoMergeEligibility: makeSummary("blocked", ["no_policy"]) }),
			NOW,
		);
		expect(status?.label).toBe("blocked");
		expect(status?.detail).toContain("no auto-merge policy");
	});

	it("prefers the merged attempt journal over the summary", () => {
		const status = deriveAutoMergeStatus(
			makeTracking({
				autoMergeWhenApproved: true,
				autoMergeEligibility: makeSummary("eligible", []),
				autoMergeAttempt: makeAttempt("merged_confirmed", {
					mergeCommitSha: "3333333333333333333333333333333333333333",
					finishedAt: NOW,
				}),
			}),
			NOW,
		);
		expect(status?.label).toBe("merged");
		expect(status?.tone).toBe("success");
		expect(status?.detail).toContain("3333333");
	});

	it("reports an in-flight fenced merge from an identity-matched attempting journal", () => {
		const status = deriveAutoMergeStatus(
			makeTracking({
				autoMergeWhenApproved: true,
				autoMergeEligibility: makeSummary("eligible", []),
				autoMergeAttempt: makeAttempt("attempting"),
			}),
			NOW,
		);
		expect(status?.label).toBe("merging");
	});

	it("reports needs attention with the humanized journal reason for the same evidence identity", () => {
		const status = deriveAutoMergeStatus(
			makeTracking({
				autoMergeWhenApproved: true,
				autoMergeEligibility: makeSummary("blocked", ["github_denied"]),
				autoMergeAttempt: makeAttempt("needs_attention", { reason: "merge write failed: gh api error" }),
			}),
			NOW,
		);
		expect(status?.label).toBe("needs attention");
		expect(status?.detail).toBe("merge write failed: gh api error");
	});

	it("ignores a journal entry from an older head in favor of the current summary", () => {
		const staleAttempt = makeAttempt("needs_attention", {
			headSha: "9999999999999999999999999999999999999999",
			reason: "github_denied:http_403",
		});
		const status = deriveAutoMergeStatus(
			makeTracking({
				autoMergeWhenApproved: true,
				autoMergeEligibility: makeSummary("waiting", ["check_pending"]),
				autoMergeAttempt: staleAttempt,
			}),
			NOW,
		);
		expect(status?.label).toBe("waiting: CI");
		expect(status?.headSha).toBe(HEAD_SHA);
	});

	it("ignores a journal entry from an older policy revision in favor of the current summary", () => {
		const staleAttempt = makeAttempt("waiting", { policyRevision: 2, reason: "head_changed" });
		const status = deriveAutoMergeStatus(
			makeTracking({
				autoMergeWhenApproved: true,
				autoMergeEligibility: makeSummary("blocked", ["policy_mismatch"]),
				autoMergeAttempt: staleAttempt,
			}),
			NOW,
		);
		expect(status?.label).toBe("blocked");
		expect(status?.detail).toContain("policy changed after arming");
	});

	it("never shows a stale attempting journal as merging", () => {
		const staleAttempt = makeAttempt("attempting", {
			headSha: "9999999999999999999999999999999999999999",
		});
		const status = deriveAutoMergeStatus(
			makeTracking({
				autoMergeWhenApproved: true,
				autoMergeEligibility: makeSummary("waiting", ["check_pending"]),
				autoMergeAttempt: staleAttempt,
			}),
			NOW,
		);
		expect(status?.label).toBe("waiting: CI");
	});

	it("maps a known journal reason code to operator text when the identity matches", () => {
		const status = deriveAutoMergeStatus(
			makeTracking({
				autoMergeWhenApproved: true,
				autoMergeEligibility: makeSummary("waiting", ["check_pending"]),
				autoMergeAttempt: makeAttempt("waiting", { reason: "head_changed" }),
			}),
			NOW,
		);
		expect(status?.label).toBe("waiting");
		expect(status?.detail).toBe("The head moved during evidence collection; a fresh read is pending.");
	});
});

describe("shortSha", () => {
	it("abbreviates a SHA and is null-safe", () => {
		expect(shortSha(HEAD_SHA)).toBe("1111111");
		expect(shortSha(null)).toBeNull();
		expect(shortSha("")).toBeNull();
	});
});
