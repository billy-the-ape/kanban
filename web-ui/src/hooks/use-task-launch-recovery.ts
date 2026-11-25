import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskLaunchRecoveryResponse } from "@/runtime/types";

/**
 * AA-UNSUPPORTED: "does this card have a worktree but no agent, and can it be
 * relaunched?" — asked where the answer is knowable.
 *
 * The question needs the persisted baseline record, the worktree's HEAD, any
 * delivery receipt or stored patch, and the agent's own session evidence. None
 * of that is on the board, so the detail view asks the runtime instead of
 * guessing from a missing pid — a guess would label an interrupted session that
 * is waiting to be restored as "never started".
 */
export interface UseTaskLaunchRecoveryResult {
	recovery: RuntimeTaskLaunchRecoveryResponse | null;
	refresh: () => void;
}

export function useTaskLaunchRecovery(input: {
	currentProjectId: string | null;
	taskId: string | null;
	/** Skip the query while a live agent is running for the card. */
	enabled: boolean;
}): UseTaskLaunchRecoveryResult {
	const { currentProjectId, taskId, enabled } = input;
	const [recovery, setRecovery] = useState<RuntimeTaskLaunchRecoveryResponse | null>(null);
	const [refreshToken, setRefreshToken] = useState(0);
	// Only the answer for the card that is currently open may be shown.
	const requestKeyRef = useRef<string | null>(null);

	const refresh = useCallback(() => {
		setRefreshToken((current) => current + 1);
	}, []);

	useEffect(() => {
		const key = currentProjectId && taskId ? `${currentProjectId}:${taskId}` : null;
		requestKeyRef.current = key;
		if (!currentProjectId || !taskId || !enabled) {
			setRecovery(null);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const response = await trpcClient.runtime.taskLaunchRecoveryStatus.query({ taskId });
				if (cancelled || requestKeyRef.current !== key) {
					return;
				}
				setRecovery(response);
			} catch {
				if (!cancelled && requestKeyRef.current === key) {
					setRecovery(null);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [currentProjectId, taskId, enabled, refreshToken]);

	return { recovery, refresh };
}

/**
 * Whether the card is in a state where "did an agent ever start?" is worth
 * asking. Both halves matter:
 *
 * - Only In Progress and Review cards can have a prepared worktree; a Backlog
 *   card has nothing to have failed in.
 * - A card with a live session, or with a stopped session that ever started
 *   (pid/started record), is not "never launched" — and an interrupted record is
 *   deliberately included, because that card belongs to Restore, not to a
 *   relaunch. A card with *no* session record at all is the case the question
 *   exists for, so a missing summary must not be treated as a live session.
 */
export function mayHaveUnstartedLaunch(input: {
	columnId: string;
	sessionSummary: { state: string; pid: number | null; reviewReason: string | null } | null;
}): boolean {
	if (input.columnId !== "in_progress" && input.columnId !== "review") {
		return false;
	}
	if (input.sessionSummary === null) {
		return true;
	}
	const summary = input.sessionSummary;
	if (summary.state === "running" || summary.pid !== null) {
		return false;
	}
	return !(summary.state === "awaiting_review" && summary.reviewReason !== "error");
}
