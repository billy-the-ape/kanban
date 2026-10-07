// PRTRACK-0: durable PR record store.
//
// One versioned record per canonical PR identity, persisted at
// `<runtimeHome>/pr-tracking/prs/<sha256(canonicalPrKey)>.json`, written only
// through revision-checked atomic updates serialized by the single
// tracking-registry mutex. The mutex's proper-lockfile `path` is
// `<runtimeHome>/pr-tracking/registry` — distinct from the scheduler lock's
// `path` (`<runtimeHome>/pr-tracking`) — because proper-lockfile keys its
// in-process lock map by `path`, not by the on-disk lockfile name.
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
	type GitHubPrTaskBinding,
	type GitHubPrTerminalStopReason,
	type GitHubPrTrackingRecord,
	githubPrTrackingRecordSchema,
} from "../core/api-contract";
import type { LockRequest } from "../fs/locked-file-system";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { parseCanonicalPrKey, prKeyDigest, recordIdentityMatchesKey } from "./pr-identity";

export const PR_TRACKING_DIR_NAME = "pr-tracking";
export const PR_RECORDS_DIR_NAME = "prs";
/** Orphan records are deleted only after 24 hours with no task links. */
export const PR_ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000;

export function getPrTrackingRootPath(): string {
	return join(getRuntimeHomePath(), PR_TRACKING_DIR_NAME);
}

export function getPrTrackingRecordsPath(): string {
	return join(getPrTrackingRootPath(), PR_RECORDS_DIR_NAME);
}

export function getPrTrackingRecordPath(canonicalPrKey: string): string {
	return join(getPrTrackingRecordsPath(), `${prKeyDigest(canonicalPrKey)}.json`);
}

/**
 * Scheduler lock for the automation storage root: one Kanban process per
 * root may run the PR-tracking scheduler. Failure blocks only the scheduler,
 * never the runtime.
 */
export function getPrTrackingSchedulerLockRequest(): LockRequest {
	const root = getPrTrackingRootPath();
	return { path: root, type: "directory", lockfilePath: join(root, ".scheduler.lock") };
}

/**
 * Tracking-registry mutex serializing all shared record/reservation changes.
 * Never held while acquiring task/Git locks or awaiting network/model work.
 */
export function getPrTrackingRegistryMutexRequest(): LockRequest {
	const root = getPrTrackingRootPath();
	const registryPath = join(root, "registry");
	return { path: registryPath, type: "directory", lockfilePath: join(registryPath, ".registry.lock") };
}

export type PrRecordLoadResult =
	| { ok: true; record: GitHubPrTrackingRecord }
	| { ok: false; reason: "not_found" | "malformed" };

export type PrRecordUpdateResult =
	| { ok: true; record: GitHubPrTrackingRecord }
	| { ok: false; reason: "malformed" | "conflict" | "invalid" };

export interface PrRecordStoreOptions {
	/** Override the automation storage root (tests). Defaults to the runtime home. */
	rootPath?: string;
	now?: () => number;
}

export interface PrRecordIdentity {
	canonicalPrKey: string;
	provider: "github";
	host: string;
	repository: string;
	number: number;
}

function emptyCommentAutomation(): GitHubPrTrackingRecord["commentAutomation"] {
	return {
		repairOwner: null,
		pendingFeedbackFingerprint: null,
		lastDispatchedFeedbackFingerprint: null,
		debounceDeadline: null,
		firstPendingAt: null,
		dispatch: null,
	};
}

function emptyReservation(): GitHubPrTrackingRecord["reservation"] {
	return {
		ownerRevision: 0,
		fencingGeneration: 0,
		state: "none",
		reservedBy: null,
		reservedOperation: null,
		transferHandoff: null,
	};
}

function emptyReplayCursors(): GitHubPrTaskBinding["replayCursors"] {
	return {};
}

export class PrRecordStore {
	private readonly rootPath: string;
	private readonly now: () => number;

	constructor(options: PrRecordStoreOptions = {}) {
		this.rootPath = options.rootPath ?? getPrTrackingRootPath();
		this.now = options.now ?? Date.now;
	}

	get recordsPath(): string {
		return join(this.rootPath, PR_RECORDS_DIR_NAME);
	}

	private recordPath(canonicalPrKey: string): string {
		return join(this.recordsPath, `${prKeyDigest(canonicalPrKey)}.json`);
	}

	private registryMutexRequest(): LockRequest {
		const registryPath = join(this.rootPath, "registry");
		return { path: registryPath, type: "directory", lockfilePath: join(registryPath, ".registry.lock") };
	}

