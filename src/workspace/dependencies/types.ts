/**
 * WORKTREE-PACKAGES: shared shapes for the task-worktree dependency cache.
 *
 * Vocabulary:
 * - an **install unit** is one package-manager install scope inside a checkout
 *   (the repository root, or a nested project that installs on its own, like
 *   Kanban's own `web-ui`);
 * - an **input** is a manifest or lockfile the install consumes. The set of
 *   inputs is what a cache entry is keyed by: byte-identical inputs mean the
 *   same tree can be reused for a different checkout of the same commit range;
 * - an **output** is a `node_modules` directory an install produced, relative
 *   to the checkout root (`node_modules`, `web-ui/node_modules`, ...).
 */

export type WorktreePackageManagerId = "npm" | "pnpm" | "yarn" | "yarn-berry" | "bun";

/**
 * How a cached tree is written into a worktree:
 * - `link`: hardlink each file, falling back to a reflink copy and then a
 *   plain copy. Fastest and cheapest on disk; a file later rewritten *in
 *   place* (patch-package style postinstalls) would be seen by every tree
 *   sharing the inode. This is still strictly more isolated than Kanban's
 *   long-standing shared `node_modules` symlink.
 * - `copy`: never shares inodes (reflink where the filesystem supports it).
 */
export type DependencyTransferStrategy = "link" | "copy";

export interface DependencyInputFile {
	/** Path relative to the checkout root, POSIX separated. */
	path: string;
	/** Raw manifest/lockfile content. */
	content: string;
}

export interface DependencyInputDigest {
	path: string;
	sha256: string;
}

export interface DependencyInstallUnit {
	/** Install root relative to the checkout; `.` for the repository root. */
	installPath: string;
	packageManager: WorktreePackageManagerId;
	/** Lockfiles the install resolves, relative to the checkout. */
	lockfiles: string[];
	/** Manifests and lockfiles this install consumes, sorted by path. */
	inputs: DependencyInputFile[];
}

export interface DependencyInstallPlan {
	/** Executable name, resolved on PATH without a shell. */
	command: string;
	args: string[];
	/** Install environment additions (never replaces the inherited env). */
	env: Record<string, string>;
}

export interface DependencyUnitReport {
	installPath: string;
	packageManager: WorktreePackageManagerId;
	/** How the unit got its dependencies. */
	source: "cache" | "install" | "already-present" | "source-checkout" | "skipped" | "failed";
	/** Human-readable explanation for `skipped`/`failed`/`already-present`. */
	reason: string | null;
	/** Cache key, present whenever a cache entry was read or written. */
	cacheKey: string | null;
	/** Outputs (node_modules dirs) that were restored or produced. */
	outputs: string[];
	durationMs: number;
}

export interface WorktreeDependenciesReport {
	/** True when nothing needed attention or everything succeeded. */
	ok: boolean;
	worktreePath: string;
	units: DependencyUnitReport[];
	durationMs: number;
	/** Aggregate failure reason; individual units keep their own reports. */
	error: string | null;
}
