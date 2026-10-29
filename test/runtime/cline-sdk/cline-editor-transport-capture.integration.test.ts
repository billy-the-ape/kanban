// End-to-end proof of the raw editor transport capture seam.
//
// Drives the real InMemoryClineTaskSessionService + InMemoryClineSessionRuntime
// against a real @clinebot/core local session host (backendMode "local" — the
// same host production native local sessions use) and a local OpenAI-compatible
// SSE server. The local session's provider adapter (Vercel AI SDK
// openai-compatible) resolves globalThis.fetch at request time, which is the
// seam the process-wide capture wrapper intercepts; if that were not true,
// the raw-arguments records below would never exist and this suite would fail.
//
// Covers, through the real agent loop:
// - a valid old_text surviving from the raw SSE bytes to the parsed call to
//   successful tool execution (and the diagnostics export evidence);
// - raw arguments that genuinely omit old_text, captured verbatim and labeled
//   as an upstream omission — never blamed on the model or the editor.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClineCore } from "@clinebot/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildClineCompactionConfig } from "../../../src/cline-sdk/cline-compaction-config";
import { readEditorTraceLines } from "../../../src/cline-sdk/cline-editor-call-evidence";
import { getEditorTraceFileDestination } from "../../../src/cline-sdk/cline-editor-trace";
import type { ResolvedClineLaunchConfig } from "../../../src/cline-sdk/cline-provider-service";
import { createInMemoryClineSessionRuntime } from "../../../src/cline-sdk/cline-session-runtime";
import {
	type ClineTaskSessionService,
	createInMemoryClineTaskSessionService,
} from "../../../src/cline-sdk/cline-task-session-service";
import type * as WorkspaceState from "../../../src/state/workspace-state";
import { createFakeMcpRuntimeService, createFakeRuntimeSetup } from "../../utilities/cline-session-service-harness";
import { createGitTestEnv } from "../../utilities/git-env";

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
	deleteTaskTurnCheckpointRef: vi.fn(),
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
	deleteTaskTurnCheckpointRef: turnCheckpointMocks.deleteTaskTurnCheckpointRef,
}));

const workspaceStateMocks = vi.hoisted(() => ({
	getTaskWorktreesHomePath: vi.fn(),
}));

vi.mock("../../../src/state/workspace-state.js", async (importOriginal) => {
	const original = await importOriginal<typeof WorkspaceState>();
	return {
		...original,
		getTaskWorktreesHomePath: workspaceStateMocks.getTaskWorktreesHomePath,
	};
});

const SYSTEM_PROMPT = "You are a concise test assistant.";
const TARGET_CONTENT = "alpha\nbeta\ngamma";
const TARGET_REPLACED = "alpha\nbeta-replaced\ngamma";

interface CapturedChatRequest {
	rawBody: string;
}

let probeDir = "";
let targetFilePath = "";
let server: Server | null = null;
let baseUrl = "";
let service: ClineTaskSessionService | null = null;
let savedEnv: Record<string, string | undefined> = {};
const chatRequests: CapturedChatRequest[] = [];
let chatResponseCount = 0;
let nextChatHandler: ((req: IncomingMessage, res: ServerResponse, rawBody: string) => void) | null = null;

function tracePath(): string {
	return getEditorTraceFileDestination();
}

function rawRecords(): ReturnType<typeof readEditorTraceLines> {
	return readEditorTraceLines(tracePath()).filter((line) => line.phase === "raw-arguments");
}

function hookLines(phase: string): ReturnType<typeof readEditorTraceLines> {
	return readEditorTraceLines(tracePath()).filter((line) => line.phase === phase);
}

