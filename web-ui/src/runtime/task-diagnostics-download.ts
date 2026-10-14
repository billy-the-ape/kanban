// DIAG-3: browser-side full-fidelity diagnostics download.
//
// The bundle is fetched from the runtime's own origin, so the SameSite=Strict
// HttpOnly session cookie authenticates the request automatically (the
// internal bearer token is a CLI-only concern). The file is created entirely
// in the browser; nothing is written to the runtime host.
//
// The bundle includes the full conversation, system prompt, and tool inputs,
// outputs, and errors. Review before sharing.

/**
 * Client-built download filename (the server's filename is not read back).
 * Only the task id is sanitized; the bundle always carries the real id.
 */
export function buildDiagnosticsDownloadFileName(taskId: string, capturedAtMs: number): string {
	const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
	return `task-${safeTaskId}-${capturedAtMs}.json`;
}

let inFlightDownload: Promise<void> | null = null;

/**
 * Download the task's full-fidelity diagnostics bundle and start a browser
 * file save with the client-built filename. Rejects with an Error carrying an
 * actionable message when the request or the download fails. A second call
 * while one is in flight rejects instead of starting another download.
 */
export async function downloadTaskDiagnostics(workspaceId: string | null, taskId: string): Promise<void> {
	if (inFlightDownload) {
		throw new Error("A diagnostics download is already in progress.");
	}
	const run = doDownloadTaskDiagnostics(workspaceId, taskId);
	inFlightDownload = run;
	try {
		await run;
	} finally {
		inFlightDownload = null;
	}
}

async function doDownloadTaskDiagnostics(workspaceId: string | null, taskId: string): Promise<void> {
	const params = new URLSearchParams();
	if (workspaceId) {
		params.set("workspaceId", workspaceId);
	}
	params.set("taskId", taskId);
	const response = await fetch(`/api/task-diagnostics/download?${params.toString()}`, {
		credentials: "same-origin",
	});
	if (!response.ok) {
		throw new Error(await readErrorDetail(response));
	}
	let blob: Blob;
	try {
		blob = await response.blob();
	} catch (error) {
		throw new Error(`download failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const fileName = buildDiagnosticsDownloadFileName(taskId, Date.now());
	const objectUrl = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = objectUrl;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	// Remove and revoke only after the download initiation is complete.
	anchor.remove();
	URL.revokeObjectURL(objectUrl);
}

async function readErrorDetail(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === "string" && body.error.trim().length > 0) {
			return body.error.trim();
		}
	} catch {
		// Non-JSON error body: fall back to the HTTP status.
	}
	return `download failed (HTTP ${response.status})`;
}
