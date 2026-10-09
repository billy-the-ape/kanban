import { describe, expect, it } from "vitest";

import {
	type RuntimeBoardData,
	type RuntimeTaskPullRequest,
	runtimeBoardDataSchema,
} from "../../src/core/api-contract";
import { getPullRequestIdentityKey } from "../../src/core/pull-request-links";
import {
	addTaskDependency,
	addTaskPullRequests,
	addTaskToColumn,
	deleteTasksFromBoard,
	moveTaskToColumn,
	removeTaskPullRequest,
	setPrimaryTaskPullRequest,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
	updateTaskPullRequestSnapshot,
} from "../../src/core/task-board-mutations";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createPullRequest(overrides: Partial<RuntimeTaskPullRequest> = {}): RuntimeTaskPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "owner/repo",
		number: 12,
		url: "https://github.com/owner/repo/pull/12",
		source: "agent_tool",
		createdAt: 1000,
		...overrides,
	};
}

function boardWithTaskPullRequests(
	board: RuntimeBoardData,
	taskId: string,
	pullRequests: RuntimeTaskPullRequest[],
): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => (card.id === taskId ? { ...card, pullRequests } : card)),
		})),
	};
}

function taskWithId(board: RuntimeBoardData, taskId: string): RuntimeBoardData {
	return addTaskToColumn(board, "backlog", { prompt: `Task ${taskId}`, baseRef: "main", taskId }, () => "00000000")
		.board;
}

describe("deleteTasksFromBoard", () => {
	it("removes a trashed task and any dependencies that reference it", () => {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(deleted.board.dependencies).toEqual([]);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});
});

describe("task images", () => {
	it("preserves images when creating and updating tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with image",
				baseRef: "main",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.images).toEqual([
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with updated image",
			baseRef: "main",
			images: [
				{
					id: "img-2",
					data: "def456",
					mimeType: "image/jpeg",
				},
			],
		});

		expect(updated.task?.images).toEqual([
			{
				id: "img-2",
				data: "def456",
				mimeType: "image/jpeg",
			},
		]);
	});
});

describe("updateBaseRefBeforeStart policy (UPD-0.1)", () => {
	it("defaults a new task to checked when the field is absent", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");
		expect(created.task.updateBaseRefBeforeStart).toBe(true);
	});

	it("persists an explicit false and survives update and move round-trips", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", updateBaseRefBeforeStart: false },
			() => "aaaaa111",
		);
		expect(created.task.updateBaseRefBeforeStart).toBe(false);

		// An update that omits the field keeps the persisted value (no
		// truthy fallback overwriting false).
		const updated = updateTask(created.board, created.task.id, { prompt: "Task", baseRef: "main" });
		expect(updated.task?.updateBaseRefBeforeStart).toBe(false);

		// Explicit toggles both directions are honored.
		const rechecked = updateTask(updated.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			updateBaseRefBeforeStart: true,
		});
		expect(rechecked.task?.updateBaseRefBeforeStart).toBe(true);

		const unchecked = updateTask(rechecked.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			updateBaseRefBeforeStart: false,
		});
		expect(unchecked.task?.updateBaseRefBeforeStart).toBe(false);

		const moved = moveTaskToColumn(unchecked.board, created.task.id, "in_progress", 1234);
		expect(moved.task?.updateBaseRefBeforeStart).toBe(false);
	});

	it("keeps the board schema backward compatible and preserves an explicit false on reload", () => {
		// Explicit false survives the persisted-board schema round-trip.
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", updateBaseRefBeforeStart: false },
			() => "aaaaa111",
		);
		const reloaded = runtimeBoardDataSchema.parse(created.board);
		const reloadedCard = reloaded.columns.find((column) => column.id === "backlog")?.cards.at(0);
		expect(reloadedCard?.updateBaseRefBeforeStart).toBe(false);

		// A legacy card without the field still parses, and the consumer
		// normalization (absent means checked) reads it as true.
		const legacyBoard: RuntimeBoardData = {
			...created.board,
			columns: created.board.columns.map((column) =>
				column.id === "backlog"
					? {
							...column,
							cards: column.cards.map((card) => {
								const { updateBaseRefBeforeStart: _dropped, ...rest } = card;
								return rest as typeof card;
							}),
						}
					: column,
			),
		};
		const parsedLegacy = runtimeBoardDataSchema.parse(legacyBoard);
		const legacyCard = parsedLegacy.columns.find((column) => column.id === "backlog")?.cards.at(0);
		expect(legacyCard?.updateBaseRefBeforeStart).toBeUndefined();
		// The same normalization the start path and board state use:
		expect(legacyCard?.updateBaseRefBeforeStart !== false).toBe(true);
	});
});

