// PRTRACK-1: fenced operation reservations (PR gate + remote write gate).
//
// Two durable gates live in the PR record's revision-checked reservation
// block:
//   - PR gate: keyed by canonical PR identity — at most one task's operation
//     is in flight per PR.
//   - Remote write gate: keyed by canonical head repository + ref — distinct
//     PRs that push to the same head branch serialize (the PR gate alone
//     does NOT serialize sibling PRs on one head branch).
//
// Gate acquisition is a short CAS on the registry mutex (a multi-record
// transaction so the head-ref check spans all matching records atomically).
// No network/model work happens while a gate is held. Fixed acquisition
// order: task ownership -> PR gate -> head-ref gate.
import type { GitHubPrTaskIdentity, GitHubPrTrackingRecord, RuntimePrOperationKind } from "../core/api-contract";
import type { PrRecordStoreBase } from "./pr-record-store";

export interface PrOperationTask {
	workspaceId: string;
	taskId: string;
}

export type PrReservationStatus = "reserved" | "busy" | "blocked" | "stale";

export interface PrReservationStateView {
	state: "none" | "reserved";
	reservedBy: GitHubPrTaskIdentity | null;
	reservedOperation: string | null;
	fencingGeneration: number;
}

export interface PrOperationReservationResult {
	status: PrReservationStatus;
	/** Detail for blocked/stale outcomes. */
	detail: string | null;
	/** Record revision after a successful write. */
	recordRevision: number | null;
	reservation: PrReservationStateView;
}

const EMPTY_VIEW: PrReservationStateView = {
	state: "none",
	reservedBy: null,
	reservedOperation: null,
	fencingGeneration: 0,
};

function normalizeHeadRepository(repository: string): string {
	return repository.trim().toLowerCase();
}

/**
 * The verified writable head mapping a record knows about: the latest
 * snapshot's headRepository/headRef (highest checkedAt wins).
 */
export function getRecordHeadMapping(
	record: GitHubPrTrackingRecord,
): { headRepository: string; headRef: string } | null {
	let latest: { checkedAt: number; headRepository: string; headRef: string } | null = null;
	for (const snapshot of Object.values(record.snapshots)) {
		if (snapshot.headRepository === null || snapshot.headRef === null) {
			continue;
		}
		if (!latest || snapshot.checkedAt > latest.checkedAt) {
			latest = {
				checkedAt: snapshot.checkedAt,
				headRepository: snapshot.headRepository,
				headRef: snapshot.headRef,
			};
		}
	}
	if (!latest) {
		return null;
	}
	return { headRepository: latest.headRepository, headRef: latest.headRef };
}

function toView(record: GitHubPrTrackingRecord): PrReservationStateView {
	return {
		state: record.reservation.state,
		reservedBy: record.reservation.reservedBy,
		reservedOperation: record.reservation.reservedOperation,
		fencingGeneration: record.reservation.fencingGeneration,
	};
}

function sameTask(a: GitHubPrTaskIdentity | null, b: PrOperationTask): boolean {
	return a !== null && a.workspaceId === b.workspaceId && a.taskId === b.taskId;
}

/**
 * Reserve an operation for a task. The caller must be the current repair
 * owner (the owner tenure provides the fencing generation). Acquires the
 * PR gate first, then the head-ref gate, in that fixed order, inside ONE
 * registry transaction.
 */
