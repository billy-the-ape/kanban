import { readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
 * The shared retry budget is deliberate: the winner of a concurrent publish
 * holds the lock for a full tree copy (seconds on a multi-GB `node_modules`),
 * and a caller that waits that out finds the entry already published, while one
 * that runs out gets `ok: false` from `publishDependencyEntry`.
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

/**
 * Move a directory out of the way atomically before deleting it.
 *
 * Deleting an entry in place is not safe while other tasks may be restoring
 * from it: a transfer that merely *skips* a vanished entry does not throw, so a
 * half-removed tree could pass the "output exists" gate and be handed to an
 * agent. A rename is atomic, so a concurrent reader either resolves the whole
 * entry or gets ENOENT and rolls the partial restore back.
 */
async function moveAsideEntry(entriesDir: string, key: string, entryPath: string): Promise<void> {
	if (!(await pathExists(entryPath))) {
		return;
	}
	// Staging prefix on purpose: an interrupted cleanup then ages out with every
	// other staging directory instead of needing its own lifecycle.
	const trashPath = join(
		entriesDir,
		`${STAGING_PREFIX}${basename(key)}-replaced-${Math.random().toString(36).slice(2, 8)}`,
	);
	try {
		await rename(entryPath, trashPath);
	} catch {
		// Could not move it (already gone, or a filesystem that refuses the
		// rename); fall back to removing it where it stands.
		await removeTree(entryPath).catch(() => undefined);
		return;
	}
	await removeTree(trashPath).catch(() => undefined);
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
	/**
	 * Lock retry budget override. Publishing waits for the per-key lock (another
	 * task may be copying the same tree), and the default budget is the shared
	 * several-seconds one; tests use a small value to exercise giving up.
	 */
	lockRetries?: number;
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
 * tree. Publishing an input set that already has a usable entry is a no-op, and
 * a failed publish only ever removes its own staging directory: a snapshot
 * another task is restoring from is never deleted because this publish failed.
 * Every failure — including losing the per-key lock to a concurrent publish —
 * comes back as `ok: false` rather than a rejection, because the callers degrade
 * on the result and a task launch must not be lost to the cache.
 */
export async function publishDependencyEntry(
	options: PublishDependencyEntryOptions,
): Promise<PublishDependencyEntryResult> {
	const now = options.now ?? Date.now();
	const entryPath = getDependencyEntryPath(options.key);
	const entriesDir = dirname(entryPath);
	// Cheap check first (no lock held); the authoritative one runs inside the
	// lock below, because two tasks starting cold on the same key are normal.
	const publishedAlready = await readDependencyEntry(options.key);
	if (publishedAlready !== null) {
		return { ok: true, meta: publishedAlready.meta, error: null };
	}
	if (options.outputs.length === 0) {
		return {
			ok: false,
			meta: null,
			error: "Install produced no node_modules directory, so there is nothing to cache.",
		};
	}
	const lock = getDependencyEntryLock(options.key);
	const request: LockRequest = options.lockRetries === undefined ? lock : { ...lock, retries: options.lockRetries };
	try {
		return await lockedFileSystem.withLock(request, publishUnderLock);
	} catch (error) {
		// Losing the lock must not be a dependency failure: this call would throw
		// past the callers that degrade on `ok: false`, and the task would lose a
		// report for work that already succeeded. The winner of a concurrent
		// publish for this exact key copied the same tree, so its entry answers
		// this call; otherwise the caller falls back exactly as it does for any
		// other publish failure.
		const winner = await readDependencyEntry(options.key);
		if (winner !== null) {
			return { ok: true, meta: winner.meta, error: null };
		}
		return {
			ok: false,
			meta: null,
			error: `Could not take the snapshot lock: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	async function publishUnderLock(): Promise<PublishDependencyEntryResult> {
		// Re-check now that the lock is held: the other task's snapshot is the
		// answer, not something to re-copy over. Without this, concurrent cold
		// starts of one key each transfer the whole tree and the last one replaces
		// the entry the first is restoring from.
		const published = await readDependencyEntry(options.key);
		if (published !== null) {
			return { ok: true, meta: published.meta, error: null };
		}
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
			// Only an unusable entry can still be here (unparseable metadata, or a
			// tree someone half-deleted): move it aside rather than unlink it.
			await moveAsideEntry(entriesDir, options.key, entryPath);
			await rename(stagingPath, entryPath);
			return { ok: true, meta, error: null };
		} catch (error) {
			await removeTree(stagingPath).catch(() => undefined);
			return {
				ok: false,
				meta: null,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
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
			await moveAsideEntry(entriesDir, name, entryPath);
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
		// Renamed out before deletion, so a restore in flight either saw the whole
		// tree or fails loudly enough to fall through to an install.
		await moveAsideEntry(entriesDir, entry.name, join(entriesDir, entry.name)).catch(() => undefined);
		removed += 1;
	}
	return { removed, remaining: kept.size };
}

export const DEPENDENCY_CACHE_DEFAULT_MAX_ENTRIES = DEFAULT_MAX_ENTRIES;