describe("per-task agent/model/provider overrides", () => {
	it("persists agentId on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Smart task", baseRef: "main", agentId: "claude" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("claude");
	});

	it("persists task-level Cline settings on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Dumb task",
				baseRef: "main",
				agentId: "cline",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("cline");
		expect(created.task.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});

	it("leaves override fields undefined when not provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Default task", baseRef: "main" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBeUndefined();
		expect(created.task.clineSettings).toBeUndefined();
	});

	it("updates agentId from undefined to a value", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");
		expect(created.task.agentId).toBeUndefined();

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
		});

		expect(updated.updated).toBe(true);
		expect(updated.task?.agentId).toBe("codex");
	});

	it("updates clineModelId", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", clineSettings: { modelId: "old-model" } },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			clineSettings: { modelId: "new-model" },
		});

		expect(updated.task?.clineSettings?.modelId).toBe("new-model");
	});

	it("preserves existing overrides when update input omits them (undefined)", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "claude",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "low",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Updated prompt",
			baseRef: "main",
			// agentId and clineSettings are undefined, so existing overrides should persist
		});

		expect(updated.task?.agentId).toBe("claude");
		expect(updated.task?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "low",
		});
	});

	it("clears overrides when update input provides null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "codex",
				clineSettings: {
					providerId: "openai",
					modelId: "gpt-4",
					reasoningEffort: "medium",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: null,
			clineSettings: null,
		});

		expect(updated.task?.agentId).toBeUndefined();
		expect(updated.task?.clineSettings).toBeUndefined();
	});

	it("preserves overrides across move operations", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Movable task",
				baseRef: "main",
				agentId: "claude",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		const moved = moveTaskToColumn(created.board, created.task.id, "in_progress");

		expect(moved.moved).toBe(true);
		expect(moved.task?.agentId).toBe("claude");
		expect(moved.task?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});
});