export async function reservePrOperation(
	store: PrRecordStoreBase,
	canonicalPrKey: string,
	operation: RuntimePrOperationKind,
	task: PrOperationTask,
	options: {
		headRepository?: string | null;
		headRef?: string | null;
		expectedFencingGeneration?: number | undefined;
		now?: () => number;
	},
): Promise<PrOperationReservationResult> {
	const now = (options.now ?? Date.now)();
	const headRepository = options.headRepository?.trim() || null;
	const headRef = options.headRef?.trim() || null;
	return await store.withRegistryTransaction(async (registry) => {
		const state = await registry.loadState(canonicalPrKey);
		if (state.kind !== "present") {
			return {
				status: "blocked" as const,
				detail: state.kind === "malformed" ? "The PR record is malformed." : "No PR record exists.",
				recordRevision: null,
				reservation: EMPTY_VIEW,
			};
		}
		const record = state.record;
		const owner = record.commentAutomation.repairOwner;
		if (!owner) {
			return {
				status: "blocked" as const,
				detail: "No repair owner is assigned to this PR.",
				recordRevision: record.revision,
				reservation: toView(record),
			};
		}
		if (!sameTask(owner, task)) {
			return {
				status: "blocked" as const,
				detail: "Only the repair owner may claim automatic follow-up reservations.",
				recordRevision: record.revision,
				reservation: toView(record),
			};
		}
		// Stale fencing: the caller's expected generation is behind the
		// current owner tenure; a newer transfer already happened.
		if (
			typeof options.expectedFencingGeneration === "number" &&
			options.expectedFencingGeneration !== owner.ownerRevision
		) {
			return {
				status: "stale" as const,
				detail: `Fencing generation mismatch: expected ${options.expectedFencingGeneration}, current ${owner.ownerRevision}.`,
				recordRevision: record.revision,
				reservation: toView(record),
			};
		}
		// PR gate.
		if (record.reservation.state === "reserved") {
			if (sameTask(record.reservation.reservedBy, task) && record.reservation.reservedOperation === operation) {
				// Idempotent re-reservation by the same holder.
				return {
					status: "reserved" as const,
					detail: null,
					recordRevision: record.revision,
					reservation: toView(record),
				};
			}
			return {
				status: "busy" as const,
				detail: `Another task holds the ${operation} reservation for this PR.`,
				recordRevision: record.revision,
				reservation: toView(record),
			};
		}
		// Head-ref gate: validate against ALL records whose head mapping
		// matches the same canonical head repository + ref.
		if (headRepository && headRef) {
			const records = await registry.listRecords();
			for (const sibling of records) {
				if (sibling.canonicalPrKey === canonicalPrKey) {
					continue;
				}
				if (sibling.reservation.state !== "reserved") {
					continue;
				}
				const siblingHead = getRecordHeadMapping(sibling);
				if (
					siblingHead &&
					normalizeHeadRepository(siblingHead.headRepository) === normalizeHeadRepository(headRepository) &&
					siblingHead.headRef === headRef
				) {
					return {
						status: "busy" as const,
						detail: `Another task holds a reservation that writes to ${siblingHead.headRepository}@${siblingHead.headRef}.`,
						recordRevision: record.revision,
						reservation: toView(record),
					};
				}
			}
		}
		const next: GitHubPrTrackingRecord = {
			...record,
			revision: record.revision + 1,
			updatedAt: now,
			reservation: {
				...record.reservation,
				ownerRevision: owner.ownerRevision,
				fencingGeneration: owner.ownerRevision,
				state: "reserved",
				reservedBy: { workspaceId: task.workspaceId, taskId: task.taskId },
				reservedOperation: operation,
				transferHandoff: null,
			},
		};
		await registry.write(canonicalPrKey, next);
		return { status: "reserved" as const, detail: null, recordRevision: next.revision, reservation: toView(next) };
	});
}

/**
 * Validate that a held reservation is still live (same holder, same
 * operation, current state). Consumers must re-validate before writing; a
 * stale generation must not act.
 */
export async function validatePrOperation(
	store: PrRecordStoreBase,
	canonicalPrKey: string,
	operation: RuntimePrOperationKind,
	task: PrOperationTask,
): Promise<PrOperationReservationResult> {
	return await store.withRegistryTransaction(async (registry) => {
		const state = await registry.loadState(canonicalPrKey);
		if (state.kind !== "present") {
			return {
				status: "stale" as const,
				detail: state.kind === "malformed" ? "The PR record is malformed." : "No PR record exists.",
				recordRevision: null,
				reservation: EMPTY_VIEW,
			};
		}
		const record = state.record;
		if (
			record.reservation.state === "reserved" &&
			sameTask(record.reservation.reservedBy, task) &&
			record.reservation.reservedOperation === operation
		) {
			return {
				status: "reserved" as const,
				detail: null,
				recordRevision: record.revision,
				reservation: toView(record),
			};
		}
		return {
			status: "stale" as const,
			detail: "The reservation is no longer held by this task/operation.",
			recordRevision: record.revision,
			reservation: toView(record),
		};
	});
}

/**
 * Release a held reservation. Only the current holder may release.
 */
export async function releasePrOperation(
	store: PrRecordStoreBase,
	canonicalPrKey: string,
	operation: RuntimePrOperationKind,
	task: PrOperationTask,
	now?: () => number,
): Promise<PrOperationReservationResult> {
	const nowValue = (now ?? Date.now)();
	return await store.withRegistryTransaction(async (registry) => {
		const state = await registry.loadState(canonicalPrKey);
		if (state.kind !== "present") {
			return {
				status: "stale" as const,
				detail: state.kind === "malformed" ? "The PR record is malformed." : "No PR record exists.",
				recordRevision: null,
				reservation: EMPTY_VIEW,
			};
		}
		const record = state.record;
		if (
			record.reservation.state === "reserved" &&
			sameTask(record.reservation.reservedBy, task) &&
			record.reservation.reservedOperation === operation
		) {
			const next: GitHubPrTrackingRecord = {
				...record,
				revision: record.revision + 1,
				updatedAt: nowValue,
				reservation: {
					...record.reservation,
					state: "none",
					reservedBy: null,
					reservedOperation: null,
					transferHandoff: null,
				},
			};
			await registry.write(canonicalPrKey, next);
			return { status: "reserved" as const, detail: null, recordRevision: next.revision, reservation: toView(next) };
		}
		return {
			status: "stale" as const,
			detail: "The reservation is not held by this task/operation.",
			recordRevision: record.revision,
			reservation: toView(record),
		};
	});
}
