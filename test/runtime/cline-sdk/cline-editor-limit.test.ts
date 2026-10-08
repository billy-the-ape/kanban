import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentModel, type AgentModelRequest, AgentRuntime } from "@clinebot/agents";
import { createDefaultExecutors, createDefaultTools } from "@clinebot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClineEditorLimitHooks } from "../../../src/cline-sdk/cline-editor-limit";
import { createClineToolFailureRecoveryHooks } from "../../../src/cline-sdk/cline-tool-failure-recovery";

async function run(cwd: string, inputs: Record<string, unknown>[]) {
	const requests: AgentModelRequest[] = [];
	const limits = createClineEditorLimitHooks(cwd);
	const recovery = createClineToolFailureRecoveryHooks();
	let index = 0;
	const model: AgentModel = {
		async *stream(request) {
			requests.push(request);
			const input = inputs[index++];
			if (input) {
				yield {
					type: "tool-call-delta",
					toolCallId: `call-${index}`,
					toolName: "editor",
					inputText: JSON.stringify(input),
				};
				yield { type: "finish", reason: "tool-calls" };
			} else {
				yield { type: "text-delta", text: "Done" };
				yield { type: "finish", reason: "stop" };
			}
		},
	};
	const tools = createDefaultTools({ executors: createDefaultExecutors(), cwd }).filter(
		(tool) => tool.name === "editor",
	);
	const runtime = new AgentRuntime({
		model,
		tools,
		hooks: {
			...recovery,
			beforeModel: async (context) => {
				await recovery.beforeModel?.(context);
				return limits.beforeModel?.(context);
			},
			beforeTool: async (context) => {
				await limits.beforeTool?.(context);
				return recovery.beforeTool?.(context);
			},
		},
	});
	return { result: await runtime.run("Edit"), requests };
}

describe("local editor limit and model-facing recovery (real SDK tool and loop)", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "editor-limit-"));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("creates, replaces, and inserts payloads larger than the SDK cap without truncation", async () => {
		const path = join(cwd, "large.ts");
		const first = "a".repeat(20900);
		const second = "b".repeat(13491);
		const inserted = "c".repeat(7018);
		const { result, requests } = await run(cwd, [
			{ path, new_text: first },
			{ path, old_text: first, new_text: second },
			{ path, insert_line: 2, new_text: inserted },
		]);
		expect(result.status).toBe("completed");
		expect(await readFile(path, "utf8")).toBe(`${second}\n${inserted}`);
		expect(JSON.stringify(requests[0].tools)).toContain("32000");
		expect(JSON.stringify(requests[0].tools)).not.toContain("6000");
		expect(JSON.stringify(requests[3].messages)).not.toContain('"success":false');
	});

	it("rejects both oversized old and new fields without modifying the file", async () => {
		const path = join(cwd, "file");
		await writeFile(path, "original");
		const { requests } = await run(cwd, [
			{ path, old_text: "original", new_text: "x".repeat(32001) },
			{ path, old_text: "x".repeat(32001), new_text: "small" },
		]);
		expect(await readFile(path, "utf8")).toBe("original");
		expect(JSON.stringify(requests[2].messages)).toContain("Split the edit into smaller sequential calls");
	});

	it("accepts the exact new limit", async () => {
		const path = join(cwd, "boundary");
		await run(cwd, [{ path, new_text: "x".repeat(32000) }]);
		expect((await readFile(path, "utf8")).length).toBe(32000);
	});

	it.each([
		{ input: { old_text: "missing", new_text: "new" }, expected: "copy an exact, unique old_text anchor" },
		{ input: { new_text: "new" }, expected: "include an explicit old_text string" },
		{ input: { insert_line: 99, new_text: "new" }, expected: "line_count + 1" },
	])("puts original error and targeted guidance in the next model request: $expected", async ({ input, expected }) => {
		const path = join(cwd, "file");
		await writeFile(path, "original");
		const { requests, result } = await run(cwd, [{ path, ...input }]);
		expect(result.status).toBe("completed");
		const toolResults = requests[1].messages
			.flatMap((message) => message.content)
			.filter((part) => part.type === "tool-result");
		expect(toolResults).toHaveLength(1);
		expect(JSON.stringify(toolResults)).toContain(expected);
		expect(JSON.stringify(toolResults)).toContain("Editor operation failed:");
		expect(await readFile(path, "utf8")).toBe("original");
	});

	it("warns on an identical failed retry, then accepts a fresh corrected anchor", async () => {
		const path = join(cwd, "file");
		await writeFile(path, "original");
		const bad = { path, old_text: "missing", new_text: "replacement" };
		const { requests, result } = await run(cwd, [bad, bad, { path, old_text: "original", new_text: "replacement" }]);
		expect(result.status).toBe("completed");
		expect(JSON.stringify(requests[2].messages)).toContain("This exact editor call already failed");
		expect(await readFile(path, "utf8")).toBe("replacement");
	});

	it("retains unique matching and missing old_text checks for large edits", async () => {
		const path = join(cwd, "file");
		await writeFile(path, "same same");
		const { requests } = await run(cwd, [
			{ path, new_text: "x".repeat(7000) },
			{ path, old_text: "same", new_text: "x".repeat(7000) },
		]);
		expect(await readFile(path, "utf8")).toBe("same same");
		expect(JSON.stringify(requests[2].messages)).toContain("old_text");
		expect(JSON.stringify(requests[2].messages)).toContain("multiple");
		expect(JSON.stringify(requests[2].messages)).toContain("Do not repeat the ambiguous anchor");
	});
});
