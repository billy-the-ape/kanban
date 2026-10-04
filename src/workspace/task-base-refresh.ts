/**
 * UPD-0: refresh an origin-backed base ref before creating a fresh task
 * worktree.
 *
 * The selected base ref is resolved to the latest `origin/<branch>` commit
 * and, when the base ref is a local branch, that local branch is safely
 * fast-forwarded to it. The update is deliberately conservative:
 *
 * - a checked-out base branch is only moved when its checkout is clean, has
 *   no in-flight merge/rebase/cherry-pick, and still points at the expected
 *   tip (re-verified right before the fast-forward);
 * - an unoccupied local branch is only moved with a compare-and-swap
 *   `git update-ref`, so a concurrent external change fails safely instead of
 *   overwriting work;
 * - the fetch is non-interactive and bounded, and diagnostics never include
 *   credentials from the remote URL;
 * - every failure is returned as a structured block (category + reason +
 *   remedy) that the start lifecycle surfaces verbatim.
 *
 * The local branch is never force-updated, reset, or rebased.
 */
import type { RuntimeTaskBaseRefreshFailure, RuntimeTaskBaseRefreshFailureCategory } from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { runGit } from "./git-utils";

/** Bounded fetch: a held/credential-prompting fetch must not hang a start. */
export const BASE_REFRESH_FETCH_TIMEOUT_MS = 60_000;

export interface TaskBaseRefreshSuccess {
	ok: true;
	/** The commit the new worktree must be created from (post-refresh). */
	baselineSha: string;
	/** refs/remotes/origin/<name> that was fetched for this refresh. */
	remoteTargetRef: string;
	/** Set when a local branch was moved (unoccupied or checked out). */
	localBranchUpdate: {
		branchRef: string;
		branchName: string;
		oldSha: string;
		newSha: string;
		checkedOutAt: string | null;
	} | null;
}

export interface TaskBaseRefreshBlocked {
	ok: false;
	failure: RuntimeTaskBaseRefreshFailure;
}

export type TaskBaseRefreshResult = TaskBaseRefreshSuccess | TaskBaseRefreshBlocked;

const LOCAL_AHEAD_OR_DIVERGED_REMEDY =
	"Push or reconcile the local commits on the base branch, or disable the update option and start from the local state.";
const RETRY_START_REMEDY = "Retry starting the task.";

/** Strip credentials that may be embedded in a remote URL or git diagnostics. */
function scrubCredentialsFromText(text: string): string {
	return text
		.replace(/(https?:\/\/)[^@\s/:]+:[^@\s/]+@/giu, "$1***:***@")
		.replace(/(https?:\/\/)[^@\s/:]+@/giu, "$1***@");
}

function toDiagnostic(diagnostic: string): string {
	const scrubbed = scrubCredentialsFromText(diagnostic).replace(/\s+/g, " ").trim();
	return scrubbed.length > 0 ? scrubbed.slice(0, 1000) : "no diagnostics available";
}

function getFetchEnv(): NodeJS.ProcessEnv {
	// GIT_TERMINAL_PROMPT=0: a missing credential must fail fast (bounded,
	// structured) instead of blocking the start on an interactive prompt.
	return createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" });
}

type BlockedFailure = (
	category: RuntimeTaskBaseRefreshFailureCategory,
	reason: string,
	remedy: string,
) => TaskBaseRefreshBlocked;

function isAncestor(repoPath: string, ancestorSha: string, descendantSha: string): Promise<boolean | null> {
	return runGit(repoPath, ["merge-base", "--is-ancestor", ancestorSha, descendantSha]).then((result) => {
		if (result.ok) {
			return true;
		}
		if (result.exitCode === 1) {
			return false;
		}
		return null;
	});
}

function detectInFlightOperation(worktreePath: string): Promise<string | null> {
	return runGit(worktreePath, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).then((mergeHead) => {
		if (mergeHead.ok && mergeHead.stdout) {
			return "merge";
		}
		return runGit(worktreePath, ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"]).then((cherryPick) => {
			if (cherryPick.ok && cherryPick.stdout) {
				return "cherry-pick";
			}
			return runGit(worktreePath, ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]).then((rebase) => {
				if (rebase.ok && rebase.stdout) {
					return "rebase";
				}
				return runGit(worktreePath, ["rev-parse", "--verify", "--quiet", "REVERT_HEAD"]).then((revert) => {
					if (revert.ok && revert.stdout) {
						return "revert";
					}
					return null;
				});
			});
		});
	});
}

