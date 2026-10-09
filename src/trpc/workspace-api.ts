import { TRPCError } from "@trpc/server";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type {
	RuntimeBoardData,
	RuntimeGitCheckoutResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeTaskPullRequestLinkResponse,
	RuntimeTaskPullRequestsRefreshResponse,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceChangesMode,
	RuntimeWorkspaceFileSearchResponse,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import {
	parseGitCheckoutRequest,
	parseTaskPreservationRequest,
	parseTaskPullRequestLinkRequest,
	parseTaskPullRequestPrimaryRequest,
	parseTaskPullRequestsRefreshRequest,
	parseWorktreeDeleteRequest,
	parseWorktreeEnsureRequest,
} from "../core/api-validation";
import { getPullRequestIdentityKey, parsePullRequestUrl } from "../core/pull-request-links";
import { removeTaskPullRequest, setPrimaryTaskPullRequest } from "../core/task-board-mutations";
import { isTaskWriterActive } from "../server/task-writer-activity";
import {
	loadWorkspaceBoardById,
	mutateWorkspaceState,
	saveWorkspaceState,
	WorkspaceStateConflictError,
} from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import {
	createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef,
} from "../workspace/get-workspace-changes";
import { readTaskDeliveryReceipt } from "../workspace/git-delivery";
import { getCommitDiff, getGitLog, getGitRefs } from "../workspace/git-history";
import { discardGitChanges, getGitSyncSummary, runGitCheckoutAction, runGitSyncAction } from "../workspace/git-sync";
import { searchWorkspaceFiles } from "../workspace/search-workspace-files";
import {
	findTasksEnteringReviewWithoutPullRequests,
	fireReviewPullRequestLookup,
	lookupTaskPullRequests,
} from "../workspace/task-pull-request-lookup";
import { recordTaskPullRequests } from "../workspace/task-pull-requests";
import { listBlockedTaskCleanups, runTaskWorkspaceMaintenance } from "../workspace/task-workspace-maintenance";
import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskPreservationInfo,
	getTaskWorkspaceInfo,
	recoverTaskWorktree,
	resolveTaskCwd,
} from "../workspace/task-worktree";
import type { RuntimeTrpcContext } from "./app-router";

export interface CreateWorkspaceApiDependencies {
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	getScopedClineTaskSessionService: (scope: {
		workspaceId: string;
		workspacePath: string;
	}) => Promise<ClineTaskSessionService>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	buildWorkspaceStateSnapshot: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	/** B-9.2: fire-and-forget queue pass after a board save (a card may have just reached Done). */
	runTaskDispatchPass?: (scope: { workspaceId: string; workspacePath: string }) => void;
	/** PRTRACK-1: reconcile task-derived PR tracking subscriptions after a board change. */
	runPrTrackingReconcilePass?: (scope: { workspaceId: string; workspacePath: string }) => void;
}

function normalizeOptionalTaskWorkspaceScopeInput(
	input: { taskId: string; baseRef: string } | null,
): { taskId: string; baseRef: string } | null {
	if (!input) {
		return null;
	}
	const taskId = input.taskId.trim();
	const baseRef = input.baseRef.trim();
	if (!taskId || !baseRef) {
		throw new Error("baseRef query parameter requires taskId.");
	}
	return {
		taskId,
		baseRef,
	};
}

function normalizeRequiredTaskWorkspaceScopeInput(input: {
	taskId: string;
	baseRef: string;
	mode?: RuntimeWorkspaceChangesMode;
}): {
	taskId: string;
	baseRef: string;
	mode: RuntimeWorkspaceChangesMode;
} {
	const taskId = input.taskId.trim();
	const baseRef = input.baseRef.trim();
	if (!taskId) {
		throw new Error("Missing taskId query parameter.");
	}
	if (!baseRef) {
		throw new Error("Missing baseRef query parameter.");
	}
	const mode: RuntimeWorkspaceChangesMode = input.mode ?? "working_copy";
	return {
		taskId,
		baseRef,
		mode,
	};
}

function isActiveTaskSessionState(summary: RuntimeTaskSessionSummary | null): boolean {
	return summary?.state === "running" || summary?.state === "awaiting_review";
}

