import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitHubPrMetadataSnapshot, RuntimeBoardCard } from "../../../src/core/api-contract";
import type {
	AccessScope,
	AccessScopeResult,
	FeedbackReadResult,
	GitHubGhAdapter,
	MetadataReadResult,
} from "../../../src/pr-tracking/github-gh-adapter";
import { InMemoryPrRecordStore } from "../../../src/pr-tracking/in-memory-pr-record-store";
import { type PrConsumerObservation, PrConsumerRegistry } from "../../../src/pr-tracking/pr-consumer-registry";
import {
	type PrMergeCompletionDeps,
	reconcileMergeCompletion,
	registerMergeCompletionConsumer,
} from "../../../src/pr-tracking/pr-merge-completion";
import type { PrRecordIdentity } from "../../../src/pr-tracking/pr-record-store";
import { releasePrOperation, reservePrOperation } from "../../../src/pr-tracking/pr-reservations";
import { normalizePrMetadata } from "../../../src/pr-tracking/pr-snapshots";
import {
	createPrTrackingCoordinator,
	type PrTrackingCoordinator,
	type PrTrackingSubscriptionDescriptor,
} from "../../../src/pr-tracking/pr-tracking-coordinator";

const PR_KEY = "github|github.com|cline/kanban|49";
const RECORD_IDENTITY: PrRecordIdentity = {
	canonicalPrKey: PR_KEY,
	provider: "github",
	host: "github.com",
	repository: "cline/kanban",
	number: 49,
};
const TASK = { workspaceId: "ws-1", taskId: "task-1" };
const NOW = 1_700_000_100_000;
const POLL_MS = 60_000;

function makeMergedMetadata(overrides: Partial<GitHubPrMetadataSnapshot> = {}): GitHubPrMetadataSnapshot {
	return {
		accessScopeId: "scope-1",
		checkedAt: NOW,
		state: "merged",
		headRepository: "fork/kanban",
		headRef: "feat/branch",
		baseRepository: "cline/kanban",
		baseRef: "main",
		headSha: "headsha1",
		mergedAt: NOW - 1000,
		mergeCommitSha: "mergesha1",
		...overrides,
	};
}

function makeCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: TASK.taskId,
		title: "Task 1",
		prompt: "do the thing",
		startInPlanMode: false,
		baseRef: "main",
		autoFinishOnMerge: true,
		createdAt: NOW - 100_000,
		updatedAt: NOW - 100_000,
		...overrides,
	};
}

/**
 * A fresh in-memory store with a record carrying a verified head mapping
 * (required for merge_completion reservations) and the task's binding.
 */
async function makeStore(): Promise<InMemoryPrRecordStore> {
	const store = new InMemoryPrRecordStore({ now: () => NOW });
	await store.createRecord(RECORD_IDENTITY);
	await store.setMetadataSnapshot(PR_KEY, makeMergedMetadata());
	await store.upsertTaskBinding(PR_KEY, TASK);
	return store;
}

function makeObservation(
	record: { taskBindings: unknown[]; canonicalPrKey: string },
	metadata: GitHubPrMetadataSnapshot = makeMergedMetadata(),
): PrConsumerObservation {
	return {
		task: TASK,
		record: record as unknown as PrConsumerObservation["record"],
		snapshot: {
			canonicalPrKey: PR_KEY,
			accessScopeId: metadata.accessScopeId,
			checkedAt: NOW,
			metadata,
			feedback: null,
			feedbackCompleteness: null,
		},
		installedConsumers: { comments: false, mergeCompletion: true },
		now: NOW,
	};
}

interface TestDeps extends PrMergeCompletionDeps {
	completeCalls: Array<{ workspaceId: string; taskId: string }>;
	warnings: string[];
}

function makeDeps(store: InMemoryPrRecordStore, overrides: Partial<PrMergeCompletionDeps> = {}): TestDeps {
	const completeCalls: Array<{ workspaceId: string; taskId: string }> = [];
	const warnings: string[] = [];
	return {
		store,
		getTaskCard: async () => ({ card: makeCard(), columnId: "review" }),
		isTaskWriterActive: async () => false,
		completeTask: async (workspaceId, taskId) => {
			completeCalls.push({ workspaceId, taskId });
		},
		warn: (message) => {
			warnings.push(message);
		},
		now: () => NOW,
		completeCalls,
		warnings,
		...overrides,
	};
}

