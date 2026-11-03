import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeTaskPullRequest } from "../../../src/core/api-contract";
import { evaluatePrLifecycleGate } from "../../../src/pr-tracking/pr-lifecycle-gate";

const PR_LINK: RuntimeTaskPullRequest = {
	provider: "github",
	host: "github.com",
	repository: "cline/kanban",
	number: 49,
	url: "https://github.com/cline/kanban/pull/49",
	source: "agent_tool",
	createdAt: 1_700_000_000_000,
};

function makeCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: "task-1",
		title: "Task 1",
		prompt: "do the thing",
		startInPlanMode: false,
		autoReviewEnabled: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

function card(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return makeCard({ pullRequests: [PR_LINK], ...overrides });
}

describe("pr-lifecycle-gate", () => {
	it("gates legacy completion when a consumer owns the PR workflow", () => {
		expect(
			evaluatePrLifecycleGate({
				card: card({ autoFinishOnMerge: true }),
				installed: { comments: false, mergeCompletion: true, autoMerge: false },
			}),
		).toMatchObject({ legacyCompletionGated: true, mergeFinishesInReview: true });

		expect(
			evaluatePrLifecycleGate({
				card: card({ autoFinishOnMerge: true }),
				installed: { comments: false, mergeCompletion: false, autoMerge: false },
			}),
		).toMatchObject({ legacyCompletionGated: false, mergeFinishesInReview: false });

		expect(
			evaluatePrLifecycleGate({
				card: card({ autoAddressComments: true, autoFinishOnMerge: true }),
				installed: { comments: true, mergeCompletion: true, autoMerge: false },
			}),
		).toMatchObject({ legacyCompletionGated: true, mergeFinishesInReview: true });
	});

	it("gates legacy completion for an armed auto-merge opt-in without changing merge completion (AM-3)", () => {
		// Armed + installed autoMerge consumer: the linked PR workflow is
		// owned, so legacy completion is gated — but auto-merge is NOT the
		// automatic task-completion mechanism (that stays merge-completion).
		expect(
			evaluatePrLifecycleGate({
				card: card({ autoMergeWhenApproved: true, armedAutoMergePolicyRevision: 1 }),
				installed: { comments: false, mergeCompletion: false, autoMerge: true },
			}),
		).toMatchObject({ legacyCompletionGated: true, mergeFinishesInReview: false });

		// Opt-in without an armed revision: no gate yet (demand requires an
		// armed revision; the evaluator would fail closed with not_armed).
		expect(
			evaluatePrLifecycleGate({
				card: card({ autoMergeWhenApproved: true }),
				installed: { comments: false, mergeCompletion: false, autoMerge: true },
			}),
		).toMatchObject({ legacyCompletionGated: false, mergeFinishesInReview: false });

		// Armed but the consumer is not installed: no gate.
		expect(
			evaluatePrLifecycleGate({
				card: card({ autoMergeWhenApproved: true, armedAutoMergePolicyRevision: 1 }),
				installed: { comments: false, mergeCompletion: false, autoMerge: false },
			}),
		).toMatchObject({ legacyCompletionGated: false, mergeFinishesInReview: false });
	});

	it("never gates without a resolvable PR", () => {
		// No PR link at all.
		expect(
			evaluatePrLifecycleGate({
				card: makeCard({ autoFinishOnMerge: true }),
				installed: { comments: false, mergeCompletion: true, autoMerge: true },
			}),
		).toMatchObject({ legacyCompletionGated: false, mergeFinishesInReview: false });

		// An ambiguous multi-PR selection can never be resolved deterministically.
		expect(
			evaluatePrLifecycleGate({
				card: makeCard({
					autoFinishOnMerge: true,
					pullRequests: [PR_LINK, { ...PR_LINK, number: 50, url: "https://github.com/cline/kanban/pull/50" }],
				}),
				installed: { comments: false, mergeCompletion: true, autoMerge: true },
			}),
		).toMatchObject({ legacyCompletionGated: false, mergeFinishesInReview: false });
	});
});
