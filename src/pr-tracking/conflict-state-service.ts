// PCR-1: the conflict-state provider behind `getTaskTrackingState`.
//
// The conflict block must answer without any consumer checkboxes being armed
// (auto-merge's opt-in is not the trigger's gate), so this service reads the
// durable record directly and tops it up lazily:
//
// - Provider snapshot: when the host supports metadata reads and the snapshot
//   is missing or stale, one debounced fire-and-forget
//   `refreshPrMetadataOnce(prKey)` runs (the coordinator coalesces and honors
//   Retry-After). Opening the PRs tab is therefore enough to know the answer;
//   the 5s panel poll picks the fresh snapshot up.
// - Local probe: only when NO provider snapshot exists. Probes fetch over the
//   network, so results are cached per (workspace, task, PR) with a TTL and
//   refreshed in the background — the response never blocks on git.
import type { RuntimePrConflictState } from "../core/api-contract";
import { supportsPrMetadataRefresh } from "../core/pull-request-providers/capabilities";
import { type MergeProbeRunner, probeMergeConflictAgainstBase } from "../workspace/pr-merge-probe";
import { latestSnapshotFromRecord, type PrConflictProbeView, resolvePrConflictState } from "./pr-conflict-state";
import type { PrRecordStoreBase } from "./pr-record-store";
import { PR_SNAPSHOT_STALE_AFTER_MS } from "./pr-snapshots";
import type { PrTrackingCoordinator } from "./pr-tracking-coordinator";

/** Minimum gap between lazy one-shot metadata reads for one PR. */
export const CONFLICT_LAZY_REFRESH_MIN_INTERVAL_MS = 30_000;
/** A local probe result is reused for this long before a fresh background probe. */
export const CONFLICT_PROBE_TTL_MS = 120_000;

export interface ConflictStateServiceDeps {
	getCoordinator: () => PrTrackingCoordinator | null;
	getStore: () => PrRecordStoreBase;
	/** Resolves the task's own worktree (`ensure: false`); null when missing. */
	resolveWorktreePath: (input: { workspacePath: string; taskId: string; baseRef: string }) => Promise<string | null>;
	/** Injectable for tests; production uses the real `runGit`. */
	probeRunner?: MergeProbeRunner;
	now?: () => number;
	warn?: (message: string) => void;
}

export interface ConflictStateQuery {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	prKey: string;
	/** The card's own base ref (the probe's merge target when no snapshot exists). */
	baseRef: string;
	provider: "github" | "gitlab" | "bitbucket";
	host: string;
	/** Repository (`owner/repo`) of the PR link, for probe remote selection. */
	repository: string;
	/** True while the card is In Progress or In Review (probes need a checkout). */
	active: boolean;
}

export interface ConflictStateService {
	/** Non-blocking: returns current knowledge and schedules top-ups. */
	compute(query: ConflictStateQuery): Promise<RuntimePrConflictState>;
	/** The Re-check affordance: one forced provider read, then recompute. */
	recheck(query: ConflictStateQuery): Promise<RuntimePrConflictState>;
}

interface ProbeCacheEntry {
	view: PrConflictProbeView;
	/** When the probe finished (or failed); drives the TTL, never the value. */
	completedAt: number;
	/** True while a background probe run is in flight (prevents overlap). */
	inFlight: boolean;
}

