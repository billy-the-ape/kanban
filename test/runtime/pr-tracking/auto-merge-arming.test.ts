import { describe, expect, it } from "vitest";
import type { AutoMergePolicy, RuntimeBoardCard, RuntimeBoardData } from "../../../src/core/api-contract";
import {
	addTaskPullRequests,
	removeTaskPullRequest,
	updateTaskPrSettings,
} from "../../../src/core/task-board-mutations";
import { prepareAutoMergeArming } from "../../../src/pr-tracking/auto-merge-arming";
import { computeTaskSubscriptionDemand } from "../../../src/pr-tracking/pr-task-subscriptions";

const policy: AutoMergePolicy = {
	repository: "owner/repo",
	requiredChecks: ["ci"],
	mergeMethod: "merge",
	revision: 2,
	updatedAt: 1,
};
const card: RuntimeBoardCard = {
	id: "t1",
	title: "Test",
	prompt: "Test",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
	pullRequests: [
		{
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
			number: 1,
			url: "https://github.com/owner/repo/pull/1",
			source: "agent_tool",
			createdAt: 1,
			lastSeenAt: 1,
		},
	],
};
function board(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardData {
	return { columns: [{ id: "review", title: "Review", cards: [{ ...card, ...overrides }] }], dependencies: [] };
}

it("arms the default-on preference with a sole linked PR and creates auto-merge demand", async () => {
	const original = board();
	const arm = await prepareAutoMergeArming(original, async () => policy);
	const ready = arm?.(original) ?? original;
	expect(ready.columns[0].cards[0]).toMatchObject({ autoMergeWhenApproved: true, armedAutoMergePolicyRevision: 2 });
	expect(
		computeTaskSubscriptionDemand([{ workspaceId: "w1", board: ready }], {
			comments: true,
			mergeCompletion: true,
			autoMerge: true,
		}),
	).toMatchObject([{ consumers: { autoMerge: true } }]);
	expect(await prepareAutoMergeArming(ready, async () => policy)).toBeNull();
});

it("saves off before setup, and never auto-arms an explicit opt-out", async () => {
	const original = board({ pullRequests: [] });
	const disabled = updateTaskPrSettings(original, "t1", { autoMergeWhenApproved: false });
	expect(disabled).toMatchObject({ updated: true, autoMergeWhenApproved: false });
	expect(await prepareAutoMergeArming(board({ autoMergeWhenApproved: false }), async () => policy)).toBeNull();
});

it("waits for policy setup and arms an enabled preference once it becomes available", async () => {
	const original = board({ autoMergeWhenApproved: true });
	expect(await prepareAutoMergeArming(original, async () => null)).toBeNull();
	const arm = await prepareAutoMergeArming(original, async () => policy);
	expect(arm?.(original).columns[0].cards[0].armedAutoMergePolicyRevision).toBe(2);
});

it("does not auto-accept a changed policy", async () => {
	expect(
		await prepareAutoMergeArming(
			board({ autoMergeWhenApproved: true, armedAutoMergePolicyRevision: 1 }),
			async () => policy,
		),
	).toBeNull();
});

it("waits for an unambiguous PR and an active card", async () => {
	const first = card.pullRequests?.[0];
	if (!first) throw new Error("Missing fixture PR");
	const ambiguous = board({
		pullRequests: [
			...(card.pullRequests ?? []),
			{ ...first, number: 2, url: "https://github.com/owner/repo/pull/2" },
		],
	});
	expect(await prepareAutoMergeArming(ambiguous, async () => policy)).toBeNull();
	const inactive = board();
	inactive.columns[0].id = "backlog";
	expect(await prepareAutoMergeArming(inactive, async () => policy)).toBeNull();
});

describe("concurrent board changes", () => {
	it.each(["disabled", "selection", "revision", "column"])("revalidates %s before arming", async (change) => {
		const original = board();
		const arm = await prepareAutoMergeArming(original, async () => policy);
		const current = board(
			change === "disabled"
				? { autoMergeWhenApproved: false }
				: change === "revision"
					? { settingsRevision: 1 }
					: change === "selection"
						? { pullRequests: [] }
						: {},
		);
		if (change === "column") current.columns[0].id = "backlog";
		expect(arm?.(current)).toBe(current);
	});
});

it("disarms if a sole linked PR is removed or becomes ambiguous", async () => {
	const original = board();
	const arm = await prepareAutoMergeArming(original, async () => policy);
	const ready = arm?.(original) ?? original;
	const removed = removeTaskPullRequest(ready, "t1", "github|github.com|owner/repo|1");
	expect(removed.task).toMatchObject({ autoMergeWhenApproved: false });
	expect(removed.task?.armedAutoMergePolicyRevision).toBeUndefined();
	const first = card.pullRequests?.[0];
	if (!first) throw new Error("Missing fixture PR");
	const ambiguous = addTaskPullRequests(ready, "t1", [
		{ ...first, number: 2, url: "https://github.com/owner/repo/pull/2" },
	]);
	expect(ambiguous.task).toMatchObject({ autoMergeWhenApproved: false });
	expect(ambiguous.task?.armedAutoMergePolicyRevision).toBeUndefined();
});
