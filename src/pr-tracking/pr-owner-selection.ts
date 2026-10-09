// PRTRACK-1: repair-owner selection, transfer, and release.
//
// A repair owner is a task that (a) links the PR, (b) has
// autoAddressComments enabled, and (c) sits in in_progress or review. When a
// task becomes eligible:
//   - no owner and exactly one candidate -> atomic owner assignment
//     (no user choice);
//   - no owner and multiple candidates    -> ambiguity block, no assignment;
//   - an owner exists                     -> the other tasks stay non-owner
//     and only run manual actions.
//
// Invalidation (checkbox off, no longer in progress/review, PR unlinked)
// stops work but performs NO handoff. An owner deletion blocks remaining
// candidates until the user explicitly reassigns. Ownership is a
// PR-scoped, revision-checked, fencing-aware block inside the PR record.
import type {
	GitHubPrTaskIdentity,
	GitHubPrTrackingRecord,
	RuntimeBoardCard,
	RuntimeBoardData,
} from "../core/api-contract";
import { parsePullRequestUrl } from "../core/pull-request-links";
import { toCanonicalPrKey } from "./pr-identity";
import type { PrRecordStoreBase } from "./pr-record-store";

/** Columns in which a task can act as (or take over) repair owner. */
export const PR_OWNER_ACTIVE_COLUMNS: ReadonlySet<string> = new Set(["in_progress", "review"]);

export type PrOwnerCandidateState = "active" | "disabled" | "deleted";

export interface PrRepairOwnerCandidate {
	workspaceId: string;
	taskId: string;
	/** Workspace/task label for the explicit selector. */
	label: string;
	state: PrOwnerCandidateState;
}

export interface PrBoardSnapshot {
	workspaceId: string;
	board: RuntimeBoardData;
}

export function findTaskCard(
	board: RuntimeBoardData,
	taskId: string,
): { card: RuntimeBoardCard; columnId: string } | null {
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.id === taskId) {
				return { card, columnId: column.id };
			}
		}
	}
	return null;
}

/** The canonical PR keys the card links (unparseable links are skipped). */
export function getCardLinkedPrKeys(card: RuntimeBoardCard): string[] {
	const keys: string[] = [];
	for (const link of card.pullRequests ?? []) {
		const parsed = parsePullRequestUrl(link.url);
		if (!parsed) {
			continue;
		}
		keys.push(
			toCanonicalPrKey({
				provider: parsed.provider,
				host: parsed.host,
				repository: parsed.repository,
				number: parsed.number,
			}),
		);
	}
	return keys;
}

/**
 * The PR this card drives automation for: an explicit selection when it is
 * still linked, otherwise the sole link when there is exactly one. null =
 * nothing selectable (none, or ambiguous). A selection that is no longer
 * linked (the link was removed) reads as unselected, so a dangling
 * selection can never keep driving demand, gates, or ownership.
 */
export function resolveCardAutomationPrKey(card: RuntimeBoardCard): {
	key: string | null;
	ambiguous: boolean;
	candidates: string[];
} {
	const linked = getCardLinkedPrKeys(card);
	const selection = card.selectedAutomationPrKey;
	if (selection && linked.includes(selection)) {
		return { key: selection, ambiguous: false, candidates: linked };
	}
	if (linked.length === 1) {
		return { key: linked[0], ambiguous: false, candidates: linked };
	}
	if (linked.length > 1) {
		return { key: null, ambiguous: true, candidates: linked };
	}
	return { key: null, ambiguous: false, candidates: [] };
}

function buildLabel(workspaceId: string, card: RuntimeBoardCard): string {
	return `${workspaceId}/${card.title || card.id}`;
}

/**
 * Compute the candidate owner tasks for one canonical PR across all managed
 * workspaces (existing cards in active columns with the checkbox enabled).
 */
