import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskClineSettings,
	RuntimeTaskImage,
	RuntimeTaskPullRequest,
} from "./api-contract";
import { getPullRequestIdentityKey } from "./pull-request-links";
import { createRandomHexId, createUniqueTaskId } from "./task-id";
import { resolveTaskTitle } from "./task-title";

export interface RuntimeCreateTaskInput {
	taskId?: string;
	title?: string;
	prompt: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	images?: RuntimeTaskImage[];
	agentId?: RuntimeAgentId;
	clineSettings?: RuntimeTaskClineSettings;
	baseRef: string;
	/** UPD-0: missing values normalize to true; an explicit false is persisted as false. */
	updateBaseRefBeforeStart?: boolean;
	/** PRTRACK-1: "Auto address comments"; default false, not persisted when omitted. */
	autoAddressComments?: boolean;
	/** PRTRACK-1: "Auto complete task when PR is merged"; default false, not persisted when omitted. */
	autoFinishOnMerge?: boolean;
}

export interface RuntimeUpdateTaskInput {
	title?: string;
	prompt: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	images?: RuntimeTaskImage[];
	agentId?: RuntimeAgentId | null;
	clineSettings?: RuntimeTaskClineSettings | null;
	baseRef: string;
	/** UPD-0: undefined keeps the card's existing policy; explicit values overwrite. */
	updateBaseRefBeforeStart?: boolean;
}

function normalizeTaskAutoReviewMode(value: RuntimeTaskAutoReviewMode | null | undefined): RuntimeTaskAutoReviewMode {
	if (value === "pr") {
		return value;
	}
	return "commit";
}

// Copy image metadata so board tasks do not retain caller-owned array or object references.
function cloneTaskImages(images?: RuntimeTaskImage[]): RuntimeTaskImage[] | undefined {
	return images && images.length > 0 ? images.map((image) => ({ ...image })) : undefined;
}

function cloneTaskClineSettings(settings?: RuntimeTaskClineSettings | null): RuntimeTaskClineSettings | undefined {
	if (settings === undefined || settings === null) {
		return undefined;
	}
	const providerId = settings.providerId?.trim();
	const modelId = settings.modelId?.trim();
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}

export interface RuntimeCreateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard;
}

export interface RuntimeMoveTaskResult {
	moved: boolean;
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	fromColumnId: RuntimeBoardColumnId | null;
}

export interface RuntimeUpdateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	updated: boolean;
}

export interface RuntimeAddTaskDependencyResult {
	board: RuntimeBoardData;
	added: boolean;
	reason?: "missing_task" | "same_task" | "duplicate" | "trash_task" | "non_backlog";
	dependency?: RuntimeBoardDependency;
}

export interface RuntimeRemoveTaskDependencyResult {
	board: RuntimeBoardData;
	removed: boolean;
}

export interface RuntimeTrashTaskResult extends RuntimeMoveTaskResult {
	readyTaskIds: string[];
}

export interface RuntimeDeleteTasksResult {
	board: RuntimeBoardData;
	deleted: boolean;
	deletedTaskIds: string[];
}

function collectExistingTaskIds(board: RuntimeBoardData): Set<string> {
	const existingIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			existingIds.add(card.id);
		}
	}
	return existingIds;
}

