import { chmod, lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { getTaskWorktreesHomePath } from "../../src/state/workspace-state";
import {
	getDepCacheRootPath,
	pruneDependencyEntries,
	publishDependencyEntry,
	readDependencyEntry,
} from "../../src/workspace/dependencies/dependency-store";
import { ensureWorktreeDependencies } from "../../src/workspace/dependencies/ensure-worktree-dependencies";
import { computeEnvironmentSignature, computeInstallFingerprint } from "../../src/workspace/dependencies/fingerprint";
import type { InstallRunResult } from "../../src/workspace/dependencies/install-plan";
import { prepareTaskWorktreeDependencies } from "../../src/workspace/dependencies/prepare-task-worktree-dependencies";
import { removeTree, transferTree } from "../../src/workspace/dependencies/tree-transfer";
import type { DependencyInstallPlan, DependencyTransferStrategy } from "../../src/workspace/dependencies/types";
import { getInitialStartLiveStage } from "../../src/workspace/task-initial-start";
import { createTempDir } from "../utilities/temp-dir";

type InstallFn = (
	plan: DependencyInstallPlan,
	options: { cwd: string; timeoutMs: number },
) => Promise<InstallRunResult>;

const cleanups: Array<() => void> = [];

function makeTempDir(prefix: string): string {
	const dir = createTempDir(prefix);
	cleanups.push(dir.cleanup);
	return dir.path;
}

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

async function writeCheckout(rootPath: string, files: Record<string, string>): Promise<void> {
	for (const [relativePath, content] of Object.entries(files)) {
		const target = join(rootPath, relativePath);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}
}

/** A deterministic package tree, shaped like what an installer leaves behind. */
async function writeNodeModules(projectRoot: string, marker: string): Promise<void> {
	const packageDir = join(projectRoot, "node_modules", "dep");
	await mkdir(packageDir, { recursive: true });
	await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "dep" }), "utf8");
	await writeFile(join(packageDir, "index.js"), `export const marker = ${JSON.stringify(marker)};\n`, "utf8");
	const binDir = join(projectRoot, "node_modules", ".bin");
	await mkdir(binDir, { recursive: true });
	const shim = join(binDir, "dep-build");
	await writeFile(shim, "#!/bin/sh\necho build\n", "utf8");
	await chmod(shim, 0o755);
	// npm writes `.bin` shims as *relative* symlinks into the package, which is
	// the tree shape that breaks when a transfer dereferences links: the copy of
	// the CLI resolves its relative requires against `.bin/` and fails.
	await writeFile(join(packageDir, "run.js"), "require('../lib/run');\n", "utf8");
	await symlink("../dep/run.js", join(binDir, "dep-run")).catch(() => undefined);
	// A per-tree build cache, which must never travel with a snapshot.
	const cacheDir = join(packageDir, ".cache");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, "stale.txt"), "stale", "utf8");
	// A package shipping a directory named like a tool's cache (`@sentry/core`
	// ships `build/cjs/logs/` and requires it), which must survive the transfer.
	const shippedDir = join(packageDir, "build", "cjs", "logs");
	await mkdir(shippedDir, { recursive: true });
	await writeFile(join(shippedDir, "index.js"), "export const logger = 1;\n", "utf8");
}

function manifestPair(token: string): Record<string, string> {
	return {
		"package.json": JSON.stringify({ name: `app-${token}`, version: "1.0.0", dependencies: { dep: "^1.0.0" } }),
		"package-lock.json": `{ "lockfileVersion": 3, "token": "${token}" }`,
	};
}

/** An installer stand-in that materializes a tree in the directory it is run in. */
function installingAs(marker: string, onInstall?: (cwd: string) => void): InstallFn {
	return async (_plan, options) => {
		onInstall?.(options.cwd);
		await writeNodeModules(options.cwd, marker);
		return { ok: true, exitCode: 0, timedOut: false, output: "added 1 package", error: null };
	};
}

