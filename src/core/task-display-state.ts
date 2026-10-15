// Shared classification and merge rules for task display states and session
// summaries. Used by the server (counts, snapshots, saves) and the web UI
// (open-project counts, stream merges), so both sides agree on a card's
// display state for identical board and session inputs.
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeProjectTaskCounts,
	RuntimeProjectTaskListItem,
	RuntimeTaskDisplayState,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
} from "./api-contract";

// The display state union is owned by the API contract; re-export it so all
// consumers can import the type through this module.
export type { RuntimeTaskDisplayState } from "./api-contract";

/** Session states where the agent is not working, so an In Progress card displays as Paused. */
export const PAUSED_TASK_SESSION_STATES: ReadonlySet<RuntimeTaskSessionState> = new Set([
	"idle",
	"interrupted",
	"failed",
]);

/** Hook event that marks a running session queued behind a concurrency slot. */
const QUEUED_HOOK_EVENT_NAME = "concurrency_waiting";

/**
 * A placeholder summary describes no session: it is created for freshly
 * attached terminals/tasks before any real session reports, so it must never
 * classify a card as Paused even when it has the newest timestamp.
 */
export function isPlaceholderSessionSummary(summary: RuntimeTaskSessionSummary): boolean {
	return summary.state === "idle" && summary.startedAt === null && summary.agentId === null;
}

/**
 * Classify a card by board column and effective session summary.
 *
 * - Any column other than In Progress maps directly to the column id.
 * - In Progress with no summary (or only a placeholder) stays `in_progress`
 *   so just-started sessions do not flash Paused before they report.
 * - A running session queued for a concurrency slot is `paused` (no agent is
 *   working yet); the queued check precedes the general running check.
 * - `awaiting_review` displays as `review`; `idle`, `interrupted` and
 *   `failed` display as `paused`.
 */
export function resolveTaskDisplayState(
	columnId: RuntimeBoardColumnId,
	summary: RuntimeTaskSessionSummary | null | undefined,
): RuntimeTaskDisplayState {
	if (columnId !== "in_progress") {
		return columnId;
	}
	if (!summary || isPlaceholderSessionSummary(summary)) {
		return "in_progress";
	}
	if (summary.state === "running") {
		if (summary.latestHookActivity?.hookEventName === QUEUED_HOOK_EVENT_NAME) {
			return "paused";
		}
		return "in_progress";
	}
	if (summary.state === "awaiting_review") {
		return "review";
	}
	if (PAUSED_TASK_SESSION_STATES.has(summary.state)) {
		return "paused";
	}
	return "in_progress";
}

export function createEmptyTaskCounts(): RuntimeProjectTaskCounts {
	return {
		backlog: 0,
		in_progress: 0,
		paused: 0,
		review: 0,
		done: 0,
		trash: 0,
	};
}

/** Count every card by its display state; In Progress cards use their effective session summary. */
export function countTasksByDisplayState(
	board: RuntimeBoardData,
	sessionsByTaskId: Readonly<Record<string, RuntimeTaskSessionSummary>>,
): RuntimeProjectTaskCounts {
	const counts = createEmptyTaskCounts();
	for (const column of board.columns) {
		for (const card of column.cards) {
			counts[resolveTaskDisplayState(column.id, sessionsByTaskId[card.id])] += 1;
		}
	}
	return counts;
}

/**
 * Pick the winning session summary for one task between a current summary and
 * a candidate from a later-listed source.
 *
 * - A real summary always beats a placeholder, regardless of timestamp.
 * - Otherwise the larger `updatedAt` wins.
 * - On a tie the candidate wins (later-listed source).
 *
 * The complete winning object is returned as-is: no field merging, no
 * timestamp changes, no mutation of either input.
 */
export function pickNewerSessionSummary(
	current: RuntimeTaskSessionSummary | undefined,
	candidate: RuntimeTaskSessionSummary,
): RuntimeTaskSessionSummary {
	if (current === undefined) {
		return candidate;
	}
	const currentIsReal = !isPlaceholderSessionSummary(current);
	const candidateIsReal = !isPlaceholderSessionSummary(candidate);
	if (currentIsReal !== candidateIsReal) {
		return currentIsReal ? current : candidate;
	}
	return candidate.updatedAt >= current.updatedAt ? candidate : current;
}

/**
 * Merge session summary sources in order, keyed by taskId, so a later-listed
 * source wins ties and real summaries always beat placeholders.
 */
export function mergeSessionSummaries(
	...sources: ReadonlyArray<Iterable<RuntimeTaskSessionSummary>>
): Record<string, RuntimeTaskSessionSummary> {
	const merged: Record<string, RuntimeTaskSessionSummary> = {};
	for (const source of sources) {
		for (const summary of source) {
			merged[summary.taskId] = pickNewerSessionSummary(merged[summary.taskId], summary);
		}
	}
	return merged;
}

/**
 * Last activity timestamp for a card: the newest of the card and the real
 * session summary's timestamps. Without a summary, or with a terminal
 * placeholder (which describes no session), only the card's own `updatedAt`
 * counts, so attaching a terminal must not reorder an untouched task.
 */
export function resolveTaskLastActivityAt(
	card: RuntimeBoardCard,
	summary: RuntimeTaskSessionSummary | null | undefined,
): number {
	if (!summary || isPlaceholderSessionSummary(summary)) {
		return card.updatedAt;
	}
	return Math.max(card.updatedAt, summary.updatedAt, summary.lastOutputAt ?? 0, summary.lastHookAt ?? 0);
}

/** One list item per card in every column; unsorted. */
export function buildProjectTaskListItems(
	project: { id: string; name: string },
	board: RuntimeBoardData,
	sessionsByTaskId: Readonly<Record<string, RuntimeTaskSessionSummary>>,
): RuntimeProjectTaskListItem[] {
	const items: RuntimeProjectTaskListItem[] = [];
	for (const column of board.columns) {
		for (const card of column.cards) {
			const summary = sessionsByTaskId[card.id] ?? undefined;
			items.push({
				projectId: project.id,
				projectName: project.name,
				taskId: card.id,
				title: card.title,
				displayState: resolveTaskDisplayState(column.id, summary),
				lastActivityAt: resolveTaskLastActivityAt(card, summary),
			});
		}
	}
	return items;
}

/**
 * Cross-project task ordering: newest activity first, then title, taskId and
 * projectId ascending. Used by both the server and the browser so both sides
 * produce identical orderings.
 */
export function compareProjectTaskListItems(a: RuntimeProjectTaskListItem, b: RuntimeProjectTaskListItem): number {
	if (a.lastActivityAt !== b.lastActivityAt) {
		return b.lastActivityAt - a.lastActivityAt;
	}
	const titleComparison = a.title.localeCompare(b.title);
	if (titleComparison !== 0) {
		return titleComparison;
	}
	if (a.taskId !== b.taskId) {
		return a.taskId < b.taskId ? -1 : 1;
	}
	if (a.projectId !== b.projectId) {
		return a.projectId < b.projectId ? -1 : 1;
	}
	return 0;
}