function collectTaskIds(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function createDependencyId(): string {
	return createRandomHexId(8);
}

function createDependencyPairKey(backlogTaskId: string, linkedTaskId: string): string {
	return `${backlogTaskId}::${linkedTaskId}`;
}

function hasDependencyPair(board: RuntimeBoardData, backlogTaskId: string, linkedTaskId: string): boolean {
	const pairKey = createDependencyPairKey(backlogTaskId, linkedTaskId);
	for (const dependency of board.dependencies) {
		const existing = resolveDependencyEndpoints(board, dependency.fromTaskId, dependency.toTaskId);
		if ("reason" in existing) {
			continue;
		}
		if (createDependencyPairKey(existing.backlogTaskId, existing.linkedTaskId) === pairKey) {
			return true;
		}
	}
	return false;
}

function findTaskLocation(
	board: RuntimeBoardData,
	taskId: string,
): {
	columnIndex: number;
	taskIndex: number;
	columnId: RuntimeBoardColumnId;
	task: RuntimeBoardCard;
} | null {
	for (const [columnIndex, column] of board.columns.entries()) {
		const taskIndex = column.cards.findIndex((card) => card.id === taskId);
		if (taskIndex === -1) {
			continue;
		}
		const task = column.cards[taskIndex];
		if (!task) {
			continue;
		}
		return {
			columnIndex,
			taskIndex,
			columnId: column.id,
			task,
		};
	}
	return null;
}

function resolveDependencyEndpoints(
	board: RuntimeBoardData,
	firstTaskId: string,
	secondTaskId: string,
	options?: { retainSettledPrerequisites?: boolean },
):
	| {
			backlogTaskId: string;
			linkedTaskId: string;
	  }
	| { reason: RuntimeAddTaskDependencyResult["reason"] } {
	const firstColumnId = getTaskColumnId(board, firstTaskId);
	const secondColumnId = getTaskColumnId(board, secondTaskId);
	if (!firstColumnId || !secondColumnId) {
		return { reason: "missing_task" };
	}
	const isSettled = (columnId: RuntimeBoardColumnId) => columnId === "done" || columnId === "trash";
	if (isSettled(firstColumnId) || isSettled(secondColumnId)) {
		// B-9: an existing edge from a backlog dependent to a prerequisite that
		// reached done or trash is retained as stored. The dispatch queue reads
		// it to require a delivery receipt (done) or to keep the dependent
		// blocked (trash) — dropping it would make the dependent look free.
		if (options?.retainSettledPrerequisites && firstColumnId === "backlog" && isSettled(secondColumnId)) {
			return { backlogTaskId: firstTaskId, linkedTaskId: secondTaskId };
		}
		return { reason: "trash_task" };
	}
	const firstIsBacklog = firstColumnId === "backlog";
	const secondIsBacklog = secondColumnId === "backlog";
	if (firstIsBacklog && secondIsBacklog) {
		return {
			backlogTaskId: firstTaskId,
			linkedTaskId: secondTaskId,
		};
	}
	if (!firstIsBacklog && !secondIsBacklog) {
		return { reason: "non_backlog" };
	}
	return firstIsBacklog
		? { backlogTaskId: firstTaskId, linkedTaskId: secondTaskId }
		: { backlogTaskId: secondTaskId, linkedTaskId: firstTaskId };
}

function getLinkedBacklogTaskIdsReadyAfterTaskCompleted(
	board: RuntimeBoardData,
	taskId: string,
	toColumnId: RuntimeBoardColumnId | null,
): string[] {
	// Completing a task (move to the done column) unblocks its linked backlog
	// tasks. Discarding a task (move to trash) never does: failed or thrown
	// away work must not start dependent work.
	if (!taskId || board.dependencies.length === 0 || toColumnId !== "done") {
		return [];
	}
	const readyTaskIds = new Set<string>();
	for (const dependency of board.dependencies) {
		if (dependency.toTaskId !== taskId) {
			continue;
		}
		if (getTaskColumnId(board, dependency.fromTaskId) !== "backlog") {
			continue;
		}
		readyTaskIds.add(dependency.fromTaskId);
	}
	return [...readyTaskIds];
}

export function updateTaskDependencies(board: RuntimeBoardData): RuntimeBoardData {
	if (board.dependencies.length === 0) {
		return board;
	}
	const taskIds = collectTaskIds(board);
	const dependencies: RuntimeBoardDependency[] = [];
	const existingPairs = new Set<string>();
	for (const dependency of board.dependencies) {
		const firstTaskId = dependency.fromTaskId.trim();
		const secondTaskId = dependency.toTaskId.trim();
		if (!firstTaskId || !secondTaskId || firstTaskId === secondTaskId) {
			continue;
		}
		if (!taskIds.has(firstTaskId) || !taskIds.has(secondTaskId)) {
			continue;
		}
		const resolved = resolveDependencyEndpoints(board, firstTaskId, secondTaskId, {
			// B-9: edges to done/trash prerequisites survive normalization so the
			// backend dispatch service can still see them. New links to done or
			// trash tasks remain rejected via the default (no-option) path.
			retainSettledPrerequisites: true,
		});
		if ("reason" in resolved) {
			continue;
		}
		const pairKey = createDependencyPairKey(resolved.backlogTaskId, resolved.linkedTaskId);
		if (existingPairs.has(pairKey)) {
			continue;
		}
		existingPairs.add(pairKey);
		dependencies.push({
			id: dependency.id,
			fromTaskId: resolved.backlogTaskId,
			toTaskId: resolved.linkedTaskId,
			createdAt: dependency.createdAt,
		});
	}
	if (
		dependencies.length === board.dependencies.length &&
		dependencies.every((dependency, index) => {
			const current = board.dependencies[index];
			return (
				current &&
				current.id === dependency.id &&
				current.fromTaskId === dependency.fromTaskId &&
				current.toTaskId === dependency.toTaskId &&
				current.createdAt === dependency.createdAt
			);
		})
	) {
		return board;
	}
	return {
		...board,
		dependencies,
	};
}

export function addTaskToColumn(
	board: RuntimeBoardData,
	columnId: RuntimeBoardColumnId,
	input: RuntimeCreateTaskInput,
	randomUuid: () => string,
	now: number = Date.now(),
): RuntimeCreateTaskResult {
	const prompt = input.prompt.trim();
	if (!prompt) {
		throw new Error("Task prompt is required.");
	}
	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		throw new Error("Task baseRef is required.");
	}
	const existingIds = collectExistingTaskIds(board);
	const explicitTaskId = input.taskId?.trim();
	if (explicitTaskId && existingIds.has(explicitTaskId)) {
		throw new Error(`Task "${explicitTaskId}" already exists.`);
	}
	const task: RuntimeBoardCard = {
		id: explicitTaskId || createUniqueTaskId(existingIds, randomUuid),
		title: resolveTaskTitle(input.title, prompt),
		prompt,
		startInPlanMode: Boolean(input.startInPlanMode),
		autoReviewEnabled: Boolean(input.autoReviewEnabled),
		autoReviewMode: normalizeTaskAutoReviewMode(input.autoReviewMode),
		images: cloneTaskImages(input.images),
		...(input.agentId ? { agentId: input.agentId } : {}),
		...(input.clineSettings !== undefined ? { clineSettings: cloneTaskClineSettings(input.clineSettings) } : {}),
		baseRef,
		// UPD-0: missing normalizes to true; explicit false survives.
		updateBaseRefBeforeStart: input.updateBaseRefBeforeStart !== false,
		// PRTRACK-1: persist explicit preferences only; omitted reads as false.
		...(input.autoAddressComments !== undefined ? { autoAddressComments: input.autoAddressComments } : {}),
		...(input.autoFinishOnMerge !== undefined ? { autoFinishOnMerge: input.autoFinishOnMerge } : {}),
		createdAt: now,
		updatedAt: now,
	};

	const targetColumnIndex = board.columns.findIndex((column) => column.id === columnId);
	if (targetColumnIndex === -1) {
		throw new Error(`Column ${columnId} not found.`);
	}

	const columns = board.columns.map((column, index) => {
		if (index !== targetColumnIndex) {
			return column;
		}
		return {
			...column,
			cards: [task, ...column.cards],
		};
	});

	return {
		board: {
			...board,
			columns,
		},
		task,
	};
}

