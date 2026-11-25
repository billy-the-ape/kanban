// PRLINK-10: shared orchestration for task pull-request link actions.
// Used by the desktop/mobile manager popover (task-pull-request-manager)
// and the task-detail PRs view (task-pr-tracking-panel) so add/remove/
// primary/refresh behavior stays identical in every surface.
//
// Pending state is per action/identity and task-scoped: switching tasks or
// workspaces drops every pending indicator, and a stale response from the
// previous scope never clears a newer scope's pending state. Server
// responses are authoritative (the board refreshes via the state broadcast);
// failures surface as toasts and never remove the stored row locally.

import { useCallback, useEffect, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskPullRequest } from "@/runtime/types";
import { toCanonicalPrKeyForLink } from "@/utils/pr-tracking";
import { getLinkedRefreshMessages, getPullRequestKey, getPullRequestRefreshMessage } from "@/utils/task-pull-requests";

/** Sentinel pending key for the "use automatic display order" (clear) action. */
export const CLEAR_PRIMARY_PENDING_KEY = "__clear-primary__";

interface TaskPullRequestScope {
	workspaceId: string;
	taskId: string;
}

export interface UseTaskPullRequestActionsArgs {
	workspaceId: string | null;
	taskId: string;
	/** Stored links for the task (decides which linked refresh has work to do). */
	pullRequests: RuntimeTaskPullRequest[];
}

export interface TaskPullRequestActions {
	adding: boolean;
	addError: string | null;
	clearAddError: () => void;
	/** Returns true when the server accepted the link. */
	addPullRequest: (url: string) => Promise<boolean>;
	removingKey: string | null;
	/** Removes the association only; never closes the remote PR. */
	removePullRequest: (pullRequest: RuntimeTaskPullRequest) => Promise<void>;
	primaryPendingKey: string | null;
	makePrimary: (pullRequest: RuntimeTaskPullRequest) => Promise<void>;
	clearPrimary: () => Promise<void>;
	refreshingKey: string | null;
	refreshEntry: (pullRequest: RuntimeTaskPullRequest) => Promise<void>;
	linkedRefreshing: boolean;
	refreshLinked: () => Promise<void>;
	branchLookupPending: boolean;
	findBranchPullRequests: () => Promise<void>;
	refreshAllPending: boolean;
	/** Branch lookup followed by a linked-metadata refresh (manager Refresh). */
	refreshAll: () => Promise<void>;
	/** PCR-2: pending indicator for the Resolve-conflicts dispatch (PR key). */
	repairPendingKey: string | null;
	/** PCR-1: pending indicator for the conflict Re-check (PR key). */
	recheckPendingKey: string | null;
	/**
	 * PCR-2: the last repair refusal, shown inline next to the row (a push is
	 * destructive-adjacent, so the reason must survive a re-render, not just
	 * live in a toast).
	 */
	repairError: string | null;
	clearRepairError: () => void;
	/** Returns true when the server accepted the repair turn. */
	resolveConflicts: (pullRequest: RuntimeTaskPullRequest) => Promise<boolean>;
	/** PCR-1: force one provider read for the conflict block (Re-check). */
	recheckConflict: (pullRequest: RuntimeTaskPullRequest) => Promise<void>;
}

function toErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function useTaskPullRequestActions({
	workspaceId,
	taskId,
	pullRequests,
}: UseTaskPullRequestActionsArgs): TaskPullRequestActions {
	const [adding, setAdding] = useState(false);
	const [addError, setAddError] = useState<string | null>(null);
	const [removingKey, setRemovingKey] = useState<string | null>(null);
	const [primaryPendingKey, setPrimaryPendingKey] = useState<string | null>(null);
	const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
	const [linkedRefreshing, setLinkedRefreshing] = useState(false);
	const [branchLookupPending, setBranchLookupPending] = useState(false);
	const [refreshAllPending, setRefreshAllPending] = useState(false);
	const [repairPendingKey, setRepairPendingKey] = useState<string | null>(null);
	const [recheckPendingKey, setRecheckPendingKey] = useState<string | null>(null);
	const [repairError, setRepairError] = useState<string | null>(null);

	// Task-scoped pending state: switching tasks/workspaces drops any pending
	// indicators so a previous task's in-flight mutation cannot drive this
	// task's UI.
	useEffect(() => {
		setAdding(false);
		setAddError(null);
		setRemovingKey(null);
		setPrimaryPendingKey(null);
		setRefreshingKey(null);
		setLinkedRefreshing(false);
		setBranchLookupPending(false);
		setRefreshAllPending(false);
		setRepairPendingKey(null);
		setRecheckPendingKey(null);
		setRepairError(null);
	}, [workspaceId, taskId]);

	// Current scope, read by in-flight actions when their responses land.
	const scopeRef = useRef<TaskPullRequestScope | null>(null);
	scopeRef.current = workspaceId !== null ? { workspaceId, taskId } : null;

	const sameScope = (scope: TaskPullRequestScope): boolean => {
		const current = scopeRef.current;
		return current !== null && current.workspaceId === scope.workspaceId && current.taskId === scope.taskId;
	};

	const clearAddError = useCallback(() => {
		setAddError(null);
	}, []);

	const clearRepairError = useCallback(() => {
		setRepairError(null);
	}, []);

	const resolveConflicts = useCallback(
		async (pullRequest: RuntimeTaskPullRequest): Promise<boolean> => {
			const prKey = toCanonicalPrKeyForLink(pullRequest);
			if (workspaceId === null || prKey === null) {
				return false;
			}
			const scope = { workspaceId, taskId };
			const key = getPullRequestKey(pullRequest);
			setRepairPendingKey(key);
			setRepairError(null);
			try {
				const response = await getRuntimeTrpcClient(workspaceId).workspace.prTracking.resolveTaskPrConflicts.mutate(
					{
						taskId,
						prKey,
					},
				);
				if (!sameScope(scope)) {
					return response.ok;
				}
				if (!response.ok) {
					// Refusals are inline text next to the row, not toasts only.
					setRepairError(response.error || "Could not dispatch the conflict repair.");
					return false;
				}
				showAppToast({
					intent: "primary",
					message: "Sent the conflict-repair turn to the task agent.",
				});
				return true;
			} catch (error) {
				const message = toErrorMessage(error, "Could not dispatch the conflict repair.");
				if (sameScope(scope)) {
					setRepairError(message);
				}
				return false;
			} finally {
				if (sameScope(scope)) {
					setRepairPendingKey(null);
				}
			}
		},
		[taskId, workspaceId],
	);

	const recheckConflict = useCallback(
		async (pullRequest: RuntimeTaskPullRequest): Promise<void> => {
			const prKey = toCanonicalPrKeyForLink(pullRequest);
			if (workspaceId === null || prKey === null) {
				return;
			}
			const scope = { workspaceId, taskId };
			const key = getPullRequestKey(pullRequest);
			setRecheckPendingKey(key);
			try {
				const response = await getRuntimeTrpcClient(workspaceId).workspace.prTracking.refreshTaskPrConflict.mutate({
					taskId,
					prKey,
				});
				if (!sameScope(scope)) {
					return;
				}
				if (!response.ok) {
					showAppToast({ intent: "warning", message: response.error || "Could not re-check mergeability." });
					return;
				}
				const state = response.conflict?.state ?? "unknown";
				showAppToast({
					intent: state === "conflicting" ? "warning" : "primary",
					message:
						state === "conflicting"
							? "Still conflicting against the base branch."
							: state === "clean"
								? "Conflicts resolved — the PR merges cleanly."
								: "GitHub is recomputing mergeability.",
				});
			} catch (error) {
				showAppToast({ intent: "warning", message: toErrorMessage(error, "Could not re-check mergeability.") });
			} finally {
				if (sameScope(scope)) {
					setRecheckPendingKey(null);
				}
			}
		},
		[taskId, workspaceId],
	);

	const addPullRequest = useCallback(
		async (url: string): Promise<boolean> => {
			if (workspaceId === null || adding) {
				return false;
			}
			const scope = { workspaceId, taskId };
			setAdding(true);
			setAddError(null);
			try {
				const response = await getRuntimeTrpcClient(workspaceId).workspace.addTaskPullRequest.mutate({
					taskId,
					url,
				});
				if (!response.ok) {
					showAppToast({ intent: "danger", message: response.error || "Could not add the pull request." });
					if (sameScope(scope)) {
						setAddError(response.error || "Could not add the pull request.");
					}
					return false;
				}
				return true;
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: toErrorMessage(error, "Could not add the pull request."),
				});
				if (sameScope(scope)) {
					setAddError(toErrorMessage(error, "Could not add the pull request."));
				}
				return false;
			} finally {
				if (sameScope(scope)) {
					setAdding(false);
				}
			}
		},
		[adding, taskId, workspaceId],
	);

	const removePullRequest = useCallback(
		async (pullRequest: RuntimeTaskPullRequest): Promise<void> => {
			if (workspaceId === null) {
				return;
			}
			const scope = { workspaceId, taskId };
			const key = getPullRequestKey(pullRequest);
			setRemovingKey(key);
			try {
				const response = await getRuntimeTrpcClient(workspaceId).workspace.removeTaskPullRequest.mutate({
					taskId,
					url: pullRequest.url,
				});
				if (!response.ok) {
					showAppToast({
						intent: "danger",
						message: response.error || "Could not remove the pull request.",
					});
				}
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: toErrorMessage(error, "Could not remove the pull request."),
				});
			} finally {
				if (sameScope(scope)) {
					setRemovingKey(null);
				}
			}
		},
		[taskId, workspaceId],
	);

	const makePrimary = useCallback(
		async (pullRequest: RuntimeTaskPullRequest): Promise<void> => {
			if (workspaceId === null) {
				return;
			}
			const scope = { workspaceId, taskId };
			const key = getPullRequestKey(pullRequest);
			setPrimaryPendingKey(key);
			try {
				const response = await getRuntimeTrpcClient(workspaceId).workspace.setPrimaryTaskPullRequest.mutate({
					taskId,
					url: pullRequest.url,
				});
				if (!response.ok) {
					showAppToast({
						intent: "danger",
						message: response.error || "Could not update the display primary.",
					});
				}
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: toErrorMessage(error, "Could not update the display primary."),
				});
			} finally {
				if (sameScope(scope)) {
					setPrimaryPendingKey(null);
				}
			}
		},
		[taskId, workspaceId],
	);

	const clearPrimary = useCallback(async (): Promise<void> => {
		if (workspaceId === null) {
			return;
		}
		const scope = { workspaceId, taskId };
		setPrimaryPendingKey(CLEAR_PRIMARY_PENDING_KEY);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).workspace.setPrimaryTaskPullRequest.mutate({
				taskId,
				url: null,
			});
			if (!response.ok) {
				showAppToast({
					intent: "danger",
					message: response.error || "Could not update the display primary.",
				});
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: toErrorMessage(error, "Could not update the display primary."),
			});
		} finally {
			if (sameScope(scope)) {
				setPrimaryPendingKey(null);
			}
		}
	}, [taskId, workspaceId]);

	const refreshEntry = useCallback(
		async (pullRequest: RuntimeTaskPullRequest): Promise<void> => {
			if (workspaceId === null) {
				return;
			}
			const scope = { workspaceId, taskId };
			const key = getPullRequestKey(pullRequest);
			setRefreshingKey(key);
			try {
				const response = await getRuntimeTrpcClient(workspaceId).workspace.refreshTaskPullRequestEntry.mutate({
					taskId,
					url: pullRequest.url,
				});
				if (!response.ok) {
					showAppToast({
						intent: "warning",
						message: response.error || "Could not refresh the pull request.",
					});
					return;
				}
				for (const message of getLinkedRefreshMessages(response.updated, response.outcomes)) {
					showAppToast({ intent: "primary", message });
				}
			} catch (error) {
				showAppToast({
					intent: "warning",
					message: toErrorMessage(error, "Could not refresh the pull request."),
				});
			} finally {
				if (sameScope(scope)) {
					setRefreshingKey(null);
				}
			}
		},
		[taskId, workspaceId],
	);

	const refreshLinked = useCallback(async (): Promise<void> => {
		if (workspaceId === null || linkedRefreshing) {
			return;
		}
		const scope = { workspaceId, taskId };
		setLinkedRefreshing(true);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).workspace.refreshLinkedTaskPullRequests.mutate({
				taskId,
			});
			if (!response.ok) {
				showAppToast({
					intent: "warning",
					message: response.error || "Could not refresh the linked pull requests.",
				});
				return;
			}
			for (const message of getLinkedRefreshMessages(response.updated, response.outcomes)) {
				showAppToast({ intent: "primary", message });
			}
		} catch (error) {
			showAppToast({
				intent: "warning",
				message: toErrorMessage(error, "Could not refresh the linked pull requests."),
			});
		} finally {
			if (sameScope(scope)) {
				setLinkedRefreshing(false);
			}
		}
	}, [linkedRefreshing, taskId, workspaceId]);

	const findBranchPullRequests = useCallback(async (): Promise<void> => {
		if (workspaceId === null || branchLookupPending) {
			return;
		}
		const scope = { workspaceId, taskId };
		setBranchLookupPending(true);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).workspace.refreshTaskPullRequests.mutate({
				taskId,
			});
			if (!response.ok) {
				showAppToast({ intent: "warning", message: response.error || "Refresh failed." });
				return;
			}
			const message = getPullRequestRefreshMessage(response.reason);
			if (message) {
				showAppToast({ intent: "primary", message });
			}
		} catch (error) {
			showAppToast({ intent: "warning", message: toErrorMessage(error, "Refresh failed.") });
		} finally {
			if (sameScope(scope)) {
				setBranchLookupPending(false);
			}
		}
	}, [branchLookupPending, taskId, workspaceId]);

	const refreshAll = useCallback(async (): Promise<void> => {
		if (workspaceId === null || refreshAllPending) {
			return;
		}
		const scope = { workspaceId, taskId };
		setRefreshAllPending(true);
		try {
			const client = getRuntimeTrpcClient(workspaceId);
			const response = await client.workspace.refreshTaskPullRequests.mutate({ taskId });
			if (!response.ok) {
				showAppToast({ intent: "warning", message: response.error || "Refresh failed." });
				return;
			}
			const message = getPullRequestRefreshMessage(response.reason);
			if (message) {
				showAppToast({ intent: "primary", message });
			}
			// Also refresh the stored links' metadata via the provider (works
			// for Done tasks and links recorded from another branch/repo).
			if (pullRequests.length > 0) {
				const linked = await client.workspace.refreshLinkedTaskPullRequests.mutate({ taskId });
				for (const linkedMessage of getLinkedRefreshMessages(linked.updated, linked.outcomes)) {
					showAppToast({ intent: "primary", message: linkedMessage });
				}
			}
		} catch (error) {
			showAppToast({ intent: "warning", message: toErrorMessage(error, "Refresh failed.") });
		} finally {
			if (sameScope(scope)) {
				setRefreshAllPending(false);
			}
		}
	}, [pullRequests.length, refreshAllPending, taskId, workspaceId]);

	return {
		adding,
		addError,
		clearAddError,
		addPullRequest,
		removingKey,
		removePullRequest,
		primaryPendingKey,
		makePrimary,
		clearPrimary,
		refreshingKey,
		refreshEntry,
		linkedRefreshing,
		refreshLinked,
		branchLookupPending,
		findBranchPullRequests,
		refreshAllPending,
		refreshAll,
		repairPendingKey,
		recheckPendingKey,
		repairError,
		clearRepairError,
		resolveConflicts,
		recheckConflict,
	};
}
