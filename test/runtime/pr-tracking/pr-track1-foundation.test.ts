import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../../../src/core/api-contract";
import { InMemoryPrRecordStore } from "../../../src/pr-tracking/in-memory-pr-record-store";
import {
	PR_CONSUMER_READ_SOURCES,
	PrConsumerRegistry,
	toInstalledConsumerFlags,
} from "../../../src/pr-tracking/pr-consumer-registry";
import { evaluatePrLifecycleGate } from "../../../src/pr-tracking/pr-lifecycle-gate";
import {
	listRepairOwnerCandidates,
	type PrBoardSnapshot,
	resolveCardAutomationPrKey,
	selectRepairOwner,
	transferRepairOwner,
} from "../../../src/pr-tracking/pr-owner-selection";
import {
	computeTaskSubscriptionDemand,
	type PrSubscriptionController,
	type PrTaskSubscriptionSource,
	reconcileTaskSubscriptions,
} from "../../../src/pr-tracking/pr-task-subscriptions";

const PR_KEY = "github|github.com|cline/kanban|49";
const LINK = {
	provider: "github" as const,
	host: "github.com",
	repository: "cline/kanban",
	number: 49,
	url: "https://github.com/cline/kanban/pull/49",
	source: "agent_tool" as const,
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

function makeBoard(
	workspaceId: string,
	cards: Array<{ columnId: RuntimeBoardColumnId; card: RuntimeBoardCard }>,
): PrBoardSnapshot {
	const columns: Array<{ id: RuntimeBoardColumnId; title: string; cards: RuntimeBoardCard[] }> = [
		{ id: "backlog", title: "Backlog", cards: [] },
		{ id: "in_progress", title: "In Progress", cards: [] },
		{ id: "review", title: "In Review", cards: [] },
		{ id: "done", title: "Done", cards: [] },
		{ id: "trash", title: "Trash", cards: [] },
	];
	for (const { columnId, card } of cards) {
		const column = columns.find((c) => c.id === columnId);
		column?.cards.push(card);
	}
	return { workspaceId, board: { columns, dependencies: [] } };
}

describe("pr-track1 consumer registry demand rule", () => {
	it("registers kinds independently and derives read demand per kind", () => {
		const registry = new PrConsumerRegistry();
		expect(toInstalledConsumerFlags(registry)).toEqual({ comments: false, mergeCompletion: false });
		expect(registry.requiredReadSources().size).toBe(0);

		registry.registerConsumer("mergeCompletion");
		expect(registry.requiredReadSources()).toEqual(new Set(PR_CONSUMER_READ_SOURCES.mergeCompletion));
		expect(registry.requiredReadSources().has("reviews")).toBe(false);

		registry.registerConsumer("comments");
		for (const source of PR_CONSUMER_READ_SOURCES.comments) {
			expect(registry.requiredReadSources().has(source)).toBe(true);
		}

		// Unregistering one consumer removes exactly its demand.
		registry.unregisterConsumer("comments");
		expect(registry.requiredReadSources()).toEqual(new Set(PR_CONSUMER_READ_SOURCES.mergeCompletion));
		registry.unregisterConsumer("mergeCompletion");
		expect(registry.requiredReadSources().size).toBe(0);
	});

	it("re-registering a kind refreshes its required sources", () => {
		const registry = new PrConsumerRegistry();
		registry.registerConsumer("mergeCompletion", ["metadata"]);
		registry.registerConsumer("mergeCompletion");
		expect(registry.getInstalled("mergeCompletion")?.requiredReadSources).toEqual(["metadata"]);
	});
});

describe("pr-track1 lifecycle gate", () => {
	const installedBoth = { comments: true, mergeCompletion: true };
	const installedNone = { comments: false, mergeCompletion: false };

	it("gates legacy completion only when an installed enabled consumer owns the workflow", () => {
		const card = makeCard({ autoAddressComments: true, autoFinishOnMerge: true, pullRequests: [LINK] });
		expect(evaluatePrLifecycleGate({ card, installed: installedBoth })).toEqual({
			legacyCompletionGated: true,
			mergeFinishesInReview: true,
		});

		// Persisted true checkbox with no consumers installed: legacy behavior unchanged.
		expect(evaluatePrLifecycleGate({ card, installed: installedNone })).toEqual({
			legacyCompletionGated: false,
			mergeFinishesInReview: false,
		});

		// Enabled comment checkbox without the comment consumer: never gated.
		expect(
			evaluatePrLifecycleGate({
				card: makeCard({ autoAddressComments: true, pullRequests: [LINK] }),
				installed: { comments: false, mergeCompletion: true },
			}),
		).toEqual({ legacyCompletionGated: false, mergeFinishesInReview: false });
	});

	it("never gates a card without a resolvable automation PR", () => {
		expect(
			evaluatePrLifecycleGate({
				card: makeCard({ autoAddressComments: true, autoFinishOnMerge: true }),
				installed: installedBoth,
			}),
		).toEqual({ legacyCompletionGated: false, mergeFinishesInReview: false });
	});
});

describe("pr-track1 task-derived subscription demand", () => {
	const bothInstalled = { comments: true, mergeCompletion: true };

	it("demands only for active cards with a resolvable PR and an installed enabled checkbox", () => {
		const active = makeCard({ id: "t-active", autoAddressComments: true, pullRequests: [LINK] });
		const done = makeCard({ id: "t-done", autoAddressComments: true, pullRequests: [LINK] });
		const unchecked = makeCard({ id: "t-off", pullRequests: [LINK] });
		const ambiguous = makeCard({
			id: "t-ambiguous",
			autoAddressComments: true,
			pullRequests: [
				LINK,
				{ ...LINK, repository: "cline/other", number: 7, url: "https://github.com/cline/other/pull/7" },
			],
		});
		const boards = [
			makeBoard("ws-1", [
				{ columnId: "in_progress", card: active },
				{ columnId: "in_progress", card: unchecked },
				{ columnId: "in_progress", card: ambiguous },
				{ columnId: "done", card: done },
			]),
		];

		const demands = computeTaskSubscriptionDemand(boards, bothInstalled);
		expect(demands).toHaveLength(1);
		expect(demands[0]).toMatchObject({
			workspaceId: "ws-1",
			taskId: "t-active",
			canonicalPrKey: PR_KEY,
			consumers: { comments: true, mergeCompletion: false },
		});
	});

	it("creates no demand for an enabled checkbox whose consumer is not installed", () => {
		const card = makeCard({ id: "t-uninstalled", autoFinishOnMerge: true, pullRequests: [LINK] });
		const boards = [makeBoard("ws-1", [{ columnId: "review", card }])];
		expect(computeTaskSubscriptionDemand(boards, { comments: false, mergeCompletion: false })).toEqual([]);
		expect(computeTaskSubscriptionDemand(boards, { comments: true, mergeCompletion: false })).toEqual([]);
	});

	it("reconciles additions, updates, and prunes when tasks become ineligible", async () => {
		let boards = [
			makeBoard("ws-1", [
				{ columnId: "in_progress", card: makeCard({ id: "t-1", autoAddressComments: true, pullRequests: [LINK] }) },
			]),
		];
		const added: string[] = [];
		const removed: string[] = [];
		const current: Array<{
			workspaceId: string;
			taskId: string;
			canonicalPrKey: string;
			column: string;
			consumers: { comments: boolean; mergeCompletion: boolean };
		}> = [];
		const controller: PrSubscriptionController = {
			async addSubscription(descriptor) {
				added.push(descriptor.taskId);
				current.push({
					workspaceId: descriptor.workspaceId,
					taskId: descriptor.taskId,
					canonicalPrKey: descriptor.canonicalPrKey,
					column: descriptor.column,
					consumers: descriptor.consumers,
				});
				return { status: "active" as const };
			},
			async removeSubscription(workspaceId, taskId) {
				removed.push(`${workspaceId}:${taskId}`);
				const index = current.findIndex((entry) => entry.workspaceId === workspaceId && entry.taskId === taskId);
				if (index !== -1) {
					current.splice(index, 1);
				}
			},
			listSubscriptions() {
				return current;
			},
		};
		const source: PrTaskSubscriptionSource = {
			async listBoards() {
				return boards;
			},
			installedConsumers: () => bothInstalled,
		};

		expect(await reconcileTaskSubscriptions(controller, source)).toEqual({
			added: ["ws-1:t-1"],
			removed: [],
			updated: [],
		});

		// Card moved to Done: demand pruned, subscription removed.
		boards = [
			makeBoard("ws-1", [
				{ columnId: "done", card: makeCard({ id: "t-1", autoAddressComments: true, pullRequests: [LINK] }) },
			]),
		];
		expect(await reconcileTaskSubscriptions(controller, source)).toEqual({
			added: [],
			removed: ["ws-1:t-1"],
			updated: [],
		});
	});

	it("updates a subscription when the card changes column or PR", async () => {
		let boards = [
			makeBoard("ws-1", [
				{ columnId: "in_progress", card: makeCard({ id: "t-1", autoAddressComments: true, pullRequests: [LINK] }) },
			]),
		];
		const current: Array<{
			workspaceId: string;
			taskId: string;
			canonicalPrKey: string;
			column: string;
			consumers: { comments: boolean; mergeCompletion: boolean };
		}> = [];
		const controller: PrSubscriptionController = {
			async addSubscription(descriptor) {
				current.push({
					workspaceId: descriptor.workspaceId,
					taskId: descriptor.taskId,
					canonicalPrKey: descriptor.canonicalPrKey,
					column: descriptor.column,
					consumers: descriptor.consumers,
				});
				return { status: "active" as const };
			},
			async removeSubscription(workspaceId, taskId) {
				const index = current.findIndex((entry) => entry.workspaceId === workspaceId && entry.taskId === taskId);
				if (index !== -1) {
					current.splice(index, 1);
				}
			},
			listSubscriptions() {
				return current;
			},
		};
		const source: PrTaskSubscriptionSource = {
			async listBoards() {
				return boards;
			},
			installedConsumers: () => ({ comments: true, mergeCompletion: true }),
		};

		expect(await reconcileTaskSubscriptions(controller, source)).toEqual({
			added: ["ws-1:t-1"],
			removed: [],
			updated: [],
		});
		expect(current[0]).toMatchObject({
			column: "in_progress",
			consumers: { comments: true, mergeCompletion: false },
		});

		// Moved to Review with the merge checkbox enabled: remove + re-add.
		boards = [
			makeBoard("ws-1", [
				{
					columnId: "review",
					card: makeCard({ id: "t-1", autoAddressComments: true, autoFinishOnMerge: true, pullRequests: [LINK] }),
				},
			]),
		];
		expect(await reconcileTaskSubscriptions(controller, source)).toEqual({
			added: [],
			removed: [],
			updated: ["ws-1:t-1"],
		});
		expect(current[0]).toMatchObject({ column: "review", consumers: { comments: true, mergeCompletion: true } });
	});
});

const RECORD_IDENTITY = {
	canonicalPrKey: PR_KEY,
	provider: "github" as const,
	host: "github.com",
	repository: "cline/kanban",
	number: 49,
};

describe("pr-track1 repair owner selection and transfer", () => {
	it("assigns exactly one candidate atomically and keeps an existing owner", async () => {
		const store = new InMemoryPrRecordStore();
		await store.createRecord(RECORD_IDENTITY);
		const boards = [
			makeBoard("ws-1", [
				{
					columnId: "in_progress",
					card: makeCard({ id: "t-owner", autoAddressComments: true, pullRequests: [LINK] }),
				},
			]),
		];

		const assigned = await selectRepairOwner(store, PR_KEY, boards);
		expect(assigned.ok).toBe(true);
		expect(assigned.assigned).toBe(true);
		expect(assigned.owner).toMatchObject({ workspaceId: "ws-1", taskId: "t-owner" });

		// Owner retained even when a second candidate appears.
		const boardsWithTwo = [
			makeBoard("ws-1", [
				{
					columnId: "in_progress",
					card: makeCard({ id: "t-owner", autoAddressComments: true, pullRequests: [LINK] }),
				},
				{ columnId: "review", card: makeCard({ id: "t-second", autoAddressComments: true, pullRequests: [LINK] }) },
			]),
		];
		const retained = await selectRepairOwner(store, PR_KEY, boardsWithTwo);
		expect(retained.ok).toBe(true);
		expect(retained.assigned).toBe(false);
		expect(retained.owner).toMatchObject({ workspaceId: "ws-1", taskId: "t-owner" });
	});

	it("blocks ambiguous candidates and missing records/candidates", async () => {
		const store = new InMemoryPrRecordStore();
		await store.createRecord(RECORD_IDENTITY);
		const boards = [
			makeBoard("ws-1", [
				{ columnId: "in_progress", card: makeCard({ id: "t-a", autoAddressComments: true, pullRequests: [LINK] }) },
				{ columnId: "in_progress", card: makeCard({ id: "t-b", autoAddressComments: true, pullRequests: [LINK] }) },
			]),
		];

		const ambiguous = await selectRepairOwner(store, PR_KEY, boards);
		expect(ambiguous.ok).toBe(false);
		expect(ambiguous.reason).toBe("ambiguous");
		expect(ambiguous.candidates).toHaveLength(2);

		const noRecord = await selectRepairOwner(store, "github|github.com|cline/kanban|99", boards);
		expect(noRecord).toMatchObject({ ok: false, reason: "no_record" });

		const noCandidates = await selectRepairOwner(store, PR_KEY, [makeBoard("ws-1", [])]);
		expect(noCandidates).toMatchObject({ ok: false, reason: "no_candidates" });
	});

	it("transfers only when drained, and releases with a transfer to none", async () => {
		const store = new InMemoryPrRecordStore();
		await store.createRecord(RECORD_IDENTITY);
		const owner = { workspaceId: "ws-1", taskId: "t-owner" };
		const next = { workspaceId: "ws-2", taskId: "t-next" };
		const boards = [
			makeBoard("ws-1", [
				{
					columnId: "in_progress",
					card: makeCard({ id: "t-owner", autoAddressComments: true, pullRequests: [LINK] }),
				},
			]),
			makeBoard("ws-2", [
				{
					columnId: "in_progress",
					card: makeCard({ id: "t-next", autoAddressComments: true, pullRequests: [LINK] }),
				},
			]),
		];
		// Seed the owner from the single-candidate board, then transfer
		// across the full board set (t-next is a valid candidate).
		await selectRepairOwner(store, PR_KEY, [boards[0]]);

		const notDrained = await transferRepairOwner(store, PR_KEY, owner, next, boards, { writerActionsDrained: false });
		expect(notDrained).toMatchObject({ ok: false, reason: "drain_required" });

		const staleCaller = await transferRepairOwner(
			store,
			PR_KEY,
			{ workspaceId: "ws-9", taskId: "nobody" },
			next,
			boards,
			{ writerActionsDrained: true },
		);
		expect(staleCaller).toMatchObject({ ok: false, reason: "not_owner" });

		const transferred = await transferRepairOwner(store, PR_KEY, owner, next, boards, { writerActionsDrained: true });
		expect(transferred.ok).toBe(true);
		expect(transferred.owner).toMatchObject({ workspaceId: "ws-2", taskId: "t-next" });

		// Release: transfer to none clears the owner.
		const released = await transferRepairOwner(store, PR_KEY, next, null, boards, { writerActionsDrained: true });
		expect(released.ok).toBe(true);
		expect(released.owner).toBeNull();
	});
});

describe("pr-track1 automation PR resolution", () => {
	it("prefers the explicit selection and auto-resolves a sole link", () => {
		const selected = makeCard({
			selectedAutomationPrKey: PR_KEY,
			pullRequests: [LINK, { ...LINK, number: 7, url: "https://github.com/cline/kanban/pull/7" }],
		});
		expect(resolveCardAutomationPrKey(selected).key).toBe(PR_KEY);
		expect(resolveCardAutomationPrKey(selected).ambiguous).toBe(false);

		const sole = makeCard({ pullRequests: [LINK] });
		expect(resolveCardAutomationPrKey(sole)).toMatchObject({ key: PR_KEY, ambiguous: false });

		const ambiguous = makeCard({
			pullRequests: [
				LINK,
				{ ...LINK, repository: "cline/other", number: 7, url: "https://github.com/cline/other/pull/7" },
			],
		});
		expect(resolveCardAutomationPrKey(ambiguous)).toMatchObject({ key: null, ambiguous: true });
	});

	it("lists candidates deterministically across workspaces", () => {
		const boards = [
			makeBoard("ws-b", [
				{ columnId: "review", card: makeCard({ id: "t-b", autoAddressComments: true, pullRequests: [LINK] }) },
			]),
			makeBoard("ws-a", [
				{ columnId: "in_progress", card: makeCard({ id: "t-a", autoAddressComments: true, pullRequests: [LINK] }) },
			]),
		];
		const candidates = listRepairOwnerCandidates(PR_KEY, boards);
		expect(candidates.map((candidate) => candidate.taskId)).toEqual(["t-a", "t-b"]);
	});
});

import { getPullRequestIdentityKey } from "../../../src/core/pull-request-links";
import { removeTaskPullRequest } from "../../../src/core/task-board-mutations";
import { assignRepairOwner, validateAutoAssignedOwner } from "../../../src/pr-tracking/pr-owner-selection";
import { releasePrOperation, reservePrOperation } from "../../../src/pr-tracking/pr-reservations";

async function seedRecordWithHead(store: InMemoryPrRecordStore, headRepository: string | null, headRef: string | null) {
	await store.createRecord(RECORD_IDENTITY);
	const loaded = await store.loadRecord(PR_KEY);
	if (!loaded.ok) {
		throw new Error("record missing after create");
	}
	await store.updateRecord(PR_KEY, loaded.record.revision, (record) => ({
		...record,
		revision: record.revision + 1,
		updatedAt: 1,
		snapshots:
			headRepository === null || headRef === null
				? record.snapshots
				: {
						"scope-1": {
							accessScopeId: "scope-1",
							checkedAt: 1,
							state: "open" as const,
							headRepository,
							headRef,
							baseRepository: "cline/kanban",
							baseRef: "main",
							headSha: null,
							mergedAt: null,
							mergeCommitSha: null,
						},
					},
	}));
}

describe("pr-track1 explicit repair-owner assignment", () => {
	it("assigns a valid candidate among multiple candidates and rejects stale revisions", async () => {
		const store = new InMemoryPrRecordStore();
		await store.createRecord(RECORD_IDENTITY);
		const boards = [
			makeBoard("ws-1", [
				{ columnId: "in_progress", card: makeCard({ id: "t-a", autoAddressComments: true, pullRequests: [LINK] }) },
				{ columnId: "review", card: makeCard({ id: "t-b", autoAddressComments: true, pullRequests: [LINK] }) },
			]),
		];

		const assigned = await assignRepairOwner(store, PR_KEY, boards, { workspaceId: "ws-1", taskId: "t-b" });
		expect(assigned.ok).toBe(true);
		expect(assigned.assigned).toBe(true);
		expect(assigned.owner).toMatchObject({ workspaceId: "ws-1", taskId: "t-b", ownerRevision: 1 });

		// Re-assigning the same task keeps the same tenure (no revision bump).
		const again = await assignRepairOwner(store, PR_KEY, boards, { workspaceId: "ws-1", taskId: "t-b" });
		expect(again.ok).toBe(true);
		expect(again.assigned).toBe(false);
		expect(again.owner?.ownerRevision).toBe(1);

		// Stale expectedOwnerRevision on a different target: conflict.
		const stale = await assignRepairOwner(
			store,
			PR_KEY,
			boards,
			{ workspaceId: "ws-1", taskId: "t-a" },
			{ expectedOwnerRevision: 99 },
		);
		expect(stale).toMatchObject({ ok: false, reason: "conflict" });
		expect(stale.owner).toMatchObject({ taskId: "t-b" });
	});

	it("rejects a target that is not a valid candidate", async () => {
		const store = new InMemoryPrRecordStore();
		await store.createRecord(RECORD_IDENTITY);
		const boards = [
			makeBoard("ws-1", [
				{ columnId: "in_progress", card: makeCard({ id: "t-a", autoAddressComments: true, pullRequests: [LINK] }) },
			]),
		];
		const invalid = await assignRepairOwner(store, PR_KEY, boards, { workspaceId: "ws-9", taskId: "t-x" });
		expect(invalid).toMatchObject({ ok: false, reason: "not_valid_candidate", assigned: false });
	});
});

describe("pr-track1 cross-repository auto-owner guard", () => {
	it("invalidates an auto-assignment when the verified head mapping is another repository", async () => {
		const store = new InMemoryPrRecordStore();
		await seedRecordWithHead(store, "cline/fork", "fix");
		const boards = [
			makeBoard("ws-1", [
				{ columnId: "in_progress", card: makeCard({ id: "t-a", autoAddressComments: true, pullRequests: [LINK] }) },
			]),
		];
		const assigned = await assignRepairOwner(store, PR_KEY, boards, { workspaceId: "ws-1", taskId: "t-a" });
		expect(assigned.ok).toBe(true);

		const warnings: string[] = [];
		const result = await validateAutoAssignedOwner(store, PR_KEY, { warn: (message) => warnings.push(message) });
		expect(result).toEqual({ invalidated: true, headRepository: "cline/fork", recordRepository: "cline/kanban" });
		expect(warnings.length).toBe(1);

		const after = await store.loadRecord(PR_KEY);
		expect(after.ok).toBe(true);
		if (after.ok) {
			expect(after.record.commentAutomation.repairOwner).toBeNull();
		}
	});

	it("keeps the owner when the verified head mapping matches the record's repository", async () => {
		const store = new InMemoryPrRecordStore();
		await seedRecordWithHead(store, "cline/kanban", "fix");
		const boards = [
			makeBoard("ws-1", [
				{ columnId: "in_progress", card: makeCard({ id: "t-a", autoAddressComments: true, pullRequests: [LINK] }) },
			]),
		];
		await assignRepairOwner(store, PR_KEY, boards, { workspaceId: "ws-1", taskId: "t-a" });

		const result = await validateAutoAssignedOwner(store, PR_KEY);
		expect(result).toEqual({ invalidated: false, headRepository: "cline/kanban", recordRepository: "cline/kanban" });

		const after = await store.loadRecord(PR_KEY);
		expect(after.ok).toBe(true);
		if (after.ok) {
			expect(after.record.commentAutomation.repairOwner).toMatchObject({ taskId: "t-a" });
		}
	});
});

describe("pr-track1 fenced operation reservations", () => {
	const task = { workspaceId: "ws-1", taskId: "t-merge" };

	it("requires the repair owner for comments but not for merge completion", async () => {
		const store = new InMemoryPrRecordStore();
		await seedRecordWithHead(store, "cline/kanban", "fix");

		const commentBlocked = await reservePrOperation(store, PR_KEY, "comment_followup", task, { requireOwner: true });
		expect(commentBlocked.status).toBe("blocked");

		const mergeReserved = await reservePrOperation(store, PR_KEY, "merge_completion", task, { requireOwner: false });
		expect(mergeReserved.status).toBe("reserved");
		expect(mergeReserved.reservation.reservedBy).toMatchObject(task);

		// A non-holder release without force is stale; with force it clears.
		const otherTask = { workspaceId: "ws-2", taskId: "t-other" };
		const softRelease = await releasePrOperation(store, PR_KEY, "merge_completion", otherTask);
		expect(softRelease.status).toBe("stale");
		const forcedRelease = await releasePrOperation(store, PR_KEY, "merge_completion", otherTask, undefined, {
			force: true,
		});
		expect(forcedRelease.status).toBe("reserved");
		expect(forcedRelease.reservation.state).toBe("none");
	});

	it("rejects a caller head hint that disagrees with the record's verified mapping", async () => {
		const store = new InMemoryPrRecordStore();
		await seedRecordWithHead(store, "cline/kanban", "fix");

		const mismatch = await reservePrOperation(store, PR_KEY, "merge_completion", task, {
			requireOwner: false,
			headRepository: "cline/other",
			headRef: "fix",
		});
		expect(mismatch.status).toBe("blocked");

		const matching = await reservePrOperation(store, PR_KEY, "merge_completion", task, {
			requireOwner: false,
			headRepository: "cline/kanban",
			headRef: "fix",
		});
		expect(matching.status).toBe("reserved");
	});

	it("blocks when the record has no verified head mapping", async () => {
		const store = new InMemoryPrRecordStore();
		await seedRecordWithHead(store, null, null);

		const blocked = await reservePrOperation(store, PR_KEY, "merge_completion", task, { requireOwner: false });
		expect(blocked.status).toBe("blocked");
	});
});

describe("pr-track1 PR link removal and automation selection", () => {
	it("clears the selected automation PR when the removed link is the selection", () => {
		const other = { ...LINK, repository: "cline/other", number: 7, url: "https://github.com/cline/other/pull/7" };
		const board = makeBoard("ws-1", [
			{
				columnId: "in_progress",
				card: makeCard({
					id: "t-1",
					autoAddressComments: true,
					selectedAutomationPrKey: PR_KEY,
					pullRequests: [LINK, other],
				}),
			},
		]).board;

		const result = removeTaskPullRequest(board, "t-1", getPullRequestIdentityKey(LINK), 123);
		expect(result.removed).toBe(true);
		expect(result.task?.selectedAutomationPrKey).toBeUndefined();
		expect(result.task?.settingsRevision).toBe(1);
		// The remaining link is untouched.
		expect(result.task?.pullRequests).toHaveLength(1);
	});

	it("keeps the selection when removing an unselected link", () => {
		const other = { ...LINK, repository: "cline/other", number: 7, url: "https://github.com/cline/other/pull/7" };
		const board = makeBoard("ws-1", [
			{
				columnId: "in_progress",
				card: makeCard({
					id: "t-1",
					autoAddressComments: true,
					selectedAutomationPrKey: PR_KEY,
					pullRequests: [LINK, other],
				}),
			},
		]).board;

		const result = removeTaskPullRequest(board, "t-1", getPullRequestIdentityKey(other), 123);
		expect(result.removed).toBe(true);
		expect(result.task?.selectedAutomationPrKey).toBe(PR_KEY);
		expect(result.task?.settingsRevision).toBeUndefined();
	});
});
