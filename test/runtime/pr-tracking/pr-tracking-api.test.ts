// PRTRACK-1: trpc consumer API — diagnostics, settings writes, and operator
// force-release authorization.
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as WorkspaceState from "../../../src/state/workspace-state";

const workspaceStateMocks = vi.hoisted(() => ({
	loadWorkspaceBoardById: vi.fn(),
	mutateWorkspaceState: vi.fn(),
}));

vi.mock("../../../src/state/workspace-state.js", async (importOriginal) => {
	const actual = await importOriginal<typeof WorkspaceState>();
	return {
		...actual,
		loadWorkspaceBoardById: workspaceStateMocks.loadWorkspaceBoardById,
		mutateWorkspaceState: workspaceStateMocks.mutateWorkspaceState,
	};
});

import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
} from "../../../src/core/api-contract";
import { AutoMergePolicyStore } from "../../../src/pr-tracking/auto-merge-policy-store";
import { InMemoryPrRecordStore } from "../../../src/pr-tracking/in-memory-pr-record-store";
import { assignRepairOwner } from "../../../src/pr-tracking/pr-owner-selection";
import { releasePrOperation, reservePrOperation } from "../../../src/pr-tracking/pr-reservations";
import { createPrTrackingCoordinator } from "../../../src/pr-tracking/pr-tracking-coordinator";
import type { RuntimeTrpcWorkspaceScope } from "../../../src/trpc/app-router";
import { createPrTrackingApi } from "../../../src/trpc/pr-tracking-api";

const WORKSPACE_ID = "ws-1";
const WORKSPACE_PATH = "/tmp/ws-1";
const PR_KEY = "github|github.com|cline/kanban|49";
const RECORD_IDENTITY = {
	canonicalPrKey: PR_KEY,
	provider: "github" as const,
	host: "github.com",
	repository: "cline/kanban",
	number: 49,
};
const LINK = {
	provider: "github" as const,
	host: "github.com",
	repository: "cline/kanban",
	number: 49,
	url: "https://github.com/cline/kanban/pull/49",
	source: "agent_tool" as const,
	createdAt: 1_700_000_000_000,
};
const SCOPE: RuntimeTrpcWorkspaceScope = { workspaceId: WORKSPACE_ID, workspacePath: WORKSPACE_PATH };
const HOLDER = { workspaceId: WORKSPACE_ID, taskId: "task-h" };
const OTHER_TASK = { workspaceId: WORKSPACE_ID, taskId: "task-b" };
const OPERATOR_TASK_ID = "task-1";

function makeCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: OPERATOR_TASK_ID,
		title: "Task 1",
		prompt: "do the thing",
		startInPlanMode: false,
		autoReviewEnabled: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 2,
		pullRequests: [LINK],
		...overrides,
	};
}

function makeBoard(card: RuntimeBoardCard, columnId: RuntimeBoardColumnId = "in_progress"): RuntimeBoardData {
	const columns: Array<{ id: RuntimeBoardColumnId; title: string; cards: RuntimeBoardCard[] }> = [
		{ id: "backlog", title: "Backlog", cards: [] },
		{ id: "in_progress", title: "In Progress", cards: [] },
		{ id: "review", title: "In Review", cards: [] },
		{ id: "done", title: "Done", cards: [] },
		{ id: "trash", title: "Trash", cards: [] },
	];
	const column = columns.find((c) => c.id === columnId);
	if (!column) {
		throw new Error("missing column");
	}
	column.cards.push(card);
	return { columns, dependencies: [] };
}

interface ApiHarness {
	store: InMemoryPrRecordStore;
	warnings: string[];
	api: ReturnType<typeof createPrTrackingApi>;
}

const tempRoots: string[] = [];

function createTempDirSync(): string {
	return mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "am1-api-test-"));
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

