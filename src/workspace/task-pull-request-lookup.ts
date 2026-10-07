// PRLINK-5: best-effort branch lookup for pull requests.
//
// When a task enters Review with no recorded PRs (hook transition or board
// save), or when the user explicitly refreshes, we ask the gh CLI (directly,
// never through an interactive shell) for the PRs pointing at the task's
// current branch and record them with a snapshot (title, state,
// stateCheckedAt). Every failure mode degrades silently: missing gh,
// unauthenticated gh, no worktree, detached HEAD, or a git error all yield
// `{ recorded: 0 }` with a reason and never surface an error. The explicit
// refresh toasts the reason; the automatic review-entry lookup ignores it.
//
// Writes are a documented exception to the single-write-path rule in
// task-pull-requests.ts: new links go through addTaskPullRequests (same
// dedupe/cap semantics as recordTaskPullRequests), while existing entries
// get their snapshot refreshed through updateTaskPullRequestSnapshot so a
// stale state (e.g. open -> merged) is corrected on refresh. Both happen in
// one atomic mutateWorkspaceState so a lookup bumps the revision at most once.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskPullRequest } from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import type { ParsedPullRequestLink } from "../core/pull-request-links";
import { getPullRequestIdentityKey, parsePullRequestUrl } from "../core/pull-request-links";
import { addTaskPullRequests, updateTaskPullRequestSnapshot } from "../core/task-board-mutations";
import { loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";
import { runGhCommand } from "./git-delivery";
import { resolveTaskCwd } from "./task-worktree";

const execFileAsync = promisify(execFile);
/** Hard bound on the gh query (user-initiated refresh awaits this). */
export const TASK_PULL_REQUEST_GH_TIMEOUT_MS = 10_000;
/** Local git rev-parse is instant; the bound only guards against a wedged index. */
const TASK_PULL_REQUEST_GIT_TIMEOUT_MS = 5_000;
const REVIEW_COLUMN_ID = "review";

/** Injectable gh runner (defaults to the gh CLI via execFile, bounded). */
export type TaskPullRequestGhRunner = (
	args: string[],
	cwd: string,
) => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number; missingBinary: boolean }>;

export interface TaskPullRequestLookupInput {
	workspacePath: string;
	taskId: string;
	/** Branch to query. When omitted, resolved inside the helper (see below). */
	branch?: string;
	/** Injectable gh runner (tests pass fakes). */
	gh?: TaskPullRequestGhRunner;
}

export type TaskPullRequestLookupReason =
	| "no_task"
	| "no_worktree"
	| "no_branch"
	| "no_gh"
	| "gh_failed"
	| "none_found"
	| "unchanged"
	| "updated"
	| "failed";

export interface TaskPullRequestLookupResult {
	/** Number of PR entries that changed (newly recorded or snapshot-updated). */
	recorded: number;
	/**
	 * Why the lookup produced that result. Consumed by the explicit refresh
	 * (which toasts it); the automatic review-entry lookup ignores it.
	 */
	reason: TaskPullRequestLookupReason;
}

function noOpResult(reason: TaskPullRequestLookupReason): TaskPullRequestLookupResult {
	return { recorded: 0, reason };
}

function logLookupFailure(taskId: string, reason: string): void {
	// Debug-level only: lookup failures are expected on machines without gh.
	process.stderr.write(`[task-pull-request-lookup] skipped lookup for task ${taskId}: ${reason}\n`);
}

function findCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | null {
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.id === taskId) {
				return card;
			}
		}
	}
	return null;
}

/** Resolves the current branch with a direct git call (no shell). */
async function resolveCurrentBranch(worktreePath: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: worktreePath,
			encoding: "utf8",
			env: createGitProcessEnv(),
			signal: AbortSignal.timeout(TASK_PULL_REQUEST_GIT_TIMEOUT_MS),
		});
		const branch = String(stdout ?? "").trim();
		// "HEAD" means a detached HEAD: nothing to query by branch name.
		if (!branch || branch === "HEAD") {
			return null;
		}
		return branch;
	} catch (error) {
		logLookupFailure("<branch-resolution>", String(error));
		return null;
	}
}

