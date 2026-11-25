// PCR-1: the advisory local merge probe over real Git fixtures.
//
// A bare origin plus a detached task checkout, exercising the shapes the
// probe must classify correctly: a disjoint (clean) merge, an overlapping
// edit (conflict), a rename the merge heuristics can follow, and a
// delete/modify pair. Also pins the hygiene contract: HEAD, the working
// tree, and the ref namespace are untouched once the probe finishes.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../../../src/workspace/git-utils";
import { parseGitRemoteRepository, probeMergeConflictAgainstBase } from "../../../src/workspace/pr-merge-probe";
import { createGitTestEnv } from "../../utilities/git-env";
import { isolateTestEnvironment } from "../../utilities/test-environment";

let env: ReturnType<typeof isolateTestEnvironment>;
let origin: string;
let seed: string;
let task: string;

async function git(cwd: string, ...args: string[]) {
	const result = await runGit(cwd, args, { env: createGitTestEnv() });
	if (!result.ok) {
		throw new Error(`git ${args.join(" ")} failed: ${result.error ?? result.stderr}`);
	}
	return result.stdout;
}

async function commitAll(cwd: string, message: string) {
	await git(cwd, "add", "-A");
	await git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", message);
	return git(cwd, "rev-parse", "HEAD");
}

async function writeAndCommit(cwd: string, file: string, content: string, message: string) {
	await writeFile(join(cwd, file), content);
	return commitAll(cwd, message);
}

beforeEach(async () => {
	env = isolateTestEnvironment();
	origin = join(env.home, "origin.git");
	seed = join(env.home, "seed");
	task = join(env.home, "task");
	await mkdir(origin);
	await git(origin, "init", "--bare", "-b", "main", origin);
	await mkdir(seed);
	await git(seed, "init", "-b", "main");
	await git(seed, "config", "user.name", "Fixture");
	await git(seed, "config", "user.email", "fixture@example.com");
	await writeFile(join(seed, "shared.ts"), "export const value = 1;\n");
	await writeFile(join(seed, "legacy.ts"), "export const legacy = true;\n");
	await commitAll(seed, "initial");
	await git(seed, "remote", "add", "origin", origin);
	await git(seed, "push", "origin", "main");
	// Task checkout: the PR head, detached (the Kanban default).
	await git(seed, "checkout", "-b", "feature");
	await git(env.home, "clone", origin, task);
	await git(task, "config", "user.name", "Fixture");
	await git(task, "config", "user.email", "fixture@example.com");
});

afterEach(() => {
	env.cleanup();
});

/** Pushes the seed checkout's current branch and fast-forwards the detached task. */
async function syncTaskWithSeed() {
	await git(seed, "push", "origin", "feature");
	const head = await git(seed, "rev-parse", "HEAD");
	await git(task, "fetch", "origin");
	await git(task, "checkout", "--detach", head);
}

