// B-2.5 — Proactive compaction in local mode, end to end.
//
// Drives the real InMemoryClineTaskSessionService through the real
// InMemoryClineSessionRuntime against a REAL @clinebot/core local session
// host (no fake host) and a local OpenAI-compatible capture server that
// ENFORCES the model window: any request whose estimated prompt plus the
// expected output exceeds the window is rejected with a 400
// "maximum context length" error. The session carries Kanban's calibrated
// compaction config, the beforeModel hook (the local-mode guard), and the
// compact callback — all wired by the runtime under test.
//
// Asserts:
// - the beforeModel hook fires and shrinks the message tokens (observed via
//   the Kanban session log "beforeModel compaction applied" lines);
// - zero provider overflow rejections across enough rounds that the
//   un-compacted history would definitely have exceeded the window;
// - every request the provider actually received fits the window, and stays
//   far below it (the un-compacted history would have crossed the window
//   around round 13);
// - the persisted transcript stays complete (the rewrite is request-scoped)
//   and the session remains healthy.
//
// This boots a real SDK host and makes real HTTP requests to a localhost
// capture server, so it is slower than the rest of the directory — the
// timeout below is intentional. The core is pinned to backendMode "local"
// so no hub detection ever runs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const SYSTEM_PROMPT = "You are a concise test assistant. Reply in one short sentence.";
// ~450 estimated tokens per reply: un-compacted history crosses the window
// (WINDOW - MAX_TOKENS) around round 13, so ROUNDS proves the guard matters.
const REPLY = "The quick brown fox jumps over the lazy dog. ".repeat(40).trim();
const ROUNDS = 20;
const TASK_ID = "task-b25-proactive";

interface CapturedRequest {
	promptTokens: number;
	messages: number;
	tools: number;
}

let probeDir = "";
let logPath = "";
let server: Server | null = null;
let baseUrl = "";
let service: ClineTaskSessionService | null = null;
let savedEnv: Record<string, string | undefined> = {};
const requests: CapturedRequest[] = [];
let overflowRejections = 0;
// Completed provider responses (SSE stream fully sent). The task session
// service starts and sends turns fire-and-forget, so the test polls this
// counter instead of relying on the service promises to sequence rounds.
let completedTurns = 0;

function writeSseCompletion(res: ServerResponse, promptTokens: number): void {
	const id = `chatcmpl-b25-${requests.length}`;
	const envelope = (extra: Record<string, unknown>) =>
		`data: ${JSON.stringify({
			id,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "probe-model",
			...extra,
		})}\n\n`;
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.write(envelope({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }));
	res.write(envelope({ choices: [{ index: 0, delta: { content: REPLY } }] }));
	res.write(
		envelope({
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
		}),
	);
	res.write("data: [DONE]\n\n");
	res.end();
	completedTurns += 1;
}