function findBranchCheckoutPath(repoPath: string, branchName: string): Promise<string | null> {
	const branchRef = `refs/heads/${branchName}`;
	return runGit(repoPath, ["worktree", "list", "--porcelain"], { trimStdout: false }).then((result) => {
		if (!result.ok) {
			return null;
		}
		const lines = result.stdout.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			if (lines[i] !== `branch ${branchRef}`) {
				continue;
			}
			for (let j = i - 1; j >= 0; j -= 1) {
				const line = lines[j];
				if (line.startsWith("worktree ")) {
					return line.slice("worktree ".length);
				}
				if (line.length === 0) {
					break;
				}
			}
			return null;
		}
		return null;
	});
}

function fetchOriginTargets(
	repoPath: string,
	selectedRef: string,
	remoteBranch: string,
	failure: BlockedFailure,
): Promise<string | TaskBaseRefreshBlocked> {
	const genericFetch = runGit(repoPath, ["fetch", "origin"], {
		timeoutMs: BASE_REFRESH_FETCH_TIMEOUT_MS,
		env: getFetchEnv(),
	});
	return genericFetch.then(async (result) => {
		if (!result.ok) {
			return failure(
				"auth_or_network_timeout",
				`Fetching the origin for base ref "${selectedRef}" failed: ${toDiagnostic(result.stderr || result.output)}`,
				"Check network access and origin credentials, then start the task again.",
			);
		}
		// Refresh the exact remote-tracking ref even when the configured fetch
		// refspec is restrictive (it may not cover the selected base branch).
		const explicitFetch = await runGit(
			repoPath,
			["fetch", "origin", `+refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`],
			{
				timeoutMs: BASE_REFRESH_FETCH_TIMEOUT_MS,
				env: getFetchEnv(),
			},
		);
		if (!explicitFetch.ok) {
			return failure(
				"missing_remote_branch",
				`Remote branch "origin/${remoteBranch}" was not found or could not be fetched: ${toDiagnostic(
					explicitFetch.stderr || explicitFetch.output,
				)}`,
				"Restore the remote branch, select a different base ref, or disable the update option and start from the local state.",
			);
		}
		const targetResult = await runGit(repoPath, [
			"rev-parse",
			"--verify",
			`refs/remotes/origin/${remoteBranch}^{commit}`,
		]);
		if (!targetResult.ok) {
			return failure(
				"missing_remote_branch",
				`Remote branch "origin/${remoteBranch}" has no resolvable commit.`,
				"Restore the remote branch, select a different base ref, or disable the update option and start from the local state.",
			);
		}
		return targetResult.stdout;
	});
}