async function loadRecord(store: InMemoryPrRecordStore) {
	const result = await store.loadRecord(PR_KEY);
	if (!result.ok) {
		throw new Error("record missing");
	}
	return result.record;
}

describe("pr-merge-completion consumer", () => {
	it("completes the task when the merged PR's merge commit is verified on the base branch", async () => {
		const store = await makeStore();
		const deps = makeDeps(store);
		const observation = makeObservation(await loadRecord(store));
		await expect(reconcileMergeCompletion(observation, deps)).resolves.toEqual({ action: "completed" });
		expect(deps.completeCalls).toEqual([TASK]);

		const record = await loadRecord(store);
		const binding = record.taskBindings[0];
		expect(binding.mergeCompletion).toMatchObject({
			status: "completed",
			prKey: PR_KEY,
			mergeCommitSha: "mergesha1",
			completedAt: NOW,
			error: null,
		});
		expect(binding.terminalStop?.reason).toBe("merged_completed");
		// The merge reservation is released when the episode ends.
		expect(record.reservation.state).toBe("none");
	});

	it("completes again only for a LATER merge (a different merge commit)", async () => {
		const store = await makeStore();
		const deps = makeDeps(store);
		await reconcileMergeCompletion(makeObservation(await loadRecord(store)), deps);
		expect(deps.completeCalls.length).toBe(1);

		// The same merge commit again (e.g. a redelivered read after restart)
		// never re-completes.
		const second = makeObservation(await loadRecord(store));
		await expect(reconcileMergeCompletion(second, deps)).resolves.toEqual({
			action: "skipped",
			reason: "merge_already_consumed",
		});
		expect(deps.completeCalls.length).toBe(1);

		// A later merge (new merge commit) completes the task again.
		const later = makeObservation(await loadRecord(store), makeMergedMetadata({ mergeCommitSha: "mergesha2" }));
		await expect(reconcileMergeCompletion(later, deps)).resolves.toEqual({ action: "completed" });
		expect(deps.completeCalls.length).toBe(2);
	});

	it("skips when the preference is off, the task is missing, or the task is in an inactive column", async () => {
		const store = await makeStore();
		const record = await loadRecord(store);
		await expect(
			reconcileMergeCompletion(
				makeObservation(record),
				makeDeps(store, {
					getTaskCard: async () => ({ card: makeCard({ autoFinishOnMerge: false }), columnId: "review" }),
				}),
			),
		).resolves.toEqual({ action: "skipped", reason: "preference_off" });
		await expect(
			reconcileMergeCompletion(makeObservation(record), makeDeps(store, { getTaskCard: async () => null })),
		).resolves.toEqual({ action: "skipped", reason: "task_missing" });
		await expect(
			reconcileMergeCompletion(
				makeObservation(record),
				makeDeps(store, {
					getTaskCard: async () => ({ card: makeCard(), columnId: "backlog" }),
				}),
			),
		).resolves.toEqual({ action: "skipped", reason: "inactive_column" });
	});

	it("skips a PR that is not merged", async () => {
		const store = await makeStore();
		const deps = makeDeps(store);
		const observation = makeObservation(
			await loadRecord(store),
			makeMergedMetadata({ state: "open", mergeCommitSha: null }),
		);
		await expect(reconcileMergeCompletion(observation, deps)).resolves.toEqual({
			action: "skipped",
			reason: "not_merged",
		});
		expect(deps.completeCalls.length).toBe(0);
	});

	it("stays pending while a writer session is active (retry on the next read)", async () => {
		const store = await makeStore();
		const deps = makeDeps(store, { isTaskWriterActive: async () => true });
		await expect(reconcileMergeCompletion(makeObservation(await loadRecord(store)), deps)).resolves.toEqual({
			action: "pending",
			reason: "writer_active",
		});
		const record = await loadRecord(store);
		expect(record.taskBindings[0].mergeCompletion).toBeNull();
		expect(record.taskBindings[0].terminalStop).toBeNull();
		expect(record.reservation.state).toBe("none");
		expect(deps.completeCalls.length).toBe(0);
	});

	it("stays pending while another task holds the merge_completion reservation, then completes after release", async () => {
		const store = await makeStore();
		const otherTask = { workspaceId: "ws-1", taskId: "task-2" };
		const held = await reservePrOperation(store, PR_KEY, "merge_completion", otherTask, {
			requireOwner: false,
			now: () => NOW,
		});
		expect(held.status).toBe("reserved");

		const deps = makeDeps(store);
		await expect(reconcileMergeCompletion(makeObservation(await loadRecord(store)), deps)).resolves.toEqual({
			action: "pending",
			reason: "reservation_busy",
		});
		expect(deps.completeCalls.length).toBe(0);

		const released = await releasePrOperation(store, PR_KEY, "merge_completion", otherTask, () => NOW);
		expect(released.status).toBe("reserved");

		await expect(reconcileMergeCompletion(makeObservation(await loadRecord(store)), deps)).resolves.toEqual({
			action: "completed",
		});
		expect(deps.completeCalls).toEqual([TASK]);
	});

	it("blocks (needs human) when the base branch does not contain the merge commit", async () => {
		const store = await makeStore();
		const deps = makeDeps(store, {
			inspectWorktree: async () => ({
				worktreePath: null,
				worktreeHead: "basehead",
				baseSha: "basehead",
				baseContainsMerge: false,
				dirty: false,
				aheadOfBase: 0,
			}),
		});
		await expect(reconcileMergeCompletion(makeObservation(await loadRecord(store)), deps)).resolves.toEqual({
			action: "blocked",
			reason: "The task's base branch does not contain the PR merge commit.",
		});
		const record = await loadRecord(store);
		expect(record.taskBindings[0].mergeCompletion).toMatchObject({
			status: "blocked",
			error: "The task's base branch does not contain the PR merge commit.",
			completedAt: null,
		});
		expect(record.taskBindings[0].terminalStop?.reason).toBe("merged_unresolved");
		expect(record.reservation.state).toBe("none");
		expect(deps.completeCalls.length).toBe(0);
	});

	it("blocks (needs human) when the worktree has local commits ahead of the base branch", async () => {
		const store = await makeStore();
		const deps = makeDeps(store, {
			inspectWorktree: async () => ({
				worktreePath: null,
				worktreeHead: "worktree-head",
				baseSha: "basehead",
				baseContainsMerge: true,
				dirty: false,
				aheadOfBase: 2,
			}),
		});
		await expect(reconcileMergeCompletion(makeObservation(await loadRecord(store)), deps)).resolves.toEqual({
			action: "blocked",
			reason: "The task worktree has 2 local commit(s) not in the base branch.",
		});
		const record = await loadRecord(store);
		expect(record.taskBindings[0].mergeCompletion?.status).toBe("blocked");
		expect(record.taskBindings[0].terminalStop?.reason).toBe("merged_unresolved");
		expect(deps.completeCalls.length).toBe(0);
	});

	it("treats a failing worktree inspection as a retryable pending state", async () => {
		const store = await makeStore();
		const deps = makeDeps(store, {
			inspectWorktree: async () => {
				throw new Error("worktree gone");
			},
		});
		await expect(reconcileMergeCompletion(makeObservation(await loadRecord(store)), deps)).resolves.toEqual({
			action: "pending",
			reason: "worktree_inspection_failed",
		});
		expect(deps.warnings.some((message) => message.includes("worktree inspection failed"))).toBe(true);
		expect(deps.completeCalls.length).toBe(0);
	});

	it("resets a dirty worktree to the base branch before completing", async () => {
		// The worktree HEAD equals the base but has uncommitted changes: the
		// consumer must discard them (git reset --hard <base>) and complete.
		// The fake path is a real temp directory that is NOT a git
		// repository, so verify the reset is attempted AND that a failed
		// reset stays pending (never completes on a broken worktree).
		const store = await makeStore();
		const scratch = mkdtempSync(join(tmpdir(), "kanban-merge-wt-"));
		const deps = makeDeps(store, {
			inspectWorktree: async () => ({
				worktreePath: scratch,
				worktreeHead: "basehead",
				baseSha: "basehead",
				baseContainsMerge: true,
				dirty: true,
				aheadOfBase: 0,
			}),
		});
		await expect(reconcileMergeCompletion(makeObservation(await loadRecord(store)), deps)).resolves.toEqual({
			action: "pending",
			reason: "worktree_reset_failed",
		});
		const record = await loadRecord(store);
		expect(record.taskBindings[0].mergeCompletion).toBeNull();
		expect(deps.completeCalls.length).toBe(0);
		expect(record.reservation.state).toBe("none");
		rmSync(scratch, { recursive: true, force: true });
	});
});