export function createConflictStateService(deps: ConflictStateServiceDeps): ConflictStateService {
	const now = deps.now ?? Date.now;
	const lastLazyRefreshAt = new Map<string, number>();
	const probeCache = new Map<string, ProbeCacheEntry>();

	const providerSupported = (query: ConflictStateQuery): boolean =>
		supportsPrMetadataRefresh({ provider: query.provider, host: query.host });

	const lazyRefresh = (query: ConflictStateQuery): void => {
		const coordinator = deps.getCoordinator();
		if (coordinator === null || !providerSupported(query)) {
			return;
		}
		const last = lastLazyRefreshAt.get(query.prKey);
		const at = now();
		if (last !== undefined && at - last < CONFLICT_LAZY_REFRESH_MIN_INTERVAL_MS) {
			return;
		}
		lastLazyRefreshAt.set(query.prKey, at);
		void coordinator
			.refreshPrMetadataOnce(query.prKey)
			.then(() => {
				// The result lands in the durable record; the next panel read sees it.
			})
			.catch((error: unknown) => {
				deps.warn?.(
					`[pr-conflict] lazy metadata refresh failed pr=${query.prKey} error=${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
	};

	const runProbe = (query: ConflictStateQuery, cacheKey: string, completedAt: number): void => {
		const entry = probeCache.get(cacheKey);
		if (entry?.inFlight) {
			return;
		}
		probeCache.set(cacheKey, {
			view: entry?.view ?? { outcome: "failed", error: null },
			completedAt: entry?.completedAt ?? completedAt,
			inFlight: true,
		});
		void (async () => {
			const cwd = await deps.resolveWorktreePath({
				workspacePath: query.workspacePath,
				taskId: query.taskId,
				baseRef: query.baseRef,
			});
			if (cwd === null) {
				return {
					outcome: "failed" as const,
					error: "The task checkout is unavailable, so no local merge probe could run.",
				};
			}
			const result = await probeMergeConflictAgainstBase({
				cwd,
				baseRef: query.baseRef,
				baseRepository: query.repository,
				runner: deps.probeRunner,
			});
			return {
				outcome: result.outcome,
				error: result.error,
				baseSha: result.baseSha,
				headSha: result.headSha,
				baseRef: query.baseRef,
			};
		})()
			.then((view) => {
				probeCache.set(cacheKey, { view: { ...view, checkedAt: now() }, completedAt: now(), inFlight: false });
			})
			.catch((error: unknown) => {
				probeCache.set(cacheKey, {
					view: { outcome: "failed", error: error instanceof Error ? error.message : String(error) },
					completedAt: now(),
					inFlight: false,
				});
				deps.warn?.(
					`[pr-conflict] local probe failed task=${query.taskId} error=${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
	};

	const compute = async (query: ConflictStateQuery): Promise<RuntimePrConflictState> => {
		const recordResult = await deps.getStore().loadRecord(query.prKey);
		const snapshot = latestSnapshotFromRecord(recordResult.ok ? recordResult.record : null);
		const snapshotStale = snapshot === null || now() - snapshot.checkedAt > PR_SNAPSHOT_STALE_AFTER_MS;
		if (providerSupported(query) && snapshotStale) {
			lazyRefresh(query);
		}
		let probe: PrConflictProbeView | null = null;
		if (snapshot === null && query.active) {
			const cacheKey = `${query.workspaceId}|${query.taskId}|${query.prKey}`;
			const cached = probeCache.get(cacheKey);
			if (cached !== undefined && !cached.inFlight) {
				probe = { ...cached.view, checkedAt: cached.view.checkedAt ?? cached.completedAt };
				if (now() - cached.completedAt > CONFLICT_PROBE_TTL_MS) {
					runProbe(query, cacheKey, cached.completedAt);
				}
			} else if (cached === undefined) {
				runProbe(query, cacheKey, 0);
			}
		}
		return resolvePrConflictState({
			prKey: query.prKey,
			snapshot,
			providerSupported: providerSupported(query),
			probe,
		});
	};

	const recheck = async (query: ConflictStateQuery): Promise<RuntimePrConflictState> => {
		const coordinator = deps.getCoordinator();
		if (coordinator !== null && providerSupported(query)) {
			lastLazyRefreshAt.set(query.prKey, now());
			try {
				await coordinator.refreshPrMetadataOnce(query.prKey);
			} catch (error) {
				deps.warn?.(
					`[pr-conflict] forced recheck failed pr=${query.prKey} error=${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		return await compute(query);
	};

	return { compute, recheck };
}
