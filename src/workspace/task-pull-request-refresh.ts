// PRLINK-9: provider-aware metadata refresh of already-linked PRs.
//
// The current `refreshTaskPullRequests` (branch lookup) only lists PRs for
// the task's CURRENT branch. These helpers refresh the STORED links by
// identity instead, through the tracking coordinator's one-shot metadata
// refresh (no subscription required, no automation side effects):
//
// - `refreshTaskPullRequestEntry`: one link named by URL (works for a Done
//   task and for a link recorded from a different branch/repo).
// - `refreshLinkedTaskPullRequests`: every existing link of the task
//   (capped at 20) with at most 4 in-flight provider reads and a bounded
//   overall deadline.
//
// Provider reads happen OUTSIDE the workspace lock; results are applied in
// one atomic `mutateWorkspaceState` after re-validation (task still exists,
// link still recorded under the same identity, result newer than the stored
// snapshot), so a concurrent unlink/task-deletion can never resurrect a
// link and a stale result is ignored. This level adds no run-level dedup:
// a duplicate refresh click starts a second pass, but the coordinator's
// one-shot refresh coalesces concurrent reads for the SAME (PR, scope)
// onto one in-flight provider read.
import type {
	GitHubPrMetadataSnapshot,
	RuntimeBoardData,
	RuntimeTaskPullRequest,
	RuntimeTaskPullRequestProvider,
	RuntimeTaskPullRequestRefreshOutcome,
} from "../core/api-contract";
import { getPullRequestIdentityKey, parsePullRequestUrl } from "../core/pull-request-links";
import { supportsPrMetadataRefresh } from "../core/pull-request-providers/capabilities";
import { findTaskLocation, updateTaskPullRequestSnapshot } from "../core/task-board-mutations";
import { toCanonicalPrKey } from "../pr-tracking/pr-identity";
import type { OneShotMetadataRefreshResult } from "../pr-tracking/pr-tracking-coordinator";
import { loadWorkspaceContext, loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";

/**
 * Provider-read port: one metadata read for a single canonical PR.
 * Production binds this to the tracking coordinator's one-shot refresh.
 */
export type TaskPullRequestMetadataRefreshPort = (canonicalPrKey: string) => Promise<OneShotMetadataRefreshResult>;

/** Default cap on how many links one linked refresh covers. */
export const TASK_PULL_REQUEST_REFRESH_LINK_LIMIT = 20;
/** Default in-flight provider-read limit for a linked refresh. */
export const TASK_PULL_REQUEST_REFRESH_CONCURRENCY = 4;
/** Default overall deadline (ms) for a linked refresh. */
export const TASK_PULL_REQUEST_REFRESH_DEADLINE_MS = 60_000;

export interface TaskPullRequestRefreshInput {
	workspacePath: string;
	taskId: string;
	/** Single refresh: URL of the link to refresh. */
	url?: string;
	/** Limits (tests override; defaults are the production bounds). */
	limit?: number;
	concurrency?: number;
	deadlineMs?: number;
	now?: () => number;
	/** Provider-read port (required; production uses the coordinator). */
	refresh: TaskPullRequestMetadataRefreshPort;
}

export interface TaskPullRequestRefreshResult {
	ok: boolean;
	/** Number of linked entries whose snapshot actually changed. */
	updated: number;
	outcomes: RuntimeTaskPullRequestRefreshOutcome[];
	error?: string;
}

interface AppliedSnapshot {
	canonicalPrKey: string;
	metadata: GitHubPrMetadataSnapshot;
}

function outcomeFor(
	entry: {
		provider: RuntimeTaskPullRequestProvider;
		host: string;
		repository: string;
		number: number;
	},
	outcome: RuntimeTaskPullRequestRefreshOutcome["outcome"],
	checkedAt?: number,
	error?: string,
): RuntimeTaskPullRequestRefreshOutcome {
	return {
		provider: entry.provider,
		host: entry.host.toLowerCase(),
		repository: entry.repository.toLowerCase(),
		number: entry.number,
		outcome,
		...(checkedAt !== undefined ? { checkedAt } : {}),
		...(error !== undefined ? { error } : {}),
	};
}

/**
 * Applies refreshed snapshots under the workspace lock. Re-validates every
 * link against the CURRENT board (never resurrects a removed/replaced link,
 * applies nothing when the task is gone), ignores results that are not
 * newer than the stored `stateCheckedAt` (a concurrent write won), and skips
 * writes whose state and title are unchanged (a successful re-read must not
 * bump the revision, the card `updatedAt`, or count as `updated`).
 */
async function applyRefreshedSnapshots(
	workspacePath: string,
	taskId: string,
	applied: AppliedSnapshot[],
): Promise<number> {
	if (applied.length === 0) {
		return 0;
	}
	const response = await mutateWorkspaceState<number>(workspacePath, (state) => {
		const found = findTaskLocation(state.board, taskId);
		if (!found) {
			return { board: state.board, value: 0, save: false };
		}
		let board: RuntimeBoardData = state.board;
		let changed = 0;
		for (const item of applied) {
			const entries =
				board.columns.flatMap((column) => column.cards).find((task) => task.id === taskId)?.pullRequests ?? [];
			const existing = entries.find((entry) => getPullRequestIdentityKey(entry) === item.canonicalPrKey);
			if (!existing) {
				// The link was removed or replaced while the read was in
				// flight: apply nothing (no resurrection).
				continue;
			}
			const storedCheckedAt = existing.stateCheckedAt;
			if (storedCheckedAt !== undefined && item.metadata.checkedAt <= storedCheckedAt) {
				// Stale result: a newer observation already won.
				continue;
			}
			const titleChanged = item.metadata.title !== undefined && existing.title !== item.metadata.title;
			if (existing.state === item.metadata.state && !titleChanged) {
				// Unchanged snapshot: no write, no revision bump, not counted.
				continue;
			}
			const updated = updateTaskPullRequestSnapshot(board, taskId, item.canonicalPrKey, {
				state: item.metadata.state,
				stateCheckedAt: item.metadata.checkedAt,
				...(item.metadata.title !== undefined ? { title: item.metadata.title } : {}),
			});
			if (updated.updated) {
				board = updated.board;
				changed += 1;
			}
		}
		// save: false on a no-op so repeated refreshes do not bump the
		// revision or trigger a broadcast.
		return { board, value: changed, save: changed > 0 };
	});
	return response.value;
}

/**
 * Runs independent provider reads with a bounded concurrency and a bounded
 * overall deadline. Items that cannot start (or that do not finish) before
 * the deadline resolve to "deadline_exceeded"; nothing is retried.
 */
async function refreshWithBounds<I, O>(
	items: I[],
	concurrency: number,
	deadlineMs: number,
	now: () => number,
	run: (item: I) => Promise<O>,
): Promise<Array<O | "deadline_exceeded">> {
	const results: Array<O | "deadline_exceeded"> = new Array(items.length).fill("deadline_exceeded");
	if (items.length === 0) {
		return results;
	}
	let next = 0;
	const deadline = now() + deadlineMs;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next;
			next += 1;
			const item = items[index];
			if (item === undefined) {
				return;
			}
			if (now() >= deadline) {
				return;
			}
			const timeout = new Promise<"deadline_exceeded">((resolve) => {
				const timer = setTimeout(() => resolve("deadline_exceeded"), Math.max(0, deadline - now()));
				if (typeof timer.unref === "function") {
					timer.unref();
				}
			});
			results[index] = await Promise.race([run(item), timeout]);
		}
	};
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker());
	await Promise.all(workers);
	return results;
}