export function getTaskColumnId(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return null;
	}
	const found = findTaskLocation(board, normalizedTaskId);
	return found ? found.columnId : null;
}

export function addTaskDependency(
	board: RuntimeBoardData,
	firstTaskId: string,
	secondTaskId: string,
): RuntimeAddTaskDependencyResult {
	const normalizedFirstTaskId = firstTaskId.trim();
	const normalizedSecondTaskId = secondTaskId.trim();
	if (!normalizedFirstTaskId || !normalizedSecondTaskId) {
		return { board, added: false, reason: "missing_task" };
	}
	if (normalizedFirstTaskId === normalizedSecondTaskId) {
		return { board, added: false, reason: "same_task" };
	}
	const resolved = resolveDependencyEndpoints(board, normalizedFirstTaskId, normalizedSecondTaskId);
	if ("reason" in resolved) {
		return { board, added: false, reason: resolved.reason };
	}
	if (hasDependencyPair(board, resolved.backlogTaskId, resolved.linkedTaskId)) {
		return { board, added: false, reason: "duplicate" };
	}
	const dependency: RuntimeBoardDependency = {
		id: createDependencyId(),
		fromTaskId: resolved.backlogTaskId,
		toTaskId: resolved.linkedTaskId,
		createdAt: Date.now(),
	};
	return {
		board: {
			...board,
			dependencies: [...board.dependencies, dependency],
		},
		added: true,
		dependency,
	};
}

