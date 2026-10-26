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
	const recovery = createClineToolFailureRecoveryHooks(cwd);
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
		{ input: { old_text: "missing", new_text: "new" }, expected: "No nearby candidate could be located" },
		{ input: { new_text: "new" }, expected: "missing old_text" },
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
		expect(JSON.stringify(requests[2].messages)).toContain("This repeats the earlier failed arguments");
		expect(await readFile(path, "utf8")).toBe("replacement");
	});

	it("attaches bounded current-source evidence for a wrong tab count without modifying the file", async () => {
		const path = join(cwd, "target.ts");
		const source = "line one\n\t\tindented = true;\nline three\n";
		await writeFile(path, source);
		// The model submits three TABs; the source line has two.
		const { requests, result } = await run(cwd, [
			{ path, old_text: "\t\t\tindented = true;", new_text: "indented = true;" },
		]);
		expect(result.status).toBe("completed");
		const toolResults = requests[1].messages
			.flatMap((message) => message.content)
			.filter((part) => part.type === "tool-result");
		const transcript = JSON.stringify(toolResults);
		expect(transcript).toContain("Editor operation failed:");
		expect(transcript).toContain("matched 0 times in the current file");
		expect(transcript).toContain('"evidence"');
		expect(transcript).toContain("diagnostic evidence, not an automatically corrected anchor");
		expect(transcript).toContain("submitted line 1 begins with 3 TAB character(s)");
		expect(transcript).toContain("candidate line 2 begins with 2 TAB character(s)");
		// The evidence window carries the current source line for correction.
		expect(transcript).toContain("indented = true;");
		// The failed call never modified the file.
		expect(await readFile(path, "utf8")).toBe(source);
	});

	it("keeps the three-failure guard for identical failed editor calls", async () => {
		const path = join(cwd, "file");
		await writeFile(path, "original");
		const bad = { path, old_text: "missing", new_text: "replacement" };
		const { requests, result } = await run(cwd, [bad, bad, bad]);
		expect(result.status).toBe("failed");
		expect(result.error?.message).toContain("failed 3 times in a row with the same error");
		expect(requests).toHaveLength(3);
		expect(await readFile(path, "utf8")).toBe("original");
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
		expect(JSON.stringify(requests[2].messages)).toContain("matched 2 times");
		expect(JSON.stringify(requests[2].messages)).toContain("Do not repeat the ambiguous anchor");
	});
});
