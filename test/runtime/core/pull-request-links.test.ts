import { describe, expect, it } from "vitest";
import type { RuntimeTaskPullRequest } from "../../../src/core/api-contract";
import type { ParsedPullRequestLink } from "../../../src/core/pull-request-links";
import {
	extractPullRequestLinks,
	getOrderedTaskPullRequests,
	getPrimaryPullRequest,
	getPullRequestIdentityKey,
	parsePullRequestUrl,
} from "../../../src/core/pull-request-links";

describe("parsePullRequestUrl", () => {
	it("parses a github.com PR URL", () => {
		expect(parsePullRequestUrl("https://github.com/owner/repo/pull/12")).toEqual({
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
			number: 12,
			url: "https://github.com/owner/repo/pull/12",
		});
	});

	it("parses a GitHub Enterprise host by shape", () => {
		expect(parsePullRequestUrl("https://ghe.corp.io/owner/repo/pull/42")).toMatchObject({
			provider: "github",
			host: "ghe.corp.io",
			number: 42,
		});
	});

	it("accepts and strips trailing path, query, and fragment segments", () => {
		for (const suffix of ["/files", "?tab=tests", "#discussion_r1", "/files#diff-abc"]) {
			expect(parsePullRequestUrl(`https://github.com/owner/repo/pull/12${suffix}`)).toMatchObject({
				number: 12,
				url: "https://github.com/owner/repo/pull/12",
			});
		}
	});

	it("rejects non-PR, non-http(s), and malformed URLs", () => {
		const rejected = [
			"https://github.com/owner/repo/pull/new/feature-branch", // git push output
			"https://github.com/owner/repo/compare/main...head",
			"https://github.com/owner/repo/issues/12",
			"ftp://github.com/owner/repo/pull/12",
			"github.com/owner/repo/pull/12", // schemeless
			"https://github.com/owner/repo/pull/", // missing number
			"https://github.com/owner/repo/pull/0", // zero
			"https://github.com/owner/pull/12", // missing repository segment
			"https://gitlab.com/group/project/-/issues/7",
		];
		for (const candidate of rejected) {
			expect(parsePullRequestUrl(candidate)).toBeNull();
		}
	});

	it("parses GitLab merge requests with nested groups", () => {
		expect(parsePullRequestUrl("https://gitlab.com/group/subgroup/repo/-/merge_requests/7")).toEqual({
			provider: "gitlab",
			host: "gitlab.com",
			repository: "group/subgroup/repo",
			number: 7,
			url: "https://gitlab.com/group/subgroup/repo/-/merge_requests/7",
		});
	});

	it("parses a self-hosted GitLab host by shape", () => {
		expect(parsePullRequestUrl("https://gitlab.example.com/team/project/-/merge_requests/3")).toMatchObject({
			provider: "gitlab",
			host: "gitlab.example.com",
			repository: "team/project",
			number: 3,
		});
	});

	it("rejects a GitHub-shaped URL on a known GitLab host", () => {
		expect(parsePullRequestUrl("https://gitlab.com/group/project/pull/5")).toBeNull();
	});

	it("parses Bitbucket Cloud pull requests", () => {
		expect(parsePullRequestUrl("https://bitbucket.org/ws/repo/pull-requests/9")).toEqual({
			provider: "bitbucket",
			host: "bitbucket.org",
			repository: "ws/repo",
			number: 9,
			url: "https://bitbucket.org/ws/repo/pull-requests/9",
		});
	});

	it("normalizes uppercase hosts to lowercase in the canonical URL", () => {
		expect(parsePullRequestUrl("https://GITHUB.COM/Owner/Repo/pull/5")).toMatchObject({
			host: "github.com",
			repository: "Owner/Repo",
			url: "https://github.com/Owner/Repo/pull/5",
		});
	});
});

describe("extractPullRequestLinks", () => {
	it("finds PR URLs embedded in prose with trailing punctuation", () => {
		const links = extractPullRequestLinks("Created the PR: See https://github.com/o/r/pull/12). Let me know.");
		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe("https://github.com/o/r/pull/12");
	});

	it("dedupes by identity (case-insensitive host/repo) keeping first-appearance order", () => {
		const links = extractPullRequestLinks(
			[
				"https://GITHUB.COM/Owner/Repo/pull/12",
				"https://github.com/other/repo/pull/99",
				"(https://github.com/owner/repo/pull/12/files)",
				"https://github.com/other/repo/pull/99.",
			].join(" "),
		);
		expect(links.map((link) => link.url)).toEqual([
			"https://github.com/Owner/Repo/pull/12",
			"https://github.com/other/repo/pull/99",
		]);
	});

	it("ignores issues, compare links, and other noise", () => {
		const links = extractPullRequestLinks(
			[
				"see https://github.com/o/r/issues/3",
				"https://github.com/o/r/compare/main...head",
				"real: https://gitlab.com/g/p/-/merge_requests/4",
				"ftp://github.com/o/r/pull/5",
			].join(" "),
		);
		expect(links.map((link) => link.url)).toEqual(["https://gitlab.com/g/p/-/merge_requests/4"]);
	});
});