export function canAddTaskDependency(board: RuntimeBoardData, firstTaskId: string, secondTaskId: string): boolean {
	const normalizedFirstTaskId = firstTaskId.trim();
	const normalizedSecondTaskId = secondTaskId.trim();
	if (!normalizedFirstTaskId || !normalizedSecondTaskId || normalizedFirstTaskId === normalizedSecondTaskId) {
		return false;
	}
	const resolved = resolveDependencyEndpoints(board, normalizedFirstTaskId, normalizedSecondTaskId);
	if ("reason" in resolved) {
		return false;
	}
	return !hasDependencyPair(board, resolved.backlogTaskId, resolved.linkedTaskId);
}

export function removeTaskDependency(board: RuntimeBoardData, dependencyId: string): RuntimeRemoveTaskDependencyResult {
	const dependencies = board.dependencies.filter((dependency) => dependency.id !== dependencyId);
	if (dependencies.length === board.dependencies.length) {
		return { board, removed: false };
	}
	return {
		board: {
			...board,
			dependencies,
		},
		removed: true,
	};
}

export function getReadyLinkedTaskIdsForTaskInDone(board: RuntimeBoardData, taskId: string): string[] {
	return getLinkedBacklogTaskIdsReadyAfterTaskCompleted(board, taskId, getTaskColumnId(board, taskId));
}

// Discarding a task (move to trash) does not unblock linked tasks, so the
// ready list is always empty. The move itself still happens so the card is
// persisted before any cleanup side effects run.
export function trashTaskAndGetReadyLinkedTaskIds(
	board: RuntimeBoardData,
	taskId: string,
	now: number = Date.now(),
): RuntimeTrashTaskResult {
	const movedToTrash = moveTaskToColumn(board, taskId, "trash", now);
	return {
		...movedToTrash,
		readyTaskIds: [],
	};
}

export function completeTaskAndGetReadyLinkedTaskIds(
	board: RuntimeBoardData,
	taskId: string,
	now: number = Date.now(),
): RuntimeTrashTaskResult {
	const readyTaskIds = getLinkedBacklogTaskIdsReadyAfterTaskCompleted(board, taskId, "done");
	const movedToDone = moveTaskToColumn(board, taskId, "done", now);
	return {
		...movedToDone,
		readyTaskIds: movedToDone.moved ? readyTaskIds : [],
	};
}

export function deleteTasksFromBoard(board: RuntimeBoardData, taskIds: Iterable<string>): RuntimeDeleteTasksResult {
	const normalizedTaskIds = new Set(
		Array.from(taskIds, (taskId) => taskId.trim()).filter((taskId) => taskId.length > 0),
	);
	if (normalizedTaskIds.size === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
		};
	}

	const deletedTaskIds: string[] = [];
	const columns = board.columns.map((column) => {
		const remainingCards = column.cards.filter((card) => {
			if (!normalizedTaskIds.has(card.id)) {
				return true;
			}
			deletedTaskIds.push(card.id);
			return false;
		});
		return remainingCards.length === column.cards.length ? column : { ...column, cards: remainingCards };
	});

	if (deletedTaskIds.length === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
		};
	}

	const deletedTaskIdSet = new Set(deletedTaskIds);
	const dependencies = board.dependencies.filter(
		(dependency) => !deletedTaskIdSet.has(dependency.fromTaskId) && !deletedTaskIdSet.has(dependency.toTaskId),
	);

	return {
		board: {
			...board,
			columns,
			dependencies,
		},
		deleted: true,
		deletedTaskIds,
	};
}

