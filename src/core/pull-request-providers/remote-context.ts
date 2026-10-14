// PRLINK-9: branch-discovery context resolution from the origin remote.
//
// The provider and repository for a branch lookup come from the task
// worktree's ORIGIN remote (HTTPS, SSH, or scp form) — never from a card
// title or from an arbitrary first linked PR. A missing, malformed, or
// unrecognized remote yields no discovery (null), never a guessed GitHub
// repository. Bitbucket/GitLab public hosts, nested (non owner/repo) paths,
// and IPv6 authorities are unrecognized. Unknown hosts are treated as
// GitHub Enterprise (the gh CLI queries the origin remote directly).
import { isValidHostAuthority } from "./url-parser";

export interface BranchDiscoveryContext {
	provider: "github";
	/** Lowercase host, including an explicit nondefault port when present. */
	host: string;
	/** "owner/repo". */
	repository: string;
}

const KNOWN_FOREIGN_PROVIDER_HOSTS: ReadonlySet<string> = new Set(["gitlab.com", "bitbucket.org"]);
const REPOSITORY_SEGMENT_PATTERN = /^[a-z0-9._-]+$/i;
const PORT_PATTERN = /^\d{1,5}$/;

function isValidPort(raw: string): boolean {
	if (!PORT_PATTERN.test(raw)) {
		return false;
	}
	const value = Number(raw);
	return value >= 1 && value <= 65535;
}

function isValidRepositorySegment(segment: string): boolean {
	return segment.length > 0 && REPOSITORY_SEGMENT_PATTERN.test(segment);
}

/**
 * Parse the remote path down to an "owner/repo" pair. Strips a trailing
 * ".git" from the repository name. Requires EXACTLY two path segments:
 * nested groups (self-hosted GitLab layouts) are unrecognized.
 */
function parseRepositoryPath(path: string): string | null {
	const parts = path.split("/").filter((segment) => segment.length > 0);
	if (parts.length !== 2) {
		return null;
	}
	const [owner, repo] = parts;
	if (!owner || !repo) {
		return null;
	}
	if (!isValidRepositorySegment(owner)) {
		return null;
	}
	const name = repo.toLowerCase().endsWith(".git") ? repo.slice(0, -4) : repo;
	if (!isValidRepositorySegment(name)) {
		return null;
	}
	return `${owner}/${name}`;
}

function contextFor(host: string, repository: string): BranchDiscoveryContext | null {
	const hostnameOnly = host.split(":")[0] ?? "";
	if (!isValidHostAuthority(hostnameOnly)) {
		return null;
	}
	// Known foreign providers are never guessed as GitHub.
	if (KNOWN_FOREIGN_PROVIDER_HOSTS.has(hostnameOnly)) {
		return null;
	}
	return { provider: "github", host, repository };
}

/**
 * Resolve the branch-discovery context from an origin remote URL. Supports
 * `https://[user@]host[:port]/owner/repo[.git]`, `ssh://[user@]host[:port]/owner/repo[.git]`,
 * and the scp form `[user@]host:owner/repo[.git]`. Returns null for missing,
 * malformed, or unrecognized remotes.
 */
export function resolveBranchDiscoveryContext(originRemoteUrl: string | null): BranchDiscoveryContext | null {
	const candidate = originRemoteUrl?.trim();
	if (!candidate) {
		return null;
	}
	let host: string;
	let path: string;
	if (candidate.includes("://")) {
		const schemeIndex = candidate.indexOf("://");
		const scheme = candidate.slice(0, schemeIndex).toLowerCase();
		if (scheme !== "https" && scheme !== "ssh") {
			return null;
		}
		const rest = candidate.slice(schemeIndex + 3);
		const slashIndex = rest.indexOf("/");
		if (slashIndex <= 0) {
			return null;
		}
		const authority = rest.slice(0, slashIndex);
		path = rest.slice(slashIndex + 1);
		const atIndex = authority.lastIndexOf("@");
		const hostPort = atIndex === -1 ? authority : authority.slice(atIndex + 1);
		const colonIndex = hostPort.lastIndexOf(":");
		if (colonIndex !== -1) {
			const hostname = hostPort.slice(0, colonIndex);
			const port = hostPort.slice(colonIndex + 1);
			if (!isValidPort(port) || hostname.includes(":")) {
				return null;
			}
			host = `${hostname.toLowerCase()}:${port}`;
		} else {
			if (hostPort.includes(":")) {
				return null;
			}
			host = hostPort.toLowerCase();
		}
	} else {
		// scp form: [user@]host:owner/repo[.git]
		const colonIndex = candidate.indexOf(":");
		if (colonIndex <= 0) {
			return null;
		}
		const authority = candidate.slice(0, colonIndex);
		path = candidate.slice(colonIndex + 1);
		const atIndex = authority.lastIndexOf("@");
		const hostname = atIndex === -1 ? authority : authority.slice(atIndex + 1);
		if (hostname.includes(":")) {
			return null;
		}
		host = hostname.toLowerCase();
	}
	const repository = parseRepositoryPath(path);
	if (!repository) {
		return null;
	}
	return contextFor(host, repository);
}
