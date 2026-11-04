import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	AUTO_MERGE_ATTEMPT_SCHEMA_VERSION,
	AUTO_MERGE_EVIDENCE_SCHEMA_VERSION,
	type AutoMergeEvidenceEnvelope,
	type AutoMergePolicy,
	type GitHubPrMetadataSnapshot,
	type GitHubPrTaskIdentity,
	type RuntimeBoardCard,
	type RuntimeBoardColumnId,
} from "../../../src/core/api-contract";
import type { AutoMergeEligibilityHandoff } from "../../../src/pr-tracking/auto-merge-eligibility";
import {
	type AutoMergeExecutionOutcome,
	type AutoMergeExecutor,
	computeAutoMergeAttemptId,
	createAutoMergeExecutor,
} from "../../../src/pr-tracking/auto-merge-executor";
import type { MergeWriteOutcome } from "../../../src/pr-tracking/github-gh-adapter";
import { InMemoryPrRecordStore } from "../../../src/pr-tracking/in-memory-pr-record-store";
import type { PrConsumerObservation } from "../../../src/pr-tracking/pr-consumer-registry";
import { type PrMergeCompletionDeps, reconcileMergeCompletion } from "../../../src/pr-tracking/pr-merge-completion";
import type { PrBoardSnapshot } from "../../../src/pr-tracking/pr-owner-selection";
import type { PrRecordIdentity } from "../../../src/pr-tracking/pr-record-store";
import { reservePrOperation } from "../../../src/pr-tracking/pr-reservations";
import type { OneShotMetadataRefreshResult } from "../../../src/pr-tracking/pr-tracking-coordinator";

const NOW = 1_700_000_000_000;
const HEAD = "headsha1";
const BASE = "basesha1";
const MERGE_COMMIT = "mergesha1";
const PR_KEY = "github|github.com|cline/kanban|49";
const TASK: GitHubPrTaskIdentity = { workspaceId: "ws-1", taskId: "task-1" };
const OTHER_TASK = { workspaceId: "ws-1", taskId: "task-2" };

const RECORD_IDENTITY: PrRecordIdentity = {
	canonicalPrKey: PR_KEY,
	provider: "github",
	host: "github.com",
	repository: "cline/kanban",
	number: 49,
};

const POLICY: AutoMergePolicy = {
	repository: "cline/kanban",
	requiredChecks: ["ci"],
	mergeMethod: "squash",
	revision: 1,
	updatedAt: NOW,
};

function makeMetadata(state: "open" | "merged"): GitHubPrMetadataSnapshot {
	return {
		accessScopeId: "scope-1",
		checkedAt: NOW,
		state,
		headRepository: "cline/kanban",
		headRef: "fix-branch",
		baseRepository: "cline/kanban",
		baseRef: "main",
		headSha: HEAD,
		mergedAt: state === "merged" ? NOW - 1_000 : null,
		mergeCommitSha: state === "merged" ? MERGE_COMMIT : null,
	};
}

function makeEnvelope(overrides: Partial<AutoMergeEvidenceEnvelope> = {}): AutoMergeEvidenceEnvelope {
	return {
		schemaVersion: AUTO_MERGE_EVIDENCE_SCHEMA_VERSION,
		accessScopeId: "scope-1",
		checkedAt: NOW,
		policyRevision: 1,
		headSha: HEAD,
		baseSha: BASE,
		baseRepository: "cline/kanban",
		baseRef: "main",
		headRepository: "cline/kanban",
		headRef: "fix-branch",
		prState: "open",
		draft: false,
		mergeable: true,
		mergeableState: "clean",
		authorLogin: "author",
		autoMergePresent: false,
		sources: {
			prMetadata: true,
			reviews: true,
			checkRuns: true,
			commitStatuses: true,
			reviewThreads: true,
		},
		unresolvedActiveThreads: 0,
		complete: true,
		reasons: [],
		reviews: [
			{
				id: "rev-1",
				state: "APPROVED",
				authorLogin: "reviewer-1",
				authorKind: "human",
				isOwnAccount: false,
				commitId: HEAD,
				submittedAt: NOW - 1_000,
			},
		],
		checks: [
			{
				kind: "check_run",
				name: "ci",
				sourceId: null,
				status: "completed",
				conclusion: "success",
				sha: HEAD,
				runId: "100",
				occurredAt: NOW - 500,
			},
		],
		statuses: [],
		...overrides,
	};
}

function makeCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: TASK.taskId,
		title: "Task 1",
		prompt: "do the thing",
		startInPlanMode: false,
		autoReviewEnabled: false,
		baseRef: "main",
		autoFinishOnMerge: false,
		createdAt: NOW - 2_000_000,
		updatedAt: NOW - 2_000_000,
		autoMergeWhenApproved: true,
		armedAutoMergePolicyRevision: 1,
		pullRequests: [
			{
				provider: "github",
				host: "github.com",
				repository: "cline/kanban",
				number: 49,
				url: "https://github.com/cline/kanban/pull/49",
				source: "agent_tool",
				createdAt: NOW - 1_000_000,
			},
		],
		...overrides,
	};
}

