import { useCallback, useEffect, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskPrTrackingState } from "@/runtime/types";
import { useInterval } from "@/utils/react-use";

const POLL_INTERVAL_MS = 5000;

/**
 * COMMENT-0: polls the server-owned PR comment tracking state for a task
 * while `active` (the detail popover is open). The response is authoritative:
 * it reflects the card's opt-in, the linked PR, pending feedback, dispatch
 * status, and visible blockers. No comment bodies cross the boundary.
 */
export function useTaskPrTrackingState(
	workspaceId: string,
	taskId: string | null,
	active: boolean,
): {
	state: RuntimeTaskPrTrackingState | null;
	isPending: boolean;
} {
	const [state, setState] = useState<RuntimeTaskPrTrackingState | null>(null);
	const [isPending, setIsPending] = useState(false);

	const refresh = useCallback(async (): Promise<void> => {
		if (!taskId) {
			return;
		}
		setIsPending(true);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).runtime.getTaskPrTrackingState.query({ taskId });
			setState(response.ok ? response.state : null);
		} catch {
			// Keep the last known state when a refresh is transiently unavailable.
		} finally {
			setIsPending(false);
		}
	}, [taskId, workspaceId]);

	useEffect(() => {
		if (!active || !taskId) {
			setState(null);
			setIsPending(false);
			return;
		}
		void refresh();
	}, [active, refresh, taskId]);

	useInterval(
		() => {
			void refresh();
		},
		active && taskId !== null ? POLL_INTERVAL_MS : null,
	);

	return { state, isPending };
}
