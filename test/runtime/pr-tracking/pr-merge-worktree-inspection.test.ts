import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultInspectWorktree } from "../../../src/pr-tracking/pr-merge-completion";
import { runGit } from "../../../src/workspace/git-utils";
import { createGitTestEnv } from "../../utilities/git-env";

const GIT_TEST_ENV = createGitTestEnv();
const UNKNOWN_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await runGit(cwd, args, { env: GIT_TEST_ENV });
	if (!result.ok) {
		throw new Error(`git ${args.join(" ")} failed: ${result.error ?? "unknown git error"}`);
	}
	return result.stdout;
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<void> {
	writeFileSync(join(cwd, file), content);
	await git(cwd, ["add", "-A"]);
	await git(cwd, ["commit", "-m", message]);
}

/**
 * A local repository where `task` (commits B, C on top of A) was merged into
 * `main` (A, D + the merge commit) with a real merge commit, plus a linked
 * worktree checked out on `task`.
 */
async function makeMergedFixture(
	root: string,
	label: string,
): Promise<{
	repo: string;
	worktree: string;
	headSha: string;
	mergeSha: string;
}> {
	const repo = join(root, `repo-${label}`);
	mkdirSync(repo);
	await git(repo, ["init", "-b", "main"]);
	await commitFile(repo, "a.txt", "A", "A");
	await git(repo, ["checkout", "-b", "task"]);
	await commitFile(repo, "b.txt", "B", "B");
	await commitFile(repo, "c.txt", "C", "C");
	await git(repo, ["checkout", "main"]);
	await commitFile(repo, "d.txt", "D", "D");
	await git(repo, ["merge", "--no-ff", "task", "-m", "merge task"]);
	const mergeSha = await git(repo, ["rev-parse", "HEAD"]);
	const headSha = await git(repo, ["rev-parse", "task"]);
	const worktree = join(root, `worktree-${label}`);
	await git(repo, ["worktree", "add", worktree, "task"]);
	return { repo, worktree, headSha, mergeSha };
}

function inspect(input: { repo: string; worktreePath: string | null; mergeSha: string; headSha: string | null }) {
	return defaultInspectWorktree({
		workspacePath: input.repo,
		worktreePath: input.worktreePath,
		baseRef: "main",
		baseRepository: null,
		mergeCommitSha: input.mergeSha,
		finalHeadSha: input.headSha,
	});
}

