import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readdir, readlink, realpath, rm, stat, symlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import type { DependencyTransferStrategy } from "./types";

/**
 * Directory names never carried into a worktree: they are per-tree build or
 * tooling caches, and restoring them would leak one task's caches into
 * another. They are recreated by the tools that need them.
 *
 * Only tool cache directory names belong here, and they are all dot-prefixed:
 * these names are skipped at *every* depth of `node_modules`, so a plain word
 * would drop real package content (a `logs/` source directory, for instance,
 * which some packages ship and require internally) and hand an agent a tree
 * that fails with MODULE_NOT_FOUND.
 */
export const VOLATILE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([".cache", ".parcel-cache", ".turbo", ".vite"]);

export interface TreeTransferStats {
	files: number;
	directories: number;
	symlinks: number;
	skipped: number;
}

function emptyStats(): TreeTransferStats {
	return { files: 0, directories: 0, symlinks: 0, skipped: 0 };
}

function isVolatileDirectoryName(name: string): boolean {
	return VOLATILE_DIRECTORY_NAMES.has(name);
}

async function linkFiles(source: string, destination: string): Promise<boolean> {
	try {
		await link(source, destination);
		return true;
	} catch {
		return false;
	}
}

async function copyFileAny(source: string, destination: string, mode: number): Promise<void> {
	try {
		// Reflink/clone where the filesystem supports it (APFS, btrfs, XFS): a
		// copy-on-write tree is both instant and isolated. Elsewhere this falls
		// back to a normal copy.
		await copyFile(source, destination, constants.COPYFILE_FICLONE);
	} catch {
		await copyFile(source, destination);
	}
	// `cp -a` semantics: `.bin` shims and native binaries keep their exec bits
	// regardless of the process umask.
	if ((mode & 0o111) !== 0) {
		await chmod(destination, mode & 0o777);
	}
}

async function transferFile(source: string, destination: string, strategy: DependencyTransferStrategy): Promise<void> {
	const info = strategy === "link" ? null : await stat(source).catch(() => null);
	if (strategy === "link" && (await linkFiles(source, destination))) {
		return;
	}
	await copyFileAny(source, destination, info?.mode ?? 0o644);
}

/** True when the stored target resolves against the link's own directory. */
function isRelativeSymlinkTarget(target: string): boolean {
	if (target.length === 0 || target.startsWith("/") || target.startsWith("\\")) {
		return false;
	}
	// A Windows drive root is absolute even when it parses as POSIX-relative.
	if (/^[A-Za-z]:/.test(target)) {
		return false;
	}
	return !isAbsolute(target);
}

async function recreateSymlink(source: string, destination: string, target: string): Promise<boolean> {
	try {
		// Only the link *type* needs the resolved target; the stored path is
		// written verbatim, so a relative link keeps resolving inside the tree
		// being restored.
		const targetStat = await stat(source).catch(() => null);
		await symlink(target, destination, targetStat?.isDirectory() ? "dir" : "file");
		return true;
	} catch {
		// Windows without privileges/secrets: callers fall back to dereferencing.
		return false;
	}
}

async function transferSymlink(
	source: string,
	destination: string,
	target: string,
	containingDirectory: string,
	strategy: DependencyTransferStrategy,
	visitedDirectories: ReadonlySet<string>,
): Promise<"linked" | "copied" | "skipped"> {
	// Recreating a link is correct under both strategies and is the whole point
	// of a package-manager tree: npm, pnpm, Yarn and Bun write `node_modules/.bin`
	// shims and workspace/`file:` links as relative symlinks. Dereferencing a shim
	// leaves a standalone copy of the CLI whose `require("../lib/tsc.js")` no
	// longer resolves, and freezes a workspace link into a duplicate that never
	// sees the agent's edits. A symlink shares no inode either, so `copy` keeps
	// its inode isolation.
	if (isRelativeSymlinkTarget(target) && (await recreateSymlink(source, destination, target))) {
		return "linked";
	}
	const targetStat = await stat(source).catch(() => null);
	if (targetStat === null) {
		// Dangling link whose link could not be written either.
		return "skipped";
	}
	if (targetStat.isDirectory()) {
		// An absolute symlinked directory (a global `npm link`, a hand-written
		// `file:/` path): materialize it, so the restored tree stays self-contained
		// instead of reading through a path owned by another checkout.
		const resolved = await realpath(source).catch(() => null);
		if (resolved === null) {
			return "skipped";
		}
		const containingRoot = await realpath(containingDirectory).catch(() => containingDirectory);
		const pathToContainer = relative(resolved, containingRoot);
		const pointsBackInside =
			pathToContainer === "" || (!pathToContainer.startsWith("..") && !isAbsolute(pathToContainer));
		if (visitedDirectories.has(resolved) || pointsBackInside) {
			// Following this link would descend into a directory already being
			// copied, so keep the link and terminate rather than looping.
			return (await recreateSymlink(source, destination, target)) ? "linked" : "skipped";
		}
		const stats = await transferTree({
			from: source,
			to: destination,
			strategy,
			visitedDirectories: new Set([...visitedDirectories, resolved]),
		});
		return stats.files > 0 ? "copied" : "skipped";
	}
	await transferFile(source, destination, strategy);
	return "copied";
}

