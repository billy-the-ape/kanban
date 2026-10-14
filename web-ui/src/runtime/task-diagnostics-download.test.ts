// DIAG-3: browser-side full-fidelity diagnostics download (jsdom).
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDiagnosticsDownloadFileName, downloadTaskDiagnostics } from "./task-diagnostics-download";

const SUCCESS_BODY = { schemaVersion: 3, diagnostics: { ok: true, task: { id: "task-1" } } };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function textResponse(body: string, status: number): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function stubAnchorClick(): { clicked: () => HTMLAnchorElement | null } {
	let clickedElement: HTMLAnchorElement | null = null;
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
		clickedElement = this;
	});
	return { clicked: () => clickedElement };
}

function stubObjectUrl(url = "blob:mock-123"): void {
	vi.spyOn(URL, "createObjectURL").mockReturnValue(url);
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
}

describe("buildDiagnosticsDownloadFileName", () => {
	it("sanitizes the task id and appends the capture timestamp", () => {
		expect(buildDiagnosticsDownloadFileName("task-1", 1760250000000)).toBe("task-task-1-1760250000000.json");
		expect(buildDiagnosticsDownloadFileName("a/b c.d", 5)).toBe("task-a_b_c_d-5.json");
	});
});

describe("downloadTaskDiagnostics", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("downloads the bundle from the same origin and triggers a browser file save", async () => {
		const fetchMock = vi.fn(async (_url: string | URL, init: RequestInit | undefined) => {
			expect(init?.credentials).toBe("same-origin");
			return jsonResponse(SUCCESS_BODY);
		});
		vi.stubGlobal("fetch", fetchMock);
		stubObjectUrl("blob:mock-123");
		const { clicked } = stubAnchorClick();

		await downloadTaskDiagnostics("workspace-1", "task-1");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/task-diagnostics/download?workspaceId=workspace-1&taskId=task-1");
		const anchor = clicked();
		expect(anchor).not.toBeNull();
		expect(anchor?.download).toMatch(/^task-task-1-\d+\.json$/);
		expect(anchor?.href).toBe("blob:mock-123");
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-123");
	});

	it("omits the workspaceId parameter when the workspace is unknown", async () => {
		const fetchMock = vi.fn(async (_url: string | URL) => jsonResponse(SUCCESS_BODY));
		vi.stubGlobal("fetch", fetchMock);
		stubObjectUrl();
		stubAnchorClick();

		await downloadTaskDiagnostics(null, "task-1");

		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/task-diagnostics/download?taskId=task-1");
	});

	it("surfaces the server error message for an HTTP failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "Authentication required." }, 401)),
		);
		await expect(downloadTaskDiagnostics("workspace-1", "task-1")).rejects.toThrow("Authentication required.");
	});

	it("falls back to the HTTP status when the error body is not JSON", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => textResponse("boom", 404)),
		);
		await expect(downloadTaskDiagnostics("workspace-1", "task-1")).rejects.toThrow("download failed (HTTP 404)");
	});

	it("propagates fetch failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		await expect(downloadTaskDiagnostics("workspace-1", "task-1")).rejects.toThrow("network down");
	});

	it("rejects a second concurrent start and resets when the first finishes", async () => {
		// Initialized with a no-op so the call site typechecks even before the
		// fetch executor assigns the real settlement function.
		let settle: (response: Response) => void = () => undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						settle = resolve;
					}),
			),
		);
		stubObjectUrl("blob:mock-456");
		stubAnchorClick();

		const first = downloadTaskDiagnostics("workspace-1", "task-1");
		await expect(downloadTaskDiagnostics("workspace-1", "task-1")).rejects.toThrow("already in progress");

		settle(jsonResponse(SUCCESS_BODY));
		await first;

		// The in-flight guard is released, so a new start is allowed.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(SUCCESS_BODY)),
		);
		await expect(downloadTaskDiagnostics("workspace-1", "task-1")).resolves.toBeUndefined();
	});
});