	private parseRecord(raw: string, canonicalPrKey: string): GitHubPrTrackingRecord | null {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}
		const record = githubPrTrackingRecordSchema.safeParse(parsed);
		if (!record.success) {
			return null;
		}
		if (record.data.canonicalPrKey !== canonicalPrKey || !recordIdentityMatchesKey(record.data, canonicalPrKey)) {
			return null;
		}
		return record.data;
	}

	/**
	 * Load a record, validating the composite identity against the key.
	 * Malformed records block tracking (they never create subscriptions).
	 */
	async loadRecord(canonicalPrKey: string): Promise<PrRecordLoadResult> {
		const parsed = parseCanonicalPrKey(canonicalPrKey);
		if (!parsed) {
			return { ok: false, reason: "malformed" };
		}
		return await lockedFileSystem.withLock(this.registryMutexRequest(), async () => {
			let raw: string;
			try {
				raw = await readFile(this.recordPath(canonicalPrKey), "utf8");
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
					return { ok: false, reason: "not_found" } satisfies PrRecordLoadResult;
				}
				throw error;
			}
			const record = this.parseRecord(raw, canonicalPrKey);
			if (!record) {
				return { ok: false, reason: "malformed" } satisfies PrRecordLoadResult;
			}
			return { ok: true, record };
		});
	}

	/**
	 * Create the record for a canonical PR identity when absent. Returns the
	 * existing record when already present; refuses to clobber a malformed one.
	 */
	async createRecord(identity: PrRecordIdentity): Promise<PrRecordLoadResult> {
		const existing = await this.loadRecord(identity.canonicalPrKey);
		if (existing.ok) {
			return existing;
		}
		if (existing.reason === "malformed") {
			return existing;
		}
		const record: GitHubPrTrackingRecord = {
			schemaVersion: 1,
			revision: 0,
			updatedAt: this.now(),
			canonicalPrKey: identity.canonicalPrKey,
			provider: identity.provider,
			host: identity.host,
			repository: identity.repository,
			number: identity.number,
			orphanedAt: null,
			snapshots: {},
			taskBindings: [],
			commentAutomation: emptyCommentAutomation(),
			reservation: emptyReservation(),
		};
		return await lockedFileSystem.withLock(this.registryMutexRequest(), async () => {
			await lockedFileSystem.writeJsonFileAtomic(this.recordPath(identity.canonicalPrKey), record, {
				lock: null,
			});
			return { ok: true, record } satisfies PrRecordLoadResult;
		});
	}

	/**
	 * Revision-checked update: `mutate` receives the current record and returns
	 * the next full record (unrelated fields preserved by the caller). Fails
	 * without writing when `expectedRevision` is set and no longer matches.
	 */
	async updateRecord(
		canonicalPrKey: string,
		expectedRevision: number | undefined,
		mutate: (record: GitHubPrTrackingRecord) => GitHubPrTrackingRecord | null,
	): Promise<PrRecordUpdateResult> {
		return await lockedFileSystem.withLock(this.registryMutexRequest(), async () => {
			let raw: string;
			try {
				raw = await readFile(this.recordPath(canonicalPrKey), "utf8");
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
					return { ok: false, reason: "conflict" } satisfies PrRecordUpdateResult;
				}
				throw error;
			}
			const current = this.parseRecord(raw, canonicalPrKey);
			if (!current) {
				return { ok: false, reason: "malformed" } satisfies PrRecordUpdateResult;
			}
			if (expectedRevision !== undefined && current.revision !== expectedRevision) {
				return { ok: false, reason: "conflict" } satisfies PrRecordUpdateResult;
			}
			const next = mutate(current);
			if (next === null) {
				return { ok: false, reason: "invalid" } satisfies PrRecordUpdateResult;
			}
			const validated = githubPrTrackingRecordSchema.safeParse(next);
			if (!validated.success) {
				return { ok: false, reason: "invalid" } satisfies PrRecordUpdateResult;
			}
			const written: GitHubPrTrackingRecord = {
				...validated.data,
				revision: current.revision + 1,
				updatedAt: this.now(),
			};
			await lockedFileSystem.writeJsonFileAtomic(this.recordPath(canonicalPrKey), written, { lock: null });
			return { ok: true, record: written };
		});
	}

	/**
	 * Enumerate all record files. Returns validated records plus the file
	 * names of malformed ones (used solely for startup orphan classification).
	 */
	async listRecords(): Promise<{ records: GitHubPrTrackingRecord[]; malformedFiles: string[] }> {
		return await lockedFileSystem.withLock(this.registryMutexRequest(), async () => {
			let entries: string[];
			try {
				entries = await readdir(this.recordsPath);
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
					return { records: [], malformedFiles: [] };
				}
				throw error;
			}
			const records: GitHubPrTrackingRecord[] = [];
			const malformedFiles: string[] = [];
			for (const entry of entries.sort()) {
				if (!entry.endsWith(".json")) {
					continue;
				}
				const raw = await readFile(join(this.recordsPath, entry), "utf8");
				let parsed: unknown;
				try {
					parsed = JSON.parse(raw);
				} catch {
					malformedFiles.push(entry);
					continue;
				}
				const record = githubPrTrackingRecordSchema.safeParse(parsed);
				if (!record.success || !recordIdentityMatchesKey(record.data, record.data.canonicalPrKey)) {
					malformedFiles.push(entry);
					continue;
				}
				records.push(record.data);
			}
			return { records, malformedFiles };
		});
	}

	/**
	 * Delete an orphan record only when the retention clock has elapsed and no
	 * live/uncertain operation is outstanding (unresolved reservations or
	 * remaining task bindings block cleanup).
	 */
	async deleteOrphanRecord(
		canonicalPrKey: string,
		options: { retentionMs?: number },
	): Promise<{ ok: boolean; reason?: "retained" | "not_orphaned" | "has_live_operation" | "malformed" }> {
		const retentionMs = options.retentionMs ?? PR_ORPHAN_RETENTION_MS;
		return await lockedFileSystem.withLock(this.registryMutexRequest(), async () => {
			let raw: string;
			try {
				raw = await readFile(this.recordPath(canonicalPrKey), "utf8");
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
					return { ok: false, reason: "not_orphaned" as const };
				}
				throw error;
			}
			const record = this.parseRecord(raw, canonicalPrKey);
			if (!record) {
				return { ok: false, reason: "malformed" as const };
			}
			if (record.orphanedAt === null || this.now() - record.orphanedAt < retentionMs) {
				return { ok: false, reason: "not_orphaned" as const };
			}
			if (record.taskBindings.length > 0 || record.reservation.state !== "none") {
				return { ok: false, reason: "has_live_operation" as const };
			}
			await rm(this.recordPath(canonicalPrKey), { force: true });
			return { ok: true };
		});
	}

	/** Persist a durable metadata snapshot for one access scope (CAS). */
	async setMetadataSnapshot(
		canonicalPrKey: string,
		snapshot: GitHubPrTrackingRecord["snapshots"][string],
	): Promise<PrRecordUpdateResult> {
		return await this.updateRecord(canonicalPrKey, undefined, (record) => ({
			...record,
			snapshots: {
				...record.snapshots,
				[snapshot.accessScopeId]: snapshot,
			},
		}));
	}

	/**
	 * Create-or-reestablish a task binding. Re-establishing the same handled PR
	 * bumps the monotonic link generation and preserves consumed markers.
	 */
	async upsertTaskBinding(
		canonicalPrKey: string,
		binding: { workspaceId: string; taskId: string },
	): Promise<PrRecordUpdateResult> {
		return await this.updateRecord(canonicalPrKey, undefined, (record) => {
			const existing = record.taskBindings.find(
				(item) => item.workspaceId === binding.workspaceId && item.taskId === binding.taskId,
			);
			const nextBinding: GitHubPrTaskBinding = existing
				? {
						...existing,
						linkGeneration: existing.linkGeneration + 1,
					}
				: {
						workspaceId: binding.workspaceId,
						taskId: binding.taskId,
						linkGeneration: 1,
						linkedAt: this.now(),
						terminalStop: null,
						mergeCompletion: null,
						replayCursors: emptyReplayCursors(),
					};
			const taskBindings = existing
				? record.taskBindings.map((item) => (item === existing ? nextBinding : item))
				: [...record.taskBindings, nextBinding];
			return {
				...record,
				orphanedAt: null,
				taskBindings,
			};
		});
	}

	/**
	 * Revision-checked binding update (terminal stop markers, merge
	 * completion, replay cursors). `mutate` returning null aborts without
	 * writing.
	 */
	async updateTaskBinding(
		canonicalPrKey: string,
		binding: { workspaceId: string; taskId: string },
		expectedRevision: number | undefined,
		mutate: (item: GitHubPrTaskBinding) => GitHubPrTaskBinding | null,
	): Promise<PrRecordUpdateResult> {
		return await this.updateRecord(canonicalPrKey, expectedRevision, (record) => {
			const existing = record.taskBindings.find(
				(item) => item.workspaceId === binding.workspaceId && item.taskId === binding.taskId,
			);
			if (!existing) {
				return null;
			}
			const next = mutate(existing);
			if (next === null) {
				return null;
			}
			return {
				...record,
				taskBindings: record.taskBindings.map((item) => (item === existing ? next : item)),
			};
		});
	}

	/** Persist a terminal stop observation on a binding (null clears it). */
	async setTaskTerminalStop(
		canonicalPrKey: string,
		binding: { workspaceId: string; taskId: string },
		terminalStop: {
			reason: GitHubPrTerminalStopReason;
			observedAt: number;
			reconciliationReads: number;
		} | null,
	): Promise<PrRecordUpdateResult> {
		return await this.updateTaskBinding(canonicalPrKey, binding, undefined, (item) => ({
			...item,
			terminalStop,
		}));
	}
}
