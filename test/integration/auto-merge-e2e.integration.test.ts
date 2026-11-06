// AM-5: end-to-end fake-GitHub integration test for the full auto-merge
// lifecycle: coordinator poll -> AM-3 eligibility consumer -> AM-4 executor
// merge write -> remote confirmation -> merge-completion consumer task move
// -> successor release. A real coordinator drives a fake GitHub adapter and
// an in-memory record store; the board-facing effects (completeTask,
// dispatchSuccessors) are stubbed and asserted.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	AutoMergePolicy,
	GitHubPrTaskBinding,
	GitHubPrTrackingRecord,
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeTaskPullRequest,
} from "../../src/core/api-contract";
import { registerAutoMergeConsumer } from "../../src/pr-tracking/auto-merge-eligibility";
import { createAutoMergeExecutor } from "../../src/pr-tracking/auto-merge-executor";
import type {
	AccessScope,
	AccessScopeResult,
	FeedbackReadResult,
	GitHubGhAdapter,
	MergeWriteOutcome,
	MetadataReadResult,
} from "../../src/pr-tracking/github-gh-adapter";
import { InMemoryPrRecordStore } from "../../src/pr-tracking/in-memory-pr-record-store";
import { PrConsumerRegistry } from "../../src/pr-tracking/pr-consumer-registry";
import { type PrMergeCompletionDeps, registerMergeCompletionConsumer } from "../../src/pr-tracking/pr-merge-completion";
import type { PrBoardSnapshot } from "../../src/pr-tracking/pr-owner-selection";
import { normalizePrMetadata } from "../../src/pr-tracking/pr-snapshots";
import {
	createPrTrackingCoordinator,
	type PrTrackingCoordinator,
	type PrTrackingSubscriptionDescriptor,
} from "../../src/pr-tracking/pr-tracking-coordinator";

const BASE_TIME = 1_700_000_000_000;
const POLL_MS = 60_000;
const WORKSPACE_ID = "ws-1";
const TASK_ID = "task-1";
const SUCCESSOR_ID = "task-2";
const PR_KEY = "github|github.com|cline/kanban|49";
const HEAD_SHA = "1111111111111111111111111111111111111111";
const BASE_SHA = "2222222222222222222222222222222222222222";
const MERGE_COMMIT = "3333333333333333333333333333333333333333";
const SCOPE: AccessScope = { accessScopeId: "scope-1", login: "bot", tokenSource: "GH_TOKEN" };
const POLICY: AutoMergePolicy = {
	repository: "cline/kanban",
	requiredChecks: ["ci"],
	mergeMethod: "squash",
	revision: 1,
	updatedAt: BASE_TIME,
};

const PR_LINK: RuntimeTaskPullRequest = {
	provider: "github",
	host: "github.com",
	repository: "cline/kanban",
	number: 49,
	url: "https://github.com/cline/kanban/pull/49",
	source: "agent_tool",
	createdAt: BASE_TIME - 10_000,
};

function makeCard(): RuntimeBoardCard {
	return {
		id: TASK_ID,
		title: "Task 1",
		prompt: "do the thing",
		startInPlanMode: false,
		autoReviewEnabled: false,
		baseRef: "main",
		autoFinishOnMerge: true,
		createdAt: BASE_TIME - 2_000_000,
		updatedAt: BASE_TIME - 2_000_000,
		autoMergeWhenApproved: true,
		armedAutoMergePolicyRevision: POLICY.revision,
		pullRequests: [PR_LINK],
		selectedAutomationPrKey: PR_KEY,
	};
}

function makeBoard(card: RuntimeBoardCard): RuntimeBoardData {
	const columns: Array<{ id: RuntimeBoardData["columns"][number]["id"]; title: string; cards: RuntimeBoardCard[] }> = [
		{ id: "backlog", title: "Backlog", cards: [] },
		{ id: "in_progress", title: "In Progress", cards: [] },
		{ id: "review", title: "In Review", cards: [] },
		{ id: "done", title: "Done", cards: [] },
		{ id: "trash", title: "Trash", cards: [] },
	];
	columns.find((column) => column.id === "review")?.cards.push(card);
	return { columns, dependencies: [] };
}