describe("probeMergeConflictAgainstBase", () => {
	it("reports clean when the head and base touch different files", async () => {
		await writeAndCommit(seed, "feature.ts", "export const feature = 1;\n", "head work");
		await syncTaskWithSeed();
		await writeAndCommit(seed, "base.ts", "export const base = 1;\n", "base work");
		await git(seed, "checkout", "main");
		await git(seed, "push", "origin", "main");
		const result = await probeMergeConflictAgainstBase({
			cwd: task,
			baseRef: "main",
			baseRepository: "fixture/repo",
		});
		expect(result.outcome).toBe("clean");
		expect(result.baseSha).not.toBeNull();
		expect(result.headSha).not.toBeNull();
		expect(result.error).toBeNull();
	});

	it("reports conflicting when both sides edited the same lines", async () => {
		await writeAndCommit(seed, "shared.ts", "export const value = 2;\n", "head edit");
		await syncTaskWithSeed();
		await git(seed, "checkout", "main");
		await writeAndCommit(seed, "shared.ts", "export const value = 3;\n", "base edit");
		await git(seed, "push", "origin", "main");
		const result = await probeMergeConflictAgainstBase({ cwd: task, baseRef: "main", baseRepository: null });
		expect(result.outcome).toBe("conflicting");
	});

	it("follows renames the way git merge heuristics do (advisory by design)", async () => {
		// Head renames legacy.ts -> kept.ts; the base edits the OLD path. The
		// rename heuristic follows the move, so this merges cleanly — exactly
		// the local-heuristic behavior the advisory contract documents.
		await git(seed, "mv", "legacy.ts", "kept.ts");
		await commitAll(seed, "head rename");
		await syncTaskWithSeed();
		await git(seed, "checkout", "main");
		await writeAndCommit(seed, "legacy.ts", "export const legacy = 'moved';\n", "base edit");
		await git(seed, "push", "origin", "main");
		const result = await probeMergeConflictAgainstBase({ cwd: task, baseRef: "main", baseRepository: null });
		expect(result.outcome).toBe("clean");
	});

	it("flags delete/modify as conflicting", async () => {
		await git(seed, "rm", "legacy.ts");
		await commitAll(seed, "head delete");
		await syncTaskWithSeed();
		await git(seed, "checkout", "main");
		await writeAndCommit(seed, "legacy.ts", "export const legacy = false;\n", "base edit");
		await git(seed, "push", "origin", "main");
		const result = await probeMergeConflictAgainstBase({ cwd: task, baseRef: "main", baseRepository: null });
		expect(result.outcome).toBe("conflicting");
	});

	it("never mutates HEAD, the working tree, or the ref namespace", async () => {
		await writeAndCommit(seed, "feature.ts", "x\n", "head work");
		await syncTaskWithSeed();
		const headBefore = await git(task, "rev-parse", "HEAD");
		const result = await probeMergeConflictAgainstBase({ cwd: task, baseRef: "main", baseRepository: null });
		expect(result.outcome).not.toBe("failed");
		expect(await git(task, "rev-parse", "HEAD")).toBe(headBefore);
		expect(await git(task, "status", "--porcelain")).toBe("");
		// The throwaway fetch refs are always removed.
		expect(await git(task, "for-each-ref", "refs/kanban/merge-probe")).toBe("");
	});

	it("fails with an explanatory error when no remote carries the base branch", async () => {
		// No matching remote AND no origin at all: the probe refuses instead of
		// guessing a fetch source.
		await git(task, "remote", "remove", "origin");
		const result = await probeMergeConflictAgainstBase({
			cwd: task,
			baseRef: "main",
			baseRepository: "someone/else",
		});
		expect(result.outcome).toBe("failed");
		expect(result.error).toContain("No configured Git remote");
	});
});

describe("parseGitRemoteRepository", () => {
	it("parses https, ssh, and scp-like remote forms", () => {
		expect(parseGitRemoteRepository("https://github.com/Octo/Repo.git")).toEqual({
			host: "github.com",
			repository: "Octo/Repo",
		});
		expect(parseGitRemoteRepository("ssh://git@github.com/Octo/Repo")).toEqual({
			host: "github.com",
			repository: "Octo/Repo",
		});
		expect(parseGitRemoteRepository("git@github.com:Octo/Repo.git")).toEqual({
			host: "github.com",
			repository: "Octo/Repo",
		});
		// The scp host class must be real whitespace exclusion (`\\s` in a
		// regex literal is backslash + "s", which silently rejected every host
		// containing an "s" and made fork heads look un-pushable).
		expect(parseGitRemoteRepository("git@ssh.github.com:Octo/Repo.git")).toEqual({
			host: "ssh.github.com",
			repository: "Octo/Repo",
		});
		expect(parseGitRemoteRepository("https://ghe.example.com/team/app.git")).toEqual({
			host: "ghe.example.com",
			repository: "team/app",
		});
	});

	it("returns null for local paths and empty values", () => {
		expect(parseGitRemoteRepository("/srv/repo")).toBeNull();
		expect(parseGitRemoteRepository("")).toBeNull();
	});
});
