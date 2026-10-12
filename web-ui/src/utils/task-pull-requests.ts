import { getPullRequestIdentityKey, parsePullRequestUrl } from "@runtime-pull-request-links";

import type { RuntimeTaskPullRequest, RuntimeTaskPullRequestRefreshReason } from "@/runtime/types";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** Stable identity for a pull request link, used as React keys in the UI. */
export function getPullRequestKey(pullRequest: RuntimeTaskPullRequest): string {
	return getPullRequestIdentityKey(pullRequest);
}

/**
 * Lightweight client-side shape check for the "link a PR" input (PRLINK-5).
 * Reuses the shared strict parser as a hint; the server re-parses and is
 * authoritative.
 */
export function validatePullRequestUrlShape(url: string): string | null {
	const trimmed = url.trim();
	if (!trimmed) {
		return "Enter a pull request URL.";
	}
	if (parsePullRequestUrl(trimmed)) {
		return null;
	}
	return "URL does not look like a pull request or merge request link.";
}

/**
 * Info message for an explicit Refresh outcome (PRLINK-5). Null when the board
 * already reflects the result (updated/unchanged) or the reason needs no
 * user-facing explanation.
 */
export function getPullRequestRefreshMessage(reason: RuntimeTaskPullRequestRefreshReason | undefined): string | null {
	switch (reason) {
		case "none_found":
			return "No pull requests found for this branch";
		case "no_gh":
			return "GitHub CLI (gh) not found";
		case "gh_failed":
			return "Could not query GitHub";
		case "no_worktree":
			return "Task worktree no longer exists";
		case "no_branch":
			return "Could not determine the current branch";
		case "no_task":
			return "Task not found";
		default:
			return null;
	}
}

/**
 * "PR #123" / "#123" for GitHub and Bitbucket; "MR !123" / "!123" for GitLab.
 */
export function formatPullRequestLabel(pullRequest: RuntimeTaskPullRequest, variant: "full" | "compact"): string {
	const prefix = pullRequest.provider === "gitlab" ? "!" : "#";
	const label = `${prefix}${pullRequest.number}`;
	if (variant === "compact") {
		return label;
	}
	return pullRequest.provider === "gitlab" ? `MR ${label}` : `PR ${label}`;
}

/**
 * Approximate, network-free age label for a timestamp, e.g. "2h ago".
 */
function formatApproximateAge(timestamp: number, now: number = Date.now()): string {
	const ageMs = Math.max(0, now - timestamp);
	if (ageMs < MINUTE_MS) {
		return "just now";
	}
	if (ageMs < HOUR_MS) {
		return `${Math.floor(ageMs / MINUTE_MS)}m ago`;
	}
	if (ageMs < DAY_MS) {
		return `${Math.floor(ageMs / HOUR_MS)}h ago`;
	}
	if (ageMs < WEEK_MS) {
		return `${Math.floor(ageMs / DAY_MS)}d ago`;
	}
	if (ageMs < YEAR_MS) {
		return `${Math.floor(ageMs / WEEK_MS)}w ago`;
	}
	return `${Math.floor(ageMs / YEAR_MS)}y ago`;
}

/**
 * Tooltip lines: "owner/repo#123", snapshot title (if any), then the
 * observation metadata as separate lines: "First recorded <age>",
 * "Last observed (approximate) <age>" (lastSeenAt, falling back to
 * createdAt when missing), and "State checked <age>" (only when both state
 * and stateCheckedAt are present). lastSeenAt is approximate and never
 * proof of state freshness — stateCheckedAt stays separate.
 */
export function getPullRequestTooltipLines(pullRequest: RuntimeTaskPullRequest): string[] {
	const prefix = pullRequest.provider === "gitlab" ? "!" : "#";
	const lines = [`${pullRequest.repository}${prefix}${pullRequest.number}`];
	if (pullRequest.title) {
		lines.push(pullRequest.title);
	}
	lines.push(`First recorded ${formatApproximateAge(pullRequest.createdAt)}`);
	lines.push(`Last observed (approximate) ${formatApproximateAge(pullRequest.lastSeenAt ?? pullRequest.createdAt)}`);
	if (pullRequest.state && pullRequest.stateCheckedAt !== undefined) {
		lines.push(`State checked ${formatApproximateAge(pullRequest.stateCheckedAt)} (${pullRequest.state})`);
	}
	return lines;
}
