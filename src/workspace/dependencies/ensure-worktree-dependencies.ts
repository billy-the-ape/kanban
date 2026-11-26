import { stat } from "node:fs/promises";
import { join } from "node:path";

import { logWorkspaceEvent } from "../workspace-logger";
import type { CheckoutReader } from "./checkout-reader";
import { createFsCheckoutReader } from "./checkout-reader";
import type { DependencyEntry } from "./dependency-store";
import {
	DEPENDENCY_CACHE_DEFAULT_MAX_ENTRIES,
	pruneDependencyEntries,
	publishDependencyEntry,
	readDependencyEntry,
	touchDependencyEntry,
} from "./dependency-store";
import { computeEnvironmentSignature, computeInstallFingerprint } from "./fingerprint";
import type { InstallRunResult } from "./install-plan";
import { buildInstallPlan, findExecutableOnPath, runInstallPlan } from "./install-plan";
import type { DetectInstallUnitsResult } from "./install-units";
import { detectInstallUnits, discoverInstallUnitOutputs } from "./install-units";
import { removeTree, transferTree } from "./tree-transfer";
import type {
	DependencyInstallPlan,
	DependencyInstallUnit,
	DependencyTransferStrategy,
	DependencyUnitReport,
	WorktreeDependenciesReport,
} from "./types";

/**
 * WORKTREE-PACKAGES: make a task worktree runnable without the agent paying a
 * package-manager install per task.
 *
 * The rule is deliberately narrow so this can only ever improve on the previous
 * behavior: a unit is touched **only when its node_modules is missing** (the
 * existing symlink mirroring already fills in what it can). For those units:
 *
 * 1. a snapshot with byte-identical install inputs is link-copied out of
 *    `~/.cline/kanban/dep-cache` (measured at ~0.2s for Kanban's own 1.1GB root
 *    tree, against 7.7s for `npm ci` on the same machine);
 * 2. otherwise the workspace checkout's own install is snapshotted when it
 *    resolves the same inputs and looks up to date — no install at all;
 * 3. otherwise the package manager installs into the worktree, and the result
 *    becomes the snapshot every later task reuses.
 *
 * Nothing here is fatal: a failed detection, snapshot or install is reported on
 * the unit and the task still starts exactly as it did before this existed.
 */

const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const STRATEGY_ENV = "KANBAN_WORKTREE_DEPS_STRATEGY";
const INSTALL_ENV = "KANBAN_WORKTREE_DEPS_INSTALL";

export interface EnsureWorktreeDependenciesOptions {
	/** Workspace checkout a snapshot may be taken from. */
	repoPath: string;
	worktreePath: string;
	taskId?: string;
	/** Overrides the env-selected materialization strategy. */
	transferStrategy?: DependencyTransferStrategy;
	installTimeoutMs?: number;
	/** False keeps the pre-feature behavior: never run an install. */
	allowInstall?: boolean;
	now?: () => number;
	/** Test seams; production callers leave these alone. */
	detectUnits?: (reader: CheckoutReader) => Promise<DetectInstallUnitsResult>;
	runInstall?: (
		plan: DependencyInstallPlan,
		runOptions: { cwd: string; timeoutMs: number },
	) => Promise<InstallRunResult>;
	resolveExecutable?: (name: string) => Promise<string | null>;
	prune?: boolean;
}

interface Deps {
	detectUnits: (reader: CheckoutReader) => Promise<DetectInstallUnitsResult>;
	runInstall: (
		plan: DependencyInstallPlan,
		runOptions: { cwd: string; timeoutMs: number },
	) => Promise<InstallRunResult>;
	resolveExecutable: (name: string) => Promise<string | null>;
	now: () => number;
}

/** Per-unit state shared by the snapshot, restore and install steps. */
interface UnitContext {
	taskId: string | null;
	worktreePath: string;
	repoPath: string;
	unit: DependencyInstallUnit;
	worktreeReader: CheckoutReader;
	otherInstallPaths: string[];
	environment: string;
	cacheKey: string;
	digests: ReturnType<typeof computeInstallFingerprint>["digests"];
}

interface UnitOutcome {
	report: DependencyUnitReport;
	published: boolean;
}

