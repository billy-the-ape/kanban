import { describe, expect, it } from "vitest";

import { detectCreatedPullRequests } from "../../../src/core/pull-request-detection";

const GH_PR_URL = "https://github.com/owner/repo/pull/12";
const GLAB_MR_URL = "https://gitlab.com/group/project/-/merge_requests/7";

describe("detectCreatedPullRequests", () => {
	it("extracts the PR URL from a successful gh pr create", () => {
		const links = detectCreatedPullRequests({
			toolName: "run_commands",
			commands: ["gh pr create --title 'Fix' --body 'x'"],
			output: `Creating pull request\n${GH_PR_URL}`,
		});
		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe(GH_PR_URL);
	});

	it("accepts the existing-PR stderr form from gh pr create", () => {
		const links = detectCreatedPullRequests({
			toolName: "bash",
			commands: ["gh pr create"],
			output: `A pull request for branch feature already exists:\n${GH_PR_URL}`,
		});
		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe(GH_PR_URL);
	});

	it("gates on chained commands with a cd prefix", () => {
		const links = detectCreatedPullRequests({
			toolName: "run_commands",
			commands: ["cd repo && gh pr create --body-file notes.md"],
			output: GH_PR_URL,
		});
		expect(links).toHaveLength(1);
	});

	it("tolerates leading environment assignments", () => {
		const links = detectCreatedPullRequests({
			toolName: "run_commands",
			commands: ["GH_TOKEN_MODE=1 gh pr create"],
			output: GH_PR_URL,
		});
		expect(links).toHaveLength(1);
	});

	it("returns links from output only, never from command text", () => {
		const links = detectCreatedPullRequests({
			toolName: "run_commands",
			commands: ["echo https://github.com/owner/repo/pull/99"],
			output: "no urls here",
		});
		expect(links).toEqual([]);
	});

	it("does not adopt PRs read by gh pr view", () => {
		const links = detectCreatedPullRequests({
			toolName: "run_commands",
			commands: ["gh pr view 205"],
			output: `https://github.com/owner/repo/pull/205\nTitle: something`,
		});
		expect(links).toEqual([]);
	});

	it("ignores gh pr list / gh pr comment output", () => {
		for (const command of ["gh pr list --state open", "gh pr comment 12 --body hi"]) {
			expect(
				detectCreatedPullRequests({
					toolName: "run_commands",
					commands: [command],
					output: GH_PR_URL,
				}),
			).toEqual([]);
		}
	});

	it("ignores plain git push output containing /pull/new/ hints", () => {
		const links = detectCreatedPullRequests({
			toolName: "run_commands",
			commands: ["git push origin feature"],
			output: "remote: https://github.com/owner/repo/pull/new/feature",
		});
		expect(links).toEqual([]);
	});

	it("gates on git push -o merge_request.create with a GitLab MR URL", () => {
		const links = detectCreatedPullRequests({
			toolName: "run_commands",
			commands: ["git push -o merge_request.create origin feature"],
			output: `remote: View merge request at ${GLAB_MR_URL}`,
		});
		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe(GLAB_MR_URL);
	});

	it("does not gate on git push with other push options", () => {
		const links = detectCreatedPullRequests({
			toolName: "run_commands",
			commands: ["git push -o ci.skip origin feature"],
			output: GLAB_MR_URL,
		});
		expect(links).toEqual([]);
	});

	it("parses html_url from structured MCP output", () => {
		const links = detectCreatedPullRequests({
			toolName: "mcp__github__create_pull_request",
			commands: [],
			output: JSON.stringify({ number: 33, html_url: "https://github.com/owner/repo/pull/33" }),
		});
		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe("https://github.com/owner/repo/pull/33");
	});

	it("parses web_url from stringified nested MCP JSON", () => {
		const links = detectCreatedPullRequests({
			toolName: "mcp__gitlab__create_merge_request",
			commands: [],
			output: JSON.stringify({ result: { web_url: "https://gitlab.com/g/p/-/merge_requests/8" } }),
		});
		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe("https://gitlab.com/g/p/-/merge_requests/8");
	});

	it("falls back to URL scanning for non-JSON MCP output", () => {
		const links = detectCreatedPullRequests({
			toolName: "mcp__github__create_pull_request",
			commands: [],
			output: `Done: ${GH_PR_URL}`,
		});
		expect(links).toHaveLength(1);
	});

	it("returns empty for non-creating tool names and empty input", () => {
		expect(detectCreatedPullRequests({ toolName: null, commands: [], output: GH_PR_URL })).toEqual([]);
		expect(
			detectCreatedPullRequests({
				toolName: "run_commands",
				commands: [],
				output: null,
			}),
		).toEqual([]);
	});
});
