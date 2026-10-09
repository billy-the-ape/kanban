import { describe, expect, it } from "vitest";
import type { GitHubPrCommandRunner } from "../../../src/pr-tracking/github-pr-client";
import { createGitHubPrClient, resolveGitHubAccessScopeId } from "../../../src/pr-tracking/github-pr-client";

const PR = { host: "github.com", repository: "octo/repo", number: 42 };

function jsonResponse(value: unknown) {
	return { ok: true, stdout: JSON.stringify(value), stderr: "", exitCode: 0, missingBinary: false };
}

function commandPath(args: string[]): string {
	// `gh api --hostname <host> <path>` and `gh api graphql --hostname <host> <query>`.
	const hostnameIndex = args.indexOf("--hostname");
	if (hostnameIndex >= 0 && hostnameIndex + 2 < args.length) {
		return args[hostnameIndex + 2];
	}
	return args[2] ?? "";
}

function makeRunner(
	routes: Array<{
		prefix: string;
		graphql?: boolean;
		respond: () => { ok: boolean; stdout: string; stderr: string; exitCode: number; missingBinary: boolean };
	}>,
): GitHubPrCommandRunner {
	return (args: string[]) => {
		for (const route of routes) {
			const matched = route.graphql ? args[1] === "graphql" : commandPath(args).startsWith(route.prefix);
			if (matched) {
				return Promise.resolve(route.respond());
			}
		}
		return Promise.resolve({
			ok: false,
			stdout: "",
			stderr: `no route for ${args.join(" ")}`,
			exitCode: 1,
			missingBinary: false,
		});
	};
}

const meta = { state: "open", head: { sha: "abc123" }, html_url: "https://github.com/octo/repo/pull/42" };
const reviewsBase = "repos/octo/repo/pulls/42/reviews";
const inlineBase = "repos/octo/repo/pulls/42/comments";
const conversationBase = "repos/octo/repo/issues/42/comments";

function baseRoutes(overrides: Partial<Record<"reviews" | "inline" | "conversation" | "resolved", unknown[]>> = {}) {
	return [
		{ prefix: reviewsBase, respond: () => jsonResponse(overrides.reviews ?? []) },
		{ prefix: inlineBase, respond: () => jsonResponse(overrides.inline ?? []) },
		{ prefix: conversationBase, respond: () => jsonResponse(overrides.conversation ?? []) },
		{
			prefix: "",
			graphql: true,
			respond: () =>
				jsonResponse({
					data: {
						repository: {
							pullRequest: {
								reviewThreads: {
									pageInfo: { hasNextPage: false, endCursor: null },
									nodes: (overrides.resolved ?? []).map((databaseId) => ({
										isResolved: true,
										comments: { nodes: [{ databaseId }] },
									})),
								},
							},
						},
					},
				}),
		},
		{ prefix: "repos/octo/repo/pulls/42", respond: () => jsonResponse(meta) },
	];
}

function clientWith(runner: GitHubPrCommandRunner, accessScopeResolver?: () => Promise<string>) {
	return createGitHubPrClient({ runner, accessScopeResolver: accessScopeResolver ?? (async () => "scope-1") });
}