function sseLine(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-probe",
		object: "chat.completion.chunk",
		created: 123,
		model: "probe-model",
		...payload,
	})}\n\n`;
}

function writeSseToolCall(
	res: ServerResponse,
	toolName: string,
	toolCallId: string,
	argumentFragments: string[],
): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.write(
		sseLine({
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						content: "",
						tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name: toolName } }],
					},
				},
			],
		}),
	);
	for (const fragment of argumentFragments) {
		res.write(
			sseLine({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] } }] }),
		);
	}
	res.write(sseLine({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
	res.write("data: [DONE]\n\n");
	res.end();
	chatResponseCount += 1;
}

function writeSseTextCompletion(res: ServerResponse, text: string): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.write(sseLine({ choices: [{ index: 0, delta: { role: "assistant", content: text } }] }));
	res.write(sseLine({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
	res.write("data: [DONE]\n\n");
	res.end();
	chatResponseCount += 1;
}

function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
	description: string,
	context?: () => string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise<void>((resolve, reject) => {
		const timer = setInterval(() => {
			if (predicate()) {
				clearInterval(timer);
				resolve();
			} else if (Date.now() > deadline) {
				clearInterval(timer);
				reject(
					new Error(
						`timed out waiting for ${description} (chatResponses=${chatResponseCount}, chatRequests=${chatRequests.length})${
							context ? `; context: ${context()}` : ""
						}`,
					),
				);
			}
		}, 250);
	});
}

function transcriptContext(taskId: string): () => string {
	return () => {
		const lines = readEditorTraceLines(tracePath())
			.filter((line) => line.taskId === taskId)
			.map((line) =>
				JSON.stringify({
					phase: line.phase,
					toolCallId: line.toolCallId,
					streamStatus: line.streamStatus,
					aborted: line.aborted,
					assembled: (line.assembledArguments as string | undefined)?.slice(0, 200),
				}),
			);
		const messages = service?.listMessages(taskId) ?? [];
		return `trace=[${lines.join(" | ")}] messages=${JSON.stringify(messages.map((m) => ({ role: m.role, toolName: m.meta?.toolName, content: String(m.content).slice(0, 300) })))}`;
	};
}

function editorSchemaFromRequest(rawBody: string): { required: string[]; properties: Record<string, unknown> } | null {
	const parsed = JSON.parse(rawBody) as {
		tools?: Array<{ function?: { name?: string; parameters?: { properties?: unknown; required?: string[] } } }>;
	};
	for (const tool of parsed.tools ?? []) {
		if (tool.function?.name === "editor" && tool.function.parameters) {
			return {
				required: tool.function.parameters.required ?? [],
				properties: (tool.function.parameters.properties as Record<string, unknown>) ?? {},
			};
		}
	}
	return null;
}

async function startSession(taskId: string): Promise<void> {
	const activeService = service;
	if (!activeService) {
		throw new Error("service not created");
	}
	const launchConfig: ResolvedClineLaunchConfig = {
		providerId: "ollama",
		modelId: "probe-model",
		apiKey: "sk-test-key",
		baseUrl,
		contextWindowTokens: 8_000,
		contextWindowSource: "override",
		maxTokens: 500,
	};
	await activeService.startTaskSession({
		taskId,
		cwd: probeDir,
		prompt:
			`Use the editor tool to replace 'beta' with 'beta-replaced' in ${targetFilePath} using old_text 'beta'.`,
		providerId: "ollama",
		modelId: "probe-model",
		apiKey: "sk-test-key",
		baseUrl,
		systemPrompt: SYSTEM_PROMPT,
		contextWindowTokens: 8_000,
		contextWindowSource: "override",
		compaction: buildClineCompactionConfig({ launchConfig }),
	});
}

beforeAll(async () => {
	probeDir = mkdtempSync(join(tmpdir(), "kanban-editor-capture-int-"));
	savedEnv = {
		KANBAN_TRACE_EDITOR: process.env.KANBAN_TRACE_EDITOR,
		CLINE_DIR: process.env.CLINE_DIR,
		CLINE_LOG_ENABLED: process.env.CLINE_LOG_ENABLED,
		CLINE_LOG_LEVEL: process.env.CLINE_LOG_LEVEL,
		CLINE_LOG_PATH: process.env.CLINE_LOG_PATH,
	};
	// Sandbox SDK storage + tracing output; enable the opt-in capture.
	process.env.KANBAN_TRACE_EDITOR = "1";
	process.env.CLINE_DIR = probeDir;
	process.env.CLINE_LOG_ENABLED = "1";
	process.env.CLINE_LOG_LEVEL = "debug";
	process.env.CLINE_LOG_PATH = join(probeDir, "kanban.log");
	execFileSync("git", ["init", "-q"], { cwd: probeDir, env: createGitTestEnv() });
	workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(join(probeDir, "worktrees-home"));
	targetFilePath = join(probeDir, "target.txt");
	writeFileSync(targetFilePath, TARGET_CONTENT, "utf8");

	const activeServer = createServer((req, res) => {
		let data = "";
		req.on("data", (chunk: string) => {
			data += chunk;
		});
		req.on("end", () => {
			if (req.url?.includes("/chat/completions")) {
				chatRequests.push({ rawBody: data });
				nextChatHandler?.(req, res, data);
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [], models: [] }));
		});
	});
	server = activeServer;
	await new Promise<void>((resolve) => activeServer.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(activeServer.address() as AddressInfo).port}/v1`;

	service = createInMemoryClineTaskSessionService({
		createSessionRuntime: (runtimeOptions) =>
			createInMemoryClineSessionRuntime({
				...runtimeOptions,
				createSessionHost: async () =>
					await ClineCore.create({ clientName: "kanban-editor-capture-int", backendMode: "local" }),
				createMcpRuntimeService: () => createFakeMcpRuntimeService(),
			}),
		createRuntimeSetup: async () => createFakeRuntimeSetup(),
	});
}, 120_000);

