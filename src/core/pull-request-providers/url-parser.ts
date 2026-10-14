// PRLINK-9: the shared, pure pull-request URL policy.
//
// One provider per URL. Parsing uses WHATWG URL semantics (scheme, authority,
// port, and path normalization) plus per-provider path-shape validation.
// Hosts are matched case-insensitively and normalized to lowercase; the
// identity host includes an explicit nondefault port (e.g. "ghe.corp.io:8443"),
// while repository segments keep their original case. Scheme is NOT part of
// the identity: the same host/port/repo/number deduplicates across http and
// https, and the https canonical URL wins when both forms are observed.
//
// This module is imported by the web-ui: no execFile, no Node-only imports,
// no environment access, no credentials.
import type { RuntimeTaskPullRequestProvider } from "../api-contract";

export interface ParsedPullRequestLink {
	provider: RuntimeTaskPullRequestProvider;
	/** Lowercase host, including an explicit nondefault port when present. */
	host: string;
	/** "owner/repo" (GitLab may be "group/subgroup/repo"). */
	repository: string;
	number: number;
	/** Canonical URL: scheme, host, repository, and PR path only. */
	url: string;
}

/**
 * Known public provider hosts (portless). A known host never accepts another
 * provider's path shape. Unknown hosts (GHE, self-hosted GitLab) are
 * classified by URL shape; Bitbucket Server and installations under a URL
 * path prefix are unsupported, so the Bitbucket shape applies only to
 * bitbucket.org.
 */
export const KNOWN_PROVIDER_HOSTS: Readonly<Record<string, RuntimeTaskPullRequestProvider>> = {
	"github.com": "github",
	"gitlab.com": "gitlab",
	"bitbucket.org": "bitbucket",
};

const DNS_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// Repository segments: alphanumeric plus ".", "_", "-" — no whitespace,
// percent-encoding, or control characters (malformed segment rejection).
const REPOSITORY_SEGMENT_PATTERN = /^[a-z0-9._-]+$/i;
const NUMBER_PATTERN = /^\d+$/;

/**
 * Valid authority for this policy: DNS names (including single labels like
 * "localhost") or dotted IPv4. IPv6 (and any other colon-bearing authority)
 * is deferred and rejected.
 */
export function isValidHostAuthority(hostname: string): boolean {
	if (hostname.length === 0 || hostname.includes(":")) {
		return false;
	}
	if (hostname.includes(".")) {
		const labels = hostname.split(".");
		return (
			labels.length <= 10 &&
			labels.every((label) => label.length > 0 && label.length <= 63 && DNS_LABEL_PATTERN.test(label))
		);
	}
	const ipv4 = IPV4_PATTERN.exec(hostname);
	if (ipv4) {
		return ipv4.slice(1).every((part) => {
			const value = Number(part);
			return value >= 0 && value <= 255;
		});
	}
	// Single label (e.g. "localhost").
	return DNS_LABEL_PATTERN.test(hostname);
}

