import { mkdir, readFile, writeFile } from "node:fs/promises";
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
/** Runs a concurrent writer right after the real fetch, before the refresh rechecks the checkout. */
const racingRunner =
	(race: () => Promise<unknown>): CommentGitRunner =>
	async (cwd, args, options) => {
		const result = await runner(cwd, args, options);
		if (args[0] === "fetch") await race();
		return result;
	};

/** The checked-out branch name, or null for a detached HEAD. */
async function attachedBranch(cwd = task) {
	const result = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (result.ok) return result.stdout;
	if (result.exitCode === 1) return null;
	throw new Error(result.error ?? "symbolic-ref failed");
}
const fetchRefs = (cwd = task) => git(cwd, "for-each-ref", "refs/kanban/comment-refresh");
async function commitLocal(cwd = task) {
	await git(
		cwd,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.com",
		"commit",
		"--allow-empty",
		"-m",
		"local work",
	);
	return git(cwd, "rev-parse", "HEAD");
}

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
		expect(await attachedBranch()).toBe("repair");
		expect(await fetchRefs()).toBe("");
	});
	it.each(["attached", "detached"].flatMap((mode) => ["unstaged", "staged", "untracked"].map((kind) => [kind, mode])))(
		"preserves %s changes on an %s HEAD and blocks before fetch",
		async (kind, mode) => {
			if (mode === "detached") await git(task, "checkout", "--detach");
			const head = await git(task, "rev-parse", "HEAD");
			await writeFile(join(task, kind === "untracked" ? "new.txt" : "file.txt"), "keep this\n");
			if (kind === "staged") await git(task, "add", ".");
			const before = await git(task, "status", "--porcelain=v1");
			await expect(refreshCommentWorktree(task, snapshot, signal(), runner)).rejects.toThrow("worktree has");
			expect(await git(task, "status", "--porcelain=v1")).toBe(before);
			expect(await readFile(join(task, kind === "untracked" ? "new.txt" : "file.txt"), "utf8")).toBe("keep this\n");
			expect(await git(task, "rev-parse", "HEAD")).toBe(head);
			expect(await attachedBranch()).toBe(mode === "detached" ? null : "repair");
			expect(await fetchRefs()).toBe("");
		},
	);
	it("blocks an ahead/divergent branch without altering local commits", async () => {
		const head = await commitLocal();
		await advanceRemote();
		await expect(refreshCommentWorktree(task, snapshot, signal(), runner)).rejects.toThrow("ahead of or diverged");
		expect(await git(task, "rev-parse", "HEAD")).toBe(head);
		expect(await fetchRefs()).toBe("");
	});
	it("blocks a different branch even when it points at the PR head", async () => {
		await git(task, "switch", "-c", "other");
		await expect(refreshCommentWorktree(task, snapshot, signal(), runner)).rejects.toThrow(
			"Expected PR branch repair; task is on other.",
		);
	});
	const failingSymbolicRef = (exitCode: number, failingCall = 1): CommentGitRunner => {
		let calls = 0;
		return (cwd, args, options) =>
			args[0] === "symbolic-ref" && ++calls === failingCall
				? Promise.resolve({ ok: false, stdout: "", stderr: "", output: "", error: "git failed", exitCode })
				: runner(cwd, args, options);
	};

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
	it.each([128, -1])(
		"does not read a failed (%i) post-fetch symbolic-ref recheck as an unchanged detached HEAD",
		async (exitCode) => {
			await git(task, "checkout", "--detach");
			const head = await git(task, "rev-parse", "HEAD");
			await advanceRemote();
			await expect(
				refreshCommentWorktree(task, snapshot, signal(), failingSymbolicRef(exitCode, 2)),
			).rejects.toThrow("Git refresh failed (symbolic-ref)");
			expect(await git(task, "rev-parse", "HEAD")).toBe(head);
			expect(await fetchRefs()).toBe("");
		},
	);
	it("blocks a racing remote update and a mismatched remote repository", async () => {
		const old = snapshot.headSha;
		await advanceRemote();
		snapshot.headSha = old;
		await expect(refreshCommentWorktree(task, snapshot, signal(), runner)).rejects.toThrow("changed during refresh");
		expect(await git(task, "rev-parse", "HEAD")).toBe(old);
		expect(await fetchRefs()).toBe("");
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

describe("safe PR repair Git refresh on detached task worktrees", () => {
	it("proceeds when a detached HEAD already matches the PR head, without attaching a branch", async () => {
		await git(task, "checkout", "--detach");
		const branchTip = await git(task, "rev-parse", "refs/heads/repair");
		expect(await refreshCommentWorktree(task, snapshot, signal(), runner)).toBe(snapshot.headSha);
		expect(await git(task, "rev-parse", "HEAD")).toBe(snapshot.headSha);
		expect(await attachedBranch()).toBeNull();
		expect(await git(task, "rev-parse", "refs/heads/repair")).toBe(branchTip);
		expect(await fetchRefs()).toBe("");
	});
	it("fast-forwards a behind detached HEAD, its checkout, and its index while staying detached", async () => {
		await git(task, "checkout", "--detach");
		const branchTip = await git(task, "rev-parse", "refs/heads/repair");
		await advanceRemote();
		expect(await refreshCommentWorktree(task, snapshot, signal(), runner)).toBe(snapshot.headSha);
		expect(await git(task, "rev-parse", "HEAD")).toBe(snapshot.headSha);
		expect(await attachedBranch()).toBeNull();
		expect(await readFile(join(task, "file.txt"), "utf8")).toBe("remote update\n");
		expect(await git(task, "rev-parse", ":file.txt")).toBe(await git(task, "rev-parse", "HEAD:file.txt"));
		expect(await git(task, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
		expect(await git(task, "rev-parse", "refs/heads/repair")).toBe(branchTip);
		expect(await fetchRefs()).toBe("");
	});
	it("repairs a linked detached worktree without moving the PR branch checked out elsewhere", async () => {
		const worktree = join(env.home, "worktree");
		await git(task, "worktree", "add", "--detach", worktree);
		const branchTip = await git(task, "rev-parse", "refs/heads/repair");
		await advanceRemote();
		expect(await refreshCommentWorktree(worktree, snapshot, signal(), runner)).toBe(snapshot.headSha);
		expect(await git(worktree, "rev-parse", "HEAD")).toBe(snapshot.headSha);
		expect(await attachedBranch(worktree)).toBeNull();
		expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("remote update\n");
		expect(await attachedBranch(task)).toBe("repair");
		expect(await git(task, "rev-parse", "HEAD")).toBe(branchTip);
		expect(await readFile(join(task, "file.txt"), "utf8")).toBe("base\n");
		expect(await git(task, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
		expect(await fetchRefs(worktree)).toBe("");
	});
	it.each(["ahead", "divergent"])(
		"blocks a detached HEAD that is %s of the PR head and keeps its commits",
		async (shape) => {
			await git(task, "checkout", "--detach");
			const head = await commitLocal();
			if (shape === "divergent") await advanceRemote();
			await expect(refreshCommentWorktree(task, snapshot, signal(), runner)).rejects.toThrow("ahead of or diverged");
			expect(await git(task, "rev-parse", "HEAD")).toBe(head);
			expect(await attachedBranch()).toBeNull();
			expect(await fetchRefs()).toBe("");
		},
	);
	it("blocks an in-progress Git operation in a linked detached worktree", async () => {
		const worktree = join(env.home, "worktree");
		await git(task, "worktree", "add", "--detach", worktree);
		await mkdir(await git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"));
		await expect(refreshCommentWorktree(worktree, snapshot, signal(), runner)).rejects.toThrow(
			"operation is already in progress",
		);
	});
	it("blocks when the detached HEAD commit changes during fetch", async () => {
		await git(task, "checkout", "--detach");
		await advanceRemote();
		let racedHead = "";
		const raced = racingRunner(async () => {
			racedHead = await commitLocal();
		});
		await expect(refreshCommentWorktree(task, snapshot, signal(), raced)).rejects.toThrow(
			"checkout changed during refresh",
		);
		expect(await git(task, "rev-parse", "HEAD")).toBe(racedHead);
		expect(await attachedBranch()).toBeNull();
		expect(await fetchRefs()).toBe("");
	});
	it.each([
		["detached", "attached", ["checkout", "repair"]],
		["attached", "detached", ["checkout", "--detach"]],
	])("blocks when HEAD goes from %s to %s at the same commit during fetch", async (initial, _next, race) => {
		if (initial === "detached") await git(task, "checkout", "--detach");
		const head = await git(task, "rev-parse", "HEAD");
		await advanceRemote();
		const raced = racingRunner(() => git(task, ...race));
		await expect(refreshCommentWorktree(task, snapshot, signal(), raced)).rejects.toThrow(
			"checkout changed during refresh",
		);
		expect(await attachedBranch()).toBe(initial === "detached" ? "repair" : null);
		expect(await git(task, "rev-parse", "HEAD")).toBe(head);
		expect(await git(task, "rev-parse", "refs/heads/repair")).toBe(head);
		expect(await fetchRefs()).toBe("");
	});
});