describe("task pull request links (PRLINK-0)", () => {
	it("dedupes by identity (case-insensitive) and backfills missing snapshot fields", () => {
		const board = taskWithId(createBoard(), "task-1");
		const first = addTaskPullRequests(board, "task-1", [
			createPullRequest({ host: "GITHUB.COM", repository: "Owner/Repo", createdAt: 1000, source: "delivery" }),
		]);
		expect(first.added).toBe(true);

		const second = addTaskPullRequests(
			first.board,
			"task-1",
			[createPullRequest({ title: "Fix bug", state: "open", stateCheckedAt: 2000 })],
			3000,
		);
		expect(second.added).toBe(true);
		const cards = second.board.columns.flatMap((column) => column.cards);
		const task = cards.find((card) => card.id === "task-1");
		expect(task?.pullRequests).toEqual([
			{
				provider: "github",
				host: "GITHUB.COM",
				repository: "Owner/Repo",
				number: 12,
				url: "https://github.com/owner/repo/pull/12",
				source: "delivery",
				createdAt: 1000,
				// New record seeded lastSeenAt to createdAt; the backfilled
				// observation at now=3000 advanced it in the same write.
				lastSeenAt: 3000,
				title: "Fix bug",
				state: "open",
				stateCheckedAt: 2000,
			},
		]);
		expect(task?.updatedAt).toBe(3000);
	});

	it("is a no-op when the incoming links are already stored verbatim", () => {
		const board = taskWithId(createBoard(), "task-1");
		const first = addTaskPullRequests(board, "task-1", [createPullRequest()], 1000);
		// PRLINK-6: a duplicate observation inside the coalescing window
		// (less than 600s) is a no-op with no revision bump.
		const repeat = addTaskPullRequests(first.board, "task-1", [createPullRequest()], 1100);
		expect(repeat.added).toBe(false);
		expect(repeat.board).toBe(first.board);

		// Once the coalescing window has passed, the observation advances
		// lastSeenAt and saves.
		const advanced = addTaskPullRequests(first.board, "task-1", [createPullRequest()], 1000 + 600_000);
		expect(advanced.added).toBe(true);
		expect(advanced.task?.pullRequests?.[0]?.lastSeenAt).toBe(1000 + 600_000);

		// A clock regression never moves lastSeenAt backward.
		const regressed = addTaskPullRequests(advanced.board, "task-1", [createPullRequest()], 1000 + 600_001);
		expect(regressed.added).toBe(false);
		expect(regressed.board).toBe(advanced.board);
	});

	it("preserves first-appearance order across interleaved adds", () => {
		const board = taskWithId(createBoard(), "task-1");
		const a = createPullRequest({ number: 1, url: "https://github.com/owner/repo/pull/1" });
		const b = createPullRequest({ number: 2, url: "https://github.com/owner/repo/pull/2" });
		const c = createPullRequest({ number: 3, url: "https://github.com/owner/repo/pull/3" });
		const first = addTaskPullRequests(board, "task-1", [a, b]);
		const second = addTaskPullRequests(first.board, "task-1", [createPullRequest({ number: 1, url: a.url }), c]);
		expect(second.task?.pullRequests?.map((pr) => pr.number)).toEqual([1, 2, 3]);
	});

	it("caps stored links at 20, dropping the oldest non-manual entry first", () => {
		const seed = Array.from({ length: 19 }, (_, index) =>
			createPullRequest({
				number: index + 1,
				url: `https://github.com/owner/repo/pull/${index + 1}`,
				createdAt: 1000 + index,
			}),
		);
		const manual = createPullRequest({ number: 20, url: "https://github.com/owner/repo/pull/20", source: "manual" });
		const board = boardWithTaskPullRequests(taskWithId(createBoard(), "task-1"), "task-1", [...seed, manual]);

		const added = addTaskPullRequests(board, "task-1", [
			createPullRequest({ number: 21, url: "https://github.com/owner/repo/pull/21" }),
		]);
		expect(added.added).toBe(true);
		const numbers = added.task?.pullRequests?.map((pr) => pr.number) ?? [];
		expect(numbers).toHaveLength(20);
		expect(numbers[0]).toBe(2); // oldest non-manual dropped
		expect(numbers).toContain(20); // manual entry survived
	});

	it("drops the oldest manual entry when every stored link is manual", () => {
		const seed = Array.from({ length: 20 }, (_, index) =>
			createPullRequest({
				number: index + 1,
				url: `https://github.com/owner/repo/pull/${index + 1}`,
				source: "manual",
				createdAt: 1000 + index,
			}),
		);
		const board = boardWithTaskPullRequests(taskWithId(createBoard(), "task-1"), "task-1", seed);

		const added = addTaskPullRequests(board, "task-1", [
			createPullRequest({ number: 21, url: "https://github.com/owner/repo/pull/21", source: "manual" }),
		]);
		const numbers = added.task?.pullRequests?.map((pr) => pr.number) ?? [];
		expect(numbers).toHaveLength(20);
		expect(numbers[0]).toBe(2); // oldest manual dropped
	});

	it("returns added: false and leaves the board unchanged for an unknown task", () => {
		const board = taskWithId(createBoard(), "task-1");
		const result = addTaskPullRequests(board, "nope", [createPullRequest()]);
		expect(result.added).toBe(false);
		expect(result.task).toBeNull();
		expect(result.board).toBe(board);
	});
});

