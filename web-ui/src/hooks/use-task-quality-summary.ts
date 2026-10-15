// DIAG-PANEL: on-demand recorded quality summary state for the diagnostics
// panel. The summary is a point-in-time capture, so it is fetched only when
// the operator loads or refreshes it — never polled. Changing workspace/task
// cancels the pending request, so a stale snapshot is never attached to
// another card.
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchTaskQualitySummary } from "@/runtime/task-quality-summary";
import type { RuntimeTaskQualitySummaryResponse } from "@/runtime/types";

export interface UseTaskQualitySummaryResult {
	/** The last loaded summary snapshot (null until the operator loads one). */
	summary: RuntimeTaskQualitySummaryResponse | null;
	/** True while a load/refresh is in flight. */
	isLoading: boolean;
	/** True while refreshing an existing snapshot (UI keeps the old data). */
	isRefreshing: boolean;
	/** Non-null when a request failed at the transport level. */
	error: string | null;
	/** Load (or refresh) the summary for the current workspace/task. */
	load: () => void;
}

export function useTaskQualitySummary(workspaceId: string | null, taskId: string | null): UseTaskQualitySummaryResult {
	const [summary, setSummary] = useState<RuntimeTaskQualitySummaryResponse | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Monotonic request ids: a response only applies to the newest request.
	const requestRef = useRef(0);
	const pendingRef = useRef(false);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	// Workspace/task change: drop the snapshot and invalidate any pending
	// request so a slow response never lands on a different card.
	useEffect(() => {
		requestRef.current += 1;
		pendingRef.current = false;
		setSummary(null);
		setError(null);
		setIsLoading(false);
	}, [workspaceId, taskId]);

	const load = useCallback(() => {
		if (pendingRef.current || workspaceId === null || taskId === null) {
			return;
		}
		requestRef.current += 1;
		const requestId = requestRef.current;
		pendingRef.current = true;
		setIsLoading(true);
		setError(null);
		void (async () => {
			const response = await fetchTaskQualitySummary(workspaceId, taskId);
			if (!mountedRef.current) {
				pendingRef.current = false;
				return;
			}
			if (requestRef.current !== requestId) {
				pendingRef.current = false;
				return; // workspace/task changed mid-request
			}
			pendingRef.current = false;
			setIsLoading(false);
			if (response === null) {
				setError("The recorded summary request failed.");
				return;
			}
			setSummary(response);
		})();
	}, [workspaceId, taskId]);

	return {
		summary,
		isLoading,
		isRefreshing: isLoading && summary !== null,
		error,
		load,
	};
}
