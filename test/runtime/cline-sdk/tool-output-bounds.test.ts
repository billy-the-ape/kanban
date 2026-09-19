// B-2.7 — end-to-end: oversized run_commands output and a large git diff are
// bounded at ingestion with structured line-based excerpts, preserving the
// exit status and persisting the full output to a local artifact.
//
// Drives the real InMemoryClineTaskSessionService + InMemoryClineSessionRuntime against a
// real @clinebot/core local session host and a local OpenAI-compatible capture server that:
// (1) answers the first model request with a `run_commands` tool call that cats a ~800 KB
//     file, and (2) answers the second model request with a `run_commands` tool call that
//     rewrites a tracked file and runs `git diff` (a large diff) — while ENFORCING the
//     model window on every request (400 on overflow). The session carries Kanban's
//     calibrated compaction config, the beforeModel guard (B-2.5), and the afterTool
//     tool-result bounding hook (B-2.6 + B-2.7) — all wired by the runtime under test.
//
// Asserts:
// - zero provider overflow rejections, and every request fits the window even though the
//   unbounded command output would have blown it several times over;
// - the persisted run_commands tool-result messages are line-based excerpts: a
//   `Command i/N:` + `Exit status: success` head, first-N/last-M output lines separated
//   by a `... [truncated K lines; full output: <path>]` marker, and a per-file diff
//   summary prepended for the diff result — with the middle of the output absent from
//   both the persisted messages and the provider requests;
// - the referenced artifacts hold the full structured SDK output (JSON per-command
//   entries), including the middle lines the excerpts dropped;
// - the hook logged the bounding with `excerptKind: "command-lines"`, and the session
//   stays healthy.
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
import { computeToolResultBoundChars } from "../../../src/cline-sdk/cline-tool-result-bounding-hook";
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
const TASK_ID = "task-b27-commands";
const HEAD_MARKER = "B27-HEAD-MARKER";
const TAIL_MARKER = "B27-TAIL-MARKER";
const MIDDLE_LINE = `line-4000 ${"p".repeat(90)}`;
const DIFF_MIDDLE_LINE = "+generated line 1500";
// ~800 KB of command output: far beyond the bounded excerpt (and under the SDK
// executor's 1 MB maxOutputBytes) so an unbounded result would overflow the 8k
// provider window many times over.
const bigCommandOutput = [
	HEAD_MARKER,
	...Array.from({ length: 7_998 }, (_, index) =>
		index + 2 === 4_000 ? MIDDLE_LINE : `line-${index + 2} ${"p".repeat(90)}`,
	),
	TAIL_MARKER,
].join("\n");
const COMPLETION = "Both command outputs were reviewed; the head and tail markers are present.";

interface CapturedRequest {
	promptTokens: number;
	rawBody: string;
}

let probeDir = "";
let bigOutputPath = "";
let diffFilePath = "";
let diffCommand = "";
let logPath = "";
let server: Server | null = null;
let baseUrl = "";
let service: ClineTaskSessionService | null = null;
let savedEnv: Record<string, string | undefined> = {};
const requests: CapturedRequest[] = [];
let overflowRejections = 0;
let completedChatResponses = 0;

function writeSseChunk(res: ServerResponse, id: string, extra: Record<string, unknown>): void {
	res.write(
		`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "probe-model", ...extra })}\n\n`,
	);
}

