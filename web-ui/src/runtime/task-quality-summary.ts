// DIAG-PANEL: on-demand recorded quality summary fetch for the diagnostics
// panel. Read-only, target-scoped, point-in-time — never a board-wide scan.

import { getRuntimeTrpcClient } from "./trpc-client";
import type { RuntimeTaskQualitySummaryResponse } from "./types";

/**
 * Fetch the task's recorded quality summary. Returns null on a transport
 * error (the response's own `coverage`/`error` fields carry read-side gaps).
 */
export async function fetchTaskQualitySummary(
	workspaceId: string | null,
	taskId: string,
): Promise<RuntimeTaskQualitySummaryResponse | null> {
	try {
		return await getRuntimeTrpcClient(workspaceId).runtime.getTaskQualitySummary.query({ taskId });
	} catch {
		return null;
	}
}
