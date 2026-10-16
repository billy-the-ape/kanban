import { useCallback, useMemo, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { type UseGitHistoryDataResult, useGitHistoryData } from "@/components/git-history/use-git-history-data";
import { buildTaskGitActionPrompt, type TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { isNativeClineAgentSelected } from "@/runtime/native-agent";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeConfigResponse, RuntimeGitSyncAction, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import {
	getTaskWorkspaceInfo,
	getTaskWorkspaceSnapshot,
	setHomeGitSummary,
	setTaskWorkspaceInfo,
	useHomeGitStateVersionValue,
	useHomeGitSummaryValue,
	useTaskWorkspaceSnapshotValue,
	useTaskWorkspaceStateVersionValue,
} from "@/stores/workspace-metadata-store";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard, BoardData, CardSelection } from "@/types";

type TaskGitActionSource = "card" | "agent";

export type TaskGitActionDedupeIntent = "manual" | "auto";

interface TaskGitActionOptions {
	/**
	 * AUTOGIT: coordinate the generated prompt against the server-owned
	 * per-review-episode record. "auto" is set-if-absent (a same-episode
	 * record suppresses the send); "manual" records the send after success
	 * so the auto path does not re-send it.
	 */
	gitActionDedupe?: TaskGitActionDedupeIntent;
}

interface TaskGitActionLoadingState {
	commitSource: TaskGitActionSource | null;
	prSource: TaskGitActionSource | null;
}

interface UseGitActionsInput {
	currentProjectId: string | null;
	board: BoardData;
	selectedCard: CardSelection | null;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
	sendTaskChatMessage: (
		taskId: string,
		text: string,
		options?: { mode?: "plan" | "act"; source?: "user" | "automated" },
	) => Promise<{ ok: boolean; message?: string }>;
	fetchTaskWorkspaceInfo: (task: BoardCard) => Promise<RuntimeTaskWorkspaceInfoResponse | null>;
	isGitHistoryOpen: boolean;
	refreshWorkspaceState: () => Promise<void>;
}

export interface UseGitActionsResult {
	runningGitAction: RuntimeGitSyncAction | null;
	taskGitActionLoadingByTaskId: Record<string, TaskGitActionLoadingState>;
	commitTaskLoadingById: Record<string, boolean>;
	openPrTaskLoadingById: Record<string, boolean>;
	agentCommitTaskLoadingById: Record<string, boolean>;
	agentOpenPrTaskLoadingById: Record<string, boolean>;
	isSwitchingHomeBranch: boolean;
	isDiscardingHomeWorkingChanges: boolean;
	gitActionError: {
		action: RuntimeGitSyncAction;
		message: string;
		output: string;
	} | null;
	gitActionErrorTitle: string;
	clearGitActionError: () => void;
	gitHistory: UseGitHistoryDataResult;
	runGitAction: (action: RuntimeGitSyncAction) => Promise<void>;
	switchHomeBranch: (branch: string) => Promise<void>;
	discardHomeWorkingChanges: () => Promise<void>;
	handleCommitTask: (taskId: string) => void;
	handleOpenPrTask: (taskId: string) => void;
	handleAgentCommitTask: (taskId: string) => void;
	handleAgentOpenPrTask: (taskId: string) => void;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
	resetGitActionState: () => void;
}

function matchesWorkspaceInfoSelection(
	workspaceInfo: RuntimeTaskWorkspaceInfoResponse | null,
	card: BoardCard | null,
): workspaceInfo is RuntimeTaskWorkspaceInfoResponse {
	if (!workspaceInfo || !card) {
		return false;
	}
	return workspaceInfo.taskId === card.id && workspaceInfo.baseRef === card.baseRef;
}

export function useGitActions({
	currentProjectId,
	board,
	selectedCard,
	runtimeProjectConfig,
	sendTaskSessionInput,
	sendTaskChatMessage,
	fetchTaskWorkspaceInfo,
	isGitHistoryOpen,
	refreshWorkspaceState,
}: UseGitActionsInput): UseGitActionsResult {
	const [runningGitAction, setRunningGitAction] = useState<RuntimeGitSyncAction | null>(null);
	const [taskGitActionLoadingByTaskId, setTaskGitActionLoadingByTaskId] = useState<
		Record<string, TaskGitActionLoadingState>
	>({});
	const [isSwitchingHomeBranch, setIsSwitchingHomeBranch] = useState(false);
	const [isDiscardingHomeWorkingChanges, setIsDiscardingHomeWorkingChanges] = useState(false);
	const [gitActionError, setGitActionError] = useState<{
		action: RuntimeGitSyncAction;
		message: string;
		output: string;
	} | null>(null);
	const homeGitSummary = useHomeGitSummaryValue();
	const homeGitStateVersion = useHomeGitStateVersionValue();
	const selectedTaskWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(selectedCard?.card.id ?? null);
	const selectedTaskWorkspaceStateVersion = useTaskWorkspaceStateVersionValue(selectedCard?.card.id ?? null);

	const gitHistoryTaskScope = useMemo(() => {
		if (!selectedCard) {
			return null;
		}
		return {
			taskId: selectedCard.card.id,
			baseRef: selectedCard.card.baseRef,
		};
	}, [selectedCard?.card.baseRef, selectedCard?.card.id]);

	const gitHistorySummary = useMemo(() => {
		if (!selectedCard) {
			return homeGitSummary;
		}
		if (!selectedTaskWorkspaceSnapshot) {
			return null;
		}
		return {
			currentBranch: selectedTaskWorkspaceSnapshot.branch,
			upstreamBranch: null,
			changedFiles: selectedTaskWorkspaceSnapshot.changedFiles ?? 0,
			additions: selectedTaskWorkspaceSnapshot.additions ?? 0,
			deletions: selectedTaskWorkspaceSnapshot.deletions ?? 0,
			aheadCount: 0,
			behindCount: 0,
		};
	}, [homeGitSummary, selectedCard, selectedTaskWorkspaceSnapshot]);
	const gitHistoryStateVersion = selectedCard ? selectedTaskWorkspaceStateVersion : homeGitStateVersion;

	const gitHistory = useGitHistoryData({
		workspaceId: currentProjectId,
		taskScope: gitHistoryTaskScope,
		gitSummary: gitHistorySummary,
		stateVersion: gitHistoryStateVersion,
		enabled: isGitHistoryOpen,
	});
	const refreshGitHistory = gitHistory.refresh;

	const setTaskGitActionLoading = useCallback(
		(taskId: string, action: TaskGitAction, source: TaskGitActionSource | null) => {
			setTaskGitActionLoadingByTaskId((current) => {
				const existing = current[taskId] ?? { commitSource: null, prSource: null };
				const key = action === "commit" ? "commitSource" : "prSource";
				if (existing[key] === source) {
					return current;
				}
				const nextEntry: TaskGitActionLoadingState = {
					...existing,
					[key]: source,
				};
				if (nextEntry.commitSource === null && nextEntry.prSource === null) {
					const { [taskId]: _removed, ...rest } = current;
					return rest;
				}
				return {
					...current,
					[taskId]: nextEntry,
				};
			});
		},
		[],
	);

	const commitTaskLoadingById = useMemo(() => {
		const next: Record<string, boolean> = {};
		for (const [taskId, loading] of Object.entries(taskGitActionLoadingByTaskId)) {
			if (loading.commitSource === "card") {
				next[taskId] = true;
			}
		}
		return next;
	}, [taskGitActionLoadingByTaskId]);

	const openPrTaskLoadingById = useMemo(() => {
		const next: Record<string, boolean> = {};
		for (const [taskId, loading] of Object.entries(taskGitActionLoadingByTaskId)) {
			if (loading.prSource === "card") {
				next[taskId] = true;
			}
		}
		return next;
	}, [taskGitActionLoadingByTaskId]);

	const agentCommitTaskLoadingById = useMemo(() => {
		const next: Record<string, boolean> = {};
		for (const [taskId, loading] of Object.entries(taskGitActionLoadingByTaskId)) {
			if (loading.commitSource === "agent") {
				next[taskId] = true;
			}
		}
		return next;
	}, [taskGitActionLoadingByTaskId]);

	const agentOpenPrTaskLoadingById = useMemo(() => {
		const next: Record<string, boolean> = {};
		for (const [taskId, loading] of Object.entries(taskGitActionLoadingByTaskId)) {
			if (loading.prSource === "agent") {
				next[taskId] = true;
			}
		}
		return next;
	}, [taskGitActionLoadingByTaskId]);

	const shouldUseClineChatForTaskGitActions = isNativeClineAgentSelected(
		runtimeProjectConfig?.selectedAgentId ?? null,
	);

	// AUTOGIT: best-effort coordination with the server-owned per-review-episode
	// record. Acquisition failures degrade to the pre-AUTOGIT behavior (send);
	// release failures leave the record in place until the episode ends.
	const acquireTaskGitActionPromptRecord = useCallback(
		async (taskId: string, action: TaskGitAction, intent: TaskGitActionDedupeIntent): Promise<boolean> => {
			if (!currentProjectId) {
				return true;
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const response = await trpcClient.workspace.acquireTaskGitActionPrompt.mutate({
					taskId,
					action,
					intent,
				});
				return response.status === "acquired";
			} catch {
				return true;
			}
		},
		[currentProjectId],
	);

	const releaseTaskGitActionPromptRecord = useCallback(
		async (taskId: string, action: TaskGitAction): Promise<void> => {
			if (!currentProjectId) {
				return;
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				await trpcClient.workspace.releaseTaskGitActionPrompt.mutate({ taskId, action });
			} catch {
				// Best-effort: the record self-clears when the card leaves Review.
			}
		},
		[currentProjectId],
	);

	const runTaskGitAction = useCallback(
		async (taskId: string, action: TaskGitAction, source: TaskGitActionSource, options?: TaskGitActionOptions) => {
			const taskLoadingState = taskGitActionLoadingByTaskId[taskId];
			const actionInFlightSource = action === "commit" ? taskLoadingState?.commitSource : taskLoadingState?.prSource;
			if (actionInFlightSource !== null && actionInFlightSource !== undefined) {
				return false;
			}
			setTaskGitActionLoading(taskId, action, source);
			try {
				const selection = findCardSelection(board, taskId);
				if (!selection) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: "Could not find the selected task card.",
						timeout: 5000,
					});
					return false;
				}
				if (selection.column.id !== "review") {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: "Commit and PR actions are only available for tasks in Review.",
						timeout: 5000,
					});
					return false;
				}

				// B-8: when deterministic delivery is enabled, the application
				// itself runs commit → integrate → push → verify → receipt. No
				// model prompt is involved, so delivery works even when the
				// model is unavailable. Both "commit" and "pr" actions route
				// through it (PR follows the policy's requirePullRequest).
				if (runtimeProjectConfig?.gitDeliveryPolicy?.enabled) {
					if (!currentProjectId) {
						showAppToast({
							intent: "danger",
							icon: "warning-sign",
							message: "No active project; cannot run deterministic delivery.",
							timeout: 6000,
						});
						return false;
					}
					const trpcClient = getRuntimeTrpcClient(currentProjectId);
					const payload = await trpcClient.runtime.startTaskDelivery.mutate({ taskId });
					if (!payload.ok || !payload.receipt) {
						showAppToast({
							intent: "danger",
							icon: "warning-sign",
							message: payload.error ?? "Git delivery failed.",
							timeout: 10000,
						});
						return false;
					}
					const receipt = payload.receipt;
					if (receipt.status === "delivered" || receipt.status === "no_op") {
						showAppToast({
							intent: "success",
							icon: "tick",
							message:
								receipt.status === "no_op"
									? "No changes to deliver; delivery recorded as a no-op."
									: `Delivered to ${receipt.destinationBranch}${
											receipt.remoteBranchSha ? ` on ${receipt.remote}` : ""
										}.`,
							timeout: 5000,
						});
						refreshGitHistory();
						await refreshWorkspaceState();
						return true;
					}
					// paused / failed: surface the resumable stage and evidence.
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: `Delivery ${receipt.status} at stage "${receipt.stage}": ${
							payload.error ?? "see the delivery receipt."
						}`,
						timeout: 10000,
					});
					return false;
				}

				const snapshot = getTaskWorkspaceSnapshot(taskId);
				const snapshotWorkspaceInfo = snapshot
					? {
							taskId,
							path: snapshot.path,
							exists: true,
							baseRef: selection.card.baseRef,
							branch: snapshot.branch,
							isDetached: snapshot.isDetached,
							headCommit: snapshot.headCommit,
						}
					: null;
				const storedWorkspaceInfo = getTaskWorkspaceInfo(selection.card.id, selection.card.baseRef);
				const workspaceInfo = matchesWorkspaceInfoSelection(storedWorkspaceInfo, selection.card)
					? storedWorkspaceInfo
					: (snapshotWorkspaceInfo ?? (await fetchTaskWorkspaceInfo(selection.card)));
				if (!workspaceInfo) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: "Could not resolve task workspace details.",
						timeout: 6000,
					});
					return false;
				}
				setTaskWorkspaceInfo(workspaceInfo);

				const dedupeIntent = options?.gitActionDedupe ?? null;
				// AUTOGIT: for the auto path, claim the per-review-episode
				// record before sending. A same-episode record means the
				// prompt was already delivered (by another client or a manual
				// click), so this caller must not send it again.
				let autoAcquired = false;
				if (dedupeIntent === "auto") {
					autoAcquired = await acquireTaskGitActionPromptRecord(taskId, action, "auto");
					if (!autoAcquired) {
						return false;
					}
				}

				const prompt = buildTaskGitActionPrompt({
					action,
					workspaceInfo,
					templates: runtimeProjectConfig
						? {
								commitPromptTemplate: runtimeProjectConfig.commitPromptTemplate,
								openPrPromptTemplate: runtimeProjectConfig.openPrPromptTemplate,
								commitPromptTemplateDefault: runtimeProjectConfig.commitPromptTemplateDefault,
								openPrPromptTemplateDefault: runtimeProjectConfig.openPrPromptTemplateDefault,
							}
						: null,
				});
				if (shouldUseClineChatForTaskGitActions) {
					// LASTPROMPT: generated commit/PR instructions are
					// automated; they must not overwrite the latest user-authored
					// prompt preview on the card.
					const sent = await sendTaskChatMessage(taskId, prompt, { mode: "act", source: "automated" });
					if (!sent.ok) {
						showAppToast({
							intent: "danger",
							icon: "warning-sign",
							message: sent.message ?? "Could not send instructions to the task chat session.",
							timeout: 7000,
						});
						// AUTOGIT: the prompt never went out; let the auto path retry.
						if (autoAcquired) {
							await releaseTaskGitActionPromptRecord(taskId, action);
						}
						return false;
					}
					if (dedupeIntent === "manual") {
						await acquireTaskGitActionPromptRecord(taskId, action, "manual");
					}
					return true;
				}
				const typed = await sendTaskSessionInput(taskId, prompt, { appendNewline: false, mode: "paste" });
				if (!typed.ok) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: typed.message ?? "Could not send instructions to the task session.",
						timeout: 7000,
					});
					if (autoAcquired) {
						await releaseTaskGitActionPromptRecord(taskId, action);
					}
					return false;
				}
				await new Promise<void>((resolve) => {
					window.setTimeout(resolve, 200);
				});
				const submitted = await sendTaskSessionInput(taskId, "\r", { appendNewline: false });
				if (!submitted.ok) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: submitted.message ?? "Could not submit instructions to the task session.",
						timeout: 7000,
					});
					if (autoAcquired) {
						await releaseTaskGitActionPromptRecord(taskId, action);
					}
					return false;
				}
				if (dedupeIntent === "manual") {
					await acquireTaskGitActionPromptRecord(taskId, action, "manual");
				}
				return true;
			} finally {
				setTaskGitActionLoading(taskId, action, null);
			}
		},
		[
			acquireTaskGitActionPromptRecord,
			board,
			currentProjectId,
			fetchTaskWorkspaceInfo,
			refreshGitHistory,
			refreshWorkspaceState,
			releaseTaskGitActionPromptRecord,
			runtimeProjectConfig,
			sendTaskChatMessage,
			sendTaskSessionInput,
			setTaskGitActionLoading,
			shouldUseClineChatForTaskGitActions,
			taskGitActionLoadingByTaskId,
		],
	);

	const handleCommitTask = useCallback(
		(taskId: string) => {
			void runTaskGitAction(taskId, "commit", "card", { gitActionDedupe: "manual" });
		},
		[runTaskGitAction],
	);

	const handleOpenPrTask = useCallback(
		(taskId: string) => {
			void runTaskGitAction(taskId, "pr", "card", { gitActionDedupe: "manual" });
		},
		[runTaskGitAction],
	);

	const handleAgentCommitTask = useCallback(
		(taskId: string) => {
			void runTaskGitAction(taskId, "commit", "agent", { gitActionDedupe: "manual" });
		},
		[runTaskGitAction],
	);

	const handleAgentOpenPrTask = useCallback(
		(taskId: string) => {
			void runTaskGitAction(taskId, "pr", "agent", { gitActionDedupe: "manual" });
		},
		[runTaskGitAction],
	);

	const runGitAction = useCallback(
		async (action: RuntimeGitSyncAction) => {
			if (!currentProjectId || runningGitAction || isSwitchingHomeBranch) {
				return;
			}
			setRunningGitAction(action);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.workspace.runGitSyncAction.mutate({ action });
				if (!payload.ok || !payload.summary) {
					const errorMessage = payload.error ?? `${action} failed.`;
					const output = payload.output ?? "";
					const fallbackSummary = payload.summary ?? null;
					if (fallbackSummary) {
						setHomeGitSummary(fallbackSummary);
					}
					setGitActionError({
						action,
						message: errorMessage,
						output,
					});
					return;
				}
				setHomeGitSummary(payload.summary);
				refreshGitHistory();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				setGitActionError({
					action,
					message,
					output: "",
				});
			} finally {
				setRunningGitAction(null);
			}
		},
		[currentProjectId, isSwitchingHomeBranch, refreshGitHistory, runningGitAction],
	);

	const switchHomeBranch = useCallback(
		async (branch: string) => {
			const normalizedBranch = branch.trim();
			const currentBranch = homeGitSummary?.currentBranch ?? null;
			if (!currentProjectId || isSwitchingHomeBranch || !normalizedBranch || normalizedBranch === currentBranch) {
				return;
			}
			setIsSwitchingHomeBranch(true);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.workspace.checkoutGitBranch.mutate({
					branch: normalizedBranch,
				});
				if (!payload.ok || !payload.summary) {
					const errorMessage = payload.error ?? "Switch branch failed.";
					const fallbackSummary = payload.summary ?? null;
					if (fallbackSummary) {
						setHomeGitSummary(fallbackSummary);
					}
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: `Could not switch to ${normalizedBranch}. ${errorMessage}`,
						timeout: 7000,
					});
					return;
				}
				setHomeGitSummary(payload.summary);
				refreshGitHistory();
				await refreshWorkspaceState();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: `Could not switch to ${normalizedBranch}. ${message}`,
					timeout: 7000,
				});
			} finally {
				setIsSwitchingHomeBranch(false);
			}
		},
		[
			currentProjectId,
			homeGitSummary?.currentBranch,
			isSwitchingHomeBranch,
			refreshGitHistory,
			refreshWorkspaceState,
		],
	);

	const discardHomeWorkingChanges = useCallback(async () => {
		if (!currentProjectId || isDiscardingHomeWorkingChanges) {
			return;
		}
		setIsDiscardingHomeWorkingChanges(true);
		try {
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			const payload = await trpcClient.workspace.discardGitChanges.mutate(null);
			if (!payload.ok) {
				if (payload.summary) {
					setHomeGitSummary(payload.summary);
				}
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: payload.error ?? "Could not discard working copy changes.",
					timeout: 7000,
				});
				return;
			}
			setHomeGitSummary(payload.summary);
			refreshGitHistory();
			showAppToast({
				intent: "success",
				icon: "tick",
				message: "Discarded working copy changes.",
				timeout: 4000,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message: `Could not discard working copy changes. ${message}`,
				timeout: 7000,
			});
		} finally {
			setIsDiscardingHomeWorkingChanges(false);
		}
	}, [currentProjectId, isDiscardingHomeWorkingChanges, refreshGitHistory]);

	const runAutoReviewGitAction = useCallback(
		async (taskId: string, action: TaskGitAction) => {
			// AUTOGIT: the auto path is the dedupe-critical caller; the server
			// record decides whether this episode has already been prompted.
			return await runTaskGitAction(taskId, action, "card", { gitActionDedupe: "auto" });
		},
		[runTaskGitAction],
	);

	const resetGitActionState = useCallback(() => {
		setRunningGitAction(null);
		setTaskGitActionLoadingByTaskId({});
		setIsSwitchingHomeBranch(false);
		setIsDiscardingHomeWorkingChanges(false);
		setGitActionError(null);
	}, []);

	const gitActionErrorTitle = useMemo(() => {
		if (!gitActionError) {
			return "Git action failed";
		}
		if (gitActionError.action === "fetch") {
			return "Fetch failed";
		}
		if (gitActionError.action === "pull") {
			return "Pull failed";
		}
		return "Push failed";
	}, [gitActionError]);

	return {
		runningGitAction,
		taskGitActionLoadingByTaskId,
		commitTaskLoadingById,
		openPrTaskLoadingById,
		agentCommitTaskLoadingById,
		agentOpenPrTaskLoadingById,
		isSwitchingHomeBranch,
		isDiscardingHomeWorkingChanges,
		gitActionError,
		gitActionErrorTitle,
		clearGitActionError: () => {
			setGitActionError(null);
		},
		gitHistory,
		runGitAction,
		switchHomeBranch,
		discardHomeWorkingChanges,
		handleCommitTask,
		handleOpenPrTask,
		handleAgentCommitTask,
		handleAgentOpenPrTask,
		runAutoReviewGitAction,
		resetGitActionState,
	};
}
