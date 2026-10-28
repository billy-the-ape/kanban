import { describe, expect, it } from "vitest";

import type { RuntimeTaskPullRequest } from "@/runtime/types";
import {
	formatMergeableStateLabel,
	formatPullRequestLabel,
	getPullRequestDetailParts,
	getPullRequestKey,
	getPullRequestRefreshMessage,
	getPullRequestTooltipLines,
	validatePullRequestUrlShape,
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

describe("validatePullRequestUrlShape", () => {
	it("accepts PR/MR URLs for the supported providers", () => {
		expect(validatePullRequestUrlShape("https://github.com/owner/repo/pull/123")).toBeNull();
		expect(validatePullRequestUrlShape("https://gitlab.com/group/repo/-/merge_requests/45")).toBeNull();
		expect(validatePullRequestUrlShape("https://bitbucket.org/owner/repo/pull-requests/7")).toBeNull();
	});

	it("rejects empty, non-URL, and non-PR URLs", () => {
		expect(validatePullRequestUrlShape("")).toBe("Enter a pull request URL.");
		expect(validatePullRequestUrlShape("https://github.com/owner/repo/issues/3")).toBe(
			"URL does not look like a pull request or merge request link.",
		);
		expect(validatePullRequestUrlShape("https://github.com/owner/repo/pull/new/branch")).toBe(
			"URL does not look like a pull request or merge request link.",
		);
	});
});

describe("getPullRequestRefreshMessage", () => {
	it("maps lookup failure reasons to info messages", () => {
		expect(getPullRequestRefreshMessage("none_found")).toBe("No pull requests found for this branch");
		expect(getPullRequestRefreshMessage("no_gh")).toBe("GitHub CLI (gh) not found");
		expect(getPullRequestRefreshMessage("gh_failed")).toBe("Could not query GitHub");
		expect(getPullRequestRefreshMessage("no_worktree")).toBe("Task worktree no longer exists");
		expect(getPullRequestRefreshMessage("no_remote")).toBe("No recognized origin remote for this task's worktree");
		expect(getPullRequestRefreshMessage("no_branch")).toBe("Could not determine the current branch");
	});

	it("returns null when the board already reflects the outcome", () => {
		expect(getPullRequestRefreshMessage("updated")).toBeNull();
		expect(getPullRequestRefreshMessage("unchanged")).toBeNull();
		expect(getPullRequestRefreshMessage("failed")).toBeNull();
		expect(getPullRequestRefreshMessage(undefined)).toBeNull();
	});
});

describe("getPullRequestTooltipLines", () => {
	it("shows repository, title, observation lines, and state line when available", () => {
		const now = Date.now();
		const lines = getPullRequestTooltipLines(
			createPullRequest({
				createdAt: now - 2 * DAY_MS,
				lastSeenAt: now - 2 * HOUR_MS,
				title: "Fix the bug",
				state: "merged",
				stateCheckedAt: now - 2 * HOUR_MS,
			}),
		);
		expect(lines).toEqual([
			"cline/kanban#123",
			"Fix the bug",
			"First recorded 2d ago",
			"Last observed (approximate) 2h ago",
			"State checked 2h ago (merged)",
		]);
	});

	it("falls back to createdAt for the last-observed line when lastSeenAt is missing", () => {
		const now = Date.now();
		const lines = getPullRequestTooltipLines(createPullRequest({ createdAt: now - 5 * MINUTE_MS }));
		expect(lines).toEqual(["cline/kanban#123", "First recorded 5m ago", "Last observed (approximate) 5m ago"]);
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

	it("omits the state line when state or stateCheckedAt is missing", () => {
		const now = Date.now();
		const created = now - 5 * MINUTE_MS;
		expect(getPullRequestTooltipLines(createPullRequest({ createdAt: created, state: "open" }))).toEqual([
			"cline/kanban#123",
			"First recorded 5m ago",
			"Last observed (approximate) 5m ago",
		]);
		expect(getPullRequestTooltipLines(createPullRequest({ createdAt: created, stateCheckedAt: created }))).toEqual([
			"cline/kanban#123",
			"First recorded 5m ago",
			"Last observed (approximate) 5m ago",
		]);
	});
});

describe("getPullRequestDetailParts", () => {
	const NOW = 1_800_000_000_000;

	it("returns an empty list when no provider details are stored", () => {
		expect(getPullRequestDetailParts(createPullRequest(), NOW)).toEqual([]);
	});

	it("renders change counts, files, commits, and comment counts", () => {
		const parts = getPullRequestDetailParts(
			createPullRequest({
				additions: 120,
				deletions: 34,
				changedFiles: 12,
				commits: 7,
				comments: 3,
				reviewComments: 5,
			}),
			NOW,
		);
		expect(parts).toEqual(["+120 -34 (12 files)", "7 commits", "3 comments · 5 review comments"]);
	});

	it("singularizes counts of one", () => {
		const parts = getPullRequestDetailParts(
			createPullRequest({
				additions: 1,
				deletions: 1,
				changedFiles: 1,
				commits: 1,
				comments: 1,
				reviewComments: 1,
			}),
			NOW,
		);
		expect(parts).toEqual(["+1 -1 (1 file)", "1 commit", "1 comment · 1 review comment"]);
	});

	it("renders the head commit, mergeability, labels, reviewers, and dates", () => {
		const parts = getPullRequestDetailParts(
			createPullRequest({
				headSha: "abc123def456789",
				mergeableState: "dirty",
				labels: ["bug", "tracking"],
				requestedReviewers: ["reviewer-a", "reviewer-b"],
				openedAt: NOW - 2 * DAY_MS,
				updatedAt: NOW - 1 * HOUR_MS,
			}),
			NOW,
		);
		expect(parts).toEqual([
			"Head abc123d",
			"Merge conflicts",
			"Labels: bug, tracking",
			"Reviewers: reviewer-a, reviewer-b",
			"Opened 2d ago",
			"Updated 1h ago",
		]);
	});
});

describe("formatMergeableStateLabel", () => {
	it("labels only noteworthy mergeable states", () => {
		expect(formatMergeableStateLabel("dirty")).toBe("Merge conflicts");
		expect(formatMergeableStateLabel("blocked")).toBe("Merge blocked");
		expect(formatMergeableStateLabel("behind")).toBe("Behind base branch");
		expect(formatMergeableStateLabel("unstable")).toBe("Checks failing");
		expect(formatMergeableStateLabel("clean")).toBeNull();
		expect(formatMergeableStateLabel("stable")).toBeNull();
		expect(formatMergeableStateLabel(undefined)).toBeNull();
	});
});

describe("getPullRequestTooltipLines with details", () => {
	it("includes the detail line and full head commit when stored", () => {
		const now = Date.now();
		const lines = getPullRequestTooltipLines(
			createPullRequest({
				title: "Fix the bug",
				headSha: "abc123def456789",
				additions: 10,
				deletions: 2,
				changedFiles: 3,
				createdAt: now - 5 * MINUTE_MS,
				lastSeenAt: now - 2 * MINUTE_MS,
			}),
			now,
		);
		expect(lines).toContain("cline/kanban#123");
		expect(lines).toContain("Fix the bug");
		expect(lines).toContain("+10 -2 (3 files) · Head abc123d");
		expect(lines).toContain("Head commit abc123def456789");
		expect(lines).toContain("First recorded 5m ago");
	});
});
