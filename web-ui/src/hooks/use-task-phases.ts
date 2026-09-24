// B-10.1: batched reliable-completion phase summaries for board chips.
// Re-queries when the workspace, the task set, or the board fingerprint
// (task ids + updatedAt per column) changes, so chips track board mutations
// without per-card requests.
import { useCallback, useMemo } from "react";

import { fetchTaskPhases } from "@/runtime/task-diagnostics";
import type { RuntimeTaskPhaseSummary } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export function useTaskPhases(
	workspaceId: string | null,
	taskIds: string[],
	boardFingerprint: string,
): {
	phases: Record<string, RuntimeTaskPhaseSummary>;
	isLoading: boolean;
	refetch: () => Promise<Record<string, RuntimeTaskPhaseSummary> | null>;
} {
	const idsKey = useMemo(() => [...taskIds].sort().join(","), [taskIds]);
	const enabled = workspaceId !== null && idsKey.length > 0;
	const queryFn = useCallback(async () => {
		const ids = idsKey.length > 0 ? idsKey.split(",") : [];
		return await fetchTaskPhases(workspaceId, ids);
	}, [idsKey, workspaceId, boardFingerprint]);
	const result = useTrpcQuery<Record<string, RuntimeTaskPhaseSummary>>({
		enabled,
		queryFn,
		// Keep the last good chip data when a transient fetch fails.
		retainDataOnError: true,
	});
	return {
		phases: result.data ?? {},
		isLoading: result.isLoading,
		refetch: result.refetch,
	};
}