interface Harness {
	coordinator: PrTrackingCoordinator;
	store: InMemoryPrRecordStore;
	remote: { merged: boolean };
	mergeWrites: Array<{ expectedHeadSha: string; mergeMethod: string }>;
	completeTaskCalls: Array<{ workspaceId: string; taskId: string }>;
	dispatchCalls: Array<{ workspaceId: string; taskId: string; readyTaskIds: string[] }>;
	warnings: string[];
}

function makeMetadata(merged: boolean): MetadataReadResult {
	const raw = merged
		? {
				state: "closed",
				merged: true,
				node_id: "PR_49",
				head: { sha: HEAD_SHA, ref: "task-branch", repo: { full_name: "cline/kanban" } },
				base: { ref: "main", sha: BASE_SHA, repo: { full_name: "cline/kanban" } },
				user: { login: "author-1", type: "User" },
				mergeable: true,
				mergeable_state: "clean",
				merged_at: new Date(BASE_TIME + 1000).toISOString(),
				merge_commit_sha: MERGE_COMMIT,
			}
		: {
				state: "open",
				merged: false,
				node_id: "PR_49",
				head: { sha: HEAD_SHA, ref: "task-branch", repo: { full_name: "cline/kanban" } },
				base: { ref: "main", sha: BASE_SHA, repo: { full_name: "cline/kanban" } },
				user: { login: "author-1", type: "User" },
				mergeable: true,
				mergeable_state: "clean",
			};
	return {
		kind: "ok",
		metadata: normalizePrMetadata(raw, SCOPE.accessScopeId, Date.now()),
		nodeId: "PR_49",
		bodyDigest: `digest-${merged ? "merged" : "open"}`,
	};
}