function makeBoard(card: RuntimeBoardCard, columnId: "review" | "in_progress" | "backlog" = "review"): PrBoardSnapshot {
	const columns: Array<{ id: RuntimeBoardColumnId; title: string; cards: RuntimeBoardCard[] }> = [
		{ id: "backlog", title: "Backlog", cards: [] },
		{ id: "in_progress", title: "In Progress", cards: [] },
		{ id: "review", title: "In Review", cards: [] },
		{ id: "done", title: "Done", cards: [] },
		{ id: "trash", title: "Trash", cards: [] },
	];
	columns.find((column) => column.id === columnId)?.cards.push(card);
	return {
		workspaceId: TASK.workspaceId,
		board: { columns, dependencies: [] },
	};
}

function makeHandoff(overrides: Partial<AutoMergeEligibilityHandoff> = {}): AutoMergeEligibilityHandoff {
	return {
		workspaceId: TASK.workspaceId,
		taskId: TASK.taskId,
		canonicalPrKey: PR_KEY,
		headSha: HEAD,
		baseSha: BASE,
		policy: POLICY,
		accessScopeId: "scope-1",
		evaluatedAt: NOW - 1_000,
		...overrides,
	};
}

interface Harness {
	/** Shared fake remote state. */
	remote: { merged: boolean; mergeCommitSha: string | null };
	/** What the evidence re-read returns. */
	envelope: () => AutoMergeEvidenceEnvelope;
	/** What the post-write / reconciliation metadata reads return. */
	metadataOutcome: () => OneShotMetadataRefreshResult;
	/** The scripted merge write response (and its effect on the fake remote). */
	mergeOutcome: () => MergeWriteOutcome;
	/** The live card read. */
	card: () => { card: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null;
	boards: PrBoardSnapshot[];
	policy: AutoMergePolicy | null;
	writerActive: boolean;
	warnings: string[];
	mergeWrites: Array<{ expectedHeadSha: string; mergeMethod: string }>;
	acceptedMerges: number;
	metadataReads: number;
	evidenceReads: number;
	/** Metadata reads completed at the moment the merge write fires (ordering proof). */
	metadataReadsAtWrite: number;
	/** Optional gate awaited DURING the merge write (ordering/race tests). */
	mergeGate?: () => Promise<void>;
	/** Optional hook run before the one-shot metadata read resolves (race tests). */
	metadataHook?: () => Promise<void>;
}

function defaultMetadataOutcome(harness: Harness): OneShotMetadataRefreshResult {
	return harness.remote.merged
		? { outcome: "refreshed", checkedAt: NOW, metadata: makeMetadata("merged"), error: null }
		: { outcome: "refreshed", checkedAt: NOW, metadata: makeMetadata("open"), error: null };
}

/** Narrow an outcome to a reason-carrying variant for assertions. */
function outcomeReason(outcome: AutoMergeExecutionOutcome, action: "waiting" | "needs_attention"): string {
	return outcome.action === action ? outcome.reason : "";
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
	const remote: { merged: boolean; mergeCommitSha: string | null } = { merged: false, mergeCommitSha: null };
	const harness: Harness = {
		remote,
		envelope: () => makeEnvelope(),
		metadataOutcome: () => defaultMetadataOutcome(harness),
		mergeOutcome: () => {
			remote.merged = true;
			remote.mergeCommitSha = MERGE_COMMIT;
			return { kind: "merged", mergeCommitSha: MERGE_COMMIT };
		},
		card: () => ({ card: makeCard(), columnId: "review" }),
		boards: [],
		policy: POLICY,
		writerActive: false,
		warnings: [],
		mergeWrites: [],
		acceptedMerges: 0,
		metadataReads: 0,
		evidenceReads: 0,
		metadataReadsAtWrite: 0,
		...overrides,
	};
	return harness;
}

/** A fresh store with the record, verified head mapping, and the binding. */
async function makeStore(): Promise<InMemoryPrRecordStore> {
	const store = new InMemoryPrRecordStore({ now: () => NOW });
	await store.createRecord(RECORD_IDENTITY);
	await store.setMetadataSnapshot(PR_KEY, makeMetadata("open"));
	await store.upsertTaskBinding(PR_KEY, TASK);
	return store;
}

async function loadBinding(store: InMemoryPrRecordStore) {
	const loaded = await store.loadRecord(PR_KEY);
	if (!loaded.ok) {
		throw new Error("record missing");
	}
	const binding = loaded.record.taskBindings.find(
		(item) => item.workspaceId === TASK.workspaceId && item.taskId === TASK.taskId,
	);
	if (!binding) {
		throw new Error("binding missing");
	}
	return binding;
}

function makeExecutor(store: InMemoryPrRecordStore, harness: Harness): AutoMergeExecutor {
	const coordinator = {
		readAutoMergeEvidence: async (
			_prKey: string,
			_scopeId: string | undefined,
			_options: { policyRevision: number },
		) => {
			harness.evidenceReads += 1;
			return harness.envelope();
		},
		refreshPrMetadataOnce: async (_prKey: string) => {
			harness.metadataReads += 1;
			await harness.metadataHook?.();
			return harness.metadataOutcome();
		},
	};
	const adapter = {
		mergePullRequest: async (_parsed: unknown, options: { expectedHeadSha: string; mergeMethod: string }) => {
			harness.mergeWrites.push({ expectedHeadSha: options.expectedHeadSha, mergeMethod: options.mergeMethod });
			harness.metadataReadsAtWrite = harness.metadataReads;
			harness.acceptedMerges += 1;
			await harness.mergeGate?.();
			return harness.mergeOutcome();
		},
	};
	return createAutoMergeExecutor({
		store,
		getCoordinator: () => coordinator,
		getTaskCard: async () => harness.card(),
		listBoards: async () => harness.boards,
		loadPolicy: async () => harness.policy,
		isTaskWriterActive: () => harness.writerActive,
		adapter,
		warn: (message) => harness.warnings.push(message),
		now: () => NOW,
	});
}

// All tests run against a temporary HOME: the durable stores resolve their
// roots from os.homedir(), so isolate even the in-memory suites.
let home: string;
let homeBackup: string | undefined;
let userBackup: string | undefined;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "am4-executor-"));
	homeBackup = process.env.HOME;
	userBackup = process.env.USERPROFILE;
	process.env.HOME = home;
	if (process.platform === "win32") {
		process.env.USERPROFILE = home;
	}
});

