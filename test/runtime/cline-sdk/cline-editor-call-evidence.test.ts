// Additive editor transport evidence: stage correlation and the factual
// old_text comparison. Covers complete matches, every inconclusive shape
// (missing/truncated/malformed/unmatched/ambiguous), and proves the
// comparison never blames the model or the editor.
import { describe, expect, it } from "vitest";
import {
	collectEditorToolCallIds,
	collectTaskEditorCallEvidence,
	type TraceLine,
} from "../../../src/cline-sdk/cline-editor-call-evidence";

const SESSION_ID = "task-1-1000-abc12345";

function rawLine(overrides: Partial<Record<string, unknown>> = {}): TraceLine {
	return {
		ts: "2026-10-12T10:00:00.000Z",
		tsEnd: "2026-10-12T10:00:01.000Z",
		taskId: "task-1",
		sessionId: SESSION_ID,
		phase: "raw-arguments",
		requestId: "req-1",
		host: "127.0.0.1:9999",
		toolCallId: "call_editor_1",
		toolName: "editor",
		argumentFragments: [],
		assembledArguments: "{}",
		assembledTruncated: false,
		streamStatus: "completed",
		aborted: false,
		parseErrors: 0,
		model: "probe-model",
		editorSchema: { properties: { path: {}, new_text: {}, old_text: {} }, required: ["path", "new_text"] },
		schemaStatus: "captured",
		...overrides,
	};
}

function hookLine(phase: "model-call" | "before-execution" | "result", input: unknown, result?: unknown): TraceLine {
	return {
		ts: "2026-10-12T10:00:02.000Z",
		taskId: "task-1",
		sessionId: SESSION_ID,
		phase,
		toolCallId: "call_editor_1",
		input,
		hasOldText: Object.hasOwn(input as Record<string, unknown>, "old_text"),
		oldTextChars: null,
		newTextChars: null,
		...(result !== undefined ? { result } : {}),
	};
}

function editorInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { path: "/tmp/file.txt", new_text: "replaced", ...overrides };
}

describe("collectEditorToolCallIds", () => {
	it("collects editor tool_use ids only", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "editor", input: {} }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t2", name: "run_command", input: {} }] },
		] as unknown as Parameters<typeof collectEditorToolCallIds>[0];
		expect(collectEditorToolCallIds(messages)).toEqual(["t1"]);
	});
});