function installFailing(output: string): InstallFn {
	return async () => ({ ok: false, exitCode: 1, timedOut: false, output, error: "install exited with code 1" });
}

function installForbidden(): InstallFn {
	return async () => {
		throw new Error("install must not run");
	};
}

const availableExecutable = async (_name: string): Promise<string | null> => "/usr/bin/npm";
const missingExecutable = async (_name: string): Promise<string | null> => null;

const strategyNone: DependencyTransferStrategy = "link";

describe("transferTree", () => {
	it("hardlinks files, preserves exec bits, and leaves tool caches behind", async () => {
		const root = makeTempDir("kanban-dep-transfer-");
		const source = join(root, "source");
		await writeNodeModules(source, "a");
		// pnpm/`file:` dependencies are relative links to sibling packages.
		await symlink("../dep", join(source, "node_modules", "linked"), "dir");

		const stats = await transferTree({
			from: join(source, "node_modules"),
			to: join(root, "dest-link"),
			strategy: "link",
		});

		const destination = join(root, "dest-link");
		expect(await readFile(join(destination, "dep", "index.js"), "utf8")).toContain("export const marker");
		const shimStat = await lstat(join(destination, ".bin", "dep-build"));
		expect(shimStat.isFile()).toBe(true);
		expect((shimStat.mode & 0o111) !== 0).toBe(true);
		expect(await lstat(join(destination, "dep", ".cache")).catch(() => null)).toBeNull();
		// Only tool cache names are dropped: a real package directory that happens
		// to be named `logs` has to arrive or the restored tree cannot be required.
		expect(await readFile(join(destination, "dep", "build", "cjs", "logs", "index.js"), "utf8")).toContain("logger");
		if (process.platform !== "win32") {
			// Two directory entries, one inode: this is why restoring a 1GB tree
			// costs milliseconds instead of seconds.
			expect((await lstat(join(destination, "dep", "index.js"))).nlink).toBe(2);
			expect((await lstat(join(destination, "linked"))).isSymbolicLink()).toBe(true);
		}
		expect(stats.files).toBeGreaterThan(2);
	});

	it("keeps relative symlinks as links under the copy strategy too", async () => {
		const root = makeTempDir("kanban-dep-transfer-copy-links-");
		const checkout = join(root, "checkout");
		const worktree = join(root, "worktree");
		await writeNodeModules(checkout, "links");
		// An npm `file:`/workspace dependency: a relative link that escapes
		// node_modules and must keep resolving inside whichever tree it lands in.
		await mkdir(join(checkout, "vendor", "pkg"), { recursive: true });
		await writeFile(join(checkout, "vendor", "pkg", "index.js"), "from-checkout", "utf8");
		await symlink("../vendor/pkg", join(checkout, "node_modules", "aliased"));
		await mkdir(join(worktree, "vendor", "pkg"), { recursive: true });
		await writeFile(join(worktree, "vendor", "pkg", "index.js"), "from-worktree", "utf8");

		await transferTree({
			from: join(checkout, "node_modules"),
			to: join(worktree, "node_modules"),
			strategy: "copy",
		});
		const restored = join(worktree, "node_modules");
		if (process.platform === "win32") {
			// Link creation needs privileges there; only the dereferencing fallback
			// is exercisable, so the link assertions below would be moot.
			expect(await readFile(join(restored, "dep", "index.js"), "utf8")).toContain("marker");
			return;
		}
		// A `.bin` shim that became a regular file would no longer resolve its
		// relative require, which is what a dereferencing copy silently produced.
		const shim = join(restored, ".bin", "dep-run");
		expect((await lstat(shim)).isSymbolicLink()).toBe(true);
		expect(await readFile(shim, "utf8")).toContain("require");
		expect((await lstat(join(restored, "aliased"))).isSymbolicLink()).toBe(true);
		// It resolves to the worktree's own package, so the agent's edits there
		// reach its consumers instead of a frozen duplicate.
		expect(await readFile(join(restored, "aliased", "index.js"), "utf8")).toBe("from-worktree");
		// Links share no inode, so `copy` isolation is unaffected.
		expect((await lstat(join(restored, "dep", "index.js"))).nlink).toBe(1);
	});

	it("materializes an absolute symlinked directory instead of pointing outside", async () => {
		const root = makeTempDir("kanban-dep-transfer-abs-link-");
		const source = join(root, "source");
		await writeNodeModules(source, "abs");
		await symlink(join(source, "node_modules", "dep"), join(source, "node_modules", "aliased"), "dir");

		const destination = join(root, "dest-abs");
		await transferTree({ from: join(source, "node_modules"), to: destination, strategy: "copy" });
		if (process.platform === "win32") {
			return;
		}
		// Keeping the stored path would hand the worktree a link into the tree it
		// was published from, so the content is copied and stays put.
		expect((await lstat(join(destination, "aliased"))).isSymbolicLink()).toBe(false);
		expect(await readFile(join(destination, "aliased", "index.js"), "utf8")).toContain("marker");
	});

	it("keeps a link that points back into a directory being copied", async () => {
		const root = makeTempDir("kanban-dep-transfer-cycle-");
		const source = join(root, "source");
		await writeNodeModules(source, "cycle");
		// Dereferencing this would recurse until the path name exploded.
		await symlink(join(source, "node_modules", "dep"), join(source, "node_modules", "dep", "self"), "dir");

		const destination = join(root, "dest-cycle");
		const stats = await transferTree({ from: join(source, "node_modules"), to: destination, strategy: "copy" });
		if (process.platform === "win32") {
			return;
		}
		expect((await lstat(join(destination, "dep", "self"))).isSymbolicLink()).toBe(true);
		expect(stats.files).toBeGreaterThan(0);
	});

	it("copies without sharing inodes when asked to", async () => {
		const root = makeTempDir("kanban-dep-transfer-copy-");
		const source = join(root, "source");
		await writeNodeModules(source, "b");
		await transferTree({ from: join(source, "node_modules"), to: join(root, "dest"), strategy: "copy" });
		if (process.platform !== "win32") {
			expect((await lstat(join(root, "dest", "dep", "index.js"))).nlink).toBe(1);
		}
		expect(await readFile(join(root, "dest", "dep", "index.js"), "utf8")).toContain("marker");
	});

	it("throws for a missing source instead of producing an empty tree", async () => {
		const root = makeTempDir("kanban-dep-transfer-missing-");
		await expect(transferTree({ from: join(root, "absent"), to: join(root, "dest") })).rejects.toThrow(
			/Dependency tree source is missing/,
		);
	});
});

