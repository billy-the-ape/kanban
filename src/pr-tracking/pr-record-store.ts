// PRTRACK-0: durable PR record store.
//
// One versioned record per canonical PR identity, persisted at
// `<runtimeHome>/pr-tracking/prs/<sha256(canonicalPrKey)>.json`, written only
// through revision-checked atomic updates serialized by the single
// tracking-registry mutex. The mutex's proper-lockfile `path` is
// `<runtimeHome>/pr-tracking/registry` — distinct from the scheduler lock's
// `path` (`<runtimeHome>/pr-tracking`) — because proper-lockfile keys its
// in-process lock map by `path`, not by the on-disk lockfile name.
//
// `PrRecordStoreBase` holds the shared CAS semantics; `PrRecordStore` (disk)
// and `InMemoryPrRecordStore` supply the storage backend. The coordinator
// depends on the `PrRecordStorePort` interface; tests use the in-memory
// backend so they stay deterministic (no fs I/O, no lockfile retry timers
// under fake timers).
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

/** Tri-state of a record at one canonical key. */
export type PrRecordState =
	| { kind: "absent" }
	| { kind: "malformed" }
	| { kind: "present"; record: GitHubPrTrackingRecord };

/** Storage-side writes available inside one atomic record transaction. */
export interface PrRecordIo {
	write: (record: GitHubPrTrackingRecord) => Promise<void>;
	remove: () => Promise<void>;
}

/**
 * Storage port for the durable PR tracking record. The coordinator depends on
 * this interface; `PrRecordStore` (disk) is the production backend and
 * `InMemoryPrRecordStore` is a deterministic backend for tests.
 */
export interface PrRecordStorePort {
	loadRecord(canonicalPrKey: string): Promise<PrRecordLoadResult>;
	createRecord(identity: PrRecordIdentity): Promise<PrRecordLoadResult>;
	updateRecord(
		canonicalPrKey: string,
		expectedRevision: number | undefined,
		mutate: (record: GitHubPrTrackingRecord) => GitHubPrTrackingRecord | null,
	): Promise<PrRecordUpdateResult>;
	listRecords(): Promise<{ records: GitHubPrTrackingRecord[]; malformedFiles: string[] }>;
	deleteOrphanRecord(
		canonicalPrKey: string,
		options: { retentionMs?: number },
	): Promise<{ ok: boolean; reason?: "retained" | "not_orphaned" | "has_live_operation" | "malformed" }>;
	setMetadataSnapshot(
		canonicalPrKey: string,
		snapshot: GitHubPrTrackingRecord["snapshots"][string],
	): Promise<PrRecordUpdateResult>;
	upsertTaskBinding(
		canonicalPrKey: string,
		binding: { workspaceId: string; taskId: string },
	): Promise<PrRecordUpdateResult>;
	updateTaskBinding(
		canonicalPrKey: string,
		binding: { workspaceId: string; taskId: string },
		expectedRevision: number | undefined,
		mutate: (item: GitHubPrTaskBinding) => GitHubPrTaskBinding | null,
	): Promise<PrRecordUpdateResult>;
	setTaskTerminalStop(
		canonicalPrKey: string,
		binding: { workspaceId: string; taskId: string },
		terminalStop: {
			reason: GitHubPrTerminalStopReason;
			observedAt: number;
			reconciliationReads: number;
		} | null,
	): Promise<PrRecordUpdateResult>;
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

/**
 * Shared CAS semantics over any backend. `withRecord` runs `op` atomically:
 * the disk backend holds the registry mutex for the whole read-mutate-write;
 * the in-memory backend resolves synchronously. `io` performs the storage
 * write/remove inside the same transaction.
 */
export abstract class PrRecordStoreBase implements PrRecordStorePort {
	protected abstract nowValue(): number;
	protected abstract withRecord<T>(
		canonicalPrKey: string,
		op: (state: PrRecordState, io: PrRecordIo) => T | Promise<T>,
	): Promise<T>;
	abstract listRecords(): Promise<{ records: GitHubPrTrackingRecord[]; malformedFiles: string[] }>;

	/**
	 * Load a record, validating the composite identity against the key.
	 * Malformed records block tracking (they never create subscriptions).
	 */
	async loadRecord(canonicalPrKey: string): Promise<PrRecordLoadResult> {
		if (!parseCanonicalPrKey(canonicalPrKey)) {
			return { ok: false, reason: "malformed" };
		}
		return await this.withRecord(canonicalPrKey, (state) => {
			if (state.kind === "present") {
				return { ok: true, record: state.record } satisfies PrRecordLoadResult;
			}
			if (state.kind === "malformed") {
				return { ok: false, reason: "malformed" } satisfies PrRecordLoadResult;
			}
			return { ok: false, reason: "not_found" } satisfies PrRecordLoadResult;
		});
	}

