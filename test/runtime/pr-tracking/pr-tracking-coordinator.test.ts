import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	GitHubPrMetadataSnapshot,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskPullRequest,
} from "../../../src/core/api-contract";
import type {
	AccessScope,
	AccessScopeResult,
	FeedbackReadResult,
	GhAdapterFailure,
	GitHubGhAdapter,
	MetadataReadResult,
} from "../../../src/pr-tracking/github-gh-adapter";
import { prKeyDigest } from "../../../src/pr-tracking/pr-identity";
import { PrRecordStore, type PrRecordStoreOptions } from "../../../src/pr-tracking/pr-record-store";
import { normalizePrMetadata } from "../../../src/pr-tracking/pr-snapshots";
import {
	createPrTrackingCoordinator,
	type PrTrackingCoordinator,
	type PrTrackingSubscriptionDescriptor,
} from "../../../src/pr-tracking/pr-tracking-coordinator";

const BASE_TIME = 1_700_000_000_000;
const POLL_MS = 60_000;

function prLink(number: number): RuntimeTaskPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "cline/kanban",
		number,
		url: `https://github.com/cline/kanban/pull/${number}`,
		source: "manual",
		createdAt: 0,
	};
}

function boardWithCards(cards: Array<{ id: string; column: RuntimeBoardColumnId; pr?: number }>): RuntimeBoardData {
	const byColumn = new Map<RuntimeBoardColumnId, Array<RuntimeBoardData["columns"][number]["cards"][number]>>();
	for (const card of cards) {
		const list = byColumn.get(card.column) ?? [];
		list.push({
			id: card.id,
			title: `task ${card.id}`,
			prompt: `task ${card.id}`,
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 0,
			updatedAt: 0,
			...(card.pr !== undefined ? { pullRequests: [prLink(card.pr)] } : {}),
		});
		byColumn.set(card.column, list);
	}
	return {
		columns: [...byColumn.entries()].map(([id, columnCards]) => ({ id, title: id, cards: columnCards })),
		dependencies: [],
	};
}

function makeMetadata(state: GitHubPrMetadataSnapshot["state"], scopeId: string, number: number): MetadataReadResult {
	return {
		kind: "ok",
		metadata: normalizePrMetadata(
			{
				state: state === "merged" ? "closed" : state,
				merged: state === "merged",
				node_id: `PR_${number}`,
				head: { sha: `head-${number}` },
				base: { ref: "main" },
			},
			scopeId,
			Date.now(),
		),
		nodeId: `PR_${number}`,
		bodyDigest: `digest-${state}-${number}`,
	};
}

interface FakeAdapterConfig {
	scopeResult: AccessScopeResult;
	metadata?: (callIndex: number) => MetadataReadResult;
	metadataGate?: () => Promise<void>;
	list?: (source: "reviews" | "conversationComments" | "inlineComments") => FeedbackReadResult;
	threads?: () => FeedbackReadResult;
}

interface FakeAdapter {
	adapter: GitHubGhAdapter;
	scopeCalls: () => number;
	metadataCalls: () => number;
	metadataCallsFor: (number: number) => number;
	listCalls: () => string[];
	threadCalls: () => number;
}

function makeFakeAdapter(config: FakeAdapterConfig): FakeAdapter {
	const counts = { scope: 0, metadata: [] as number[], lists: [] as string[], threads: 0 };
	const fake = {
		resolveAccessScope: async () => {
			counts.scope += 1;
			return config.scopeResult;
		},
		readPrMetadata: async (parsed: { number: number }, scope: AccessScope): Promise<MetadataReadResult> => {
			counts.metadata.push(parsed.number);
			if (config.metadataGate) {
				await config.metadataGate();
			}
			return (
				config.metadata?.(counts.metadata.length - 1) ?? makeMetadata("open", scope.accessScopeId, parsed.number)
			);
		},
		readRestListSource: async (
			_parsed: unknown,
			_scope: AccessScope,
			source: "reviews" | "conversationComments" | "inlineComments",
		): Promise<FeedbackReadResult> => {
			counts.lists.push(source);
			return config.list?.(source) ?? { kind: "ok", events: [], bodyDigest: "empty" };
		},
		readReviewThreads: async (): Promise<FeedbackReadResult> => {
			counts.threads += 1;
			return config.threads?.() ?? { kind: "ok_threads", threads: new Map() };
		},
	};
	return {
		adapter: fake as unknown as GitHubGhAdapter,
		scopeCalls: () => counts.scope,
		metadataCalls: () => counts.metadata.length,
		metadataCallsFor: (number: number) => counts.metadata.filter((item) => item === number).length,
		listCalls: () => counts.lists,
		threadCalls: () => counts.threads,
	};
}
interface HarnessOptions {
	scope?: AccessScope;
	scopeResult?: AccessScopeResult;
	metadata?: (callIndex: number) => MetadataReadResult;
	metadataGate?: () => Promise<void>;
	list?: (source: "reviews" | "conversationComments" | "inlineComments") => FeedbackReadResult;
	threads?: () => FeedbackReadResult;
	boards?: Array<{ workspaceId: string; board: RuntimeBoardData }>;
	listBoards?: () => Promise<Array<{ workspaceId: string; board: RuntimeBoardData }>>;
	storeRoot?: string;
	schedulerLockPath?: string;
	logError?: (message: string) => void;
}

