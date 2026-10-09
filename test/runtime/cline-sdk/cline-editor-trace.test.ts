import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentModel, AgentRuntime, type AgentTool } from "@clinebot/agents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClineEditorTraceHooks } from "../../../src/cline-sdk/cline-editor-trace";

const state = vi.hoisted(() => ({ directory: "" }));
vi.mock("../../../src/cline-sdk/sdk-runtime-boundary", () => ({
	resolveClineSdkDataDir: () => state.directory,
}));

async function run(input: Record<string, unknown>, toolName = "editor", fail = true) {
	let calls = 0;
	const model: AgentModel = {
		async *stream() {
			if (calls++ === 0) {
				yield { type: "tool-call-delta", toolCallId: "call-1", toolName, inputText: JSON.stringify(input) };
				yield { type: "finish", reason: "tool-calls" };
			} else {
				yield { type: "text-delta", text: "Done" };
				yield { type: "finish", reason: "stop" };
			}
		},
	};
	const tool: AgentTool = {
		name: toolName,
		description: "Test editor",
		inputSchema: { type: "object" },
		execute: () => {
			if (!fail) return { success: true };
			throw new Error("Parameter old_text is required");
		},
	};
	return new AgentRuntime({ model, tools: [tool], hooks: createClineEditorTraceHooks("task", "session") }).run(
		"Start",
	);
}

describe("temporary editor trace", () => {
	beforeEach(() => {
		state.directory = mkdtempSync(join(tmpdir(), "editor-trace-"));
		vi.stubEnv("KANBAN_TRACE_EDITOR", "1");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(state.directory, { recursive: true, force: true });
	});
	it("records paired model/execution inputs and the SDK's thrown-error result without truncation", async () => {
		const input = { path: "/file.ts", new_text: "x".repeat(7000) };
		expect((await run(input)).status).toBe("completed");
		const path = join(state.directory, "logs", "editor-trace.jsonl");
		const records = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.map((record) => record.phase)).toEqual(["model-call", "before-execution", "result"]);
		for (const record of records) {
			expect(record).toMatchObject({
				taskId: "task",
				sessionId: "session",
				toolCallId: "call-1",
				input,
				hasOldText: false,
				oldTextChars: null,
				newTextChars: 7000,
			});
			expect(Number.isNaN(Date.parse(record.ts))).toBe(false);
		}
		expect(JSON.stringify(records[2].result)).toContain("Parameter old_text is required");
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	});
	it.each([null, ""])("preserves old_text %j distinctly from absence", async (old_text) => {
		await run({ path: "/file.ts", old_text, new_text: "a" });
		const record = JSON.parse(
			readFileSync(join(state.directory, "logs", "editor-trace.jsonl"), "utf8").split("\n")[0],
		);
		expect(record.hasOldText).toBe(true);
		expect(record.input.old_text).toBe(old_text);
		expect(record.oldTextChars).toBe(old_text === null ? null : 0);
	});
	it("is disabled by default and ignores other tools", async () => {
		vi.stubEnv("KANBAN_TRACE_EDITOR", "");
		expect(createClineEditorTraceHooks("task", "session")).toEqual({});
		vi.stubEnv("KANBAN_TRACE_EDITOR", "1");
		await run({}, "read_files");
		expect(() => readFileSync(join(state.directory, "logs", "editor-trace.jsonl"))).toThrow();
	});
	it("does not stop the loop when the destination cannot be written", async () => {
		writeFileSync(join(state.directory, "logs"), "not a directory");
		expect((await run({ new_text: "a" })).status).toBe("completed");
	});
	it("records successful calls too", async () => {
		await run({ path: "/file.ts", insert_line: 1, new_text: "a" }, "editor", false);
		const records = readFileSync(join(state.directory, "logs", "editor-trace.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toHaveLength(3);
		expect(JSON.stringify(records[2].result)).toContain('"success":true');
	});
});
