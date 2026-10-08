// PRTRACK-1: trpc consumer API — diagnostics, settings writes, and operator
// force-release authorization.
import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceStateMocks = vi.hoisted(() => ({
	loadWorkspaceBoardById: vi.fn(),
	mutateWorkspaceState: vi.fn(),
}));

vi.mock("../../../src/state/workspace-state.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/state/workspace-state")>();
	return {
		...actual,
		loadWorkspaceBoardById: workspaceStateMocks.loadWorkspaceBoardById,
		mutateWorkspaceState: workspaceStateMocks.mutateWorkspaceState,
	};
});

import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData } from "../../../src/core/api-contract";
import { InMemoryPrRecordStore } from "../../../src/pr-tracking/in-memory-pr-record-store";
import { PrConsumerRegistry } from "../../../src/pr-tracking/pr-consumer-registry";
import { assignRepairOwner } from "../../../src/pr-tracking/pr-owner-selection";
import { reservePrOperation } from "../../../src/pr-tracking/pr-reservations";
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
	registry: PrConsumerRegistry;
	warnings: string[];
	api: ReturnType<typeof createPrTrackingApi>;
}

function createHarness(board: RuntimeBoardData, options: { writerActive?: boolean } = {}): ApiHarness {
	const store = new InMemoryPrRecordStore();
	const registry = new PrConsumerRegistry();
	const coordinator = createPrTrackingCoordinator({ store });
	const warnings: string[] = [];
	const api = createPrTrackingApi({
		getPrTrackingCoordinator: () => coordinator,
		getPrTrackingStore: () => store,
		getPrConsumerRegistry: () => registry,
		listManagedWorkspaceBoards: async () => [{ workspaceId: WORKSPACE_ID, board }],
		broadcastRuntimeWorkspaceStateUpdated: () => undefined,
		isTaskWriterActive: () => options.writerActive === true,
		runPrTrackingReconcilePass: async () => undefined,
		warn: (message: string) => {
			warnings.push(message);
		},
	});
	return { store, registry, warnings, api };
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

	it("reports comments_unsupported (not feature_unavailable) for a non-Cline task when the consumer is installed", async () => {
		const board = makeBoard(makeCard({ autoAddressComments: true, agentId: "codex" }));
		mockWorkspaceState(board);
		const harness = createHarness(board);
		harness.registry.registerConsumer("comments");

		const state = await harness.api.getTaskTrackingState(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(state.commentsSupportedForTask).toBe(false);
		expect(state.blockers).toContainEqual({
			kind: "comments_unsupported",
			message: "Comment follow-up automation requires a native Cline task.",
		});
	});

	it("reports feature_unavailable when the comments consumer is not installed (merge only)", async () => {
		const board = makeBoard(makeCard({ autoAddressComments: true }));
		mockWorkspaceState(board);
		const harness = createHarness(board);
		harness.registry.registerConsumer("mergeCompletion");

		const state = await harness.api.getTaskTrackingState(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(state.blockers).toContainEqual({
			kind: "feature_unavailable",
			message: "Comment follow-up automation is not installed in this runtime.",
		});
		expect(state.blockers.some((blocker) => blocker.kind === "comments_unsupported")).toBe(false);
	});

	it("supports comments for a native Cline task with the consumer installed", async () => {
		const board = makeBoard(makeCard({ autoAddressComments: true }));
		mockWorkspaceState(board);
		const harness = createHarness(board);
		harness.registry.registerConsumer("comments");

		const state = await harness.api.getTaskTrackingState(SCOPE, { taskId: OPERATOR_TASK_ID });
		expect(state.commentsSupportedForTask).toBe(true);
		expect(
			state.blockers.some(
				(blocker) => blocker.kind === "comments_unsupported" || blocker.kind === "feature_unavailable",
			),
		).toBe(false);
	});

	it("does not report the repair owner as deleted on the zero-consumer short-circuit", async () => {
		const board = makeBoard(makeCard({ autoAddressComments: true }));
		mockWorkspaceState(board);
		const harness = createHarness(board);
		// No consumers installed: the read path must short-circuit without a
		// board scan, and an existing owner must not surface as deleted.
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
});