afterEach(() => {
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
	rmSync(home, { recursive: true, force: true });
});

describe("AM-4 auto-merge executor: success path", () => {
	it("merges once with the verified head SHA and policy method, confirms remotely, and journals merged_confirmed", async () => {
		const store = await makeStore();
		const harness = makeHarness();
		const executor = makeExecutor(store, harness);
		const outcome = await executor.execute(makeHandoff());

		expect(outcome).toEqual({ action: "merged_confirmed", mergeCommitSha: MERGE_COMMIT });
		// Exactly one fenced write, pinned to the verified head and policy method.
		expect(harness.mergeWrites).toEqual([{ expectedHeadSha: HEAD, mergeMethod: "squash" }]);
		expect(harness.acceptedMerges).toBe(1);
		// The durable journal landed BEFORE the write (write-ahead marker).
		expect(harness.metadataReadsAtWrite).toBe(0);
		const binding = await loadBinding(store);
		expect(binding.autoMergeAttempt).toMatchObject({
			schemaVersion: AUTO_MERGE_ATTEMPT_SCHEMA_VERSION,
			canonicalPrKey: PR_KEY,
			headSha: HEAD,
			baseSha: BASE,
			policyRevision: 1,
			mergeMethod: "squash",
			state: "merged_confirmed",
			mergeCommitSha: MERGE_COMMIT,
			startedAt: NOW,
			finishedAt: NOW,
		});
		// Confirmation came from a fresh remote read, never the write response.
		expect(harness.metadataReads).toBeGreaterThanOrEqual(1);
		// The reservation is released once the durable outcome is persisted.
		const loaded = await store.loadRecord(PR_KEY);
		expect(loaded.ok).toBe(true);
		if (loaded.ok) {
			expect(loaded.record.reservation.state).toBe("none");
		}
		// The executor never moves the task itself.
		expect(binding.mergeCompletion).toBeNull();
	});

	it("coalesces duplicate handoffs for the same PR onto the in-flight execution", async () => {
		const store = await makeStore();
		const harness = makeHarness();
		const executor = makeExecutor(store, harness);
		const [a, b] = await Promise.all([executor.execute(makeHandoff()), executor.execute(makeHandoff())]);
		expect(a).toEqual({ action: "merged_confirmed", mergeCommitSha: MERGE_COMMIT });
		expect(b).toEqual({ action: "merged_confirmed", mergeCommitSha: MERGE_COMMIT });
		expect(harness.mergeWrites.length).toBe(1);
	});

	it("is idempotent after a confirmed merge: a later handoff never re-writes", async () => {
		const store = await makeStore();
		const harness = makeHarness();
		const executor = makeExecutor(store, harness);
		await expect(executor.execute(makeHandoff())).resolves.toEqual({
			action: "merged_confirmed",
			mergeCommitSha: MERGE_COMMIT,
		});
		// A fresh executor (process restart) against the same store.
		const executor2 = makeExecutor(store, harness);
		await expect(executor2.execute(makeHandoff())).resolves.toEqual({ action: "skipped", reason: "already_merged" });
		expect(harness.mergeWrites.length).toBe(1);
	});
});
describe("AM-4 auto-merge executor: precondition drift never writes", () => {
	it.each([
		[
			"failed CI",
			() =>
				makeEnvelope({
					checks: [
						{
							kind: "check_run",
							name: "ci",
							sourceId: null,
							status: "completed",
							conclusion: "failure",
							sha: HEAD,
							runId: "100",
							occurredAt: NOW - 500,
						},
					],
				}),
			"check_failed",
		],
		["withdrawn approval", () => makeEnvelope({ reviews: [] }), "no_approval"],
		["stale evidence", () => makeEnvelope({ checkedAt: NOW - 60 * 60 * 1000 }), "evidence_stale"],
		[
			"incomplete evidence",
			() => makeEnvelope({ complete: false, reasons: ["check_runs_incomplete"] }),
			"evidence_incomplete",
		],
		["PR closed", () => makeEnvelope({ prState: "closed" }), "pr_closed"],
		["PR turns draft", () => makeEnvelope({ draft: true }), "pr_draft"],
		["native auto-merge present", () => makeEnvelope({ autoMergePresent: true }), "native_auto_merge"],
	])("no merge write when %s", async (_label, envelope, expectedCode) => {
		const store = await makeStore();
		const harness = makeHarness({ envelope });
		const executor = makeExecutor(store, harness);
		const outcome = await executor.execute(makeHandoff());
		expect(outcome.action).toBe("waiting");
		expect(outcomeReason(outcome, "waiting")).toContain(expectedCode);
		expect(harness.mergeWrites.length).toBe(0);
		const binding = await loadBinding(store);
		expect(binding.autoMergeAttempt ?? null).toBeNull();
	});

	it("no merge write when the head SHA shifted between the handoff and the write", async () => {
		const store = await makeStore();
		const harness = makeHarness({
			envelope: () =>
				makeEnvelope({
					headSha: "headsha2",
					reviews: [
						{
							id: "rev-1",
							state: "APPROVED",
							authorLogin: "reviewer-1",
							authorKind: "human",
							isOwnAccount: false,
							commitId: "headsha2",
							submittedAt: NOW - 1_000,
						},
					],
					checks: [
						{
							kind: "check_run",
							name: "ci",
							sourceId: null,
							status: "completed",
							conclusion: "success",
							sha: "headsha2",
							runId: "101",
							occurredAt: NOW - 500,
						},
					],
				}),
		});
		const executor = makeExecutor(store, harness);
		const outcome = await executor.execute(makeHandoff());
		// The fresh evaluation may be green at the NEW identity, but the
		// immutable evidence identity shifted: never write on a shifted head.
		expect(outcome.action).toBe("waiting");
		expect(harness.mergeWrites.length).toBe(0);
	});

	it("no merge write when the task disarms auto-merge before the write", async () => {
		const store = await makeStore();
		const harness = makeHarness({
			card: () => ({ card: makeCard({ autoMergeWhenApproved: false }), columnId: "review" }),
		});
		const executor = makeExecutor(store, harness);
		await expect(executor.execute(makeHandoff())).resolves.toEqual({ action: "waiting", reason: "disabled" });
		expect(harness.mergeWrites.length).toBe(0);
	});

	it("no merge write when the armed policy revision no longer matches", async () => {
		const store = await makeStore();
		const harness = makeHarness({ policy: { ...POLICY, revision: 2, updatedAt: NOW } });
		const executor = makeExecutor(store, harness);
		const outcome = await executor.execute(makeHandoff());
		expect(outcome.action).toBe("needs_attention");
		expect(outcomeReason(outcome, "needs_attention")).toContain("policy_mismatch");
		expect(harness.mergeWrites.length).toBe(0);
	});

	it("no merge write while a live writer owns the task", async () => {
		const store = await makeStore();
		const harness = makeHarness({ writerActive: true });
		const executor = makeExecutor(store, harness);
		const outcome = await executor.execute(makeHandoff());
		expect(outcome.action).toBe("waiting");
		expect(outcomeReason(outcome, "waiting")).toContain("writer_active");
		expect(harness.mergeWrites.length).toBe(0);
	});

	it("no merge write while another task claims this PR", async () => {
		const store = await makeStore();
		const otherCard = makeCard({ id: OTHER_TASK.taskId });
		const harness = makeHarness({ boards: [makeBoard(makeCard()), makeBoard(otherCard)] });
		const executor = makeExecutor(store, harness);
		const outcome = await executor.execute(makeHandoff());
		expect(outcome.action).toBe("waiting");
		expect(outcomeReason(outcome, "waiting")).toContain("ambiguous_claim");
		expect(harness.mergeWrites.length).toBe(0);
	});

	it("no merge write while comment repair dispatch is active", async () => {
		const store = await makeStore();
		const harness = makeHarness();
		await store.updateRecord(PR_KEY, undefined, (record) => ({
			...record,
			commentAutomation: {
				...record.commentAutomation,
				dispatch: {
					dispatchId: "dispatch-1",
					attemptedAt: null,
					fingerprint: { digest: "fp", latestUpdatedAt: NOW - 1_000, tokensAtWatermark: ["t1"] },
					ownerRevision: 1,
					status: "running",
					turnReference: null,
					error: null,
				},
			},
		}));
		const executor = makeExecutor(store, harness);
		const outcome = await executor.execute(makeHandoff());
		expect(outcome.action).toBe("waiting");
		expect(outcomeReason(outcome, "waiting")).toContain("comment_repair_pending");
		expect(harness.mergeWrites.length).toBe(0);
	});

	it("no merge write when the task leaves the board", async () => {
		const store = await makeStore();
		const harness = makeHarness({ card: () => null });
		const executor = makeExecutor(store, harness);
		await expect(executor.execute(makeHandoff())).resolves.toEqual({ action: "waiting", reason: "no_task" });
		expect(harness.mergeWrites.length).toBe(0);
	});
});

