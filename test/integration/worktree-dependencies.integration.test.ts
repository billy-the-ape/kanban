import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
 * The fixture resolves one dependency through a `file:` reference, which keeps
 * the run offline and therefore deterministic.
 */
const npmAvailable = spawnSync("npm", ["--version"], { encoding: "utf8" }).status === 0;

async function writeFiles(rootPath: string, files: Record<string, string>): Promise<void> {
	for (const [relativePath, content] of Object.entries(files)) {
		const target = join(rootPath, relativePath);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}
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
					"package.json": JSON.stringify({
						name: "fixture",
						version: "1.0.0",
						dependencies: { helper: "file:vendor/helper" },
					}),
					"vendor/helper/package.json": JSON.stringify({ name: "helper", version: "1.0.0", main: "index.js" }),
					"vendor/helper/index.js": 'module.exports = { marker: "vendor-helper" };\n',
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
