import { type AgentModel, type AgentModelRequest, AgentRuntime, type AgentTool } from "@clinebot/agents";
import { describe, expect, it, vi } from "vitest";
import {
	createClineToolFailureRecoveryHooks,
	readClineToolFailure,
} from "../../../src/cline-sdk/cline-tool-failure-recovery";

function harness(toolName: string, execute: AgentTool["execute"], calls: string[][] = [[toolName]]) {
	const requests: AgentModelRequest[] = [];
	let iteration = 0;
	const model: AgentModel = {
		async *stream(request) {
			requests.push(request);
			const names = calls[iteration++];
			if (!names) {
				yield { type: "text-delta", text: "Done" };
				yield { type: "finish", reason: "stop" };
				return;
			}
			for (const [index, name] of names.entries()) {
				yield {
					type: "tool-call-delta",
					toolCallId: `call-${iteration}-${index}`,
					toolName: name,
					inputText: '{"commands":["gh pr create"]}',
				};
			}
			yield { type: "finish", reason: "tool-calls" };
		},
	};
	const tool: AgentTool = { name: toolName, description: "Test", inputSchema: { type: "object" }, execute };
	const runtime = new AgentRuntime({ model, tools: [tool], hooks: createClineToolFailureRecoveryHooks() });
	return { runtime, requests };
}

describe("bounded Cline tool recovery (real SDK agent loop)", () => {
	it("retries structured read errors once without consulting the model", async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce([{ success: false, error: "Read timed out" }])
			.mockResolvedValueOnce([{ success: true, result: "contents" }]);
		const { runtime, requests } = harness("read_files", execute);
		expect((await runtime.run("Start")).status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(2);
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1].messages)).not.toContain("failed twice");
	});

	it("gives the model the call details after two failures and stops on the repaired call's failure", async () => {
		const execute = vi.fn().mockRejectedValue(new Error("Invalid file range"));
		const { runtime, requests } = harness("read_files", execute, [["read_files"], ["read_files"]]);
		const result = await runtime.run("Start");
		expect(execute).toHaveBeenCalledTimes(3);
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1].messages)).toContain("failed twice");
		expect(JSON.stringify(requests[1].messages)).toContain("Invalid file range");
		expect(result.status).toBe("failed");
		expect(result.error?.message).toContain("Tool recovery exhausted");
		expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(2);
	});

	it("does not blindly replay a command timeout, but resumes the model with verification guidance", async () => {
		const execute = vi
			.fn()
			.mockResolvedValue([{ success: false, error: "Command failed: Command timed out after 30000ms" }]);
		const { runtime, requests } = harness("run_commands", execute);
		expect((await runtime.run("Create PR")).status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(requests[1].messages)).toContain("check whether it already succeeded");
		expect(JSON.stringify(requests[1].messages)).toContain("gh pr create");
	});

	it("permits a successful model repair", async () => {
		const execute = vi.fn().mockResolvedValueOnce({ error: "bad input" }).mockResolvedValueOnce({ ok: true });
		const { runtime } = harness("editor", execute, [["editor"], ["editor"]]);
		expect((await runtime.run("Fix")).status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("does not consume the model repair on multiple failures in the same batch", async () => {
		const execute = vi.fn().mockResolvedValue({ error: "timeout" });
		const { runtime, requests } = harness("read_files", execute, [["read_files", "read_files"]]);
		expect((await runtime.run("Read")).status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(4);
		expect(requests).toHaveLength(2);
	});

	it("handles unknown tools that bypass tool hooks", async () => {
		const { runtime, requests } = harness("read_files", vi.fn(), [["missing"], ["missing"]]);
		const result = await runtime.run("Start");
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1].messages)).toContain("Unknown tool");
		expect(result.status).toBe("failed");
	});

	it("does not bypass rejected tool approvals", async () => {
		const execute = vi.fn();
		const tool: AgentTool = { name: "read_files", description: "Test", inputSchema: {}, execute };
		const model: AgentModel = {
			async *stream() {
				yield { type: "tool-call-delta", toolCallId: "denied", toolName: "read_files", inputText: "{}" };
				yield { type: "finish", reason: "tool-calls" };
			},
		};
		const runtime = new AgentRuntime({
			model,
			tools: [tool],
			hooks: createClineToolFailureRecoveryHooks(),
			toolPolicies: { read_files: { autoApprove: false } },
			requestToolApproval: async () => ({ approved: false, reason: "Denied" }),
		});
		expect((await runtime.run("Start")).status).toBe("failed");
		expect(execute).not.toHaveBeenCalled();
	});

	it("does not retry cancellation", async () => {
		let runtime: AgentRuntime;
		const execute = vi.fn(async () => {
			runtime.abort();
			throw new Error("Canceled");
		});
		({ runtime } = harness("read_files", execute));
		expect((await runtime.run("Start")).status).toBe("aborted");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("resets the budget on a new user turn without stacking wrappers", async () => {
		const execute = vi.fn().mockResolvedValue({ error: "timeout" });
		const { runtime } = harness("read_files", execute, [
			["read_files"],
			["read_files"],
			["read_files"],
			["read_files"],
		]);
		expect((await runtime.run("Start")).status).toBe("failed");
		expect((await runtime.run("Try again")).status).toBe("failed");
		expect(execute).toHaveBeenCalledTimes(6);
	});

	it("ignores no-match search results, test failures in output, and detects MCP error envelopes", () => {
		expect(readClineToolFailure([{ success: false, result: "No results found" }])).toBeNull();
		expect(readClineToolFailure([{ success: true, result: "Exit code: 1\nTests failed" }])).toBeNull();
		expect(readClineToolFailure({ isError: true, content: [{ type: "text", text: "MCP unavailable" }] })).toContain(
			"MCP unavailable",
		);
	});
});
