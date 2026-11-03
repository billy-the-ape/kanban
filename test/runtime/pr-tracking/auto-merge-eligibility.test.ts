import { describe, expect, it } from "vitest";

import {
	AUTO_MERGE_EVIDENCE_SCHEMA_VERSION,
	type AutoMergeEvidenceEnvelope,
	type AutoMergePolicy,
	type AutoMergeReviewEvidence,
	type GitHubPrMetadataSnapshot,
	type GitHubPrTaskIdentity,
	type GitHubPrTrackingRecord,
	type RuntimeBoardCard,
	type RuntimeBoardColumnId,
} from "../../../src/core/api-contract";
import {
	type AutoMergeConsumerDeps,
	type AutoMergeEligibilityHandoff,
	type AutoMergeEligibilityTaskFacts,
	classifyAutoMergeReviews,
	classifyRequiredChecks,
	evaluateAutoMergeEligibility,
	reconcileAutoMergeEligibility,
	registerAutoMergeConsumer,
} from "../../../src/pr-tracking/auto-merge-eligibility";
import { InMemoryPrRecordStore } from "../../../src/pr-tracking/in-memory-pr-record-store";
import {
	type PrConsumerObservation,
	PrConsumerRegistry,
	toInstalledConsumerFlags,
} from "../../../src/pr-tracking/pr-consumer-registry";
import type { PrBoardSnapshot } from "../../../src/pr-tracking/pr-owner-selection";
import type { PrRecordIdentity } from "../../../src/pr-tracking/pr-record-store";
import type { PrTrackingCoordinator } from "../../../src/pr-tracking/pr-tracking-coordinator";

const NOW = 1_700_000_000_000;
const HEAD = "headsha1";
const BASE = "basesha1";
const PR_KEY = "github|github.com|cline/kanban|49";
const TASK: GitHubPrTaskIdentity = { workspaceId: "ws-1", taskId: "task-1" };

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
	mergeMethod: "merge",
	revision: 1,
	updatedAt: NOW,
};

function makeTask(overrides: Partial<AutoMergeEligibilityTaskFacts> = {}): AutoMergeEligibilityTaskFacts {
	return {
		workspaceId: TASK.workspaceId,
		taskId: TASK.taskId,
		column: "review",
		optIn: true,
		armedPolicyRevision: 1,
		expectedRepository: "cline/kanban",
		expectedBaseRef: "main",
		...overrides,
	};
}

/** A complete, current, fully-green evidence envelope. */
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

async function makeRecord(
	overrides: (record: GitHubPrTrackingRecord) => GitHubPrTrackingRecord = (record) => record,
): Promise<GitHubPrTrackingRecord> {
	const store = new InMemoryPrRecordStore({ now: () => NOW });
	await store.createRecord(RECORD_IDENTITY);
	const loaded = await store.loadRecord(PR_KEY);
	if (!loaded.ok) {
		throw new Error("record missing after create");
	}
	return overrides(loaded.record);
}

function makeInput(
	overrides: {
		task?: AutoMergeEligibilityTaskFacts;
		policy?: AutoMergePolicy | null;
		envelope?: AutoMergeEvidenceEnvelope;
		record?: GitHubPrTrackingRecord;
		otherClaimantCount?: number;
		writerActive?: boolean;
		accessScopeId?: string;
		now?: number;
		maxEvidenceAgeMs?: number;
	} = {},
	record: GitHubPrTrackingRecord,
) {
	return {
		task: overrides.task ?? makeTask(),
		policy: overrides.policy === undefined ? POLICY : overrides.policy,
		envelope: overrides.envelope ?? makeEnvelope(),
		otherClaimantCount: overrides.otherClaimantCount ?? 0,
		record: overrides.record ?? record,
		writerActive: overrides.writerActive ?? false,
		accessScopeId: overrides.accessScopeId ?? "scope-1",
		now: overrides.now ?? NOW + 10_000,
		...(overrides.maxEvidenceAgeMs !== undefined ? { maxEvidenceAgeMs: overrides.maxEvidenceAgeMs } : {}),
	};
}

