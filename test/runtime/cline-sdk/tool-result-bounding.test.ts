// B-2.6 — end-to-end: a single oversized file read is bounded at ingestion time and
// preserved as a local artifact.
//
// Drives the real InMemoryClineTaskSessionService + InMemoryClineSessionRuntime against a
// real @clinebot/core local session host and a local OpenAI-compatible capture server that:
// (1) answers the first model request with a `read_files` tool call targeting a ~1 MB file,
// and (2) ENFORCES the model window on every request (400 on overflow). The session carries
// Kanban's calibrated compaction config, the beforeModel guard (B-2.5), and the afterTool
// tool-result bounding hook (B-2.6) — all wired by the runtime under test.
//
// Asserts:
// - zero provider overflow rejections, and every request fits the window even though the
//   unbounded read result would have blown it several times over;
// - the persisted read_files tool-result message is bounded (head + tail excerpt) with a
//   `Full content:` reference, and the middle of the file is absent;
// - the referenced artifact exists outside any repo checkout (under the task's worktrees
//   home) and holds the full read result;
// - the session stays healthy.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClineCore } from "@clinebot/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildClineCompactionConfig } from "../../../src/cline-sdk/cline-compaction-config";
import type { ResolvedClineLaunchConfig } from "../../../src/cline-sdk/cline-provider-service";
import { createInMemoryClineSessionRuntime } from "../../../src/cline-sdk/cline-session-runtime";
import {
	type ClineTaskSessionService,
	createInMemoryClineTaskSessionService,
} from "../../../src/cline-sdk/cline-task-session-service";
import { CLINE_TOOL_RESULT_BOUND_MIN_CHARS } from "../../../src/cline-sdk/cline-tool-result-bounding-hook";
import { readTaskContextArtifact } from "../../../src/workspace/task-artifacts";
import { createFakeMcpRuntimeService, createFakeRuntimeSetup } from "../../utilities/cline-session-service-harness";

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
	const original = await importOriginal<typeof import("../../../src/state/workspace-state")>();
	return {
		...original,
		getTaskWorktreesHomePath: workspaceStateMocks.getTaskWorktreesHomePath,
	};
});

beforeEach(() => {
	turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
	turnCheckpointMocks.deleteTaskTurnCheckpointRef.mockReset();
	turnCheckpointMocks.captureTaskTurnCheckpoint.mockImplementation(
		async (input: { taskId: string; turn: number }) => ({
			turn: input.turn,
			ref: `refs/kanban/checkpoints/${input.taskId}/turn/${input.turn}`,
			commit: `commit-${input.turn}`,
			createdAt: input.turn,
		}),
	);
	turnCheckpointMocks.deleteTaskTurnCheckpointRef.mockResolvedValue(undefined);
});

const WINDOW = 8_000;
const MAX_TOKENS = 500;
const SYSTEM_PROMPT = "You are a concise test assistant.";
const TASK_ID = "task-b26-read";
const HEAD_MARKER = "B26-HEAD-MARKER";
const TAIL_MARKER = "B26-TAIL-MARKER";
const MIDDLE_LINE = `line-5000 ${"p".repeat(90)}`;
// ~1 MB file: far beyond the bounded excerpt (and the SDK's own 50k cap) so an unbounded
// result would overflow the 8k provider window many times over.
const bigFileContent = [
	HEAD_MARKER,
	...Array.from({ length: 9_998 }, (_, index) =>
		index + 2 === 5_000 ? MIDDLE_LINE : `line-${index + 2} ${"p".repeat(90)}`,
	),
	TAIL_MARKER,
].join("\n");
const COMPLETION = "The file starts with B26-HEAD-MARKER and ends with B26-TAIL-MARKER.";

interface CapturedRequest {
	promptTokens: number;
	rawBody: string;
}

let probeDir = "";
let bigFilePath = "";
let logPath = "";
let server: Server | null = null;
let baseUrl = "";
let service: ClineTaskSessionService | null = null;
let savedEnv: Record<string, string | undefined> = {};
const requests: CapturedRequest[] = [];
let overflowRejections = 0;

function writeSseChunk(res: ServerResponse, id: string, extra: Record<string, unknown>): void {
	res.write(
		`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "probe-model", ...extra })}\n\n`,
	);
}

