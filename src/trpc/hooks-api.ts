import type {
	RuntimeHookEvent,
	RuntimeHookIngestResponse,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { parseHookIngestRequest } from "../core/api-validation";
import { loadWorkspaceContextById } from "../state/workspace-state";
import { isStaleHookAttempt } from "../terminal/hook-runtime-context";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type { HookReviewReason } from "../terminal/session-state-machine";
import { fireReviewPullRequestLookup } from "../workspace/task-pull-request-lookup";
import { type RecordHookPullRequestsInput, recordHookPullRequests } from "../workspace/task-pull-requests";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext } from "./app-router";

export interface CreateHooksApiDependencies {
	getWorkspacePathById: (workspaceId: string) => string | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastTaskReadyForReview: (workspaceId: string, taskId: string) => void;
	captureTaskTurnCheckpoint?: (input: {
		cwd: string;
		taskId: string;
		turn: number;
	}) => Promise<RuntimeTaskTurnCheckpoint>;
	deleteTaskTurnCheckpointRef?: (input: { cwd: string; ref: string }) => Promise<void>;
	/** PRLINK-5: fires the best-effort branch lookup on review entry (tests inject a spy). */
	fireReviewPullRequestLookup?: (input: { workspacePath: string; taskId: string }) => void;
	/** PRLINK-2: records hook-detected PRs, fire-and-forget (tests inject a spy). */
	recordHookPullRequests?: (input: RecordHookPullRequestsInput) => Promise<void>;
	/** Pi's own completed tool commands can publish comments on linked PRs. */
	recordPiPublicationToolEvent?: (input: {
		workspaceId: string;
		workspacePath: string;
		taskId: string;
		phase: "finished";
		toolCallId: string | null;
		toolName: string | null;
		commands: string[];
		output: string | null;
		error: string | null;
	}) => Promise<void>;
}