/** Keyed by worktree path so a manual start and a dispatch pass share one job. */
const inFlightByWorktreePath = new Map<string, Promise<WorktreeDependenciesReport>>();

export function resolveTransferStrategy(
	overrides: { strategy?: DependencyTransferStrategy; env?: NodeJS.ProcessEnv } = {},
): DependencyTransferStrategy {
	if (overrides.strategy !== undefined) {
		return overrides.strategy;
	}
	const raw = (overrides.env ?? process.env)[STRATEGY_ENV];
	const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return normalized === "copy" ? "copy" : "link";
}

/**
 * Whether Kanban may run a package manager at all. Restoring a snapshot only
 * copies bytes a previous install produced, but an install executes whatever the
 * project's lifecycle scripts do, so an operator who does not want that
 * happening unattended can turn it off; the agent can still install for itself.
 */
export function resolveAllowInstall(overrides: { allowInstall?: boolean; env?: NodeJS.ProcessEnv } = {}): boolean {
	if (overrides.allowInstall === false) {
		return false;
	}
	const raw = (overrides.env ?? process.env)[INSTALL_ENV];
	const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return !(normalized === "off" || normalized === "0" || normalized === "false" || normalized === "no");
}

function resolveDeps(options: EnsureWorktreeDependenciesOptions): Deps {
	return {
		detectUnits: options.detectUnits ?? ((reader) => detectInstallUnits(reader)),
		runInstall:
			options.runInstall ??
			((plan, runOptions) => runInstallPlan(plan, { cwd: runOptions.cwd, timeoutMs: runOptions.timeoutMs })),
		resolveExecutable: options.resolveExecutable ?? ((name) => findExecutableOnPath(name)),
		now: options.now ?? Date.now,
	};
}

function reportUnit(
	unit: DependencyInstallUnit,
	source: DependencyUnitReport["source"],
	options: {
		reason?: string | null;
		cacheKey?: string | null;
		outputs?: string[];
		startedAt: number;
		deps: Deps;
	},
): DependencyUnitReport {
	return {
		installPath: unit.installPath,
		packageManager: unit.packageManager,
		source,
		reason: options.reason ?? null,
		cacheKey: options.cacheKey ?? null,
		outputs: options.outputs ?? [],
		durationMs: options.deps.now() - options.startedAt,
	};
}

function label(installPath: string): string {
	return installPath === "." ? "root" : installPath;
}

async function pathExists(path: string): Promise<boolean> {
	return (await stat(path).catch(() => null)) !== null;
}

/**
 * A workspace-checkout install is only trustworthy when it is at least as fresh
 * as every manifest and lockfile it resolves. A user who pulled newer lockfiles
 * without reinstalling therefore falls through to a real install instead of
 * publishing a stale snapshot for every later task.
 */
async function isInstallUpToDate(options: {
	rootPath: string;
	outputs: readonly string[];
	inputPaths: readonly string[];
}): Promise<boolean> {
	if (options.outputs.length === 0) {
		return false;
	}
	let newestInput = 0;
	for (const inputPath of options.inputPaths) {
		const info = await stat(join(options.rootPath, inputPath)).catch(() => null);
		if (info !== null && info.mtimeMs > newestInput) {
			newestInput = info.mtimeMs;
		}
	}
	for (const output of options.outputs) {
		const info = await stat(join(options.rootPath, output)).catch(() => null);
		if (info === null || info.mtimeMs < newestInput) {
			return false;
		}
	}
	return true;
}

/**
 * Copy a snapshot's outputs into the worktree. Any failure rolls back the
 * outputs this call created, because a half-restored `node_modules` is worse
 * than none: the agent's own install has to start from a clean directory.
 */
async function materializeOutputs(options: {
	context: UnitContext;
	outputs: readonly string[];
	entry: DependencyEntry;
	strategy: DependencyTransferStrategy;
}): Promise<string[]> {
	const materialized: string[] = [];
	const started: string[] = [];
	try {
		for (const output of options.outputs) {
			const destination = join(options.context.worktreePath, output);
			if (await pathExists(destination)) {
				// Something else created the tree while this job ran; leave it.
				materialized.push(output);
				continue;
			}
			started.push(output);
			await transferTree({
				from: options.entry.outputPath(output),
				to: destination,
				strategy: options.strategy,
			});
			materialized.push(output);
		}
		return materialized;
	} catch (error) {
		for (const output of started) {
			await removeTree(join(options.context.worktreePath, output)).catch(() => undefined);
		}
		throw error;
	}
}