function mapGhPullRequestState(raw: string): RuntimeTaskPullRequest["state"] | null {
	// gh's `state` enum is OPEN/MERGED/CLOSED (no draft); leave draft unset.
	const normalized = raw.toUpperCase();
	if (normalized === "OPEN") {
		return "open";
	}
	if (normalized === "MERGED") {
		return "merged";
	}
	if (normalized === "CLOSED") {
		return "closed";
	}
	return null;
}

interface GhPullRequestEntry {
	link: ParsedPullRequestLink;
	title?: string;
	state: RuntimeTaskPullRequest["state"];
}

/** Parses `gh pr list --json` output into canonical links with snapshots. */
function parseGhPullRequestEntries(stdout: string): GhPullRequestEntry[] {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) {
		return [];
	}
	const entries: GhPullRequestEntry[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const candidate = item as { url?: unknown; title?: unknown; state?: unknown };
		const url = typeof candidate.url === "string" ? candidate.url : null;
		const state = typeof candidate.state === "string" ? mapGhPullRequestState(candidate.state) : null;
		const title = typeof candidate.title === "string" && candidate.title.trim() ? candidate.title.trim() : undefined;
		if (!url || !state) {
			continue;
		}
		const link = parsePullRequestUrl(url);
		if (!link) {
			continue;
		}
		const key = getPullRequestIdentityKey(link);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		entries.push({ link, title, state });
	}
	return entries;
}

/**
 * Looks up the PRs for the task's current branch and records them. Returns
 * how many entries changed plus a reason; never throws. `branch` defaults to
 * the worktree's current branch (resolved inside this fire-and-forget work,
 * direct git call).
 */
