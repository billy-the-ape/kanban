// PCR: shared "is this checkout mid-operation?" probes.
//
// Extracted from `refreshCommentWorktree` (comment-git-refresh) so the PR
// conflict-repair dispatch guard and the comment git refresh ask the same
// question the same way: a half-finished merge/rebase/cherry-pick/revert must
// never be inherited by an automated turn, and unmerged index entries mean
// the working tree is not in a state where another merge may start.
import { stat } from "node:fs/promises";

import { createGitProcessEnv } from "../core/git-process-env";
import { runGit } from "./git-utils";

/** Sequencer/marker files git writes while an operation is in progress. */
export const GIT_OPERATION_MARKERS = [
	"MERGE_HEAD",
	"rebase-merge",
	"rebase-apply",
	"CHERRY_PICK_HEAD",
	"REVERT_HEAD",
	"sequencer",
] as const;

/** A git step that returns stdout and throws on any failure. */
export type GitStep = (args: string[]) => Promise<string>;

/**
 * True when any in-progress-operation marker exists in this checkout's git
 * directory. The `exec` step is supplied by the caller so timeouts, env, and
 * error wording stay with the caller's failure contract.
 */
export async function hasGitOperationInProgress(exec: GitStep): Promise<boolean> {
	for (const marker of GIT_OPERATION_MARKERS) {
		const path = await exec(["rev-parse", "--path-format=absolute", "--git-path", marker]);
		if (
			await stat(path).then(
				() => true,
				() => false,
			)
		) {
			return true;
		}
	}
	return false;
}

/** True when the index carries unmerged (conflicted) entries. */
export async function hasUnmergedIndexEntries(exec: GitStep): Promise<boolean> {
	const paths = await exec(["diff", "--name-only", "--diff-filter=U"]);
	return paths.trim().length > 0;
}

/** Runs one read-only git step in a checkout the caller does not own. */
async function runStep(cwd: string, args: string[]): Promise<string> {
	const result = await runGit(cwd, args, {
		timeoutMs: 10_000,
		env: createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
	});
	if (!result.ok) {
		throw new Error(result.error ?? `git ${args[0] ?? ""} failed`);
	}
	return result.stdout;
}

/**
 * Direct-`runGit` convenience wrappers for callers (like the conflict-repair
 * guard) that own no git helper of their own. A failed probe reports `true`
 * (fail closed): a checkout we cannot inspect is never "clean enough".
 */
export async function checkoutHasGitOperationInProgress(cwd: string): Promise<boolean> {
	try {
		return await hasGitOperationInProgress((args) => runStep(cwd, args));
	} catch {
		return true;
	}
}

export async function checkoutHasUnmergedIndexEntries(cwd: string): Promise<boolean> {
	try {
		return await hasUnmergedIndexEntries((args) => runStep(cwd, args));
	} catch {
		return true;
	}
}