describe("github pr client", () => {
	it("rejects non-github.com hosts without calling gh", async () => {
		const runner: GitHubPrCommandRunner = () => Promise.reject(new Error("should not be called"));
		const snapshot = await clientWith(runner).fetchSnapshot({ ...PR, host: "gitlab.com" }, "/repo", "scope");
		expect(snapshot.complete).toBe(false);
		expect(snapshot.authError).toContain("github.com");
	});

	it("surfaces a visible auth blocker when the credential context is unavailable", async () => {
		const client = clientWith(makeRunner([]), async () => {
			throw new Error("GitHub authentication unavailable: token expired");
		});
		const snapshot = await client.fetchSnapshot(PR, "/repo", "scope");
		expect(snapshot.complete).toBe(false);
		expect(snapshot.authError).toContain("token expired");
	});

	it("collects eligible feedback from reviews, inline comments, and human conversation comments", async () => {
		const runner = makeRunner(
			baseRoutes({
				reviews: [
					{ id: 1, state: "COMMENTED", body: "review note", updated_at: "2026-10-01T00:00:00Z" },
					{ id: 2, state: "PENDING", body: "unpublished", updated_at: "2026-10-01T00:00:00Z" },
					{ id: 3, state: "APPROVED", body: "  ", updated_at: "2026-10-01T00:00:00Z" },
					{ id: 4, state: "DISMISSED", body: "dismissed", updated_at: "2026-10-01T00:00:00Z" },
				],
				inline: [
					{ id: 10, body: "inline note", updated_at: "2026-10-02T00:00:00Z" },
					{ id: 11, body: "resolved inline", updated_at: "2026-10-02T00:00:00Z" },
					{ id: 12, body: "", updated_at: "2026-10-02T00:00:00Z" },
					{ id: 13, body: "   ", updated_at: "2026-10-02T00:00:00Z" },
				],
				conversation: [
					{ id: 20, body: "human comment", updated_at: "2026-10-03T00:00:00Z", user: { type: "User" } },
					{ id: 21, body: "bot chatter", updated_at: "2026-10-03T00:00:00Z", user: { type: "Bot" } },
					{ id: 22, body: "", updated_at: "2026-10-03T00:00:00Z", user: { type: "User" } },
				],
				resolved: [11],
			}),
		);
		const snapshot = await clientWith(runner).fetchSnapshot(PR, "/repo", "scope");
		expect(snapshot.complete).toBe(true);
		expect(snapshot.prState).toBe("open");
		expect(snapshot.headSha).toBe("abc123");
		expect(snapshot.events.map((event) => event.providerId).sort()).toEqual([
			"conversation-20",
			"inline-10",
			"review-1",
		]);
		expect(snapshot.events.find((event) => event.providerId === "review-1")?.updatedAt).toBe(
			Date.parse("2026-10-01T00:00:00Z"),
		);
	});

	it("marks the snapshot incomplete when any source page fails", async () => {
		const runner = makeRunner([
			{
				prefix: reviewsBase,
				respond: () => jsonResponse([{ id: 1, state: "COMMENTED", body: "x", updated_at: "2026-10-01T00:00:00Z" }]),
			},
			{
				prefix: inlineBase,
				respond: () => ({ ok: false, stdout: "", stderr: "boom", exitCode: 1, missingBinary: false }),
			},
			{ prefix: conversationBase, respond: () => jsonResponse([]) },
			{
				prefix: "",
				graphql: true,
				respond: () =>
					jsonResponse({
						data: {
							repository: {
								pullRequest: {
									reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
								},
							},
						},
					}),
			},
			{ prefix: "repos/octo/repo/pulls/42", respond: () => jsonResponse(meta) },
		]);
		const snapshot = await clientWith(runner).fetchSnapshot(PR, "/repo", "scope");
		expect(snapshot.complete).toBe(false);
	});

	it("paginates complete sources and stops on a short final page", async () => {
		const fullPage = Array.from({ length: 100 }, (_, index) => ({
			id: index + 1,
			state: "COMMENTED",
			body: `note ${index}`,
			updated_at: "2026-10-01T00:00:00Z",
		}));
		const shortPage = [{ id: 101, state: "COMMENTED", body: "note 100", updated_at: "2026-10-01T00:00:00Z" }];
		let page1Seen = 0;
		let page2Seen = 0;
		const runner: GitHubPrCommandRunner = (args) => {
			const path = commandPath(args);
			if (path === "user") {
				return Promise.resolve({ ok: true, stdout: "octocat\n", stderr: "", exitCode: 0, missingBinary: false });
			}
			if (path === "repos/octo/repo/pulls/42") {
				return Promise.resolve(jsonResponse(meta));
			}
			if (path.startsWith(`${reviewsBase}?`)) {
				if (path.endsWith("&page=1")) {
					page1Seen += 1;
					return Promise.resolve(jsonResponse(fullPage));
				}
				if (path.endsWith("&page=2")) {
					page2Seen += 1;
					return Promise.resolve(jsonResponse(shortPage));
				}
			}
			if (path.startsWith(inlineBase)) {
				return Promise.resolve(jsonResponse([]));
			}
			if (path.startsWith(conversationBase)) {
				return Promise.resolve(jsonResponse([]));
			}
			if (args[1] === "graphql") {
				return Promise.resolve(
					jsonResponse({
						data: {
							repository: {
								pullRequest: {
									reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
								},
							},
						},
					}),
				);
			}
			return Promise.resolve({
				ok: false,
				stdout: "",
				stderr: `no route for ${path}`,
				exitCode: 1,
				missingBinary: false,
			});
		};
		const snapshot = await clientWith(runner).fetchSnapshot(PR, "/repo", "scope");
		expect(snapshot.complete).toBe(true);
		expect(snapshot.events).toHaveLength(101);
		expect(page1Seen).toBe(1);
		expect(page2Seen).toBe(1);
	});

	it("resolveGitHubAccessScopeId maps missing gh and missing credentials to actionable errors", async () => {
		const missingGh: GitHubPrCommandRunner = () =>
			Promise.resolve({ ok: false, stdout: "", stderr: "", exitCode: 127, missingBinary: true });
		await expect(resolveGitHubAccessScopeId(missingGh)).rejects.toThrow(/gh CLI is not installed/);
		const badAuth: GitHubPrCommandRunner = () =>
			Promise.resolve({ ok: false, stdout: "", stderr: "HTTP 401", exitCode: 1, missingBinary: false });
		await expect(resolveGitHubAccessScopeId(badAuth)).rejects.toThrow(/HTTP 401/);
		const good: GitHubPrCommandRunner = () =>
			Promise.resolve({ ok: true, stdout: "octocat\n", stderr: "", exitCode: 0, missingBinary: false });
		await expect(resolveGitHubAccessScopeId(good)).resolves.toBe("octocat");
	});
});