function selectLastTurnSummary(
	terminalSummary: RuntimeTaskSessionSummary | null,
	clineSummary: RuntimeTaskSessionSummary | null,
): RuntimeTaskSessionSummary | null {
	if (!terminalSummary) {
		return clineSummary;
	}
	if (!clineSummary) {
		return terminalSummary;
	}
	const terminalIsActive = isActiveTaskSessionState(terminalSummary);
	const clineIsActive = isActiveTaskSessionState(clineSummary);
	if (terminalIsActive !== clineIsActive) {
		return clineIsActive ? clineSummary : terminalSummary;
	}
	if (terminalSummary.updatedAt !== clineSummary.updatedAt) {
		return terminalSummary.updatedAt > clineSummary.updatedAt ? terminalSummary : clineSummary;
	}
	if (clineSummary.agentId === "cline" && terminalSummary.agentId !== "cline") {
		return clineSummary;
	}
	return terminalSummary;
}

function createEmptyGitSummaryErrorResponse(error: unknown): RuntimeGitSummaryResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		error: message,
	};
}

function createEmptyGitSyncErrorResponse(action: RuntimeGitSyncAction, error: unknown): RuntimeGitSyncResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		action,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function createEmptyGitCheckoutErrorResponse(error: unknown): RuntimeGitCheckoutResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		branch: "",
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function createEmptyGitDiscardErrorResponse(error: unknown): RuntimeGitDiscardResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function isMissingTaskWorktreeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return error.message.startsWith("Task worktree not found for task ");
}

function taskExistsOnBoard(board: RuntimeBoardData, taskId: string): boolean {
	return board.columns.some((column) => column.cards.some((card) => card.id === taskId));
}

