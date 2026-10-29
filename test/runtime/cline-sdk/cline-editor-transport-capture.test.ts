// Raw editor transport capture: the process-wide fetch wrapper and its SSE
// fragment extractor, driven through the real fetch against a local
// OpenAI-compatible SSE server. The end-to-end seam (real provider adapter +
// agent runtime) is covered in cline-editor-transport-capture.integration.test.ts;
// this suite pins the capture semantics: byte-exact pass-through, fragment
// assembly, stream-status bookkeeping, truncation, and attribution.
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readEditorTraceLines } from "../../../src/cline-sdk/cline-editor-call-evidence";
import { getEditorTraceFileDestination } from "../../../src/cline-sdk/cline-editor-trace";
import {
	type EditorTransportCapture,
	initEditorTransportCapture,
} from "../../../src/cline-sdk/cline-editor-transport-capture";

const TASK_ID = "task-capture";
const SESSION_ID = "session-capture";
const MODEL_ID = "probe-model";

let probeDir = "";
let server: Server | null = null;
let baseUrl = "";
let capture: EditorTransportCapture | null = null;
let savedEnv: Record<string, string | undefined> = {};
let nextHandler: ((req: IncomingMessage, res: ServerResponse, rawBody: string) => void) | null = null;

function tracePath(): string {
	return getEditorTraceFileDestination();
}

function rawRecords() {
	return readEditorTraceLines(tracePath()).filter((line) => line.phase === "raw-arguments");
}

function editorToolBody(extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		model: MODEL_ID,
		stream: true,
		messages: [{ role: "user", content: "edit the file" }],
		tools: [
			{
				type: "function",
				function: {
					name: "editor",
					description: "Edit a file",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string" },
							new_text: { type: "string" },
							old_text: { type: "string" },
							insert_line: { type: "number" },
						},
						required: ["path", "new_text"],
					},
				},
			},
		],
		...extra,
	});
}

function sseLine(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		created: 123,
		model: MODEL_ID,
		...payload,
	})}\n\n`;
}

/** Writes an SSE body in small delayed slices to force byte-level fragmentation. */
function writeSseFragmented(res: ServerResponse, sseText: string): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const pieces: string[] = [];
	let remainder = sseText;
	while (remainder.length > 0) {
		const piece = remainder.slice(0, 257);
		pieces.push(piece);
		remainder = remainder.slice(piece.length);
	}
	pieces.forEach((piece, index) => {
		setTimeout(() => {
			res.write(piece);
			if (index === pieces.length - 1) {
				res.end();
			}
		}, index * 2);
	});
}

function startServer(): Promise<void> {
	return new Promise<void>((resolve) => {
		server = createServer((req, res) => {
			let data = "";
			req.on("data", (chunk: string) => {
				data += chunk;
			});
			req.on("end", () => {
				nextHandler?.(req, res, data);
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server?.address() as AddressInfo;
			baseUrl = `http://127.0.0.1:${address.port}/v1`;
			resolve();
		});
	});
}

beforeAll(async () => {
	probeDir = mkdtempSync(join(tmpdir(), "kanban-editor-capture-"));
	savedEnv = {
		KANBAN_TRACE_EDITOR: process.env.KANBAN_TRACE_EDITOR,
		CLINE_DIR: process.env.CLINE_DIR,
	};
	process.env.KANBAN_TRACE_EDITOR = "1";
	process.env.CLINE_DIR = probeDir;
	await startServer();
	capture = initEditorTransportCapture();
	expect(capture).not.toBeNull();
	capture?.trackSession({
		taskId: TASK_ID,
		sessionId: SESSION_ID,
		host: new URL(baseUrl).host,
		providerId: "ollama",
		modelId: MODEL_ID,
	});
}, 30_000);

afterAll(async () => {
	if (capture) {
		capture.untrackSession(SESSION_ID);
	}
	const closing = server;
	if (closing) {
		closing.closeAllConnections();
		await new Promise<void>((resolve) => closing.close(() => resolve()));
		server = null;
	}
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	if (probeDir) {
		rmSync(probeDir, { recursive: true, force: true });
		probeDir = "";
	}
});