function createHarness(
	board: RuntimeBoardData,
	options: {
		writerActive?: boolean;
		effectiveAgentId?: RuntimeAgentId | null;
		policyStore?: AutoMergePolicyStore;
	} = {},
): ApiHarness {
	const store = new InMemoryPrRecordStore();
	const coordinator = createPrTrackingCoordinator({ store });
	const warnings: string[] = [];
	const policyStore =
		options.policyStore ??
		(() => {
			const tempRoot = createTempDirSync();
			tempRoots.push(tempRoot);
			return new AutoMergePolicyStore({ rootPath: tempRoot });
		})();
	const api = createPrTrackingApi({
		getPrTrackingCoordinator: () => coordinator,
		getPrTrackingStore: () => store,
		getAutoMergePolicyStore: () => policyStore,
		listManagedWorkspaceBoards: async () => [{ workspaceId: WORKSPACE_ID, board }],
		broadcastRuntimeWorkspaceStateUpdated: () => undefined,
		isTaskWriterActive: () => options.writerActive === true,
		getEffectiveTaskAgentId: async () => options.effectiveAgentId ?? null,
		runPrTrackingReconcilePass: async () => undefined,
		warn: (message: string) => {
			warnings.push(message);
		},
	});
	return { store, warnings, api };
}

/** Mocks the workspace-state module around an in-memory board. */
function mockWorkspaceState(board: RuntimeBoardData) {
	let lastMutationSave: boolean | null = null;
	workspaceStateMocks.loadWorkspaceBoardById.mockReset();
	workspaceStateMocks.mutateWorkspaceState.mockReset();
	workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(board);
	workspaceStateMocks.mutateWorkspaceState.mockImplementation(
		async (_path: string, mutate: (state: unknown) => { value: unknown; board: unknown; save: boolean }) => {
			const state = { board, sessions: {}, revision: 1 };
			const result = mutate(state);
			lastMutationSave = result.save;
			return { value: result.value, state, saved: result.save !== false };
		},
	);
	return {
		lastMutationSave: () => lastMutationSave,
	};
}

async function seedRecord(store: InMemoryPrRecordStore): Promise<void> {
	await store.createRecord(RECORD_IDENTITY);
}