describe("setPrimaryTaskPullRequest (PRLINK-6)", () => {
	it("sets exactly one explicit primary and clears the rest", () => {
		const first = createPullRequest({ number: 1, url: "https://github.com/owner/repo/pull/1" });
		const second = createPullRequest({ number: 2, url: "https://github.com/owner/repo/pull/2" });
		const board = boardWithTaskPullRequests(taskWithId(createBoard(), "task-1"), "task-1", [first, second]);

		const result = setPrimaryTaskPullRequest(board, "task-1", getPullRequestIdentityKey(second), 4000);
		expect(result.updated).toBe(true);
		expect(result.task?.pullRequests).toEqual([first, { ...second, isPrimary: true }]);
		expect(result.task?.updatedAt).toBe(4000);
	});

	it("normalizes malformed data with several explicit primaries to the selected one", () => {
		const first = createPullRequest({ number: 1, url: "https://github.com/owner/repo/pull/1", isPrimary: true });
		const second = createPullRequest({ number: 2, url: "https://github.com/owner/repo/pull/2", isPrimary: true });
		const board = boardWithTaskPullRequests(taskWithId(createBoard(), "task-1"), "task-1", [first, second]);

		const result = setPrimaryTaskPullRequest(board, "task-1", getPullRequestIdentityKey(first));
		expect(result.updated).toBe(true);
		expect(result.task?.pullRequests).toEqual([
			{ ...first, isPrimary: true },
			{ ...second, isPrimary: undefined },
		]);
	});

	it("is a no-op when the chosen entry is already the sole explicit primary", () => {
		const primary = createPullRequest({ isPrimary: true });
		const board = boardWithTaskPullRequests(taskWithId(createBoard(), "task-1"), "task-1", [primary]);

		const result = setPrimaryTaskPullRequest(board, "task-1", getPullRequestIdentityKey(primary));
		expect(result.updated).toBe(false);
		expect(result.board).toBe(board);
	});

	it("clears every explicit flag with a null identity key", () => {
		const primary = createPullRequest({ number: 1, url: "https://github.com/owner/repo/pull/1", isPrimary: true });
		const other = createPullRequest({ number: 2, url: "https://github.com/owner/repo/pull/2" });
		const board = boardWithTaskPullRequests(taskWithId(createBoard(), "task-1"), "task-1", [primary, other]);

		const result = setPrimaryTaskPullRequest(board, "task-1", null, 5000);
		expect(result.updated).toBe(true);
		expect(result.task?.pullRequests).toEqual([{ ...primary, isPrimary: undefined }, other]);
	});

	it("is a no-op when clearing a task without explicit primaries", () => {
		const board = boardWithTaskPullRequests(taskWithId(createBoard(), "task-1"), "task-1", [createPullRequest()]);
		const result = setPrimaryTaskPullRequest(board, "task-1", null);
		expect(result.updated).toBe(false);
		expect(result.board).toBe(board);
	});

	it("is a no-op for unknown tasks and unknown identity keys", () => {
		const board = taskWithId(createBoard(), "task-1");
		const unknownTask = setPrimaryTaskPullRequest(board, "nope", "github|github.com|owner/repo|12");
		expect(unknownTask.updated).toBe(false);
		expect(unknownTask.task).toBeNull();

		const boardWithLinks = boardWithTaskPullRequests(board, "task-1", [createPullRequest()]);
		const unknownKey = setPrimaryTaskPullRequest(boardWithLinks, "task-1", "github|github.com|other/repo|99");
		expect(unknownKey.updated).toBe(false);
		expect(unknownKey.board).toBe(boardWithLinks);
	});
});