export function moveTaskToColumn(
	board: RuntimeBoardData,
	taskId: string,
	targetColumnId: RuntimeBoardColumnId,
	now: number = Date.now(),
): RuntimeMoveTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}

	const found = findTaskLocation(board, normalizedTaskId);
	if (!found) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}
	if (found.columnId === targetColumnId) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const targetColumnIndex = board.columns.findIndex((column) => column.id === targetColumnId);
	if (targetColumnIndex === -1) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceColumn = board.columns[found.columnIndex];
	const targetColumn = board.columns[targetColumnIndex];
	if (!sourceColumn || !targetColumn) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceCards = [...sourceColumn.cards];
	const [task] = sourceCards.splice(found.taskIndex, 1);
	if (!task) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const movedTask: RuntimeBoardCard = {
		...task,
		updatedAt: now,
	};
	const targetCards =
		targetColumnId === "trash" || targetColumnId === "done"
			? [movedTask, ...targetColumn.cards]
			: [...targetColumn.cards, movedTask];

	const columns = board.columns.map((column, index) => {
		if (index === found.columnIndex) {
			return {
				...column,
				cards: sourceCards,
			};
		}
		if (index === targetColumnIndex) {
			return {
				...column,
				cards: targetCards,
			};
		}
		return column;
	});

	return {
		moved: true,
		board: updateTaskDependencies({
			...board,
			columns,
		}),
		task: movedTask,
		fromColumnId: found.columnId,
	};
}

export function updateTask(
	board: RuntimeBoardData,
	taskId: string,
	input: RuntimeUpdateTaskInput,
	now: number = Date.now(),
): RuntimeUpdateTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const prompt = input.prompt.trim();
	if (!prompt) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	let updatedTask: RuntimeBoardCard | null = null;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== normalizedTaskId) {
				return card;
			}
			columnUpdated = true;
			updatedTask = {
				...card,
				title: resolveTaskTitle(input.title, prompt),
				prompt,
				startInPlanMode: Boolean(input.startInPlanMode),
				autoReviewEnabled: Boolean(input.autoReviewEnabled),
				autoReviewMode: normalizeTaskAutoReviewMode(input.autoReviewMode),
				images: input.images === undefined ? card.images : cloneTaskImages(input.images),
				agentId: input.agentId === undefined ? card.agentId : (input.agentId ?? undefined),
				clineSettings:
					input.clineSettings === undefined
						? cloneTaskClineSettings(card.clineSettings)
						: input.clineSettings === null
							? undefined
							: cloneTaskClineSettings(input.clineSettings),
				baseRef,
				// UPD-0: an explicit false must survive; a missing input keeps the
				// card's policy (normalized so legacy cards read as true).
				updateBaseRefBeforeStart:
					input.updateBaseRefBeforeStart === undefined
						? card.updateBaseRefBeforeStart !== false
						: input.updateBaseRefBeforeStart,
				updatedAt: now,
			};
			return updatedTask;
		});
		return columnUpdated ? { ...column, cards } : column;
	});

	if (!updatedTask) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	return {
		board: {
			...board,
			columns,
		},
		task: updatedTask,
		updated: true,
	};
}

// --- PRLINK-0: pull request links --------------------------------------------

/** Hard cap on stored pull requests per task card. */
const MAX_TASK_PULL_REQUESTS = 20;

export interface RuntimeTaskPullRequestSnapshotUpdate {
	title?: string;
	state?: RuntimeTaskPullRequest["state"];
	stateCheckedAt?: number;
}

export interface RuntimeAddTaskPullRequestsResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	added: boolean;
}

export interface RuntimeRemoveTaskPullRequestResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	removed: boolean;
}

export interface RuntimeUpdateTaskPullRequestSnapshotResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	updated: boolean;
}