async function publishSnapshot(options: {
	context: UnitContext;
	outputs: readonly string[];
	source: "install" | "source-checkout";
	sourceRoot: string;
	deps: Deps;
}): Promise<{ ok: boolean; error: string | null }> {
	const publish = await publishDependencyEntry({
		key: options.context.cacheKey,
		installPath: options.context.unit.installPath,
		packageManager: options.context.unit.packageManager,
		environment: options.context.environment,
		inputs: options.context.digests,
		outputs: [...options.outputs],
		source: options.source,
		repoRoot: options.context.repoPath,
		sourceRoot: options.sourceRoot,
		// Neither source tree is Kanban-owned: the workspace checkout and the
		// agent's own worktree both keep mutating, so the snapshot never shares
		// inodes with either of them.
		strategy: "copy",
		now: options.deps.now(),
	});
	return { ok: publish.ok && publish.meta !== null, error: publish.error };
}

async function restoreFromCache(options: {
	context: UnitContext;
	entry: DependencyEntry;
	strategy: DependencyTransferStrategy;
	deps: Deps;
	startedAt: number;
	/** Where the tree came from, which the report must not blur. */
	source: DependencyUnitReport["source"];
}): Promise<UnitOutcome | null> {
	const { context, entry, deps } = options;
	try {
		const materialized = await materializeOutputs({
			context,
			outputs: entry.meta.outputs,
			entry,
			strategy: options.strategy,
		});
		void touchDependencyEntry(entry, deps.now());
		return {
			published: false,
			report: reportUnit(context.unit, options.source, {
				cacheKey: context.cacheKey,
				outputs: materialized,
				startedAt: options.startedAt,
				deps,
			}),
		};
	} catch (error) {
		logWorkspaceEvent(
			`dependency snapshot restore failed task=${context.taskId ?? "?"} unit=${label(context.unit.installPath)} key=${context.cacheKey}: ${error instanceof Error ? error.message : String(error)}`,
		);
		// A snapshot that cannot be restored must not cost the task its
		// dependencies, so the caller falls through to the other sources.
		return null;
	}
}

async function snapshotFromSourceCheckout(options: {
	context: UnitContext;
	sourceDetected: DetectInstallUnitsResult;
	strategy: DependencyTransferStrategy;
	deps: Deps;
	startedAt: number;
}): Promise<UnitOutcome | null> {
	const { context, deps } = options;
	const sourceUnit = options.sourceDetected.units.find(
		(candidate) =>
			candidate.installPath === context.unit.installPath && candidate.packageManager === context.unit.packageManager,
	);
	if (sourceUnit === undefined) {
		return null;
	}
	const sourceFingerprint = computeInstallFingerprint({
		installPath: sourceUnit.installPath,
		packageManager: sourceUnit.packageManager,
		inputs: sourceUnit.inputs,
		environment: context.environment,
	});
	// The worktree may sit on a newer base ref than the workspace checkout, in
	// which case its install inputs differ and nothing here can be reused.
	if (sourceFingerprint.key !== context.cacheKey) {
		return null;
	}
	const sourceOutputs = await discoverInstallUnitOutputs(
		createFsCheckoutReader(context.repoPath),
		sourceUnit.installPath,
		options.sourceDetected.units
			.filter((candidate) => candidate.installPath !== sourceUnit.installPath)
			.map((candidate) => candidate.installPath),
	);
	if (sourceOutputs.length === 0) {
		return null;
	}
	const fresh = await isInstallUpToDate({
		rootPath: context.repoPath,
		outputs: sourceOutputs,
		inputPaths: sourceUnit.inputs.map((input) => input.path),
	});
	if (!fresh) {
		logWorkspaceEvent(
			`workspace checkout install is older than its manifests task=${context.taskId ?? "?"} unit=${label(context.unit.installPath)}; installing instead of snapshotting`,
		);
		return null;
	}
	const publish = await publishSnapshot({
		context,
		outputs: sourceOutputs,
		source: "source-checkout",
		sourceRoot: context.repoPath,
		deps,
	});
	if (!publish.ok) {
		logWorkspaceEvent(
			`dependency snapshot publish from workspace checkout failed task=${context.taskId ?? "?"} unit=${label(context.unit.installPath)}: ${publish.error ?? "unknown error"}`,
		);
		return null;
	}
	const entry = await readDependencyEntry(context.cacheKey);
	if (entry === null) {
		return null;
	}
	const restored = await restoreFromCache({
		context,
		entry,
		strategy: options.strategy,
		deps,
		startedAt: options.startedAt,
		source: "source-checkout",
	});
	if (restored === null) {
		return null;
	}
	// The snapshot was created by this call, so pruning gets a chance to bound it.
	return { ...restored, published: true };
}

