import { useCallback, useMemo } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import type { BoardData } from "@/types";
import { useInterval } from "@/utils/react-use";

const BLOCKED_CLEANUP_REFRESH_MS = 30_000;

/**
 * B-5.9: Trash cards whose worktree cleanup is still blocked, keyed by task id
 * with the reason. Refetched when the Trash column changes and periodically
 * while it has cards (cleanup runs asynchronously after a discard and is
 * retried by runtime maintenance).
 */
export function useBlockedTaskCleanups(workspaceId: string | null, board: BoardData): Record<string, string> {
	const trashTaskKey = useMemo(
		() =>
			(board.columns.find((column) => column.id === "trash")?.cards ?? [])
				.map((card) => card.id)
				.sort()
				.join(","),
		[board],
	);
	const queryFn = useCallback(async () => {
		if (!workspaceId) {
			return { blocked: [] };
		}
		// trashTaskKey is part of the identity so a Trash change triggers a refetch.
		void trashTaskKey;
		return await getRuntimeTrpcClient(workspaceId).workspace.listBlockedTaskCleanups.query();
	}, [trashTaskKey, workspaceId]);
	const { data, refetch } = useTrpcQuery({
		enabled: workspaceId !== null && trashTaskKey.length > 0,
		queryFn,
		retainDataOnError: true,
	});
	useInterval(
		() => {
			void refetch();
		},
		trashTaskKey.length > 0 ? BLOCKED_CLEANUP_REFRESH_MS : null,
	);
	return useMemo(() => {
		if (trashTaskKey.length === 0) {
			return {};
		}
		return Object.fromEntries((data?.blocked ?? []).map((entry) => [entry.taskId, entry.reason]));
	}, [data, trashTaskKey]);
}
