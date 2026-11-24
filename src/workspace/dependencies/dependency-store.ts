import { readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { LockRequest } from "../../fs/locked-file-system";
import { lockedFileSystem } from "../../fs/locked-file-system";
import { getRuntimeHomePath } from "../../state/workspace-state";
import { DEPENDENCY_CACHE_SCHEMA_VERSION } from "./fingerprint";
import { removeTree, transferTree } from "./tree-transfer";
import type { DependencyInputDigest, DependencyTransferStrategy, WorktreePackageManagerId } from "./types";

/**
 * Kanban's own snapshot cache for installed dependency trees.
 *
 * This is deliberately layered on top of (not a replacement for) each package
 * manager's global store: that store still makes a cold install cheap, but it
 * cannot make a *materialized* tree available. A snapshot entry is exactly the
 * tree an install produced for one byte-exact set of manifests and lockfiles,
 * so the next worktree with the same inputs pays a link-copy instead of an
 * install.
 */

const DEP_CACHE_DIR_NAME = "dep-cache";
const ENTRIES_DIR_NAME = "entries";
const LOCKS_DIR_NAME = "locks";
const TREE_DIR_NAME = "tree";
const META_FILENAME = "meta.json";
const STAGING_PREFIX = ".tmp-";
const DEFAULT_MAX_ENTRIES = 12;
const DEFAULT_MAX_ENTRIES_PER_REPO = 4;
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

export interface DependencyEntryMeta {
	version: number;
	key: string;
	installPath: string;
	packageManager: WorktreePackageManagerId;
	environment: string;
	inputs: DependencyInputDigest[];
	/** node_modules directories relative to the checkout, in transfer order. */
	outputs: string[];
	/** Where the snapshot came from. */
	source: "install" | "source-checkout";
	/** Repository the snapshot was taken for (diagnostics only). */
	repoRoot: string;
	createdAt: number;
	lastUsedAt: number;
}

const dependencyEntryMetaSchema = z.object({
	version: z.number(),
	key: z.string().min(1),
	installPath: z.string(),
	packageManager: z.enum(["npm", "pnpm", "yarn", "yarn-berry", "bun"]),
	environment: z.string(),
	inputs: z.array(z.object({ path: z.string(), sha256: z.string() })),
	outputs: z.array(z.string()).min(1),
	source: z.enum(["install", "source-checkout"]),
	repoRoot: z.string(),
	createdAt: z.number(),
	lastUsedAt: z.number(),
});

export interface DependencyEntry {
	meta: DependencyEntryMeta;
	entryPath: string;
	/** Absolute path of one recorded output inside the entry. */
	outputPath: (output: string) => string;
}

export function getDepCacheRootPath(): string {
	return join(getRuntimeHomePath(), DEP_CACHE_DIR_NAME);
}

function getEntriesDirPath(): string {
	return join(getDepCacheRootPath(), ENTRIES_DIR_NAME);
}

export function getDependencyEntryPath(key: string): string {
	return join(getEntriesDirPath(), key);
}

/**
 * Per-entry lock. proper-lockfile keys its in-process map by `path`, so each
 * distinct lock needs its own `path` as well as its own lockfile: two requests
 * sharing a path would overwrite each other's in-process entry (see AGENTS.md).
 */
export function getDependencyEntryLock(key: string): LockRequest {
	const locksDir = join(getDepCacheRootPath(), LOCKS_DIR_NAME);
	return {
		path: join(locksDir, key),
		type: "file",
		lockfilePath: join(locksDir, `${key}.lock`),
	};
}

async function pathExists(path: string): Promise<boolean> {
	return (await stat(path).catch(() => null)) !== null;
}

async function readMeta(entryPath: string): Promise<DependencyEntryMeta | null> {
	const raw = await readFile(join(entryPath, META_FILENAME), "utf8").catch(() => null);
	if (raw === null) {
		return null;
	}
	try {
		const parsed = dependencyEntryMetaSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Read and validate a cache entry. An entry whose recorded output trees are
 * missing (partial publish, manual deletion, or an interrupted process) is
 * treated as absent so a worktree is never handed a broken snapshot.
 */
export async function readDependencyEntry(key: string): Promise<DependencyEntry | null> {
	const entryPath = getDependencyEntryPath(key);
	const meta = await readMeta(entryPath);
	if (meta === null || meta.version !== DEPENDENCY_CACHE_SCHEMA_VERSION || meta.key !== key) {
		return null;
	}
	const treePath = join(entryPath, TREE_DIR_NAME);
	for (const output of meta.outputs) {
		if (!(await pathExists(join(treePath, output)))) {
			return null;
		}
	}
	return {
		meta,
		entryPath,
		outputPath: (output: string) => join(treePath, output),
	};
}

async function writeMeta(entryPath: string, meta: DependencyEntryMeta): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(join(entryPath, META_FILENAME), meta);
}

/** Refresh the recency field used by pruning. Best-effort by design. */
export async function touchDependencyEntry(entry: DependencyEntry, now: number): Promise<void> {
	if (entry.meta.lastUsedAt === now) {
		return;
	}
	await writeMeta(entry.entryPath, { ...entry.meta, lastUsedAt: now }).catch(() => undefined);
}

export interface PublishDependencyEntryOptions {
	key: string;
	installPath: string;
	packageManager: WorktreePackageManagerId;
	environment: string;
	inputs: DependencyInputDigest[];
	outputs: string[];
	source: DependencyEntryMeta["source"];
	repoRoot: string;
	/** Checkout the outputs are copied out of. */
	sourceRoot: string;
	strategy?: DependencyTransferStrategy;
	now?: number;
}

export interface PublishDependencyEntryResult {
	ok: boolean;
	/** Null when nothing was published (no outputs found, or a failure). */
	meta: DependencyEntryMeta | null;
	error: string | null;
}

/**
 * Publish a snapshot: every output tree is copied into a staging directory
 * first and only then moved into place, so a reader can never observe half a
 * tree. A failure part-way through costs the previous entry (worst case a later
 * task re-installs) but never leaves a half-restorable entry behind.
 */
export async function publishDependencyEntry(
	options: PublishDependencyEntryOptions,
): Promise<PublishDependencyEntryResult> {
	const now = options.now ?? Date.now();
	const entryPath = getDependencyEntryPath(options.key);
	if (await pathExists(entryPath)) {
		const existing = await readMeta(entryPath);
		if (existing !== null) {
			return { ok: true, meta: existing, error: null };
		}
	}
	if (options.outputs.length === 0) {
		return {
			ok: false,
			meta: null,
			error: "Install produced no node_modules directory, so there is nothing to cache.",
		};
	}
	return await lockedFileSystem.withLock(getDependencyEntryLock(options.key), async () => {
		const stagingPath = join(
			getEntriesDirPath(),
			`${STAGING_PREFIX}${options.key}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		);
		const meta: DependencyEntryMeta = {
			version: DEPENDENCY_CACHE_SCHEMA_VERSION,
			key: options.key,
			installPath: options.installPath,
			packageManager: options.packageManager,
			environment: options.environment,
			inputs: options.inputs,
			outputs: options.outputs,
			source: options.source,
			repoRoot: options.repoRoot,
			createdAt: now,
			lastUsedAt: now,
		};
		try {
			for (const output of options.outputs) {
				const sourcePath = join(options.sourceRoot, output);
				if (!(await pathExists(sourcePath))) {
					continue;
				}
				await transferTree({
					from: sourcePath,
					to: join(stagingPath, TREE_DIR_NAME, output),
					strategy: options.strategy ?? "copy",
				});
			}
			await writeMeta(stagingPath, meta);
			await removeTree(entryPath);
			await rename(stagingPath, entryPath);
			return { ok: true, meta, error: null };
		} catch (error) {
			await removeTree(stagingPath).catch(() => undefined);
			await removeTree(entryPath).catch(() => undefined);
			return {
				ok: false,
				meta: null,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});
}

export interface PruneDependencyEntriesResult {
	removed: number;
	remaining: number;
}

/**
 * Bound the cache's disk use, and reclaim staging directories left behind by
 * interrupted publishes. Two caps exist because one project's lockfile churn
 * must never push every other project out of the cache: a global recency cap,
 * and a smaller per-repository cap (a snapshot is a full tree copy, so a few
 * entries per repository is already gigabytes).
 */
export async function pruneDependencyEntries(
	options: { maxEntries?: number; maxEntriesPerRepo?: number; now?: number } = {},
): Promise<PruneDependencyEntriesResult> {
	const now = options.now ?? Date.now();
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const maxEntriesPerRepo = options.maxEntriesPerRepo ?? DEFAULT_MAX_ENTRIES_PER_REPO;
	const entriesDir = getEntriesDirPath();
	const names = await readdir(entriesDir).catch(() => [] as string[]);
	const survivors: Array<{ name: string; repoRoot: string; lastUsedAt: number }> = [];
	let removed = 0;
	for (const name of names) {
		const entryPath = join(entriesDir, name);
		if (name.startsWith(STAGING_PREFIX)) {
			const info = await stat(entryPath).catch(() => null);
			const ageMs = info === null ? Number.POSITIVE_INFINITY : now - info.mtimeMs;
			if (ageMs > STAGING_MAX_AGE_MS) {
				await removeTree(entryPath).catch(() => undefined);
				removed += 1;
			}
			continue;
		}
		const meta = await readMeta(entryPath);
		if (meta === null || meta.version !== DEPENDENCY_CACHE_SCHEMA_VERSION) {
			await removeTree(entryPath).catch(() => undefined);
			removed += 1;
			continue;
		}
		survivors.push({ name, repoRoot: meta.repoRoot, lastUsedAt: meta.lastUsedAt });
	}
	// Recency wins globally, but a single repository may only hold its share.
	const ordered = [...survivors].sort((left, right) => right.lastUsedAt - left.lastUsedAt);
	const kept = new Set<string>();
	const keptPerRepo = new Map<string, number>();
	for (const entry of ordered) {
		if (kept.size >= Math.max(0, maxEntries)) {
			break;
		}
		const usedForRepo = keptPerRepo.get(entry.repoRoot) ?? 0;
		if (usedForRepo >= Math.max(0, maxEntriesPerRepo)) {
			continue;
		}
		keptPerRepo.set(entry.repoRoot, usedForRepo + 1);
		kept.add(entry.name);
	}
	for (const entry of survivors) {
		if (kept.has(entry.name)) {
			continue;
		}
		await removeTree(join(entriesDir, entry.name)).catch(() => undefined);
		removed += 1;
	}
	return { removed, remaining: kept.size };
}

export const DEPENDENCY_CACHE_DEFAULT_MAX_ENTRIES = DEFAULT_MAX_ENTRIES;
