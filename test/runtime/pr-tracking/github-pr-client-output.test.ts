import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubPrClient } from "../../../src/pr-tracking/github-pr-client";
import { runGhCommand } from "../../../src/workspace/git-delivery";
import { isolateTestEnvironment } from "../../utilities/test-environment";

// Exercise real execFile buffering, not a fake command result that bypasses
// Node's output limit. The fixture never contacts GitHub or reads credentials.
describe.skipIf(process.platform === "win32")("comment fetch subprocess output bounds", () => {
	let env: ReturnType<typeof isolateTestEnvironment>;
	let cwd: string;

	beforeEach(async () => {
		env = isolateTestEnvironment();
		cwd = env.home;
		const bin = join(cwd, "bin");
		await mkdir(bin);
		await writeFile(
			join(bin, "gh"),
			`#!/usr/bin/env node
const args = process.argv.slice(2);
const path = args[args.indexOf('--hostname') + 2];
let response;
if (args[1] === 'graphql') {
  response = {data: {repository: {pullRequest: {reviewThreads: {
    pageInfo: {hasNextPage: false, endCursor: null}, nodes: []
  }}}}};
} else if (path.includes('/pulls/42/comments')) {
  response = [{id: 1, body: 'Fix this', updated_at: '2026-11-17T00:00:00Z',
    diff_hunk: 'x'.repeat(Number(process.env.KANBAN_TEST_COMMENT_MIB) * 1024 * 1024)}];
} else if (path.includes('?')) {
  response = [];
} else {
  response = {state: 'open', head: {sha: 'abc'}, html_url: 'https://github.com/octo/repo/pull/42'};
}
process.stdout.write(JSON.stringify(response));
`,
			{ mode: 0o755 },
		);
		vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
		vi.stubEnv("KANBAN_TEST_COMMENT_MIB", "6");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		env.cleanup();
	});

	const pr = { host: "github.com", repository: "octo/repo", number: 42 };
	const client = () => createGitHubPrClient({ accessScopeResolver: async () => "fixture" });

	it("reads a 6 MiB inline page without losing feedback or diff context", async () => {
		const snapshot = await client().fetchSnapshot(pr, cwd, "fixture");
		expect(snapshot.complete).toBe(true);
		expect(snapshot.error).toBeUndefined();
		expect(snapshot.events).toHaveLength(1);
		expect(snapshot.events[0]?.body).toBe("Fix this");
		expect(snapshot.events[0]?.diffHunk).toHaveLength(6 * 1024 * 1024);
	});

	it("keeps unrelated gh operations at their existing 1 MiB bound and preserves overflow details", async () => {
		const result = await runGhCommand(
			["api", "--hostname", "github.com", "repos/octo/repo/pulls/42/comments?per_page=100&page=1"],
			cwd,
			30_000,
		);
		expect(result.ok).toBe(false);
		expect(result.stderr).toContain("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
	});

	it("rejects pages above 8 MiB with an actionable source error and no eligible partial feedback", async () => {
		vi.stubEnv("KANBAN_TEST_COMMENT_MIB", "9");
		const snapshot = await client().fetchSnapshot(pr, cwd, "fixture");
		expect(snapshot.complete).toBe(false);
		expect(snapshot.error).toContain("pulls/42/comments page 1");
		expect(snapshot.error).toContain("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
		expect(snapshot.events).toEqual([]);
	});
});