describe("getPullRequestIdentityKey", () => {
	it("is case-insensitive on host and repository", () => {
		const upper: ParsedPullRequestLink = {
			provider: "github",
			host: "GITHUB.COM",
			repository: "Owner/Repo",
			number: 12,
			url: "https://github.com/owner/repo/pull/12",
		};
		const lower: ParsedPullRequestLink = {
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
			number: 12,
			url: "https://github.com/owner/repo/pull/12",
		};
		expect(getPullRequestIdentityKey(upper)).toBe(getPullRequestIdentityKey(lower));
	});

	it("distinguishes different numbers and providers", () => {
		const base = { host: "example.com", repository: "owner/repo", number: 1 };
		expect(getPullRequestIdentityKey({ ...base, provider: "github" })).not.toBe(
			getPullRequestIdentityKey({ ...base, provider: "gitlab" }),
		);
		expect(getPullRequestIdentityKey({ ...base, provider: "github", number: 2 })).not.toBe(
			getPullRequestIdentityKey({ ...base, provider: "github" }),
		);
	});
});

function createPullRequest(overrides?: Partial<RuntimeTaskPullRequest>): RuntimeTaskPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "owner/repo",
		number: 1,
		url: "https://github.com/owner/repo/pull/1",
		source: "manual",
		createdAt: 1000,
		...overrides,
	};
}

describe("getPrimaryPullRequest", () => {
	it("returns null for an empty list", () => {
		expect(getPrimaryPullRequest([])).toBeNull();
	});

	it("picks the newest first-recorded open entry over older ones", () => {
		const older = createPullRequest({ number: 1, state: "open", createdAt: 1000 });
		const newest = createPullRequest({ number: 2, state: "open", createdAt: 3000 });
		const oldest = createPullRequest({ number: 3, state: "open", createdAt: 2000 });
		expect(getPrimaryPullRequest([older, newest, oldest])).toBe(newest);
	});

	it("treats draft and open as the same priority tier", () => {
		const open = createPullRequest({ number: 1, state: "open", createdAt: 1000 });
		const draft = createPullRequest({ number: 2, state: "draft", createdAt: 2000 });
		expect(getPrimaryPullRequest([open, draft])).toBe(draft);
	});

	it("falls back to unknown-state entries when none are open or draft", () => {
		const merged = createPullRequest({ number: 1, state: "merged", createdAt: 5000 });
		const unknown = createPullRequest({ number: 2, createdAt: 1000 });
		expect(getPrimaryPullRequest([merged, unknown])).toBe(unknown);
	});

	it("falls back to merged/closed only when no open, draft, or unknown entries exist", () => {
		const closed = createPullRequest({ number: 1, state: "closed", createdAt: 1000 });
		const merged = createPullRequest({ number: 2, state: "merged", createdAt: 2000 });
		expect(getPrimaryPullRequest([closed, merged])).toBe(merged);
	});

	it("lets an explicit isPrimary win even for a merged or closed entry", () => {
		const open = createPullRequest({ number: 1, state: "open", createdAt: 9000 });
		const mergedPrimary = createPullRequest({ number: 2, state: "merged", createdAt: 1000, isPrimary: true });
		expect(getPrimaryPullRequest([open, mergedPrimary])).toBe(mergedPrimary);
	});

	it("resolves duplicate explicit flags to the newest first-recorded, latest index on ties", () => {
		const first = createPullRequest({ number: 1, createdAt: 2000, isPrimary: true });
		const second = createPullRequest({ number: 2, createdAt: 2000, isPrimary: true });
		const newest = createPullRequest({ number: 3, createdAt: 3000, isPrimary: true });
		expect(getPrimaryPullRequest([first, second, newest])).toBe(newest);
		const tied = [
			createPullRequest({ number: 4, createdAt: 1000, isPrimary: true }),
			createPullRequest({ number: 5, createdAt: 1000, isPrimary: true }),
		];
		expect(getPrimaryPullRequest(tied)).toBe(tied[1]);
	});

	it("breaks equal createdAt ties to the later original array index", () => {
		const earlier = createPullRequest({ number: 1, state: "open", createdAt: 1000 });
		const later = createPullRequest({ number: 2, state: "open", createdAt: 1000 });
		expect(getPrimaryPullRequest([earlier, later])).toBe(later);
	});

	it("never mutates the stored list", () => {
		const list = [
			createPullRequest({ number: 1, state: "merged", createdAt: 1000 }),
			createPullRequest({ number: 2, state: "open", createdAt: 2000 }),
		];
		const copy = [...list];
		getPrimaryPullRequest(list);
		getOrderedTaskPullRequests(list);
		expect(list).toEqual(copy);
	});
});

describe("getOrderedTaskPullRequests", () => {
	it("returns an empty array for an empty list", () => {
		expect(getOrderedTaskPullRequests([])).toEqual([]);
	});

	it("returns the winner first and the rest in original recorded order", () => {
		const first = createPullRequest({ number: 1, state: "merged", createdAt: 1000 });
		const winner = createPullRequest({ number: 2, state: "open", createdAt: 3000 });
		const third = createPullRequest({ number: 3, state: "open", createdAt: 2000 });
		expect(getOrderedTaskPullRequests([first, winner, third])).toEqual([winner, first, third]);
	});

	it("keeps a single-entry list unchanged in order", () => {
		const only = createPullRequest();
		expect(getOrderedTaskPullRequests([only])).toEqual([only]);
	});
});
