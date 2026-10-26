import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { createGitProcessEnv } from "../core/git-process-env";
import { runGit } from "../workspace/git-utils";
import type { GitHubPrSnapshot } from "./github-pr-client";

export type CommentGitRunner = typeof runGit;

const CHECKOUT_CHANGED = "The task checkout changed during refresh. Resume after other writers finish.";

/** Kanban task worktrees are detached by default; a task may still be attached to the PR branch. */
type HeadAttachment = { kind: "detached" } | { kind: "branch"; name: string };

function isSameAttachment(left: HeadAttachment, right: HeadAttachment): boolean {
	if (left.kind === "detached" || right.kind === "detached") return left.kind === right.kind;
	return left.name === right.name;
}

/**
 * Fast-forwards a clean detached HEAD or PR-branch checkout to the verified PR head.
 * Never attaches, creates, or switches a branch, and performs no reset, stash, rebase,
 * checkout, merge commit, push, or force update of a user branch.
 */
export async function refreshCommentWorktree(
	cwd: string,
	snapshot: GitHubPrSnapshot,
	signal: AbortSignal,
	runner: CommentGitRunner = runGit,
): Promise<string> {
	const { headSha, headRef, headRepository } = snapshot;
	if (!headSha || !headRef || !headRepository || !/^[\w.-]+\/[\w.-]+$/.test(headRepository)) {
		throw new Error("The PR head branch/repository could not be verified.");
	}
	const git = async (args: string[]) => {
		signal.throwIfAborted();
		const result = await runner(cwd, args, {
			timeoutMs: 30_000,
			env: createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
		});
		signal.throwIfAborted();
		if (!result.ok) throw new Error(`Git refresh failed (${args[0]}). Check repository access and retry.`);
		return result.stdout;
	};
	const readAttachment = async (): Promise<HeadAttachment> => {
		signal.throwIfAborted();
		const symbolicRef = await runner(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
			timeoutMs: 30_000,
			env: createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
		});
		signal.throwIfAborted();
		if (symbolicRef.ok) return { kind: "branch", name: symbolicRef.stdout };
		// Exit code 1 means HEAD is not a branch ref (detached HEAD); fatal git
		// errors (128), timeouts and spawn failures (normalized to -1 by
		// runGit) keep the generic retry message.
		if (symbolicRef.exitCode === 1) return { kind: "detached" };
		throw new Error(`Git refresh failed (symbolic-ref). Check repository access and retry.`);
	};
	await git(["check-ref-format", `refs/heads/${headRef}`]);
	const attachment = await readAttachment();
	if (attachment.kind === "branch" && attachment.name !== headRef)
		throw new Error(`Expected PR branch ${headRef}; task is on ${attachment.name}.`);
	for (const marker of [
		"MERGE_HEAD",
		"rebase-merge",
		"rebase-apply",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"sequencer",
	]) {
		const path = await git(["rev-parse", "--path-format=absolute", "--git-path", marker]);
		if (
			await stat(path).then(
				() => true,
				() => false,
			)
		)
			throw new Error("A Git operation is already in progress.");
	}
	const assertClean = async () => {
		if (await git(["status", "--porcelain=v1", "--untracked-files=all"])) {
			throw new Error(
				"The task worktree has staged, unstaged, or untracked changes. Preserve/commit them before resuming.",
			);
		}
	};
	const assertSameAttachment = async () => {
		if (!isSameAttachment(await readAttachment(), attachment)) throw new Error(CHECKOUT_CHANGED);
	};
	await assertClean();
	const originalHead = await git(["rev-parse", "HEAD"]);
	let remote: string | null = null;
	for (const name of (await git(["remote"])).split("\n").filter(Boolean)) {
		const url = await git(["remote", "get-url", name]);
		const repository = url.match(
			/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s]+?)(?:\.git)?\/?$/,
		)?.[1];
		if (repository?.toLowerCase() === headRepository.toLowerCase()) {
			remote = name;
			break;
		}
	}
	if (!remote || remote.startsWith("-")) throw new Error("No configured Git remote matches the PR head repository.");
	const fetchRef = `refs/kanban/comment-refresh/${randomUUID()}`;
	try {
		await git(["fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/heads/${headRef}:${fetchRef}`]);
		const fetchedHead = await git(["rev-parse", fetchRef]);
		if (fetchedHead !== headSha)
			throw new Error("The PR branch changed during refresh. Resume to capture its new state.");
		await assertClean();
		if ((await git(["rev-parse", "HEAD"])) !== originalHead) throw new Error(CHECKOUT_CHANGED);
		// A detach/attach transition is a concurrent change even when the commit is unchanged.
		await assertSameAttachment();
		if (originalHead !== fetchedHead) {
			const ancestor = await runner(cwd, ["merge-base", "--is-ancestor", originalHead, fetchedHead]);
			if (!ancestor.ok)
				throw new Error(
					"The task checkout is ahead of or diverged from the PR head. Reconcile it before resuming.",
				);
			// Fast-forwards the checkout and index; a detached HEAD stays detached.
			await git(["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--no-edit", fetchedHead]);
		}
		await assertClean();
		const finalHead = await git(["rev-parse", "HEAD"]);
		if (finalHead !== headSha) throw new Error("The task HEAD no longer matches the captured PR head.");
		await assertSameAttachment();
		return finalHead;
	} finally {
		await runner(cwd, ["update-ref", "-d", fetchRef], { timeoutMs: 5_000 });
	}
}
