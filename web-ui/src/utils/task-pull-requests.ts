import type { RuntimeBoardCard, RuntimeTaskPullRequest } from "@/runtime/types";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** The card's most recent PR (last recorded), or null. */
export function getLatestPullRequest(card: RuntimeBoardCard): RuntimeTaskPullRequest | null {
	const pullRequests = card.pullRequests;
	if (!pullRequests || pullRequests.length === 0) {
		return null;
	}
	return pullRequests[pullRequests.length - 1] ?? null;
}

/** Stable identity for a pull request link, used as React keys in the UI. */
export function getPullRequestKey(pullRequest: RuntimeTaskPullRequest): string {
	return `${pullRequest.provider}|${pullRequest.host.toLowerCase()}|${pullRequest.repository.toLowerCase()}|${pullRequest.number}`;
}

/**
 * Lightweight client-side shape check for the "link a PR" input (PRLINK-5):
 * http(s) URL that looks like a GitHub/GitLab/Bitbucket PR or MR link.
 * The server re-parses with the strict parser and is authoritative.
 */
export function validatePullRequestUrlShape(url: string): string | null {
	const trimmed = url.trim();
	if (!trimmed) {
		return "Enter a pull request URL.";
	}
	if (!/^https?:\/\//i.test(trimmed)) {
		return "URL must start with http:// or https://.";
	}
	if (!/(\/pull\/|\/pull-requests\/|\/-\/merge_requests\/)/.test(trimmed)) {
		return "URL does not look like a pull request or merge request link.";
	}
	return null;
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
 * Tooltip lines: "owner/repo#123", snapshot title (if any),
 * "state as of <age>" (only when both state and stateCheckedAt are present).
 */
export function getPullRequestTooltipLines(pullRequest: RuntimeTaskPullRequest): string[] {
	const prefix = pullRequest.provider === "gitlab" ? "!" : "#";
	const lines = [`${pullRequest.repository}${prefix}${pullRequest.number}`];
	if (pullRequest.title) {
		lines.push(pullRequest.title);
	}
	if (pullRequest.state && pullRequest.stateCheckedAt !== undefined) {
		lines.push(`${pullRequest.state} as of ${formatApproximateAge(pullRequest.stateCheckedAt)}`);
	}
	return lines;
}