/**
 * Refreshes ONE recorded link of a task by URL. Works for any column (Done,
 * Backlog, ...) and for links recorded from a different branch or repo —
 * never uses the worktree's current branch. Unknown task → `ok: false`;
 * unlinked identity → per-identity `unlinked` outcome; unsupported provider
 * or host → `unsupported`; provider failures → sanitized `failed`.
 */
export async function refreshTaskPullRequestEntry(
	input: TaskPullRequestRefreshInput,
): Promise<TaskPullRequestRefreshResult> {
	if (!input.url) {
		return { ok: false, updated: 0, outcomes: [], error: "Missing pull request URL" };
	}
	const link = parsePullRequestUrl(input.url);
	if (!link) {
		return { ok: false, updated: 0, outcomes: [], error: "Not a valid pull request URL" };
	}
	const taskId = input.taskId.trim();
	if (!taskId) {
		return { ok: false, updated: 0, outcomes: [], error: "Missing taskId" };
	}
	await loadWorkspaceContext(input.workspacePath, { autoCreateIfMissing: false });
	const state = await loadWorkspaceState(input.workspacePath);
	const found = findTaskLocation(state.board, taskId);
	if (!found) {
		return { ok: false, updated: 0, outcomes: [], error: "Task not found" };
	}
	const canonicalPrKey = getPullRequestIdentityKey(link);
	const entry = (found.task.pullRequests ?? []).find((item) => getPullRequestIdentityKey(item) === canonicalPrKey);
	if (!entry) {
		return {
			ok: true,
			updated: 0,
			outcomes: [outcomeFor(link, "unlinked")],
		};
	}
	if (!supportsPrMetadataRefresh(entry)) {
		return {
			ok: true,
			updated: 0,
			outcomes: [outcomeFor(entry, "unsupported", undefined, "provider unsupported")],
		};
	}
	const result = await input.refresh(canonicalPrKey);
	if (result.outcome === "refreshed" && result.metadata) {
		const updated = await applyRefreshedSnapshots(input.workspacePath, taskId, [
			{ canonicalPrKey, metadata: result.metadata },
		]);
		return {
			ok: true,
			updated,
			outcomes: [outcomeFor(entry, "refreshed", result.checkedAt ?? result.metadata.checkedAt)],
		};
	}
	return {
		ok: true,
		updated: 0,
		outcomes: [outcomeFor(entry, "failed", result.checkedAt ?? undefined, result.error ?? "provider failed")],
	};
}