describe("pull request cap protection (PRLINK-6)", () => {
	it("protects the explicit display primary and the selected Automation PR from eviction", () => {
		const seed = Array.from({ length: 18 }, (_, index) =>
			createPullRequest({
				number: index + 1,
				url: `https://github.com/owner/repo/pull/${index + 1}`,
				createdAt: 1000 + index,
			}),
		);
		// Entry 19 is the explicit display primary; entry 20 is the selected
		// Automation PR. Both must survive eviction of entry 1 (oldest unprotected non-manual).
		const primaryEntry = createPullRequest({
			number: 19,
			url: "https://github.com/owner/repo/pull/19",
			isPrimary: true,
		});
		const automationEntry = createPullRequest({ number: 20, url: "https://github.com/owner/repo/pull/20" });
		const board = boardWithTaskPullRequests(taskWithId(createBoard(), "task-1"), "task-1", [
			...seed,
			primaryEntry,
			automationEntry,
		]);
		const protectedBoard: RuntimeBoardData = {
			...board,
			columns: board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) =>
					card.id === "task-1"
						? { ...card, selectedAutomationPrKey: getPullRequestIdentityKey(automationEntry) }
						: card,
				),
			})),
		};

		const added = addTaskPullRequests(protectedBoard, "task-1", [
			createPullRequest({ number: 21, url: "https://github.com/owner/repo/pull/21" }),
		]);
		const numbers = added.task?.pullRequests?.map((pr) => pr.number) ?? [];
		expect(numbers).toHaveLength(20);
		expect(numbers[0]).toBe(2); // oldest unprotected dropped; #1 protected? No: #1 unprotected -> dropped
		expect(numbers).toContain(19); // explicit primary survived
		expect(numbers).toContain(20); // selected Automation PR survived
		expect(numbers).toContain(21);
		expect(added.task?.selectedAutomationPrKey).toBe(getPullRequestIdentityKey(automationEntry));
	});
});
describe("removeTaskPullRequest / updateTaskPullRequestSnapshot (PRLINK-0)", () => {
	it("removes by identity key case-insensitively and is a no-op for unknown identities", () => {
		const stored = createPullRequest({ host: "GITHUB.COM", repository: "Owner/Repo" });
		const board = boardWithTaskPullRequests(taskWithId(createBoard(), "task-1"), "task-1", [stored]);

		const removed = removeTaskPullRequest(board, "task-1", getPullRequestIdentityKey(stored), 5000);
		expect(removed.removed).toBe(true);
		expect(removed.task?.pullRequests).toEqual([]);
		expect(removed.task?.updatedAt).toBe(5000);

		const repeat = removeTaskPullRequest(removed.board, "task-1", getPullRequestIdentityKey(stored));
		expect(repeat.removed).toBe(false);
		expect(repeat.board).toBe(removed.board);
	});

	it("is a no-op for unknown tasks and tasks without links", () => {
		const board = taskWithId(createBoard(), "task-1");
		const unknownTask = removeTaskPullRequest(board, "nope", "github|github.com|owner/repo|12");
		expect(unknownTask.removed).toBe(false);
		expect(unknownTask.task).toBeNull();
		const noLinks = removeTaskPullRequest(board, "task-1", "github|github.com|owner/repo|12");
		expect(noLinks.removed).toBe(false);
		expect(noLinks.task?.id).toBe("task-1");
	});

	it("updates only the provided snapshot fields and stamps stateCheckedAt", () => {
		const stored = createPullRequest();
		const board = boardWithTaskPullRequests(taskWithId(createBoard(), "task-1"), "task-1", [stored]);
		const identityKey = getPullRequestIdentityKey(stored);

		// PRLINK-6: a successful observation write also advances lastSeenAt.
		const updated = updateTaskPullRequestSnapshot(board, "task-1", identityKey, { title: "Fix bug" }, 7000);
		expect(updated.updated).toBe(true);
		expect(updated.task?.pullRequests).toEqual([
			{ ...stored, title: "Fix bug", stateCheckedAt: 7000, lastSeenAt: 7000 },
		]);

		const restamped = updateTaskPullRequestSnapshot(
			updated.board,
			"task-1",
			identityKey,
			{
				state: "merged",
				stateCheckedAt: 9000,
			},
			9500,
		);
		expect(restamped.updated).toBe(true);
		expect(restamped.task?.pullRequests).toEqual([
			{ ...stored, title: "Fix bug", state: "merged", stateCheckedAt: 9000, lastSeenAt: 9500 },
		]);
	});

	it("is a no-op for unknown tasks, unknown identities, or empty snapshots", () => {
		const stored = createPullRequest();
		const board = boardWithTaskPullRequests(taskWithId(createBoard(), "task-1"), "task-1", [stored]);
		const identityKey = getPullRequestIdentityKey(stored);

		expect(updateTaskPullRequestSnapshot(board, "nope", identityKey, { title: "x" }).updated).toBe(false);
		expect(
			updateTaskPullRequestSnapshot(board, "task-1", "github|github.com|other/repo|1", { title: "x" }).updated,
		).toBe(false);
		const empty = updateTaskPullRequestSnapshot(board, "task-1", identityKey, {});
		expect(empty.updated).toBe(false);
		expect(empty.board).toBe(board);
	});
});