function makeHarness(root: string): Harness {
	const remote: { merged: boolean } = { merged: false };
	const mergeWrites: Array<{ expectedHeadSha: string; mergeMethod: string }> = [];
	const completeTaskCalls: Array<{ workspaceId: string; taskId: string }> = [];
	const dispatchCalls: Array<{ workspaceId: string; taskId: string; readyTaskIds: string[] }> = [];
	const warnings: string[] = [];
	const store = new InMemoryPrRecordStore({ now: () => Date.now() });
	const card = makeCard();
	const boards: PrBoardSnapshot[] = [{ workspaceId: WORKSPACE_ID, board: makeBoard(card) }];

	const fakeAdapter = {
		resolveAccessScope: async (): Promise<AccessScopeResult> => ({ ok: true, scope: SCOPE }),
		readPrMetadata: async (): Promise<MetadataReadResult> => makeMetadata(remote.merged),
		readRestListSource: async (): Promise<FeedbackReadResult> => ({ kind: "ok", events: [], bodyDigest: "empty" }),
		readReviewThreads: async (): Promise<FeedbackReadResult> => ({ kind: "ok_threads", threads: new Map() }),
		readRawRestList: async (
			endpointBase: string,
		): Promise<{ kind: "ok"; items: unknown[] } | { kind: "failed"; failure: unknown }> => {
			if (endpointBase.includes("/pulls/49/reviews")) {
				return {
					kind: "ok",
					items: [
						{
							id: "rev-1",
							state: "APPROVED",
							user: { login: "reviewer-1", type: "User" },
							commit_id: HEAD_SHA,
							submitted_at: new Date(BASE_TIME - 5_000).toISOString(),
						},
					],
				};
			}
			if (endpointBase.includes("/check-runs")) {
				return {
					kind: "ok",
					items: [
						{
							id: 100,
							name: "ci",
							status: "completed",
							conclusion: "success",
							head_sha: HEAD_SHA,
							completed_at: new Date(BASE_TIME - 5_000).toISOString(),
							app: { id: 123 },
						},
					],
				};
			}
			return { kind: "ok", items: [] };
		},
		readCommitStatuses: async (): Promise<{
			kind: "ok";
			aggregateState: string | null;
			totalCount: number | null;
			statuses: unknown[];
		}> => ({
			kind: "ok",
			aggregateState: "success",
			totalCount: 0,
			statuses: [],
		}),
		mergePullRequest: async (
			_parsed: unknown,
			options: { expectedHeadSha: string; mergeMethod: string },
		): Promise<MergeWriteOutcome> => {
			mergeWrites.push({ expectedHeadSha: options.expectedHeadSha, mergeMethod: options.mergeMethod });
			remote.merged = true;
			return { kind: "merged", mergeCommitSha: MERGE_COMMIT };
		},
	};

	const registry = new PrConsumerRegistry({ now: () => Date.now() });
	const mergeCompletionDeps: PrMergeCompletionDeps = {
		store,
		getTaskCard: async () => ({ card, columnId: "review" }),
		isTaskWriterActive: async () => false,
		completeTask: async (workspaceId: string, taskId: string) => {
			completeTaskCalls.push({ workspaceId, taskId });
			return [SUCCESSOR_ID];
		},
		dispatchSuccessors: async (workspaceId: string, taskId: string, readyTaskIds: string[]) => {
			dispatchCalls.push({ workspaceId, taskId, readyTaskIds });
		},
		inspectWorktree: async () => ({
			worktreePath: null,
			worktreeHead: null,
			baseSha: BASE_SHA,
			baseContainsMerge: true,
			dirty: false,
			aheadOfBase: 0,
		}),
		warn: (message: string) => {
			warnings.push(message);
		},
	};
	// Merge-completion consumer: the ONLY path that moves the task to Done.
	registerMergeCompletionConsumer(registry, mergeCompletionDeps);

	const coordinator = createPrTrackingCoordinator({
		adapter: fakeAdapter as unknown as GitHubGhAdapter,
		store,
		consumerRegistry: registry,
		listManagedWorkspaceBoards: async () => boards,
		now: () => Date.now(),
		random: () => 0,
		schedulerLockRequest: {
			path: join(root, "scheduler"),
			type: "directory",
			lockfilePath: join(root, "scheduler", ".scheduler.lock"),
		},
		logError: (message: string) => {
			warnings.push(message);
		},
	});

	const executor = createAutoMergeExecutor({
		store,
		getCoordinator: () => coordinator,
		getTaskCard: async () => ({ card, columnId: "review" }),
		listBoards: async () => boards,
		loadPolicy: async () => POLICY,
		isTaskWriterActive: () => false,
		adapter: fakeAdapter as unknown as GitHubGhAdapter,
		warn: (message: string) => {
			warnings.push(message);
		},
		now: () => Date.now(),
	});

	// AM-3 consumer: eligibility evaluation + handoff to the AM-4 executor.
	// Like production, the handoff is fire-and-forget: the executor runs off
	// the poll cycle so its confirm reads never coalesce onto (and block)
	// the in-flight poll that delivered the observation.
	registerAutoMergeConsumer(registry, {
		store,
		getCoordinator: () => coordinator,
		getTaskCard: async () => ({ card, columnId: "review" }),
		listBoards: async () => boards,
		loadPolicy: async () => POLICY,
		isTaskWriterActive: () => false,
		onEligible: (handoff) => {
			void executor.execute(handoff).catch(() => undefined);
		},
		warn: (message: string) => {
			warnings.push(message);
		},
		now: () => Date.now(),
	});

	return {
		coordinator,
		store,
		remote,
		mergeWrites,
		completeTaskCalls,
		dispatchCalls,
		warnings,
	};
}

let root: string;
let home: string;
let homeBackup: string | undefined;
let userBackup: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "am5-e2e-"));
	mkdirSync(join(root, "scheduler"));
	home = mkdtempSync(join(tmpdir(), "am5-e2e-home-"));
	homeBackup = process.env.HOME;
	userBackup = process.env.USERPROFILE;
	process.env.HOME = home;
	if (process.platform === "win32") {
		process.env.USERPROFILE = home;
	}
	vi.useFakeTimers();
	vi.setSystemTime(BASE_TIME);
});

afterEach(async () => {
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	if (homeBackup === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = homeBackup;
	}
	if (userBackup === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = userBackup;
	}
});

/** Flush pending async work (real fs I/O) without crossing a poll boundary. */
async function settle(iterations = 120): Promise<void> {
	for (let i = 0; i < iterations; i += 1) {
		await vi.advanceTimersByTimeAsync(25);
	}
}

/** Advance one poll interval and let the resulting cycle complete. */
async function pollOnce(): Promise<void> {
	await vi.advanceTimersByTimeAsync(POLL_MS);
	await settle();
}

/**
 * Poll a probe (advancing the fake clock in settle windows) until it passes
 * or the budget of settle windows is exhausted. Background work (e.g. the
 * fire-and-forget executor job) only makes progress on these windows.
 */