export function listRepairOwnerCandidates(canonicalPrKey: string, boards: PrBoardSnapshot[]): PrRepairOwnerCandidate[] {
	const candidates: PrRepairOwnerCandidate[] = [];
	for (const { workspaceId, board } of boards) {
		for (const column of board.columns) {
			if (!PR_OWNER_ACTIVE_COLUMNS.has(column.id)) {
				continue;
			}
			for (const card of column.cards) {
				if (card.autoAddressComments !== true) {
					continue;
				}
				const resolved = resolveCardAutomationPrKey(card);
				if (resolved.key !== canonicalPrKey) {
					continue;
				}
				candidates.push({
					workspaceId,
					taskId: card.id,
					label: buildLabel(workspaceId, card),
					state: "active",
				});
			}
		}
	}
	candidates.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.taskId.localeCompare(b.taskId));
	return candidates;
}

export interface PrSelectRepairOwnerResult {
	ok: boolean;
	/** The (possibly newly assigned) owner. */
	owner: (GitHubPrTaskIdentity & { ownerRevision: number }) | null;
	/** "ambiguous" (no assignment made) | "no_candidates" | "no_record" | null. */
	reason: "ambiguous" | "no_candidates" | "no_record" | null;
	candidates: PrRepairOwnerCandidate[];
	/** True when this call atomically assigned the owner. */
	assigned: boolean;
}

/**
 * The next owner revision: strictly above every revision the record has
 * ever issued. `reservation.ownerRevision` is the record-level high-water
 * mark (never decremented, kept across releases), so a fencing token from
 * an earlier tenure can never repeat — a stale holder's generation always
 * reads stale, even after release + reassignment of the same task.
 */
function nextOwnerRevision(record: GitHubPrTrackingRecord): number {
	const current = record.commentAutomation.repairOwner?.ownerRevision ?? 0;
	return Math.max(record.reservation.ownerRevision, current) + 1;
}

/**
 * Attempt auto-selection: with no current owner, exactly one candidate is
 * assigned atomically inside the PR record; multiple candidates yield an
 * ambiguity block instead of a guess. An existing owner is always kept.
 */
export async function selectRepairOwner(
	store: PrRecordStoreBase,
	canonicalPrKey: string,
	boards: PrBoardSnapshot[],
	now?: () => number,
): Promise<PrSelectRepairOwnerResult> {
	const nowValue = (now ?? Date.now)();
	const candidates = listRepairOwnerCandidates(canonicalPrKey, boards);
	return await store.withRegistryTransaction(async (registry) => {
		const state = await registry.loadState(canonicalPrKey);
		if (state.kind !== "present") {
			return { ok: false, owner: null, reason: "no_record" as const, candidates, assigned: false };
		}
		const record = state.record;
		const existing = record.commentAutomation.repairOwner;
		if (existing) {
			return { ok: true, owner: existing, reason: null, candidates, assigned: false };
		}
		if (candidates.length === 0) {
			return { ok: false, owner: null, reason: "no_candidates" as const, candidates, assigned: false };
		}
		if (candidates.length > 1) {
			return { ok: false, owner: null, reason: "ambiguous" as const, candidates, assigned: false };
		}
		const chosen = candidates[0];
		const newRevision = nextOwnerRevision(record);
		const next: GitHubPrTrackingRecord = {
			...record,
			revision: record.revision + 1,
			updatedAt: nowValue,
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: {
					workspaceId: chosen.workspaceId,
					taskId: chosen.taskId,
					ownerRevision: newRevision,
				},
			},
			reservation: {
				...record.reservation,
				ownerRevision: newRevision,
				fencingGeneration: Math.max(record.reservation.fencingGeneration, newRevision),
			},
		};
		await registry.write(canonicalPrKey, next);
		return { ok: true, owner: next.commentAutomation.repairOwner, reason: null, candidates, assigned: true };
	});
}

