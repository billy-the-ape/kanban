import { useCallback, useEffect, useRef } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeWorkspaceChangesMode, RuntimeWorkspaceChangesResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseRuntimeWorkspaceChangesResult {
	changes: RuntimeWorkspaceChangesResponse | null;
	isLoading: boolean;
	isRuntimeAvailable: boolean;
	refresh: () => Promise<void>;
}

export function useRuntimeWorkspaceChanges(
	taskId: string | null,
	workspaceId: string | null,
	baseRef: string | null,
	mode: RuntimeWorkspaceChangesMode = "working_copy",
	stateVersion = 0,
	pollIntervalMs: number | null = null,
	viewKey: string | null = null,
	clearOnViewTransition = true,
	// PRLINK-10: gate ALL detail-diff reads behind a visible changes view —
	// the initial query, state-version refetches, explicit refresh, and the
	// poll interval. Setting pollIntervalMs to null alone is not sufficient.
	// In-flight reads are invalidated by useTrpcQuery when the gate turns off.
	enabled = true,
): UseRuntimeWorkspaceChangesResult {
	const hasWorkspaceScope = taskId !== null && workspaceId !== null && baseRef !== null;
	// PRLINK-10: the changes view is only active when scoped AND visible;
	// every read below is gated on this, not just the poll interval.
	const isChangesViewActive = hasWorkspaceScope && enabled;
	const normalizedViewKey = viewKey ?? "__default__";
	const requestKey = `${workspaceId ?? "__none__"}:${taskId ?? "__none__"}:${baseRef ?? "__none__"}:${mode}:${normalizedViewKey}`;
	const previousRequestKeyRef = useRef(requestKey);
	const isRequestTransitioning = hasWorkspaceScope && previousRequestKeyRef.current !== requestKey;
	const queryFn = useCallback(async () => {
		if (!taskId || !workspaceId || !baseRef) {
			throw new Error("Missing workspace scope.");
		}
		void normalizedViewKey;
		const trpcClient = getRuntimeTrpcClient(workspaceId);
		return await trpcClient.workspace.getChanges.query({
			taskId,
			baseRef,
			mode,
		});
	}, [baseRef, mode, normalizedViewKey, taskId, workspaceId]);
	const { refetch, setData, data, isError } = useTrpcQuery<RuntimeWorkspaceChangesResponse>({
		enabled: isChangesViewActive,
		queryFn,
		noLoading: true,
	});

	const refresh = useCallback(async () => {
		if (!isChangesViewActive) {
			return;
		}
		await refetch();
	}, [refetch, isChangesViewActive]);
	const previousStateVersionRef = useRef(stateVersion);

	useEffect(() => {
		if (!isRequestTransitioning) {
			return;
		}
		previousRequestKeyRef.current = requestKey;
		if (clearOnViewTransition) {
			setData(null);
		}
	}, [setData, clearOnViewTransition, isRequestTransitioning, requestKey]);

	useEffect(() => {
		if (!hasWorkspaceScope) {
			previousRequestKeyRef.current = requestKey;
			previousStateVersionRef.current = stateVersion;
			return;
		}
		if (previousStateVersionRef.current === stateVersion) {
			return;
		}
		previousStateVersionRef.current = stateVersion;
		// PRLINK-10: a hidden changes view must not schedule refetches; the
		// next visible mount re-runs the initial query with fresh data.
		if (!enabled) {
			return;
		}
		void refetch();
	}, [refetch, hasWorkspaceScope, requestKey, stateVersion, enabled]);

	useEffect(() => {
		if (!isChangesViewActive || pollIntervalMs == null) {
			return;
		}
		const interval = window.setInterval(() => {
			void refetch();
		}, pollIntervalMs);
		return () => {
			window.clearInterval(interval);
		};
	}, [refetch, isChangesViewActive, pollIntervalMs]);

	if (!taskId) {
		return {
			changes: null,
			isLoading: false,
			isRuntimeAvailable: true,
			refresh,
		};
	}

	if (!workspaceId) {
		return {
			changes: null,
			isLoading: false,
			isRuntimeAvailable: false,
			refresh,
		};
	}

	const shouldHideDuringTransition = clearOnViewTransition && isRequestTransitioning;
	const visibleChanges = shouldHideDuringTransition ? null : data;
	const visibleIsLoading = shouldHideDuringTransition;
	const visibleIsRuntimeAvailable = shouldHideDuringTransition ? true : !isError;

	return {
		changes: visibleChanges,
		isLoading: visibleIsLoading,
		isRuntimeAvailable: visibleIsRuntimeAvailable,
		refresh,
	};
}