async function installIntoWorktree(options: {
	context: UnitContext;
	deps: Deps;
	allowInstall: boolean;
	installTimeoutMs: number;
	startedAt: number;
}): Promise<UnitOutcome> {
	const { context, deps } = options;
	const { unit } = context;
	if (!options.allowInstall) {
		return {
			published: false,
			report: reportUnit(unit, "skipped", {
				reason: "No snapshot matched and automatic installs are disabled",
				cacheKey: context.cacheKey,
				startedAt: options.startedAt,
				deps,
			}),
		};
	}
	const plan = buildInstallPlan({ packageManager: unit.packageManager, hasLockfile: unit.lockfiles.length > 0 });
	const executable = await deps.resolveExecutable(plan.command);
	if (executable === null) {
		return {
			published: false,
			report: reportUnit(unit, "skipped", {
				reason: `${plan.command} is not installed, so dependencies could not be prepared`,
				cacheKey: context.cacheKey,
				startedAt: options.startedAt,
				deps,
			}),
		};
	}
	const install = await deps.runInstall(plan, {
		cwd: join(context.worktreePath, unit.installPath === "." ? "" : unit.installPath),
		timeoutMs: options.installTimeoutMs,
	});
	const installedOutputs = await discoverInstallUnitOutputs(
		context.worktreeReader,
		unit.installPath,
		context.otherInstallPaths,
	);
	if (!install.ok || installedOutputs.length === 0) {
		// The installer's own output is the actionable part; the exit summary is
		// only useful when nothing was captured.
		const detail =
			install.output.trim().length > 0 ? install.output.trim().split("\n").slice(-3).join(" ") : install.error;
		return {
			published: false,
			report: reportUnit(unit, "failed", {
				reason:
					installedOutputs.length === 0 && install.ok
						? "Install produced no node_modules directory"
						: `Install failed: ${detail ?? "unknown error"}`,
				cacheKey: context.cacheKey,
				startedAt: options.startedAt,
				deps,
			}),
		};
	}
	const publish = await publishSnapshot({
		context,
		outputs: installedOutputs,
		source: "install",
		sourceRoot: context.worktreePath,
		deps,
	});
	return {
		published: true,
		report: reportUnit(unit, "install", {
			reason: publish.ok ? null : (publish.error ?? "Snapshot publish failed"),
			cacheKey: context.cacheKey,
			outputs: installedOutputs,
			startedAt: options.startedAt,
			deps,
		}),
	};
}

export async function ensureWorktreeDependencies(
	options: EnsureWorktreeDependenciesOptions,
): Promise<WorktreeDependenciesReport> {
	const pending = inFlightByWorktreePath.get(options.worktreePath);
	if (pending !== undefined) {
		return await pending;
	}
	const job = runEnsureWorktreeDependencies(options).finally(() => {
		if (inFlightByWorktreePath.get(options.worktreePath) === job) {
			inFlightByWorktreePath.delete(options.worktreePath);
		}
	});
	inFlightByWorktreePath.set(options.worktreePath, job);
	return await job;
}

