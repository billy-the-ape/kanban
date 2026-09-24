// B-9 unit tests: receipt-based readiness resolution, worker slot accounting,
// fresh-context prompt building, dispatch orchestration (durable records,
// board ownership moves, bounded retries), and restart reconciliation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseTaskIdForReviewSessionId } from "../../src/cline-sdk/cline-review-session-service";
import type { RuntimeConfigState } from "../../src/config/runtime-config";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeGitDeliveryReceipt,
	RuntimeTaskDispatchRecord,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
} from "../../src/core/api-contract";
import { readTaskDispatchRecord, writeTaskDispatchRecord } from "../../src/task-dispatch/dispatch-records";
import {
	buildFreshDispatchPrompt,
	dispatchReadyTasks,
	getActiveWorkerTaskIds,
	getTaskDispatchStatus,
	reconcileTaskDispatch,
	resolveReadyTasks,
	TASK_DISPATCH_RETRY_CAP,
	type TaskDispatchDeps,
} from "../../src/task-dispatch/task-dispatch-service";

const WORKSPACE_ID = "ws-dispatch-unit";

function createCard(id: string, overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: `Prompt for ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createDependency(id: string, fromTaskId: string, toTaskId: string): RuntimeBoardDependency {
	return { id, fromTaskId, toTaskId, createdAt: 1 };
}

function createBoard(
	options: {
		cardsByColumn?: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>;
		dependencies?: RuntimeBoardDependency[];
	} = {},
): RuntimeBoardData {
	const cardsByColumn = options.cardsByColumn ?? {};
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: cardsByColumn.backlog ?? [] },
			{ id: "in_progress", title: "In Progress", cards: cardsByColumn.in_progress ?? [] },
			{ id: "review", title: "Review", cards: cardsByColumn.review ?? [] },
			{ id: "done", title: "Done", cards: cardsByColumn.done ?? [] },
			{ id: "trash", title: "Trash", cards: cardsByColumn.trash ?? [] },
		],
		dependencies: options.dependencies ?? [],
	};
}

function createSummary(
	taskId: string,
	state: RuntimeTaskSessionState,
	agentId: RuntimeAgentId | null = null,
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

function createReceipt(
	taskId: string,
	status: "delivered" | "no_op" | "paused" | "failed",
	overrides: Partial<RuntimeGitDeliveryReceipt> = {},
): RuntimeGitDeliveryReceipt {
	return {
		taskId,
		workspaceId: WORKSPACE_ID,
		repoPath: "/repo",
		worktreePath: `/wt/${taskId}`,
		baseRef: "main",
		baseSha: null,
		destinationBranch: "main",
		remote: "origin",
		remoteBranchSha: null,
		taskCommitSha: status === "no_op" ? null : `${taskId}-commit`,
		integratedSha: status === "no_op" ? null : `${taskId}-integrated`,
		status,
		stage: status === "delivered" ? "pushed" : "validated",
		policy: {
			enabled: true,
			remote: "origin",
			destinationBranch: "main",
			pushRequired: true,
			protectedBranches: ["main"],
			integrationStrategy: "fast_forward",
			requirePullRequest: false,
			pullRequestBaseBranch: null,
		},
		commitMessageSource: null,
		stagedPaths: [],
		excludedPaths: [],
		reviewOutcome: null,
		verificationPassed: null,
		candidateTreeHash: null,
		combinedVerificationPassed: null,
		pr: null,
		evidence: [],
		attempt: 1,
		startedAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

interface CreateTestDepsOptions {
	board?: RuntimeBoardData;
	receipts?: Map<string, RuntimeGitDeliveryReceipt | null>;
	terminalSummaries?: RuntimeTaskSessionSummary[];
	clineSummaries?: RuntimeTaskSessionSummary[];
	reviewSummaries?: RuntimeTaskSessionSummary[];
	enabled?: boolean;
	workerLimit?: number;
	startSessionError?: string;
	prepareWorktree?: TaskDispatchDeps["prepareWorktree"];
}

function createTestDeps(options: CreateTestDepsOptions = {}) {
	let board = options.board ?? createBoard();
	const receipts = options.receipts ?? new Map<string, RuntimeGitDeliveryReceipt | null>();
	const startedTasks: Array<{ taskId: string; baseRef: string; prompt: string; taskTitle: string }> = [];
	let stateUpdateCount = 0;
	const config = {
		taskDispatchPolicy: { enabled: options.enabled ?? true, workerLimit: options.workerLimit ?? 1 },
	} as unknown as RuntimeConfigState;
	const deps: TaskDispatchDeps = {
		workspaceId: WORKSPACE_ID,
		workspacePath: "/repo",
		loadConfig: () => Promise.resolve(config),
		loadBoard: () => Promise.resolve(board),
		persistBoard: async (mutate) => {
			board = mutate(board);
		},
		listTerminalSummaries: () => Promise.resolve(options.terminalSummaries ?? []),
		listClineSummaries: () => Promise.resolve(options.clineSummaries ?? []),
		listReviewSessionSummaries: () => Promise.resolve(options.reviewSummaries ?? []),
		readReceipt: (taskId) => Promise.resolve(receipts.get(taskId) ?? null),
		startSession: async (input) => {
			startedTasks.push(input);
			if (options.startSessionError) {
				return { ok: false, error: options.startSessionError };
			}
			return { ok: true, summary: createSummary(input.taskId, "running", "cline") };
		},
		prepareWorktree:
			options.prepareWorktree ??
			(async (input) => ({
				ok: true,
				worktreePath: `/wt/${input.taskId}`,
				baseSha: "b".repeat(40),
				error: null,
			})),
		onStateUpdated: () => {
			stateUpdateCount += 1;
		},
	};
	return {
		deps,
		startedTasks,
		getBoard: () => board,
		getStateUpdateCount: () => stateUpdateCount,
	};
}

function readinessInputFor(board: RuntimeBoardData, receipts: Map<string, RuntimeGitDeliveryReceipt | null>) {
	const columnIdFor = (taskId: string): RuntimeBoardColumnId | null => {
		for (const column of board.columns) {
			if (column.cards.some((card) => card.id === taskId)) {
				return column.id;
			}
		}
		return null;
	};
	return {
		board,
		workspaceId: WORKSPACE_ID,
		prereqStatus: (taskId: string) => ({
			columnId: columnIdFor(taskId),
			receipt: receipts.get(taskId) ?? null,
		}),
	};
}

function findEntry(result: ReturnType<typeof resolveReadyTasks>, taskId: string) {
	const entry = result.find((candidate) => candidate.taskId === taskId);
	if (!entry) {
		throw new Error(`No readiness entry for ${taskId}`);
	}
	return entry;
}

// The dispatch layer reads/writes records and locks under the runtime home
// (via os.homedir()); point HOME at a temp dir so unit tests never touch the
// real task-state home.
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let tempHome: string;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-dispatch-test-"));
	previousHome = process.env.HOME;
	previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
});

afterEach(() => {
	if (previousHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = previousHome;
	}
	if (previousUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = previousUserProfile;
	}
	rmSync(tempHome, { recursive: true, force: true });
});

describe("resolveReadyTasks", () => {
	const receipts = new Map<string, RuntimeGitDeliveryReceipt | null>();

	// The map is shared by the tests in this block; reset it per test.
	beforeEach(() => {
		receipts.clear();
	});

	it("treats a card with no dependencies as ready", () => {
		const board = createBoard({
			cardsByColumn: { backlog: [createCard("solo")] },
		});
		const result = resolveReadyTasks(readinessInputFor(board, receipts));
		expect(result).toHaveLength(1);
		expect(findEntry(result, "solo")).toMatchObject({ ready: true, reason: null, prerequisites: [] });
	});

	it("blocks when a prerequisite is not in the done column", () => {
		const board = createBoard({
			cardsByColumn: { backlog: [createCard("b")] },
			dependencies: [createDependency("dep-b-a", "b", "a")],
		});
		const entry = findEntry(resolveReadyTasks(readinessInputFor(board, receipts)), "b");
		expect(entry.ready).toBe(false);
		expect((entry as { code: string }).code).toBe("prerequisite_in_progress");
	});

	it("blocks when the prerequisite is done but has no delivery receipt", () => {
		const board = createBoard({
			cardsByColumn: { backlog: [createCard("b")], done: [createCard("a")] },
			dependencies: [createDependency("dep-b-a", "b", "a")],
		});
		const entry = findEntry(resolveReadyTasks(readinessInputFor(board, receipts)), "b");
		expect(entry.ready).toBe(false);
		expect((entry as { code: string }).code).toBe("prerequisite_delivery_missing");
	});

	it("blocks when the prerequisite delivery is paused", () => {
		const board = createBoard({
			cardsByColumn: { backlog: [createCard("b")], done: [createCard("a")] },
			dependencies: [createDependency("dep-b-a", "b", "a")],
		});
		receipts.set("a", createReceipt("a", "paused"));
		const entry = findEntry(resolveReadyTasks(readinessInputFor(board, receipts)), "b");
		expect(entry.ready).toBe(false);
		expect((entry as { code: string }).code).toBe("prerequisite_delivery_paused");
	});

	it("blocks when the prerequisite delivery failed", () => {
		const board = createBoard({
			cardsByColumn: { backlog: [createCard("b")], done: [createCard("a")] },
			dependencies: [createDependency("dep-b-a", "b", "a")],
		});
		receipts.set("a", createReceipt("a", "failed"));
		const entry = findEntry(resolveReadyTasks(readinessInputFor(board, receipts)), "b");
		expect(entry.ready).toBe(false);
		expect((entry as { code: string }).code).toBe("prerequisite_delivery_failed");
	});

	it("is ready when the prerequisite is delivered", () => {
		const board = createBoard({
			cardsByColumn: { backlog: [createCard("b")], done: [createCard("a")] },
			dependencies: [createDependency("dep-b-a", "b", "a")],
		});
		receipts.set("a", createReceipt("a", "delivered"));
		const entry = findEntry(resolveReadyTasks(readinessInputFor(board, receipts)), "b");
		expect(entry.ready).toBe(true);
		expect((entry as { prerequisites: unknown[] }).prerequisites).toHaveLength(1);
	});

	it("is ready when the prerequisite was a no-op delivery", () => {
		const board = createBoard({
			cardsByColumn: { backlog: [createCard("b")], done: [createCard("a")] },
			dependencies: [createDependency("dep-b-a", "b", "a")],
		});
		receipts.set("a", createReceipt("a", "no_op"));
		const entry = findEntry(resolveReadyTasks(readinessInputFor(board, receipts)), "b");
		expect(entry.ready).toBe(true);
	});

	it("resolves a linear chain (b ready after a; c blocked until b is done)", () => {
		const board = createBoard({
			cardsByColumn: {
				backlog: [createCard("b"), createCard("c")],
				done: [createCard("a")],
			},
			dependencies: [createDependency("dep-b-a", "b", "a"), createDependency("dep-c-b", "c", "b")],
		});
		receipts.set("a", createReceipt("a", "delivered"));
		const result = resolveReadyTasks(readinessInputFor(board, receipts));
		expect(findEntry(result, "b").ready).toBe(true);
		const c = findEntry(result, "c");
		expect(c.ready).toBe(false);
		expect((c as { code: string }).code).toBe("prerequisite_in_progress");
	});

	it("resolves a diamond (both parents must be delivered)", () => {
		const board = createBoard({
			cardsByColumn: {
				backlog: [createCard("d")],
				done: [createCard("a"), createCard("b"), createCard("c")],
			},
			dependencies: [
				createDependency("dep-b-a", "b", "a"),
				createDependency("dep-c-a", "c", "a"),
				createDependency("dep-d-b", "d", "b"),
				createDependency("dep-d-c", "d", "c"),
			],
		});
		receipts.set("a", createReceipt("a", "delivered"));
		receipts.set("b", createReceipt("b", "delivered"));
		receipts.set("c", createReceipt("c", "no_op"));
		const entry = findEntry(resolveReadyTasks(readinessInputFor(board, receipts)), "d");
		expect(entry.ready).toBe(true);
		const prereqs = (entry as { prerequisites: { taskId: string }[] }).prerequisites;
		expect(prereqs.map((prereq) => prereq.taskId).sort()).toEqual(["b", "c"]);
	});

	it("stays blocked on a diamond until every parent is delivered", () => {
		const board = createBoard({
			cardsByColumn: {
				backlog: [createCard("d")],
				done: [createCard("a"), createCard("b"), createCard("c")],
			},
			dependencies: [
				createDependency("dep-b-a", "b", "a"),
				createDependency("dep-c-a", "c", "a"),
				createDependency("dep-d-b", "d", "b"),
				createDependency("dep-d-c", "d", "c"),
			],
		});
		receipts.set("a", createReceipt("a", "delivered"));
		receipts.set("b", createReceipt("b", "delivered"));
		// "c" is done but was never delivered.
		const entry = findEntry(resolveReadyTasks(readinessInputFor(board, receipts)), "d");
		expect(entry.ready).toBe(false);
	});

	it("ignores receipts that belong to another workspace", () => {
		const board = createBoard({
			cardsByColumn: { backlog: [createCard("b")], done: [createCard("a")] },
			dependencies: [createDependency("dep-b-a", "b", "a")],
		});
		receipts.set("a", createReceipt("a", "delivered", { workspaceId: "other-workspace" }));
		const entry = findEntry(resolveReadyTasks(readinessInputFor(board, receipts)), "b");
		expect(entry.ready).toBe(false);
		expect((entry as { code: string }).code).toBe("prerequisite_delivery_missing");
	});

	it("records a circular dependency as blocked rather than dispatching", () => {
		// Corrupted board: a duplicate edge to a delivered prerequisite trips the
		// cycle guard (single-edge cycles are impossible by board invariants).
		const board = createBoard({
			cardsByColumn: { backlog: [createCard("a")], done: [createCard("b")] },
			dependencies: [createDependency("dep-a-b-1", "a", "b"), createDependency("dep-a-b-2", "a", "b")],
		});
		receipts.set("b", createReceipt("b", "delivered"));
		const entry = findEntry(resolveReadyTasks(readinessInputFor(board, receipts)), "a");
		expect(entry.ready).toBe(false);
		expect((entry as { code: string }).code).toBe("prerequisite_cycle");
	});
});

describe("getActiveWorkerTaskIds", () => {
	it("counts running and awaiting-review sessions as held slots", () => {
		const ids = getActiveWorkerTaskIds([
			createSummary("t-running", "running"),
			createSummary("t-review", "awaiting_review"),
		]);
		expect(ids.sort()).toEqual(["t-review", "t-running"]);
	});

	it("ignores idle, failed, interrupted, and home-agent sessions", () => {
		const ids = getActiveWorkerTaskIds([
			createSummary("t-idle", "idle"),
			createSummary("t-failed", "failed"),
			createSummary("t-interrupted", "interrupted"),
			createSummary("__home_agent__:ws:cline", "running"),
		]);
		expect(ids).toEqual([]);
	});
});

describe("B-11 shared worker budget", () => {
	const linearBoard = () =>
		createBoard({
			cardsByColumn: {
				backlog: [createCard("b")],
				done: [createCard("a")],
			},
			dependencies: [createDependency("dep-b-a", "b", "a")],
		});
	const deliveredReceipts = () => new Map([["a", createReceipt("a", "delivered")]]);

	it("counts a running review session against the shared worker budget", async () => {
		const { deps, startedTasks } = createTestDeps({
			board: linearBoard(),
			receipts: deliveredReceipts(),
			reviewSummaries: [createSummary("a::review", "running")],
		});
		const response = await dispatchReadyTasks(deps);
		expect(response.dispatchedTaskId).toBeNull();
		expect(response.skippedReason).toBe("worker_busy");
		expect(startedTasks).toHaveLength(0);
	});

	it("counts review sessions for distinct tasks as distinct slots", async () => {
		const board = createBoard({
			cardsByColumn: {
				backlog: [createCard("b"), createCard("c")],
				done: [createCard("a")],
			},
			dependencies: [createDependency("dep-b-a", "b", "a"), createDependency("dep-c-a", "c", "a")],
		});
		const { deps, startedTasks } = createTestDeps({
			board,
			receipts: deliveredReceipts(),
			workerLimit: 2,
			terminalSummaries: [createSummary("w", "running")],
			reviewSummaries: [createSummary("a::review", "running")],
		});
		const response = await dispatchReadyTasks(deps);
		// Two distinct holders (w + a) fill a limit of 2 → the ready tasks wait.
		expect(response.dispatchedTaskId).toBeNull();
		expect(response.skippedReason).toBe("worker_busy");
		expect(startedTasks).toHaveLength(0);

		// With a limit of 3, one slot is free and the first ready task dispatches.
		const open = createTestDeps({
			board,
			receipts: deliveredReceipts(),
			workerLimit: 3,
			terminalSummaries: [createSummary("w", "running")],
			reviewSummaries: [createSummary("a::review", "running")],
		});
		const second = await dispatchReadyTasks(open.deps);
		expect(second.dispatchedTaskId).toBe("b");
		expect(open.startedTasks.map((task) => task.taskId)).toEqual(["b"]);
	});

	it("counts a task and its own review/repair sessions as a single slot", async () => {
		const board = createBoard({
			cardsByColumn: {
				backlog: [createCard("b")],
				in_progress: [createCard("w")],
				done: [createCard("a")],
			},
			dependencies: [createDependency("dep-b-a", "b", "a")],
		});
		const reviewSummaries = [
			createSummary("w::review", "running"),
			createSummary("w::verification-repair-1", "running"),
		];
		// One holder (w) → the single slot is full even though three sessions run.
		const full = createTestDeps({
			board,
			receipts: deliveredReceipts(),
			terminalSummaries: [createSummary("w", "running")],
			reviewSummaries,
		});
		const busy = await dispatchReadyTasks(full.deps);
		expect(busy.skippedReason).toBe("worker_busy");
		expect(full.startedTasks).toHaveLength(0);

		// A second free slot dispatches the ready task.
		const open = createTestDeps({
			board,
			receipts: deliveredReceipts(),
			workerLimit: 2,
			terminalSummaries: [createSummary("w", "running")],
			reviewSummaries,
		});
		const dispatched = await dispatchReadyTasks(open.deps);
		expect(dispatched.dispatchedTaskId).toBe("b");
	});

	it("reports every active worker task (including review sessions) in the dispatch status", async () => {
		const { deps } = createTestDeps({
			board: linearBoard(),
			receipts: deliveredReceipts(),
			terminalSummaries: [createSummary("w", "running")],
			reviewSummaries: [createSummary("a::review", "running")],
		});
		const status = await getTaskDispatchStatus(deps);
		expect(status.activeWorkerTaskId).toBe("w");
		expect(status.activeWorkerTaskIds).toEqual(["w", "a"]);
	});
});

describe("baseTaskIdForReviewSessionId", () => {
	it("maps review session ids to their base task id", () => {
		expect(baseTaskIdForReviewSessionId("task-1::review")).toBe("task-1");
		expect(baseTaskIdForReviewSessionId("task-1::verification-repair-1")).toBe("task-1");
		expect(baseTaskIdForReviewSessionId("task-1::verification-repair-12")).toBe("task-1");
	});

	it("returns null for non-review session ids", () => {
		expect(baseTaskIdForReviewSessionId("task-1")).toBeNull();
		expect(baseTaskIdForReviewSessionId("__home_agent__:ws:cline")).toBeNull();
	});
});

describe("buildFreshDispatchPrompt", () => {
	it("includes the task identity, verified base, and prerequisite results", () => {
		const prompt = buildFreshDispatchPrompt({
			task: createCard("task-b", { title: "Build the thing" }),
			baseRef: "main",
			baseSha: "b".repeat(40),
			prerequisites: [
				{
					taskId: "task-a",
					integratedSha: "a".repeat(40),
					taskCommitSha: "c".repeat(40),
					deliveryStatus: "delivered",
				},
				{ taskId: "task-n", integratedSha: null, taskCommitSha: null, deliveryStatus: "no_op" },
			],
			titleByTaskId: { "task-a": "Prepare the base", "task-n": "No changes" },
		});
		expect(prompt).toContain("Build the thing");
		expect(prompt).toContain("main");
		expect(prompt).toContain("b".repeat(40));
		expect(prompt).toContain("Prepare the base");
		expect(prompt).toContain("a".repeat(40));
		expect(prompt).toContain("c".repeat(12));
		expect(prompt).toContain("no-op");
		expect(prompt).toContain("Prompt for task-b");
	});

	it("falls back to guidance when the card has no prompt", () => {
		const prompt = buildFreshDispatchPrompt({
			task: createCard("empty", { prompt: "   " }),
			baseRef: "main",
			baseSha: "b".repeat(40),
			prerequisites: [],
		});
		expect(prompt).toContain("No task prompt was provided");
	});
});

describe("dispatchReadyTasks", () => {
	const linearBoard = () =>
		createBoard({
			cardsByColumn: {
				backlog: [createCard("b")],
				done: [createCard("a")],
			},
			dependencies: [createDependency("dep-b-a", "b", "a")],
		});
	const deliveredReceipts = () => new Map([["a", createReceipt("a", "delivered")]]);

	it("dispatches a ready task: fresh prompt, ownership before launch, durable record", async () => {
		const { deps, startedTasks, getBoard, getStateUpdateCount } = createTestDeps({
			board: linearBoard(),
			receipts: deliveredReceipts(),
		});
		const response = await dispatchReadyTasks(deps);
		expect(response.dispatchedTaskId).toBe("b");
		expect(response.skippedReason).toBeNull();
		expect(startedTasks).toHaveLength(1);
		expect(startedTasks[0]?.taskId).toBe("b");
		expect(startedTasks[0]?.prompt).toContain("Fresh Kanban task session");
		expect(startedTasks[0]?.taskTitle).toBe("b");
		// Ownership moved to in_progress before the session started.
		expect(
			getBoard()
				.columns.find((column) => column.id === "in_progress")
				?.cards.map((card) => card.id),
		).toEqual(["b"]);
		expect(getStateUpdateCount()).toBeGreaterThan(0);
		const record = await readTaskDispatchRecord("b");
		expect(record?.status).toBe("dispatched");
		expect(record?.attempt).toBe(1);
		expect(record?.baseSha).toBe("b".repeat(40));
		expect(record?.prompt).toBe(startedTasks[0]?.prompt);
	});

	it("is a no-op when the policy is disabled", async () => {
		const { deps, startedTasks, getBoard } = createTestDeps({
			board: linearBoard(),
			receipts: deliveredReceipts(),
			enabled: false,
		});
		const response = await dispatchReadyTasks(deps);
		expect(response.dispatchedTaskId).toBeNull();
		expect(response.skippedReason).toBe("disabled");
		expect(startedTasks).toHaveLength(0);
		expect(
			getBoard()
				.columns.find((column) => column.id === "backlog")
				?.cards.map((card) => card.id),
		).toEqual(["b"]);
	});

	it("skips when the only worker slot is held", async () => {
		const { deps, startedTasks } = createTestDeps({
			board: linearBoard(),
			receipts: deliveredReceipts(),
			terminalSummaries: [createSummary("other-task", "running")],
		});
		const response = await dispatchReadyTasks(deps);
		expect(response.dispatchedTaskId).toBeNull();
		expect(response.skippedReason).toBe("worker_busy");
		expect(startedTasks).toHaveLength(0);
	});

	it("reports no_ready_tasks when the backlog has nothing ready", async () => {
		const { deps } = createTestDeps({ board: createBoard() });
		const response = await dispatchReadyTasks(deps);
		expect(response.dispatchedTaskId).toBeNull();
		expect(response.skippedReason).toBe("no_ready_tasks");
	});

	it("honors the worker limit by dispatching backlog order", async () => {
		const { deps, startedTasks } = createTestDeps({
			board: createBoard({
				cardsByColumn: { backlog: [createCard("first"), createCard("second")] },
			}),
			workerLimit: 1,
		});
		const response = await dispatchReadyTasks(deps);
		expect(response.dispatchedTaskId).toBe("first");
		expect(startedTasks.map((entry) => entry.taskId)).toEqual(["first"]);
		// The still-ready task is surfaced for the next pass.
		expect(response.readyTasks.map((view) => view.taskId)).toEqual(["second"]);
	});

	it("returns the card to backlog and records the failure when the session start fails", async () => {
		const { deps, getBoard } = createTestDeps({
			board: linearBoard(),
			receipts: deliveredReceipts(),
			startSessionError: "agent binary not found",
		});
		const response = await dispatchReadyTasks(deps);
		expect(response.dispatchedTaskId).toBeNull();
		expect(response.blockedTasks.map((view) => view.taskId)).toEqual(["b"]);
		expect(response.blockedTasks[0]?.blockedReason).toContain("agent binary not found");
		expect(
			getBoard()
				.columns.find((column) => column.id === "backlog")
				?.cards.map((card) => card.id),
		).toEqual(["b"]);
		const record = await readTaskDispatchRecord("b");
		expect(record?.status).toBe("failed");
		expect(record?.attempt).toBe(1);
	});

	it("retries failed launches up to the cap, then blocks as exhausted", async () => {
		const { deps, startedTasks, getBoard } = createTestDeps({
			board: linearBoard(),
			receipts: deliveredReceipts(),
			startSessionError: "agent binary not found",
		});
		for (let attempt = 0; attempt < TASK_DISPATCH_RETRY_CAP; attempt += 1) {
			await dispatchReadyTasks(deps);
		}
		expect(startedTasks).toHaveLength(TASK_DISPATCH_RETRY_CAP);
		const record = await readTaskDispatchRecord("b");
		expect(record?.status).toBe("exhausted");
		// The next pass must not dispatch again.
		const response = await dispatchReadyTasks(deps);
		expect(response.dispatchedTaskId).toBeNull();
		expect(startedTasks).toHaveLength(TASK_DISPATCH_RETRY_CAP);
		expect(response.blockedTasks[0]?.blockedReason).toContain("exhausted");
		expect(
			getBoard()
				.columns.find((column) => column.id === "backlog")
				?.cards.map((card) => card.id),
		).toEqual(["b"]);
	});

	it("blocks the task when worktree baseline verification fails (stale base)", async () => {
		const { deps, startedTasks, getBoard } = createTestDeps({
			board: linearBoard(),
			receipts: deliveredReceipts(),
			prepareWorktree: async () => ({
				ok: false,
				worktreePath: "/wt/b",
				baseSha: "b".repeat(40),
				error: "Worktree does not contain delivered prerequisite work: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			}),
		});
		const response = await dispatchReadyTasks(deps);
		expect(response.dispatchedTaskId).toBeNull();
		expect(startedTasks).toHaveLength(0);
		expect(response.blockedTasks[0]?.blockedReason).toContain("does not contain delivered prerequisite work");
		expect(
			getBoard()
				.columns.find((column) => column.id === "backlog")
				?.cards.map((card) => card.id),
		).toEqual(["b"]);
		const record = await readTaskDispatchRecord("b");
		expect(record?.status).toBe("blocked");
	});
});

function dispatchRecordFor(
	taskId: string,
	overrides: Partial<RuntimeTaskDispatchRecord> = {},
): RuntimeTaskDispatchRecord {
	return {
		taskId,
		workspaceId: WORKSPACE_ID,
		baseRef: "main",
		baseSha: "b".repeat(40),
		attempt: 1,
		status: "dispatched",
		error: null,
		prerequisites: [],
		prompt: `Recorded prompt for ${taskId}`,
		agentId: "cline",
		dispatchedAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("reconcileTaskDispatch", () => {
	const inProgressBoard = () =>
		createBoard({
			cardsByColumn: { in_progress: [createCard("b")] },
		});

	it("is a no-op when the policy is disabled", async () => {
		await writeTaskDispatchRecord(dispatchRecordFor("b"));
		const { deps, startedTasks } = createTestDeps({ board: inProgressBoard(), enabled: false });
		const response = await reconcileTaskDispatch(deps);
		expect(response).toEqual({ relaunchedTaskIds: [], skippedTaskIds: [] });
		expect(startedTasks).toHaveLength(0);
	});

	it("relaunches a dispatched task whose session was lost, reusing the recorded prompt", async () => {
		await writeTaskDispatchRecord(dispatchRecordFor("b"));
		const { deps, startedTasks } = createTestDeps({ board: inProgressBoard() });
		const response = await reconcileTaskDispatch(deps);
		expect(response.relaunchedTaskIds).toEqual(["b"]);
		expect(response.skippedTaskIds).toEqual([]);
		expect(startedTasks).toHaveLength(1);
		expect(startedTasks[0]?.taskId).toBe("b");
		// Reuses the recorded prompt instead of rebuilding it.
		expect(startedTasks[0]?.prompt).toBe("Recorded prompt for b");
		const record = await readTaskDispatchRecord("b");
		expect(record?.status).toBe("dispatched");
		expect(record?.attempt).toBe(2);
	});

	it("rebuilds the prompt when the recorded one is empty", async () => {
		await writeTaskDispatchRecord(dispatchRecordFor("b", { prompt: "" }));
		const { deps, startedTasks } = createTestDeps({ board: inProgressBoard() });
		const response = await reconcileTaskDispatch(deps);
		expect(response.relaunchedTaskIds).toEqual(["b"]);
		expect(startedTasks[0]?.prompt).toContain("Fresh Kanban task session");
	});

	it("leaves tasks with a live session alone", async () => {
		await writeTaskDispatchRecord(dispatchRecordFor("b"));
		const { deps, startedTasks } = createTestDeps({
			board: inProgressBoard(),
			terminalSummaries: [createSummary("b", "running")],
		});
		const response = await reconcileTaskDispatch(deps);
		expect(response.relaunchedTaskIds).toEqual([]);
		expect(startedTasks).toHaveLength(0);
	});

	it("leaves tasks with a delivery receipt alone", async () => {
		await writeTaskDispatchRecord(dispatchRecordFor("b"));
		const { deps, startedTasks } = createTestDeps({
			board: inProgressBoard(),
			receipts: new Map([["b", createReceipt("b", "delivered")]]),
		});
		const response = await reconcileTaskDispatch(deps);
		expect(response.relaunchedTaskIds).toEqual([]);
		expect(startedTasks).toHaveLength(0);
	});

	it("leaves manually started tasks (no record) alone", async () => {
		const { deps, startedTasks } = createTestDeps({ board: inProgressBoard() });
		const response = await reconcileTaskDispatch(deps);
		expect(response.relaunchedTaskIds).toEqual([]);
		expect(startedTasks).toHaveLength(0);
	});

	it("blocks a task as exhausted and returns it to the backlog when the cap is hit", async () => {
		await writeTaskDispatchRecord(dispatchRecordFor("b", { attempt: TASK_DISPATCH_RETRY_CAP }));
		const { deps, startedTasks, getBoard } = createTestDeps({
			board: inProgressBoard(),
			startSessionError: "still failing",
		});
		const response = await reconcileTaskDispatch(deps);
		// attempt would become CAP + 1, so the task is finalized as exhausted.
		expect(response.relaunchedTaskIds).toEqual([]);
		expect(response.skippedTaskIds).toEqual(["b"]);
		expect(startedTasks).toHaveLength(0);
		const record = await readTaskDispatchRecord("b");
		expect(record?.status).toBe("exhausted");
		expect(
			getBoard()
				.columns.find((column) => column.id === "backlog")
				?.cards.map((card) => card.id),
		).toEqual(["b"]);
	});
});

describe("getTaskDispatchStatus", () => {
	it("reports policy, active worker, ready/blocked views, and records", async () => {
		const board = createBoard({
			cardsByColumn: {
				backlog: [createCard("b"), createCard("c")],
				in_progress: [createCard("w")],
				done: [createCard("a")],
			},
			dependencies: [createDependency("dep-b-a", "b", "a"), createDependency("dep-c-w", "c", "w")],
		});
		await writeTaskDispatchRecord(dispatchRecordFor("w"));
		const { deps } = createTestDeps({
			board,
			receipts: new Map([["a", createReceipt("a", "delivered")]]),
			terminalSummaries: [createSummary("w", "running")],
		});
		const status = await getTaskDispatchStatus(deps);
		expect(status.enabled).toBe(true);
		expect(status.workerLimit).toBe(1);
		expect(status.activeWorkerTaskId).toBe("w");
		expect(status.readyTasks.map((view) => view.taskId)).toEqual(["b"]);
		expect(status.blockedTasks.map((view) => view.taskId)).toEqual(["c"]);
		expect(status.blockedTasks[0]?.blockedReason).toContain("not done");
		expect(status.records.map((record) => record.taskId)).toEqual(["w"]);
	});
});
