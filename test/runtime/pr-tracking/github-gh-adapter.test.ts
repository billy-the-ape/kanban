import { describe, expect, it } from "vitest";
import type { GitHubPrNormalizedFeedbackEvent } from "../../../src/core/api-contract";
import {
	type AccessScope,
	createGitHubGhAdapter,
	createNonInteractiveGhEnv,
	GH_API_MAX_BUFFER_BYTES,
	GH_API_TIMEOUT_MS,
	type GhAdapterFailureCategory,
	type GhRunnerCommandResult,
	type GitHubGhAdapterOptions,
} from "../../../src/pr-tracking/github-gh-adapter";
import { normalizeReviews } from "../../../src/pr-tracking/pr-snapshots";

const NOW = 1_700_000_000_000;

interface ScriptedCall {
	args: string[];
	cwd: string;
}

interface ScriptedResult {
	kind: "ok" | "stderr" | "missing" | "timeout" | "buffer";
	stdout?: string;
	stderr?: string;
}

function scriptRunner(
	results: ScriptedResult[],
	calls: ScriptedCall[],
): NonNullable<GitHubGhAdapterOptions["ghRunner"]> {
	let index = 0;
	return async (args: string[], cwd: string): Promise<GhRunnerCommandResult> => {
		calls.push({ args, cwd });
		const result = results[Math.min(index, results.length - 1)];
		index += 1;
		if (result.kind === "missing") {
			return { ok: false, stdout: "", stderr: "spawn gh ENOENT", exitCode: -1, missingBinary: true };
		}
		if (result.kind === "timeout") {
			return {
				ok: false,
				stdout: "",
				stderr: "request timed out",
				exitCode: -1,
				missingBinary: false,
				timeout: true,
			};
		}
		if (result.kind === "buffer") {
			return {
				ok: false,
				stdout: "",
				stderr: "stdout maxBuffer size exceeded",
				exitCode: -1,
				missingBinary: false,
				bufferBound: true,
			};
		}
		if (result.kind === "stderr") {
			return { ok: false, stdout: "", stderr: result.stderr ?? "", exitCode: 1, missingBinary: false };
		}
		return { ok: true, stdout: result.stdout ?? "{}", stderr: "", exitCode: 0, missingBinary: false };
	};
}

const SCOPE: AccessScope = { accessScopeId: "scope-1", login: "me", tokenSource: "GH_TOKEN" };
const PARSED = { provider: "github" as const, host: "github.com", repository: "cline/kanban", number: 49 };

function adapterFor(results: ScriptedResult[], calls: ScriptedCall[], options: GitHubGhAdapterOptions = {}) {
	return createGitHubGhAdapter({
		ghRunner: scriptRunner(results, calls),
		now: () => NOW,
		cwd: "/tmp/fake-repo",
		...options,
	});
}