function replaceTaskCard(board: RuntimeBoardData, taskId: string, nextTask: RuntimeBoardCard): RuntimeBoardData {
	const columns = board.columns.map((column) =>
		column.cards.some((card) => card.id === taskId)
			? { ...column, cards: column.cards.map((card) => (card.id === taskId ? nextTask : card)) }
			: column,
	);
	return { ...board, columns };
}

/**
 * Fills only the snapshot fields missing from `current` with values from
 * `incoming`. Returns null when nothing changes. The stored identity
 * (provider/host/repository/number/source/createdAt) is never overwritten.
 */
function backfillPullRequestSnapshot(
	current: RuntimeTaskPullRequest,
	incoming: RuntimeTaskPullRequest,
): RuntimeTaskPullRequest | null {
	let changed = false;
	const next: RuntimeTaskPullRequest = { ...current };
	if (next.title === undefined && incoming.title !== undefined) {
		next.title = incoming.title;
		changed = true;
	}
	if (next.state === undefined && incoming.state !== undefined) {
		next.state = incoming.state;
		changed = true;
	}
	if (next.stateCheckedAt === undefined && incoming.stateCheckedAt !== undefined) {
		next.stateCheckedAt = incoming.stateCheckedAt;
		changed = true;
	}
	return changed ? next : null;
}

/**
 * Records pull requests against a task. Deduped by identity key: an existing
 * entry keeps its position, `createdAt`, and `source` and only backfills
 * missing snapshot fields. New entries append (first-appearance order is
 * preserved across interleaved adds). When the cap is exceeded, the oldest
 * non-manual entry is dropped first; only an all-manual list evicts its
 * oldest manual entry. `added` is true only when the stored array changed.
 */
export function addTaskPullRequests(
	board: RuntimeBoardData,
	taskId: string,
	pullRequests: RuntimeTaskPullRequest[],
	now: number = Date.now(),
): RuntimeAddTaskPullRequestsResult {
	const normalizedTaskId = taskId.trim();
	const found = normalizedTaskId ? findTaskLocation(board, normalizedTaskId) : null;
	if (!found) {
		return { board, task: null, added: false };
	}
	const task = found.task;
	if (pullRequests.length === 0) {
		return { board, task, added: false };
	}

	const nextPullRequests = [...(task.pullRequests ?? [])];
	const positionByKey = new Map<string, number>();
	nextPullRequests.forEach((pullRequest, index) => {
		positionByKey.set(getPullRequestIdentityKey(pullRequest), index);
	});

	let changed = false;
	for (const incoming of pullRequests) {
		const key = getPullRequestIdentityKey(incoming);
		const existingIndex = positionByKey.get(key);
		if (existingIndex === undefined) {
			positionByKey.set(key, nextPullRequests.length);
			nextPullRequests.push({ ...incoming });
			changed = true;
			continue;
		}
		const existing = nextPullRequests[existingIndex];
		if (existing !== undefined) {
			const backfilled = backfillPullRequestSnapshot(existing, incoming);
			if (backfilled !== null) {
				nextPullRequests[existingIndex] = backfilled;
				changed = true;
			}
		}
	}

	while (nextPullRequests.length > MAX_TASK_PULL_REQUESTS) {
		let dropIndex = nextPullRequests.findIndex((pullRequest) => pullRequest.source !== "manual");
		if (dropIndex === -1) {
			dropIndex = 0;
		}
		nextPullRequests.splice(dropIndex, 1);
		changed = true;
	}

	if (!changed) {
		return { board, task, added: false };
	}
	const nextTask: RuntimeBoardCard = { ...task, pullRequests: nextPullRequests, updatedAt: now };
	return {
		board: replaceTaskCard(board, normalizedTaskId, nextTask),
		task: nextTask,
		added: true,
	};
}