async function waitUntil(probe: () => Promise<boolean>, maxSettles = 40): Promise<boolean> {
	for (let i = 0; i < maxSettles; i += 1) {
		await settle();
		if (await probe()) {
			return true;
		}
	}
	return probe();
}

function findBinding(record: GitHubPrTrackingRecord): GitHubPrTaskBinding | undefined {
	return record.taskBindings.find((item) => item.workspaceId === WORKSPACE_ID && item.taskId === TASK_ID);
}

function descriptor(overrides: Partial<PrTrackingSubscriptionDescriptor> = {}): PrTrackingSubscriptionDescriptor {
	return {
		workspaceId: WORKSPACE_ID,
		taskId: TASK_ID,
		canonicalPrKey: PR_KEY,
		column: "review",
		consumers: { comments: false, mergeCompletion: true, autoMerge: true },
		...overrides,
	};
}

describe("AM-5: full auto-merge lifecycle (fake GitHub)", () => {
	it("poll -> eligibility -> fenced merge -> remote confirmation -> task Done -> successor release", async () => {
		const harness = makeHarness(root);
		const coordinator = harness.coordinator;
		try {
			expect((await coordinator.addSubscription(descriptor())).status).toBe("active");

			// Poll 1: the PR is open. The auto-merge consumer evaluates the
			// fresh evidence (approved + green "ci"), becomes eligible and
			// hands off to the executor, which performs the single fenced
			// merge write and confirms it remotely.
			await pollOnce();
			expect(harness.remote.merged).toBe(true);
			expect(harness.mergeWrites).toEqual([{ expectedHeadSha: HEAD_SHA, mergeMethod: "squash" }]);

			// The executor runs off the poll cycle (like production); wait for
			// its background job to finish the remote confirmation.
			const confirmed = await waitUntil(async () => {
				const loaded = await harness.store.loadRecord(PR_KEY);
				return loaded.ok && findBinding(loaded.record)?.autoMergeAttempt?.state === "merged_confirmed";
			});
			expect(confirmed).toBe(true);

			const first = await harness.store.loadRecord(PR_KEY);
			expect(first.ok).toBe(true);
			if (!first.ok) {
				return;
			}
			const binding1 = findBinding(first.record);
			expect(binding1?.autoMergeAttempt?.state).toBe("merged_confirmed");
			expect(binding1?.autoMergeAttempt?.mergeCommitSha).toBe(MERGE_COMMIT);
			// The eligibility summary was persisted with the fresh facts.
			expect(binding1?.autoMerge?.kind).toBe("eligible");
			// The executor NEVER moves the task itself: no merge completion
			// binding yet.
			expect(binding1?.mergeCompletion).toBeNull();
			// The poll's own snapshot was still "open", so the merge-completion
			// consumer has not moved the task yet.
			expect(harness.completeTaskCalls).toHaveLength(0);

			// Poll 2: the fresh metadata read sees merged. The merge-completion
			// consumer (the only task-mover) completes the task and releases
			// the successors only AFTER the completion is persisted.
			await pollOnce();
			expect(harness.completeTaskCalls).toEqual([{ workspaceId: WORKSPACE_ID, taskId: TASK_ID }]);
			expect(harness.dispatchCalls).toEqual([
				{ workspaceId: WORKSPACE_ID, taskId: TASK_ID, readyTaskIds: [SUCCESSOR_ID] },
			]);
			const second = await harness.store.loadRecord(PR_KEY);
			expect(second.ok).toBe(true);
			if (!second.ok) {
				return;
			}
			const binding2 = findBinding(second.record);
			expect(binding2?.mergeCompletion?.status).toBe("completed");
			expect(binding2?.mergeCompletion?.mergeCommitSha).toBe(MERGE_COMMIT);
			expect(binding2?.terminalStop?.reason).toBe("merged_completed");

			// Poll 3: idempotency — never a second merge write.
			await pollOnce();
			expect(harness.mergeWrites).toHaveLength(1);

			// No warnings on the happy path (a warning here would indicate a
			// silently retried step the test above should have surfaced).
			expect(harness.warnings).toEqual([]);
		} finally {
			await coordinator.stop();
			await settle();
		}
	});
});
