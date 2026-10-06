import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeTaskPullRequest } from "@/runtime/types";
import {
	formatPullRequestLabel,
	getLatestPullRequest,
	getPullRequestKey,
	getPullRequestTooltipLines,
} from "@/utils/task-pull-requests";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function createPullRequest(overrides?: Partial<RuntimeTaskPullRequest>): RuntimeTaskPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "cline/kanban",
		number: 123,
		url: "https://github.com/cline/kanban/pull/123",
		source: "manual",
		createdAt: 1,
		...overrides,
	};
}

function createCard(pullRequests?: RuntimeTaskPullRequest[]): RuntimeBoardCard {
	return {
		id: "task-1",
		title: "Task",
		prompt: "Task",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...(pullRequests !== undefined ? { pullRequests } : {}),
	};
}

describe("getLatestPullRequest", () => {
	it("returns the last recorded PR", () => {
		const first = createPullRequest({ number: 1 });
		const latest = createPullRequest({ number: 2 });
		expect(getLatestPullRequest(createCard([first, latest]))).toBe(latest);
	});

	it("returns null for undefined or empty pullRequests", () => {
		expect(getLatestPullRequest(createCard(undefined))).toBeNull();
		expect(getLatestPullRequest(createCard([]))).toBeNull();
	});
});

describe("formatPullRequestLabel", () => {
	it("uses # and PR for GitHub", () => {
		expect(formatPullRequestLabel(createPullRequest(), "full")).toBe("PR #123");
		expect(formatPullRequestLabel(createPullRequest(), "compact")).toBe("#123");
	});

	it("uses # and PR for Bitbucket", () => {
		const pullRequest = createPullRequest({
			provider: "bitbucket",
			host: "bitbucket.org",
			url: "https://bitbucket.org/cline/kanban/pull-requests/123",
		});
		expect(formatPullRequestLabel(pullRequest, "full")).toBe("PR #123");
		expect(formatPullRequestLabel(pullRequest, "compact")).toBe("#123");
	});

	it("uses ! and MR for GitLab", () => {
		const pullRequest = createPullRequest({
			provider: "gitlab",
			host: "gitlab.com",
			url: "https://gitlab.com/cline/kanban/-/merge_requests/123",
		});
		expect(formatPullRequestLabel(pullRequest, "full")).toBe("MR !123");
		expect(formatPullRequestLabel(pullRequest, "compact")).toBe("!123");
	});
});

describe("getPullRequestKey", () => {
	it("is case-insensitive for host and repository and exact for provider and number", () => {
		const first = createPullRequest();
		const same = createPullRequest({ host: "GitHub.com", repository: "Cline/Kanban" });
		const different = createPullRequest({ number: 124 });
		expect(getPullRequestKey(first)).toBe(getPullRequestKey(same));
		expect(getPullRequestKey(first)).not.toBe(getPullRequestKey(different));
	});
});

describe("getPullRequestTooltipLines", () => {
	it("shows repository, number, title, and approximate state age when available", () => {
		const now = Date.now();
		const lines = getPullRequestTooltipLines(
			createPullRequest({ title: "Fix the bug", state: "merged", stateCheckedAt: now - 2 * HOUR_MS }),
		);
		expect(lines).toEqual([
			"cline/kanban#123",
			"Fix the bug",
			`merged as of ${Math.floor((now - (now - 2 * HOUR_MS)) / HOUR_MS)}h ago`,
		]);
	});

	it("uses the ! prefix for GitLab repositories", () => {
		const lines = getPullRequestTooltipLines(
			createPullRequest({
				provider: "gitlab",
				host: "gitlab.com",
				url: "https://gitlab.com/cline/kanban/-/merge_requests/45",
				number: 45,
			}),
		);
		expect(lines[0]).toBe("cline/kanban!45");
	});

	it("omits the title when absent", () => {
		const lines = getPullRequestTooltipLines(createPullRequest());
		expect(lines).toEqual(["cline/kanban#123"]);
	});

	it("omits the state line when state or stateCheckedAt is missing", () => {
		expect(getPullRequestTooltipLines(createPullRequest({ state: "open" }))).toEqual(["cline/kanban#123"]);
		expect(getPullRequestTooltipLines(createPullRequest({ stateCheckedAt: Date.now() }))).toEqual([
			"cline/kanban#123",
		]);
	});

	it("labels very recent and older snapshots with approximate ages", () => {
		const now = Date.now();
		const lines = getPullRequestTooltipLines(createPullRequest({ state: "open", stateCheckedAt: now - 90 * 1000 }));
		expect(lines[1]).toBe("open as of 1m ago");
		const daysAgo = getPullRequestTooltipLines(
			createPullRequest({ state: "closed", stateCheckedAt: now - 3 * DAY_MS }),
		);
		expect(daysAgo[1]).toBe("closed as of 3d ago");
	});
});