	/**
	 * Create the record for a canonical PR identity when absent — the
	 * check-then-write happens inside ONE transaction, so concurrent creation
	 * never clobbers an existing record. Returns the existing record when
	 * already present; refuses to clobber a malformed one.
	 */
	async createRecord(identity: PrRecordIdentity): Promise<PrRecordLoadResult> {
		if (!parseCanonicalPrKey(identity.canonicalPrKey)) {
			return { ok: false, reason: "malformed" };
		}
		return await this.withRecord(identity.canonicalPrKey, async (state, io) => {
			if (state.kind === "present") {
				return { ok: true, record: state.record } satisfies PrRecordLoadResult;
			}
			if (state.kind === "malformed") {
				return { ok: false, reason: "malformed" } satisfies PrRecordLoadResult;
			}
			const record: GitHubPrTrackingRecord = {
				schemaVersion: 1,
				revision: 0,
				updatedAt: this.nowValue(),
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
			await io.write(record);
			return { ok: true, record } satisfies PrRecordLoadResult;
		});
	}

	/**
	 * Revision-checked update: `mutate` receives the current record and
	 * returns the next full record (unrelated fields are preserved by the
	 * caller). Fails without writing when `expectedRevision` is set and no
	 * longer matches (the other process's version already won).
	 */
	async updateRecord(
		canonicalPrKey: string,
		expectedRevision: number | undefined,
		mutate: (record: GitHubPrTrackingRecord) => GitHubPrTrackingRecord | null,
	): Promise<PrRecordUpdateResult> {
		return await this.withRecord(canonicalPrKey, async (state, io) => {
			if (state.kind === "absent") {
				return { ok: false, reason: "conflict" } satisfies PrRecordUpdateResult;
			}
			if (state.kind === "malformed") {
				return { ok: false, reason: "malformed" } satisfies PrRecordUpdateResult;
			}
			const current = state.record;
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
				updatedAt: this.nowValue(),
			};
			await io.write(written);
			return { ok: true, record: written };
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
		return await this.withRecord(canonicalPrKey, async (state, io) => {
			if (state.kind === "absent") {
				return { ok: false, reason: "not_orphaned" as const };
			}
			if (state.kind === "malformed") {
				return { ok: false, reason: "malformed" as const };
			}
			const record = state.record;
			if (record.orphanedAt === null || this.nowValue() - record.orphanedAt < retentionMs) {
				return { ok: false, reason: "not_orphaned" as const };
			}
			if (record.taskBindings.length > 0 || record.reservation.state !== "none") {
				return { ok: false, reason: "has_live_operation" as const };
			}
			await io.remove();
			return { ok: true };
		});
	}

	/** Persist a durable metadata snapshot for one access scope. */
	async setMetadataSnapshot(
		canonicalPrKey: string,
		snapshot: GitHubPrTrackingRecord["snapshots"][string],
	): Promise<PrRecordUpdateResult> {
		return await this.updateRecord(canonicalPrKey, undefined, (record) => ({
			...record,
			snapshots: { ...record.snapshots, [snapshot.accessScopeId]: snapshot },
		}));
	}

	/**
	 * Idempotent per-task binding: one binding per (workspace, task). A
	 * re-subscription for the SAME handled PR keeps consumed markers
	 * (terminalStop / mergeCompletion) — restarts never rearm from them —
	 * and re-linking revives an orphan-marked record.
	 */
	async upsertTaskBinding(
		canonicalPrKey: string,
		binding: { workspaceId: string; taskId: string },
	): Promise<PrRecordUpdateResult> {
		return await this.updateRecord(canonicalPrKey, undefined, (record) => {
			const existing = record.taskBindings.find(
				(item) => item.workspaceId === binding.workspaceId && item.taskId === binding.taskId,
			);
			const taskBindings = existing
				? record.taskBindings.map((item) =>
						item === existing ? { ...item, linkGeneration: item.linkGeneration + 1 } : item,
					)
				: [
						...record.taskBindings,
						{
							workspaceId: binding.workspaceId,
							taskId: binding.taskId,
							linkGeneration: 1,
							linkedAt: this.nowValue(),
							terminalStop: null,
							mergeCompletion: null,
							replayCursors: emptyReplayCursors(),
						},
					];
			return {
				...record,
				orphanedAt: null,
				taskBindings,
			};
		});
	}

	/** Revision-checked mutation of a single task binding. */
	async updateTaskBinding(
		canonicalPrKey: string,
		binding: { workspaceId: string; taskId: string },
		expectedRevision: number | undefined,
		mutate: (item: GitHubPrTaskBinding) => GitHubPrTaskBinding | null,
	): Promise<PrRecordUpdateResult> {
		return await this.updateRecord(canonicalPrKey, expectedRevision, (record) => {
			const index = record.taskBindings.findIndex(
				(item) => item.workspaceId === binding.workspaceId && item.taskId === binding.taskId,
			);
			if (index === -1) {
				return null;
			}
			const next = mutate(record.taskBindings[index]);
			if (next === null) {
				return null;
			}
			return {
				...record,
				taskBindings: record.taskBindings.map((item, i) => (i === index ? next : item)),
			};
		});
	}

	/** Persist a terminal stop reason (or clear it) for one task binding. */
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

export class PrRecordStore extends PrRecordStoreBase {
	private readonly rootPath: string;
	private readonly now: () => number;

	constructor(options: PrRecordStoreOptions = {}) {
		super();
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

	protected nowValue(): number {
		return this.now();
	}

	private async readRecordStateUnlocked(canonicalPrKey: string): Promise<PrRecordState> {
		let raw: string;
		try {
			raw = await readFile(this.recordPath(canonicalPrKey), "utf8");
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				return { kind: "absent" };
			}
			throw error;
		}
		const record = this.parseRecord(raw, canonicalPrKey);
		return record ? { kind: "present", record } : { kind: "malformed" };
	}

	protected async withRecord<T>(
		canonicalPrKey: string,
		op: (state: PrRecordState, io: PrRecordIo) => T | Promise<T>,
	): Promise<T> {
		return await lockedFileSystem.withLock(this.registryMutexRequest(), async () => {
			const state = await this.readRecordStateUnlocked(canonicalPrKey);
			const io: PrRecordIo = {
				write: async (record) => {
					await lockedFileSystem.writeJsonFileAtomic(this.recordPath(canonicalPrKey), record, {
						lock: null,
					});
				},
				remove: async () => {
					await rm(this.recordPath(canonicalPrKey), { force: true });
				},
			};
			return await op(state, io);
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
}
