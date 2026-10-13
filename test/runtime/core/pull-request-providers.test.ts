// PRLINK-9: provider capabilities, the PR-creation command gate, and the
// branch-discovery context resolver. Pure modules: no I/O.
import { describe, expect, it } from "vitest";

import type { RuntimeTaskPullRequest } from "../../../src/core/api-contract";
import {
	getPullRequestProviderCapabilities,
	PULL_REQUEST_PROVIDER_CAPABILITIES,
	supportsBranchDiscovery,
	supportsPrMetadataRefresh,
} from "../../../src/core/pull-request-providers/capabilities";
import {
	commandHasPrCreatingSegment,
	isPrCreatingCommand,
	isPrCreatingMcpTool,
	tokenizeCommandFragment,
} from "../../../src/core/pull-request-providers/creation-command-gate";
import { resolveBranchDiscoveryContext } from "../../../src/core/pull-request-providers/remote-context";
import { extractPullRequestLinks, parsePullRequestUrl } from "../../../src/core/pull-request-providers/url-parser";

describe("provider capabilities", () => {
	it("declares branch discovery and metadata refresh for github only", () => {
		expect(PULL_REQUEST_PROVIDER_CAPABILITIES).toEqual({
			github: { branchDiscovery: true, metadataRefresh: true },
			gitlab: { branchDiscovery: false, metadataRefresh: false },
			bitbucket: { branchDiscovery: false, metadataRefresh: false },
		});
	});

	it("exposes capabilities per provider", () => {
		expect(getPullRequestProviderCapabilities("github")).toEqual({
			branchDiscovery: true,
			metadataRefresh: true,
		});
		expect(getPullRequestProviderCapabilities("gitlab")).toEqual({
			branchDiscovery: false,
			metadataRefresh: false,
		});
		expect(getPullRequestProviderCapabilities("bitbucket")).toEqual({
			branchDiscovery: false,
			metadataRefresh: false,
		});
	});

	it("supports branch discovery for github only", () => {
		expect(supportsBranchDiscovery("github")).toBe(true);
		expect(supportsBranchDiscovery("gitlab")).toBe(false);
		expect(supportsBranchDiscovery("bitbucket")).toBe(false);
	});

	it("supports explicit metadata refresh only for github.com links", () => {
		expect(supportsPrMetadataRefresh({ provider: "github", host: "github.com" })).toBe(true);
		// GitHub Enterprise hosts are never queried in this milestone.
		expect(supportsPrMetadataRefresh({ provider: "github", host: "ghe.corp.io" })).toBe(false);
		expect(supportsPrMetadataRefresh({ provider: "gitlab", host: "gitlab.com" })).toBe(false);
		expect(supportsPrMetadataRefresh({ provider: "bitbucket", host: "bitbucket.org" })).toBe(false);
	});
});

function _entry(overrides: Partial<RuntimeTaskPullRequest>): RuntimeTaskPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "owner/repo",
		number: 12,
		url: "https://github.com/owner/repo/pull/12",
		source: "manual",
		createdAt: 0,
		...overrides,
	};
}

describe("PR-creation command gate", () => {
	it("recognizes the creating commands and rejects reads", () => {
		expect(isPrCreatingCommand(tokenizeCommandFragment("gh pr create --title x"))).toBe(true);
		expect(isPrCreatingCommand(tokenizeCommandFragment("glab mr create --title x"))).toBe(true);
		expect(isPrCreatingCommand(tokenizeCommandFragment("hub pull-request -r o/r"))).toBe(true);
		expect(isPrCreatingCommand(tokenizeCommandFragment("git push -o merge_request.create"))).toBe(true);
		// Reads / other actions never create.
		expect(isPrCreatingCommand(tokenizeCommandFragment("gh pr view 88"))).toBe(false);
		expect(isPrCreatingCommand(tokenizeCommandFragment("gh pr merge 88"))).toBe(false);
		expect(isPrCreatingCommand(tokenizeCommandFragment("git push origin main"))).toBe(false);
		expect(isPrCreatingCommand(tokenizeCommandFragment("echo hello"))).toBe(false);
	});

	it("gates whole commands that contain a creating fragment", () => {
		expect(commandHasPrCreatingSegment("cd repo && gh pr create --body-file notes.md")).toBe(true);
		expect(commandHasPrCreatingSegment("git push -o merge_request.create origin feature")).toBe(true);
		expect(commandHasPrCreatingSegment("gh pr view 88")).toBe(false);
	});

	it("recognizes MCP creation tools only", () => {
		expect(isPrCreatingMcpTool("mcp_github_create_pull_request")).toBe(true);
		expect(isPrCreatingMcpTool("mcp_gitlab_create_merge_request")).toBe(true);
		expect(isPrCreatingMcpTool("mcp_github_get_pull_request")).toBe(false);
		expect(isPrCreatingMcpTool(null)).toBe(false);
	});
});

