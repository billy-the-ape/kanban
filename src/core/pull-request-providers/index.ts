// PRLINK-9: shared pull-request provider policy entry points.
//
// Pure modules (no exec, no Node-only imports, no environment) so they can
// be imported by both the runtime and the web-ui. The server-side entry
// points (`src/core/pull-request-links.ts`, `src/core/pull-request-detection.ts`)
// re-expose these policies.
export {
	getPullRequestProviderCapabilities,
	PULL_REQUEST_PROVIDER_CAPABILITIES,
	type PullRequestProviderCapabilities,
	supportsBranchDiscovery,
	supportsPrMetadataRefresh,
} from "./capabilities";
export {
	commandHasPrCreatingSegment,
	isPrCreatingCommand,
	isPrCreatingMcpTool,
} from "./creation-command-gate";
export {
	type BranchDiscoveryContext,
	resolveBranchDiscoveryContext,
} from "./remote-context";
export {
	extractPullRequestLinks,
	getPullRequestIdentityKey,
	isValidHostAuthority,
	KNOWN_PROVIDER_HOSTS,
	type ParsedPullRequestLink,
	parsePullRequestUrl,
	toPositivePrNumber,
} from "./url-parser";