export interface PrAssignRepairOwnerResult {
	ok: boolean;
	owner: (GitHubPrTaskIdentity & { ownerRevision: number }) | null;
	/**
	 * "no_record" | "not_valid_candidate" (the task is not a current
	 * candidate for this PR) | "conflict" (stale expectedOwnerRevision).
	 */
	reason: "no_record" | "not_valid_candidate" | "conflict" | null;
	candidates: PrRepairOwnerCandidate[];
	/** True when this call atomically assigned the owner. */
	assigned: boolean;
}

/**
 * Explicit owner assignment: assigns the given task as repair owner,
 * validated against the current candidate list. This is the resolution
 * path for the ambiguous (2+ candidates) state — the user picks one.
 * An existing owner is kept unless the revision check passes (a concurrent
 * handoff between the caller's read and this write is a conflict).
 *
 * Note: `boards` is a snapshot read immediately before the transaction;
 * a card moved/unchecked in that window is assigned on stale eligibility
 * (documented window, bounded by the same revision check as transfers).
 */
export async function assignRepairOwner(
	store: PrRecordStoreBase,
	canonicalPrKey: string,
	boards: PrBoardSnapshot[],
	task: GitHubPrTaskIdentity,
	options: {
		expectedOwnerRevision?: number;
		now?: () => number;
	} = {},
): Promise<PrAssignRepairOwnerResult> {
	const nowValue = (options.now ?? Date.now)();
	const candidates = listRepairOwnerCandidates(canonicalPrKey, boards);
	if (!candidates.some((c) => c.workspaceId === task.workspaceId && c.taskId === task.taskId)) {
		return { ok: false, owner: null, reason: "not_valid_candidate", candidates, assigned: false };
	}
	return await store.withRegistryTransaction(async (registry) => {
		const state = await registry.loadState(canonicalPrKey);
		if (state.kind !== "present") {
			return { ok: false, owner: null, reason: "no_record" as const, candidates, assigned: false };
		}
		const record = state.record;
		const existing = record.commentAutomation.repairOwner;
		if (existing) {
			if (existing.workspaceId === task.workspaceId && existing.taskId === task.taskId) {
				return { ok: true, owner: existing, reason: null, candidates, assigned: false };
			}
			if (
				typeof options.expectedOwnerRevision === "number" &&
				options.expectedOwnerRevision !== existing.ownerRevision
			) {
				return { ok: false, owner: existing, reason: "conflict" as const, candidates, assigned: false };
			}
			// A different owner exists and the caller saw no owner (or the
			// same revision): never silently steal an assignment.
			return { ok: false, owner: existing, reason: "conflict" as const, candidates, assigned: false };
		}
		const newRevision = nextOwnerRevision(record);
		const next: GitHubPrTrackingRecord = {
			...record,
			revision: record.revision + 1,
			updatedAt: nowValue,
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: {
					workspaceId: task.workspaceId,
					taskId: task.taskId,
					ownerRevision: newRevision,
				},
			},
			reservation: {
				...record.reservation,
				ownerRevision: newRevision,
				fencingGeneration: Math.max(record.reservation.fencingGeneration, newRevision),
			},
		};
		await registry.write(canonicalPrKey, next);
		return { ok: true, owner: next.commentAutomation.repairOwner, reason: null, candidates, assigned: true };
	});
}

export interface PrTransferRepairOwnerResult {
	ok: boolean;
	owner: (GitHubPrTaskIdentity & { ownerRevision: number }) | null;
	/**
	 * "conflict" (stale expectedOwnerRevision / owner changed) | "not_owner"
	 * (caller is not the current owner) | "drain_required" (writer actions or
	 * a live reservation not drained) | "missing_task" | "no_record" |
	 * "not_valid_candidate" (target is not an eligible candidate).
	 */
	reason: "conflict" | "not_owner" | "drain_required" | "missing_task" | "no_record" | "not_valid_candidate" | null;
	candidates: PrRepairOwnerCandidate[];
}

/**
 * Atomically transfer ownership (or release, with `to` = null). The whole
 * handoff — intent invalidation for both tasks, writer-action drain, fencing
 * bump, and reservation/gate reconcile (the reservation block must be free) —
 * happens inside ONE record write. Pending/last-dispatched fingerprints and
 * failure state are preserved on the record.
 */