async function waitForTurns(minTurns: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (completedTurns >= minTurns) {
			return;
		}
		const summary = service?.getSummary(TASK_ID);
		if (summary && (summary.state === "failed" || summary.state === "interrupted")) {
			throw new Error(
				`session entered ${summary.state} before turn ${minTurns}: ${summary.warningMessage ?? summary.reviewReason ?? "no detail"}`,
			);
		}
		if (Date.now() > deadline) {
			throw new Error(
				`timed out waiting for turn ${minTurns} (completed=${completedTurns}, requests=${requests.length})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

beforeAll(async () => {
	probeDir = mkdtempSync(join(tmpdir(), "kanban-b25-int-"));
	// Task state (compaction event records) lives under the probe dir, so the
	// session is self-contained and never writes into the real ~/.cline.
	workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(join(probeDir, "worktrees-home"));
	savedEnv = {
		CLINE_DIR: process.env.CLINE_DIR,
		CLINE_LOG_ENABLED: process.env.CLINE_LOG_ENABLED,
		CLINE_LOG_LEVEL: process.env.CLINE_LOG_LEVEL,
		CLINE_LOG_PATH: process.env.CLINE_LOG_PATH,
	};
	// Sandbox the SDK's storage and capture the Kanban session log (which
	// carries the beforeModel hook's compaction diagnostics).
	process.env.CLINE_DIR = probeDir;
	process.env.CLINE_LOG_ENABLED = "1";
	process.env.CLINE_LOG_LEVEL = "debug";
	logPath = join(probeDir, "kanban.log");
	process.env.CLINE_LOG_PATH = logPath;
	execFileSync("git", ["init", "-q"], { cwd: probeDir });

	const activeServer = createServer((req: IncomingMessage, res: ServerResponse) => {
		let data = "";
		req.on("data", (chunk: string) => {
			data += chunk;
		});
		req.on("end", () => {
			const body = data ? (JSON.parse(data) as { messages?: unknown[]; tools?: unknown[] }) : {};
			if (req.url?.includes("/chat/completions")) {
				const promptTokens = Math.ceil(data.length / 4);
				requests.push({
					promptTokens,
					messages: body.messages?.length ?? 0,
					tools: body.tools?.length ?? 0,
				});
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
				writeSseCompletion(res, promptTokens);
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
					await ClineCore.create({ clientName: "kanban-b25-integration", backendMode: "local" }),
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

describe("B-2.5 — proactive compaction (real local SDK session)", () => {
	it("compacts oversized requests proactively with zero provider overflow rejections", async () => {
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
			prompt: "Round 1: reply with the fox sentence",
			providerId: "ollama",
			modelId: "probe-model",
			apiKey: "sk-test-key",
			baseUrl,
			systemPrompt: SYSTEM_PROMPT,
			contextWindowTokens: WINDOW,
			contextWindowSource: "override",
			compaction,
		});
		// The start runs fire-and-forget; wait until the first model turn
		// fully completed (host created, first request answered).
		await waitForTurns(1, 120_000);
		for (let round = 2; round <= ROUNDS; round += 1) {
			await activeService.sendTaskSessionInput(TASK_ID, `Round ${round}: reply with the fox sentence`);
			await waitForTurns(round, 30_000);
		}
		const summary = activeService.getSummary(TASK_ID);

		// 1. The provider never rejected an overflow request, and every
		//    request it received fit the window.
		expect(requests.length).toBeGreaterThanOrEqual(ROUNDS);
		expect(overflowRejections).toBe(0);
		const maxPromptTokens = Math.max(...requests.map((request) => request.promptTokens));
		expect(maxPromptTokens + MAX_TOKENS).toBeLessThanOrEqual(WINDOW);
		// Without the hook, requests would have kept growing past the
		// window; the hook keeps them at the calibrated budget instead
		// (limit - output reserve - safety margin, well under half the
		// window here).
		expect(maxPromptTokens).toBeLessThan(WINDOW / 2);

		// 2. The beforeModel hook fired and reduced the message tokens.
		const logLines = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0);
		const hookEntries = logLines
			.map((line) => JSON.parse(line) as { message?: string; metadata?: Record<string, unknown> })
			.filter((entry) => entry.message?.includes("beforeModel compaction applied to model request"));
		expect(hookEntries.length).toBeGreaterThan(0);
		for (const entry of hookEntries) {
			expect(Number(entry.metadata?.messageTokensAfter)).toBeLessThan(Number(entry.metadata?.messageTokensBefore));
		}

		// 3. The rewrite is request-scoped: the persisted transcript
		//    stays complete, and the session stayed healthy (completed
		//    turns settle into awaiting_review; a failure would be
		//    failed/interrupted with an error review reason).
		expect(activeService.listMessages(TASK_ID).length).toBeGreaterThanOrEqual(ROUNDS);
		expect(["running", "awaiting_review", "idle"]).toContain(summary?.state);
		expect(summary?.reviewReason).not.toBe("error");
	}, 180_000);
});
