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
	/** The verified head mapping the gate was keyed against (derived, not caller-supplied). */
	headRepository: string | null;
	headRef: string | null;
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
	headRepository: null,
	headRef: null,
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
	const head = getRecordHeadMapping(record);
	return {
		state: record.reservation.state,
		reservedBy: record.reservation.reservedBy,
		reservedOperation: record.reservation.reservedOperation,
		fencingGeneration: record.reservation.fencingGeneration,
		headRepository: head?.headRepository ?? null,
		headRef: head?.headRef ?? null,
	};
}

function sameTask(a: GitHubPrTaskIdentity | null, b: PrOperationTask): boolean {
	return a !== null && a.workspaceId === b.workspaceId && a.taskId === b.taskId;
}

/**
 * Reserve an operation for a task.
 *
 * Authorization is per operation:
 *   - `comment_followup` requires the caller to BE the repair owner (the
 *     owner tenure provides the fencing generation);
 *   - `merge_completion` is claimable by ANY task whose own binding selects
 *     this PR (verified at the API layer from the caller's card — the two
 *     consumers are independent, and a merge-only task is never a repair
 *     owner).
 *
 * The head-ref write gate is keyed by the RECORD's verified head mapping
 * (`getRecordHeadMapping`), never by caller-supplied values: a record without
 * a verified mapping is blocked, and a caller-supplied value that disagrees
 * with the record is rejected. Acquires the PR gate first, then the head-ref
 * gate, in that fixed order, inside ONE registry transaction.
 */
export async function reservePrOperation(
	store: PrRecordStoreBase,
	canonicalPrKey: string,
	operation: RuntimePrOperationKind,
	task: PrOperationTask,
	options: {
		/** True for comment_followup (owner-gated). Merge ops pass false. */
		requireOwner?: boolean;
		/** Optional validation hint: blocked when it disagrees with the record. */
		headRepository?: string | null;
		/** Optional validation hint: blocked when it disagrees with the record. */
		headRef?: string | null;
		expectedFencingGeneration?: number | undefined;
		now?: () => number;
	},
): Promise<PrOperationReservationResult> {
	const now = (options.now ?? Date.now)();
	const suppliedHeadRepository = options.headRepository?.trim() || null;
	const suppliedHeadRef = options.headRef?.trim() || null;
	const requireOwner = options.requireOwner ?? true;
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
		if (requireOwner && !owner) {
			return {
				status: "blocked" as const,
				detail: "No repair owner is assigned to this PR.",
				recordRevision: record.revision,
				reservation: toView(record),
			};
		}
		if (requireOwner && owner && !sameTask(owner, task)) {
			return {
				status: "blocked" as const,
				detail: "Only the repair owner may claim automatic follow-up reservations.",
				recordRevision: record.revision,
				reservation: toView(record),
			};
		}
		// Stale fencing: the fencing generation is a monotonic high-water mark
		// (never reset by release), so an expected generation from an earlier
		// tenure can never pass again.
		const currentGeneration = Math.max(record.reservation.fencingGeneration, owner?.ownerRevision ?? 0);
		if (
			typeof options.expectedFencingGeneration === "number" &&
			options.expectedFencingGeneration !== currentGeneration
		) {
			return {
				status: "stale" as const,
				detail: `Fencing generation mismatch: expected ${options.expectedFencingGeneration}, current ${currentGeneration}.`,
				recordRevision: record.revision,
				reservation: toView(record),
			};
		}
		// The head-ref gate always applies, keyed by the record's verified
		// head mapping (never caller-supplied).
		const head = getRecordHeadMapping(record);
		if (!head) {
			return {
				status: "blocked" as const,
				detail: "No verified head mapping on this PR record; refresh the snapshot before reserving.",
				recordRevision: record.revision,
				reservation: toView(record),
			};
		}
		if (
			suppliedHeadRepository &&
			suppliedHeadRef &&
			(normalizeHeadRepository(suppliedHeadRepository) !== normalizeHeadRepository(head.headRepository) ||
				suppliedHeadRef !== head.headRef)
		) {
			return {
				status: "blocked" as const,
				detail: `Caller head mapping ${suppliedHeadRepository}@${suppliedHeadRef} does not match the record's ${head.headRepository}@${head.headRef}.`,
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
		// Head-ref gate: validate against ALL records whose latest head
		// mapping is the same canonical head repository + ref.
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
				normalizeHeadRepository(siblingHead.headRepository) === normalizeHeadRepository(head.headRepository) &&
				siblingHead.headRef === head.headRef
			) {
				return {
					status: "busy" as const,
					detail: `Another task holds a reservation that writes to ${siblingHead.headRepository}@${siblingHead.headRef}.`,
					recordRevision: record.revision,
					reservation: toView(record),
				};
			}
		}
		// Reservation block: the fencing fields are monotonic high-water marks
		// (max with the previous values), never reset downward.
		const nextGeneration = Math.max(
			record.reservation.fencingGeneration,
			record.reservation.ownerRevision,
			owner?.ownerRevision ?? 0,
		);
		const next: GitHubPrTrackingRecord = {
			...record,
			revision: record.revision + 1,
			updatedAt: now,
			reservation: {
				...record.reservation,
				ownerRevision: Math.max(record.reservation.ownerRevision, owner?.ownerRevision ?? 0),
				fencingGeneration: nextGeneration,
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
 * Release a held reservation. Only the current holder may release, EXCEPT
 * the explicit operator path (`force: true`): a crashed holder cannot call
 * release, so a wedged PR is cleared by an explicit, audited operator call
 * (the API layer warns with the holder + operation). No implicit takeover
 * is ever performed.
 */
export async function releasePrOperation(
	store: PrRecordStoreBase,
	canonicalPrKey: string,
	operation: RuntimePrOperationKind,
	task: PrOperationTask,
	now?: () => number,
	options: { force?: boolean } = {},
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
		const heldByCaller =
			record.reservation.state === "reserved" &&
			sameTask(record.reservation.reservedBy, task) &&
			record.reservation.reservedOperation === operation;
		if (heldByCaller || (options.force === true && record.reservation.state === "reserved")) {
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
			detail:
				record.reservation.state === "reserved"
					? `The reservation is held by ${record.reservation.reservedBy?.workspaceId ?? "unknown"}/${record.reservation.reservedBy?.taskId ?? "unknown"} (operator release requires force).`
					: "No reservation is held for this PR.",
			recordRevision: record.revision,
			reservation: toView(record),
		};
	});
}