function canTransitionTaskForHookEvent(summary: RuntimeTaskSessionSummary, event: RuntimeHookEvent): boolean {
	if (event === "activity") {
		return false;
	}
	if (event === "to_review") {
		return summary.state === "running";
	}
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

/**
 * AA-O1a: why a hook-driven review happened. An integration reports what kind of
 * pause it is through the notification type, so a failed model call parks the
 * card with the error reason instead of reading as a finished turn, and a parked
 * approval uses the attention reason because the agent is blocked on the human
 * rather than done with the work. The narrowed return type is what makes the
 * reason survive: `transitionToReview` accepts only what a hook may report, and
 * the session summary carries it, so the card parks with the reason the
 * integration actually claimed.
 */
function hookReviewReason(notificationType: string | null | undefined): HookReviewReason {
	if (notificationType === "error") {
		return "error";
	}
	if (notificationType === "permission.asked" || notificationType === "permission_prompt") {
		return "attention";
	}
	return "hook";
}

export function createHooksApi(deps: CreateHooksApiDependencies): RuntimeTrpcContext["hooksApi"] {
	const checkpointCapture = deps.captureTaskTurnCheckpoint ?? captureTaskTurnCheckpoint;
	const checkpointRefDelete = deps.deleteTaskTurnCheckpointRef ?? deleteTaskTurnCheckpointRef;
	const reviewPullRequestLookup = deps.fireReviewPullRequestLookup ?? fireReviewPullRequestLookup;
	const hookPullRequestRecorder = deps.recordHookPullRequests ?? recordHookPullRequests;

	return {
		ingest: async (input) => {
			try {
				const body = parseHookIngestRequest(input);
				const taskId = body.taskId;
				const workspaceId = body.workspaceId;
				const event = body.event;
				const knownWorkspacePath = deps.getWorkspacePathById(workspaceId);
				const workspaceContext = knownWorkspacePath ? null : await loadWorkspaceContextById(workspaceId);
				const workspacePath = knownWorkspacePath ?? workspaceContext?.repoPath ?? null;
				if (!workspacePath) {
					return {
						ok: false,
						error: `Workspace "${workspaceId}" not found`,
					} satisfies RuntimeHookIngestResponse;
				}

				const manager = await deps.ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
				const summary = manager.getSummary(taskId);
				if (!summary) {
					return {
						ok: false,
						error: `Task "${taskId}" not found in workspace "${workspaceId}"`,
					} satisfies RuntimeHookIngestResponse;
				}

				// AA-S1: the summary's current launch attempt owns this card's events.
				// An event with a different token comes from a superseded attempt (a
				// stale child process, a leftover plugin) and must never move the card,
				// so it is acknowledged and dropped. A session or integration without a
				// token has nothing to compare against and keeps working unchanged.
				if (isStaleHookAttempt({ eventAttemptId: body.attemptId, sessionAttemptId: summary.launchAttemptId })) {
					return {
						ok: true,
					} satisfies RuntimeHookIngestResponse;
				}

				// AA-O1a: remember which agent conversation this card is in, so a
				// later launch can name this exact session. Recorded before the
				// transition early return because plain activity events carry the id
				// too, and only after the attempt check so a superseded attempt
				// cannot rewrite what the live session reported.
				if (body.sessionId) {
					manager.applyExternalSessionId(taskId, body.sessionId);
				}

				// PRLINK-2: record hook-detected PRs before the transition early
				// return so recording is independent of column transitions.
				// Fire-and-forget by contract: a slow workspace lock must not
				// delay the hook response (the hook CLI has a short ingest
				// timeout), and failures are logged, never surfaced.
				if (body.pullRequestUrls && body.pullRequestUrls.length > 0) {
					void hookPullRequestRecorder({
						rawUrls: body.pullRequestUrls,
						workspaceId,
						workspacePath,
						taskId,
						broadcast: deps.broadcastRuntimeWorkspaceStateUpdated,
					});
				}

				if (body.publicationTool && summary.agentId === "pi" && deps.recordPiPublicationToolEvent) {
					void deps
						.recordPiPublicationToolEvent({
							workspaceId,
							workspacePath,
							taskId,
							...body.publicationTool,
						})
						.catch(() => {
							// Publication evidence is best-effort, never an agent-blocking hook.
						});
				}

				if (!canTransitionTaskForHookEvent(summary, event)) {
					if (body.metadata) {
						manager.applyHookActivity(taskId, body.metadata);
					}
					return {
						ok: true,
					} satisfies RuntimeHookIngestResponse;
				}

				const transitionedSummary =
					event === "to_review"
						? manager.transitionToReview(taskId, hookReviewReason(body.metadata?.notificationType))
						: manager.transitionToRunning(taskId);
				if (!transitionedSummary) {
					return {
						ok: false,
						error: `Task "${taskId}" transition failed`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (event === "to_review") {
					const nextTurn = (transitionedSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpointCwd = transitionedSummary.workspacePath ?? workspacePath;
					const staleRef = transitionedSummary.previousTurnCheckpoint?.ref ?? null;
					try {
						const checkpoint = await checkpointCapture({
							cwd: checkpointCwd,
							taskId,
							turn: nextTurn,
						});
						manager.applyTurnCheckpoint(taskId, checkpoint);
						if (staleRef) {
							void checkpointRefDelete({
								cwd: checkpointCwd,
								ref: staleRef,
							}).catch(() => {
								// Best effort cleanup only.
							});
						}
					} catch {
						// Best effort checkpointing only.
					}
				}

				// PRLINK-5: a review transition on a card with no recorded PRs
				// gets a best-effort branch lookup. Fire-and-forget: it is never
				// awaited and its failures are logged, never surfaced.
				if (event === "to_review") {
					reviewPullRequestLookup({
						workspacePath,
						taskId,
					});
				}

				if (body.metadata) {
					manager.applyHookActivity(taskId, body.metadata);
				}

				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
				if (event === "to_review") {
					deps.broadcastTaskReadyForReview(workspaceId, taskId);
				}

				return { ok: true } satisfies RuntimeHookIngestResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