// Standard OpenAI chat-completion SSE with a single tool call: the full call (id, name,
// arguments) in one delta, then finish_reason "tool_calls". Parsed by the Vercel AI SDK
// openai-compatible provider the local session uses for the ollama provider.
function writeSseToolCall(res: ServerResponse, toolName: string, args: unknown, promptTokens: number): void {
	const id = `chatcmpl-b27-toolcall-${requests.length}`;
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
							id: `call_b27_run_commands_${requests.length}`,
							type: "function",
							function: { name: toolName, arguments: JSON.stringify(args) },
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
	const id = `chatcmpl-b27-text-${requests.length}`;
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
	probeDir = mkdtempSync(join(tmpdir(), "kanban-b27-int-"));
	savedEnv = {
		CLINE_DIR: process.env.CLINE_DIR,
		CLINE_LOG_ENABLED: process.env.CLINE_LOG_ENABLED,
		CLINE_LOG_LEVEL: process.env.CLINE_LOG_LEVEL,
		CLINE_LOG_PATH: process.env.CLINE_LOG_PATH,
	};
	// Sandbox the SDK storage and capture the Kanban session log (it carries the
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
	// The file whose stdout the first run_commands call dumps.
	bigOutputPath = join(probeDir, "big-command-output.txt");
	writeFileSync(bigOutputPath, bigCommandOutput, "utf8");
	// A tracked file the second run_commands call rewrites so `git diff` yields a large
	// unified diff (10 lines replaced by 3000).
	diffFilePath = join(probeDir, "large-file.txt");
	writeFileSync(
		diffFilePath,
		Array.from({ length: 10 }, (_, i) => `original line ${i + 1}`).join("\n") + "\n",
		"utf8",
	);
	execFileSync("git", ["-C", probeDir, "config", "user.email", "kanban-b27@example.com"]);
	execFileSync("git", ["-C", probeDir, "config", "user.name", "Kanban B27 Test"]);
	execFileSync("git", ["-C", probeDir, "add", "large-file.txt"]);
	execFileSync("git", ["-C", probeDir, "commit", "-q", "-m", "initial"]);
	diffCommand =
		`awk 'BEGIN { for (i = 1; i <= 3000; i++ ) print "generated line " i }' > ${diffFilePath} && ` +
		`git -C ${probeDir} diff -- large-file.txt`;

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
				// Scripted model responses: (1) cat the ~800 KB file, (2) rewrite the
				// tracked file and run git diff, (3) final answer.
				if (requests.length === 1) {
					writeSseToolCall(res, "run_commands", { commands: [`cat ${bigOutputPath}`] }, promptTokens);
				} else if (requests.length === 2) {
					writeSseToolCall(res, "run_commands", { commands: [diffCommand] }, promptTokens);
				} else {
					writeSseTextCompletion(res, COMPLETION, promptTokens);
				}
				return;
			}
			// Non-chat endpoints (provider metadata probes): lenient 200.
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
					await ClineCore.create({ clientName: "kanban-b27-integration", backendMode: "local" }),
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