describe("AM-4 auto-merge executor: write outcomes are classified, never guessed", () => {
	it.each([
		[
			"GitHub 409 (head moved)",
			() => ({ kind: "rejected" as const, status: 409, detail: "head moved" }),
			"waiting",
			"head_moved:github_409",
		],
		[
			"GitHub 405 (merge conflicts)",
			() => ({ kind: "rejected" as const, status: 405, detail: "merge conflict" }),
			"waiting",
			"merge_conflicts:github_405",
		],
		[
			"GitHub 403 (permission)",
			() => ({ kind: "rejected" as const, status: 403, detail: "no access" }),
			"needs_attention",
			"github_denied:http_403",
		],
		[
			"GitHub 451 (ruleset)",
			() => ({ kind: "rejected" as const, status: 451, detail: "ruleset" }),
			"needs_attention",
			"github_denied:http_451",
		],
		[
			"GitHub 422 (validation)",
			() => ({ kind: "rejected" as const, status: 422, detail: "invalid merge method" }),
			"needs_attention",
			"validation_rejected:github_422",
		],
		[
			"adapter timeout",
			() => ({
				kind: "failed" as const,
				failure: { category: "timeout" as const, message: "request timed out", at: NOW },
			}),
			"waiting",
			"merge_call_failed:timeout",
		],
		[
			"adapter auth failure",
			() => ({
				kind: "failed" as const,
				failure: { category: "auth" as const, message: "bad credentials", at: NOW },
			}),
			"needs_attention",
			"merge_call_failed:auth",
		],
		[
			"adapter network failure",
			() => ({ kind: "failed" as const, failure: { category: "network" as const, message: "boom", at: NOW } }),
			"waiting",
			"merge_call_failed:network",
		],
		[
			"adapter rate limit (secondary throttle)",
			() => ({
				kind: "failed" as const,
				failure: { category: "rate_limit" as const, message: "secondary rate limit", at: NOW },
			}),
			"waiting",
			"merge_call_failed:rate_limit",
		],
	])("classifies %s and persists the durable outcome", async (_label, outcome, expectedAction, expectedReason) => {
		const store = await makeStore();
		const harness = makeHarness({ mergeOutcome: outcome });
		const executor = makeExecutor(store, harness);
		const result = await executor.execute(makeHandoff());
		expect(result.action).toBe(expectedAction);
		expect(outcomeReason(result, expectedAction as "waiting" | "needs_attention")).toBe(expectedReason);
		expect(harness.mergeWrites.length).toBe(1);
		// The PR is confirmed still open on the fake remote: the outcome
		// state is durable, and the reservation is released.
		const binding = await loadBinding(store);
		expect(binding.autoMergeAttempt?.state).toBe(expectedAction);
		expect(binding.autoMergeAttempt?.mergeCommitSha ?? null).toBeNull();
		const loaded = await store.loadRecord(PR_KEY);
		expect(loaded.ok).toBe(true);
		if (loaded.ok) {
			expect(loaded.record.reservation.state).toBe("none");
		}
	});

	it("keeps the journal `attempting` when the remote state is unresolved after the write (no blind retry)", async () => {
		const store = await makeStore();
		const harness = makeHarness({
			metadataOutcome: () => ({ outcome: "failed", checkedAt: null, metadata: null, error: "network down" }),
		});
		const executor = makeExecutor(store, harness);
		const result = await executor.execute(makeHandoff());
		expect(result.action).toBe("waiting");
		expect(harness.mergeWrites.length).toBe(1);
		const binding = await loadBinding(store);
		expect(binding.autoMergeAttempt?.state).toBe("attempting");
		expect(binding.autoMergeAttempt?.mergeCommitSha ?? null).toBeNull();
	});
});

