// PRLINK-1: the single server-side write path for recording pull-request
// links onto task cards. Every capture milestone (Cline tool calls, hooks,
// deterministic delivery, branch lookup, manual add) funnels through
// recordTaskPullRequests so identity dedupe, caps, and the server-owned
// pullRequests field stay consistent.
//
// Best-effort by contract: callers fire this off the hot path of tool
// events, hook ingest, and delivery, so failures are logged and swallowed
// instead of failing the surrounding operation.
import type { RuntimeTaskPullRequest, RuntimeTaskPullRequestSource } from "../core/api-contract";
import type { ParsedPullRequestLink } from "../core/pull-request-links";
import { parsePullRequestUrl } from "../core/pull-request-links";
import { addTaskPullRequests } from "../core/task-board-mutations";
import { loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";

export interface RecordTaskPullRequestsInput {
	workspacePath: string;
	taskId: string;
	links: ParsedPullRequestLink[];
	source: RuntimeTaskPullRequestSource;
	now?: number;
}

export interface RecordTaskPullRequestsResult {
	/** False when nothing was written (duplicate, unknown task, or error). */
	recorded: boolean;
	/** True only when the board actually changed (caller broadcasts only then). */
	changed: boolean;
}

const NO_OP_RESULT: RecordTaskPullRequestsResult = { recorded: false, changed: false };

function toRuntimePullRequests(
	links: ParsedPullRequestLink[],
	source: RuntimeTaskPullRequestSource,
	now: number,
): RuntimeTaskPullRequest[] {
	return links.map((link) => ({
		provider: link.provider,
		host: link.host,
		repository: link.repository,
		number: link.number,
		url: link.url,
		source,
		createdAt: now,
	}));
}

export async function recordTaskPullRequests(
	input: RecordTaskPullRequestsInput,
): Promise<RecordTaskPullRequestsResult> {
	const now = input.now ?? Date.now();
	if (input.links.length === 0) {
		return NO_OP_RESULT;
	}
	try {
		// A linked worktree (the usual task cwd) is not a workspace root:
		// refuse to auto-create a phantom workspace entry for a path that is
		// not already added to Kanban.
		await loadWorkspaceContext(input.workspacePath, { autoCreateIfMissing: false });
		const response = await mutateWorkspaceState<boolean>(input.workspacePath, (state) => {
			const result = addTaskPullRequests(
				state.board,
				input.taskId,
				toRuntimePullRequests(input.links, input.source, now),
				now,
			);
			// save: false on a no-op so repeated detections do not bump the
			// revision or trigger a broadcast.
			return { board: result.board, value: result.added, save: result.added };
		});
		const changed = response.saved && response.value;
		if (!changed) {
			return NO_OP_RESULT;
		}
		return { recorded: true, changed: true };
	} catch (error) {
		// Best-effort by contract: an unknown workspace or a failed write must
		// never fail a tool call, hook ingest, or delivery.
		process.stderr.write(
			`[task-pull-requests] failed to record pull requests for task ${input.taskId}: ${String(error)}\n`,
		);
		return NO_OP_RESULT;
	}
}

export interface RecordHookPullRequestsInput {
	/** Raw URLs as sent by the hook CLI (untrusted; re-parsed server-side). */
	rawUrls: string[];
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	broadcast: (workspaceId: string, workspacePath: string) => Promise<void> | void;
}

// PRLINK-2: hook-detected PR URLs. The hook CLI is not trusted to send
// canonical data, so every URL is re-parsed with the strict parser before
// recording. Best-effort by contract: recording never fails the hook ingest.
export async function recordHookPullRequests(input: RecordHookPullRequestsInput): Promise<void> {
	try {
		const links = input.rawUrls
			.map((url) => parsePullRequestUrl(url))
			.filter((link): link is ParsedPullRequestLink => link !== null);
		if (links.length === 0) {
			return;
		}
		const result = await recordTaskPullRequests({
			workspacePath: input.workspacePath,
			taskId: input.taskId,
			links,
			source: "agent_tool",
		});
		if (result.changed) {
			void input.broadcast(input.workspaceId, input.workspacePath);
		}
	} catch (error) {
		// Best-effort: a failure here must never fail the surrounding ingest.
		process.stderr.write(
			`[task-pull-requests] failed to record hook pull requests for task ${input.taskId}: ${String(error)}\n`,
		);
	}
}