/** Removes a stored pull request by identity key (case-insensitive). */
export function removeTaskPullRequest(
	board: RuntimeBoardData,
	taskId: string,
	identityKey: string,
	now: number = Date.now(),
): RuntimeRemoveTaskPullRequestResult {
	const normalizedTaskId = taskId.trim();
	const found = normalizedTaskId ? findTaskLocation(board, normalizedTaskId) : null;
	if (!found) {
		return { board, task: null, removed: false };
	}
	const task = found.task;
	const existing = task.pullRequests;
	if (!existing) {
		return { board, task, removed: false };
	}
	const nextPullRequests = existing.filter((pullRequest) => getPullRequestIdentityKey(pullRequest) !== identityKey);
	if (nextPullRequests.length === existing.length) {
		return { board, task, removed: false };
	}
	const nextTask: RuntimeBoardCard = { ...task, pullRequests: nextPullRequests, updatedAt: now };
	return {
		board: replaceTaskCard(board, normalizedTaskId, nextTask),
		task: nextTask,
		removed: true,
	};
}

/**
 * Updates the stored snapshot for one pull request. Only provided fields are
 * set; when `title` or `state` is provided without `stateCheckedAt`, the
 * stamp is set to `now`.
 */
export function updateTaskPullRequestSnapshot(
	board: RuntimeBoardData,
	taskId: string,
	identityKey: string,
	snapshot: RuntimeTaskPullRequestSnapshotUpdate,
	now: number = Date.now(),
): RuntimeUpdateTaskPullRequestSnapshotResult {
	const normalizedTaskId = taskId.trim();
	const found = normalizedTaskId ? findTaskLocation(board, normalizedTaskId) : null;
	if (!found) {
		return { board, task: null, updated: false };
	}
	const task = found.task;
	const existing = task.pullRequests;
	if (
		!existing ||
		(snapshot.title === undefined && snapshot.state === undefined && snapshot.stateCheckedAt === undefined)
	) {
		return { board, task, updated: false };
	}
	let foundMatch = false;
	const nextPullRequests = existing.map((pullRequest) => {
		if (getPullRequestIdentityKey(pullRequest) !== identityKey) {
			return pullRequest;
		}
		foundMatch = true;
		const next: RuntimeTaskPullRequest = { ...pullRequest };
		if (snapshot.title !== undefined) {
			next.title = snapshot.title;
		}
		if (snapshot.state !== undefined) {
			next.state = snapshot.state;
		}
		if (snapshot.stateCheckedAt !== undefined) {
			next.stateCheckedAt = snapshot.stateCheckedAt;
		} else if (snapshot.title !== undefined || snapshot.state !== undefined) {
			next.stateCheckedAt = now;
		}
		return next;
	});
	if (!foundMatch) {
		return { board, task, updated: false };
	}
	const nextTask: RuntimeBoardCard = { ...task, pullRequests: nextPullRequests, updatedAt: now };
	return {
		board: replaceTaskCard(board, normalizedTaskId, nextTask),
		task: nextTask,
		updated: true,
	};
}

// --- PRTRACK-1: server-owned PR automation settings -------------------------

export interface RuntimeTaskPrSettingsInput {
	/** undefined = keep current; explicit boolean overwrites. */
	autoAddressComments?: boolean;
	/** undefined = keep current; explicit boolean overwrites. */
	autoFinishOnMerge?: boolean;
	/** Must equal the card's current settingsRevision (absent reads as 0). */
	expectedSettingsRevision?: number;
}

export interface RuntimeUpdateTaskPrSettingsResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	updated: boolean;
	/** True when expectedSettingsRevision did not match the stored revision. */
	conflict: boolean;
	settingsRevision: number;
	autoAddressComments: boolean;
	autoFinishOnMerge: boolean;
	selectedAutomationPrKey: string | null;
}

/**
 * The dedicated revision-checked settings mutation. Never called from the
 * whole-board save path: `saveWorkspaceState` carries the stored values over,
 * and this mutation is the only writer of the settings block.
 */