describe("dependency snapshot store", () => {
	const baseMeta = {
		installPath: ".",
		packageManager: "npm" as const,
		environment: computeEnvironmentSignature(),
		repoRoot: "/repo",
	};

	it("publishes atomically and validates the outputs on read", async () => {
		const root = makeTempDir("kanban-dep-store-");
		const source = join(root, "checkout");
		await writeNodeModules(source, "store");
		const key = "store-roundtrip";

		const publish = await publishDependencyEntry({
			key,
			...baseMeta,
			inputs: [{ path: "package.json", sha256: "abc" }],
			outputs: ["node_modules"],
			source: "install",
			sourceRoot: source,
			now: 5_000,
		});
		expect(publish.ok).toBe(true);
		expect(publish.meta?.outputs).toEqual(["node_modules"]);

		const entry = await readDependencyEntry(key);
		expect(entry).not.toBeNull();
		const restoredFile = entry?.outputPath("node_modules");
		expect(restoredFile).not.toBeUndefined();
		expect(await readFile(join(restoredFile ?? "", "dep", "index.js"), "utf8")).toContain("store");
		if (process.platform !== "win32") {
			// Publishing is a copy, and a copy that dereferenced links would leave
			// every restored worktree with a broken CLI shim.
			expect((await lstat(join(restoredFile ?? "", ".bin", "dep-run"))).isSymbolicLink()).toBe(true);
		}
		expect(await readFile(join(restoredFile ?? "", "dep", "build", "cjs", "logs", "index.js"), "utf8")).toContain(
			"logger",
		);
		// No staging directory survives a completed publish.
		expect(
			await lstat(join(getDepCacheRootPath(), "entries", "store-roundtrip", "tree")).catch(() => null),
		).not.toBeNull();

		await removeTree(join(getDepCacheRootPath(), "entries", "store-roundtrip", "tree", "node_modules"));
		// A snapshot missing an output is worse than no snapshot: refuse it.
		expect(await readDependencyEntry(key)).toBeNull();
	});

	it("keeps the most recently used entries when pruning", async () => {
		const root = makeTempDir("kanban-dep-store-prune-");
		const source = join(root, "checkout");
		await writeNodeModules(source, "prune");
		const keys = ["prune-a", "prune-b", "prune-c"];
		for (const [index, key] of keys.entries()) {
			await publishDependencyEntry({
				key,
				...baseMeta,
				inputs: [{ path: "package.json", sha256: `digest-${index}` }],
				outputs: ["node_modules"],
				source: "install",
				sourceRoot: source,
				now: 10_000 + index,
			});
		}

		const pruned = await pruneDependencyEntries({ maxEntries: 2 });
		expect(pruned.remaining).toBe(2);
		expect(pruned.removed).toBeGreaterThanOrEqual(1);
		expect(await readDependencyEntry("prune-a")).toBeNull();
		expect(await readDependencyEntry("prune-c")).not.toBeNull();
		// Eviction renames an entry out before deleting it, so nothing is left
		// behind for a later prune to find.
		expect(
			(await readdir(join(getDepCacheRootPath(), "entries"))).filter((name) => name.startsWith(".tmp-")),
		).toEqual([]);
	});

	it("publishes one snapshot when two cold starts race on the same key", async () => {
		const root = makeTempDir("kanban-dep-store-race-");
		const source = join(root, "checkout");
		await writeNodeModules(source, "race");
		const key = "race-roundtrip";
		const request = {
			key,
			...baseMeta,
			inputs: [{ path: "package.json", sha256: "race-digest" }],
			outputs: ["node_modules"],
			source: "install" as const,
			sourceRoot: source,
		};

		// Two tasks dispatched against the same cold cache state: the loser takes
		// the winner's snapshot instead of re-copying over the one being restored.
		// The distinct clocks make a silent second publish observable, whichever
		// one wins the lock.
		const [first, second] = await Promise.all([
			publishDependencyEntry({ ...request, now: 20_000 }),
			publishDependencyEntry({ ...request, now: 30_000 }),
		]);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(second.meta?.createdAt).toBe(first.meta?.createdAt);
		expect([first.meta?.createdAt, second.meta?.createdAt]).toContain(20_000);

		const entry = await readDependencyEntry(key);
		expect(entry).not.toBeNull();
		const output = entry?.outputPath("node_modules");
		expect(await readFile(join(output ?? "", "dep", "index.js"), "utf8")).toContain("race");
		expect(await readFile(join(output ?? "", "dep", "build", "cjs", "logs", "index.js"), "utf8")).toContain("logger");
		expect(
			(await readdir(join(getDepCacheRootPath(), "entries"))).filter((name) => name.startsWith(".tmp-")),
		).toEqual([]);
	});

	it("caps how many entries one repository may hold", async () => {
		const root = makeTempDir("kanban-dep-store-per-repo-");
		const source = join(root, "checkout");
		await writeNodeModules(source, "per-repo");
		const repoA = join(root, "repo-a");
		const repoB = join(root, "repo-b");
		// Two repositories whose lockfiles churn independently. The newest two
		// entries of repo-a must not crowd out repo-b entirely.
		for (const [index, key] of [
			"per-repo-a1",
			"per-repo-a2",
			"per-repo-a3",
			"per-repo-b1",
			"per-repo-b2",
		].entries()) {
			await publishDependencyEntry({
				key,
				...baseMeta,
				repoRoot: key.startsWith("per-repo-a") ? repoA : repoB,
				inputs: [{ path: "package.json", sha256: `digest-${index}` }],
				outputs: ["node_modules"],
				source: "install",
				sourceRoot: source,
				now: 20_000 + index,
			});
		}
		const pruned = await pruneDependencyEntries({ maxEntries: 12, maxEntriesPerRepo: 2 });
		expect(pruned.removed).toBeGreaterThanOrEqual(1);
		expect(await readDependencyEntry("per-repo-a3")).not.toBeNull();
		expect(await readDependencyEntry("per-repo-a2")).not.toBeNull();
		expect(await readDependencyEntry("per-repo-a1")).toBeNull();
		expect(await readDependencyEntry("per-repo-b2")).not.toBeNull();
		expect(await readDependencyEntry("per-repo-b1")).not.toBeNull();
	});

	it("refuses unparseable metadata and reclaims the entry directory", async () => {
		const entryDir = join(getDepCacheRootPath(), "entries", "broken-entry");
		await mkdir(entryDir, { recursive: true });
		await writeFile(join(entryDir, "meta.json"), "{ not json", "utf8");
		expect(await readDependencyEntry("broken-entry")).toBeNull();
		expect((await pruneDependencyEntries({ maxEntries: 100 })).removed).toBeGreaterThanOrEqual(1);
		expect(await lstat(entryDir).catch(() => null)).toBeNull();
	});
});

