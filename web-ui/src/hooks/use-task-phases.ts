// B-10.1: batched reliable-completion phase summaries for board chips.
// Re-queries when the workspace, the task set, or the board fingerprint
// (task ids + updatedAt per column + session states) changes, so chips track
// board and session changes without per-card requests. Delivery receipts
// advance without touching the board, so the hook also polls: quickly while
// a delivery is in flight, slowly otherwise.
import { useCallback, useMemo } from "react";

import { fetchTaskPhases } from "@/runtime/task-diagnostics";
import type { RuntimeTaskPhase, RuntimeTaskPhaseSummary } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { useInterval } from "@/utils/react-use";

const DELIVERY_IN_FLIGHT_REFRESH_MS = 3_000;
const IDLE_REFRESH_MS = 15_000;

const DELIVERY_IN_FLIGHT_PHASES: ReadonlySet<RuntimeTaskPhase> = new Set([
	"checking",
	"committing",
	"integrating",
	"pushing",
	"verifying_remote",
]);

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
	const phases = result.data ?? {};
	const deliveryInFlight = Object.values(phases).some((summary) => DELIVERY_IN_FLIGHT_PHASES.has(summary.phase));
	const { refetch } = result;
	useInterval(
		() => {
			void refetch();
		},
		enabled ? (deliveryInFlight ? DELIVERY_IN_FLIGHT_REFRESH_MS : IDLE_REFRESH_MS) : null,
	);
	return {
		phases,
		isLoading: result.isLoading,
		refetch,
	};
}
