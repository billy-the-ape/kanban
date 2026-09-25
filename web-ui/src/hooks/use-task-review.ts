import { useCallback, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskReviewInfoResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { useTaskWorkspaceStateVersionValue } from "@/stores/workspace-metadata-store";

export type TaskReviewVerdict = "ready" | "blocked" | "failed" | "stale" | null;

export interface UseTaskReviewResult {
	verdict: TaskReviewVerdict;
	/** Human-readable detail for the verdict (error or findings summary). */
	detail: string | null;
	isRunning: boolean;
	startReview: () => void;
}

/** B-6.7: a stored verdict only counts while it is bound to the current worktree tree. */
export function resolveTaskReviewVerdict(info: RuntimeTaskReviewInfoResponse | null): TaskReviewVerdict {
	if (!info?.status) {
		return null;
	}
	if (info.resultMatchesTree === false) {
		return "stale";
	}
	if (info.status === "ready") {
		return "ready";
	}
	return info.status === "blocked" ? "blocked" : "failed";
}

/**
 * B-6: runs the bounded review for a task and exposes its durable verdict.
 * The verdict is refetched whenever the task worktree changes, so an edit
 * after the review shows as stale.
 */
export function useTaskReview(input: {
	workspaceId: string | null;
	taskId: string;
	description: string;
	taskTitle: string | null;
}): UseTaskReviewResult {
	const { workspaceId, taskId, description, taskTitle } = input;
	const [isRunning, setIsRunning] = useState(false);
	const workspaceStateVersion = useTaskWorkspaceStateVersionValue(taskId);
	const queryFn = useCallback(async () => {
		if (!workspaceId) {
			return null;
		}
		// workspaceStateVersion is part of the identity so worktree edits refetch.
		void workspaceStateVersion;
		return await getRuntimeTrpcClient(workspaceId).runtime.getTaskReviewInfo.query({ taskId });
	}, [taskId, workspaceId, workspaceStateVersion]);
	const { data, refetch } = useTrpcQuery({ enabled: workspaceId !== null, queryFn, retainDataOnError: true });

	const startReview = useCallback(() => {
		if (!workspaceId || isRunning) {
			return;
		}
		setIsRunning(true);
		void (async () => {
			try {
				const response = await getRuntimeTrpcClient(workspaceId).runtime.startTaskReview.mutate({
					taskId,
					description,
					...(taskTitle ? { taskTitle } : {}),
				});
				const findings = response.result?.findings.length ?? 0;
				showAppToast({
					intent: response.status === "ready" ? "success" : "warning",
					icon: response.status === "ready" ? "tick" : "warning-sign",
					message:
						response.status === "ready"
							? `Review ready${findings > 0 ? ` (${findings} non-blocking finding(s))` : ""}.`
							: `Review ${response.status ?? "failed"}: ${response.error ?? `${findings} finding(s)`}`,
					timeout: 8000,
				});
			} catch (error) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: `Review failed: ${error instanceof Error ? error.message : String(error)}`,
					timeout: 8000,
				});
			} finally {
				setIsRunning(false);
				void refetch();
			}
		})();
	}, [description, isRunning, refetch, taskId, taskTitle, workspaceId]);

	const verdict = resolveTaskReviewVerdict(data);
	const detail =
		verdict === "stale"
			? "The task changed after this review; run it again before delivery."
			: (data?.error ?? (data?.result ? `${data.result.findings.length} finding(s)` : null));
	return { verdict, detail, isRunning, startReview };
}
