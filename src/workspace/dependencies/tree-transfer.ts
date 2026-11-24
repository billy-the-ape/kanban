import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readdir, readlink, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";

import type { DependencyTransferStrategy } from "./types";

/**
 * Directory names never carried into a worktree: they are per-tree build or
 * tooling caches, and restoring them would leak one task's caches into
 * another. They are recreated by the tools that need them.
 */
export const VOLATILE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
	".cache",
	".parcel-cache",
	".turbo",
	".vite",
	"logs",
]);

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

async function transferSymlink(
	source: string,
	destination: string,
	target: string,
	strategy: DependencyTransferStrategy,
): Promise<"linked" | "copied" | "skipped"> {
	if (strategy === "link") {
		try {
			const targetStat = await stat(source).catch(() => null);
			await symlink(target, destination, targetStat?.isDirectory() ? "dir" : "file");
			return "linked";
		} catch {
			// Fall through to dereferencing the link (Windows without privileges).
		}
	}
	const targetStat = await stat(source).catch(() => null);
	if (targetStat === null) {
		return "skipped";
	}
	if (targetStat.isDirectory()) {
		// A symlinked directory inside node_modules (pnpm layouts): recreate the
		// subtree rather than the link so the copy stays self-contained.
		const stats = await transferTree({
			from: source,
			to: destination,
			strategy,
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
}

/**
 * Materialize a directory tree from one path to another, cheaply.
 *
 * `link` (the default) hardlinks files and recreates symlinks, so a cached
 * 1GB `node_modules` lands in a fresh worktree in a fraction of a second.
 * `copy` never shares inodes and instead tries a reflink (copy-on-write) copy
 * first. Missing the fast path is never fatal: every failure degrades to a
 * plain copy, and only a real I/O failure throws.
 */
export async function transferTree(options: TreeTransferOptions): Promise<TreeTransferStats> {
	const strategy = options.strategy ?? "link";
	const skip = options.skipDirectoryNames;
	const stats = emptyStats();
	const sourceStat = await lstat(options.from).catch(() => null);
	if (sourceStat === null) {
		throw new Error(`Dependency tree source is missing: ${options.from}`);
	}
	await mkdir(options.to, { recursive: true });
	stats.directories += 1;
	await walk(options.from, options.to, strategy, skip, stats);
	return stats;
}

async function walk(
	sourceDir: string,
	destinationDir: string,
	strategy: DependencyTransferStrategy,
	skip: ReadonlySet<string> | undefined,
	stats: TreeTransferStats,
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
			await walk(sourcePath, destinationPath, strategy, skip, stats);
			continue;
		}
		if (entry.isSymbolicLink()) {
			const target = await readlink(sourcePath);
			const result = await transferSymlink(sourcePath, destinationPath, target, strategy);
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
