import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CommentGitRunner, refreshCommentWorktree } from "../../../src/pr-tracking/comment-git-refresh";
import type { GitHubPrSnapshot } from "../../../src/pr-tracking/github-pr-client";
import { runGit } from "../../../src/workspace/git-utils";
import { isolateTestEnvironment } from "../../utilities/test-environment";

let env: ReturnType<typeof isolateTestEnvironment>;
let remote: string;
let task: string;
let snapshot: GitHubPrSnapshot;
const signal = () => new AbortController().signal;
async function git(cwd: string, ...args: string[]) {
	const result = await runGit(cwd, args);
	if (!result.ok) throw new Error(result.error ?? "git failed");
	return result.stdout;
}
const runner: CommentGitRunner = (cwd, args, options) =>
	runGit(cwd, args[0] === "fetch" ? args.map((arg) => (arg === "origin" ? remote : arg)) : args, options);

beforeEach(async () => {
	env = isolateTestEnvironment();
	remote = join(env.home, "remote");
	task = join(env.home, "task");
	await mkdir(remote);
	await git(remote, "init", "-b", "repair");
	await git(remote, "config", "user.name", "Fixture");
	await git(remote, "config", "user.email", "fixture@example.com");
	await writeFile(join(remote, "file.txt"), "base\n");
	await git(remote, "add", ".");
	await git(remote, "commit", "-m", "base");
	await git(env.home, "clone", remote, task);
	await git(task, "remote", "set-url", "origin", "https://github.com/octo/repo.git");
	snapshot = {
		complete: true,
		authError: null,
		prState: "open",
		headSha: await git(remote, "rev-parse", "HEAD"),
		headRef: "repair",
		headRepository: "octo/repo",
		htmlUrl: null,
		events: [],
	};
});
afterEach(() => env.cleanup());

async function advanceRemote() {
	await writeFile(join(remote, "file.txt"), "remote update\n");
	await git(remote, "add", ".");
	await git(remote, "commit", "-m", "remote update");
	snapshot.headSha = await git(remote, "rev-parse", "HEAD");
}

describe("safe PR repair Git refresh", () => {
	it("fast-forwards a clean behind branch and removes its temporary fetch ref", async () => {
		await advanceRemote();
		expect(await refreshCommentWorktree(task, snapshot, signal(), runner)).toBe(snapshot.headSha);
		expect(await git(task, "rev-parse", "HEAD")).toBe(snapshot.headSha);
		expect(await git(task, "for-each-ref", "refs/kanban/comment-refresh")).toBe("");
	});
	it.each(["unstaged", "staged", "untracked"])("preserves %s changes and blocks before fetch", async (kind) => {
		await writeFile(join(task, kind === "untracked" ? "new.txt" : "file.txt"), "keep this\n");
		if (kind === "staged") await git(task, "add", ".");
		const before = await git(task, "status", "--porcelain=v1");
		await expect(refreshCommentWorktree(task, snapshot, signal(), runner)).rejects.toThrow("worktree has");
		expect(await git(task, "status", "--porcelain=v1")).toBe(before);
	});
	it("blocks an ahead/divergent branch without altering local commits", async () => {
		await git(
			task,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.com",
			"commit",
			"--allow-empty",
			"-m",
			"local work",
		);
		const head = await git(task, "rev-parse", "HEAD");
		await advanceRemote();
		await expect(refreshCommentWorktree(task, snapshot, signal(), runner)).rejects.toThrow("ahead of or diverged");
		expect(await git(task, "rev-parse", "HEAD")).toBe(head);
	});
	it("blocks a different branch and detached HEAD", async () => {
		await git(task, "switch", "-c", "other");
		await expect(refreshCommentWorktree(task, snapshot, signal(), runner)).rejects.toThrow("Expected PR branch");
		await git(task, "checkout", "--detach");
		await expect(refreshCommentWorktree(task, snapshot, signal(), runner)).rejects.toThrow("detached HEAD");
	});
	const failingSymbolicRef =
		(exitCode: number): CommentGitRunner =>
		(cwd, args, options) =>
			args[0] === "symbolic-ref"
				? Promise.resolve({ ok: false, stdout: "", stderr: "", output: "", error: "git failed", exitCode })
				: runGit(cwd, args, options);

	it("keeps the generic retry message when symbolic-ref times out or fails to spawn", async () => {
		await expect(refreshCommentWorktree(task, snapshot, signal(), failingSymbolicRef(-1))).rejects.toThrow(
			"Git refresh failed (symbolic-ref)",
		);
	});
	it("keeps the generic retry message on a fatal symbolic-ref error", async () => {
		await expect(refreshCommentWorktree(task, snapshot, signal(), failingSymbolicRef(128))).rejects.toThrow(
			"Git refresh failed (symbolic-ref)",
		);
	});
	it("blocks a racing remote update and a mismatched remote repository", async () => {
		const old = snapshot.headSha;
		await advanceRemote();
		snapshot.headSha = old;
		await expect(refreshCommentWorktree(task, snapshot, signal(), runner)).rejects.toThrow("changed during refresh");
		expect(await git(task, "rev-parse", "HEAD")).toBe(old);
		snapshot.headRepository = "someone/else";
		await expect(refreshCommentWorktree(task, snapshot, signal(), runner)).rejects.toThrow(
			"No configured Git remote",
		);
	});
	it("blocks an in-progress Git operation even when its worktree is clean", async () => {
		await mkdir(join(task, ".git", "rebase-merge"));
		await expect(refreshCommentWorktree(task, snapshot, signal(), runner)).rejects.toThrow(
			"operation is already in progress",
		);
	});
});
