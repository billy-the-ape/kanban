// Temporary probe (B-2-5): boot a REAL SDK session against a local capture server.
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

const probeDir = mkdtempSync(join(tmpdir(), "kanban-probe-"));
process.env.CLINE_DIR = probeDir;
console.log("[probe] CLINE_DIR =", probeDir);

execFileSync("git", ["init", "-q"], { cwd: probeDir });

const { ClineCore } = await import("@clinebot/core");

const requests: { path: string; body: any }[] = [];
let respondText = "Okay.";

const server = createServer((req, res) => {
	let data = "";
	req.on("data", (chunk) => (data += chunk));
	req.on("end", () => {
		const body = data ? JSON.parse(data) : {};
		if (req.url?.includes("/chat/completions")) {
			requests.push({ path: req.url!, body });
			res.writeHead(200, { "content-type": "text/event-stream" });
			const id = `chatcmpl-probe-${requests.length}`;
			const chunk = (choices: unknown) =>
				`data: ${JSON.stringify({
					id,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "probe-model",
					choices,
				})}\n\n`;
			res.write(chunk([{ index: 0, delta: { role: "assistant", content: "" } }]));
			res.write(chunk([{ index: 0, delta: { content: respondText } }]));
			res.write(
				`data: ${JSON.stringify({
					id,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "probe-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					// Simulate a server-side count of the full assembled request.
					usage: {
						prompt_tokens: Math.ceil(data.length / 4),
						completion_tokens: 1,
						total_tokens: Math.ceil(data.length / 4) + 1,
					},
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [{ id: "probe-model", object: "model" }] }));
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

const scenario = process.argv[2] ?? "basic";
const logger = {
	debug: (msg: string, meta?: any) => console.log(`[sdk:debug] ${msg}`, meta ? JSON.stringify(meta) : ""),
	log: (msg: string, meta?: any) => console.log(`[sdk:log] ${msg}`, meta ? JSON.stringify(meta) : ""),
	error: (msg: string, meta?: any) => console.error(`[sdk:error] ${msg}`, meta?.error ?? (meta ? JSON.stringify(meta) : "")),
};
const core = await ClineCore.create({ clientName: "kanban-probe", backendMode: "auto", logger });

core.subscribe((event) => {
	if (event.type === "chunk") {
		return;
	}
	console.log(`[probe] event: ${event.type}`, JSON.stringify(event.payload).slice(0, 800));
});

let start;
try {
	if (scenario === "basic") {
		start = await core.start({
			config: {
				providerId: "ollama",
				modelId: "probe-model",
				apiKey: "sk-probe",
				baseUrl,
				cwd: probeDir,
				mode: "act",
				systemPrompt: "You are a concise test assistant.",
				enableTools: true,
				enableSpawnAgent: false,
				enableAgentTeams: false,
				contextWindowTokens: 4000,
				maxTokens: 500,
				compaction: { enabled: true, auto: true, reserveTokens: 300 },
				knownModels: {
					"probe-model": {
						id: "probe-model",
						name: "Probe model",
						contextWindow: 4000,
						maxTokens: 500,
						capabilities: ["streaming", "tools"],
					},
				},
			},
			prompt: "Reply with exactly: hello probe",
			interactive: true,
			localRuntime: { logger },
		});
	} else if (scenario === "compaction") {
		start = await core.start({
			config: {
				providerId: "ollama",
				modelId: "probe-model",
				apiKey: "sk-probe",
				baseUrl,
				cwd: probeDir,
				mode: "act",
				systemPrompt: "You are a concise test assistant.",
				enableTools: false,
				enableSpawnAgent: false,
				enableAgentTeams: false,
				contextWindowTokens: 400,
				maxTokens: 100,
				compaction: { enabled: true, auto: true, reserveTokens: 100 },
				knownModels: {
					"probe-model": {
						id: "probe-model",
						name: "Probe model",
						contextWindow: 400,
						maxTokens: 100,
						capabilities: ["streaming", "tools"],
					},
				},
			},
			interactive: true,
			localRuntime: { logger },
		});
		const reply = ("The quick brown fox jumps over the lazy dog. ".repeat(20)).trim();
		for (let i = 0; i < 8; i++) {
			respondText = reply;
			const result = await core.send({ sessionId: start.sessionId, prompt: `Round ${i}: repeat after me` });
			const record = await core.get(start.sessionId);
			console.log(
				`[probe] round ${i}: status=${record?.status ?? "?"} result=${result ? `finish=${(result as any).finishReason}` : "undefined"}`,
			);
			if (record?.status === "error" || record?.status === "stopped") break;
		}
	} else {
		throw new Error(`unknown scenario: ${scenario}`);
	}

	console.log("[probe] sessionId =", start.sessionId);
	const finalRecord = await core.get(start.sessionId);
	console.log("[probe] final status =", finalRecord?.status, "messageCount hint:", (finalRecord as any)?.messages?.length);

	console.log(`\n[probe] ${requests.length} chat completion request(s) captured:`);
	for (const [index, { path, body }] of requests.entries()) {
		const roles = (body.messages ?? []).map((m: any) => `${m.role}:${(m.content ?? "").length}c`);
		console.log(`\n  request #${index} (${path}):`);
		console.log(`    model=${body.model} stream=${body.stream} max_tokens=${body.max_tokens ?? body.max_completion_tokens}`);
		console.log(`    messages[${body.messages?.length ?? 0}]: ${roles.join(" | ")}`);
		console.log(`    tools=${body.tools?.length ?? 0}${body.tools ? ` (${body.tools.map((t: any) => t.function?.name ?? t.name).join(", ")})` : ""}`);
		if (body.tools?.length) {
			const toolsJson = JSON.stringify(body.tools);
			console.log(`    tools json length=${toolsJson.length} chars (est ${Math.ceil(toolsJson.length / 4)} tokens)`);
		}
		if (body.messages?.[0]) {
			console.log(`    first message role=${body.messages[0].role}, content length=${(body.messages[0].content ?? "").length}`);
			console.log(`    first message head: ${(body.messages[0].content ?? "").slice(0, 160).replace(/\n/g, " ⏎ ")}`);
		}
	}

	const usage = await core.getAccumulatedUsage(start.sessionId);
	console.log("\n[probe] accumulated usage =", usage);
} catch (error) {
	console.error("[probe] FAILED:", error);
	try {
		const recent = await core.list(2);
		for (const rec of recent) {
			console.log(`[probe] recent session: ${rec.sessionId} status=${rec.status}`);
			const full = (await core.get(rec.sessionId)) as any;
			console.log("[probe] record keys:", Object.keys(full ?? {}));
			console.log("[probe] record.result:", JSON.stringify(full?.result)?.slice(0, 2000));
			console.log("[probe] record.metadata:", JSON.stringify(full?.metadata)?.slice(0, 2000));
			try {
				const raw = await readFile(full?.messagesPath, "utf8");
				console.log(`[probe] messages (${raw.length} chars), tail:`);
				console.log(raw.slice(-3000));
			} catch (msgError) {
				console.error("[probe] messages read failed:", msgError);
			}
		}
	} catch (listError) {
		console.error("[probe] list failed:", listError);
	}
	process.exitCode = 1;
} finally {
	try {
		await core.stop(start?.sessionId).catch(() => {});
	} catch {
		/* start failed */
	}
	await core.dispose("probe complete").catch(() => {});
	server.close();
	if (process.exitCode !== 1) {
		rmSync(probeDir, { recursive: true, force: true });
	} else {
		console.log(`[probe] kept dir for inspection: ${probeDir}`);
	}
}