describe("branch-discovery context from the origin remote", () => {
	it("resolves an https github.com remote", () => {
		expect(resolveBranchDiscoveryContext("https://github.com/owner/repo.git")).toEqual({
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
		});
	});

	it("resolves an ssh and an scp remote, stripping .git", () => {
		expect(resolveBranchDiscoveryContext("ssh://git@github.com/owner/repo.git")).toEqual({
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
		});
		expect(resolveBranchDiscoveryContext("git@github.com:owner/repo.git")).toEqual({
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
		});
	});

	it("keeps an explicit nondefault port in the host", () => {
		expect(resolveBranchDiscoveryContext("https://github.com:8443/owner/repo")).toEqual({
			provider: "github",
			host: "github.com:8443",
			repository: "owner/repo",
		});
	});

	it("treats unknown hosts as GitHub Enterprise (never a guess error)", () => {
		expect(resolveBranchDiscoveryContext("https://ghe.corp.io/owner/repo")).toEqual({
			provider: "github",
			host: "ghe.corp.io",
			repository: "owner/repo",
		});
	});

	it("rejects known foreign hosts, nested paths, and malformed remotes", () => {
		expect(resolveBranchDiscoveryContext("https://gitlab.com/group/project")).toBeNull();
		expect(resolveBranchDiscoveryContext("https://bitbucket.org/owner/repo")).toBeNull();
		// Self-hosted GitLab nested (non owner/repo) layout.
		expect(resolveBranchDiscoveryContext("https://gitlab.corp.io/group/sub/project")).toBeNull();
		// Missing/extra path segments.
		expect(resolveBranchDiscoveryContext("https://github.com/owner")).toBeNull();
		expect(resolveBranchDiscoveryContext("https://github.com/owner/repo/extra")).toBeNull();
		// Bad scheme / IPv6 / malformed port.
		expect(resolveBranchDiscoveryContext("http://github.com/owner/repo")).toBeNull();
		expect(resolveBranchDiscoveryContext("https://[::1]/owner/repo")).toBeNull();
		expect(resolveBranchDiscoveryContext("https://github.com:99999/owner/repo")).toBeNull();
		expect(resolveBranchDiscoveryContext(null)).toBeNull();
		expect(resolveBranchDiscoveryContext("   ")).toBeNull();
	});
});

describe("URL link classification", () => {
	it("parses pull and merge-request URLs and rejects issues/PR-new/compare", () => {
		expect(parsePullRequestUrl("https://github.com/owner/repo/pull/12")?.number).toBe(12);
		expect(parsePullRequestUrl("https://gitlab.com/group/project/-/merge_requests/7")?.number).toBe(7);
		// Not creation links: issues, `pull/new/...` (push output), compare.
		expect(parsePullRequestUrl("https://github.com/owner/repo/issues/12")).toBeNull();
		expect(parsePullRequestUrl("https://github.com/owner/repo/pull/new/feature")).toBeNull();
		expect(parsePullRequestUrl("https://github.com/owner/repo/compare/main...head")).toBeNull();
	});

	it("extractPullRequestLinks keeps only PR/MR links in first-appearance order", () => {
		const text = [
			"See https://github.com/owner/repo/issues/5 and",
			"https://github.com/owner/repo/pull/12 plus",
			"https://github.com/owner/repo/pull/new/feature and",
			"https://github.com/owner/repo/pull/13",
		].join("\n");
		expect(extractPullRequestLinks(text).map((link) => link.number)).toEqual([12, 13]);
	});
});