describe("AM-4 auto-merge executor: serialization against other consumers", () => {
	it("waits while a merge_completion reservation is held, without releasing it", async () => {
		const store = await makeStore();
		const otherResult = await reservePrOperation(store, PR_KEY, "merge_completion", OTHER_TASK, {
			requireOwner: false,
			now: () => NOW,
		});
		expect(otherResult.status).toBe("reserved");
		const harness = makeHarness();
		const executor = makeExecutor(store, harness);
		const result = await executor.execute(makeHandoff());
		expect(result.action).toBe("waiting");
		expect(outcomeReason(result, "waiting")).toContain("busy");
		expect(harness.mergeWrites.length).toBe(0);
		const loaded = await store.loadRecord(PR_KEY);
		expect(loaded.ok).toBe(true);
		if (loaded.ok) {
			// The executor did not disturb the held reservation.
			expect(loaded.record.reservation.state).toBe("reserved");
			expect(loaded.record.reservation.reservedBy).toEqual(OTHER_TASK);
		}
	});

	it("the merge-completion consumer can reserve after the auto_merge write finishes", async () => {
		const store = await makeStore();
		const harness = makeHarness();
		const executor = makeExecutor(store, harness);
		const result = await executor.execute(makeHandoff());
		expect(result.action).toBe("merged_confirmed");
		const otherResult = await reservePrOperation(store, PR_KEY, "merge_completion", OTHER_TASK, {
			requireOwner: false,
			now: () => NOW,
		});
		expect(otherResult.status).toBe("reserved");
	});
});
describe("AM-4 auto-merge executor: startup crash recovery reads the remote first", () => {
	it("recovers a crash between the accepted write and the outcome write as merged_confirmed — never re-writes", async () => {
		const store = await makeStore();
		const harness = makeHarness();
		const executor = makeExecutor(store, harness);
		// Simulate a crash: a durable `attempting` journal with no outcome,
		// and GitHub already merged the PR.
		const before = await loadBinding(store);
		expect(before.autoMergeAttempt ?? null).toBeNull();
		await store.setAutoMergeAttempt(PR_KEY, TASK, {
			schemaVersion: AUTO_MERGE_ATTEMPT_SCHEMA_VERSION,
			attemptId: computeAutoMergeAttemptId(PR_KEY, HEAD, BASE, 1),
			canonicalPrKey: PR_KEY,
			headSha: HEAD,
			baseSha: BASE,
			policyRevision: 1,
			mergeMethod: "squash",
			startedAt: NOW - 5_000,
			state: "attempting",
			reason: null,
			mergeCommitSha: null,
			finishedAt: null,
		});
		harness.remote.merged = true;
		harness.remote.mergeCommitSha = MERGE_COMMIT;
		await executor.reconcilePending();
		expect(harness.mergeWrites.length).toBe(0);
		const after = await loadBinding(store);
		expect(after.autoMergeAttempt?.state).toBe("merged_confirmed");
		expect(after.autoMergeAttempt?.mergeCommitSha).toBe(MERGE_COMMIT);
		// startedAt survives reconciliation (the first attempt time wins).
		expect(after.autoMergeAttempt?.startedAt).toBe(NOW - 5_000);
	});

	it("demotes a stale `attempting` attempt to `waiting` when GitHub confirms the PR is still open", async () => {
		const store = await makeStore();
		const harness = makeHarness();
		const executor = makeExecutor(store, harness);
		await store.setAutoMergeAttempt(PR_KEY, TASK, {
			schemaVersion: AUTO_MERGE_ATTEMPT_SCHEMA_VERSION,
			attemptId: computeAutoMergeAttemptId(PR_KEY, HEAD, BASE, 1),
			canonicalPrKey: PR_KEY,
			headSha: HEAD,
			baseSha: BASE,
			policyRevision: 1,
			mergeMethod: "squash",
			startedAt: NOW - 5_000,
			state: "attempting",
			reason: null,
			mergeCommitSha: null,
			finishedAt: null,
		});
		await executor.reconcilePending();
		expect(harness.mergeWrites.length).toBe(0);
		const after = await loadBinding(store);
		expect(after.autoMergeAttempt?.state).toBe("waiting");
		expect(after.autoMergeAttempt?.mergeCommitSha ?? null).toBeNull();
	});

	it("leaves an unresolved attempt `attempting` (blocked) until a later reconciliation", async () => {
		const store = await makeStore();
		const harness = makeHarness({
			metadataOutcome: () => ({ outcome: "failed", checkedAt: null, metadata: null, error: "network down" }),
		});
		const executor = makeExecutor(store, harness);
		await store.setAutoMergeAttempt(PR_KEY, TASK, {
			schemaVersion: AUTO_MERGE_ATTEMPT_SCHEMA_VERSION,
			attemptId: computeAutoMergeAttemptId(PR_KEY, HEAD, BASE, 1),
			canonicalPrKey: PR_KEY,
			headSha: HEAD,
			baseSha: BASE,
			policyRevision: 1,
			mergeMethod: "squash",
			startedAt: NOW - 5_000,
			state: "attempting",
			reason: null,
			mergeCommitSha: null,
			finishedAt: null,
		});
		await executor.reconcilePending();
		expect(harness.mergeWrites.length).toBe(0);
		const after = await loadBinding(store);
		expect(after.autoMergeAttempt?.state).toBe("attempting");
	});
});
describe("AM-4 auto-merge executor: startup reconciliation serializes with live executions", () => {
	it("never drops a live execution's fence: reconcile and execute serialize per-PR", async () => {
		const store = await makeStore();
		// Simulate a crash: a durable `attempting` journal; GitHub has NOT
		// merged (the fake remote starts open).
		const attemptId = computeAutoMergeAttemptId(PR_KEY, HEAD, BASE, 1);
		await store.setAutoMergeAttempt(PR_KEY, TASK, {
			schemaVersion: AUTO_MERGE_ATTEMPT_SCHEMA_VERSION,
			attemptId,
			canonicalPrKey: PR_KEY,
			headSha: HEAD,
			baseSha: BASE,
			policyRevision: 1,
			mergeMethod: "squash",
			startedAt: NOW - 5_000,
			state: "attempting",
			reason: null,
			mergeCommitSha: null,
			finishedAt: null,
		});
		// Gate the merge write and capture the reservation state AT THE WRITE.
		let releasePut: () => void = () => {};
		const putGate = new Promise<void>((resolve) => {
			releasePut = resolve;
		});
		const reservationAtWrite: Array<{
			state: "none" | "reserved";
			reservedBy: { workspaceId: string; taskId: string } | null;
		}> = [];
		const harness = makeHarness({
			// Gate the write: capture the reservation state AT THE WRITE, then
			// hold the write until released.
			mergeGate: async () => {
				const rec = await store.loadRecord(PR_KEY);
				if (rec.ok) {
					reservationAtWrite.push({
						state: rec.record.reservation.state,
						reservedBy: rec.record.reservation.reservedBy,
					});
				}
				await putGate;
			},
		});
		const executor = makeExecutor(store, harness);
		// Startup reconcile and the first poll's handoff race: the reconcile
		// (queued first) must fully finish, fence released, before the
		// execution runs — never the other way around.
		const reconcile = executor.reconcilePending();
		const execution = executor.execute(makeHandoff());
		// Wait until the gated PUT is reached (the execution is in flight).
		while (reservationAtWrite.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		// The fence must be HELD by the execution at the write — the old
		// unfenced reconcile used to release it mid-write.
		expect(reservationAtWrite[0]?.state).toBe("reserved");
		expect(reservationAtWrite[0]?.reservedBy).toEqual(TASK);
		releasePut();
		const outcome = await execution;
		await reconcile;
		expect(outcome.action).toBe("merged_confirmed");
		expect(harness.mergeWrites.length).toBe(1);
		const after = await loadBinding(store);
		expect(after.autoMergeAttempt?.state).toBe("merged_confirmed");
		expect(after.autoMergeAttempt?.startedAt).toBe(NOW - 5_000);
		const final = await store.loadRecord(PR_KEY);
		expect(final.ok).toBe(true);
		if (final.ok) {
			expect(final.record.reservation.state).toBe("none");
		}
	});

	it("does not clobber a journal entry replaced after the reconcile read (conditional write)", async () => {
		const store = await makeStore();
		const seededId = computeAutoMergeAttemptId(PR_KEY, HEAD, BASE, 1);
		await store.setAutoMergeAttempt(PR_KEY, TASK, {
			schemaVersion: AUTO_MERGE_ATTEMPT_SCHEMA_VERSION,
			attemptId: seededId,
			canonicalPrKey: PR_KEY,
			headSha: HEAD,
			baseSha: BASE,
			policyRevision: 1,
			mergeMethod: "squash",
			startedAt: NOW - 5_000,
			state: "attempting",
			reason: null,
			mergeCommitSha: null,
			finishedAt: null,
		});
		// A racing (serialized, later) execution re-journaled a NEW evidence
		// identity while the reconcile read is in flight: the reconcile must
		// not overwrite it.
		const newerId = computeAutoMergeAttemptId(PR_KEY, "headsha2", "basesha2", 2);
		const harness = makeHarness({
			// A racing (serialized, later) execution re-journaled a NEW evidence
			// identity while the reconcile read is in flight: the reconcile
			// must not overwrite it.
			metadataHook: async () => {
				await store.setAutoMergeAttempt(PR_KEY, TASK, {
					schemaVersion: AUTO_MERGE_ATTEMPT_SCHEMA_VERSION,
					attemptId: newerId,
					canonicalPrKey: PR_KEY,
					headSha: "headsha2",
					baseSha: "basesha2",
					policyRevision: 2,
					mergeMethod: "squash",
					startedAt: NOW - 1_000,
					state: "attempting",
					reason: null,
					mergeCommitSha: null,
					finishedAt: null,
				});
			},
			metadataOutcome: () => ({ outcome: "refreshed", checkedAt: NOW, metadata: makeMetadata("open"), error: null }),
		});
		const executor = makeExecutor(store, harness);
		await executor.reconcilePending();
		const after = await loadBinding(store);
		// The newer entry survives: the reconcile saw the seeded entry, its
		// conditional CAS no longer matched, and nothing was written.
		expect(after.autoMergeAttempt?.attemptId).toBe(newerId);
		expect(after.autoMergeAttempt?.state).toBe("attempting");
		const final = await store.loadRecord(PR_KEY);
		expect(final.ok).toBe(true);
		if (final.ok) {
			expect(final.record.reservation.state).toBe("none");
		}
	});
});
describe("AM-4 auto-merge executor: rejection resilience (no unhandled rejections, no cascade)", () => {
	it("a rejected execution settles cleanly and a later handoff re-executes fresh", async () => {
		const store = await makeStore();
		let first = true;
		const harness = makeHarness({
			card: () => {
				if (first) {
					first = false;
					throw new Error("board read exploded");
				}
				return { card: makeCard(), columnId: "review" };
			},
		});
		const executor = makeExecutor(store, harness);
		// The in-flight execution rejects (store/board calls have no
		// catch-all). The derived cleanup promises must not reject
		// unhandled, and the coalescing map must clear.
		const firstRun = executor.execute(makeHandoff());
		await expect(firstRun).rejects.toThrow("board read exploded");
		// A later handoff runs a FRESH execution (not the stale rejected
		// promise) and succeeds.
		const result = await executor.execute(makeHandoff());
		expect(result).toEqual({ action: "merged_confirmed", mergeCommitSha: MERGE_COMMIT });
		expect(harness.mergeWrites.length).toBe(1);
		const loaded = await store.loadRecord(PR_KEY);
		expect(loaded.ok).toBe(true);
		if (loaded.ok) {
			expect(loaded.record.reservation.state).toBe("none");
		}
	});

	it("a failed reconciliation does not cascade into a queued execution or abort the loop", async () => {
		const store = await makeStore();
		// PR 1: a durable `attempting` journal whose record read throws
		// (simulated lock timeout) — reconcileOne rejects.
		const attemptId = computeAutoMergeAttemptId(PR_KEY, HEAD, BASE, 1);
		await store.setAutoMergeAttempt(PR_KEY, TASK, {
			schemaVersion: AUTO_MERGE_ATTEMPT_SCHEMA_VERSION,
			attemptId,
			canonicalPrKey: PR_KEY,
			headSha: HEAD,
			baseSha: BASE,
			policyRevision: 1,
			mergeMethod: "squash",
			startedAt: NOW - 5_000,
			state: "attempting",
			reason: null,
			mergeCommitSha: null,
			finishedAt: null,
		});
		// PR 2: a plain `attempting` journal that must still be reconciled
		// even though PR 1's reconciliation rejects.
		const OTHER_PR_KEY = "github|github.com|cline/kanban|50";
		await store.createRecord({
			canonicalPrKey: OTHER_PR_KEY,
			provider: "github",
			host: "github.com",
			repository: "cline/kanban",
			number: 50,
		});
		await store.setMetadataSnapshot(OTHER_PR_KEY, makeMetadata("open"));
		await store.upsertTaskBinding(OTHER_PR_KEY, TASK);
		await store.setAutoMergeAttempt(OTHER_PR_KEY, TASK, {
			schemaVersion: AUTO_MERGE_ATTEMPT_SCHEMA_VERSION,
			attemptId: computeAutoMergeAttemptId(OTHER_PR_KEY, HEAD, BASE, 1),
			canonicalPrKey: OTHER_PR_KEY,
			headSha: HEAD,
			baseSha: BASE,
			policyRevision: 1,
			mergeMethod: "squash",
			startedAt: NOW - 5_000,
			state: "attempting",
			reason: null,
			mergeCommitSha: null,
			finishedAt: null,
		});
		// Only the FIRST record read of PR 1 throws (reconcile's read); the
		// queued execution's later reads succeed.
		let threw = false;
		const originalLoadRecord = store.loadRecord.bind(store);
		store.loadRecord = (canonicalPrKey: string) => {
			if (canonicalPrKey === PR_KEY && !threw) {
				threw = true;
				return Promise.reject(new Error("lock timeout"));
			}
			return originalLoadRecord(canonicalPrKey);
		};
		const harness = makeHarness();
		const executor = makeExecutor(store, harness);
		const reconcile = executor.reconcilePending();
		// Let reconcilePending enqueue PR 1's job before the handoff, so the
		// handoff's execution queues BEHIND the failing reconciliation.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const execution = executor.execute(makeHandoff());
		// The loop caught PR 1's failure and kept going.
		await expect(reconcile).resolves.toBeUndefined();
		expect(harness.warnings.some((message) => message.includes("lock timeout"))).toBe(true);
		// PR 2's journal was still reconciled (the loop did not abort).
		const other = await store.loadRecord(OTHER_PR_KEY);
		expect(other.ok).toBe(true);
		if (other.ok) {
			const otherBinding = other.record.taskBindings.find(
				(item) => item.workspaceId === TASK.workspaceId && item.taskId === TASK.taskId,
			);
			expect(otherBinding?.autoMergeAttempt?.state).toBe("waiting");
		}
		// The queued execution did NOT inherit the reconciliation failure:
		// it ran a fresh, fully re-validated attempt.
		const result = await execution;
		expect(result).toEqual({ action: "merged_confirmed", mergeCommitSha: MERGE_COMMIT });
		expect(harness.mergeWrites.length).toBe(1);
	});
});

describe("AM-4 auto-merge executor: the task move belongs to the merge-completion consumer", () => {
	it("leaves the card in review after a confirmed merge; the merge-completion consumer moves it to Done", async () => {
		const store = await makeStore();
		const harness = makeHarness();
		const executor = makeExecutor(store, harness);
		await expect(executor.execute(makeHandoff())).resolves.toEqual({
			action: "merged_confirmed",
			mergeCommitSha: MERGE_COMMIT,
		});
		// The executor does NOT move the task.
		const afterMerge = await loadBinding(store);
		expect(afterMerge.mergeCompletion ?? null).toBeNull();
		// The remote now reports merged; the merge-completion consumer picks
		// it up and completes the task.
		harness.remote.merged = true;
		harness.remote.mergeCommitSha = MERGE_COMMIT;
		const completeCalls: Array<{ workspaceId: string; taskId: string }> = [];
		const deps: PrMergeCompletionDeps = {
			store,
			getTaskCard: async () => ({ card: makeCard({ autoFinishOnMerge: true }), columnId: "review" }),
			isTaskWriterActive: async () => false,
			completeTask: async (workspaceId, taskId) => {
				completeCalls.push({ workspaceId, taskId });
				return [];
			},
			inspectWorktree: async () => null,
			warn: (message) => harness.warnings.push(message),
			now: () => NOW,
		};
		const loaded = await store.loadRecord(PR_KEY);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) {
			return;
		}
		const observation: PrConsumerObservation = {
			task: TASK,
			record: loaded.record,
			snapshot: {
				canonicalPrKey: PR_KEY,
				accessScopeId: "scope-1",
				checkedAt: NOW,
				metadata: makeMetadata("merged"),
				feedback: null,
				feedbackCompleteness: null,
			},
			installedConsumers: { comments: false, mergeCompletion: true, autoMerge: false },
			now: NOW,
		};
		await reconcileMergeCompletion(observation, deps);
		expect(completeCalls).toEqual([{ workspaceId: TASK.workspaceId, taskId: TASK.taskId }]);
		const finalBinding = await loadBinding(store);
		expect(finalBinding.mergeCompletion?.completedAt ?? null).toBe(NOW);
	});
});
