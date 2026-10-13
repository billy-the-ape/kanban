// DIAG-3: authenticated full-fidelity diagnostics download.
//
// GET /api/task-diagnostics/download?workspaceId=...&taskId=...
//
// Dispatched in runtime-server.ts AFTER the extracted auth gate (session
// cookie for browsers, internal bearer token for the CLI) and BEFORE the
// unmatched /api/ 404. The bundle streams straight to the response — nothing
// is written to the runtime host. Auth failures, unknown workspaces, and
// unknown tasks return clear non-2xx JSON errors before any filesystem read
// (Decision 7): taskId comes from the query string, so membership must be
// checked against the scoped workspace board before it can reach session or
// artifact readers. A failure after the 200 headers are sent terminates the
// response so the client reports a failed download instead of receiving an
// apparently complete bundle.

import type { IncomingMessage, ServerResponse } from "node:http";

import { streamTaskDiagnosticsExportV3 } from "../core/task-diagnostics-export-stream";
import type { TaskDiagnosticsExportV3Plan } from "../core/task-diagnostics-export-v3";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import { resolveWorkspaceScopeFromRequest } from "./request-auth-gate";

/** The dedicated download path (dispatched after the auth gate). */
export const TASK_DIAGNOSTICS_DOWNLOAD_PATHNAME = "/api/task-diagnostics/download";

/** Response header carrying the bundle's completeness status (for the CLI). */
export const DIAGNOSTICS_COMPLETENESS_HEADER = "X-Kanban-Diagnostics-Completeness";

/**
 * Sanitize only the download filename (Decision 7); the bundle always carries
 * the real, unmodified task id.
 */
export function buildTaskDiagnosticsDownloadFileName(taskId: string, capturedAtMs: number): string {
	const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
	return `task-${safeTaskId}-${capturedAtMs}.json`;
}

export interface TaskDiagnosticsDownloadDeps {
	/** Assemble the schemaVersion 3 export plan (read-only; never writes files). */
	buildExportPlan: (workspaceScope: RuntimeTrpcWorkspaceScope, taskId: string) => Promise<TaskDiagnosticsExportV3Plan>;
	warn: (message: string) => void;
}

function writeJsonError(response: ServerResponse, statusCode: number, error: string): void {
	if (response.headersSent) {
		response.destroy();
		return;
	}
	response.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	response.end(JSON.stringify({ error }));
}

/**
 * Handle the diagnostics download request. The caller must have already run
 * the auth gate (this handler never re-authenticates or invents a second
 * mechanism — it runs on the authenticated side of the gate).
 */
export async function handleTaskDiagnosticsDownload(
	request: IncomingMessage,
	response: ServerResponse,
	requestUrl: URL,
	deps: TaskDiagnosticsDownloadDeps,
): Promise<void> {
	if (request.method !== "GET") {
		writeJsonError(response, 405, "Only GET is supported for the diagnostics download.");
		return;
	}
	const taskId = requestUrl.searchParams.get("taskId")?.trim() ?? "";
	if (!taskId) {
		writeJsonError(response, 400, "taskId query parameter is required.");
		return;
	}
	const { requestedWorkspaceId, workspaceScope } = await resolveWorkspaceScopeFromRequest(request, requestUrl);
	if (!requestedWorkspaceId || !workspaceScope) {
		writeJsonError(response, 404, "Workspace not found.");
		return;
	}
	// Task membership: the task must exist on the scoped workspace board
	// (any column, including trash). Unknown or foreign ids 404 before any
	// session/artifact filesystem read.
	const board = await loadWorkspaceBoardById(workspaceScope.workspaceId).catch(() => null);
	const taskPresent = board?.columns.some((column) => column.cards.some((card) => card.id === taskId));
	if (!taskPresent) {
		writeJsonError(response, 404, "Task not found in this workspace.");
		return;
	}
	// Assemble the full plan before starting the response so auth, missing
	// task, and initial read errors all return clear non-2xx JSON errors.
	let plan: TaskDiagnosticsExportV3Plan;
	try {
		plan = await deps.buildExportPlan(workspaceScope, taskId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.warn(
			`[task-diagnostics-download] Export assembly failed for ${workspaceScope.workspaceId}/${taskId}: ${message}`,
		);
		writeJsonError(response, 500, `Diagnostics export failed: ${message}`);
		return;
	}
	const fileName = buildTaskDiagnosticsDownloadFileName(taskId, Date.now());
	const abortController = new AbortController();
	const onDisconnect = (): void => {
		// Client went away before the bundle finished: abort the serializer so
		// no background export continues after cancellation.
		if (!response.writableEnded) {
			abortController.abort();
		}
	};
	request.on("close", onDisconnect);
	try {
		response.writeHead(200, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Disposition": `attachment; filename="${fileName}"`,
			"Cache-Control": "no-store",
			[DIAGNOSTICS_COMPLETENESS_HEADER]: plan.completeness.status,
		});
		await streamTaskDiagnosticsExportV3(response, plan, { signal: abortController.signal });
		response.end();
	} catch (error) {
		// Headers already went out: a truncated response must never read like a
		// complete bundle, so terminate the connection and let the client report
		// a failed download.
		deps.warn(
			`[task-diagnostics-download] Stream failed for ${workspaceScope.workspaceId}/${taskId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		if (!response.writableEnded && !response.destroyed) {
			response.destroy();
		}
	} finally {
		request.off("close", onDisconnect);
	}
}
