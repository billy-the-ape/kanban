// PRLINK-0/9: shared, pure pull-request URL parsing entry point.
//
// PRLINK-9: the URL policy moved to `src/core/pull-request-providers/`
// (strict WHATWG-URL-based parsing, per-provider path shapes, port-aware
// identity, and scheme canonicalization). This module stays the shared
// server/web-ui entry point and keeps the chat classification and the
// display-primary selection.
import type { RuntimeTaskPullRequest } from "./api-contract";
import {
	extractPullRequestLinks,
	getPullRequestIdentityKey,
	type ParsedPullRequestLink,
	parsePullRequestUrl,
} from "./pull-request-providers/url-parser";

export { extractPullRequestLinks, getPullRequestIdentityKey, type ParsedPullRequestLink, parsePullRequestUrl };
// --- PRLINK-8: native chat bare-URL shortcut ----------------------------------

/**
 * PRLINK-8: classification of a native task chat message for PR linking.
 * Pure: no I/O, no settings. A trimmed message that is exactly one valid
 * bare HTTP(S) PR URL with no attached images is an auto-link shortcut.
 * Everything else (prose mentions, markdown/angle wrappers, code fences,
 * trailing punctuation, multiple/duplicate URLs, attached images) falls
 * through to the suggestion path with at most three deduped links.
 * Slash-command exclusion happens before this helper is called.
 */
export type TaskChatPrLinkCandidate =
	| { kind: "auto_link"; link: ParsedPullRequestLink }
	| { kind: "suggestions"; links: ParsedPullRequestLink[] }
	| { kind: "none" };

export const MAX_CHAT_PR_LINK_SUGGESTIONS = 3;

export function classifyTaskChatMessageForPrLink(text: string, hasImages: boolean): TaskChatPrLinkCandidate {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return { kind: "none" };
	}
	// The auto-link shortcut requires a whitespace-free message: a bare URL has
	// no spaces. (The GitLab MR pattern's repository group is lazy and can span
	// whitespace, so anchoring alone does not guarantee a single-URL match.)
	if (!hasImages && !/\s/.test(trimmed)) {
		const link = parsePullRequestUrl(trimmed);
		if (link) {
			return { kind: "auto_link", link };
		}
	}
	const links = extractPullRequestLinks(trimmed).slice(0, MAX_CHAT_PR_LINK_SUGGESTIONS);
	if (links.length === 0) {
		return { kind: "none" };
	}
	return { kind: "suggestions", links };
}

// --- PRLINK-6: primary display selection --------------------------------------

/**
 * Compares two entries as "newest first-recorded": later `createdAt` wins;
 * for equal timestamps the later original array index wins.
 */
function isNewerFirstRecorded(candidate: RuntimeTaskPullRequest, best: RuntimeTaskPullRequest): boolean {
	return candidate.createdAt > best.createdAt;
}

/**
 * Picks the newest first-recorded entry from a non-empty candidate list.
 * Iterating in original order and replacing on ties makes the later index
 * win when timestamps are equal, so malformed data (e.g. several explicit
 * primaries) resolves deterministically.
 */
function pickNewestFirstRecorded(candidates: RuntimeTaskPullRequest[]): RuntimeTaskPullRequest {
	let best = candidates[0];
	if (best === undefined) {
		throw new Error("pickNewestFirstRecorded requires at least one candidate");
	}
	for (const candidate of candidates) {
		if (candidate === best) {
			continue;
		}
		if (isNewerFirstRecorded(candidate, best) || candidate.createdAt === best.createdAt) {
			best = candidate;
		}
	}
	return best;
}

/**
 * PRLINK-6: the display-preferred ("primary") pull request for a task card.
 * Pure: never sorts or mutates the stored array. Rules, in order:
 * 1. An explicit `isPrimary: true` entry wins, even if closed, merged or
 *    unknown (with several, the newest first-recorded one wins).
 * 2. Otherwise the newest first-recorded open or draft entry.
 * 3. Otherwise the newest first-recorded unknown-state entry.
 * 4. Otherwise the newest first-recorded merged or closed entry.
 * Returns null for an empty list.
 */
export function getPrimaryPullRequest(pullRequests: RuntimeTaskPullRequest[]): RuntimeTaskPullRequest | null {
	if (pullRequests.length === 0) {
		return null;
	}
	const explicitPrimary = pullRequests.filter((pullRequest) => pullRequest.isPrimary === true);
	if (explicitPrimary.length > 0) {
		return pickNewestFirstRecorded(explicitPrimary);
	}
	const openOrDraft = pullRequests.filter(
		(pullRequest) => pullRequest.state === "open" || pullRequest.state === "draft",
	);
	if (openOrDraft.length > 0) {
		return pickNewestFirstRecorded(openOrDraft);
	}
	const unknown = pullRequests.filter((pullRequest) => pullRequest.state === undefined);
	if (unknown.length > 0) {
		return pickNewestFirstRecorded(unknown);
	}
	const mergedOrClosed = pullRequests.filter(
		(pullRequest) => pullRequest.state === "merged" || pullRequest.state === "closed",
	);
	if (mergedOrClosed.length > 0) {
		return pickNewestFirstRecorded(mergedOrClosed);
	}
	return null;
}

/**
 * PRLINK-6: ordered display list — the primary winner first, then all other
 * entries in original recorded order. Never mutates the input; returns a new
 * array (a copy of the input when there are no entries).
 */
export function getOrderedTaskPullRequests(pullRequests: RuntimeTaskPullRequest[]): RuntimeTaskPullRequest[] {
	if (pullRequests.length === 0) {
		return [];
	}
	const primary = getPrimaryPullRequest(pullRequests);
	if (primary === null) {
		return [...pullRequests];
	}
	return [primary, ...pullRequests.filter((pullRequest) => pullRequest !== primary)];
}
