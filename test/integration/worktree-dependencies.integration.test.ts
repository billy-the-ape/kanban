import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { readDependencyEntry } from "../../src/workspace/dependencies/dependency-store";
import { ensureWorktreeDependencies } from "../../src/workspace/dependencies/ensure-worktree-dependencies";
import { createTempDir } from "../utilities/temp-dir";

/**
 * End-to-end proof against the real package manager: the argv built for npm is
 * accepted, the tree it produces is discovered, snapshotted, and restored into
 * another checkout of the same manifests. Unit suites stub the installer, so
 * this is the only test that exercises the real thing.
 *
 * The fixture declares one workspace member, which keeps the run offline and
 * therefore deterministic.
 */
const npmAvailable = spawnSync("npm", ["--version"], { encoding: "utf8" }).status === 0;

async function writeFiles(rootPath: string, files: Record<string, string>): Promise<void> {
	for (const [relativePath, content] of Object.entries(files)) {
		const target = join(rootPath, relativePath);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}
}

/**
 * Run the package's CLI through npm's `.bin` shim, which only works while the
 * shim is the relative symlink npm wrote: a dereferenced copy cannot resolve
 * the CLI's own relative require. POSIX-only layout, so a no-op on Windows
 * (where npm writes `.cmd` shims instead of links).
 */
async function expectRestoredCliShimToRun(worktreePath: string, marker = "vendor-helper"): Promise<void> {
	if (process.platform === "win32") {
		return;
	}
	const shim = join(worktreePath, "node_modules", ".bin", "helper");
	expect((await lstat(shim)).isSymbolicLink(), `${shim} is not a symlink`).toBe(true);
	const ran = spawnSync(shim, [], { encoding: "utf8" });
	expect(ran.status, `${ran.error?.message ?? ""} ${ran.stderr}`).toBe(0);
	expect(ran.stdout.trim()).toBe(marker);
}

describe.sequential("task worktree dependencies", () => {
	it.skipIf(!npmAvailable)(
		"installs once and restores the snapshot for the next task worktree",
		async () => {
			const sandbox = createTempDir("kanban-worktree-deps-");
			try {
				const repo = join(sandbox.path, "repo");
				const first = join(sandbox.path, "worktree-first");
				const second = join(sandbox.path, "worktree-second");
				const manifest = {
					// A workspace member, which is the shape npm links (rather than
					// copies): `node_modules/helper -> ../vendor/helper`.
					"package.json": JSON.stringify({
						name: "fixture",
						version: "1.0.0",
						workspaces: ["vendor/*"],
						dependencies: { helper: "1.0.0" },
					}),
					"vendor/helper/package.json": JSON.stringify({
						name: "helper",
						version: "1.0.0",
						main: "index.js",
						bin: { helper: "cli.js" },
					}),
					"vendor/helper/index.js": 'module.exports = { marker: "vendor-helper" };\n',
					// A relative require is what makes a dereferenced `.bin` shim fail:
					// the copy sits in `.bin/`, where `./index.js` does not exist.
					"vendor/helper/cli.js":
						'#!/usr/bin/env node\nconst { marker } = require("./index.js");\nconsole.log(marker);\n',
				};
				await writeFiles(repo, manifest);
				const lockfile = spawnSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], {
					cwd: repo,
					encoding: "utf8",
				});
				expect(lockfile.status, lockfile.stderr).toBe(0);
				const packageLock = await readFile(join(repo, "package-lock.json"), "utf8");
				const checkout = { ...manifest, "package-lock.json": packageLock };
				await writeFiles(first, checkout);
				await writeFiles(second, checkout);
				// A real git checkout would restore the committed mode, and a bin script
				// has to be executable for the `.bin` link to run it.
				for (const worktreePath of [first, second]) {
					await chmod(join(worktreePath, "vendor", "helper", "cli.js"), 0o755);
				}

				const firstReport = await ensureWorktreeDependencies({
					repoPath: repo,
					worktreePath: first,
					taskId: "task-deps-first",
					prune: false,
				});
				expect(firstReport.ok, firstReport.error ?? "").toBe(true);
				expect(firstReport.units.map((unit) => unit.source)).toEqual(["install"]);
				expect(firstReport.units[0]?.outputs).toEqual(["node_modules"]);
				// The installed tree is usable, which is the whole promise.
				expect(await readFile(join(first, "node_modules", "helper", "index.js"), "utf8")).toContain(
					"vendor-helper",
				);
				await expectRestoredCliShimToRun(first);
				if (process.platform !== "win32") {
					expect((await lstat(join(first, "node_modules", "helper"))).isSymbolicLink()).toBe(true);
				}

				const cacheKey = firstReport.units[0]?.cacheKey ?? "";
				expect((await readDependencyEntry(cacheKey))?.meta.source).toBe("install");

				const secondReport = await ensureWorktreeDependencies({
					repoPath: repo,
					worktreePath: second,
					taskId: "task-deps-second",
					prune: false,
				});
				expect(secondReport.units.map((unit) => unit.source)).toEqual(["cache"]);
				expect(secondReport.units[0]?.cacheKey).toBe(cacheKey);
				expect(await readFile(join(second, "node_modules", "helper", "index.js"), "utf8")).toContain(
					"vendor-helper",
				);
				// A snapshot that dereferenced links would restore a standalone copy
				// of the CLI here, whose relative require no longer resolves.
				await expectRestoredCliShimToRun(second);
				if (process.platform !== "win32") {
					// A workspace link stays a link, so the agent's edits inside the
					// worktree still reach the packages that consume them.
					expect((await lstat(join(second, "node_modules", "helper"))).isSymbolicLink()).toBe(true);
					await writeFile(
						join(second, "vendor", "helper", "index.js"),
						'module.exports = { marker: "edited" };\n',
					);
					await expectRestoredCliShimToRun(second, "edited");
				}
				// npm's own bookkeeping came along, so a later install inside the task
				// worktree resolves against the same tree instead of reinstalling.
				expect(await readFile(join(second, "node_modules", ".package-lock.json"), "utf8")).toContain("helper");
			} finally {
				sandbox.cleanup();
			}
		},
		120_000,
	);
});