export async function transferRepairOwner(
	store: PrRecordStoreBase,
	canonicalPrKey: string,
	from: GitHubPrTaskIdentity,
	to: GitHubPrTaskIdentity | null,
	boards: PrBoardSnapshot[],
	options: {
		/** True when every writer action / in-flight dispatch has drained. */
		writerActionsDrained: boolean;
		expectedOwnerRevision?: number;
		now?: () => number;
	},
): Promise<PrTransferRepairOwnerResult> {
	const nowValue = (options.now ?? Date.now)();
	const candidates = listRepairOwnerCandidates(canonicalPrKey, boards);
	if (!options.writerActionsDrained) {
		return { ok: false, owner: null, reason: "drain_required", candidates };
	}
	if (to !== null && !candidates.some((c) => c.workspaceId === to.workspaceId && c.taskId === to.taskId)) {
		return { ok: false, owner: null, reason: "not_valid_candidate", candidates };
	}
	return await store.withRegistryTransaction(async (registry) => {
		const state = await registry.loadState(canonicalPrKey);
		if (state.kind !== "present") {
			return { ok: false, owner: null, reason: "no_record" as const, candidates };
		}
		const record = state.record;
		const current = record.commentAutomation.repairOwner;
		if (!current || current.workspaceId !== from.workspaceId || current.taskId !== from.taskId) {
			return { ok: false, owner: current ?? null, reason: "not_owner" as const, candidates };
		}
		if (
			typeof options.expectedOwnerRevision === "number" &&
			options.expectedOwnerRevision !== current.ownerRevision
		) {
			return { ok: false, owner: current, reason: "conflict" as const, candidates };
		}
		// Gate reconcile: the handoff requires the reservation to be free.
		if (record.reservation.state === "reserved") {
			return { ok: false, owner: current, reason: "drain_required" as const, candidates };
		}
		const newRevision = to ? nextOwnerRevision(record) : current.ownerRevision;
		// The in-flight dispatch is invalidated by the handoff; a terminal
		// failure status (and the pending/last-dispatched fingerprints)
		// stays recorded so the next owner sees why the last attempt failed.
		const dispatch = record.commentAutomation.dispatch;
		const dispatchInvalidated = dispatch !== null && (dispatch.status === "queued" || dispatch.status === "running");
		const next: GitHubPrTrackingRecord = {
			...record,
			revision: record.revision + 1,
			updatedAt: nowValue,
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: to
					? {
							workspaceId: to.workspaceId,
							taskId: to.taskId,
							ownerRevision: newRevision,
						}
					: null,
				dispatch: dispatchInvalidated ? null : dispatch,
			},
			reservation: {
				...record.reservation,
				// High-water mark: a release keeps the last issued revision so
				// the next assignment (even of the same task) starts above it
				// and every earlier fencing token stays stale.
				ownerRevision: Math.max(record.reservation.ownerRevision, newRevision),
				fencingGeneration: Math.max(record.reservation.fencingGeneration, newRevision),
				state: "none",
				reservedBy: null,
				reservedOperation: null,
				transferHandoff: null,
			},
		};
		await registry.write(canonicalPrKey, next);
		return { ok: true, owner: next.commentAutomation.repairOwner, reason: null, candidates };
	});
}

/**
 * PRTRACK-1: repair-owner selection is card-link based (an explicit
 * selection when linked, otherwise the sole resolvable link). The
 * plan's "cross-repository reference" protection is enforced at the point
 * of use, not at assignment: the record's verified head mapping keys the
 * head-ref write gate in `reservePrOperation`/`validatePrOperation`, and
 * the repair turn (COMMENT-0) validates the task's delivery branch against
 * that mapping before any remote write. Fork workflows are intentionally
 * supported: a fork→upstream PR's head repository differing from the
 * record/base repository is the normal shape and is not a blocker.
 */