/** Positive, safe integer PR numbers; rejects "", "0", and overflowing runs. */
export function toPositivePrNumber(raw: string): number | null {
	if (!NUMBER_PATTERN.test(raw)) {
		return null;
	}
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isValidRepositorySegment(segment: string): boolean {
	return segment.length > 0 && REPOSITORY_SEGMENT_PATTERN.test(segment);
}

interface ProviderShape {
	provider: RuntimeTaskPullRequestProvider;
	repository: string;
	number: number;
	pathSuffix: string;
}

/**
 * Validate the path segments for one provider's PR shape. Returns null when
 * the shape does not match (foreign shapes on known hosts, wrong segment
 * counts, malformed segments, or unsafe numbers).
 */
function matchProviderShape(segments: string[], provider: RuntimeTaskPullRequestProvider): ProviderShape | null {
	switch (provider) {
		case "github": {
			// owner/repo/pull/<number>, with any trailing path segments
			// (e.g. `/files`, `/comments`) ignored in the canonical URL.
			if (segments.length < 4) {
				return null;
			}
			const [owner, repo, action, rawNumber] = segments;
			if (!owner || !repo || !action || !rawNumber) {
				return null;
			}
			if (!isValidRepositorySegment(owner) || !isValidRepositorySegment(repo) || action.toLowerCase() !== "pull") {
				return null;
			}
			const number = toPositivePrNumber(rawNumber);
			if (number === null) {
				return null;
			}
			return { provider, repository: `${owner}/${repo}`, number, pathSuffix: `pull/${number}` };
		}
		case "gitlab": {
			// group[/subgroup...]/repo/-/merge_requests/<number>, where the
			// `-/merge_requests/<number>` marker may sit anywhere in the
			// segments; trailing path segments after the number (e.g.
			// `/diffs`) are ignored in the canonical URL.
			const markerIndex = segments.findIndex((segment, index) => {
				if (segment !== "-") {
					return false;
				}
				const action = segments[index + 1];
				if (!action || action.toLowerCase() !== "merge_requests") {
					return false;
				}
				return toPositivePrNumber(segments[index + 2] ?? "") !== null;
			});
			if (markerIndex === -1) {
				return null;
			}
			const repoParts = segments.slice(0, markerIndex);
			if (repoParts.length === 0 || !repoParts.every(isValidRepositorySegment)) {
				return null;
			}
			const number = toPositivePrNumber(segments[markerIndex + 2] ?? "");
			if (number === null) {
				return null;
			}
			return { provider, repository: repoParts.join("/"), number, pathSuffix: `-/merge_requests/${number}` };
		}
		case "bitbucket": {
			// workspace/repo/pull-requests/<number> (bitbucket.org only — the
			// caller enforces the known host; Bitbucket Server layouts are
			// unsupported). Trailing path segments after the number (e.g.
			// `/diff`, `/overview`) are ignored in the canonical URL.
			if (segments.length < 4) {
				return null;
			}
			const [workspace, repo, action, rawNumber] = segments;
			if (!workspace || !repo || !action || !rawNumber) {
				return null;
			}
			if (!isValidRepositorySegment(workspace) || !isValidRepositorySegment(repo)) {
				return null;
			}
			if (action.toLowerCase() !== "pull-requests") {
				return null;
			}
			const number = toPositivePrNumber(rawNumber);
			if (number === null) {
				return null;
			}
			return { provider, repository: `${workspace}/${repo}`, number, pathSuffix: `pull-requests/${number}` };
		}
	}
}

function canonicalSchemeFor(originalScheme: "http" | "https", hostname: string, port: string): "http" | "https" {
	// Known PUBLIC hosts (portless) always canonicalize to https. A known
	// hostname with a nondefault port is NOT the public host and follows the
	// self-hosted rules below.
	if (KNOWN_PROVIDER_HOSTS[hostname] !== undefined && port === "") {
		return "https";
	}
	// Self-hosted HTTP is accepted only with an explicit nondefault port,
	// and then preserves HTTP. All other portless HTTP links retain the v1
	// HTTPS canonicalization (http://host:80 is portless for this policy —
	// URL normalization already dropped the default port).
	if (originalScheme === "http" && port !== "") {
		return "http";
	}
	return "https";
}

/**
 * Parse a pull request URL into a canonical link, or null when the URL is
 * not a supported provider PR link. Rejects: credentials/userinfo, unsafe
 * schemes, missing/unsafe numbers, invalid ports, malformed repository
 * segments, IPv6 authorities, and foreign provider shapes on known hosts.
 */
export function parsePullRequestUrl(raw: string): ParsedPullRequestLink | null {
	const candidate = raw.trim();
	if (!candidate) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return null;
	}
	// Never accept credentials in the authority.
	if (url.username !== "" || url.password !== "") {
		return null;
	}
	const hostname = url.hostname;
	if (!isValidHostAuthority(hostname)) {
		return null;
	}
	const port = url.port;
	const knownProvider = port === "" ? (KNOWN_PROVIDER_HOSTS[hostname] ?? undefined) : undefined;
	const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

	const tryShape = (provider: RuntimeTaskPullRequestProvider): ProviderShape | null => {
		// A known host never takes a foreign shape.
		if (knownProvider !== undefined && knownProvider !== provider) {
			return null;
		}
		// Bitbucket is known-host only: no Bitbucket Server / path-prefixed
		// installations.
		if (provider === "bitbucket" && knownProvider !== "bitbucket") {
			return null;
		}
		return matchProviderShape(segments, provider);
	};

	const shape = tryShape("github") ?? tryShape("gitlab") ?? tryShape("bitbucket");
	if (!shape) {
		return null;
	}
	const host = port === "" ? hostname : `${hostname}:${port}`;
	const scheme = canonicalSchemeFor(url.protocol === "http:" ? "http" : "https", hostname, port);
	return {
		provider: shape.provider,
		host,
		repository: shape.repository,
		number: shape.number,
		url: `${scheme}://${host}/${shape.repository}/${shape.pathSuffix}`,
	};
}

const CANDIDATE_URL_PATTERN = /https?:\/\/\S+/gi;
const TRAILING_PROSE_PUNCTUATION_PATTERN = /[.,:;'"()>\]`]+$/;
// A markdown link `[text](url)` is a single non-whitespace run; splitting it
// at `](` keeps the two URLs as separate candidates.
const MARKDOWN_LINK_SEPARATOR_PATTERN = /\]\(/g;

/**
 * Scans arbitrary text for pull-request URLs. Trailing prose punctuation
 * (e.g. `.../pull/12).`, `>`, and closing backticks/brackets) is stripped
 * before parsing; results are deduped by identity key in first-appearance
 * order, and when the same identity is observed as both http and https,
 * the https canonical URL is kept.
 */
export function extractPullRequestLinks(text: string): ParsedPullRequestLink[] {
	const links: ParsedPullRequestLink[] = [];
	const indexByKey = new Map<string, number>();
	const normalized = text.replace(MARKDOWN_LINK_SEPARATOR_PATTERN, ") (");
	for (const match of normalized.matchAll(CANDIDATE_URL_PATTERN)) {
		const candidate = (match[0] ?? "").replace(TRAILING_PROSE_PUNCTUATION_PATTERN, "");
		const parsed = parsePullRequestUrl(candidate);
		if (!parsed) {
			continue;
		}
		const key = getPullRequestIdentityKey(parsed);
		const existingIndex = indexByKey.get(key);
		if (existingIndex === undefined) {
			indexByKey.set(key, links.length);
			links.push(parsed);
			continue;
		}
		// Scheme is not part of the identity: the https form wins.
		const existing = links[existingIndex];
		if (existing?.url.startsWith("http://") && parsed.url.startsWith("https://")) {
			links[existingIndex] = parsed;
		}
	}
	return links;
}

/**
 * Stable identity for a pull request link. Scheme is intentionally NOT part
 * of the identity (same host/port/repo/number deduplicates across http and
 * https). Host and repository are case-insensitive; the host keeps its
 * explicit nondefault port, so different nondefault ports remain distinct.
 */
export function getPullRequestIdentityKey(pullRequest: {
	provider: RuntimeTaskPullRequestProvider;
	host: string;
	repository: string;
	number: number;
}): string {
	return `${pullRequest.provider}|${pullRequest.host.toLowerCase()}|${pullRequest.repository.toLowerCase()}|${pullRequest.number}`;
}
