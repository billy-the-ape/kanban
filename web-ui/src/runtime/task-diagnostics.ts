// B-10: web-side wrappers for the operational-controls & diagnostics
// procedures. The runtime owns the phase model, action availability, and
// redaction; these helpers only translate failures into usable shapes.
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeDiagnosticsExportResponse,
	RuntimeTaskDiagnosticsActionName,
	RuntimeTaskDiagnosticsActionResponse,
	RuntimeTaskDiagnosticsResponse,
	RuntimeTaskPhaseSummary,
} from "@/runtime/types";

/** B-10.2: aggregated diagnostics for one task (phase, delivery, review, dispatch, preservation, context). */
export async function fetchTaskDiagnostics(
	workspaceId: string | null,
	taskId: string,
): Promise<RuntimeTaskDiagnosticsResponse | null> {
	try {
		return await getRuntimeTrpcClient(workspaceId).runtime.getTaskDiagnostics.query({ taskId });
	} catch {
		return null;
	}
}

/** B-10.3: run an operator action (deduplicated in-flight on the runtime). */
export async function runTaskDiagnosticsAction(
	workspaceId: string | null,
	taskId: string,
	action: RuntimeTaskDiagnosticsActionName,
): Promise<RuntimeTaskDiagnosticsActionResponse | null> {
	try {
		return await getRuntimeTrpcClient(workspaceId).runtime.runTaskDiagnosticsAction.mutate({
			taskId,
			action,
		});
	} catch {
		return null;
	}
}

/** B-10.1: batched phase summaries for board chips (empty when the call fails). */
export async function fetchTaskPhases(
	workspaceId: string | null,
	taskIds: string[],
): Promise<Record<string, RuntimeTaskPhaseSummary>> {
	if (taskIds.length === 0) {
		return {};
	}
	try {
		const response = await getRuntimeTrpcClient(workspaceId).runtime.getTaskPhases.query({ taskIds });
		return response.phases;
	} catch {
		return {};
	}
}

/** B-10.7: write the redacted diagnostic bundle (explicit operator action only). */
export async function exportTaskDiagnostics(
	workspaceId: string | null,
	taskId: string,
): Promise<RuntimeDiagnosticsExportResponse | null> {
	try {
		return await getRuntimeTrpcClient(workspaceId).runtime.exportTaskDiagnostics.mutate({ taskId });
	} catch {
		return null;
	}
}
