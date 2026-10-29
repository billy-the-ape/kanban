// Tracing disabled by default: without KANBAN_TRACE_EDITOR=1 the capture
// singleton is never initialized, the process-wide fetch wrapper is never
// installed, and the editor tracing hooks are no-ops. This file must run
// without KANBAN_TRACE_EDITOR set in its worker (no other test in this file
// enables it), matching a default Kanban process.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClineEditorTraceHooks } from "../../../src/cline-sdk/cline-editor-trace";
import { initEditorTransportCapture } from "../../../src/cline-sdk/cline-editor-transport-capture";

describe("editor tracing is disabled by default", () => {
	let originalFetch: typeof fetch;
	beforeAll(() => {
		originalFetch = globalThis.fetch;
		delete process.env.KANBAN_TRACE_EDITOR;
	});
	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	it("does not install the transport capture or the fetch wrapper", () => {
		expect(initEditorTransportCapture()).toBeNull();
		expect(globalThis.fetch).toBe(originalFetch);
	});

	it("returns no-op editor trace hooks", () => {
		expect(createClineEditorTraceHooks("task-1", "session-1")).toEqual({});
	});
});