describe("ensureWorktreeDependencies", () => {
	it("restores a snapshot whose install inputs match exactly", async () => {
		const root = makeTempDir("kanban-dep-ensure-hit-");
		const repo = join(root, "repo");
		const worktree = join(root, "worktree");
		const token = "cache-hit";
		await writeCheckout(worktree, manifestPair(token));
		// The snapshot was published by an earlier task's install.
		const snapshotSource = join(root, "snapshot-source");
		await writeCheckout(snapshotSource, manifestPair(token));
		await writeNodeModules(snapshotSource, "from-snapshot");

		const fingerprint = computeInstallFingerprint({
			installPath: ".",
			packageManager: "npm",
			inputs: Object.entries(manifestPair(token)).map(([path, content]) => ({ path, content })),
			environment: computeEnvironmentSignature(),
		});
		await publishDependencyEntry({
			key: fingerprint.key,
			installPath: ".",
			packageManager: "npm",
			environment: computeEnvironmentSignature(),
			inputs: fingerprint.digests,
			outputs: ["node_modules"],
			source: "install",
			repoRoot: repo,
			sourceRoot: snapshotSource,
		});

		const runInstall = vi.fn(installForbidden());
		const report = await ensureWorktreeDependencies({
			repoPath: repo,
			worktreePath: worktree,
			taskId: "task-hit",
			runInstall,
			resolveExecutable: availableExecutable,
			transferStrategy: strategyNone,
		});

		expect(report.ok).toBe(true);
		expect(report.units[0]?.source).toBe("cache");
		expect(report.units[0]?.cacheKey).toBe(fingerprint.key);
		expect(runInstall).not.toHaveBeenCalled();
		expect(await readFile(join(worktree, "node_modules", "dep", "index.js"), "utf8")).toContain("from-snapshot");
	});

	it("snapshots the workspace checkout when it resolves the same inputs", async () => {
		const root = makeTempDir("kanban-dep-ensure-checkout-");
		const repo = join(root, "repo");
		const worktree = join(root, "worktree");
		const token = "same-locked";
		await writeCheckout(repo, manifestPair(token));
		await writeNodeModules(repo, "checkout-tree");
		await writeCheckout(worktree, manifestPair(token));

		const runInstall = vi.fn(installForbidden());
		const report = await ensureWorktreeDependencies({
			repoPath: repo,
			worktreePath: worktree,
			taskId: "task-checkout",
			runInstall,
			resolveExecutable: availableExecutable,
		});

		expect(report.units[0]?.source).toBe("source-checkout");
		expect(runInstall).not.toHaveBeenCalled();
		expect(await readFile(join(worktree, "node_modules", "dep", "index.js"), "utf8")).toContain("checkout-tree");
	});

	it("refuses to snapshot a workspace install older than its own manifests", async () => {
		const root = makeTempDir("kanban-dep-ensure-stale-");
		const repo = join(root, "repo");
		const worktree = join(root, "worktree");
		const token = "stale-locked";
		await writeCheckout(repo, manifestPair(token));
		await writeNodeModules(repo, "stale-tree");
		await writeCheckout(worktree, manifestPair(token));
		// The developer pulled newer manifests without reinstalling.
		await writeFile(join(repo, "package-lock.json"), `{ "lockfileVersion": 3, "token": "${token}-newer" }`, "utf8");

		const installedPaths: string[] = [];
		const report = await ensureWorktreeDependencies({
			repoPath: repo,
			worktreePath: worktree,
			taskId: "task-stale",
			runInstall: installingAs("installed-tree", (cwd) => installedPaths.push(cwd)),
			resolveExecutable: availableExecutable,
		});

		expect(installedPaths).toEqual([worktree]);
		expect(report.units[0]?.source).toBe("install");
		expect(await readFile(join(worktree, "node_modules", "dep", "index.js"), "utf8")).toContain("installed-tree");
	});

	it("installs on a cold cache and publishes the snapshot the next worktree reuses", async () => {
		const root = makeTempDir("kanban-dep-ensure-install-");
		const repo = join(root, "repo");
		const token = "cold-cache";
		// The workspace checkout has no install at all, so nothing can be reused.
		await writeCheckout(repo, manifestPair(token));

		const first = join(root, "worktree-first");
		await writeCheckout(first, manifestPair(token));
		const installCalls = vi.fn(installingAs("fresh"));
		const firstReport = await ensureWorktreeDependencies({
			repoPath: repo,
			worktreePath: first,
			taskId: "task-first",
			runInstall: installCalls,
			resolveExecutable: availableExecutable,
		});
		expect(firstReport.units[0]?.source).toBe("install");

		const second = join(root, "worktree-second");
		await writeCheckout(second, manifestPair(token));
		const secondReport = await ensureWorktreeDependencies({
			repoPath: repo,
			worktreePath: second,
			taskId: "task-second",
			runInstall: installForbidden(),
			resolveExecutable: availableExecutable,
		});
		expect(secondReport.units[0]?.source).toBe("cache");
		expect(installCalls).toHaveBeenCalledTimes(1);
		expect(await readFile(join(second, "node_modules", "dep", "index.js"), "utf8")).toContain("fresh");
		if (process.platform !== "win32") {
			// install -> snapshot -> restore has to keep the tree's links working,
			// or the reused tree is not usable by the next agent.
			expect((await lstat(join(second, "node_modules", ".bin", "dep-run"))).isSymbolicLink()).toBe(true);
		}
	});

	it("prepares every install unit of a multi-project repository", async () => {
		const root = makeTempDir("kanban-dep-ensure-units-");
		const repo = join(root, "repo");
		const worktree = join(root, "worktree");
		const token = "multi-unit";
		const files = {
			...manifestPair(token),
			"web-ui/package.json": JSON.stringify({ name: "web", version: "1.0.0" }),
			"web-ui/package-lock.json": `{ "lockfileVersion": 3, "token": "${token}" }`,
		};
		await writeCheckout(repo, files);
		await writeCheckout(worktree, files);

		const installedPaths: string[] = [];
		const report = await ensureWorktreeDependencies({
			repoPath: repo,
			worktreePath: worktree,
			taskId: "task-units",
			runInstall: installingAs("unit-tree", (cwd) => installedPaths.push(cwd)),
			resolveExecutable: availableExecutable,
		});

		expect(report.units.map((unit) => unit.installPath)).toEqual([".", "web-ui"]);
		expect(report.units.every((unit) => unit.source === "install")).toBe(true);
		expect(installedPaths.sort()).toEqual([worktree, join(worktree, "web-ui")]);
		// Each unit's tree is materialized in the right place, and the root
		// snapshot never swallowed the nested project's tree. Output paths stay
		// checkout-relative, which is what makes a nested unit restorable anywhere.
		expect(await readFile(join(worktree, "node_modules", "dep", "index.js"), "utf8")).toContain("unit-tree");
		expect(await readFile(join(worktree, "web-ui", "node_modules", "dep", "index.js"), "utf8")).toContain(
			"unit-tree",
		);
		const rootEntry = await readDependencyEntry(report.units[0]?.cacheKey ?? "");
		expect(rootEntry?.meta.outputs).toEqual(["node_modules"]);
		const nestedEntry = await readDependencyEntry(report.units[1]?.cacheKey ?? "");
		expect(nestedEntry?.meta.outputs).toEqual(["web-ui/node_modules"]);
	});

	it("leaves a worktree that already has dependencies alone", async () => {
		const root = makeTempDir("kanban-dep-ensure-present-");
		const repo = join(root, "repo");
		const worktree = join(root, "worktree");
		const token = "already-there";
		await writeCheckout(repo, manifestPair(token));
		await writeCheckout(worktree, manifestPair(token));
		await writeNodeModules(worktree, "existing");

		const runInstall = vi.fn(installForbidden());
		const report = await ensureWorktreeDependencies({
			repoPath: repo,
			worktreePath: worktree,
			taskId: "task-present",
			runInstall,
			resolveExecutable: availableExecutable,
		});
		expect(report.units[0]?.source).toBe("already-present");
		expect(report.units[0]?.outputs).toEqual(["node_modules"]);
		expect(runInstall).not.toHaveBeenCalled();
		expect(await readFile(join(worktree, "node_modules", "dep", "index.js"), "utf8")).toContain("existing");
	});

	it("does nothing for a repository with no Node project", async () => {
		const root = makeTempDir("kanban-dep-ensure-nonode-");
		const repo = join(root, "repo");
		const worktree = join(root, "worktree");
		await writeCheckout(worktree, { "main.go": "package main" });
		await writeCheckout(repo, { "main.go": "package main" });
		const report = await ensureWorktreeDependencies({
			repoPath: repo,
			worktreePath: worktree,
			taskId: "task-go",
			runInstall: installForbidden(),
			resolveExecutable: availableExecutable,
		});
		expect(report.ok).toBe(true);
		expect(report.units).toEqual([]);
	});

	it("skips the unit when its package manager is not installed", async () => {
		const root = makeTempDir("kanban-dep-ensure-nopm-");
		const repo = join(root, "repo");
		const worktree = join(root, "worktree");
		const token = "missing-pm";
		await writeCheckout(repo, manifestPair(token));
		await writeCheckout(worktree, manifestPair(token));
		const report = await ensureWorktreeDependencies({
			repoPath: repo,
			worktreePath: worktree,
			taskId: "task-nopm",
			runInstall: installForbidden(),
			resolveExecutable: missingExecutable,
		});
		expect(report.units[0]?.source).toBe("skipped");
		expect(report.units[0]?.reason).toContain("npm");
		// A missing package manager must not fail the launch.
		expect(report.ok).toBe(true);
	});

	it("reports a failed install without publishing a snapshot", async () => {
		const root = makeTempDir("kanban-dep-ensure-fail-");
		const repo = join(root, "repo");
		const worktree = join(root, "worktree");
		const token = "broken-install";
		await writeCheckout(repo, manifestPair(token));
		await writeCheckout(worktree, manifestPair(token));
		const report = await ensureWorktreeDependencies({
			repoPath: repo,
			worktreePath: worktree,
			taskId: "task-fail",
			runInstall: installFailing("npm ERR! 404 dep not found"),
			resolveExecutable: availableExecutable,
		});
		expect(report.ok).toBe(false);
		expect(report.error).toContain("404");
		expect(report.units[0]?.source).toBe("failed");
		expect(await readDependencyEntry(report.units[0]?.cacheKey ?? "")).toBeNull();
	});

	it("never runs two jobs for the same worktree at once", async () => {
		const root = makeTempDir("kanban-dep-ensure-coalesce-");
		const repo = join(root, "repo");
		const worktree = join(root, "worktree");
		const token = "coalesced";
		await writeCheckout(repo, manifestPair(token));
		await writeCheckout(worktree, manifestPair(token));
		const installCalls = vi.fn(installingAs("once"));
		const runInstall: InstallFn = (plan, options) => installCalls(plan, options);
		const [first, second] = await Promise.all([
			ensureWorktreeDependencies({
				repoPath: repo,
				worktreePath: worktree,
				taskId: "task-coalesce-a",
				runInstall,
				resolveExecutable: availableExecutable,
			}),
			ensureWorktreeDependencies({
				repoPath: repo,
				worktreePath: worktree,
				taskId: "task-coalesce-b",
				runInstall,
				resolveExecutable: availableExecutable,
			}),
		]);
		expect(installCalls).toHaveBeenCalledTimes(1);
		expect(first.units[0]?.source).toBe("install");
		expect(second.units[0]?.source).toBe("install");
	});

	it("skips installing when automatic installs are disabled", async () => {
		const root = makeTempDir("kanban-dep-ensure-disabled-");
		const repo = join(root, "repo");
		const worktree = join(root, "worktree");
		const token = "install-disabled";
		await writeCheckout(repo, manifestPair(token));
		await writeCheckout(worktree, manifestPair(token));
		const runInstall = vi.fn(installForbidden());
		const report = await ensureWorktreeDependencies({
			repoPath: repo,
			worktreePath: worktree,
			taskId: "task-disabled",
			allowInstall: false,
			runInstall,
			resolveExecutable: availableExecutable,
		});
		expect(report.units[0]?.source).toBe("skipped");
		expect(report.units[0]?.reason).toContain("disabled");
		expect(runInstall).not.toHaveBeenCalled();
	});
});