describe("pr-tracking api: tracking-state diagnostics", () => {
	beforeEach(() => {
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();
	});

	it("reports comments_unsupported for a non-Cline task", async () => {
		const board = makeBoard(makeCard({ autoAddressComments: true, agentId: "codex" }));
		mockWorkspaceState(board);
		const harness = createHarness(board);

		const state = await harness.api.getTaskTrackingState(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(state.commentsSupportedForTask).toBe(false);
		expect(state.blockers).toContainEqual({
			kind: "comments_unsupported",
			message: "Comment follow-up automation requires a native Cline task.",
		});
	});

	it("supports comments for an explicitly Cline-assigned task", async () => {
		const board = makeBoard(makeCard({ autoAddressComments: true, agentId: "cline" }));
		mockWorkspaceState(board);
		const harness = createHarness(board);

		const state = await harness.api.getTaskTrackingState(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(state.commentsSupportedForTask).toBe(true);
		expect(state.blockers.some((blocker) => blocker.kind === "comments_unsupported")).toBe(false);
	});

	it("treats an unset agentId as the workspace's selected agent (non-Cline)", async () => {
		// No per-card agentId: the effective agent is the workspace's selected
		// agent, which here is non-Cline.
		const board = makeBoard(makeCard({ autoAddressComments: true }));
		mockWorkspaceState(board);
		const harness = createHarness(board, { effectiveAgentId: "claude" });

		const state = await harness.api.getTaskTrackingState(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(state.commentsSupportedForTask).toBe(false);
		expect(state.blockers).toContainEqual({
			kind: "comments_unsupported",
			message: "Comment follow-up automation requires a native Cline task.",
		});
	});

	it("treats an unset agentId as native Cline when the workspace's selected agent is cline", async () => {
		const board = makeBoard(makeCard({ autoAddressComments: true }));
		mockWorkspaceState(board);
		const harness = createHarness(board, { effectiveAgentId: "cline" });

		const state = await harness.api.getTaskTrackingState(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(state.commentsSupportedForTask).toBe(true);
	});

	it("does not gate legacy completion for a non-Cline task even with the comments checkbox on", async () => {
		// The comments half of the lifecycle gate only owns native-Cline
		// tasks: a codex task with auto-finish-off must stay completable.
		const board = makeBoard(makeCard({ autoAddressComments: true, autoFinishOnMerge: false, agentId: "codex" }));
		mockWorkspaceState(board);
		const harness = createHarness(board);

		const state = await harness.api.getTaskTrackingState(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(state.legacyCompletionGated).toBe(false);
		expect(state.mergeFinishesInReview).toBe(false);
	});

	it("still gates legacy completion for a non-Cline task when auto-finish-on-merge is on", async () => {
		// The merge consumer is provider-independent.
		const board = makeBoard(makeCard({ autoAddressComments: true, autoFinishOnMerge: true, agentId: "codex" }));
		mockWorkspaceState(board);
		const harness = createHarness(board);

		const state = await harness.api.getTaskTrackingState(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(state.legacyCompletionGated).toBe(true);
		expect(state.mergeFinishesInReview).toBe(true);
	});

	it("lets the comments half gate legacy completion for a native Cline task", async () => {
		const board = makeBoard(makeCard({ autoAddressComments: true, autoFinishOnMerge: false }));
		mockWorkspaceState(board);
		const harness = createHarness(board, { effectiveAgentId: "cline" });

		const state = await harness.api.getTaskTrackingState(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(state.legacyCompletionGated).toBe(true);
		expect(state.mergeFinishesInReview).toBe(false);
	});

	it("reports the repair owner as active while it is still on a board", async () => {
		const board = makeBoard(makeCard({ autoAddressComments: true }));
		mockWorkspaceState(board);
		const harness = createHarness(board);
		await seedRecord(harness.store);
		await assignRepairOwner(harness.store, PR_KEY, [{ workspaceId: WORKSPACE_ID, board }], {
			workspaceId: WORKSPACE_ID,
			taskId: OPERATOR_TASK_ID,
		});

		const state = await harness.api.getTaskTrackingState(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(state.owner?.state).toBe("active");
		expect(state.blockers.some((blocker) => blocker.kind === "owner_deleted")).toBe(false);
	});
});

describe("pr-tracking api: settings writes", () => {
	beforeEach(() => {
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();
	});

	it("reports a no-op settings write as ok without touching the revision", async () => {
		const board = makeBoard(makeCard({ settingsRevision: 3 }));
		const state = mockWorkspaceState(board);
		const harness = createHarness(board);

		const result = await harness.api.setTaskPrSettings(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(result.ok).toBe(true);
		expect(result.reason).toBeNull();
		expect(result.settingsRevision).toBe(3);
		expect(state.lastMutationSave()).toBe(false);
	});

	it("returns conflict when the expected settings revision is stale", async () => {
		const board = makeBoard(makeCard({ settingsRevision: 4 }));
		mockWorkspaceState(board);
		const harness = createHarness(board);

		const result = await harness.api.setTaskPrSettings(SCOPE, {
			taskId: OPERATOR_TASK_ID,
			autoAddressComments: true,
			expectedSettingsRevision: 3,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("conflict");
		expect(result.settingsRevision).toBe(4);
	});
});

describe("pr-tracking api: operator force release authorization", () => {
	beforeEach(() => {
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();
	});

	async function seedHeldReservation(harness: ApiHarness, board: ReturnType<typeof makeBoard>) {
		// A reservation requires the record to carry a verified head mapping,
		// so seed one (like a real snapshot refresh would).
		await harness.store.createRecord(RECORD_IDENTITY);
		const loaded = await harness.store.loadRecord(PR_KEY);
		if (!loaded.ok) {
			throw new Error("record missing");
		}
		await harness.store.updateRecord(PR_KEY, loaded.record.revision, (record) => ({
			...record,
			revision: record.revision + 1,
			updatedAt: 1,
			snapshots: {
				"scope-1": {
					accessScopeId: "scope-1",
					checkedAt: 1,
					state: "open" as const,
					headRepository: "cline/kanban",
					headRef: "feat/x",
					baseRepository: "cline/kanban",
					baseRef: "main",
					headSha: null,
					mergedAt: null,
					mergeCommitSha: null,
				},
			},
		}));
		const reserved = await reservePrOperation(harness.store, PR_KEY, "comment_followup", HOLDER, {
			requireOwner: false,
		});
		if (reserved.status !== "reserved") {
			throw new Error(`expected reservation success, got ${reserved.status}: ${reserved.detail ?? ""}`);
		}
		return board;
	}

	it("refuses force release while the holder's writer is still active", async () => {
		const board = makeBoard(makeCard());
		mockWorkspaceState(board);
		const harness = createHarness(board, { writerActive: true });
		await seedHeldReservation(harness, board);
		const loaded = await harness.store.loadRecord(PR_KEY);
		if (!loaded.ok) {
			throw new Error("record missing");
		}
		const generation = loaded.record.reservation.fencingGeneration;

		const result = await harness.api.releasePrOperation(SCOPE, {
			taskId: OPERATOR_TASK_ID,
			operation: "comment_followup",
			force: true,
			expectedHolder: HOLDER,
			expectedFencingGeneration: generation,
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe("busy");
	});

	it("refuses force release when the observed generation does not match (stale)", async () => {
		const board = makeBoard(makeCard());
		mockWorkspaceState(board);
		const harness = createHarness(board, { writerActive: false });
		await seedHeldReservation(harness, board);
		const loaded = await harness.store.loadRecord(PR_KEY);
		if (!loaded.ok) {
			throw new Error("record missing");
		}

		const result = await harness.api.releasePrOperation(SCOPE, {
			taskId: OPERATOR_TASK_ID,
			operation: "comment_followup",
			force: true,
			expectedHolder: HOLDER,
			expectedFencingGeneration: loaded.record.reservation.fencingGeneration + 1,
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe("stale");
	});

	it("clears the reservation once the holder is verified exited", async () => {
		const board = makeBoard(makeCard());
		mockWorkspaceState(board);
		const harness = createHarness(board, { writerActive: false });
		await seedHeldReservation(harness, board);
		const loaded = await harness.store.loadRecord(PR_KEY);
		if (!loaded.ok) {
			throw new Error("record missing");
		}
		const generation = loaded.record.reservation.fencingGeneration;

		const result = await harness.api.releasePrOperation(SCOPE, {
			taskId: OPERATOR_TASK_ID,
			operation: "comment_followup",
			force: true,
			expectedHolder: HOLDER,
			expectedFencingGeneration: generation,
		});
		expect(result.ok).toBe(true);
		expect(result.reservation.state).toBe("none");
		expect(result.reservation.reservedBy).toBeNull();
		// Audited operator action.
		expect(harness.warnings.some((warning) => warning.includes("operator force-release"))).toBe(true);
	});

	it("leaves a newer reservation intact when the observed generation was superseded", async () => {
		const board = makeBoard(makeCard());
		mockWorkspaceState(board);
		const harness = createHarness(board, { writerActive: false });
		await seedHeldReservation(harness, board);
		const observed = await harness.store.loadRecord(PR_KEY);
		if (!observed.ok) {
			throw new Error("record missing");
		}
		const observedGeneration = observed.record.reservation.fencingGeneration;

		// The holder exits and another task re-reserves in the meantime: the
		// operator's observed holder/generation no longer matches.
		const released = await releasePrOperation(harness.store, PR_KEY, "comment_followup", HOLDER);
		if (released.status !== "reserved") {
			throw new Error(`expected holder release, got ${released.status}`);
		}
		const rereserved = await reservePrOperation(harness.store, PR_KEY, "comment_followup", OTHER_TASK, {
			requireOwner: false,
		});
		if (rereserved.status !== "reserved") {
			throw new Error(`expected re-reservation, got ${rereserved.status}`);
		}

		// Stale observation: the force path must NOT clear the newer reservation
		// (re-validated inside the registry transaction).
		const result = await releasePrOperation(
			harness.store,
			PR_KEY,
			"comment_followup",
			{ workspaceId: WORKSPACE_ID, taskId: OPERATOR_TASK_ID },
			undefined,
			{
				force: true,
				expectedHolder: HOLDER,
				expectedFencingGeneration: observedGeneration,
			},
		);
		expect(result.status).toBe("stale");
		const current = await harness.store.loadRecord(PR_KEY);
		if (!current.ok) {
			throw new Error("record missing");
		}
		// The newer reservation (OTHER_TASK) is preserved. Note the fencing
		// generation is a max-based high-water mark and need not increment on
		// an ownerless re-reservation; the holder identity distinguishes the
		// superseded observation.
		expect(current.record.reservation.state).toBe("reserved");
		expect(current.record.reservation.reservedBy).toEqual(OTHER_TASK);
	});
});
describe("pr-tracking api: the auto-merge fence is exclusive to the server-side executor (AM-4)", () => {
	beforeEach(() => {
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();
	});

	async function seedAutoMergeFence(harness: ApiHarness) {
		await harness.store.createRecord(RECORD_IDENTITY);
		const loaded = await harness.store.loadRecord(PR_KEY);
		if (!loaded.ok) {
			throw new Error("record missing");
		}
		await harness.store.updateRecord(PR_KEY, loaded.record.revision, (record) => ({
			...record,
			revision: record.revision + 1,
			updatedAt: 1,
			snapshots: {
				"scope-1": {
					accessScopeId: "scope-1",
					checkedAt: 1,
					state: "open" as const,
					headRepository: "cline/kanban",
					headRef: "feat/x",
					baseRepository: "cline/kanban",
					baseRef: "main",
					headSha: null,
					mergedAt: null,
					mergeCommitSha: null,
				},
			},
		}));
		// The executor's fence, held by the SAME task the browser caller
		// uses: without the guard, the non-force `heldByCaller` check would
		// pass and clear the durable fence mid-merge.
		const reserved = await reservePrOperation(
			harness.store,
			PR_KEY,
			"auto_merge",
			{
				workspaceId: WORKSPACE_ID,
				taskId: OPERATOR_TASK_ID,
			},
			{ requireOwner: false },
		);
		if (reserved.status !== "reserved") {
			throw new Error(`expected auto_merge reservation, got ${reserved.status}: ${reserved.detail ?? ""}`);
		}
	}

	it("refuses a non-force browser release of the auto_merge fence", async () => {
		const board = makeBoard(makeCard());
		mockWorkspaceState(board);
		const harness = createHarness(board);
		await seedAutoMergeFence(harness);

		const result = await harness.api.releasePrOperation(SCOPE, {
			taskId: OPERATOR_TASK_ID,
			operation: "auto_merge",
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe("blocked");
		// The durable fence is untouched.
		const current = await harness.store.loadRecord(PR_KEY);
		expect(current.ok).toBe(true);
		if (current.ok) {
			expect(current.record.reservation.state).toBe("reserved");
			expect(current.record.reservation.reservedBy).toEqual({
				workspaceId: WORKSPACE_ID,
				taskId: OPERATOR_TASK_ID,
			});
		}
	});

	it("refuses a force browser release of the auto_merge fence even when the holder looks exited", async () => {
		const board = makeBoard(makeCard());
		mockWorkspaceState(board);
		// writerActive: false — the holder-exit probe would have permitted
		// the force takeover without the guard.
		const harness = createHarness(board, { writerActive: false });
		await seedAutoMergeFence(harness);
		const loaded = await harness.store.loadRecord(PR_KEY);
		if (!loaded.ok) {
			throw new Error("record missing");
		}

		const result = await harness.api.releasePrOperation(SCOPE, {
			taskId: OPERATOR_TASK_ID,
			operation: "auto_merge",
			force: true,
			expectedHolder: { workspaceId: WORKSPACE_ID, taskId: OPERATOR_TASK_ID },
			expectedFencingGeneration: loaded.record.reservation.fencingGeneration,
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe("blocked");
		const current = await harness.store.loadRecord(PR_KEY);
		expect(current.ok).toBe(true);
		if (current.ok) {
			expect(current.record.reservation.state).toBe("reserved");
		}
	});
});

// AM-1: per-repository auto-merge policy procedures.
describe("pr-tracking api: auto-merge policy (AM-1)", () => {
	beforeEach(() => {
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();
	});

	it("reports no policy for an unknown repository", async () => {
		const board = makeBoard(makeCard());
		mockWorkspaceState(board);
		const harness = createHarness(board);

		const result = await harness.api.getAutoMergePolicy(SCOPE, { repository: "org/none" });
		expect(result).toEqual({ ok: true, repository: "org/none", policy: null });
	});

	it("normalizes the repository and returns the stored policy", async () => {
		const board = makeBoard(makeCard());
		mockWorkspaceState(board);
		const harness = createHarness(board);
		const created = await harness.api.updateAutoMergePolicy(SCOPE, {
			repository: "Cline/Kanban",
			requiredChecks: ["Build"],
			mergeMethod: "squash",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) {
			throw new Error("policy write failed");
		}
		const result = await harness.api.getAutoMergePolicy(SCOPE, { repository: "CLINE/kanban" });
		expect(result).toMatchObject({
			ok: true,
			repository: "cline/kanban",
			policy: { repository: "cline/kanban", requiredChecks: ["Build"], mergeMethod: "squash", revision: 1 },
		});
	});

	it("refuses an invalid repository and records an operator warning", async () => {
		const board = makeBoard(makeCard());
		mockWorkspaceState(board);
		const harness = createHarness(board);

		const result = await harness.api.updateAutoMergePolicy(SCOPE, {
			repository: "github.com/cline/kanban",
			requiredChecks: ["ci"],
		});
		expect(result).toMatchObject({ ok: false, reason: "invalid" });
		expect(harness.warnings.some((warning) => warning.includes("refused: invalid"))).toBe(true);
	});

	it("rejects a stale expectedRevision as a conflict", async () => {
		const board = makeBoard(makeCard());
		mockWorkspaceState(board);
		const harness = createHarness(board);
		await harness.api.updateAutoMergePolicy(SCOPE, { repository: "org/repo", requiredChecks: ["ci"] });

		const result = await harness.api.updateAutoMergePolicy(SCOPE, {
			repository: "org/repo",
			requiredChecks: ["ci", "docs"],
			expectedRevision: 0,
		});
		expect(result).toMatchObject({ ok: false, reason: "conflict" });
		expect(harness.warnings.some((warning) => warning.includes("refused: conflict"))).toBe(true);
	});
});

// AM-1: setTaskPrSettings arms the card against the resolved policy.
describe("pr-tracking api: settings auto-merge (AM-1)", () => {
	const SELECTED_KEY = PR_KEY;

	beforeEach(() => {
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();
	});

	function selectedBoard(card: RuntimeBoardCard): RuntimeBoardData {
		return makeBoard({ ...card, selectedAutomationPrKey: SELECTED_KEY });
	}

	it("cannot enable without a selected PR or a stored policy", async () => {
		mockWorkspaceState(makeBoard(makeCard()));
		const noSelection = createHarness(makeBoard(makeCard()));
		const noSelectionResult = await noSelection.api.setTaskPrSettings(SCOPE, {
			taskId: OPERATOR_TASK_ID,
			autoMergeWhenApproved: true,
		});
		expect(noSelectionResult).toMatchObject({ ok: false, reason: "no_selected_pr" });

		mockWorkspaceState(selectedBoard(makeCard()));
		const noPolicy = createHarness(selectedBoard(makeCard()));
		const noPolicyResult = await noPolicy.api.setTaskPrSettings(SCOPE, {
			taskId: OPERATOR_TASK_ID,
			autoMergeWhenApproved: true,
		});
		expect(noPolicyResult).toMatchObject({ ok: false, reason: "no_policy" });
	});

	it("arms at the policy revision and reports both values", async () => {
		const board = selectedBoard(makeCard());
		mockWorkspaceState(board);
		const harness = createHarness(board);
		await harness.api.updateAutoMergePolicy(SCOPE, { repository: "cline/kanban", requiredChecks: ["ci"] });

		const result = await harness.api.setTaskPrSettings(SCOPE, {
			taskId: OPERATOR_TASK_ID,
			autoMergeWhenApproved: true,
		});
		expect(result).toMatchObject({
			ok: true,
			autoMergeWhenApproved: true,
			armedAutoMergePolicyRevision: 1,
			reason: null,
		});
	});

	it("rejects when the policy belongs to a different repository", async () => {
		const board = selectedBoard(makeCard());
		mockWorkspaceState(board);
		const harness = createHarness(board);
		await harness.api.updateAutoMergePolicy(SCOPE, { repository: "other/repo", requiredChecks: ["ci"] });

		const result = await harness.api.setTaskPrSettings(SCOPE, {
			taskId: OPERATOR_TASK_ID,
			autoMergeWhenApproved: true,
		});
		expect(result).toMatchObject({ ok: false, reason: "no_policy" });
	});

	it("disarming drops the armed revision regardless of policies", async () => {
		const board = selectedBoard(makeCard({ autoMergeWhenApproved: true, armedAutoMergePolicyRevision: 2 }));
		mockWorkspaceState(board);
		const harness = createHarness(board);

		const result = await harness.api.setTaskPrSettings(SCOPE, {
			taskId: OPERATOR_TASK_ID,
			autoMergeWhenApproved: false,
		});
		expect(result).toMatchObject({
			ok: true,
			autoMergeWhenApproved: false,
			armedAutoMergePolicyRevision: null,
			reason: null,
		});
	});

	it("reports the auto-merge state in the tracking diagnostics", async () => {
		const board = selectedBoard(makeCard({ autoMergeWhenApproved: true, armedAutoMergePolicyRevision: 2 }));
		mockWorkspaceState(board);
		const harness = createHarness(board);

		const state = await harness.api.getTaskTrackingState(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(state).toMatchObject({
			ok: true,
			autoMergeWhenApproved: true,
			armedAutoMergePolicyRevision: 2,
		});
	});
});