describe("B-2.7 — command-output bounding at ingestion (real local SDK session)", () => {
	it("bounds oversized run_commands output with a line excerpt and preserves the full output as an artifact", async () => {
		const activeService = service as ClineTaskSessionService;
		const boundChars = computeToolResultBoundChars(WINDOW);
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
			prompt: `Run \`cat ${bigOutputPath}\` and then run: ${diffCommand}. Report when both are done.`,
			providerId: "ollama",
			modelId: "probe-model",
			apiKey: "sk-test-key",
			baseUrl,
			systemPrompt: SYSTEM_PROMPT,
			contextWindowTokens: WINDOW,
			contextWindowSource: "override",
			compaction,
		});
		// Three model responses: (1) cat tool call, (2) diff tool call, (3) final
		// answer carrying both (bounded) tool results.
		await waitForResponses(3, 120_000);

		// 1. The provider window is enforced on every request and never overflows:
		//    without ingestion bounding the ~800 KB cat output would blow the 8k window
		//    many times over on later requests.
		expect(overflowRejections).toBe(0);
		expect(requests.length).toBeGreaterThanOrEqual(3);
		for (const request of requests) {
			expect(request.promptTokens + MAX_TOKENS).toBeLessThanOrEqual(WINDOW);
		}
		// The unbounded middle of the cat output never reaches the provider.
		for (const request of requests) {
			expect(request.rawBody).not.toContain(MIDDLE_LINE);
		}
		expect(requests[2]!.rawBody).not.toContain(DIFF_MIDDLE_LINE);

		// 2. The persisted tool messages are bounded line-based excerpts.
		const artifactsDir = join(probeDir, "worktrees-home", TASK_ID, "context-artifacts");
		const toolMessages = activeService
			.listMessages(TASK_ID)
			.filter((message) => message.role === "tool" && message.meta?.toolName === "run_commands");
		expect(toolMessages.length).toBe(2);

		// (a) cat result: Command/Exit-status head, head + tail output lines, truncation
		//     marker with the artifact reference; the middle is dropped.
		const catContent = toolMessages[0]!.content;
		expect(catContent).toContain("Tool: run_commands");
		expect(catContent).toContain("Command 1/1: cat ");
		expect(catContent).toContain("Exit status: success");
		expect(catContent).toContain(HEAD_MARKER);
		expect(catContent).toContain(TAIL_MARKER);
		expect(catContent).not.toContain(MIDDLE_LINE);
		expect(catContent).toMatch(/\.\.\. \[truncated \d+ lines; full output: [^\]]+\]/);
		expect(catContent.length).toBeLessThanOrEqual(boundChars + 512);

		// (b) git diff result: diff stat summary in the head, diff head + tail lines,
		//     and the middle of the diff dropped.
		const diffContent = toolMessages[1]!.content;
		expect(diffContent).toContain("Tool: run_commands");
		expect(diffContent).toContain("Command 1/1: awk");
		expect(diffContent).toContain("Exit status: success");
		expect(diffContent).toContain("Diff summary (1 file):");
		expect(diffContent).toContain("  large-file.txt | +3000 -10");
		expect(diffContent).toContain("+generated line 1");
		expect(diffContent).toContain("+generated line 3000");
		expect(diffContent).not.toContain(DIFF_MIDDLE_LINE);
		expect(diffContent).toMatch(/\.\.\. \[truncated \d+ lines; full output: [^\]]+\]/);
		expect(diffContent.length).toBeLessThanOrEqual(boundChars + 512);

		// 3. The referenced artifacts live outside any repo checkout and hold the full
		//    structured SDK output (JSON per-command entries) — including the middle
		//    lines the excerpts dropped.
		const readArtifactFor = (content: string) => {
			const reference = content.match(/\[truncated \d+ lines; full output: ([^\]]+)\]/)![1]!.trim();
			expect(reference.startsWith(artifactsDir)).toBe(true);
			return reference;
		};
		const catArtifactContent = await readTaskContextArtifact(readArtifactFor(catContent));
		const catArtifact = JSON.parse(catArtifactContent) as Array<{
			query: string;
			result?: string;
			success?: boolean;
		}>;
		expect(catArtifact).toHaveLength(1);
		expect(catArtifact[0]?.query).toBe(`cat ${bigOutputPath}`);
		expect(catArtifact[0]?.success).toBe(true);
		expect(catArtifact[0]?.result?.length).toBeGreaterThan(750_000);
		expect(catArtifact[0]?.result).toContain(HEAD_MARKER);
		expect(catArtifact[0]?.result).toContain(MIDDLE_LINE);
		expect(catArtifact[0]?.result).toContain(TAIL_MARKER);

		const diffArtifactContent = await readTaskContextArtifact(readArtifactFor(diffContent));
		const diffArtifact = JSON.parse(diffArtifactContent) as Array<{
			query: string;
			result?: string;
			success?: boolean;
		}>;
		expect(diffArtifact).toHaveLength(1);
		expect(diffArtifact[0]?.success).toBe(true);
		expect(diffArtifact[0]?.result).toContain("@@ -1,10 +1,3000 @@");
		expect(diffArtifact[0]?.result).toContain(DIFF_MIDDLE_LINE);

		// 4. The hook logged the bounding with line-excerpt stats and artifact paths
		//    for both commands, and the session stayed healthy (a tool failure would
		//    surface as an error review reason).
		const logLines = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0);
		const hookEntries = logLines
			.map((line) => JSON.parse(line) as { message?: string; metadata?: Record<string, unknown> })
			.filter((entry) => entry.message?.includes("Bounded oversized tool result at ingestion"));
		expect(hookEntries.length).toBe(2);
		for (const entry of hookEntries) {
			expect(entry.metadata?.toolName).toBe("run_commands");
			expect(entry.metadata?.excerptKind).toBe("command-lines");
			expect(typeof entry.metadata?.omittedLines).toBe("number");
			expect(String(entry.metadata?.artifactPath).startsWith(artifactsDir)).toBe(true);
		}

		const summary = activeService.getSummary(TASK_ID);
		expect(["running", "awaiting_review", "idle"]).toContain(summary?.state);
		expect(summary?.reviewReason).not.toBe("error");
	}, 180_000);
});