afterAll(async () => {
	await service?.dispose();
	service = null;
	const closingServer = server;
	if (closingServer) {
		closingServer.closeAllConnections();
		await new Promise<void>((resolve) => closingServer.close(() => resolve()));
		server = null;
	}
	workspaceStateMocks.getTaskWorktreesHomePath.mockReset();
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

describe("raw editor transport capture through the real local session seam", () => {
	it("preserves a valid old_text from raw SSE to execution and records it in the diagnostics export", async () => {
		const fullArguments = JSON.stringify({
			path: targetFilePath,
			old_text: "beta",
			new_text: "beta-replaced",
		});
		const fragmentOne = fullArguments.slice(0, 30);
		const fragmentTwo = fullArguments.slice(30);
		const requestsAtStart = chatRequests.length;
		const responsesAtStart = chatResponseCount;
		nextChatHandler = (_req, res) => {
			if (chatRequests.length === requestsAtStart + 1) {
				writeSseToolCall(res, "editor", "call_edit_probe", [fragmentOne, fragmentTwo]);
			} else {
				writeSseTextCompletion(res, "Done.");
			}
		};
		await startSession("task-editor-valid");

		// The tool actually executed with old_text: the file changed on disk.
		await waitFor(
			() => readFileSync(targetFilePath, "utf8") === TARGET_REPLACED,
			120_000,
			"the editor tool to replace the text",
			transcriptContext("task-editor-valid"),
		);
		await waitFor(() => chatResponseCount >= responsesAtStart + 2, 60_000, "the final text completion");
		await service?.stopTaskSession("task-editor-valid");

		// The request the provider sent carried the model-facing editor schema.
		const requestBody = chatRequests[requestsAtStart]?.rawBody ?? "";
		const requestSchema = editorSchemaFromRequest(requestBody);
		expect(requestSchema).not.toBeNull();
		expect(requestSchema?.required).toContain("path");
		expect(requestSchema?.required).toContain("new_text");

		// Raw transport capture: exact fragments, exact assembly, completed stream.
		const records = rawRecords().filter((line) => line.toolCallId === "call_edit_probe");
		expect(records).toHaveLength(1);
		const record = records[0];
		expect(record?.taskId).toBe("task-editor-valid");
		expect(record?.argumentFragments).toEqual([fragmentOne, fragmentTwo]);
		expect(record?.assembledArguments).toBe(fullArguments);
		expect(record?.streamStatus).toBe("completed");
		expect(record?.parseErrors).toBe(0);
		expect(record?.schemaStatus).toBe("captured");
		const editorSchema = record?.editorSchema as { required?: string[]; properties?: Record<string, unknown> } | null;
		expect(editorSchema?.required).toEqual(requestSchema?.required);
		expect(editorSchema?.properties).toHaveProperty("old_text");

		// Parsed and execution stages agree: old_text present at every stage.
		for (const phase of ["model-call", "before-execution"]) {
			const lines = hookLines(phase).filter((line) => line.toolCallId === "call_edit_probe");
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(line.hasOldText).toBe(true);
			}
		}
		const resultLines = hookLines("result").filter((line) => line.toolCallId === "call_edit_probe");
		expect(resultLines.length).toBeGreaterThan(0);

		// The diagnostics export snapshot carries the correlated evidence.
		const snapshot = await service?.getTaskExportSnapshot("task-editor-valid");
		expect(snapshot).not.toBeNull();
		const evidence = snapshot?.segments[0]?.editorCallEvidence;
		expect(evidence?.status).toBe("captured");
		const call = evidence?.calls.find((candidate) => candidate.toolCallId === "call_edit_probe");
		expect(call?.comparison).toBe("present-in-both");
	}, 300_000);

	it("captures a raw omission of old_text and labels it upstream without blaming the model", async () => {
		const fullArguments = JSON.stringify({
			path: targetFilePath,
			new_text: "beta-replaced",
		});
		const requestsAtStart = chatRequests.length;
		const responsesAtStart = chatResponseCount;
		nextChatHandler = (_req, res) => {
			if (chatRequests.length === requestsAtStart + 1) {
				writeSseToolCall(res, "editor", "call_edit_missing", [fullArguments]);
			} else {
				writeSseTextCompletion(res, "Understood.");
			}
		};
		await startSession("task-editor-missing");

		// The editor tool failed with the original missing-old_text result.
		const activeService = service;
		if (!activeService) {
			throw new Error("service not created");
		}
		await waitFor(
			() =>
				activeService
					.listMessages("task-editor-missing")
					.some(
						(message) =>
							message.role === "tool" &&
							message.meta?.toolName === "editor" &&
							(message.content as string).toLowerCase().includes("old_text"),
					),
			120_000,
			"the editor tool result reporting the missing old_text",
			transcriptContext("task-editor-missing"),
		);
		await waitFor(() => chatResponseCount >= responsesAtStart + 2, 60_000, "the final text completion");
		await activeService.stopTaskSession("task-editor-missing");

		// The raw capture shows the omission exactly as it arrived on the wire.
		const records = rawRecords().filter((line) => line.toolCallId === "call_edit_missing");
		expect(records).toHaveLength(1);
		expect(records[0]?.taskId).toBe("task-editor-missing");
		expect(records[0]?.streamStatus).toBe("completed");
		const parsedRaw = JSON.parse((records[0]?.assembledArguments as string) ?? "{}") as Record<string, unknown>;
		expect(Object.hasOwn(parsedRaw, "old_text")).toBe(false);

		// The original execution result is preserved verbatim.
		const toolMessages = activeService
			.listMessages("task-editor-missing")
			.filter((message) => message.role === "tool" && message.meta?.toolName === "editor");
		expect(toolMessages.length).toBeGreaterThan(0);
		const originalResult = toolMessages[0]?.content ?? "";
		expect(originalResult.toLowerCase()).toContain("old_text");

		// The export evidence distinguishes the stages and does not blame the model.
		const snapshot = await activeService.getTaskExportSnapshot("task-editor-missing");
		const evidence = snapshot?.segments[0]?.editorCallEvidence;
		const call = evidence?.calls.find((candidate) => candidate.toolCallId === "call_edit_missing");
		expect(call?.raw.status).toBe("captured");
		expect(call?.parsed.status).toBe("captured");
		expect(call?.result.status).toBe("captured");
		expect(JSON.stringify(call?.result.result ?? null)).toContain("old_text");
		expect(call?.comparison).toBe("absent-in-both");
		expect(call?.comparisonNote).toContain("not proven model error");
	}, 300_000);
});
