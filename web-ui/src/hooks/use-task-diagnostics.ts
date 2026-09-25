// B-10.2/3/7: single-task diagnostics state for the detail view — the
// aggregated query, the operator actions (with a pending state so double
// clicks never double-run), and the redacted bundle export.
import { useCallback, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { exportTaskDiagnostics, fetchTaskDiagnostics, runTaskDiagnosticsAction } from "@/runtime/task-diagnostics";
import type { RuntimeTaskDiagnosticsActionName, RuntimeTaskDiagnosticsResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

const ACTION_LABELS: Record<RuntimeTaskDiagnosticsActionName, string> = {
	retry_phase: "Retry phase",
	resume_repair: "Resume repair",
	cancel: "Cancel",
	recover_workspace: "Recover workspace",
};

export function useTaskDiagnostics(workspaceId: string | null, taskId: string | null) {
	const [pendingAction, setPendingAction] = useState<RuntimeTaskDiagnosticsActionName | null>(null);
	const [exporting, setExporting] = useState(false);

	const queryFn = useCallback(async () => {
		if (!taskId) {
			return null;
		}
		return await fetchTaskDiagnostics(workspaceId, taskId);
	}, [taskId, workspaceId]);

	const result = useTrpcQuery<RuntimeTaskDiagnosticsResponse | null>({
		enabled: workspaceId !== null && taskId !== null,
		queryFn,
		// Keep the last snapshot while refreshing (phase chips must not flicker).
		retainDataOnError: true,
	});

	const runAction = useCallback(
		async (action: RuntimeTaskDiagnosticsActionName) => {
			if (!taskId || pendingAction !== null) {
				return;
			}
			setPendingAction(action);
			try {
				const response = await runTaskDiagnosticsAction(workspaceId, taskId, action);
				if (response === null) {
					showAppToast({ intent: "danger", message: `${ACTION_LABELS[action]} failed: runtime request error.` });
					return;
				}
				if (response.ok) {
					const dedupeNote = response.deduplicated ? " (already in flight; result shared)" : "";
					showAppToast({
						intent: "success",
						message: `${ACTION_LABELS[action]} complete${dedupeNote}.`,
					});
				} else {
					showAppToast({
						intent: "danger",
						message: `${ACTION_LABELS[action]}: ${response.error ?? "unknown error"}`,
					});
				}
			} finally {
				setPendingAction(null);
				void result.refetch();
			}
		},
		[result, taskId, pendingAction, workspaceId],
	);

	const exportBundle = useCallback(async () => {
		if (!taskId || exporting) {
			return;
		}
		setExporting(true);
		try {
			const response = await exportTaskDiagnostics(workspaceId, taskId);
			if (response?.ok && response.bundlePath) {
				const redactionNote =
					response.redactions.length > 0 ? ` (redacted: ${response.redactions.join(", ")})` : "";
				showAppToast({
					intent: "success",
					message: `Diagnostics bundle written to ${response.bundlePath}${redactionNote}`,
					timeout: 8000,
				});
			} else {
				showAppToast({
					intent: "danger",
					message: `Diagnostics export failed: ${response?.error ?? "runtime request error"}`,
				});
			}
		} finally {
			setExporting(false);
		}
	}, [exporting, taskId, workspaceId]);

	return {
		diagnostics: result.data,
		isLoading: result.isLoading,
		isRefreshing: result.isLoading && result.data !== null,
		refetch: result.refetch,
		runAction,
		pendingAction,
		exportBundle,
		exporting,
	};
}