async function updateLocalBranchSafely(
	repoPath: string,
	branchName: string,
	targetSha: string,
	failure: BlockedFailure,
): Promise<TaskBaseRefreshSuccess["localBranchUpdate"] | TaskBaseRefreshBlocked> {
	const branchRef = `refs/heads/${branchName}`;
	const oldShaResult = await runGit(repoPath, ["rev-parse", "--verify", `${branchRef}^{commit}`]);
	if (!oldShaResult.ok) {
		return failure(
			"unsupported_ref",
			`Local branch "${branchName}" could not be resolved to a commit while preparing the start.`,
			"Select a valid base ref, or disable the update option and start from the local state.",
		);
	}
	const oldSha = oldShaResult.stdout;
	if (oldSha === targetSha) {
		// Equal tip: successful no-op, nothing to move.
		return null;
	}

	const checkoutPath = await findBranchCheckoutPath(repoPath, branchName);
	if (checkoutPath !== null) {
		// The branch is checked out: re-verify its state immediately before
		// mutating (a concurrent checkout switch or external change must block).
		const headBranch = await runGit(checkoutPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
		if (!headBranch.ok || headBranch.stdout !== branchName) {
			return failure(
				"concurrent_change",
				`The checkout of base branch "${branchName}" changed while preparing the start.`,
				RETRY_START_REMEDY,
			);
		}
		const status = await runGit(checkoutPath, ["status", "--porcelain"]);
		if (!status.ok) {
			return failure(
				"concurrent_change",
				`Could not verify the working tree of the base branch "${branchName}" checkout.`,
				RETRY_START_REMEDY,
			);
		}
		if (status.stdout.length > 0) {
			return failure(
				"dirty_checkout",
				`The selected base branch "${branchName}" is checked out with local changes, so Kanban will not move it.`,
				`Commit, stash, or discard the changes in the checkout of "${branchName}", or disable the update option and start from the local state.`,
			);
		}
		const inFlight = await detectInFlightOperation(checkoutPath);
		if (inFlight !== null) {
			return failure(
				"dirty_checkout",
				`A ${inFlight} is in progress in the checkout of base branch "${branchName}", so Kanban will not move it.`,
				`Finish or abort the ${inFlight} in that checkout, or disable the update option and start from the local state.`,
			);
		}
		const currentTip = await runGit(checkoutPath, ["rev-parse", "HEAD^{commit}"]);
		if (!currentTip.ok) {
			return failure(
				"concurrent_change",
				`Could not read the current tip of base branch "${branchName}" while preparing the start.`,
				RETRY_START_REMEDY,
			);
		}
		if (currentTip.stdout !== oldSha) {
			return failure(
				"concurrent_change",
				`Base branch "${branchName}" moved while preparing the start (expected ${oldSha.slice(0, 8)}, found ${currentTip.stdout.slice(0, 8)}).`,
				RETRY_START_REMEDY,
			);
		}
		const isAhead = await isAncestor(repoPath, currentTip.stdout, targetSha);
		if (isAhead === null) {
			return failure(
				"concurrent_change",
				`Could not verify that origin state is reachable from base branch "${branchName}".`,
				RETRY_START_REMEDY,
			);
		}
		if (!isAhead) {
			const localAhead = await isAncestor(repoPath, targetSha, currentTip.stdout);
			return failure(
				"local_ahead_or_diverged",
				localAhead
					? `Local branch "${branchName}" has commits that are not on origin, so Kanban will not move it.`
					: `Local branch "${branchName}" has diverged from origin, so Kanban will not move it.`,
				LOCAL_AHEAD_OR_DIVERGED_REMEDY,
			);
		}
		const mergeResult = await runGit(checkoutPath, ["merge", "--ff-only", targetSha]);
		if (!mergeResult.ok) {
			return failure(
				"concurrent_change",
				`Fast-forward of base branch "${branchName}" failed: ${toDiagnostic(mergeResult.stderr || mergeResult.output)}`,
				RETRY_START_REMEDY,
			);
		}
		return {
			branchRef,
			branchName,
			oldSha: currentTip.stdout,
			newSha: targetSha,
			checkedOutAt: checkoutPath,
		};
	}

	// Unoccupied branch: compare-and-swap so a concurrent external change
	// fails safely instead of being overwritten.
	const isAhead = await isAncestor(repoPath, oldSha, targetSha);
	if (isAhead === null) {
		return failure(
			"concurrent_change",
			`Could not verify that origin state is reachable from base branch "${branchName}".`,
			RETRY_START_REMEDY,
		);
	}
	if (!isAhead) {
		const localAhead = await isAncestor(repoPath, targetSha, oldSha);
		return failure(
			"local_ahead_or_diverged",
			localAhead
				? `Local branch "${branchName}" has commits that are not on origin, so Kanban will not move it.`
				: `Local branch "${branchName}" has diverged from origin, so Kanban will not move it.`,
			LOCAL_AHEAD_OR_DIVERGED_REMEDY,
		);
	}
	const updateResult = await runGit(repoPath, ["update-ref", branchRef, targetSha, oldSha]);
	if (!updateResult.ok) {
		return failure(
			"concurrent_change",
			`Base branch "${branchName}" changed concurrently and could not be updated safely: ${toDiagnostic(
				updateResult.stderr || updateResult.output,
			)}`,
			RETRY_START_REMEDY,
		);
	}
	return {
		branchRef,
		branchName,
		oldSha,
		newSha: targetSha,
		checkedOutAt: null,
	};
}

/**
 * Refresh the selected base ref against origin and return the baseline SHA a
 * fresh task worktree must be created from. Never moves a local branch except
 * by a verified fast-forward or a compare-and-swap update-ref.
 */
export async function refreshTaskBaseRef(options: {
	repoPath: string;
	baseRef: string;
}): Promise<TaskBaseRefreshResult> {
	const baseRef = options.baseRef.trim();
	const failure: BlockedFailure = (category, reason, remedy) => ({
		ok: false,
		failure: {
			category,
			reason,
			remedy,
			selectedRef: baseRef,
		},
	});

	const originUrl = await runGit(options.repoPath, ["remote", "get-url", "origin"]);
	if (!originUrl.ok) {
		return failure(
			"missing_origin",
			`This repository has no "origin" remote, so Kanban cannot refresh base ref "${baseRef}" from origin.`,
			"Add an origin remote (git remote add origin <url>), or disable the update option and start from the local state.",
		);
	}

	// Explicit origin remote-tracking ref (origin/<branch> or refs/remotes/...).
	let explicitRemoteBranch: string | null = null;
	if (baseRef.startsWith("origin/")) {
		const candidate = baseRef.slice("origin/".length);
		if (candidate.length > 0 && !candidate.includes("..") && !candidate.startsWith("/") && candidate !== "HEAD") {
			explicitRemoteBranch = candidate;
		}
	} else if (baseRef.startsWith("refs/remotes/origin/")) {
		const candidate = baseRef.slice("refs/remotes/origin/".length);
		if (candidate.length > 0 && !candidate.includes("..") && candidate !== "HEAD") {
			explicitRemoteBranch = candidate;
		}
	}

	if (explicitRemoteBranch !== null) {
		const targetSha = await fetchOriginTargets(options.repoPath, baseRef, explicitRemoteBranch, failure);
		if (typeof targetSha !== "string") {
			return targetSha;
		}
		return {
			ok: true,
			baselineSha: targetSha,
			remoteTargetRef: `refs/remotes/origin/${explicitRemoteBranch}`,
			localBranchUpdate: null,
		};
	}

	// Local branch (a "refs/heads/..." prefix is normalized away).
	const branchName = baseRef.startsWith("refs/heads/") ? baseRef.slice("refs/heads/".length) : baseRef;
	const localBranchCheck = await runGit(options.repoPath, [
		"rev-parse",
		"--verify",
		"--quiet",
		`refs/heads/${branchName}`,
	]);
	if (!localBranchCheck.ok) {
		// Not a local branch: a pinned SHA/tag/other ref cannot be refreshed
		// against origin in a controlled way.
		return failure(
			"unsupported_ref",
			`Base ref "${baseRef}" is not a local branch or an "origin/<branch>" ref, so Kanban cannot refresh it from origin.`,
			"Select a local branch or an origin/<branch> ref as the task base, or disable the update option and start from the local state.",
		);
	}

	const remoteConfig = await runGit(options.repoPath, ["config", `branch.${branchName}.remote`]);
	const mergeConfig = await runGit(options.repoPath, ["config", `branch.${branchName}.merge`]);
	const trackedRemote = remoteConfig.ok ? remoteConfig.stdout.trim() : null;
	const trackedMerge = mergeConfig.ok ? mergeConfig.stdout.trim() : null;

	if (trackedRemote !== null && trackedRemote !== "origin") {
		return failure(
			"unsupported_ref",
			`Local branch "${branchName}" tracks remote "${trackedRemote}", but this update is origin-based.`,
			`Point the branch at origin (git branch --set-upstream-to=origin/<branch> ${branchName}), or disable the update option and start from the local state.`,
		);
	}

	let remoteBranch: string;
	if (trackedRemote === "origin" && trackedMerge) {
		if (trackedMerge.startsWith("refs/heads/")) {
			remoteBranch = trackedMerge.slice("refs/heads/".length);
		} else {
			return failure(
				"unsupported_ref",
				`Local branch "${branchName}" has a misconfigured upstream (${trackedMerge}).`,
				"Fix the branch tracking (git branch --set-upstream-to=origin/<branch>), or disable the update option and start from the local state.",
			);
		}
	} else {
		// No origin tracking: fall back to the same-named origin branch when
		// it exists (without writing any upstream configuration).
		remoteBranch = branchName;
	}

	const targetSha = await fetchOriginTargets(options.repoPath, baseRef, remoteBranch, failure);
	if (typeof targetSha !== "string") {
		return targetSha;
	}

	const localResult = await updateLocalBranchSafely(options.repoPath, branchName, targetSha, failure);
	if (localResult !== null && "ok" in localResult) {
		// Blocked: surface the structured failure (ok is always false here).
		return localResult;
	}
	const localBranchUpdate = localResult;

	return {
		ok: true,
		baselineSha: targetSha,
		remoteTargetRef: `refs/remotes/origin/${remoteBranch}`,
		localBranchUpdate,
	};
}
