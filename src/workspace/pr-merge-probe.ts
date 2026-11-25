// PCR-1: the advisory local merge probe.
//
// Answers "would the task checkout's current commit merge cleanly into the
// latest remote base?" WITHOUT any provider read, for hosts where Kanban has
// no mergeability API (GHE/GitLab/no gh). The probe mirrors
// `refreshCommentWorktree`'s ref hygiene — a scoped `--no-tags
// --no-write-fetch-head` fetch into a throwaway ref under
// `refs/kanban/merge-probe/`, deleted afterwards, no working-tree or HEAD
// mutation of any kind — then runs `git merge-tree --write-tree`, which
// performs a real 3-way merge into an object database temp result and never
// touches the checkout.
//
// Advisory only: merge-tree follows LOCAL merge drivers (`.gitattributes
// merge=binary|ours|theirs`), its own rename heuristics, and LFS pointers,
// and it cannot see provider-side merge state at all. Callers must label the
// result (`source: "local_probe"`) and never render a local "clean" as a
// provider-confirmed green light.
import { randomUUID } from "node:crypto";

import { createGitProcessEnv } from "../core/git-process-env";
import { runGit } from "./git-utils";

export type MergeProbeRunner = typeof runGit;

export type MergeProbeOutcome = "clean" | "conflicting" | "failed";

export interface MergeProbeResult {
	outcome: MergeProbeOutcome;
	/** The fetched base tip the probe merged against (null when unavailable). */
	baseSha: string | null;
	/** The checkout's HEAD commit the probe treated as the PR head. */
	headSha: string | null;
	/** Populated when `outcome === "failed"`. */
	error: string | null;
}

export interface MergeProbeInput {
	/** The task worktree whose HEAD commit is the merge head. */
	cwd: string;
	/** The base branch to fetch and merge into the head. */
	baseRef: string;
	/**
	 * `owner/repo` of the PR's base repository (used to pick the matching
	 * remote); the first remote wins when absent or unmatched only if it is
	 * literally `origin`.
	 */
	baseRepository: string | null;
	runner?: MergeProbeRunner;
	signal?: AbortSignal;
}

const PROBE_TIMEOUT_MS = 30_000;

/**
 * Parses a git remote URL into `{ host, repository }` (host lowercased,
 * `owner/repo` as written). Handles scp-like `git@host:owner/repo.git`,
 * `ssh://git@host/owner/repo.git`, and `https://host/owner/repo.git` forms.
 * Local paths and unparseable URLs return null.
 */
export function parseGitRemoteRepository(url: string): { host: string; repository: string } | null {
	const trimmed = url.trim();
	if (trimmed.length === 0) {
		return null;
	}
	const scheme = trimmed.match(/^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/i);
	if (scheme) {
		const host = scheme[1];
		const repository = scheme[2];
		if (host === undefined || repository === undefined) {
			return null;
		}
		return { host: host.toLowerCase(), repository: repository.replace(/\/+$/, "") };
	}
	// scp-like syntax: [user@]host:owner/repo(.git) — the colon separates the
	// host from the path, which distinguishes it from a local path.
	const scp = trimmed.match(/^(?:[^@/]+@)?([^:/\\s]+):(.+?)(?:\.git)?\/?$/);
	if (scp) {
		const host = scp[1];
		const repository = scp[2];
		if (host === undefined || repository === undefined) {
			return null;
		}
		return { host: host.toLowerCase(), repository: repository.replace(/\/+$/, "") };
	}
	return null;
}

