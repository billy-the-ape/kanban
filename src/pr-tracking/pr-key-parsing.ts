// Canonical PR key parsing (AM-1 / PRTRACK-0).
//
// Pure, dependency-free parsing and validation of canonical PR keys
// (`provider|host|repository|number`, host/repository lowercase). This
// module must stay free of `node:` imports: it is part of the browser
// bundle's module graph via `src/core/task-board-mutations.ts` (aliased as
// `@runtime-task-state` by the web-ui build). `prKeyDigest`, which needs
// `node:crypto`, stays in `./pr-identity`.
import type { RuntimeTaskPullRequestProvider } from "../core/api-contract";
import { getPullRequestIdentityKey } from "../core/pull-request-links";

export interface ParsedCanonicalPrKey {
	provider: RuntimeTaskPullRequestProvider;
	host: string;
	repository: string;
	number: number;
}

const CANONICAL_PR_KEY_PROVIDERS: ReadonlySet<string> = new Set(["github", "gitlab", "bitbucket"]);
const SUPPORTED_TRACKING_HOST = "github.com";

/** Build the canonical PR key from a parsed PR link (PR-linking identity). */
export function toCanonicalPrKey(pr: {
	provider: RuntimeTaskPullRequestProvider;
	host: string;
	repository: string;
	number: number;
}): string {
	return getPullRequestIdentityKey(pr);
}

/**
 * Parse and validate a canonical PR key. Returns null for malformed keys
 * (wrong segment count, uppercase host/repository, unknown provider, non
 * positive or non-integer number) so malformed records can never create
 * subscriptions.
 */
export function parseCanonicalPrKey(canonicalPrKey: string): ParsedCanonicalPrKey | null {
	const segments = canonicalPrKey.split("|");
	if (segments.length !== 4) {
		return null;
	}
	const [provider, host, repository, rawNumber] = segments;
	if (!provider || !CANONICAL_PR_KEY_PROVIDERS.has(provider)) {
		return null;
	}
	if (!host || host !== host.toLowerCase() || host.includes("|")) {
		return null;
	}
	if (!repository || repository !== repository.toLowerCase() || repository.includes("|")) {
		return null;
	}
	const number = Number(rawNumber ?? "");
	if (!/^\d+$/.test(rawNumber ?? "") || !Number.isSafeInteger(number) || number <= 0) {
		return null;
	}
	return { provider: provider as RuntimeTaskPullRequestProvider, host, repository, number };
}

/**
 * Whether the tracking foundation may poll this PR at all: only github.com
 * links are supported. Other provider/host links stay visible but report
 * "Automation unsupported"; a GitHub credential is never sent elsewhere.
 */
export function isTrackingSupportedPr(canonicalPrKey: string): boolean {
	const parsed = parseCanonicalPrKey(canonicalPrKey);
	return parsed !== null && parsed.provider === "github" && parsed.host === SUPPORTED_TRACKING_HOST;
}

/**
 * Recompute the canonical key from a record's identity fields and verify it
 * matches the key the record is stored under (composite identity check).
 */
export function recordIdentityMatchesKey(
	record: {
		provider: string;
		host: string;
		repository: string;
		number: number;
	},
	canonicalPrKey: string,
): boolean {
	if (record.provider !== "github" || typeof record.host !== "string" || typeof record.repository !== "string") {
		return false;
	}
	return (
		toCanonicalPrKey({
			provider: "github",
			host: record.host.toLowerCase(),
			repository: record.repository.toLowerCase(),
			number: record.number,
		}) === canonicalPrKey
	);
}