// Standard OpenAI chat-completion SSE with a single tool call: the full call (id, name,
// arguments) in one delta, then finish_reason "tool_calls". Parsed by the Vercel AI SDK
// openai-compatible provider the local session uses for the ollama provider.
function writeSseToolCall(res: ServerResponse, targetPath: string, promptTokens: number): void {
	const id = "chatcmpl-b26-toolcall";
	res.writeHead(200, { "content-type": "text/event-stream" });
	writeSseChunk(res, id, {
		choices: [
			{
				index: 0,
				delta: {
					role: "assistant",
					content: "",
					tool_calls: [
						{
							index: 0,
							id: "call_b26_read_files",
							type: "function",
							function: { name: "read_files", arguments: JSON.stringify({ files: [{ path: targetPath }] }) },
						},
					],
				},
			},
		],
	});
	res.write(
		`data: ${JSON.stringify({
			id,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "probe-model",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
	completedChatResponses += 1;
}

function writeSseTextCompletion(res: ServerResponse, text: string, promptTokens: number): void {
	const id = `chatcmpl-b26-text-${requests.length}`;
	res.writeHead(200, { "content-type": "text/event-stream" });
	writeSseChunk(res, id, { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
	writeSseChunk(res, id, { choices: [{ index: 0, delta: { content: text } }] });
	writeSseChunk(res, id, {
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
	});
	res.write("data: [DONE]\n\n");
	res.end();
	completedChatResponses += 1;
}

async function waitForResponses(minResponses: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (completedChatResponses >= minResponses) {
			return;
		}
		const summary = service?.getSummary(TASK_ID);
		if (summary && (summary.state === "failed" || summary.state === "interrupted")) {
			throw new Error(
				`session entered ${summary.state} before response ${minResponses}: ${summary.warningMessage ?? summary.reviewReason ?? "no detail"}`,
			);
		}
		if (Date.now() > deadline) {
			throw new Error(
				`timed out waiting for response ${minResponses} (completed=${completedChatResponses}, requests=${requests.length})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

beforeAll(async () => {
	probeDir = mkdtempSync(join(tmpdir(), "kanban-b26-int-"));
	savedEnv = {
		CLINE_DIR: process.env.CLINE_DIR,
		CLINE_LOG_ENABLED: process.env.CLINE_LOG_ENABLED,
		CLINE_LOG_LEVEL: process.env.CLINE_LOG_LEVEL,
		CLINE_LOG_PATH: process.env.CLINE_LOG_PATH,
	};
	// Sandbox the SDK's storage and capture the Kanban session log (which carries the
	// afterTool hook's bounding diagnostics).
	process.env.CLINE_DIR = probeDir;
	process.env.CLINE_LOG_ENABLED = "1";
	process.env.CLINE_LOG_LEVEL = "debug";
	logPath = join(probeDir, "kanban.log");
	process.env.CLINE_LOG_PATH = logPath;
	execFileSync("git", ["init", "-q"], { cwd: probeDir });
	// Task state (worktrees + context artifacts) lives under the probe dir too, so the
	// whole session is self-contained and cleaned up in afterAll.
	workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(join(probeDir, "worktrees-home"));
	bigFilePath = join(probeDir, "big-file.txt");
	writeFileSync(bigFilePath, bigFileContent, "utf8");

	const activeServer = createServer((req: IncomingMessage, res: ServerResponse) => {
		let data = "";
		req.on("data", (chunk: string) => {
			data += chunk;
		});
		req.on("end", () => {
			if (req.url?.includes("/chat/completions")) {
				const promptTokens = Math.ceil(data.length / 4);
				requests.push({ promptTokens, rawBody: data });
				if (promptTokens + MAX_TOKENS > WINDOW) {
					overflowRejections += 1;
					res.writeHead(400, { "content-type": "application/json" });
					res.end(
						JSON.stringify({
							error: {
								message: `This model's maximum context length is ${WINDOW} tokens. However, your messages resulted in ${promptTokens} tokens. Please shorten the messages.`,
								type: "invalid_request_error",
							},
						}),
					);
					return;
				}
				if (requests.length === 1) {
					writeSseToolCall(res, bigFilePath, promptTokens);
				} else {
					writeSseTextCompletion(res, COMPLETION, promptTokens);
				}
				return;
			}
			// Non-chat endpoints (provider metadata probes): permissive 200.
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
					await ClineCore.create({ clientName: "kanban-b26-integration", backendMode: "local" }),
				createMcpRuntimeService: () => createFakeMcpRuntimeService(),
			}),
		createRuntimeSetup: async () => createFakeRuntimeSetup(),
	});
});

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

describe("B-2.6 — tool-result bounding at ingestion (real local SDK session)", () => {
	it("bounds an oversized read_files result and preserves the full content as a local artifact", async () => {
		const activeService = service as ClineTaskSessionService;
		const launchConfig: ResolvedClineLaunchConfig = {
			providerId: "ollama",
			modelId: "probe-model",
			apiKey: "sk-test-key",
			baseUrl,
			contextWindowTokens: WINDOW,
			contextWindowSource: "override",
			maxTokens: MAX_TOKENS,
		};
		const compaction = buildClineCompactionConfig({ launchConfig });

		await activeService.startTaskSession({
			taskId: TASK_ID,
			cwd: probeDir,
			prompt: `Read the file at ${bigFilePath} with read_files and report the head and tail markers exactly.`,
			providerId: "ollama",
			modelId: "probe-model",
			apiKey: "sk-test-key",
			baseUrl,
			systemPrompt: SYSTEM_PROMPT,
			contextWindowTokens: WINDOW,
			contextWindowSource: "override",
			compaction,
		});
		// Two model responses: (1) the tool call, (2) the final answer carrying the
		// (bounded) tool result.
		await waitForResponses(2, 120_000);

		// 1. The provider window was enforced on every request and never overflowed:
		//    without the ingestion bound, the ~1 MB read result would have blown the
		//    8k window many times over on the second request.
		expect(overflowRejections).toBe(0);
		expect(requests.length).toBeGreaterThanOrEqual(2);
		for (const request of requests) {
			expect(request.promptTokens + MAX_TOKENS).toBeLessThanOrEqual(WINDOW);
		}
		expect(requests[1]!.promptTokens).toBeLessThan(WINDOW / 2);

		// 2. The request carrying the tool result is bounded and references the artifact.
		const artifactsDir = join(probeDir, "worktrees-home", TASK_ID, "context-artifacts");
		expect(requests[1]!.rawBody).toContain("Full content: ");
		expect(requests[1]!.rawBody).toContain(artifactsDir);

		// 3. The persisted tool message is a head+tail excerpt: markers at both ends
		//    present, the middle of the file gone, and the total within the bound
		//    plus the small tool-wrapper overhead.
		const toolMessages = activeService
			.listMessages(TASK_ID)
			.filter((message) => message.role === "tool" && message.meta?.toolName === "read_files");
		expect(toolMessages.length).toBe(1);
		const toolContent = toolMessages[0]!.content;
		expect(toolContent).toContain("Tool: read_files");
		expect(toolContent).toContain(HEAD_MARKER);
		expect(toolContent).toContain(TAIL_MARKER);
		expect(toolContent).not.toContain(MIDDLE_LINE);
		expect(toolContent).toContain("Full content: ");
		expect(toolContent.length).toBeLessThanOrEqual(CLINE_TOOL_RESULT_BOUND_MIN_CHARS + 512);

		// 4. The referenced artifact lives outside any repo checkout and holds the
		//    full read result.
		const reference = toolContent.match(/Full content: (.+)$/m)![1]!.trim();
		expect(reference.startsWith(artifactsDir)).toBe(true);
		const artifactContent = await readTaskContextArtifact(reference);
		expect(artifactContent.length).toBeGreaterThan(900_000);
		expect(artifactContent).toContain(HEAD_MARKER);
		expect(artifactContent).toContain(TAIL_MARKER);
		expect(artifactContent).toContain(MIDDLE_LINE);

		// 5. The hook logged the bounding with the artifact path, and the session
		//    stayed healthy (a tool failure would surface as error review reason).
		const logLines = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0);
		const hookEntries = logLines
			.map((line) => JSON.parse(line) as { message?: string; metadata?: Record<string, unknown> })
			.filter((entry) => entry.message?.includes("Bounded oversized tool result at ingestion"));
		expect(hookEntries.length).toBeGreaterThan(0);
		expect(String(hookEntries[0]!.metadata?.artifactPath)).toBe(reference);

		const summary = activeService.getSummary(TASK_ID);
		expect(["running", "awaiting_review", "idle"]).toContain(summary?.state);
		expect(summary?.reviewReason).not.toBe("error");
	}, 180_000);
});
let completedChatResponses = 0;