/** `owner/repo` comparison is case-insensitive on both sides. */
function sameRepository(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

async function findRemoteForRepository(
	cwd: string,
	repository: string,
	runner: MergeProbeRunner,
	signal?: AbortSignal,
): Promise<string | null> {
	signal?.throwIfAborted();
	const remotes = await runner(cwd, ["remote"], {
		timeoutMs: PROBE_TIMEOUT_MS,
		env: createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
	});
	if (!remotes.ok) {
		return null;
	}
	for (const name of remotes.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)) {
		signal?.throwIfAborted();
		const url = await runner(cwd, ["remote", "get-url", name], {
			timeoutMs: PROBE_TIMEOUT_MS,
			env: createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
		});
		if (!url.ok) {
			continue;
		}
		const parsed = parseGitRemoteRepository(url.stdout);
		if (parsed !== null && sameRepository(parsed.repository, repository)) {
			return name;
		}
	}
	return null;
}

/**
 * Probes whether `HEAD` of `cwd` merges cleanly into the freshly fetched
 * remote base branch. Never mutates the working tree, the index, or HEAD.
 */
export async function probeMergeConflictAgainstBase(input: MergeProbeInput): Promise<MergeProbeResult> {
	const runner = input.runner ?? runGit;
	const { cwd, baseRef, signal } = input;
	const env = createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" });
	const run = async (args: string[]): Promise<string> => {
		signal?.throwIfAborted();
		const result = await runner(cwd, args, { timeoutMs: PROBE_TIMEOUT_MS, env });
		signal?.throwIfAborted();
		if (!result.ok) {
			throw new Error(result.error ?? `git ${args[0] ?? ""} failed`);
		}
		return result.stdout;
	};
	const baseRepository = input.baseRepository?.trim() || null;
	const refFormat = await runner(cwd, ["check-ref-format", `refs/heads/${baseRef}`], {
		timeoutMs: PROBE_TIMEOUT_MS,
		env,
	});
	if (!refFormat.ok) {
		return { outcome: "failed", baseSha: null, headSha: null, error: "The base branch name is invalid." };
	}
	let headSha: string | null = null;
	try {
		headSha = await run(["rev-parse", "HEAD"]);
	} catch {
		return { outcome: "failed", baseSha: null, headSha: null, error: "The task checkout has no HEAD commit." };
	}
	// Pick the remote that actually carries the base repository; `origin` is
	// the fallback only when no remote matches (the common single-remote case).
	let remote: string | null = null;
	if (baseRepository !== null) {
		remote = await findRemoteForRepository(cwd, baseRepository, runner, signal);
	}
	if (remote === null) {
		const origin = await runner(cwd, ["remote", "get-url", "origin"], { timeoutMs: PROBE_TIMEOUT_MS, env });
		remote = origin.ok ? "origin" : null;
	}
	if (remote === null || remote.startsWith("-")) {
		return { outcome: "failed", baseSha: null, headSha, error: "No configured Git remote carries the base branch." };
	}
	const fetchRef = `refs/kanban/merge-probe/${randomUUID()}`;
	let baseSha: string | null = null;
	let outcome: MergeProbeOutcome = "failed";
	let error: string | null = null;
	try {
		await run(["fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/heads/${baseRef}:${fetchRef}`]);
		baseSha = await run(["rev-parse", fetchRef]);
		// merge-tree's exit codes: 0 = merged cleanly, 1 = conflicts, ≥128 =
		// operational error. `<head> <base>` order makes the checkout's HEAD
		// "ours", matching how the repair turn merges (base into head).
		const merge = await runner(cwd, ["merge-tree", "--write-tree", "HEAD", fetchRef], {
			timeoutMs: PROBE_TIMEOUT_MS,
			env,
		});
		if (merge.ok || merge.exitCode === 0) {
			outcome = "clean";
		} else if (merge.exitCode === 1) {
			outcome = "conflicting";
		} else {
			outcome = "failed";
			error = merge.error ?? "The local merge probe could not run.";
		}
	} catch (probeError) {
		outcome = "failed";
		error = probeError instanceof Error ? probeError.message : String(probeError);
	} finally {
		await runner(cwd, ["update-ref", "-d", fetchRef], { timeoutMs: 5_000 });
	}
	return { outcome, baseSha, headSha, error };
}