describe("prepareTaskWorktreeDependencies", () => {
	it("never touches a checkout that is not a task worktree", async () => {
		const root = makeTempDir("kanban-dep-guard-");
		const workspacePath = join(root, "repo");
		await writeCheckout(workspacePath, manifestPair("guard"));
		const report = await prepareTaskWorktreeDependencies({
			workspacePath,
			taskId: "task-guard",
			taskCwd: workspacePath,
		});
		expect(report).toBeNull();
		// The user's own working copy is never installed into.
		expect(await lstat(join(workspacePath, "node_modules")).catch(() => null)).toBeNull();
	});

	it("refuses sibling lookalikes of the task worktree root", async () => {
		const root = makeTempDir("kanban-dep-lookalike-");
		const workspacePath = join(root, "repo");
		const lookalike = `${getTaskWorktreesHomePath()}-evil/task-lookalike/repo`;
		await writeCheckout(workspacePath, manifestPair("lookalike"));
		await writeCheckout(lookalike, manifestPair("lookalike"));
		const report = await prepareTaskWorktreeDependencies({
			workspacePath,
			taskId: "task-lookalike",
			taskCwd: lookalike,
			allowInstall: false,
		});
		expect(report).toBeNull();
	});

	it("runs for a real task worktree and clears the live stage afterwards", async () => {
		const root = makeTempDir("kanban-dep-live-repo-");
		const taskWorktree = join(getTaskWorktreesHomePath(), "task-live", "repo");
		await writeCheckout(root, manifestPair("live"));
		await writeCheckout(taskWorktree, manifestPair("live"));
		const pending = prepareTaskWorktreeDependencies({
			workspacePath: root,
			taskId: "task-live",
			taskCwd: taskWorktree,
			allowInstall: false,
		});
		expect(getInitialStartLiveStage("task-live")).toBe("preparing_dependencies");
		const report = await pending;
		expect(report?.units[0]?.source).toBe("skipped");
		expect(getInitialStartLiveStage("task-live")).toBeNull();
	});
});
