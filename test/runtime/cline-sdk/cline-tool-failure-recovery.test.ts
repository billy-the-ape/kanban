import { type AgentModel, type AgentModelRequest, AgentRuntime, type AgentTool } from "@clinebot/agents";
import { describe, expect, it, vi } from "vitest";
import {
	createClineToolFailureRecoveryHooks,
	isClineToolTimeout,
	readClineToolFailure,
} from "../../../src/cline-sdk/cline-tool-failure-recovery";

/** Real SDK timeout shapes (see TIMEOUT_LINE_PATTERNS). */
const READ_TIMEOUT = "Error reading file: File read timed out after 30000ms";
const COMMAND_TIMEOUT = "Command failed: Command timed out after 30000ms";

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
			.mockResolvedValueOnce([{ success: false, error: READ_TIMEOUT }])
			.mockResolvedValueOnce([{ success: true, result: "contents" }]);
		const { runtime, requests } = harness("read_files", execute);
		expect((await runtime.run("Start")).status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(2);
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1].messages)).not.toContain("failed twice");
	});

	it("gives the model the call details after two timeouts and stops when the retried call times out again", async () => {
		const execute = vi.fn().mockRejectedValue(new Error(READ_TIMEOUT));
		const { runtime, requests } = harness("read_files", execute, [["read_files"], ["read_files"]]);
		const result = await runtime.run("Start");
		expect(execute).toHaveBeenCalledTimes(3);
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1].messages)).toContain("timed out twice");
		expect(JSON.stringify(requests[1].messages)).toContain(READ_TIMEOUT);
		expect(result.status).toBe("failed");
		expect(result.error?.message).toContain("timed out again after one retry");
		expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(2);
	});

	it("does not blindly replay a command timeout, but resumes the model with verification guidance", async () => {
		const execute = vi.fn().mockResolvedValue([{ success: false, error: COMMAND_TIMEOUT }]);
		const { runtime, requests } = harness("run_commands", execute);
		expect((await runtime.run("Create PR")).status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(requests[1].messages)).toContain("check whether it already succeeded");
		expect(JSON.stringify(requests[1].messages)).toContain("gh pr create");
	});

	it("passes model-fixable errors straight through without replay, repair budget or run failure", async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce({ error: "Editor input too large: new_text was 11721 characters ... or time out." })
			.mockRejectedValueOnce(new Error("old_text not found"))
			.mockResolvedValueOnce({ error: "Invalid file range" })
			.mockResolvedValueOnce({ ok: true });
		const { runtime, requests } = harness("read_files", execute, [
			["read_files"],
			["read_files"],
			["read_files"],
			["read_files"],
		]);
		const result = await runtime.run("Edit");
		expect(result.status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(4);
		expect(requests).toHaveLength(5);
		const transcript = JSON.stringify(requests[4].messages);
		expect(transcript).toContain("Editor input too large");
		expect(transcript).toContain("old_text not found");
		expect(transcript).not.toContain("recovery");
		expect(transcript).not.toContain("repair opportunity");
	});

	it("allows the retried call to succeed and re-arms the strike for later timeouts of the same call", async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce({ error: COMMAND_TIMEOUT })
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ error: COMMAND_TIMEOUT })
			.mockResolvedValueOnce({ ok: true });
		const { runtime } = harness("run_commands", execute, [
			["run_commands"],
			["run_commands"],
			["run_commands"],
			["run_commands"],
		]);
		expect((await runtime.run("Run")).status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(4);
	});

	it("classifies only the SDK's own timeout shapes as timeouts", () => {
		for (const timeout of [
			"Command failed: Command timed out after 30000ms",
			"Error reading file: File read timed out after 30000ms",
			"Search failed: Search timed out after 30000ms",
			"Error fetching web content: Request timed out after 1500ms",
			"Editor operation failed: Editor operation timed out after 30000ms",
			"Error fetching web content: HTTP 504: Gateway Time-out",
			"Error fetching web content: HTTP 408: ",
			'MCP server "browser" failed: MCP error -32001: Request timed out',
			'MCP request timed out for "browser" (tools/call).',
			"Invalid file range: 3\nError reading file: File read timed out after 30000ms",
		]) {
			expect(isClineToolTimeout(timeout), timeout).toBe(true);
		}
		for (const notTimeout of [
			"Editor input too large: new_text was 11721 characters ... less likely to be truncated or time out.",
			"Command failed: Error: Test timed out in 5000ms",
			"Command failed: timeout: invalid time interval 'foo'",
			"Command failed: fatal: unrecognized argument: --timeout=5",
			"Command failed:     at Timeout._onTimeout (/repo/node_modules/p-timeout/index.js:12:3)",
			"Error reading file: ENOENT: no such file or directory, stat '/repo/src/utils/timeout.ts'",
			"No replacement performed: text not found in /tmp/zz-timeout.ts.",
			"Search failed: Invalid regex pattern: timeout(",
			"Error fetching web content: Invalid URL: not a url timeout",
			'MCP server "timeout-proxy" failed: Invalid arguments: timeout must be <= 600000',
			"User denied: do not set a timeout on this",
			"Tool timed out again after one retry.\nTool: read_files",
			"Error fetching web content: HTTP 500: Internal Server Error",
			"Error fetching web content: fetch failed",
		]) {
			expect(isClineToolTimeout(notTimeout), notTimeout).toBe(false);
		}
		expect(isClineToolTimeout(null)).toBe(false);
	});

	it("does not replay or recover errors that merely mention a timeout", async () => {
		const execute = vi
			.fn()
			.mockRejectedValueOnce(new Error("ENOENT: no such file or directory, stat '/repo/src/utils/timeout.ts'"))
			.mockResolvedValueOnce({ ok: true });
		const { runtime, requests } = harness("read_files", execute, [["read_files"], ["read_files"]]);
		expect((await runtime.run("Read")).status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(requests[1].messages)).not.toContain("timed out");
	});

	it("ends the run when the same call fails the same way three times in a row", async () => {
		const execute = vi.fn().mockRejectedValue(new Error("Invalid file range: 3"));
		const { runtime, requests } = harness("read_files", execute, [["read_files"], ["read_files"], ["read_files"]]);
		const result = await runtime.run("Read");
		expect(execute).toHaveBeenCalledTimes(3);
		expect(requests).toHaveLength(3);
		expect(result.status).toBe("failed");
		expect(result.error?.message).toContain("failed 3 times in a row with the same error");
		expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(3);
	});

	it("resets the repeated-failure count whenever a tool call succeeds", async () => {
		const execute = vi
			.fn()
			.mockRejectedValueOnce(new Error("Invalid file range: 3"))
			.mockRejectedValueOnce(new Error("Invalid file range: 3"))
			.mockResolvedValueOnce({ ok: true })
			.mockRejectedValueOnce(new Error("Invalid file range: 3"))
			.mockRejectedValueOnce(new Error("Invalid file range: 3"))
			.mockResolvedValueOnce({ ok: true });
		const { runtime } = harness(
			"read_files",
			execute,
			Array.from({ length: 6 }, () => ["read_files"]),
		);
		expect((await runtime.run("Read")).status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(6);
	});

	it("does not count failures with different errors toward the repeated-failure limit", async () => {
		const execute = vi
			.fn()
			.mockRejectedValueOnce(new Error("Invalid file range: 3"))
			.mockRejectedValueOnce(new Error("old_text not found"))
			.mockRejectedValueOnce(new Error("Invalid file range: 3"))
			.mockResolvedValueOnce({ ok: true });
		const { runtime } = harness(
			"editor",
			execute,
			Array.from({ length: 4 }, () => ["editor"]),
		);
		expect((await runtime.run("Edit")).status).toBe("completed");
	});

	it("permits a successful model repair", async () => {
		const execute = vi.fn().mockResolvedValueOnce({ error: "bad input" }).mockResolvedValueOnce({ ok: true });
		const { runtime } = harness("editor", execute, [["editor"], ["editor"]]);
		expect((await runtime.run("Fix")).status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("does not strike twice for identical timeouts in the same batch", async () => {
		const execute = vi.fn().mockResolvedValue({ error: READ_TIMEOUT });
		const { runtime, requests } = harness("read_files", execute, [["read_files", "read_files"]]);
		expect((await runtime.run("Read")).status).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(4);
		expect(requests).toHaveLength(2);
	});

	it("lets the model see and repair unknown tool calls", async () => {
		const { runtime, requests } = harness("read_files", vi.fn(), [["missing"], ["missing"]]);
		const result = await runtime.run("Start");
		expect(requests).toHaveLength(3);
		expect(JSON.stringify(requests[1].messages)).toContain("Unknown tool");
		expect(result.status).toBe("completed");
	});

	it("does not bypass rejected tool approvals", async () => {
		const execute = vi.fn();
		let calls = 0;
		const tool: AgentTool = { name: "read_files", description: "Test", inputSchema: {}, execute };
		const model: AgentModel = {
			async *stream() {
				if (calls++ === 0) {
					yield { type: "tool-call-delta", toolCallId: "denied", toolName: "read_files", inputText: "{}" };
					yield { type: "finish", reason: "tool-calls" };
					return;
				}
				yield { type: "text-delta", text: "Done" };
				yield { type: "finish", reason: "stop" };
			},
		};
		const runtime = new AgentRuntime({
			model,
			tools: [tool],
			hooks: createClineToolFailureRecoveryHooks(),
			toolPolicies: { read_files: { autoApprove: false } },
			requestToolApproval: async () => ({ approved: false, reason: "Denied" }),
		});
		await runtime.run("Start");
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
		const execute = vi.fn().mockResolvedValue({ error: READ_TIMEOUT });
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
