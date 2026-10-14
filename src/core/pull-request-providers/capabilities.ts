// PRLINK-9: workspace provider capabilities.
//
// Capabilities are declared per provider and are INTERFACE declarations, not
// a claim of full provider support in this milestone:
// - github: branch discovery (gh CLI against the origin remote, github.com
//   and GitHub Enterprise) and explicit metadata refresh (github.com only,
//   through the shared tracking coordinator).
// - gitlab (including self-hosted): parsing/manual links and creation
//   detection only.
// - bitbucket cloud: parsing/manual links only.
import type { RuntimeTaskPullRequestProvider } from "../api-contract";

export interface PullRequestProviderCapabilities {
	/** Best-effort branch lookup for the task's current branch. */
	branchDiscovery: boolean;
	/** Explicit one-shot metadata refresh of already-linked PRs. */
	metadataRefresh: boolean;
}

export const PULL_REQUEST_PROVIDER_CAPABILITIES: Readonly<
	Record<RuntimeTaskPullRequestProvider, PullRequestProviderCapabilities>
> = {
	github: { branchDiscovery: true, metadataRefresh: true },
	gitlab: { branchDiscovery: false, metadataRefresh: false },
	bitbucket: { branchDiscovery: false, metadataRefresh: false },
};

export function getPullRequestProviderCapabilities(
	provider: RuntimeTaskPullRequestProvider,
): PullRequestProviderCapabilities {
	return PULL_REQUEST_PROVIDER_CAPABILITIES[provider];
}

/**
 * Whether an explicit metadata refresh may query a provider for this PR
 * identity. Only github.com is refreshable: the shared tracking coordinator
 * resolves a runtime github.com credential, and arbitrary self-hosted
 * pasted links never receive a provider query in this milestone.
 */
export function supportsPrMetadataRefresh(pr: { provider: RuntimeTaskPullRequestProvider; host: string }): boolean {
	return pr.provider === "github" && pr.host === "github.com";
}

/** Whether the provider supports best-effort branch discovery at all. */
export function supportsBranchDiscovery(provider: RuntimeTaskPullRequestProvider): boolean {
	return PULL_REQUEST_PROVIDER_CAPABILITIES[provider].branchDiscovery;
}