interface Harness {
	coordinator: PrTrackingCoordinator;
	store: PrRecordStore;
	fake: FakeAdapter;
}

function makeCoordinator(options: HarnessOptions = {}): Harness {
	const scope: AccessScope = options.scope ?? { accessScopeId: "scope-A", login: "alice", tokenSource: "GH_TOKEN" };
	const scopeResult: AccessScopeResult = options.scopeResult ?? { ok: true, scope };
	const fake = makeFakeAdapter({
		scopeResult,
		metadata: options.metadata,
		metadataGate: options.metadataGate,
		list: options.list,
		threads: options.threads,
	});
	const storeRoot = options.storeRoot ?? root;
	const store = new PrRecordStore({ rootPath: storeRoot, now: () => Date.now() } satisfies PrRecordStoreOptions);
	const lockPath = options.schedulerLockPath ?? join(root, "lock-default");
	const coordinator = createPrTrackingCoordinator({
		adapter: fake.adapter,
		store,
		listManagedWorkspaceBoards: options.listBoards ?? (async () => options.boards ?? []),
		now: () => Date.now(),
		random: () => 0,
		schedulerLockRequest: {
			path: lockPath,
			type: "directory" as const,
			lockfilePath: join(lockPath, ".scheduler.lock"),
		},
		...(options.logError ? { logError: options.logError } : {}),
	});
	return { coordinator, store, fake };
}

let root: string;
const coordinators: PrTrackingCoordinator[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kanban-pr-coord-"));
	vi.useFakeTimers();
	vi.setSystemTime(BASE_TIME);
});

afterEach(async () => {
	for (const coordinator of coordinators.splice(0)) {
		await coordinator.stop();
	}
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});

function descriptor(overrides: Partial<PrTrackingSubscriptionDescriptor> = {}): PrTrackingSubscriptionDescriptor {
	return {
		workspaceId: "ws-1",
		taskId: "task-1",
		canonicalPrKey: "github|github.com|cline/kanban|49",
		column: "in_progress",
		consumers: { comments: true, mergeCompletion: false },
		...overrides,
	};
}

/**
 * Flush pending async work (real fs I/O) without crossing a poll boundary.
 * Advances the fake clock in small 25ms steps so proper-lockfile's retry
 * backoff (25ms, faked) can progress when two store operations overlap.
 */
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

function failure(category: GhAdapterFailure["category"], extra: Partial<GhAdapterFailure> = {}): GhAdapterFailure {
	return { category, message: `fake ${category} failure`, at: Date.now(), ...extra };
}

/** Register a coordinator for cleanup in afterEach. */
function track(coordinator: PrTrackingCoordinator): PrTrackingCoordinator {
	coordinators.push(coordinator);
	return coordinator;
}

const PR49 = "github|github.com|cline/kanban|49";

async function readRecordRawFile(storeRoot: string, canonicalPrKey: string): Promise<string> {
	return readFile(join(storeRoot, "prs", `${prKeyDigest(canonicalPrKey)}.json`), "utf8");
}

