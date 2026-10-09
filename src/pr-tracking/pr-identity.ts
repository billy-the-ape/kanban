// PRTRACK-0: canonical PR identity for the tracking foundation.
//
// The canonical PR key is the PR-linking identity key
// (`provider|host|repository|number`, host/repository lowercase) reused from
// `src/core/pull-request-links.ts`. This module only adds validation, the
// SHA-256 storage digest, and the github.com-only support gate; it never
// re-implements URL parsing.
import { createHash } from "node:crypto";

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

/** SHA-256 hex digest used as the on-disk record file name. */
export function prKeyDigest(canonicalPrKey: string): string {
	return createHash("sha256").update(canonicalPrKey, "utf8").digest("hex");
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