describe("collectTaskEditorCallEvidence", () => {
	it("is unavailable when nothing was recorded", () => {
		const evidence = collectTaskEditorCallEvidence({ sessionId: SESSION_ID, knownEditorToolCallIds: [], lines: [] });
		expect(evidence.status).toBe("unavailable");
		expect(evidence.calls).toEqual([]);
	});

	it("is partial with explicitly unavailable stages when editor calls ran but no stage was recorded", () => {
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: ["call_editor_1"],
			lines: [],
		});
		expect(evidence.status).toBe("partial");
		const call = evidence.calls[0];
		expect(call?.raw.status).toBe("unavailable");
		expect(call?.parsed.status).toBe("unavailable");
		expect(call?.beforeExecution.status).toBe("unavailable");
		expect(call?.result.status).toBe("unavailable");
		expect(call?.comparison).toBe("not-comparable");
	});

	it("is unavailable for a session with no editor calls and no captures", () => {
		const other = rawLine({ sessionId: "other-session", toolCallId: "call_other" });
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: [],
			lines: [other],
		});
		expect(evidence.status).toBe("unavailable");
	});

	it("compares present-in-both when raw and parsed agree", () => {
		const lines = [
			rawLine({
				argumentFragments: ['{"path":"/tmp/file.txt"', ', "old_text": "old", "new_text": "new"}'],
				assembledArguments: '{"path":"/tmp/file.txt", "old_text": "old", "new_text": "new"}',
			}),
			hookLine("model-call", editorInput({ old_text: "old" })),
			hookLine("before-execution", editorInput({ old_text: "old" })),
			hookLine("result", editorInput({ old_text: "old" }), "Edited file"),
		];
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: ["call_editor_1"],
			lines,
		});
		expect(evidence.status).toBe("captured");
		const call = evidence.calls[0];
		expect(call?.comparison).toBe("present-in-both");
		expect(call?.raw.complete).toBe(true);
		expect(call?.result.status).toBe("captured");
		expect(call?.result.result).toBe("Edited file");
	});

	it("detects a controlled stage mismatch at the client boundary without blaming the model", () => {
		const lines = [
			rawLine({
				argumentFragments: ['{"path":"/tmp/file.txt", "old_text": "old", "new_text": "new"}'],
				assembledArguments: '{"path":"/tmp/file.txt", "old_text": "old", "new_text": "new"}',
			}),
			// The parsed call lost old_text somewhere between the transport and the hook.
			hookLine("model-call", editorInput()),
			hookLine("before-execution", editorInput()),
			hookLine("result", editorInput(), "Error: old_text is required"),
		];
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: ["call_editor_1"],
			lines,
		});
		const call = evidence.calls[0];
		expect(call?.comparison).toBe("present-only-in-raw");
		expect(call?.comparisonNote).toContain("client argument-parsing boundary");
		expect(call?.comparisonNote).not.toContain("model error");
	});

	it("treats parsed-present-but-raw-absent as an inconclusive capture mismatch", () => {
		const lines = [
			rawLine({ assembledArguments: '{"path":"/tmp/file.txt", "new_text": "new"}' }),
			hookLine("model-call", editorInput({ old_text: "old" })),
		];
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: ["call_editor_1"],
			lines,
		});
		expect(evidence.calls[0]?.comparison).toBe("present-only-in-parsed");
		expect(evidence.calls[0]?.comparisonNote).toContain("inconclusive");
	});

	it("labels an upstream omission as upstream and not proven model error", () => {
		const lines = [
			rawLine({ assembledArguments: '{"path":"/tmp/file.txt", "new_text": "new"}' }),
			hookLine("model-call", editorInput()),
			hookLine("before-execution", editorInput()),
			hookLine("result", editorInput(), "Error: old_text is required"),
		];
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: ["call_editor_1"],
			lines,
		});
		const call = evidence.calls[0];
		expect(call?.comparison).toBe("absent-in-both");
		expect(call?.comparisonNote).toContain("upstream of the client boundary");
		expect(call?.comparisonNote).toContain("not proven model error");
		expect(evidence.status).toBe("captured");
	});

	it("is not comparable when the raw argument text is malformed JSON", () => {
		const lines = [
			rawLine({ argumentFragments: ["{'path:'/tmp/file.txt'"], assembledArguments: "{'path:'/tmp/file.txt'" }),
			hookLine("model-call", editorInput()),
		];
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: ["call_editor_1"],
			lines,
		});
		const call = evidence.calls[0];
		expect(call?.comparison).toBe("not-comparable");
		expect(call?.comparisonNote).toContain("not valid JSON");
		expect(evidence.status).toBe("partial");
	});

	it("never presents truncated or interrupted evidence as proof of omission", () => {
		const lines = [
			rawLine({
				assembledArguments: '{"path":"/tmp/file.txt", "ol',
				assembledTruncated: true,
				streamStatus: "completed",
			}),
			hookLine("model-call", editorInput()),
		];
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: ["call_editor_1"],
			lines,
		});
		const call = evidence.calls[0];
		expect(call?.raw.complete).toBe(false);
		expect(call?.raw.note).toContain("truncated");
		expect(call?.comparison).toBe("not-comparable");
		expect(evidence.status).toBe("partial");
	});

	it("marks repeated tool-call ids across requests as ambiguous and lists each record", () => {
		const lines = [
			rawLine({ requestId: "req-1" }),
			rawLine({ requestId: "req-2" }),
			hookLine("model-call", editorInput()),
		];
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: ["call_editor_1"],
			lines,
		});
		const call = evidence.calls[0];
		expect(call?.raw.status).toBe("ambiguous");
		expect(call?.raw.records).toHaveLength(2);
		expect(call?.comparison).toBe("not-comparable");
	});

	it("explicitly represents unavailable hook stages and unmatched raw captures", () => {
		const lines = [rawLine({ toolCallId: "call_unknown" })];
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: ["call_editor_1"],
			lines,
		});
		const call = evidence.calls[0];
		expect(call?.raw.status).toBe("unmatched");
		expect(call?.parsed.status).toBe("unavailable");
		expect(call?.beforeExecution.status).toBe("unavailable");
		expect(call?.result.status).toBe("unavailable");
		expect(evidence.unmatchedRawCaptures).toBe(1);
		expect(evidence.status).toBe("partial");
	});

	it("preserves the original result text verbatim, never synthesized fields", () => {
		const originalResult = "Error: editor failed: old_text is required but missing";
		const lines = [
			rawLine({ assembledArguments: '{"path":"/tmp/file.txt", "new_text": "new"}' }),
			hookLine("model-call", editorInput()),
			hookLine("before-execution", editorInput()),
			hookLine("result", editorInput(), originalResult),
		];
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: ["call_editor_1"],
			lines,
		});
		expect(evidence.calls[0]?.result.result).toBe(originalResult);
		expect(JSON.stringify(evidence)).not.toContain('"old_text":"synthesized"');
	});

	it("keeps sessions isolated (no cross-session attribution by tool-call id alone)", () => {
		const lines = [
			rawLine({
				sessionId: "other-session",
				toolCallId: "call_editor_1",
				assembledArguments: '{"path":"/tmp/x", "new_text":"y"}',
			}),
			hookLine("model-call", editorInput()),
		];
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: ["call_editor_1"],
			lines,
		});
		// The raw line belongs to another session and is not attributed to this one.
		expect(evidence.calls[0]?.raw.status).toBe("unavailable");
		expect(evidence.unmatchedRawCaptures).toBe(0);
	});

	it("attributes un-attributed raw captures to matching tool-call ids (concurrent sessions)", () => {
		const lines = [
			rawLine({
				taskId: null,
				sessionId: null,
				assembledArguments: '{"path":"/tmp/file.txt", "old_text": "old", "new_text": "new"}',
			}),
			hookLine("model-call", editorInput({ old_text: "old" })),
		];
		const evidence = collectTaskEditorCallEvidence({
			sessionId: SESSION_ID,
			knownEditorToolCallIds: ["call_editor_1"],
			lines,
		});
		expect(evidence.calls[0]?.raw.status).toBe("captured");
		expect(evidence.calls[0]?.comparison).toBe("present-in-both");
	});
});