function codes(result: ReturnType<typeof evaluateAutoMergeEligibility>): string[] {
	return result.blockers.map((blocker) => blocker.code);
}

describe("AM-3 pure eligibility evaluation", () => {
	it("is eligible when every gate is green", async () => {
		const result = evaluateAutoMergeEligibility(makeInput({}, await makeRecord()));
		expect(result.kind).toBe("eligible");
		expect(result.blockers).toEqual([]);
		expect(result.headSha).toBe(HEAD);
		expect(result.baseSha).toBe(BASE);
		expect(result.policyRevision).toBe(1);
		expect(result.evidenceAgeMs).toBe(10_000);
	});

	it("blocks (not waits) on configuration and identity problems", async () => {
		const record = await makeRecord();
		expect(codes(evaluateAutoMergeEligibility(makeInput({ task: makeTask({ optIn: false }) }, record)))).toContain(
			"disabled",
		);
		expect(
			codes(evaluateAutoMergeEligibility(makeInput({ task: makeTask({ armedPolicyRevision: null }) }, record))),
		).toContain("not_armed");
		expect(
			codes(evaluateAutoMergeEligibility(makeInput({ task: makeTask({ column: "backlog" }) }, record))),
		).toContain("inactive_task");
		expect(codes(evaluateAutoMergeEligibility(makeInput({ policy: null }, record)))).toContain("no_policy");
		expect(codes(evaluateAutoMergeEligibility(makeInput({ policy: { ...POLICY, revision: 2 } }, record)))).toContain(
			"policy_mismatch",
		);
		expect(codes(evaluateAutoMergeEligibility(makeInput({ otherClaimantCount: 2 }, record)))).toContain(
			"ambiguous_claim",
		);
		expect(
			codes(evaluateAutoMergeEligibility(makeInput({ envelope: makeEnvelope({ reasons: ["auth"] }) }, record))),
		).toContain("auth");
		expect(
			codes(
				evaluateAutoMergeEligibility(
					makeInput({ envelope: makeEnvelope({ reasons: ["internal_error:boom"] }) }, record),
				),
			),
		).toContain("internal_error");
		expect(
			codes(
				evaluateAutoMergeEligibility(makeInput({ envelope: makeEnvelope({ accessScopeId: "scope-9" }) }, record)),
			),
		).toContain("stale_scope");
		expect(
			codes(evaluateAutoMergeEligibility(makeInput({ envelope: makeEnvelope({ headSha: null }) }, record))),
		).toContain("head_unknown");
		expect(
			codes(evaluateAutoMergeEligibility(makeInput({ envelope: makeEnvelope({ baseSha: null }) }, record))),
		).toContain("base_unknown");
		expect(
			codes(
				evaluateAutoMergeEligibility(makeInput({ task: makeTask({ expectedRepository: "other/repo" }) }, record)),
			),
		).toContain("pr_identity_mismatch");
		expect(
			codes(evaluateAutoMergeEligibility(makeInput({ task: makeTask({ expectedBaseRef: "develop" }) }, record))),
		).toContain("pr_identity_mismatch");
		expect(
			codes(evaluateAutoMergeEligibility(makeInput({ envelope: makeEnvelope({ prState: "closed" }) }, record))),
		).toContain("pr_closed");
		expect(
			codes(evaluateAutoMergeEligibility(makeInput({ envelope: makeEnvelope({ prState: "merged" }) }, record))),
		).toContain("pr_merged");
		expect(
			codes(evaluateAutoMergeEligibility(makeInput({ envelope: makeEnvelope({ mergeable: false }) }, record))),
		).toContain("merge_conflicts");
		expect(
			codes(evaluateAutoMergeEligibility(makeInput({ envelope: makeEnvelope({ autoMergePresent: true }) }, record))),
		).toContain("native_auto_merge");
	});

	it("classifies blocked problems as blocked even when other gates only wait", async () => {
		const record = await makeRecord();
		const result = evaluateAutoMergeEligibility(
			makeInput(
				{
					// Waiting: no approval. Blocked: closed PR.
					envelope: makeEnvelope({ prState: "closed", reviews: [] }),
				},
				record,
			),
		);
		expect(result.kind).toBe("blocked");
		expect(codes(result)).toContain("pr_closed");
		expect(codes(result)).toContain("no_approval");
	});

	it("waits on normal pending conditions", async () => {
		const record = await makeRecord();
		expect(
			codes(evaluateAutoMergeEligibility(makeInput({ envelope: makeEnvelope({ draft: true }) }, record))),
		).toContain("pr_draft");
		expect(
			codes(evaluateAutoMergeEligibility(makeInput({ envelope: makeEnvelope({ mergeable: null }) }, record))),
		).toContain("mergeability_unknown");
		expect(
			codes(
				evaluateAutoMergeEligibility(makeInput({ envelope: makeEnvelope({ reasons: ["head_changed"] }) }, record)),
			),
		).toContain("head_changed");
		expect(
			codes(
				evaluateAutoMergeEligibility(
					makeInput({ envelope: makeEnvelope({ complete: false, reasons: ["check_runs_incomplete"] }) }, record),
				),
			),
		).toContain("evidence_incomplete");
		expect(
			codes(
				evaluateAutoMergeEligibility(
					makeInput({ envelope: makeEnvelope({ checkedAt: NOW - 5 * 60 * 1000 }), now: NOW }, record),
				),
			),
		).toContain("evidence_stale");
		expect(codes(evaluateAutoMergeEligibility(makeInput({ writerActive: true }, record)))).toContain("writer_active");

		const reserved = await makeRecord((r) => ({
			...r,
			reservation: {
				...r.reservation,
				state: "reserved",
				reservedBy: { workspaceId: "ws-9", taskId: "other" },
				reservedOperation: "auto_merge",
				fencingGeneration: 1,
			},
		}));
		expect(codes(evaluateAutoMergeEligibility(makeInput({}, reserved)))).toContain("pr_reserved");

		const fingerprint = { digest: "fp-1", latestUpdatedAt: NOW, tokensAtWatermark: [] };
		const dispatched = await makeRecord((r) => ({
			...r,
			commentAutomation: {
				...r.commentAutomation,
				dispatch: {
					dispatchId: "disp-1",
					attemptedAt: null,
					fingerprint,
					ownerRevision: 1,
					status: "queued",
					turnReference: null,
					error: null,
				},
				pendingFeedbackFingerprint: fingerprint,
			},
		}));
		expect(codes(evaluateAutoMergeEligibility(makeInput({}, dispatched)))).toContain("comment_repair_pending");
	});
	// ── Review classification ──────────────────────────────────────────────────────

	function review(overrides: Partial<AutoMergeReviewEvidence> = {}): AutoMergeReviewEvidence {
		return {
			id: "rev-1",
			state: "APPROVED",
			authorLogin: "reviewer-1",
			authorKind: "human",
			isOwnAccount: false,
			commitId: HEAD,
			submittedAt: NOW - 1_000,
			...overrides,
		};
	}

	describe("AM-3 review classification", () => {
		it("counts only effective current-head approvals from non-author reviewers", () => {
			// Current-head approval: valid.
			expect(classifyAutoMergeReviews([review()], HEAD, "author").approvers).toEqual(["reviewer-1"]);

			// Self-approval: never counts.
			expect(classifyAutoMergeReviews([review({ authorLogin: "author" })], HEAD, "author").approvers).toEqual([]);

			// Stale-head approval: never counts.
			expect(classifyAutoMergeReviews([review({ commitId: "old-head" })], HEAD, "author").approvers).toEqual([]);

			// PENDING / DISMISSED states: never count.
			expect(classifyAutoMergeReviews([review({ state: "PENDING" })], HEAD, "author").approvers).toEqual([]);
			expect(classifyAutoMergeReviews([review({ state: "DISMISSED" })], HEAD, "author").approvers).toEqual([]);

			// Unknown reviewer identity: not a valid approver.
			expect(classifyAutoMergeReviews([review({ authorLogin: "unknown" })], HEAD, "author").approvers).toEqual([]);

			// Unknown PR author or unknown head: no approvals possible.
			expect(classifyAutoMergeReviews([review()], HEAD, null).approvers).toEqual([]);
			expect(classifyAutoMergeReviews([review()], null, "author").approvers).toEqual([]);
		});

		it("a changes request blocks until a strictly-later valid current-head approval supersedes it", () => {
			const cr = review({
				id: "cr-1",
				state: "CHANGES_REQUESTED",
				authorLogin: "reviewer-1",
				submittedAt: NOW - 5_000,
			});
			const approval = review({ id: "ap-1", authorLogin: "reviewer-1", submittedAt: NOW - 1_000 });

			// CR alone: blocks.
			expect(classifyAutoMergeReviews([cr], HEAD, "author").blockingChangeRequests).toEqual(["reviewer-1"]);

			// Later valid approval supersedes the CR.
			expect(classifyAutoMergeReviews([cr, approval], HEAD, "author")).toMatchObject({
				approvers: ["reviewer-1"],
				blockingChangeRequests: [],
			});

			// CR after the approval: still blocks, no approval.
			const lateCr = review({
				id: "cr-2",
				state: "CHANGES_REQUESTED",
				authorLogin: "reviewer-1",
				submittedAt: NOW - 500,
			});
			expect(classifyAutoMergeReviews([approval, lateCr], HEAD, "author")).toMatchObject({
				approvers: [],
				blockingChangeRequests: ["reviewer-1"],
			});

			// Stale-head approval does not supersede the CR.
			const staleApproval = review({ id: "ap-2", commitId: "old-head", submittedAt: NOW - 500 });
			expect(classifyAutoMergeReviews([cr, staleApproval], HEAD, "author").blockingChangeRequests).toEqual([
				"reviewer-1",
			]);
		});

		it("tied decision timestamps are inconsistent (never guessed)", () => {
			const cr = review({ id: "cr-1", state: "CHANGES_REQUESTED", submittedAt: NOW - 1_000 });
			const approval = review({ id: "ap-1", submittedAt: NOW - 1_000 });
			expect(classifyAutoMergeReviews([cr, approval], HEAD, "author").inconsistent).toEqual(["reviewer-1"]);
		});

		it("a dismissed review contributes nothing (fail-closed: an un-dismissed CR still blocks)", () => {
			const cr = review({ id: "cr-1", state: "CHANGES_REQUESTED", submittedAt: NOW - 5_000 });
			const dismissed = review({ id: "dis-1", state: "DISMISSED", submittedAt: NOW - 4_000 });

			// The dismissed review's original decision is not recoverable from
			// the evidence; a still-submitted CR therefore keeps blocking.
			expect(classifyAutoMergeReviews([cr, dismissed], HEAD, "author")).toMatchObject({
				blockingChangeRequests: ["reviewer-1"],
				approvers: [],
				inconsistent: [],
			});

			// A dismissed approval alone contributes nothing.
			expect(classifyAutoMergeReviews([dismissed], HEAD, "author")).toMatchObject({
				blockingChangeRequests: [],
				approvers: [],
				inconsistent: [],
			});
		});
	});

	describe("AM-3 required-check classification", () => {
		it("uses the effective latest attempt per check and ignores unrelated checks", () => {
			const envelope = makeEnvelope({
				checks: [
					{
						kind: "check_run",
						name: "ci",
						sourceId: null,
						status: "completed",
						conclusion: "success",
						sha: HEAD,
						runId: "1",
						occurredAt: NOW - 10_000,
					},
					{
						kind: "check_run",
						name: "unrelated",
						sourceId: null,
						status: "completed",
						conclusion: "failure",
						sha: HEAD,
						runId: "2",
						occurredAt: NOW - 5_000,
					},
				],
			});
			expect(classifyRequiredChecks(POLICY, envelope)).toEqual([{ name: "ci", outcome: "success" }]);
		});

		it("a newer pending attempt masks an older success", () => {
			const envelope = makeEnvelope({
				checks: [
					{
						kind: "check_run",
						name: "ci",
						sourceId: null,
						status: "completed",
						conclusion: "success",
						sha: HEAD,
						runId: "1",
						occurredAt: NOW - 10_000,
					},
					{
						kind: "check_run",
						name: "ci",
						sourceId: null,
						status: "in_progress",
						conclusion: null,
						sha: HEAD,
						runId: "2",
						occurredAt: NOW - 5_000,
					},
				],
			});
			expect(classifyRequiredChecks(POLICY, envelope)).toEqual([{ name: "ci", outcome: "pending" }]);
		});

		it("classifies neutral/skipped conclusions as non-success and missing checks as missing", () => {
			const envelope = makeEnvelope({
				checks: [
					{
						kind: "check_run",
						name: "ci",
						sourceId: null,
						status: "completed",
						conclusion: "skipped",
						sha: HEAD,
						runId: "1",
						occurredAt: NOW - 5_000,
					},
				],
			});
			expect(classifyRequiredChecks(POLICY, envelope)).toEqual([{ name: "ci", outcome: "failed" }]);

			const policyTwo: AutoMergePolicy = { ...POLICY, requiredChecks: ["ci", "lint"] };
			expect(classifyRequiredChecks(policyTwo, envelope)).toEqual([
				{ name: "ci", outcome: "failed" },
				{ name: "lint", outcome: "missing" },
			]);
		});

		it("combines check runs and commit statuses by exact name", () => {
			const envelope = makeEnvelope({
				checks: [],
				statuses: [
					{
						kind: "commit_status",
						name: "ci",
						sourceId: null,
						status: "completed",
						conclusion: "success",
						sha: HEAD,
						runId: "s1",
						occurredAt: NOW - 5_000,
					},
				],
			});
			expect(classifyRequiredChecks(POLICY, envelope)).toEqual([{ name: "ci", outcome: "success" }]);
		});
	});
	// ── The auto-merge consumer observer ───────────────────────────────────────────

	const LINK = {
		provider: "github" as const,
		host: "github.com",
		repository: "cline/kanban",
		number: 49,
		url: "https://github.com/cline/kanban/pull/49",
		source: "agent_tool" as const,
		createdAt: NOW - 1_000_000,
	};

	function makeCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
		return {
			id: TASK.taskId,
			title: "Task 1",
			prompt: "do the thing",
			startInPlanMode: false,
			autoReviewEnabled: false,
			baseRef: "main",
			createdAt: NOW - 2_000_000,
			updatedAt: NOW - 2_000_000,
			autoMergeWhenApproved: true,
			armedAutoMergePolicyRevision: 1,
			pullRequests: [LINK],
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
			columns.find((column) => column.id === columnId)?.cards.push(card);
		}
		return { workspaceId, board: { columns, dependencies: [] } };
	}

	interface ReconcileHarness {
		deps: AutoMergeConsumerDeps;
		observation: PrConsumerObservation;
		handoffs: AutoMergeEligibilityHandoff[];
		envelopeReads: number[];
		warnings: string[];
	}

	function makeReconcileHarness(
		options: {
			envelope?: AutoMergeEvidenceEnvelope;
			card?: RuntimeBoardCard;
			boards?: PrBoardSnapshot[];
			policy?: AutoMergePolicy | null;
			writerActive?: boolean;
			coordinatorAvailable?: boolean;
		} = {},
	): ReconcileHarness {
		const envelope = options.envelope ?? makeEnvelope();
		const card = options.card ?? makeCard();
		const boards = options.boards ?? [makeBoard(TASK.workspaceId, [{ columnId: "review", card }])];
		const handoffs: AutoMergeEligibilityHandoff[] = [];
		const envelopeReads: number[] = [];
		const warnings: string[] = [];
		const fakeCoordinator = {
			readAutoMergeEvidence: async (
				_prKey: string,
				_accessScopeId: string,
				readOptions: { policyRevision: number },
			) => {
				envelopeReads.push(readOptions.policyRevision);
				return envelope;
			},
		} as unknown as PrTrackingCoordinator;
		const deps: AutoMergeConsumerDeps = {
			// The tests set the durable store after creating the harness.
			store: null as unknown as InMemoryPrRecordStore,
			getCoordinator: () => (options.coordinatorAvailable === false ? null : fakeCoordinator),
			getTaskCard: async (workspaceId, taskId) => {
				if (workspaceId !== TASK.workspaceId || taskId !== TASK.taskId) {
					return null;
				}
				const found = boards
					.flatMap((snapshot) =>
						snapshot.board.columns.flatMap((column) => column.cards.map((c) => ({ column, c }))),
					)
					.find((entry) => entry.c.id === taskId);
				return found ? { card: found.c, columnId: found.column.id } : null;
			},
			listBoards: async () => boards,
			loadPolicy: async () => options.policy ?? POLICY,
			isTaskWriterActive: async () => options.writerActive ?? false,
			onEligible: (handoff) => {
				handoffs.push(handoff);
			},
			warn: (message) => warnings.push(message),
			now: () => NOW + 10_000,
		};
		return { deps, observation: makeObservation(), handoffs, envelopeReads, warnings };
	}

	function makeObservation(): PrConsumerObservation {
		const record = {
			canonicalPrKey: PR_KEY,
			provider: "github",
			host: "github.com",
			repository: "cline/kanban",
			number: 49,
			taskBindings: [{ workspaceId: TASK.workspaceId, taskId: TASK.taskId }],
			commentAutomation: {
				repairOwner: null,
				pendingFeedbackFingerprint: null,
				lastDispatchedFeedbackFingerprint: null,
				debounceDeadline: null,
				firstPendingAt: null,
				dispatch: null,
			},
			reservation: { state: "none", reservedBy: null, reservedOperation: null, fencingGeneration: 0 },
			mergeCompletion: null,
			snapshots: {},
			replayCursors: {},
			revision: 0,
			createdAt: NOW,
			updatedAt: NOW,
		} as unknown as PrConsumerObservation["record"];
		const metadata: GitHubPrMetadataSnapshot = {
			accessScopeId: "scope-1",
			checkedAt: NOW,
			state: "open",
			headRepository: "cline/kanban",
			headRef: "fix-branch",
			baseRepository: "cline/kanban",
			baseRef: "main",
			headSha: HEAD,
			mergedAt: null,
			mergeCommitSha: null,
		};
		return {
			task: TASK,
			record,
			snapshot: {
				canonicalPrKey: PR_KEY,
				accessScopeId: "scope-1",
				checkedAt: NOW,
				metadata,
				feedback: null,
				feedbackCompleteness: null,
			},
			installedConsumers: { comments: false, mergeCompletion: false, autoMerge: true },
			now: NOW + 10_000,
		};
	}

	describe("AM-3 consumer reconciliation", () => {
		it("emits the eligibility handoff and persists the summary when eligible", async () => {
			const harness = makeReconcileHarness();
			const store = new InMemoryPrRecordStore({ now: () => NOW });
			await store.createRecord(RECORD_IDENTITY);
			await store.upsertTaskBinding(PR_KEY, TASK);
			harness.deps.store = store;

			await reconcileAutoMergeEligibility(harness.observation, harness.deps);

			expect(harness.handoffs).toHaveLength(1);
			expect(harness.handoffs[0]).toMatchObject({
				workspaceId: TASK.workspaceId,
				taskId: TASK.taskId,
				canonicalPrKey: PR_KEY,
				headSha: HEAD,
				baseSha: BASE,
				accessScopeId: "scope-1",
			});
			expect(harness.envelopeReads).toEqual([1]);

			const loaded = await store.loadRecord(PR_KEY);
			expect(loaded.ok).toBe(true);
			const summary = loaded.ok ? loaded.record.taskBindings[0]?.autoMerge : null;
			expect(summary).toMatchObject({ kind: "eligible", codes: [] });
		});

		it("persists the waiting summary and emits no handoff when a gate waits", async () => {
			const harness = makeReconcileHarness({ envelope: makeEnvelope({ reviews: [] }) });
			const store = new InMemoryPrRecordStore({ now: () => NOW });
			await store.createRecord(RECORD_IDENTITY);
			await store.upsertTaskBinding(PR_KEY, TASK);
			harness.deps.store = store;

			await reconcileAutoMergeEligibility(harness.observation, harness.deps);

			expect(harness.handoffs).toEqual([]);
			const loaded = await store.loadRecord(PR_KEY);
			expect(loaded.ok).toBe(true);
			const summary = loaded.ok ? loaded.record.taskBindings[0]?.autoMerge : null;
			expect(summary?.kind).toBe("waiting");
			expect(summary?.codes).toContain("no_approval");
		});

		it("never evaluates or writes when the opt-in is off or the card is not armed", async () => {
			for (const card of [
				makeCard({ autoMergeWhenApproved: false }),
				makeCard({ armedAutoMergePolicyRevision: undefined }),
			]) {
				const harness = makeReconcileHarness({ card });
				const store = new InMemoryPrRecordStore({ now: () => NOW });
				await store.createRecord(RECORD_IDENTITY);
				await store.upsertTaskBinding(PR_KEY, TASK);
				harness.deps.store = store;

				await reconcileAutoMergeEligibility(harness.observation, harness.deps);

				expect(harness.handoffs).toEqual([]);
				expect(harness.envelopeReads).toEqual([]);
				const loaded = await store.loadRecord(PR_KEY);
				expect(loaded.ok).toBe(true);
				expect(loaded.ok ? loaded.record.taskBindings[0]?.autoMerge : null).toBeNull();
			}
		});

		it("skips the observation when the card's selection moved to a different PR", async () => {
			const harness = makeReconcileHarness({
				card: makeCard({
					pullRequests: [{ ...LINK, number: 50, url: "https://github.com/cline/kanban/pull/50" }],
				}),
			});
			const store = new InMemoryPrRecordStore({ now: () => NOW });
			await store.createRecord(RECORD_IDENTITY);
			await store.upsertTaskBinding(PR_KEY, TASK);
			harness.deps.store = store;

			await reconcileAutoMergeEligibility(harness.observation, harness.deps);

			expect(harness.handoffs).toEqual([]);
			expect(harness.envelopeReads).toEqual([]);
		});

		it("blocks on ambiguous claims when another opted-in armed task claims the same PR", async () => {
			const other = makeCard({ id: "task-2" });
			const boards = [
				makeBoard(TASK.workspaceId, [
					{ columnId: "review", card: makeCard() },
					{ columnId: "in_progress", card: other },
				]),
			];
			const harness = makeReconcileHarness({ boards });
			const store = new InMemoryPrRecordStore({ now: () => NOW });
			await store.createRecord(RECORD_IDENTITY);
			await store.upsertTaskBinding(PR_KEY, TASK);
			harness.deps.store = store;

			await reconcileAutoMergeEligibility(harness.observation, harness.deps);

			expect(harness.handoffs).toEqual([]);
			const loaded = await store.loadRecord(PR_KEY);
			expect(loaded.ok).toBe(true);
			expect(loaded.ok ? loaded.record.taskBindings[0]?.autoMerge?.kind : null).toBe("blocked");
			expect(loaded.ok ? loaded.record.taskBindings[0]?.autoMerge?.codes : []).toContain("ambiguous_claim");
		});

		it("does nothing when the coordinator is unavailable", async () => {
			const harness = makeReconcileHarness({ coordinatorAvailable: false });
			const store = new InMemoryPrRecordStore({ now: () => NOW });
			await store.createRecord(RECORD_IDENTITY);
			await store.upsertTaskBinding(PR_KEY, TASK);
			harness.deps.store = store;

			await reconcileAutoMergeEligibility(harness.observation, harness.deps);

			expect(harness.handoffs).toEqual([]);
			expect(harness.envelopeReads).toEqual([]);
		});
	});

	describe("AM-3 consumer registration", () => {
		it("registers the autoMerge kind with its default metadata read demand", async () => {
			const registry = new PrConsumerRegistry();
			const harness = makeReconcileHarness();
			const store = new InMemoryPrRecordStore({ now: () => NOW });
			await store.createRecord(RECORD_IDENTITY);
			harness.deps.store = store;

			registerAutoMergeConsumer(registry, harness.deps);

			expect(toInstalledConsumerFlags(registry)).toMatchObject({ autoMerge: true });
			expect(registry.requiredReadSources().has("metadata")).toBe(true);
		});
	});
});