export function updateTaskPrSettings(
	board: RuntimeBoardData,
	taskId: string,
	input: RuntimeTaskPrSettingsInput,
	now: number = Date.now(),
): RuntimeUpdateTaskPrSettingsResult {
	const normalizedTaskId = taskId.trim();
	const found = normalizedTaskId ? findTaskLocation(board, normalizedTaskId) : null;
	const base = (task: RuntimeBoardCard): RuntimeUpdateTaskPrSettingsResult => ({
		board,
		task,
		updated: false,
		conflict: false,
		settingsRevision: task.settingsRevision ?? 0,
		autoAddressComments: task.autoAddressComments === true,
		autoFinishOnMerge: task.autoFinishOnMerge === true,
		selectedAutomationPrKey: task.selectedAutomationPrKey ?? null,
	});
	if (!found) {
		return {
			board,
			task: null,
			updated: false,
			conflict: false,
			settingsRevision: 0,
			autoAddressComments: false,
			autoFinishOnMerge: false,
			selectedAutomationPrKey: null,
		};
	}
	const task = found.task;
	const currentRevision = task.settingsRevision ?? 0;
	if (typeof input.expectedSettingsRevision === "number" && input.expectedSettingsRevision !== currentRevision) {
		return { ...base(task), conflict: true };
	}
	if (input.autoAddressComments === undefined && input.autoFinishOnMerge === undefined) {
		return base(task);
	}
	const nextTask: RuntimeBoardCard = {
		...task,
		autoAddressComments:
			input.autoAddressComments === undefined ? task.autoAddressComments === true : input.autoAddressComments,
		autoFinishOnMerge:
			input.autoFinishOnMerge === undefined ? task.autoFinishOnMerge === true : input.autoFinishOnMerge,
		settingsRevision: currentRevision + 1,
		updatedAt: now,
	};
	return {
		board: replaceTaskCard(board, normalizedTaskId, nextTask),
		task: nextTask,
		updated: true,
		conflict: false,
		settingsRevision: nextTask.settingsRevision ?? currentRevision + 1,
		autoAddressComments: nextTask.autoAddressComments === true,
		autoFinishOnMerge: nextTask.autoFinishOnMerge === true,
		selectedAutomationPrKey: nextTask.selectedAutomationPrKey ?? null,
	};
}

export interface RuntimeSetTaskSelectedAutomationPrResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	changed: boolean;
	conflict: boolean;
	settingsRevision: number;
	selectedAutomationPrKey: string | null;
}

/**
 * Sets (or clears, with null) the one selected Automation PR. The selection
 * is part of the settings block, so it shares its revision.
 */
export function setTaskSelectedAutomationPr(
	board: RuntimeBoardData,
	taskId: string,
	prKey: string | null,
	expectedSettingsRevision?: number,
	now: number = Date.now(),
): RuntimeSetTaskSelectedAutomationPrResult {
	const normalizedTaskId = taskId.trim();
	const found = normalizedTaskId ? findTaskLocation(board, normalizedTaskId) : null;
	if (!found) {
		return { board, task: null, changed: false, conflict: false, settingsRevision: 0, selectedAutomationPrKey: null };
	}
	const task = found.task;
	const currentRevision = task.settingsRevision ?? 0;
	if (typeof expectedSettingsRevision === "number" && expectedSettingsRevision !== currentRevision) {
		return {
			board,
			task,
			changed: false,
			conflict: true,
			settingsRevision: currentRevision,
			selectedAutomationPrKey: task.selectedAutomationPrKey ?? null,
		};
	}
	const currentKey = task.selectedAutomationPrKey ?? null;
	if (currentKey === prKey) {
		return {
			board,
			task,
			changed: false,
			conflict: false,
			settingsRevision: currentRevision,
			selectedAutomationPrKey: currentKey,
		};
	}
	const nextTask: RuntimeBoardCard = { ...task };
	if (prKey === null) {
		delete nextTask.selectedAutomationPrKey;
	} else {
		nextTask.selectedAutomationPrKey = prKey;
	}
	nextTask.settingsRevision = currentRevision + 1;
	nextTask.updatedAt = now;
	return {
		board: replaceTaskCard(board, normalizedTaskId, nextTask),
		task: nextTask,
		changed: true,
		conflict: false,
		settingsRevision: nextTask.settingsRevision ?? currentRevision + 1,
		selectedAutomationPrKey: nextTask.selectedAutomationPrKey ?? null,
	};
}