export function createWorkspaceApi(deps: CreateWorkspaceApiDependencies): RuntimeTrpcContext["workspaceApi"] {
	return {
		loadGitSummary: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let summaryCwd = workspaceScope.workspacePath;
				if (taskScope) {
					summaryCwd = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
						ensure: false,
					});
				}
				const summary = await getGitSyncSummary(summaryCwd);
				return {
					ok: true,
					summary,
				} satisfies RuntimeGitSummaryResponse;
			} catch (error) {
				return createEmptyGitSummaryErrorResponse(error);
			}
		},
		runGitSyncAction: async (workspaceScope, input) => {
			try {
				return await runGitSyncAction({
					cwd: workspaceScope.workspacePath,
					action: input.action,
				});
			} catch (error) {
				return createEmptyGitSyncErrorResponse(input.action, error);
			}
		},
		checkoutGitBranch: async (workspaceScope, input) => {
			try {
				const body = parseGitCheckoutRequest(input);
				const response = await runGitCheckoutAction({
					cwd: workspaceScope.workspacePath,
					branch: body.branch,
				});
				if (response.ok) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return response;
			} catch (error) {
				return createEmptyGitCheckoutErrorResponse(error);
			}
		},
		discardGitChanges: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let discardCwd = workspaceScope.workspacePath;
				if (taskScope) {
					discardCwd = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
						ensure: false,
					});
				}
				const response = await discardGitChanges({
					cwd: discardCwd,
				});
				if (response.ok) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return response;
			} catch (error) {
				return createEmptyGitDiscardErrorResponse(error);
			}
		},
		loadChanges: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			let taskCwd: string;
			try {
				taskCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: normalizedInput.taskId,
					baseRef: normalizedInput.baseRef,
					ensure: false,
				});
			} catch (error) {
				if (!isMissingTaskWorktreeError(error)) {
					throw error;
				}
				return await createEmptyWorkspaceChangesResponse(workspaceScope.workspacePath);
			}
			if (normalizedInput.mode === "last_turn") {
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = selectLastTurnSummary(
					terminalManager.getSummary(normalizedInput.taskId),
					clineTaskSessionService.getSummary(normalizedInput.taskId),
				);
				const fromCheckpoint = summary?.previousTurnCheckpoint;
				const toCheckpoint = summary?.latestTurnCheckpoint;
				if (!toCheckpoint) {
					return await createEmptyWorkspaceChangesResponse(taskCwd);
				}
				if (summary?.state === "running" || !fromCheckpoint) {
					return await getWorkspaceChangesFromRef({
						cwd: taskCwd,
						fromRef: toCheckpoint.commit,
					});
				}
				return await getWorkspaceChangesBetweenRefs({
					cwd: taskCwd,
					fromRef: fromCheckpoint.commit,
					toRef: toCheckpoint.commit,
				});
			}
			return await getWorkspaceChanges(taskCwd);
		},
		ensureWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeEnsureRequest(input);
			return await ensureTaskWorktreeIfDoesntExist({
				cwd: workspaceScope.workspacePath,
				taskId: body.taskId,
				baseRef: body.baseRef,
			});
		},
		deleteWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeDeleteRequest(input);
			// B-5.5: cleanup never removes a worktree that is still being written.
			const writerActive = isTaskWriterActive(body.taskId, {
				clineTaskSessionService: await deps.getScopedClineTaskSessionService(workspaceScope),
				terminalManager: await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				),
			});
			if (writerActive) {
				const blockedReason = "The task's agent session is still running; stop it before cleaning up its worktree.";
				return { ok: false, removed: false, preserved: false, blockedReason, error: blockedReason };
			}
			return await deleteTaskWorktree({
				repoPath: workspaceScope.workspacePath,
				taskId: body.taskId,
			});
		},
		getTaskPreservationInfo: async (workspaceScope, input) => {
			const body = parseTaskPreservationRequest(input);
			return await getTaskPreservationInfo({
				repoPath: workspaceScope.workspacePath,
				taskId: body.taskId,
			});
		},
		recoverTaskWorktree: async (workspaceScope, input) => {
			const body = parseTaskPreservationRequest(input);
			return await recoverTaskWorktree({
				repoPath: workspaceScope.workspacePath,
				taskId: body.taskId,
			});
		},
		runTaskWorkspaceMaintenance: async (workspaceScope) => {
			const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
			const terminalManager = await deps.ensureTerminalManagerForWorkspace(
				workspaceScope.workspaceId,
				workspaceScope.workspacePath,
			);
			return await runTaskWorkspaceMaintenance({
				repoPath: workspaceScope.workspacePath,
				board: await loadWorkspaceBoardById(workspaceScope.workspaceId),
				readDeliveryReceipt: readTaskDeliveryReceipt,
				isTaskWriterActive: async (taskId) =>
					isTaskWriterActive(taskId, { clineTaskSessionService, terminalManager }),
			});
		},
		listBlockedTaskCleanups: async (workspaceScope) => ({
			blocked: await listBlockedTaskCleanups({
				repoPath: workspaceScope.workspacePath,
				board: await loadWorkspaceBoardById(workspaceScope.workspaceId),
			}),
		}),
		loadTaskContext: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			return await getTaskWorkspaceInfo({
				cwd: workspaceScope.workspacePath,
				taskId: normalizedInput.taskId,
				baseRef: normalizedInput.baseRef,
			});
		},
		searchFiles: async (workspaceScope, input) => {
			const query = input.query.trim();
			const limit = input.limit;
			const files = await searchWorkspaceFiles(workspaceScope.workspacePath, query, limit);
			return {
				query,
				files,
			} satisfies RuntimeWorkspaceFileSearchResponse;
		},
		loadState: async (workspaceScope) => {
			return await deps.buildWorkspaceStateSnapshot(workspaceScope.workspaceId, workspaceScope.workspacePath);
		},
		notifyStateUpdated: async (workspaceScope) => {
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
			return {
				ok: true,
			};
		},
		saveState: async (workspaceScope, input) => {
			try {
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				for (const summary of terminalManager.listSummaries()) {
					input.sessions[summary.taskId] = summary;
				}
				// PRLINK-5: capture the pre-save board so we can detect cards that
				// just moved into Review without PRs (best-effort lookup trigger).
				const previousBoard = await loadWorkspaceBoardById(workspaceScope.workspaceId);
				const response = await saveWorkspaceState(workspaceScope.workspacePath, input);
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
				void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
				// B-9.2: a board save is the trigger that moves a card to Done;
				// the pass itself is locked and a no-op unless dispatch is enabled.
				deps.runTaskDispatchPass?.({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
				});
				// PRTRACK-1: a board change may start or drop task-derived PR tracking
				// subscriptions. Fire-and-forget: the save response is never delayed.
				deps.runPrTrackingReconcilePass?.({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
				});
				// PRLINK-5: a card entering Review without PRs gets a best-effort
				// branch lookup. Fire-and-forget: the save response is never delayed.
				for (const taskId of findTasksEnteringReviewWithoutPullRequests(previousBoard, response.board)) {
					fireReviewPullRequestLookup({
						workspacePath: workspaceScope.workspacePath,
						taskId,
						onChanged: () => {
							// PRTRACK-1: recorded branch_lookup links mutate the
							// board with no other broadcast, so the lookup must
							// refresh open UIs and re-derive PR tracking demand
							// itself.
							void deps.broadcastRuntimeWorkspaceStateUpdated(
								workspaceScope.workspaceId,
								workspaceScope.workspacePath,
							);
						},
					});
				}

				return response;
			} catch (error) {
				if (error instanceof WorkspaceStateConflictError) {
					throw new TRPCError({
						code: "CONFLICT",
						message: error.message,
						cause: {
							currentRevision: error.currentRevision,
						},
					});
				}
				throw error;
			}
		},
		// PRLINK-5: manual PR link add. The server re-parses the URL with the
		// strict shared parser (authoritative); invalid URLs are never stored.
		addTaskPullRequest: async (workspaceScope, input): Promise<RuntimeTaskPullRequestLinkResponse> => {
			try {
				const body = parseTaskPullRequestLinkRequest(input);
				const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
				if (!taskExistsOnBoard(board, body.taskId)) {
					return {
						ok: false,
						error: `Task "${body.taskId}" not found`,
						pullRequest: null,
					} satisfies RuntimeTaskPullRequestLinkResponse;
				}
				const parsed = parsePullRequestUrl(body.url);
				if (!parsed) {
					return {
						ok: false,
						error: "Not a valid pull request URL.",
						pullRequest: null,
					} satisfies RuntimeTaskPullRequestLinkResponse;
				}
				const result = await recordTaskPullRequests({
					workspacePath: workspaceScope.workspacePath,
					taskId: body.taskId,
					links: [parsed],
					source: "manual",
				});
				if (result.changed) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
					// PRTRACK-1: a new PR link changes task-derived subscription
					// demand. Fire-and-forget: the response is never delayed.
					deps.runPrTrackingReconcilePass?.({
						workspaceId: workspaceScope.workspaceId,
						workspacePath: workspaceScope.workspacePath,
					});
				}
				// Re-read from the board: the recorded entry, or the existing
				// identical one on a duplicate add (no revision bump).
				const recorded =
					(await loadWorkspaceBoardById(workspaceScope.workspaceId)).columns
						.flatMap((column) => column.cards)
						.find((card) => card.id === body.taskId)?.pullRequests ?? [];
				const pullRequest =
					recorded.find((entry) => getPullRequestIdentityKey(entry) === getPullRequestIdentityKey(parsed)) ?? null;
				if (!pullRequest) {
					return {
						ok: false,
						error: "Could not record the pull request.",
						pullRequest: null,
					} satisfies RuntimeTaskPullRequestLinkResponse;
				}
				return {
					ok: true,
					pullRequest,
				} satisfies RuntimeTaskPullRequestLinkResponse;
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					pullRequest: null,
				} satisfies RuntimeTaskPullRequestLinkResponse;
			}
		},
		// PRLINK-5: manual PR link remove. Unknown URL -> ok: false (no throw),
		// matching the neighboring routes' error style.
		removeTaskPullRequest: async (workspaceScope, input): Promise<RuntimeTaskPullRequestLinkResponse> => {
			try {
				const body = parseTaskPullRequestLinkRequest(input);
				const parsed = parsePullRequestUrl(body.url);
				if (!parsed) {
					return {
						ok: false,
						error: "Not a valid pull request URL.",
						pullRequest: null,
					} satisfies RuntimeTaskPullRequestLinkResponse;
				}
				const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
				if (!taskExistsOnBoard(board, body.taskId)) {
					return {
						ok: false,
						error: `Task "${body.taskId}" not found`,
						pullRequest: null,
					} satisfies RuntimeTaskPullRequestLinkResponse;
				}
				// This mutation has no "add" counterpart in recordTaskPullRequests,
				// so it is the documented direct mutateWorkspaceState call outside
				// the record path (PRLINK-5).
				const identityKey = getPullRequestIdentityKey(parsed);
				const response = await mutateWorkspaceState<boolean>(workspaceScope.workspacePath, (state) => {
					const result = removeTaskPullRequest(state.board, body.taskId, identityKey);
					return { board: result.board, value: result.removed, save: result.removed };
				});
				if (response.saved) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
					// PRTRACK-1: a removed PR link may clear a card's selected
					// automation PR or its last link — re-derive demand.
					// Fire-and-forget: the response is never delayed.
					deps.runPrTrackingReconcilePass?.({
						workspaceId: workspaceScope.workspaceId,
						workspacePath: workspaceScope.workspacePath,
					});
				}
				return response.value
					? ({ ok: true, pullRequest: null } satisfies RuntimeTaskPullRequestLinkResponse)
					: ({
							ok: false,
							error: "No matching pull request is recorded for this task.",
							pullRequest: null,
						} satisfies RuntimeTaskPullRequestLinkResponse);
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					pullRequest: null,
				} satisfies RuntimeTaskPullRequestLinkResponse;
			}
		},
		// PRLINK-6: explicit display-only primary. Display preference only —
		// never touches the Automation PR selection, settings, or tracking.
		// `url: null` clears all explicit flags. The response reuses the
		// link-response shape: the selected entry re-read from the board, or
		// null when cleared.
		setPrimaryTaskPullRequest: async (workspaceScope, input): Promise<RuntimeTaskPullRequestLinkResponse> => {
			try {
				const body = parseTaskPullRequestPrimaryRequest(input);
				let identityKey: string | null;
				if (body.url === null) {
					identityKey = null;
				} else {
					const parsed = parsePullRequestUrl(body.url);
					if (!parsed) {
						return {
							ok: false,
							error: "Not a valid pull request URL.",
							pullRequest: null,
						} satisfies RuntimeTaskPullRequestLinkResponse;
					}
					identityKey = getPullRequestIdentityKey(parsed);
				}
				const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
				if (!taskExistsOnBoard(board, body.taskId)) {
					return {
						ok: false,
						error: `Task "${body.taskId}" not found`,
						pullRequest: null,
					} satisfies RuntimeTaskPullRequestLinkResponse;
				}
				const recorded =
					board.columns.flatMap((column) => column.cards).find((card) => card.id === body.taskId)?.pullRequests ??
					[];
				if (identityKey !== null && !recorded.some((entry) => getPullRequestIdentityKey(entry) === identityKey)) {
					return {
						ok: false,
						error: "That pull request is not linked to this task.",
						pullRequest: null,
					} satisfies RuntimeTaskPullRequestLinkResponse;
				}
				const response = await mutateWorkspaceState<boolean>(workspaceScope.workspacePath, (state) => {
					const result = setPrimaryTaskPullRequest(state.board, body.taskId, identityKey);
					// save: false on a no-op so a redundant choice does not bump
					// the revision or trigger a broadcast.
					return { board: result.board, value: result.updated, save: result.updated };
				});
				if (response.saved) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				// Re-read the board so the response reflects the authoritative
				// entry (or null when cleared), matching the add/remove style.
				const authoritative =
					(await loadWorkspaceBoardById(workspaceScope.workspaceId)).columns
						.flatMap((column) => column.cards)
						.find((card) => card.id === body.taskId)?.pullRequests ?? [];
				const pullRequest =
					identityKey === null
						? null
						: (authoritative.find((entry) => getPullRequestIdentityKey(entry) === identityKey) ?? null);
				// A null result is the successful cleared state, not an error.
				if (pullRequest === null && identityKey !== null) {
					return {
						ok: false,
						error: "Could not update the display primary.",
						pullRequest: null,
					} satisfies RuntimeTaskPullRequestLinkResponse;
				}
				return {
					ok: true,
					pullRequest,
				} satisfies RuntimeTaskPullRequestLinkResponse;
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					pullRequest: null,
				} satisfies RuntimeTaskPullRequestLinkResponse;
			}
		},
		// PRLINK-5: opt-in refresh. User-initiated, so a bounded await (the 10s
		// gh timeout inside the lookup) is fine.
		refreshTaskPullRequests: async (workspaceScope, input): Promise<RuntimeTaskPullRequestsRefreshResponse> => {
			try {
				const body = parseTaskPullRequestsRefreshRequest(input);
				const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
				if (!taskExistsOnBoard(board, body.taskId)) {
					return {
						ok: false,
						updated: 0,
						error: `Task "${body.taskId}" not found`,
					} satisfies RuntimeTaskPullRequestsRefreshResponse;
				}
				const result = await lookupTaskPullRequests({
					workspacePath: workspaceScope.workspacePath,
					taskId: body.taskId,
				});
				if (result.recorded > 0) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				// The reason is what the explicit Refresh toasts; it is never
				// surfaced for the automatic review-entry lookup.
				return {
					ok: true,
					updated: result.recorded,
					reason: result.reason,
				} satisfies RuntimeTaskPullRequestsRefreshResponse;
			} catch (error) {
				return {
					ok: false,
					updated: 0,
					error: error instanceof Error ? error.message : String(error),
				} satisfies RuntimeTaskPullRequestsRefreshResponse;
			}
		},
		loadWorkspaceChanges: async (workspaceScope) => {
			return await getWorkspaceChanges(workspaceScope.workspacePath);
		},
		loadGitLog: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let logCwd = workspaceScope.workspacePath;
			if (taskScope) {
				logCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getGitLog({
				cwd: logCwd,
				ref: input.ref ?? null,
				refs: input.refs ?? null,
				maxCount: input.maxCount,
				skip: input.skip,
			});
		},
		loadGitRefs: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input ?? null);
			let refsCwd = workspaceScope.workspacePath;
			if (taskScope) {
				refsCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getGitRefs(refsCwd);
		},
		loadCommitDiff: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let diffCwd = workspaceScope.workspacePath;
			if (taskScope) {
				diffCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getCommitDiff({
				cwd: diffCwd,
				commitHash: input.commitHash,
			});
		},
	};
}