export interface TreeTransferOptions {
	/** Source directory; must exist. */
	from: string;
	/** Destination path, which must not exist yet. */
	to: string;
	strategy?: DependencyTransferStrategy;
	/** Extra directory names to leave out of the transfer. */
	skipDirectoryNames?: ReadonlySet<string>;
	/** Realpaths of dereferenced symlinked directories this walk is inside of. */
	visitedDirectories?: ReadonlySet<string>;
}

/**
 * Materialize a directory tree from one path to another, cheaply.
 *
 * `link` (the default) hardlinks files and recreates symlinks, so a cached
 * 1GB `node_modules` lands in a fresh worktree in a fraction of a second.
 * `copy` never shares inodes and instead tries a reflink (copy-on-write) copy
 * first. Symlinks are recreated rather than followed under both strategies
 * whenever the stored target is relative; only absolute targets are
 * dereferenced, and a link back into a directory already being copied stays a
 * link so a cycle can never recurse forever. Missing the fast path is never
 * fatal: every failure degrades to a plain copy, and only a real I/O failure
 * throws.
 */
export async function transferTree(options: TreeTransferOptions): Promise<TreeTransferStats> {
	const strategy = options.strategy ?? "link";
	const skip = options.skipDirectoryNames;
	const stats = emptyStats();
	const sourceStat = await lstat(options.from).catch(() => null);
	if (sourceStat === null) {
		throw new Error(`Dependency tree source is missing: ${options.from}`);
	}
	const visitedDirectories = new Set<string>(options.visitedDirectories ?? []);
	const sourceRoot = await realpath(options.from).catch(() => null);
	if (sourceRoot !== null) {
		visitedDirectories.add(sourceRoot);
	}
	await mkdir(options.to, { recursive: true });
	stats.directories += 1;
	await walk(options.from, options.to, strategy, skip, stats, visitedDirectories);
	return stats;
}

async function walk(
	sourceDir: string,
	destinationDir: string,
	strategy: DependencyTransferStrategy,
	skip: ReadonlySet<string> | undefined,
	stats: TreeTransferStats,
	visitedDirectories: ReadonlySet<string>,
): Promise<void> {
	const entries = await readdir(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = join(sourceDir, entry.name);
		const destinationPath = join(destinationDir, entry.name);
		if (entry.isDirectory()) {
			if (isVolatileDirectoryName(entry.name) || skip?.has(entry.name)) {
				stats.skipped += 1;
				continue;
			}
			await mkdir(destinationPath, { recursive: true });
			stats.directories += 1;
			await walk(sourcePath, destinationPath, strategy, skip, stats, visitedDirectories);
			continue;
		}
		if (entry.isSymbolicLink()) {
			const target = await readlink(sourcePath);
			const result = await transferSymlink(
				sourcePath,
				destinationPath,
				target,
				sourceDir,
				strategy,
				visitedDirectories,
			);
			if (result === "linked") {
				stats.symlinks += 1;
				continue;
			}
			if (result === "skipped") {
				stats.skipped += 1;
				continue;
			}
			stats.files += 1;
			continue;
		}
		if (entry.isFile()) {
			await transferFile(sourcePath, destinationPath, strategy);
			stats.files += 1;
			continue;
		}
		// Sockets, fifos and devices have no meaning inside node_modules.
		stats.skipped += 1;
	}
}

export async function removeTree(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