/**
 * Refreshes EVERY existing link of a task (capped at `limit`), at most
 * `concurrency` provider reads in flight, bounded by the overall deadline.
 * Duplicate clicks for the same task coalesce onto one run.
 */
export async function refreshLinkedTaskPullRequests(
	input: TaskPullRequestRefreshInput,
): Promise<TaskPullRequestRefreshResult> {
	const taskId = input.taskId.trim();
	if (!taskId) {
		return { ok: false, updated: 0, outcomes: [], error: "Missing taskId" };
	}
	await loadWorkspaceContext(input.workspacePath, { autoCreateIfMissing: false });
	const state = await loadWorkspaceState(input.workspacePath);
	const found = findTaskLocation(state.board, taskId);
	if (!found) {
		return { ok: false, updated: 0, outcomes: [], error: "Task not found" };
	}
	const entries = (found.task.pullRequests ?? []).slice(0, input.limit ?? TASK_PULL_REQUEST_REFRESH_LINK_LIMIT);
	if (entries.length === 0) {
		return { ok: true, updated: 0, outcomes: [] };
	}
	const now = input.now ?? Date.now;
	// Unsupported providers never receive a provider query.
	const outcomes = new Map<string, RuntimeTaskPullRequestRefreshOutcome>();
	const refreshable: RuntimeTaskPullRequest[] = [];
	for (const entry of entries) {
		const key = getPullRequestIdentityKey(entry);
		if (!supportsPrMetadataRefresh(entry)) {
			outcomes.set(key, outcomeFor(entry, "unsupported", undefined, "provider unsupported"));
		} else {
			refreshable.push(entry);
		}
	}
	let updated = 0;
	if (refreshable.length > 0) {
		const results = await refreshWithBounds(
			refreshable,
			input.concurrency ?? TASK_PULL_REQUEST_REFRESH_CONCURRENCY,
			input.deadlineMs ?? TASK_PULL_REQUEST_REFRESH_DEADLINE_MS,
			now,
			(entry) => input.refresh(toCanonicalPrKey(entry)),
		);
		const applied: AppliedSnapshot[] = [];
		refreshable.forEach((entry, index) => {
			const key = getPullRequestIdentityKey(entry);
			const result = results[index];
			if (result === undefined || result === "deadline_exceeded") {
				outcomes.set(key, outcomeFor(entry, "failed", undefined, "deadline exceeded"));
				return;
			}
			if (result.outcome === "refreshed" && result.metadata) {
				applied.push({ canonicalPrKey: key, metadata: result.metadata });
				outcomes.set(key, outcomeFor(entry, "refreshed", result.checkedAt ?? result.metadata.checkedAt));
			} else {
				outcomes.set(
					key,
					outcomeFor(entry, "failed", result.checkedAt ?? undefined, result.error ?? "provider failed"),
				);
			}
		});
		updated = await applyRefreshedSnapshots(input.workspacePath, taskId, applied);
	}
	// Outcome order follows the stored link order.
	const ordered = entries
		.map((entry) => outcomes.get(getPullRequestIdentityKey(entry)))
		.filter((outcome): outcome is RuntimeTaskPullRequestRefreshOutcome => outcome !== undefined);
	return { ok: true, updated, outcomes: ordered };
}