describe("pr-merge-completion coordinator delivery", () => {
	let root: string;
	let coordinators: PrTrackingCoordinator[];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "kanban-pr-merge-"));
		coordinators = [];
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		mkdirSync(join(root, "locks"));
	});

	afterEach(async () => {
		for (const coordinator of coordinators.splice(0)) {
			await coordinator.stop();
		}
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	async function settle(iterations = 120): Promise<void> {
		for (let i = 0; i < iterations; i += 1) {
			await vi.advanceTimersByTimeAsync(25);
		}
	}

	function makeCoordinator(
		store: InMemoryPrRecordStore,
		registry: PrConsumerRegistry,
		metadata: (callIndex: number, prNumber: number) => MetadataReadResult,
	): PrTrackingCoordinator {
		const scope: AccessScope = { accessScopeId: "scope-1", login: "alice", tokenSource: "GH_TOKEN" };
		const fake = {
			resolveAccessScope: async (): Promise<AccessScopeResult> => ({ ok: true, scope }),
			readPrMetadata: async (parsed: { number: number }): Promise<MetadataReadResult> => metadata(0, parsed.number),
			// Feedback sources are never read for a merge-only consumer
			// (required read sources are metadata only).
			readRestListSource: async (): Promise<FeedbackReadResult> => ({ kind: "not_modified" }),
			readReviewThreads: async (): Promise<FeedbackReadResult> => ({ kind: "not_modified" }),
		} as unknown as GitHubGhAdapter;
		const coordinator = createPrTrackingCoordinator({
			adapter: fake,
			store,
			consumerRegistry: registry,
			listManagedWorkspaceBoards: async () => [],
			now: () => Date.now(),
			random: () => 0,
			schedulerLockRequest: {
				path: join(root, "locks"),
				type: "directory",
				lockfilePath: join(root, "locks", ".scheduler.lock"),
			},
		});
		coordinators.push(coordinator);
		return coordinator;
	}

	const mergedMetadataResult: MetadataReadResult = {
		kind: "ok",
		metadata: normalizePrMetadata(
			{
				state: "closed",
				merged: true,
				node_id: "PR_49",
				head: { sha: "headsha1", ref: "feat/branch", repo: { full_name: "fork/kanban" } },
				base: { ref: "main" },
				merged_at: "2023-11-14T22:16:40Z",
				merge_commit_sha: "mergesha1",
			},
			"scope-1",
			NOW,
		),
		nodeId: "PR_49",
		bodyDigest: "digest-merged-49",
	};

	it("delivers the merged-PR observation to the installed consumer during a poll cycle", async () => {
		const store = await makeStore();
		const registry = new PrConsumerRegistry();
		const completeCalls: Array<{ workspaceId: string; taskId: string }> = [];
		registerMergeCompletionConsumer(registry, {
			store,
			getTaskCard: async () => ({ card: makeCard(), columnId: "review" }),
			isTaskWriterActive: async () => false,
			completeTask: async (workspaceId, taskId) => {
				completeCalls.push({ workspaceId, taskId });
			},
			now: () => NOW,
		});
		const coordinator = makeCoordinator(store, registry, () => mergedMetadataResult);
		const descriptor: PrTrackingSubscriptionDescriptor = {
			workspaceId: TASK.workspaceId,
			taskId: TASK.taskId,
			canonicalPrKey: PR_KEY,
			column: "review",
			consumers: { comments: false, mergeCompletion: true },
		};
		expect((await coordinator.addSubscription(descriptor)).status).toBe("active");

		await vi.advanceTimersByTimeAsync(POLL_MS);
		await settle();

		expect(completeCalls).toEqual([TASK]);
		const record = await loadRecord(store);
		expect(record.taskBindings[0].mergeCompletion?.status).toBe("completed");
	});

	it("does not complete when no consumer is installed", async () => {
		const store = await makeStore();
		const registry = new PrConsumerRegistry();
		const completeCalls: Array<{ workspaceId: string; taskId: string }> = [];
		const coordinator = makeCoordinator(store, registry, () => mergedMetadataResult);
		const descriptor: PrTrackingSubscriptionDescriptor = {
			workspaceId: TASK.workspaceId,
			taskId: TASK.taskId,
			canonicalPrKey: PR_KEY,
			column: "review",
			consumers: { comments: false, mergeCompletion: true },
		};
		expect((await coordinator.addSubscription(descriptor)).status).toBe("active");

		await vi.advanceTimersByTimeAsync(POLL_MS);
		await settle();

		expect(completeCalls.length).toBe(0);
		const record = await loadRecord(store);
		expect(record.taskBindings[0].mergeCompletion).toBeNull();
	});
});
