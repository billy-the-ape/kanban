// PRLINK-2: hook-CLI-side PR detection. Only canonical URLs are extracted
// from the agent's hook payload — raw tool output never crosses the wire.
import { describe, expect, it } from "vitest";

import { extractHookPullRequestUrls, extractPiPublicationTool } from "../../src/commands/hooks";

describe("extractHookPullRequestUrls", () => {
	it("detects a PR created via gh in a Claude-style Bash payload", () => {
		const urls = extractHookPullRequestUrls({
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "gh pr create --title 'Fix' --body-file PR.md" },
			tool_response: {
				stdout: "https://github.com/o/r/pull/7",
				stderr: "",
			},
		});
		expect(urls).toEqual(["https://github.com/o/r/pull/7"]);
	});

	it("detects a PR when tool_response is a plain string", () => {
		const urls = extractHookPullRequestUrls({
			tool_name: "Bash",
			tool_input: { command: "gh pr create" },
			tool_response: "https://github.com/o/r/pull/9#discussion_r1",
		});
		expect(urls).toEqual(["https://github.com/o/r/pull/9"]);
	});

	it("does not attach PRs to a gh pr view command even when the output has a PR URL", () => {
		const urls = extractHookPullRequestUrls({
			tool_name: "Bash",
			tool_input: { command: "gh pr view 205 --json url" },
			tool_response: { stdout: "https://github.com/o/r/pull/205", stderr: "" },
		});
		expect(urls).toBeUndefined();
	});

	it("returns undefined when the payload has no tool_response (never throws)", () => {
		expect(
			extractHookPullRequestUrls({
				tool_name: "Bash",
				tool_input: { command: "gh pr create" },
			}),
		).toBeUndefined();
	});

	it("detects PRs from an MCP create_pull_request tool with structured html_url output", () => {
		const urls = extractHookPullRequestUrls({
			hook_event_name: "PostToolUse",
			tool_name: "mcp__github__create_pull_request",
			tool_input: { title: "Fix" },
			tool_response: {
				html_url: "https://github.com/o/r/pull/12",
				number: 12,
			},
		});
		expect(urls).toEqual(["https://github.com/o/r/pull/12"]);
	});

	it("caps the result at 10 URLs", () => {
		const manyLinks = Array.from({ length: 12 }, (_, index) => `https://github.com/o/r/pull/${index + 1}`).join("\n");
		const chainedCreate = Array.from({ length: 12 }, () => "gh pr create").join(" && ");
		const urls = extractHookPullRequestUrls({
			tool_name: "Bash",
			tool_input: { command: chainedCreate },
			tool_response: { stdout: manyLinks, stderr: "" },
		});
		expect(urls).toHaveLength(10);
		expect(urls?.[0]).toBe("https://github.com/o/r/pull/1");
		expect(urls?.[9]).toBe("https://github.com/o/r/pull/10");
	});

	it("returns undefined for a null payload", () => {
		expect(extractHookPullRequestUrls(null)).toBeUndefined();
	});

	it("returns undefined when the tool output is empty and the command is not PR-creating", () => {
		expect(
			extractHookPullRequestUrls({
				tool_name: "Bash",
				tool_input: { command: "git status" },
				tool_response: { stdout: "", stderr: "" },
			}),
		).toBeUndefined();
	});
});

describe("extractPiPublicationTool", () => {
	it("captures Pi's attributed gh comment write with its tool call id", () => {
		const event = extractPiPublicationTool({
			hook_event_name: "tool_execution_end",
			tool_name: "bash",
			tool_call_id: "call-42",
			tool_input: { command: "gh pr comment 42 --repo octo/repo --body 'Addressed'" },
			tool_response: { output: "https://github.com/octo/repo/pull/42#issuecomment-51" },
			tool_is_error: false,
		}, "pi");
		expect(event).toMatchObject({
			phase: "finished",
			toolCallId: "call-42",
			toolName: "bash",
			commands: ["gh pr comment 42 --repo octo/repo --body 'Addressed'"],
			output: "https://github.com/octo/repo/pull/42#issuecomment-51",
			error: null,
		});
	});

	it("ignores ordinary Pi commands and read-only GitHub operations", () => {
		for (const command of ["git status --short", "npm test", "gh pr view 42 --json comments"]) {
			expect(extractPiPublicationTool({
				hook_event_name: "tool_execution_end",
				tool_name: "bash",
				tool_input: { command },
				tool_response: { output: "https://github.com/octo/repo/pull/42" },
			}, "pi")).toBeUndefined();
		}
	});

	it("ignores non-Pi tool events and preserves failure evidence", () => {
		const payload = {
			hook_event_name: "tool_execution_end",
			tool_name: "bash",
			tool_input: { command: "gh pr comment 42 --body 'retry'" },
			tool_response: { output: "HTTP 403" },
			tool_is_error: true,
		};
		expect(extractPiPublicationTool(payload, "cline")).toBeUndefined();
		expect(extractPiPublicationTool(payload, "pi")?.error).toBe("HTTP 403");
	});
});
