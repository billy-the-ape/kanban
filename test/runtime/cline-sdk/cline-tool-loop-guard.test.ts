import { type AgentModel, AgentRuntime, type AgentTool } from "@clinebot/agents";
import { describe, expect, it } from "vitest";
import { createClineToolLoopGuard } from "../../../src/cline-sdk/cline-tool-loop-guard";

async function runCalls(
	name: string,
	inputs: unknown[],
	options: { running?: boolean; output?: unknown; fail?: boolean } = {},
) {
	let iteration = 0;
	const model: AgentModel = {
		async *stream() {
			if (iteration < inputs.length) {
				yield {
					type: "tool-call-delta",
					toolCallId: `call-${iteration}`,
					toolName: name,
					inputText: JSON.stringify(inputs[iteration++]),
				};
				yield { type: "finish", reason: "tool-calls" };
			} else {
				yield { type: "text-delta", text: "Done" };
				yield { type: "finish", reason: "stop" };
			}
		},
	};
	const tool: AgentTool = {
		name,
		description: "test",
		inputSchema: { type: "object" },
		execute: async () => {
			if (options.fail) throw new Error("observation failed");
			return options.output ?? { status: "running", progress: iteration };
		},
	};
	const runtime = new AgentRuntime({
		model,
		tools: [tool],
		hooks: createClineToolLoopGuard((jobId) => Boolean(options.running) && jobId === "owned"),
	});
	return { runtime, result: await runtime.run("Start") };
}

describe("polling-aware loop guard (real SDK agent loop)", () => {
	it.each(["status", "wait", "read"])("allows repeated successful %s of an owned running job", async (action) => {
		const { result } = await runCalls("validation_job", Array(8).fill({ action, jobId: "owned" }), { running: true });
		expect(result.status).toBe("completed");
		expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(8);
	});
	it.each([
		["run_commands", { commands: ["sleep 1"] }, { running: true }],
		["editor", { path: "file", new_text: "x" }, {}],
		["validation_job", { action: "start", command: "npm" }, { running: true }],
		["validation_job", { action: "cancel", jobId: "owned" }, { running: true }],
		["validation_job", { action: "status", jobId: "foreign" }, { running: true }],
		["validation_job", { action: "status", jobId: "owned" }, { running: false }],
		["validation_job", { action: "status", jobId: "owned" }, { running: true, fail: true }],
		[
			"validation_job",
			{ action: "read", jobId: "owned" },
			{ running: true, output: { isError: true, content: "failed" } },
		],
	] as const)("keeps loop protection for %s %j %j", async (name, input, options) => {
		const { result } = await runCalls(name, Array(8).fill(input), options);
		expect(result.status).toBe("failed");
		expect(result.error?.message).toContain("5 consecutive identical calls");
		// Even the last call keeps its paired result in the transcript.
		expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(5);
		expect(JSON.stringify(result.messages)).toContain("3 consecutive identical calls");
	});
	it("compares JSON objects independent of property order and resets on a new turn", async () => {
		const inputs = Array.from({ length: 5 }, (_, i) => (i % 2 ? { b: 2, a: 1 } : { a: 1, b: 2 }));
		const { runtime, result } = await runCalls("read_files", inputs);
		expect(result.status).toBe("failed");
		expect((await runtime.run("Try another turn")).status).toBe("completed");
	});
	it("resets the streak when arguments change", async () => {
		const inputs = Array.from({ length: 8 }, (_, offset) => ({ path: "file", offset }));
		expect((await runCalls("read_files", inputs)).result.status).toBe("completed");
	});
});