async function runEnsureWorktreeDependencies(
	options: EnsureWorktreeDependenciesOptions,
): Promise<WorktreeDependenciesReport> {
	const deps = resolveDeps(options);
	const startedAt = deps.now();
	const worktreePath = options.worktreePath;
	const strategy = resolveTransferStrategy({ strategy: options.transferStrategy });
	const fail = (error: string, units: DependencyUnitReport[] = []): WorktreeDependenciesReport => {
		logWorkspaceEvent(
			`worktree dependencies incomplete task=${options.taskId ?? "?"} worktree=${worktreePath}: ${error}`,
		);
		return { ok: false, worktreePath, units, durationMs: deps.now() - startedAt, error };
	};

	let detected: DetectInstallUnitsResult;
	try {
		detected = await deps.detectUnits(createFsCheckoutReader(worktreePath));
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	if (detected.units.length === 0) {
		// Not a Node project (no root manifest): there is nothing this feature
		// can do, and the worktree is exactly as it was before.
		return { ok: true, worktreePath, units: [], durationMs: deps.now() - startedAt, error: null };
	}

	const environment = computeEnvironmentSignature();
	const reports: DependencyUnitReport[] = [];
	let published = false;
	let sourceDetected: DetectInstallUnitsResult | null = null;

	for (const unit of detected.units) {
		const startedUnitAt = deps.now();
		const otherInstallPaths = detected.units
			.filter((candidate) => candidate.installPath !== unit.installPath)
			.map((candidate) => candidate.installPath);
		const fingerprint = computeInstallFingerprint({
			installPath: unit.installPath,
			packageManager: unit.packageManager,
			inputs: unit.inputs,
			environment,
		});
		const context: UnitContext = {
			taskId: options.taskId ?? null,
			worktreePath,
			repoPath: options.repoPath,
			unit,
			worktreeReader: createFsCheckoutReader(worktreePath),
			otherInstallPaths,
			environment,
			cacheKey: fingerprint.key,
			digests: fingerprint.digests,
		};

		const presentOutputs = await discoverInstallUnitOutputs(
			context.worktreeReader,
			unit.installPath,
			otherInstallPaths,
		);
		if (presentOutputs.length > 0) {
			// The agent, an earlier start, or Kanban's symlink mirroring already
			// owns this tree; replacing it would fight whatever put it there.
			reports.push(
				reportUnit(unit, "already-present", {
					reason: "node_modules already exists in the worktree",
					outputs: presentOutputs,
					startedAt: startedUnitAt,
					deps,
				}),
			);
			continue;
		}

		const cached = await readDependencyEntry(context.cacheKey);
		if (cached !== null) {
			const restored = await restoreFromCache({
				context,
				entry: cached,
				strategy,
				deps,
				startedAt: startedUnitAt,
				source: "cache",
			});
			if (restored !== null) {
				reports.push(restored.report);
				continue;
			}
		}

		// The common single-repo case: the developer's own install already
		// resolves exactly what this worktree needs, so reusing it costs nothing.
		sourceDetected = sourceDetected ?? (await deps.detectUnits(createFsCheckoutReader(options.repoPath)));
		const fromCheckout = await snapshotFromSourceCheckout({
			context,
			sourceDetected,
			strategy,
			deps,
			startedAt: startedUnitAt,
		});
		if (fromCheckout !== null) {
			published = published || fromCheckout.published;
			reports.push(fromCheckout.report);
			continue;
		}

		const installed = await installIntoWorktree({
			context,
			deps,
			allowInstall: resolveAllowInstall({ allowInstall: options.allowInstall }),
			installTimeoutMs: options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
			startedAt: startedUnitAt,
		});
		published = published || installed.published;
		reports.push(installed.report);
	}

	if (options.prune !== false && (published || reports.some((report) => report.cacheKey !== null))) {
		// Bound the cache whenever this start touched it. Pruning also reclaims
		// staging directories left by an interrupted publish, which is why a
		// snapshot the layer created but could not restore (its report is then
		// null) still has to reach this line.
		await pruneDependencyEntries({ maxEntries: DEPENDENCY_CACHE_DEFAULT_MAX_ENTRIES }).catch(() => null);
	}

	const failed = reports.filter((report) => report.source === "failed");
	logWorkspaceEvent(
		`worktree dependencies task=${options.taskId ?? "?"} ${reports
			.map((report) => `${label(report.installPath)}:${report.source}`)
			.join(" ")} in ${deps.now() - startedAt}ms`,
	);
	return {
		ok: failed.length === 0,
		worktreePath,
		units: reports,
		durationMs: deps.now() - startedAt,
		error:
			failed.length === 0
				? null
				: failed.map((report) => `${label(report.installPath)}: ${report.reason ?? "failed"}`).join("; "),
	};
}
