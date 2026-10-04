import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createGitTestEnv } from "./git-env";
import { createTempDir } from "./temp-dir";
import { isolateTestEnvironment } from "./test-environment";

// Capture at import time: isolation must happen before application imports.
const importedHome = homedir();
const importedSdkDirectory = process.env.CLINE_DIR;

describe("root test environment", () => {
	it("isolates home and SDK storage before test imports", () => {
		expect(importedHome).toBe(process.env.HOME);
		expect(importedHome).toContain("kanban-test-home-");
		expect(process.env.USERPROFILE).toBe(importedHome);
		expect(importedSdkDirectory).toBe(join(importedHome, ".cline"));
		expect(process.env.GIT_DIR).toBeUndefined();
		expect(process.env.GIT_WORK_TREE).toBeUndefined();
		expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
	});

	it("restores inherited variables and removes temporary storage on cleanup", () => {
		const env = {
			HOME: "/original/home",
			USERPROFILE: "/original/profile",
			CLINE_DIR: "/original/sdk",
			CLINE_LOG_PATH: "/original/log",
			XDG_CONFIG_HOME: "/original/config",
			GIT_DIR: "/original/repository",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.bare",
			GIT_CONFIG_VALUE_0: "true",
			PATH: process.env.PATH,
		};
		const previous = { ...env };
		const isolated = isolateTestEnvironment(env);
		try {
			expect(env.GIT_DIR).toBeUndefined();
			expect(env.GIT_CONFIG_COUNT).toBeUndefined();
			writeFileSync(join(env.CLINE_DIR, "session.json"), "{}");
			expect(existsSync(join(isolated.home, ".cline", "session.json"))).toBe(true);
		} finally {
			isolated.cleanup();
		}
		isolated.cleanup();
		expect(env).toEqual(previous);
		expect(existsSync(isolated.home)).toBe(false);
	});

	it("keeps bare initialization and fixture commits out of a contaminated linked worktree", () => {
		const sandbox = createTempDir("kanban-routing-regression-");
		let isolated: ReturnType<typeof isolateTestEnvironment> | undefined;
		try {
			const repo = join(sandbox.path, "repo");
			const worktree = join(sandbox.path, "task");
			const originalHome = join(sandbox.path, "user-home");
			mkdirSync(repo);
			mkdirSync(originalHome);
			const git = (cwd: string, args: string[], env = createGitTestEnv()) =>
				execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
			git(repo, ["init", "-q"]);
			writeFileSync(join(repo, "original.txt"), "original\n");
			git(repo, ["add", "."]);
			git(repo, ["commit", "-qm", "original"]);
			git(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);
			const gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"]);
			const configPath = join(repo, ".git", "config");
			const indexPath = join(gitDir, "index");
			const beforeConfig = readFileSync(configPath);
			const beforeIndex = readFileSync(indexPath);
			const beforeHead = git(worktree, ["rev-parse", "HEAD"]);
			const globalConfig = join(originalHome, ".gitconfig");
			writeFileSync(globalConfig, "[user]\n\tname = Real User\n");
			const env = {
				...process.env,
				HOME: originalHome,
				USERPROFILE: originalHome,
				CLINE_DIR: join(originalHome, ".cline"),
				GIT_DIR: gitDir,
				GIT_COMMON_DIR: join(repo, ".git"),
				GIT_WORK_TREE: worktree,
				GIT_INDEX_FILE: indexPath,
				GIT_CONFIG_GLOBAL: globalConfig,
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "core.bare",
				GIT_CONFIG_VALUE_0: "true",
			};
			isolated = isolateTestEnvironment(env);
			const remote = join(sandbox.path, "remote.git");
			const fixture = join(sandbox.path, "fixture");
			mkdirSync(fixture);
			// No per-command helper: exercise the environment used by SDK tools too.
			git(fixture, ["init", "--bare", "-q", remote], env);
			expect(git(remote, ["rev-parse", "--is-bare-repository"], env)).toBe("true");
			git(fixture, ["init", "-q"], env);
			writeFileSync(join(fixture, "fixture.txt"), "fixture\n");
			git(fixture, ["add", "."], env);
			git(
				fixture,
				["-c", "user.name=Fixture", "-c", "user.email=fixture@test.local", "commit", "-qm", "fixture"],
				env,
			);
			expect(git(fixture, ["ls-files"], env)).toBe("fixture.txt");
			expect(spawnSync("git", ["config", "--global", "--get", "user.name"], { cwd: fixture, env }).status).toBe(1);
			writeFileSync(join(env.CLINE_DIR, "session.json"), "{}");
			expect(existsSync(join(originalHome, ".cline"))).toBe(false);
			expect(readFileSync(globalConfig, "utf8")).toBe("[user]\n\tname = Real User\n");
			expect(readFileSync(configPath)).toEqual(beforeConfig);
			expect(readFileSync(indexPath)).toEqual(beforeIndex);
			expect(git(worktree, ["rev-parse", "HEAD"])).toBe(beforeHead);
			expect(git(repo, ["config", "--get", "core.bare"])).toBe("false");
		} finally {
			isolated?.cleanup();
			sandbox.cleanup();
		}
	});
});