beforeEach(() => {
	try {
		unlinkSync(tracePath());
	} catch {
		// The file may not exist yet.
	}
	nextHandler = null;
});

describe("raw editor transport capture (real fetch, controlled SSE)", () => {
	it("captures fragmented editor arguments exactly and passes the stream through byte-for-byte", async () => {
		const fullArguments =
			'{"path":"/tmp/f.txt", "old_text": "line one \\"quoted\\"\\nünïcode {arr:[1,2]}", "new_text": "done"}';
		const argumentFragmentOne = fullArguments.slice(0, 40);
		const argumentFragmentTwo = fullArguments.slice(40);
		const sseText =
			sseLine({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							content: "",
							tool_calls: [{ index: 0, id: "call_frag", type: "function" }],
						},
					},
				],
			}) +
			sseLine({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "editor" } }] } }] }) +
			sseLine({
				choices: [
					{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argumentFragmentOne } }] } },
				],
			}) +
			sseLine({
				choices: [
					{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argumentFragmentTwo } }] } },
				],
			}) +
			sseLine({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
			"data: [DONE]\n\n";
		nextHandler = (_req, res) => {
			writeSseFragmented(res, sseText);
		};
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: editorToolBody(),
		});
		// The consumer sees exactly the bytes the server wrote.
		expect(await response.text()).toBe(sseText);

		const records = rawRecords();
		expect(records).toHaveLength(1);
		const record = records[0];
		expect(record?.toolCallId).toBe("call_frag");
		expect(record?.taskId).toBe(TASK_ID);
		expect(record?.sessionId).toBe(SESSION_ID);
		expect(record?.host).toBe(new URL(baseUrl).host);
		// Fragments preserve original order and exact text; assembly is exact.
		expect(record?.argumentFragments).toEqual([argumentFragmentOne, argumentFragmentTwo]);
		expect(record?.assembledArguments).toBe(fullArguments);
		expect(record?.assembledTruncated).toBe(false);
		expect(record?.streamStatus).toBe("completed");
		expect(record?.parseErrors).toBe(0);
		expect(record?.aborted).toBe(false);
		expect(record?.model).toBe(MODEL_ID);
		expect(record?.schemaStatus).toBe("captured");
		const editorSchema = record?.editorSchema as { required?: string[]; properties?: Record<string, unknown> } | null;
		expect(editorSchema?.required).toEqual(["path", "new_text"]);
		expect(editorSchema?.properties).toHaveProperty("old_text");
	});

	it("captures only the editor call among interleaved non-editor tool calls", async () => {
		const editorArgs = '{"path":"/tmp/f.txt", "old_text": "a", "new_text": "b"}';
		const commandArgs = '{"command": "echo interleaved"}';
		const sseText =
			sseLine({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							content: "",
							tool_calls: [{ index: 0, id: "call_cmd", type: "function" }],
						},
					},
				],
			}) +
			sseLine({
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, function: { name: "run_command" } },
								{ index: 1, id: "call_edit", type: "function" },
							],
						},
					},
				],
			}) +
			sseLine({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { name: "editor" } }] } }] }) +
			sseLine({
				choices: [
					{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: commandArgs.slice(0, 10) } }] } },
				],
			}) +
			sseLine({
				choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: editorArgs } }] } }],
			}) +
			sseLine({
				choices: [
					{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: commandArgs.slice(10) } }] } },
				],
			}) +
			sseLine({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
			"data: [DONE]\n\n";
		nextHandler = (_req, res) => {
			writeSseFragmented(res, sseText);
		};
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: editorToolBody(),
		});
		expect(await response.text()).toBe(sseText);

		const records = rawRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.toolCallId).toBe("call_edit");
		expect(records[0]?.assembledArguments).toBe(editorArgs);
		expect(JSON.stringify(records)).not.toContain("interleaved");
	});

	it("counts malformed SSE data lines without dropping subsequent valid fragments", async () => {
		const editorArgs = '{"path":"/tmp/f.txt", "old_text": "a", "new_text": "b"}';
		const sseText =
			"data: {not valid json\n\n" +
			sseLine({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							content: "",
							tool_calls: [{ index: 0, id: "call_bad", type: "function" }],
						},
					},
				],
			}) +
			sseLine({
				choices: [
					{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "editor", arguments: editorArgs } }] } },
				],
			}) +
			"data: [DONE]\n\n";
		nextHandler = (_req, res) => {
			writeSseFragmented(res, sseText);
		};
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: editorToolBody(),
		});
		expect(await response.text()).toBe(sseText);

		const records = rawRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.parseErrors).toBe(1);
		expect(records[0]?.toolCallId).toBe("call_bad");
		expect(records[0]?.assembledArguments).toBe(editorArgs);
		expect(records[0]?.streamStatus).toBe("completed");
	});

	it("marks the stream interrupted when the socket is destroyed before [DONE]", async () => {
		nextHandler = (_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(
				sseLine({
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								content: "",
								tool_calls: [
									{
										index: 0,
										id: "call_cut",
										type: "function",
										function: {
											name: "editor",
											arguments: '{"path":"/tmp/c.txt","old_text":"c","new_text":"d"}',
										},
									},
								],
							},
						},
					],
				}),
			);
			setTimeout(() => {
				res.destroy();
			}, 40);
		};
		let fetchError: unknown = null;
		try {
			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: editorToolBody(),
			});
			await response.text();
		} catch (error) {
			fetchError = error;
		}
		// The client saw a broken stream; the capture must not claim completion.
		expect(fetchError).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const records = rawRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.toolCallId).toBe("call_cut");
		expect(records[0]?.streamStatus).toBe("interrupted");
		expect(records[0]?.assembledTruncated).toBe(false);
	});

	it("marks the stream ended-early when the server closes without [DONE]", async () => {
		nextHandler = (_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(
				sseLine({
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								content: "",
								tool_calls: [
									{
										index: 0,
										id: "call_early",
										type: "function",
										function: {
											name: "editor",
											arguments: '{"path":"/tmp/e.txt","old_text":"e","new_text":"f"}',
										},
									},
								],
							},
						},
					],
				}),
			);
			res.end();
		};
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: editorToolBody(),
		});
		await response.text();
		const records = rawRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.streamStatus).toBe("ended-early");
	});

	it("records the abort flag when the fetch signal is aborted mid-stream", async () => {
		const controller = new AbortController();
		nextHandler = (_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(
				sseLine({
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								content: "",
								tool_calls: [
									{
										index: 0,
										id: "call_abort",
										type: "function",
										function: {
											name: "editor",
											arguments: '{"path":"/tmp/a.txt","old_text":"a","new_text":"b"}',
										},
									},
								],
							},
						},
					],
				}),
			);
			// Keep the stream open; the client aborts.
			setTimeout(() => {
				res.end();
			}, 5_000);
		};
		const responsePromise = fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: editorToolBody(),
			signal: controller.signal,
		});
		setTimeout(() => {
			controller.abort();
		}, 60);
		// fetch resolves once headers arrive; the body read is what rejects.
		const response = await responsePromise;
		let bodyError: unknown = null;
		try {
			await response.text();
		} catch (error) {
			bodyError = error;
		}
		expect(bodyError).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const records = rawRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.aborted).toBe(true);
		expect(records[0]?.streamStatus).toBe("interrupted");
	});

	it("truncates oversized assembled arguments and flags them explicitly", async () => {
		const bigText = "x".repeat(40_000);
		const editorArgs = `{"path":"/tmp/big.txt", "new_text": "${bigText}"}`;
		const sseText =
			sseLine({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							content: "",
							tool_calls: [{ index: 0, id: "call_big", type: "function" }],
						},
					},
				],
			}) +
			sseLine({
				choices: [
					{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "editor", arguments: editorArgs } }] } },
				],
			}) +
			"data: [DONE]\n\n";
		nextHandler = (_req, res) => {
			writeSseFragmented(res, sseText);
		};
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: editorToolBody(),
		});
		expect(await response.text()).toBe(sseText);
		const records = rawRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.assembledTruncated).toBe(true);
		const assembled = typeof records[0]?.assembledArguments === "string" ? records[0].assembledArguments : "";
		expect(assembled.length).toBeLessThan(editorArgs.length);
		expect(assembled.length).toBeLessThan(33_000);
	});

	it("emits no records for responses without editor tool calls", async () => {
		const sseText =
			sseLine({ choices: [{ index: 0, delta: { role: "assistant", content: "Just text, " } }] }) +
			sseLine({ choices: [{ index: 0, delta: { content: "no tools." } }] }) +
			sseLine({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
			"data: [DONE]\n\n";
		nextHandler = (_req, res) => {
			writeSseFragmented(res, sseText);
		};
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: editorToolBody(),
		});
		expect(await response.text()).toBe(sseText);
		expect(rawRecords()).toEqual([]);
	});

	it("passes responses through untouched when no session tracks the host", async () => {
		const activeCapture = capture;
		if (!activeCapture) {
			throw new Error("capture not initialized");
		}
		activeCapture.untrackSession(SESSION_ID);
		const sseText =
			sseLine({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							content: "",
							tool_calls: [{ index: 0, id: "call_untracked", type: "function" }],
						},
					},
				],
			}) +
			sseLine({
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, function: { name: "editor", arguments: '{"path":"/tmp/u","new_text":"x"}' } },
							],
						},
					},
				],
			}) +
			"data: [DONE]\n\n";
		nextHandler = (_req, res) => {
			writeSseFragmented(res, sseText);
		};
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: editorToolBody(),
		});
		expect(await response.text()).toBe(sseText);
		expect(rawRecords()).toEqual([]);
		activeCapture.trackSession({
			taskId: TASK_ID,
			sessionId: SESSION_ID,
			host: new URL(baseUrl).host,
			providerId: "ollama",
			modelId: MODEL_ID,
		});
	});

	it("keeps repeated tool-call ids from concurrent requests as separate records", async () => {
		nextHandler = (_req, res) => {
			const editorArgs = '{"path":"/tmp/c.txt", "old_text": "c", "new_text": "d"}';
			const sseText =
				sseLine({
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								content: "",
								tool_calls: [{ index: 0, id: "call_dup", type: "function" }],
							},
						},
					],
				}) +
				sseLine({
					choices: [
						{
							index: 0,
							delta: { tool_calls: [{ index: 0, function: { name: "editor", arguments: editorArgs } }] },
						},
					],
				}) +
				"data: [DONE]\n\n";
			writeSseFragmented(res, sseText);
		};
		const options = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: editorToolBody(),
		};
		const [responseOne, responseTwo] = await Promise.all([
			fetch(`${baseUrl}/chat/completions`, options),
			fetch(`${baseUrl}/chat/completions`, options),
		]);
		expect(await responseOne.text()).not.toBe("");
		expect(await responseTwo.text()).not.toBe("");
		const records = rawRecords();
		expect(records).toHaveLength(2);
		const requestIds = records
			.map((record) => record.requestId)
			.filter((value): value is string => typeof value === "string");
		expect(new Set(requestIds).size).toBe(2);
		for (const record of records) {
			expect(record.toolCallId).toBe("call_dup");
			expect(record.streamStatus).toBe("completed");
		}
	});

	it("marks the editor schema unavailable when the request body has no tools", async () => {
		nextHandler = (_req, res) => {
			const sseText =
				sseLine({
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								content: "",
								tool_calls: [{ index: 0, id: "call_noschema", type: "function" }],
							},
						},
					],
				}) +
				sseLine({
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{ index: 0, function: { name: "editor", arguments: '{"path":"/tmp/s","new_text":"t"}' } },
								],
							},
						},
					],
				}) +
				"data: [DONE]\n\n";
			writeSseFragmented(res, sseText);
		};
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: MODEL_ID, stream: true, messages: [] }),
		});
		await response.text();
		const records = rawRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.schemaStatus).toBe("unavailable");
		expect(records[0]?.editorSchema).toBeNull();
	});
});