describe("github-gh-adapter", () => {
	it("builds a noninteractive gh environment with prompt disabled", () => {
		const previous = process.env.GIT_DIR;
		process.env.GIT_DIR = "/bad";
		try {
			const env = createNonInteractiveGhEnv({ PATH: "/bin" });
			expect(env.GH_PROMPT_DISABLED).toBe("1");
			expect(env.GH_NO_PROMPT).toBe("1");
			expect(env.PATH).toBe("/bin");
			expect(env.GIT_DIR).toBeUndefined();
		} finally {
			if (previous === undefined) {
				delete process.env.GIT_DIR;
			} else {
				process.env.GIT_DIR = previous;
			}
		}
	});

	it("resolves the opaque access scope without persisting token material", async () => {
		const calls: ScriptedCall[] = [];
		const adapter = adapterFor(
			[{ kind: "ok", stdout: "gh is authenticated\nLogged in to github.com as me (GH_TOKEN)\n" }],
			calls,
		);
		const result = await adapter.resolveAccessScope();
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.scope.login).toBe("me");
		expect(result.scope.tokenSource).toBe("GH_TOKEN");
		expect(result.scope.accessScopeId).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(result.scope)).not.toContain("token-material-secret");
	});

	it("classifies missing gh and unauthenticated hosts as auth blockers", async () => {
		const calls: ScriptedCall[] = [];
		const missing = adapterFor([{ kind: "missing" }], calls);
		const missingResult = await missing.resolveAccessScope();
		expect(missingResult.ok).toBe(false);
		if (!missingResult.ok) {
			expect(missingResult.failure.category).toBe("auth");
		}

		const calls2: ScriptedCall[] = [];
		const unauth = adapterFor([{ kind: "stderr", stderr: "you must be logged in to a GitHub host" }], calls2);
		const unauthResult = await unauth.resolveAccessScope();
		expect(unauthResult.ok).toBe(false);
		if (!unauthResult.ok) {
			expect(unauthResult.failure.category).toBe("auth");
		}
	});

	it("reads PR metadata and returns nodeId plus normalized state", async () => {
		const calls: ScriptedCall[] = [];
		const adapter = adapterFor(
			[
				{
					kind: "ok",
					stdout: JSON.stringify({
						node_id: "PR_123",
						state: "open",
						draft: false,
						head: { sha: "abc123", ref: "feature" },
						base: { ref: "main" },
					}),
				},
			],
			calls,
		);
		const result = await adapter.readPrMetadata(PARSED, SCOPE);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") {
			return;
		}
		expect(result.nodeId).toBe("PR_123");
		expect(result.metadata.state).toBe("open");
		expect(result.metadata.accessScopeId).toBe("scope-1");
		expect(calls[0]?.args.slice(0, 3)).toEqual(["api", "--hostname", "github.com"]);
		expect(calls[0]?.args[3]).toBe("repos/cline/kanban/pulls/49");
	});

	it("keeps last state on unchanged conditional reads and refetches with fresh", async () => {
		const body = JSON.stringify({ node_id: "PR_123", state: "open", head: { sha: "abc" }, base: { ref: "main" } });
		const calls: ScriptedCall[] = [];
		const adapter = adapterFor([{ kind: "ok", stdout: body }], calls);
		const first = await adapter.readPrMetadata(PARSED, SCOPE);
		expect(first.kind).toBe("ok");
		const second = await adapter.readPrMetadata(PARSED, SCOPE);
		expect(second.kind).toBe("not_modified");
		const fresh = await adapter.readPrMetadata(PARSED, SCOPE, { fresh: true });
		expect(fresh.kind).toBe("ok");
	});

	it("paginates REST lists completely and normalizes every item", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => ({
			id: `a${i}`,
			user: { login: "human", type: "User" },
			body: `body ${i}`,
		}));
		const page2 = Array.from({ length: 40 }, (_, i) => ({
			id: `b${i}`,
			user: { login: "me", type: "User" },
			body: "",
		}));
		const calls: ScriptedCall[] = [];
		const adapter = adapterFor(
			[
				{ kind: "ok", stdout: JSON.stringify(page1) },
				{ kind: "ok", stdout: JSON.stringify(page2) },
			],
			calls,
		);
		const result = await adapter.readRestListSource(
			PARSED,
			SCOPE,
			"reviews",
			"repos/cline/kanban/pulls/49/reviews",
			normalizeReviews,
		);
		expect(result.kind).toBe("ok");
		expect(calls.map((call) => call.args[call.args.length - 1])).toEqual([
			"repos/cline/kanban/pulls/49/reviews?per_page=100&page=1",
			"repos/cline/kanban/pulls/49/reviews?per_page=100&page=2",
		]);
	});

	it("reports partial-page failures for mid-list errors and later 304s", async () => {
		const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` }));
		const noop = (_items: unknown[], _login: string): GitHubPrNormalizedFeedbackEvent[] => [];
		const calls: ScriptedCall[] = [];
		const adapter = adapterFor(
			[
				{ kind: "ok", stdout: JSON.stringify(fullPage) },
				{ kind: "stderr", stderr: "HTTP 404: Not Found" },
			],
			calls,
		);
		const result = await adapter.readRestListSource(PARSED, SCOPE, "reviews", "base", noop);
		expect(result.kind).toBe("failed");
		if (result.kind === "failed") {
			expect(result.failure.category).toBe("partial_page");
		}

		const calls2: ScriptedCall[] = [];
		const adapter2 = adapterFor(
			[
				{ kind: "ok", stdout: JSON.stringify(fullPage) },
				{ kind: "stderr", stderr: "HTTP 304 Not Modified" },
			],
			calls2,
		);
		const result2 = await adapter2.readRestListSource(PARSED, SCOPE, "reviews", "base", noop);
		expect(result2.kind).toBe("failed");
		if (result2.kind === "failed") {
			expect(result2.failure.category).toBe("partial_page");
		}
	});

	it("classifies 404, 401, timeout, and buffer-bound failures", async () => {
		const cases: Array<[ScriptedResult, GhAdapterFailureCategory]> = [
			[{ kind: "stderr", stderr: "HTTP 404: Not Found" }, "not_found"],
			[{ kind: "stderr", stderr: "HTTP 401: Bad credentials" }, "auth"],
			[{ kind: "timeout" }, "timeout"],
			[{ kind: "buffer" }, "buffer_bound"],
			[{ kind: "ok", stdout: "not json" }, "network"],
		];
		for (const [scripted, category] of cases) {
			const calls: ScriptedCall[] = [];
			const adapter = adapterFor([scripted], calls);
			const result = await adapter.readPrMetadata(PARSED, SCOPE);
			expect(result.kind).toBe("failed");
			if (result.kind === "failed") {
				expect(result.failure.category).toBe(category);
				expect(result.failure.at).toBe(NOW);
			}
		}
	});

	it("fetches the rate-limit reset deadline for 429 responses", async () => {
		const calls: ScriptedCall[] = [];
		const adapter = adapterFor(
			[
				{ kind: "stderr", stderr: "HTTP 429: rate limit exceeded" },
				{ kind: "ok", stdout: JSON.stringify({ resources: { core: { reset: Math.floor(NOW / 1000) + 1200 } } }) },
			],
			calls,
		);
		const result = await adapter.readPrMetadata(PARSED, SCOPE);
		expect(result.kind).toBe("failed");
		if (result.kind === "failed") {
			expect(result.failure.category).toBe("rate_limit");
			expect(result.failure.rateLimitResetAt).toBe(NOW + 1_200_000);
		}
		expect(calls.map((call) => call.args[call.args.length - 1])).toContain("rate_limit");
	});

	it("caps in-flight reads runtime-wide", async () => {
		const calls: ScriptedCall[] = [];
		let inFlight = 0;
		let observedMax = 0;
		const slow = async (args: string[], cwd: string): Promise<GhRunnerCommandResult> => {
			calls.push({ args, cwd });
			inFlight += 1;
			observedMax = Math.max(observedMax, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 20));
			inFlight -= 1;
			return {
				ok: true,
				stdout: JSON.stringify({ state: "open", head: { sha: "x" }, base: { ref: "main" } }),
				stderr: "",
				exitCode: 0,
				missingBinary: false,
			};
		};
		const adapter = createGitHubGhAdapter({
			ghRunner: slow,
			now: () => NOW,
			cwd: "/tmp/fake-repo",
			inFlightLimit: 2,
		});
		await Promise.all([
			adapter.readPrMetadata(PARSED, SCOPE),
			adapter.readPrMetadata({ ...PARSED, number: 50 }, SCOPE),
			adapter.readPrMetadata({ ...PARSED, number: 51 }, SCOPE),
			adapter.readPrMetadata({ ...PARSED, number: 52 }, SCOPE),
		]);
		expect(observedMax).toBeLessThanOrEqual(2);
		expect(calls).toHaveLength(4);
	});

	it("paginates GraphQL review threads into a per-comment thread map", async () => {
		const page1 = JSON.stringify({
			node: {
				reviewThreads: {
					pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
					nodes: [
						{ isResolved: true, isOutdated: false, comments: { nodes: [{ id: "c1" }, { id: "c2" }] } },
						{ isResolved: false, isOutdated: true, comments: { nodes: [{ id: "c3" }] } },
					],
				},
			},
		});
		const page2 = JSON.stringify({
			node: {
				reviewThreads: {
					pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
					nodes: [{ isResolved: false, isOutdated: false, comments: { nodes: [{ id: "c4" }] } }],
				},
			},
		});
		const calls: ScriptedCall[] = [];
		const adapter = adapterFor(
			[
				{ kind: "ok", stdout: page1 },
				{ kind: "ok", stdout: page2 },
			],
			calls,
		);
		const result = await adapter.readReviewThreads(PARSED, SCOPE, "PR_123");
		expect(result.kind).toBe("ok_threads");
		if (result.kind !== "ok_threads") {
			return;
		}
		expect(result.threads.get("c1")).toEqual({ resolved: true, deleted: false });
		expect(result.threads.get("c3")).toEqual({ resolved: false, deleted: true });
		expect(result.threads.get("c4")).toEqual({ resolved: false, deleted: false });
		expect(calls).toHaveLength(2);
		expect(calls[1]?.args).toContain("after=cursor-1");
	});

	it("exposes the default 30s timeout and 8 MiB bound", () => {
		expect(GH_API_TIMEOUT_MS).toBe(30_000);
		expect(GH_API_MAX_BUFFER_BYTES).toBe(8 * 1024 * 1024);
	});
});
