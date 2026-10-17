import { getPullRequestIdentityKey, parsePullRequestUrl } from "@runtime-pull-request-links";

import type {
	RuntimeTaskPullRequest,
	RuntimeTaskPullRequestRefreshOutcome,
	RuntimeTaskPullRequestRefreshReason,
	RuntimeTaskPullRequestSource,
} from "@/runtime/types";
import { formatApproximateAge } from "@/utils/format-approximate-age";

export { formatApproximateAge } from "@/utils/format-approximate-age";

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
		case "no_remote":
			return "No recognized origin remote for this task's worktree";
		case "no_branch":
			return "Could not determine the current branch";
		case "no_task":
			return "Task not found";
		default:
			return null;
	}
}

/**
 * PRLINK-9: user-facing messages for a linked-metadata refresh result.
 * Reports how many links changed and, when anything could not be refreshed,
 * how many failed (unsupported providers, provider errors, or deadline).
 */
export function getLinkedRefreshMessages(updated: number, outcomes: RuntimeTaskPullRequestRefreshOutcome[]): string[] {
	const messages: string[] = [];
	if (updated > 0) {
		messages.push(`Refreshed ${updated} pull request${updated === 1 ? "" : "s"}.`);
	}
	const unresolved = outcomes.filter((outcome) => outcome.outcome === "failed" || outcome.outcome === "unsupported");
	if (unresolved.length > 0) {
		messages.push(`${unresolved.length} pull request${unresolved.length === 1 ? "" : "s"} could not be refreshed.`);
	}
	return messages;
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
 * "owner/repo#123" (GitLab: "group/repo!123") — the identity shown in
 * linked-PR rows (PRLINK-10).
 */
export function formatPullRequestIdentity(pullRequest: RuntimeTaskPullRequest): string {
	const prefix = pullRequest.provider === "gitlab" ? "!" : "#";
	return `${pullRequest.repository}${prefix}${pullRequest.number}`;
}

/**
 * Human label for a provider mergeable state. Only noteworthy states get a
 * label; clean/stable/unknown are noise on a row.
 */
export function formatMergeableStateLabel(state: string | undefined): string | null {
	switch (state) {
		case "dirty":
			return "Merge conflicts";
		case "blocked":
			return "Merge blocked";
		case "behind":
			return "Behind base branch";
		case "unstable":
			return "Checks failing";
		default:
			return null;
	}
}

function plural(count: number, singular: string, plural: string): string {
	return count === 1 ? singular : plural;
}

/**
 * Provider detail parts for a linked-PR row, projected from a metadata
 * refresh (same read as state/title — no extra fetch): change counts, commit
 * count, comment counts, head commit, mergeability, labels, requested
 * reviewers, and opened/updated ages. Returns [] when the row has no
 * provider details yet (never a provider round-trip from the row itself).
 */
export function getPullRequestDetailParts(pullRequest: RuntimeTaskPullRequest, now: number = Date.now()): string[] {
	const parts: string[] = [];
	const changes: string[] = [];
	if (pullRequest.additions !== undefined) {
		changes.push(`+${pullRequest.additions}`);
	}
	if (pullRequest.deletions !== undefined) {
		changes.push(`-${pullRequest.deletions}`);
	}
	if (changes.length > 0) {
		parts.push(
			pullRequest.changedFiles !== undefined
				? `${changes.join(" ")} (${pullRequest.changedFiles} ${plural(pullRequest.changedFiles, "file", "files")})`
				: changes.join(" "),
		);
	}
	if (pullRequest.commits !== undefined) {
		parts.push(`${pullRequest.commits} ${plural(pullRequest.commits, "commit", "commits")}`);
	}
	const commentCounts: string[] = [];
	if (pullRequest.comments !== undefined) {
		commentCounts.push(`${pullRequest.comments} ${plural(pullRequest.comments, "comment", "comments")}`);
	}
	if (pullRequest.reviewComments !== undefined) {
		commentCounts.push(
			`${pullRequest.reviewComments} review ${plural(pullRequest.reviewComments, "comment", "comments")}`,
		);
	}
	if (commentCounts.length > 0) {
		parts.push(commentCounts.join(" · "));
	}
	if (pullRequest.headSha) {
		parts.push(`Head ${pullRequest.headSha.slice(0, 7)}`);
	}
	const mergeable = formatMergeableStateLabel(pullRequest.mergeableState);
	if (mergeable !== null) {
		parts.push(mergeable);
	}
	if (pullRequest.labels && pullRequest.labels.length > 0) {
		parts.push(`Labels: ${pullRequest.labels.join(", ")}`);
	}
	if (pullRequest.requestedReviewers && pullRequest.requestedReviewers.length > 0) {
		parts.push(`Reviewers: ${pullRequest.requestedReviewers.join(", ")}`);
	}
	if (pullRequest.openedAt !== undefined) {
		parts.push(`Opened ${formatApproximateAge(pullRequest.openedAt, now)}`);
	}
	if (pullRequest.updatedAt !== undefined) {
		parts.push(`Updated ${formatApproximateAge(pullRequest.updatedAt, now)}`);
	}
	return parts;
}

/** Human label for how a link was recorded (PRLINK-10). */
export function formatPullRequestSource(source: RuntimeTaskPullRequestSource): string {
	switch (source) {
		case "agent_tool":
			return "agent";
		case "delivery":
			return "delivery";
		case "manual":
			return "manual";
		case "branch_lookup":
			return "branch lookup";
	}
}

/**
 * Tooltip lines: "owner/repo#123", snapshot title (if any), then the
 * observation metadata as separate lines: "First recorded <age>",
 * "Last observed (approximate) <age>" (lastSeenAt, falling back to
 * createdAt when missing), and "State checked <age>" (only when both state
 * and stateCheckedAt are present). lastSeenAt is approximate and never
 * proof of state freshness — stateCheckedAt stays separate.
 */
export function getPullRequestTooltipLines(pullRequest: RuntimeTaskPullRequest, now: number = Date.now()): string[] {
	const prefix = pullRequest.provider === "gitlab" ? "!" : "#";
	const lines = [`${pullRequest.repository}${prefix}${pullRequest.number}`];
	if (pullRequest.title) {
		lines.push(pullRequest.title);
	}
	const details = getPullRequestDetailParts(pullRequest, now);
	if (details.length > 0) {
		lines.push(details.join(" · "));
	}
	if (pullRequest.headSha) {
		lines.push(`Head commit ${pullRequest.headSha}`);
	}
	lines.push(`First recorded ${formatApproximateAge(pullRequest.createdAt, now)}`);
	lines.push(
		`Last observed (approximate) ${formatApproximateAge(pullRequest.lastSeenAt ?? pullRequest.createdAt, now)}`,
	);
	if (pullRequest.state && pullRequest.stateCheckedAt !== undefined) {
		lines.push(`State checked ${formatApproximateAge(pullRequest.stateCheckedAt, now)} (${pullRequest.state})`);
	}
	return lines;
}