describe("defaultInspectWorktree (real git repositories)", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "kanban-merge-inspect-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("verifies a merge-commit merge: the PR work is not counted as local commits", async () => {
		const fixture = await makeMergedFixture(root, "merge");
		const result = await inspect({
			repo: fixture.repo,
			worktreePath: fixture.worktree,
			mergeSha: fixture.mergeSha,
			headSha: fixture.headSha,
		});
		expect(result.baseContainsMerge).toBe(true);
		expect(result.aheadOfBase).toBe(0);
		expect(result.dirty).toBe(false);
		expect(result.worktreeHead).toBe(fixture.headSha);
	});

	it("counts only commits that are neither in base nor in the merged PR head", async () => {
		const fixture = await makeMergedFixture(root, "local-work");
		// A genuine local commit on top of the (already merged) task branch.
		await commitFile(fixture.worktree, "e.txt", "E", "local work");
		const result = await inspect({
			repo: fixture.repo,
			worktreePath: fixture.worktree,
			mergeSha: fixture.mergeSha,
			headSha: fixture.headSha,
		});
		expect(result.baseContainsMerge).toBe(true);
		expect(result.aheadOfBase).toBe(1);
	});

	it("does not flag a squash-merged PR as local commits", async () => {
		const repo = join(root, "repo-squash");
		mkdirSync(repo);
		await git(repo, ["init", "-b", "main"]);
		await commitFile(repo, "a.txt", "A", "A");
		await git(repo, ["checkout", "-b", "task"]);
		await commitFile(repo, "b.txt", "B", "B");
		await commitFile(repo, "c.txt", "C", "C");
		await git(repo, ["checkout", "main"]);
		await commitFile(repo, "d.txt", "D", "D");
		await git(repo, ["merge", "--squash", "task"]);
		await git(repo, ["commit", "-m", "squashed task"]);
		const mergeSha = await git(repo, ["rev-parse", "HEAD"]);
		const headSha = await git(repo, ["rev-parse", "task"]);
		const worktree = join(root, "worktree-squash");
		await git(repo, ["worktree", "add", worktree, "task"]);
		// The task's own commits (B, C) are NOT ancestors of the squash
		// commit: a plain base..HEAD count would read 2 and block the merge.
		const result = await inspect({ repo, worktreePath: worktree, mergeSha, headSha });
		expect(result.baseContainsMerge).toBe(true);
		expect(result.aheadOfBase).toBe(0);
	});

	it("does not flag a rebase-merged PR as local commits", async () => {
		const repo = join(root, "repo-rebase");
		mkdirSync(repo);
		await git(repo, ["init", "-b", "main"]);
		await commitFile(repo, "a.txt", "A", "A");
		await git(repo, ["checkout", "-b", "task"]);
		await commitFile(repo, "b.txt", "B", "B");
		await commitFile(repo, "c.txt", "C", "C");
		await git(repo, ["checkout", "main"]);
		await commitFile(repo, "d.txt", "D", "D");
		await git(repo, ["checkout", "task"]);
		await git(repo, ["rebase", "main"]);
		await git(repo, ["checkout", "main"]);
		await git(repo, ["merge", "--ff-only", "task"]);
		const mergeSha = await git(repo, ["rev-parse", "main"]);
		const headSha = await git(repo, ["rev-parse", "task"]);
		const worktree = join(root, "worktree-rebase");
		await git(repo, ["worktree", "add", worktree, "task"]);
		const result = await inspect({ repo, worktreePath: worktree, mergeSha, headSha });
		expect(result.baseContainsMerge).toBe(true);
		expect(result.aheadOfBase).toBe(0);
	});

	it("reports baseContainsMerge=false when the base branch lacks the merge commit", async () => {
		const repo = join(root, "repo-unmerged");
		mkdirSync(repo);
		await git(repo, ["init", "-b", "main"]);
		await commitFile(repo, "a.txt", "A", "A");
		await git(repo, ["checkout", "-b", "task"]);
		await commitFile(repo, "b.txt", "B", "B");
		const mergeSha = await git(repo, ["rev-parse", "task"]);
		const result = await inspect({ repo, worktreePath: null, mergeSha, headSha: null });
		expect(result.baseContainsMerge).toBe(false);
		expect(result.worktreePath).toBeNull();
		expect(result.aheadOfBase).toBe(0);
	});

	it("throws (retryable) when the merge commit is not available locally and no remote exists", async () => {
		const fixture = await makeMergedFixture(root, "unknown");
		await expect(
			inspect({
				repo: fixture.repo,
				worktreePath: fixture.worktree,
				mergeSha: UNKNOWN_SHA,
				headSha: fixture.headSha,
			}),
		).rejects.toThrow(/not available locally/);
	});

	it("throws (retryable) when the PR head is unavailable and the ahead-of-base count cannot be verified", async () => {
		const fixture = await makeMergedFixture(root, "no-head");
		await expect(
			inspect({ repo: fixture.repo, worktreePath: fixture.worktree, mergeSha: fixture.mergeSha, headSha: null }),
		).rejects.toThrow(/cannot be verified/);
	});

	it("verifies a just-merged PR through a best-effort remote fetch when the local base is stale", async () => {
		// Upstream has merged the task (main contains the merge commit).
		const upstream = join(root, "upstream");
		mkdirSync(upstream);
		await git(upstream, ["init", "-b", "main"]);
		await commitFile(upstream, "u1.txt", "U1", "U1");
		await git(upstream, ["checkout", "-b", "task"]);
		await commitFile(upstream, "u2.txt", "U2", "U2");
		await git(upstream, ["checkout", "main"]);
		await commitFile(upstream, "u3.txt", "U3", "U3");
		const u3Sha = await git(upstream, ["rev-parse", "main"]);
		await git(upstream, ["merge", "--no-ff", "task", "-m", "merge task"]);
		const upstreamMergeSha = await git(upstream, ["rev-parse", "HEAD"]);
		const taskSha = await git(upstream, ["rev-parse", "task"]);

		// The workspace is a clone whose LOCAL main is rewound to U3: the
		// merge commit is not in the local base branch yet. Only the
		// best-effort remote fetch can make the verification succeed.
		const workspace = join(root, "workspace");
		await git(root, ["clone", upstream, workspace]);
		await git(workspace, ["reset", "--hard", u3Sha]);
		const worktree = join(root, "worktree-remote");
		await git(workspace, ["worktree", "add", worktree, "task"]);

		const result = await inspect({
			repo: workspace,
			worktreePath: worktree,
			mergeSha: upstreamMergeSha,
			headSha: taskSha,
		});
		// The verification must use the fetched (fresh) base, not the stale
		// local main: against the stale local main the merge commit would not
		// be an ancestor.
		expect(result.baseSha).toBe(upstreamMergeSha);
		expect(result.baseContainsMerge).toBe(true);
		expect(result.aheadOfBase).toBe(0);
	});
});
