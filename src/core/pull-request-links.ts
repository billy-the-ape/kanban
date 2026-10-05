// PRLINK-0: shared, pure pull-request URL parsing.
//
// One matcher per provider. Hosts are matched case-insensitively and
// normalized to lowercase; repository segments keep their original case.
// Unknown hosts are classified by URL shape so GitHub Enterprise and
// self-hosted GitLab instances work without configuration.
import type { RuntimeTaskPullRequestProvider } from "./api-contract";

export interface ParsedPullRequestLink {
	provider: RuntimeTaskPullRequestProvider;
	/** Lowercase host, e.g. "github.com" or a GHE host. */
	host: string;
	/** "owner/repo" (GitLab may be "group/subgroup/repo"). */
	repository: string;
	number: number;
	/** Canonical URL: scheme, host, repository, and PR path only. */
	url: string;
}

const KNOWN_PROVIDER_HOSTS: Record<string, RuntimeTaskPullRequestProvider> = {
	"github.com": "github",
	"gitlab.com": "gitlab",
	"bitbucket.org": "bitbucket",
};

// The PR number must be digits followed by the end of the URL or a
// path/query/fragment boundary; this rejects `/pull/new/<branch>` (printed by
// `git push`), `/compare/...`, `/issues/<n>`, and missing or empty numbers.
// `http://` is accepted and canonicalized to `https://`.
const GITHUB_PULL_URL_PATTERN = /^https?:\/\/([a-z0-9.-]+)\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i;
const GITLAB_MERGE_REQUEST_URL_PATTERN = /^https?:\/\/([a-z0-9.-]+)\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#]\S*)?$/i;
const BITBUCKET_PULL_REQUEST_URL_PATTERN =
	/^https?:\/\/bitbucket\.org\/([^/?#\s]+)\/([^/?#\s]+)\/pull-requests\/(\d+)(?:[/?#]\S*)?$/i;

function toPositiveNumber(raw: string): number | null {
	const value = Number.parseInt(raw, 10);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function buildLink(
	provider: RuntimeTaskPullRequestProvider,
	host: string,
	repository: string,
	number: number,
	pathSuffix: string,
): ParsedPullRequestLink {
	return {
		provider,
		host,
		repository,
		number,
		url: `https://${host}/${repository}/${pathSuffix}`,
	};
}

export function parsePullRequestUrl(raw: string): ParsedPullRequestLink | null {
	const candidate = raw.trim();
	if (!candidate) {
		return null;
	}
	const hostMatch = candidate.match(/^https?:\/\/([a-z0-9.-]+)/i);
	const hostRaw = hostMatch?.[1];
	if (!hostMatch || !hostRaw) {
		return null;
	}
	const host = hostRaw.toLowerCase();
	const knownProvider = KNOWN_PROVIDER_HOSTS[host];
	// The URL shape decides the provider for unknown hosts; a known host
	// never takes a foreign shape (e.g. `/pull/<n>` on gitlab.com is rejected).
	const shapeAllows = (provider: RuntimeTaskPullRequestProvider): boolean =>
		knownProvider === undefined || knownProvider === provider;

	const githubMatch = GITHUB_PULL_URL_PATTERN.exec(candidate);
	if (githubMatch?.[1] && githubMatch[2] && githubMatch[3] && githubMatch[4] && shapeAllows("github")) {
		const number = toPositiveNumber(githubMatch[4]);
		if (number !== null) {
			return buildLink("github", host, `${githubMatch[2]}/${githubMatch[3]}`, number, `pull/${number}`);
		}
	}

	const gitlabMatch = GITLAB_MERGE_REQUEST_URL_PATTERN.exec(candidate);
	if (gitlabMatch?.[1] && gitlabMatch[2] && gitlabMatch[3] && shapeAllows("gitlab")) {
		const number = toPositiveNumber(gitlabMatch[3]);
		if (number !== null) {
			return buildLink("gitlab", host, gitlabMatch[2], number, `-/merge_requests/${number}`);
		}
	}

	const bitbucketMatch = BITBUCKET_PULL_REQUEST_URL_PATTERN.exec(candidate);
	if (bitbucketMatch?.[1] && bitbucketMatch[2] && bitbucketMatch[3]) {
		const number = toPositiveNumber(bitbucketMatch[3]);
		if (number !== null) {
			return buildLink(
				"bitbucket",
				host,
				`${bitbucketMatch[1]}/${bitbucketMatch[2]}`,
				number,
				`pull-requests/${number}`,
			);
		}
	}

	return null;
}

const CANDIDATE_URL_PATTERN = /https?:\/\/\S+/gi;
const TRAILING_PROSE_PUNCTUATION_PATTERN = /[.,:;'"()\]]+$/;

/**
 * Scans arbitrary text for pull-request URLs. Trailing prose punctuation
 * (e.g. `.../pull/12).`) is stripped before parsing; results are deduped by
 * identity key in first-appearance order.
 */
export function extractPullRequestLinks(text: string): ParsedPullRequestLink[] {
	const links: ParsedPullRequestLink[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(CANDIDATE_URL_PATTERN)) {
		const candidate = (match[0] ?? "").replace(TRAILING_PROSE_PUNCTUATION_PATTERN, "");
		const parsed = parsePullRequestUrl(candidate);
		if (!parsed) {
			continue;
		}
		const key = getPullRequestIdentityKey(parsed);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		links.push(parsed);
	}
	return links;
}

/**
 * Stable identity for a pull request link. Host and repository are
 * case-insensitive; provider and number are exact.
 */
export function getPullRequestIdentityKey(pullRequest: {
	provider: RuntimeTaskPullRequestProvider;
	host: string;
	repository: string;
	number: number;
}): string {
	return `${pullRequest.provider}|${pullRequest.host.toLowerCase()}|${pullRequest.repository.toLowerCase()}|${pullRequest.number}`;
}
