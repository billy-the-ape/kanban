import { describe, expect, it } from "vitest";

import { getPullRequestIdentityKey } from "../../../src/core/pull-request-links";
import {
	isTrackingSupportedPr,
	parseCanonicalPrKey,
	prKeyDigest,
	recordIdentityMatchesKey,
	toCanonicalPrKey,
} from "../../../src/pr-tracking/pr-identity";

const PR = { provider: "github" as const, host: "github.com", repository: "cline/kanban", number: 49 };

describe("pr-identity", () => {
	it("reuses the PR-linking identity key verbatim", () => {
		expect(toCanonicalPrKey(PR)).toBe(getPullRequestIdentityKey(PR));
	});

	it("parses valid canonical keys", () => {
		const parsed = parseCanonicalPrKey("github|github.com|cline/kanban|49");
		expect(parsed).toEqual({ provider: "github", host: "github.com", repository: "cline/kanban", number: 49 });
	});

	it.each([
		"not-a-key",
		"github|github.com|cline/kanban|0",
		"github|github.com|cline/kanban|-4",
		"github|github.com|cline/kanban|4.5",
		"github|github.com|cline/kanban|abc",
		"github|GitHub.com|cline/kanban|49",
		"github|github.com|Cline/kanban|49",
	])("rejects malformed keys: %s", (key) => {
		expect(parseCanonicalPrKey(key)).toBeNull();
	});

	it("parses valid non-github.com keys but only supports github.com", () => {
		expect(parseCanonicalPrKey("gitlab|ghe.corp|team/repo|7")).not.toBeNull();
		expect(isTrackingSupportedPr("gitlab|ghe.corp|team/repo|7")).toBe(false);
		expect(isTrackingSupportedPr("github|ghe.corp|cline/kanban|49")).toBe(false);
		expect(isTrackingSupportedPr("not-a-key")).toBe(false);
	});

	it("computes a stable 64-hex-char sha256 digest", () => {
		const digest = prKeyDigest("github|github.com|cline/kanban|49");
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(prKeyDigest("github|github.com|cline/kanban|49")).toBe(digest);
	});

	it("validates composite identity against the key", () => {
		const record = {
			canonicalPrKey: "github|github.com|cline/kanban|49",
			provider: "github",
			host: "github.com",
			repository: "cline/kanban",
			number: 49,
		};
		expect(recordIdentityMatchesKey(record, "github|github.com|cline/kanban|49")).toBe(true);
		expect(recordIdentityMatchesKey({ ...record, number: 50 }, "github|github.com|cline/kanban|49")).toBe(false);
	});
});