describe("pr-tracking-coordinator", () => {
	it("deduplicates one PR across workspaces into one poll and one durable record", async () => {
		const harness = makeCoordinator();
		const coordinator = track(harness.coordinator);

		expect((await coordinator.addSubscription(descriptor())).status).toBe("active");
		expect((await coordinator.addSubscription(descriptor({ workspaceId: "ws-2", taskId: "task-2" }))).status).toBe(
			"active",
		);

		await pollOnce();
		expect(harness.fake.metadataCalls()).toBe(1);
		expect(harness.fake.scopeCalls()).toBe(1);

		const record = await harness.store.loadRecord(PR49);
		expect(record.ok).toBe(true);
		if (!record.ok) {
			return;
		}
		expect(record.record.taskBindings).toHaveLength(2);
		expect(record.record.snapshots["scope-A"]?.state).toBe("open");
		expect(record.record.snapshots["scope-A"]?.headSha).toBe("head-49");

		const state1 = coordinator.getSnapshotsForTask("ws-1", "task-1");
		const state2 = coordinator.getSnapshotsForTask("ws-2", "task-2");
		expect(state1?.metadata?.headSha).toBe("head-49");
		expect(state2?.metadata?.headSha).toBe("head-49");
		expect(state1?.isStale).toBe(false);
	});

	it("keeps disjoint access scopes isolated in the shared record and in reads", async () => {
		const sharedRoot = join(root, "shared");
		const scopeB: AccessScope = { accessScopeId: "scope-B", login: "bob", tokenSource: "GH_TOKEN" };
		const coordinatorA = track(
			makeCoordinator({ storeRoot: sharedRoot, schedulerLockPath: join(root, "lock-a") }).coordinator,
		);
		const coordinatorB = track(
			makeCoordinator({
				storeRoot: sharedRoot,
				schedulerLockPath: join(root, "lock-b"),
				scope: scopeB,
				metadata: (_n) => makeMetadata("open", "scope-B", 49),
			}).coordinator,
		);

		expect((await coordinatorA.addSubscription(descriptor())).status).toBe("active");
		await pollOnce();
		// Fully stop the first runtime before the second starts (sequential runtimes).
		await coordinatorA.stop();
		await settle();

		// A second runtime (different access scope) polls the same record.
		expect((await coordinatorB.addSubscription(descriptor({ workspaceId: "ws-2", taskId: "task-2" }))).status).toBe(
			"active",
		);
		await pollOnce();

		const record = await new PrRecordStore({ rootPath: sharedRoot }).loadRecord(PR49);
		expect(record.ok).toBe(true);
		if (!record.ok) {
			return;
		}
		expect(record.record.snapshots["scope-A"]?.headSha).toBe("head-49");
		expect(record.record.snapshots["scope-B"]?.headSha).toBe("head-49");

		expect(coordinatorA.getSnapshotsForTask("ws-1", "task-1")?.metadata?.accessScopeId).toBe("scope-A");
		expect(coordinatorB.getSnapshotsForTask("ws-2", "task-2")?.metadata?.accessScopeId).toBe("scope-B");

		const raw = await readRecordRawFile(sharedRoot, PR49);
		expect(raw).not.toContain("GH_TOKEN");
		expect(raw).not.toContain("alice");
		expect(raw).not.toContain("bob");
	});

	it("retains last state on unchanged conditional reads", async () => {
		const harness = makeCoordinator({
			metadata: (n) => (n === 0 ? makeMetadata("open", "scope-A", 49) : { kind: "not_modified" }),
		});
		const coordinator = track(harness.coordinator);
		expect((await coordinator.addSubscription(descriptor())).status).toBe("active");

		await pollOnce();
		expect(harness.fake.metadataCalls()).toBe(1);
		expect(coordinator.getState().polls[0]?.metadataState).toBe("open");

		await pollOnce();
		expect(harness.fake.metadataCalls()).toBe(2);
		expect(coordinator.getState().polls[0]?.metadataState).toBe("open");
		// Normal cadence resumes: the next poll is ~60s after the second read
		// (bounded tolerance for the fake-clock drift while the cycle settles).
		const nextPollAt = coordinator.getState().polls[0]?.nextPollAt ?? 0;
		expect(nextPollAt).toBeGreaterThanOrEqual(BASE_TIME + 3 * POLL_MS - 10_000);
		expect(nextPollAt).toBeLessThan(BASE_TIME + 3 * POLL_MS + 10_000);
		// The last successful metadata is retained (now older than the staleness
		// window because the second read was not_modified).
		expect(coordinator.getSnapshotsForTask("ws-1", "task-1")?.metadata?.headSha).toBe("head-49");
		expect(coordinator.getSnapshotsForTask("ws-1", "task-1")?.isStale).toBe(true);
	});

	it("resumes polling when a task returns to an active column and picks up a newly selected PR", async () => {
		const harness = makeCoordinator();
		const coordinator = track(harness.coordinator);
		// Inactive tasks never poll.
		expect((await coordinator.addSubscription(descriptor({ column: "backlog" }))).status).toBe("active");
		expect(coordinator.getState().polls.every((poll) => poll.nextPollAt === null)).toBe(true);

		await coordinator.removeSubscription("ws-1", "task-1");
		// Re-register from an active column: polling arms and reads.
		expect((await coordinator.addSubscription(descriptor({ column: "in_progress" }))).status).toBe("active");
		await pollOnce();
		expect(harness.fake.metadataCalls()).toBe(1);

		// Selecting a different PR opens a new demand union.
		expect(
			(
				await coordinator.addSubscription(
					descriptor({
						workspaceId: "ws-1",
						taskId: "task-2",
						canonicalPrKey: "github|github.com|cline/kanban|50",
					}),
				)
			).status,
		).toBe("active");
		await pollOnce();
		expect(harness.fake.metadataCallsFor(50)).toBe(1);
		expect(
			coordinator
				.getState()
				.polls.map((poll) => poll.prKey)
				.sort(),
		).toEqual(["github|github.com|cline/kanban|49", "github|github.com|cline/kanban|50"]);
	});

	it("stops permanently for comments-only tasks when the PR merges", async () => {
		const harness = makeCoordinator({
			metadata: () => makeMetadata("merged", "scope-A", 49),
		});
		const coordinator = track(harness.coordinator);
		expect((await coordinator.addSubscription(descriptor())).status).toBe("active");

		await pollOnce();
		const record = await harness.store.loadRecord(PR49);
		expect(record.ok).toBe(true);
		if (!record.ok) {
			return;
		}
		expect(record.record.taskBindings[0]?.terminalStop?.reason).toBe("no_enabled_consumers");
		expect(coordinator.getState().polls[0]?.nextPollAt).toBeNull();

		// No further remote reads on later ticks.
		await pollOnce();
		await pollOnce();
		expect(harness.fake.metadataCalls()).toBe(1);
	});

	it("coalesces an explicit refresh onto the in-flight poll", async () => {
		const gateState: { release: (() => void) | null } = { release: null };
		const gate = new Promise<void>((resolve) => {
			gateState.release = resolve;
		});
		const harness = makeCoordinator({ metadataGate: () => gate });
		const coordinator = track(harness.coordinator);
		expect((await coordinator.addSubscription(descriptor())).status).toBe("active");

		const poll = coordinator.refresh(PR49, "scope-A");
		const refresh = coordinator.refresh(PR49, "scope-A");
		await Promise.resolve(); // let the first cycle start its in-flight read
		expect(harness.fake.metadataCalls()).toBeLessThanOrEqual(1);
		gateState.release?.();
		await Promise.all([poll, refresh]);
		expect(harness.fake.metadataCalls()).toBe(1);
	});

	it("discards transient state when the last subscriber leaves during an in-flight read", async () => {
		const gateState: { release: (() => void) | null } = { release: null };
		const gate = new Promise<void>((resolve) => {
			gateState.release = resolve;
		});
		const harness = makeCoordinator({ metadataGate: () => gate });
		const coordinator = track(harness.coordinator);
		expect((await coordinator.addSubscription(descriptor())).status).toBe("active");

		const poll = coordinator.refresh(PR49, "scope-A");
		// Let the in-flight read progress past its store lock (fake clock
		// advances only in settle steps) so the orphan-marking write below
		// doesn't race it on the registry lock.
		await settle();
		await coordinator.removeSubscription("ws-1", "task-1");
		expect(coordinator.getSnapshotsForTask("ws-1", "task-1")).toBeNull();
		gateState.release?.();
		await poll;
		// The cycle re-validated in-flight consumers: nothing scheduled, no timer.
		expect(coordinator.getState().polls.every((pollState) => pollState.nextPollAt === null)).toBe(true);
		await pollOnce();
		expect(harness.fake.metadataCalls()).toBe(1);

		// The unlinked record is marked orphaned (no managed board links it).
		const record = await harness.store.loadRecord(PR49);
		expect(record.ok).toBe(true);
		if (!record.ok) {
			return;
		}
		expect(record.record.orphanedAt).not.toBeNull();
	});

	it("applies the eligibility table for blockers, unsupported hosts, and disabled consumers", async () => {
		const harness = makeCoordinator();
		const coordinator = track(harness.coordinator);

		// Unsupported host: visible but never reads.
		const unsupported = await coordinator.addSubscription(
			descriptor({ taskId: "task-unsupported", canonicalPrKey: "github|ghe.corp|cline/kanban|49" }),
		);
		expect(unsupported).toEqual({ status: "blocked", blocker: "unsupported_host" });

		// Malformed key: blocked without a record.
		expect(await coordinator.addSubscription(descriptor({ canonicalPrKey: "not-a-key" }))).toEqual({
			status: "blocked",
			blocker: "malformed_key",
		});

		// Both consumers disabled: tracked but stopped, no reads.
		expect(
			(
				await coordinator.addSubscription(
					descriptor({ taskId: "task-off", consumers: { comments: false, mergeCompletion: false } }),
				)
			).status,
		).toBe("active");
		expect(coordinator.getState().subscriptions.find((sub) => sub.taskId === "task-off")?.blocker).toBeNull();
		await pollOnce();
		expect(harness.fake.metadataCalls()).toBe(0);
	});

	it("caps a merged terminal episode at three reads and never re-arms on restart", async () => {
		const harness = makeCoordinator({
			metadata: () => makeMetadata("merged", "scope-A", 49),
		});
		const coordinator = track(harness.coordinator);
		expect(
			(await coordinator.addSubscription(descriptor({ consumers: { comments: false, mergeCompletion: true } })))
				.status,
		).toBe("active");

		await pollOnce(); // reconciliation read 1
		await pollOnce(); // reconciliation read 2
		await pollOnce(); // reconciliation read 3
		await pollOnce(); // budget exhausted: no fourth read, merged_unresolved persisted
		expect(harness.fake.metadataCalls()).toBe(3);

		const record = await harness.store.loadRecord(PR49);
		expect(record.ok).toBe(true);
		if (!record.ok) {
			return;
		}
		expect(record.record.taskBindings[0]?.terminalStop?.reason).toBe("merged_unresolved");
		expect(record.record.taskBindings[0]?.terminalStop?.reconciliationReads).toBe(3);
		expect(coordinator.getState().polls[0]?.nextPollAt).toBeNull();

		// Restart: a fresh coordinator on the same record never re-arms.
		const restarted = track(makeCoordinator({ schedulerLockPath: join(root, "lock-restart") }).coordinator);
		expect(
			(await restarted.addSubscription(descriptor({ consumers: { comments: false, mergeCompletion: true } })))
				.status,
		).toBe("active");
		await pollOnce();
		expect(harness.fake.metadataCalls()).toBe(3);
		expect(restarted.getState().polls.every((poll) => poll.nextPollAt === null)).toBe(true);
	});

	it("backs off through the 60/120/240/480/900s ladder on repeated failures", async () => {
		const callTimes: number[] = [];
		const harness = makeCoordinator({
			metadata: () => {
				callTimes.push(Date.now());
				return { kind: "failed", failure: failure("network") };
			},
		});
		const coordinator = track(harness.coordinator);
		expect((await coordinator.addSubscription(descriptor())).status).toBe("active");

		// First poll uses the normal 60s interval; each failed poll then
		// schedules the 60/120/240/480/900 backoff ladder.
		const advances = [60_000, 60_000, 120_000, 240_000, 480_000, 900_000];
		for (let index = 0; index < advances.length; index += 1) {
			await vi.advanceTimersByTimeAsync(advances[index]);
			await settle();
			expect(harness.fake.metadataCalls()).toBe(index + 1);
			const poll = coordinator.getState().polls[0];
			if (poll) {
				expect(poll.consecutiveFailures).toBe(index + 1);
			}
		}
		// The observed gap between successive reads is the scheduled backoff
		// plus/minus one settle window of fake-clock drift.
		for (let index = 1; index < callTimes.length; index += 1) {
			const gap = callTimes[index] - callTimes[index - 1];
			const expected = advances[index];
			expect(gap).toBeGreaterThanOrEqual(expected);
			expect(gap).toBeLessThanOrEqual(expected + 6_000);
		}
	});

	it("honors the rate-limit reset deadline before backing off", async () => {
		const resetAt = BASE_TIME + 5 * 60 * 60 * 1000;
		const harness = makeCoordinator({
			metadata: () => ({ kind: "failed", failure: failure("rate_limit", { rateLimitResetAt: resetAt }) }),
		});
		const coordinator = track(harness.coordinator);
		expect((await coordinator.addSubscription(descriptor())).status).toBe("active");

		await vi.advanceTimersByTimeAsync(60_000);
		await settle();
		const poll = coordinator.getState().polls[0];
		expect(harness.fake.metadataCalls()).toBe(1);
		if (poll) {
			expect(poll.rateLimitDeadline).toBe(resetAt);
			expect(poll.nextPollAt).toBe(resetAt);
		}
		// Ticks before the reset schedule no further reads.
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(harness.fake.metadataCalls()).toBe(1);
	});

	it("blocks on missing credentials without repeated login attempts", async () => {
		const harness = makeCoordinator({
			scopeResult: { ok: false, failure: failure("auth", { message: "no authenticated GitHub account" }) },
		});
		const coordinator = track(harness.coordinator);

		const first = await coordinator.addSubscription(descriptor());
		expect(first).toEqual({ status: "blocked", blocker: "auth" });
		const second = await coordinator.addSubscription(descriptor({ workspaceId: "ws-2", taskId: "task-2" }));
		expect(second).toEqual({ status: "blocked", blocker: "auth" });
		expect(harness.fake.scopeCalls()).toBe(1);
		expect(coordinator.getState().authBlocker).toBe("no authenticated GitHub account");
		expect(coordinator.getState().subscriptions.every((sub) => sub.blocker === "auth")).toBe(true);
	});

	it("keeps the runtime serving when another process holds the scheduler lock", async () => {
		const lockDir = join(root, "scheduler-lock");
		const first = track(makeCoordinator({ schedulerLockPath: lockDir }).coordinator);
		await first.start();
		await settle();
		expect((await first.addSubscription(descriptor())).status).toBe("active");
		expect(first.getState().schedulerBlocked).toBe(false);
		expect(first.getState().started).toBe(true);

		const errors: string[] = [];
		const second = track(
			makeCoordinator({ schedulerLockPath: lockDir, logError: (message) => errors.push(message) }).coordinator,
		);
		await second.start();
		await settle();
		expect((await second.addSubscription(descriptor({ workspaceId: "ws-2", taskId: "task-2" }))).status).toBe(
			"blocked",
		);
		expect(second.getState().schedulerBlocked).toBe(true);
		expect(second.getState().started).toBe(true);
		expect(errors.some((line) => line.includes("scheduler lock"))).toBe(true);
	});

	it("classifies orphan records on startup: linked records stay, unlinked records age out", async () => {
		const store = new PrRecordStore({ rootPath: root, now: () => Date.now() });
		const linkedKey = "github|github.com|cline/kanban|71";
		const unlinkedKey = "github|github.com|cline/kanban|72";
		const freshKey = "github|github.com|cline/kanban|73";
		await store.createRecord({
			canonicalPrKey: linkedKey,
			provider: "github",
			host: "github.com",
			repository: "cline/kanban",
			number: 71,
		});
		await store.createRecord({
			canonicalPrKey: unlinkedKey,
			provider: "github",
			host: "github.com",
			repository: "cline/kanban",
			number: 72,
		});
		await store.createRecord({
			canonicalPrKey: freshKey,
			provider: "github",
			host: "github.com",
			repository: "cline/kanban",
			number: 73,
		});
		// Pre-age the two unlinked candidates.
		await store.updateRecord(unlinkedKey, undefined, (record) => ({ ...record, orphanedAt: 1 }));
		await store.updateRecord(freshKey, undefined, (record) => ({ ...record, orphanedAt: BASE_TIME - 1000 }));

		const boards: Array<{ workspaceId: string; board: RuntimeBoardData }> = [
			{ workspaceId: "ws-1", board: boardWithCards([{ id: "task-71", column: "in_progress", pr: 71 }]) },
		];
		// Hold the startup pass at the board-listing step so the test never reads
		// the store concurrently with the pass's writes (same lock request).
		const passState: { release: (() => void) | null } = { release: null };
		const passGate = new Promise<void>((resolve) => {
			passState.release = resolve;
		});
		const coordinator = track(
			makeCoordinator({
				listBoards: async () => {
					await passGate;
					return boards;
				},
			}).coordinator,
		);
		await coordinator.start();
		passState.release?.();
		await settle();

		expect((await store.loadRecord(linkedKey)).ok).toBe(true);
		expect(await store.loadRecord(unlinkedKey)).toEqual({ ok: false, reason: "not_found" });
		const fresh = await store.loadRecord(freshKey);
		expect(fresh.ok).toBe(true);
		if (fresh.ok) {
			expect(fresh.record.orphanedAt).toBe(BASE_TIME - 1000);
		}
	});
});