export async function lookupTaskPullRequests(input: TaskPullRequestLookupInput): Promise<TaskPullRequestLookupResult> {
	const taskId = input.taskId.trim();
	if (!taskId) {
		return noOpResult("no_task");
	}
	const gh = input.gh ?? ((args: string[], cwd: string) => runGhCommand(args, cwd, TASK_PULL_REQUEST_GH_TIMEOUT_MS));
	try {
		const state = await loadWorkspaceState(input.workspacePath);
		const card = findCard(state.board, taskId);
		if (!card) {
			logLookupFailure(taskId, "task not found on the board");
			return noOpResult("no_task");
		}
		let worktreePath: string;
		try {
			worktreePath = await resolveTaskCwd({
				cwd: input.workspacePath,
				taskId,
				baseRef: card.baseRef,
				ensure: false,
			});
		} catch (error) {
			// resolveTaskCwd throws when the worktree is gone (cleaned up).
			logLookupFailure(taskId, `task worktree no longer exists: ${String(error)}`);
			return noOpResult("no_worktree");
		}
		const branch = input.branch?.trim() || (await resolveCurrentBranch(worktreePath));
		if (!branch) {
			logLookupFailure(taskId, "no resolvable branch (detached HEAD or git error)");
			return noOpResult("no_branch");
		}
		const ghResult = await gh(
			["pr", "list", "--head", branch, "--state", "all", "--json", "number,url,title,state", "--limit", "5"],
			worktreePath,
		);
		if (ghResult.missingBinary) {
			logLookupFailure(taskId, "gh CLI is not installed");
			return noOpResult("no_gh");
		}
		if (!ghResult.ok) {
			// Unauthenticated, no remote, or a transient failure: degrade silently.
			logLookupFailure(taskId, `gh pr list failed (exit ${ghResult.exitCode}): ${ghResult.stderr || "no stderr"}`);
			return noOpResult("gh_failed");
		}
		const entries = parseGhPullRequestEntries(ghResult.stdout);
		if (entries.length === 0) {
			return noOpResult("none_found");
		}
		const now = Date.now();
		const response = await mutateWorkspaceState<number>(input.workspacePath, (current) => {
			let board = current.board;
			let changed = 0;
			for (const entry of entries) {
				const key = getPullRequestIdentityKey(entry.link);
				const taskPullRequests =
					board.columns.flatMap((column) => column.cards).find((task) => task.id === taskId)?.pullRequests ?? [];
				const existing = taskPullRequests.find((pullRequest) => getPullRequestIdentityKey(pullRequest) === key);
				if (existing) {
					// Refresh only when the stored snapshot is actually stale;
					// repeated lookups must not churn the revision. Only compare
					// the title when gh returned one: gh can omit it while the
					// stored entry keeps it, which must not count as a change.
					const titleChanged = entry.title !== undefined && existing.title !== entry.title;
					if (titleChanged || existing.state !== entry.state) {
						const result = updateTaskPullRequestSnapshot(board, taskId, key, {
							...(entry.title !== undefined ? { title: entry.title } : {}),
							state: entry.state,
							stateCheckedAt: now,
						});
						if (result.updated) {
							board = result.board;
							changed += 1;
						}
					}
					continue;
				}
				const pullRequest: RuntimeTaskPullRequest = {
					provider: entry.link.provider,
					host: entry.link.host,
					repository: entry.link.repository,
					number: entry.link.number,
					url: entry.link.url,
					source: "branch_lookup",
					createdAt: now,
					...(entry.title !== undefined ? { title: entry.title } : {}),
					state: entry.state,
					stateCheckedAt: now,
				};
				const result = addTaskPullRequests(board, taskId, [pullRequest], now);
				if (result.added) {
					board = result.board;
					changed += 1;
				}
			}
			// save: false on a no-op so repeated lookups do not bump the
			// revision or trigger a broadcast.
			return { board, value: changed, save: changed > 0 };
		});
		return response.value > 0
			? { recorded: response.value, reason: "updated" }
			: { recorded: response.value, reason: "unchanged" };
	} catch (error) {
		// Best-effort by contract: a lookup must never fail the surrounding
		// transition, board save, or refresh call.
		logLookupFailure(taskId, String(error));
		return noOpResult("failed");
	}
}

/**
 * Fire-and-forget wrapper for review transitions: fires the branch lookup
 * only when the card exists and has no recorded PRs. Never awaited.
 */
export function fireReviewPullRequestLookup(input: { workspacePath: string; taskId: string }): void {
	void (async () => {
		try {
			const state = await loadWorkspaceState(input.workspacePath);
			const card = findCard(state.board, input.taskId);
			if (!card || (card.pullRequests ?? []).length > 0) {
				return;
			}
			await lookupTaskPullRequests({
				workspacePath: input.workspacePath,
				taskId: input.taskId,
			});
		} catch (error) {
			// lookupTaskPullRequests swallows its own failures; this only
			// guards the pre-check board read.
			logLookupFailure(input.taskId, String(error));
		}
	})();
}

/**
 * Task ids present in the Review column of `nextBoard` that were not in
 * Review in `previousBoard` and have no recorded PRs (the PRLINK-5 trigger
 * for the best-effort branch lookup after a board save).
 */
export function findTasksEnteringReviewWithoutPullRequests(
	previousBoard: RuntimeBoardData,
	nextBoard: RuntimeBoardData,
): string[] {
	const previousReviewIds = new Set<string>();
	for (const column of previousBoard.columns) {
		if (column.id !== REVIEW_COLUMN_ID) {
			continue;
		}
		for (const card of column.cards) {
			previousReviewIds.add(card.id);
		}
	}
	const result: string[] = [];
	for (const column of nextBoard.columns) {
		if (column.id !== REVIEW_COLUMN_ID) {
			continue;
		}
		for (const card of column.cards) {
			if (!previousReviewIds.has(card.id) && (card.pullRequests ?? []).length === 0) {
				result.push(card.id);
			}
		}
	}
	return result;
}
