// PRTRACK-1: the frozen consumer API for PR-driven task workflows.
//
// This router exposes: task PR settings/selection/resume/tracking-state,
// authorized versioned snapshot reads + refresh, revision-checked record
// mutators (comment dispatch, merge binding), repair-owner
// select/transfer/release, fenced operation reservations, and versioned
// snapshot subscriptions with durable replay cursors.
//
// No new pollers or settings plumbing live here: every read is delegated to
// the runtime-wide PR tracking coordinator (one coordinator, one poll per
// canonical PR per access scope) and every durable mutation goes through the
// revision-checked PR record store under the tracking-registry mutex.
import type {
	GitHubPrTaskBinding,
	GitHubPrTaskIdentity,
	GitHubPrTrackingRecord,
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimePrAuthorizedSnapshotRequest,
	RuntimePrAuthorizedSnapshotResponse,
	RuntimePrCommentDispatchUpdateRequest,
	RuntimePrInstalledConsumer,
	RuntimePrOperationReleaseRequest,
	RuntimePrOperationReservationRequest,
	RuntimePrOperationReservationResponse,
	RuntimePrOperationValidateRequest,
	RuntimePrRecordMutationResponse,
	RuntimePrRepairOwnerResponse,
	RuntimePrRepairOwnerSelectRequest,
	RuntimePrRepairOwnerTransferRequest,
	RuntimePrReservationState,
	RuntimePrSnapshotRefreshRequest,
	RuntimePrSnapshotRefreshResponse,
	RuntimePrSubscriptionRequest,
	RuntimePrSubscriptionResponse,
	RuntimePrTaskOwner,
	RuntimeTaskAutomationPrSelectRequest,
	RuntimeTaskAutomationPrSelectResponse,
	RuntimeTaskMergeBindingUpdateRequest,
	RuntimeTaskPrSettingsRequest,
	RuntimeTaskPrSettingsResponse,
	RuntimeTaskPrTrackingResumeRequest,
	RuntimeTaskPrTrackingResumeResponse,
	RuntimeTaskTrackingStateRequest,
	RuntimeTaskTrackingStateResponse,
} from "../core/api-contract";
import { setTaskSelectedAutomationPr, updateTaskPrSettings } from "../core/task-board-mutations";
import type { PrConsumerRegistry, PrInstalledConsumers } from "../pr-tracking/pr-consumer-registry";
import { evaluatePrLifecycleGate } from "../pr-tracking/pr-lifecycle-gate";
import {
	assignRepairOwner,
	findTaskCard,
	listRepairOwnerCandidates,
	type PrBoardSnapshot,
	resolveCardAutomationPrKey,
	selectRepairOwner,
	transferRepairOwner,
} from "../pr-tracking/pr-owner-selection";
import type { PrRecordStoreBase } from "../pr-tracking/pr-record-store";
import { releasePrOperation, reservePrOperation, validatePrOperation } from "../pr-tracking/pr-reservations";
import { reconcileTaskSubscriptions } from "../pr-tracking/pr-task-subscriptions";
import type { PrTrackingCoordinator } from "../pr-tracking/pr-tracking-coordinator";
import { loadWorkspaceBoardById, mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "./app-router";

export interface CreatePrTrackingApiDependencies {
	getPrTrackingCoordinator: () => PrTrackingCoordinator | null;
	getPrTrackingStore: () => PrRecordStoreBase;
	getPrConsumerRegistry: () => PrConsumerRegistry;
	listManagedWorkspaceBoards: () => Promise<PrBoardSnapshot[]>;
	broadcastRuntimeWorkspaceStateUpdated: (scope: RuntimeTrpcWorkspaceScope) => void | Promise<void>;
	/** B-5.5-style writer liveness probe (drain precondition for repair-owner transfer). */
	isTaskWriterActive?: (workspaceId: string, taskId: string) => Promise<boolean> | boolean;
	/**
	 * PRTRACK-1: the shared single-flight reconcile pass (server wiring).
	 * When present, ALL subscription reconciliation in this API goes through
	 * it so passes never interleave; the fallback reconciles directly.
	 */
	runPrTrackingReconcilePass?: () => Promise<void>;
	/**
	 * PRTRACK-1: resolves the task's effective agent — a live session's
	 * agent when one exists, else the workspace's selected agent. A card
	 * with `agentId` unset does NOT default to Cline; it inherits the
	 * workspace's selected agent (same precedence as task start).
	 */
	getEffectiveTaskAgentId?: (
		scope: RuntimeTrpcWorkspaceScope,
		taskId: string,
	) => Promise<RuntimeAgentId | null> | (RuntimeAgentId | null);
	/** Audited operator actions (force releases) are reported here. */
	warn?: (message: string) => void;
}

function installedConsumersOf(registry: PrConsumerRegistry): RuntimePrInstalledConsumer[] {
	return registry.listInstalled().map((registration) => ({
		kind: registration.kind,
		requiredReadSources: registration.requiredReadSources,
	}));
}

function toInstalledConsumerFlags(registry: PrConsumerRegistry): PrInstalledConsumers {
	return {
		comments: registry.isInstalled("comments"),
		mergeCompletion: registry.isInstalled("mergeCompletion"),
	};
}

/** Human-facing mapping for coordinator subscription blockers. */
const SUBSCRIPTION_BLOCKER_MESSAGES: Record<
	string,
	{ kind: RuntimeTaskTrackingStateResponse["blockers"][number]["kind"]; message: string }
> = {
	malformed_key: { kind: "auth", message: "The recorded PR link cannot be parsed." },
	unsupported_host: { kind: "unsupported_host", message: "This PR host is not supported by tracking automation." },
	auth: { kind: "auth", message: "GitHub authentication is unavailable for this PR." },
	scope: { kind: "auth", message: "No access scope is available for this task's PR." },
	scheduler: { kind: "scheduler", message: "The PR tracking scheduler is blocked; reads are paused." },
	record_malformed: { kind: "needs_human", message: "The PR tracking record is malformed." },
};

/**
 * The repair owner's current state against the live boards: deleted when the
 * task no longer exists anywhere, disabled when it is no longer an eligible
 * candidate (work stops, no handoff), active otherwise.
 */
function toOwnerView(
	owner: (GitHubPrTaskIdentity & { ownerRevision: number }) | null,
	candidates: Array<{ workspaceId: string; taskId: string; label: string }>,
	boards: PrBoardSnapshot[],
): RuntimePrTaskOwner | null {
	if (!owner) {
		return null;
	}
	const candidate = candidates.find((c) => c.workspaceId === owner.workspaceId && c.taskId === owner.taskId);
	if (candidate) {
		return {
			workspaceId: owner.workspaceId,
			taskId: owner.taskId,
			ownerRevision: owner.ownerRevision,
			label: candidate.label,
			state: "active",
		};
	}
	const boardEntry = boards.find((entry) => entry.workspaceId === owner.workspaceId);
	const card = boardEntry ? findTaskCard(boardEntry.board, owner.taskId) : null;
	if (!card) {
		return {
			workspaceId: owner.workspaceId,
			taskId: owner.taskId,
			ownerRevision: owner.ownerRevision,
			label: `${owner.workspaceId}/${owner.taskId}`,
			state: "deleted",
		};
	}
	return {
		workspaceId: owner.workspaceId,
		taskId: owner.taskId,
		ownerRevision: owner.ownerRevision,
		label: `${owner.workspaceId}/${card.card.title || card.card.id}`,
		state: "disabled",
	};
}

function toReservationView(record: GitHubPrTrackingRecord | null): RuntimePrReservationState {
	if (!record) {
		return { state: "none", reservedBy: null, reservedOperation: null, fencingGeneration: 0 };
	}
	return {
		state: record.reservation.state,
		reservedBy: record.reservation.reservedBy,
		reservedOperation: record.reservation.reservedOperation,
		fencingGeneration: record.reservation.fencingGeneration,
	};
}

export function createPrTrackingApi(deps: CreatePrTrackingApiDependencies) {
	const source = {
		listBoards: () => deps.listManagedWorkspaceBoards(),
		installedConsumers: () => toInstalledConsumerFlags(deps.getPrConsumerRegistry()),
	};

	/** Reconcile live task-derived subscriptions after a board change. */
	async function reconcileDemand(): Promise<void> {
		if (deps.runPrTrackingReconcilePass) {
			// The shared single-flight pass: coalesced with the startup pass,
			// board-save triggers, poll-time backstop, and other API triggers.
			await deps.runPrTrackingReconcilePass();
			return;
		}
		const coordinator = deps.getPrTrackingCoordinator();
		if (!coordinator) {
			return;
		}
		await reconcileTaskSubscriptions(coordinator, source);
	}

	/**
	 * Best-effort auto owner-selection for one canonical PR: exactly one
	 * eligible candidate is assigned atomically; multiple candidates report
	 * ambiguity (no assignment). Selection is card-link based; the
	 * cross-repository-reference protection lives at the point of use
	 * (the record's verified head mapping keys the write gate, and the
	 * repair turn validates the task's delivery branch — see
	 * pr-owner-selection).
	 */
	async function autoSelectOwnerFor(canonicalPrKey: string, boards: PrBoardSnapshot[]): Promise<void> {
		const store = deps.getPrTrackingStore();
		await selectRepairOwner(store, canonicalPrKey, boards);
	}

	async function loadScopedCard(
		scope: RuntimeTrpcWorkspaceScope,
		taskId: string,
	): Promise<{ card: RuntimeBoardCard; columnId: string } | null> {
		const board = await loadWorkspaceBoardById(scope.workspaceId);
		return findTaskCard(board, taskId);
	}

	const setTaskPrSettings = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeTaskPrSettingsRequest,
	): Promise<RuntimeTaskPrSettingsResponse> => {
		const response = await mutateWorkspaceState<RuntimeTaskPrSettingsResponse>(scope.workspacePath, (state) => {
			const result = updateTaskPrSettings(state.board, input.taskId, {
				autoAddressComments: input.autoAddressComments,
				autoFinishOnMerge: input.autoFinishOnMerge,
				expectedSettingsRevision: input.expectedSettingsRevision,
			});
			if (result.conflict) {
				return {
					value: {
						ok: false,
						taskId: input.taskId,
						autoAddressComments: result.autoAddressComments,
						autoFinishOnMerge: result.autoFinishOnMerge,
						selectedAutomationPrKey: result.selectedAutomationPrKey,
						settingsRevision: result.settingsRevision,
						reason: "conflict",
						error: null,
					},
					board: state.board,
					save: false,
				};
			}
			if (!result.updated) {
				if (result.task === null) {
					return {
						value: {
							ok: false,
							taskId: input.taskId,
							autoAddressComments: result.autoAddressComments,
							autoFinishOnMerge: result.autoFinishOnMerge,
							selectedAutomationPrKey: result.selectedAutomationPrKey,
							settingsRevision: result.settingsRevision,
							reason: "missing_task",
							error: null,
						},
						board: state.board,
						save: false,
					};
				}
				// No-op write: both fields absent and nothing changed; the
				// revision is untouched and this reports success.
				return {
					value: {
						ok: true,
						taskId: input.taskId,
						autoAddressComments: result.autoAddressComments,
						autoFinishOnMerge: result.autoFinishOnMerge,
						selectedAutomationPrKey: result.selectedAutomationPrKey,
						settingsRevision: result.settingsRevision,
						reason: null,
						error: null,
					},
					board: state.board,
					save: false,
				};
			}
			return {
				value: {
					ok: true,
					taskId: input.taskId,
					autoAddressComments: result.autoAddressComments,
					autoFinishOnMerge: result.autoFinishOnMerge,
					selectedAutomationPrKey: result.selectedAutomationPrKey,
					settingsRevision: result.settingsRevision,
					reason: null,
					error: null,
				},
				board: result.board,
				save: true,
			};
		});
		if (response.value.ok) {
			await reconcileDemand();
			const boards = await deps.listManagedWorkspaceBoards();
			const after = await loadScopedCard(scope, input.taskId);
			if (after) {
				const resolved = resolveCardAutomationPrKey(after.card);
				if (resolved.key) {
					await autoSelectOwnerFor(resolved.key, boards);
				}
			}
			await deps.broadcastRuntimeWorkspaceStateUpdated(scope);
		}
		return response.value;
	};

	const selectTaskAutomationPr = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeTaskAutomationPrSelectRequest,
	): Promise<RuntimeTaskAutomationPrSelectResponse> => {
		const found = await loadScopedCard(scope, input.taskId);
		if (!found) {
			return {
				ok: false,
				taskId: input.taskId,
				selectedAutomationPrKey: null,
				settingsRevision: 0,
				candidates: [],
				blocker: "missing_task",
				error: null,
			};
		}
		const card = found.card;
		const currentRevision = card.settingsRevision ?? 0;
		const candidates = resolveCardAutomationPrKey(card).candidates;
		if (typeof input.expectedSettingsRevision === "number" && input.expectedSettingsRevision !== currentRevision) {
			return {
				ok: false,
				taskId: input.taskId,
				selectedAutomationPrKey: card.selectedAutomationPrKey ?? null,
				settingsRevision: currentRevision,
				candidates,
				blocker: "conflict",
				error: null,
			};
		}
		let selected: string | null;
		let blocker: RuntimeTaskAutomationPrSelectResponse["blocker"] = null;
		if (input.prKey === undefined) {
			if (card.selectedAutomationPrKey) {
				selected = card.selectedAutomationPrKey;
			} else if (candidates.length === 1) {
				selected = candidates[0];
			} else if (candidates.length > 1) {
				selected = null;
				blocker = "ambiguous";
			} else {
				selected = null;
				blocker = "no_matching_link";
			}
		} else if (input.prKey === null) {
			selected = null;
		} else if (candidates.includes(input.prKey)) {
			selected = input.prKey;
		} else {
			selected = null;
			blocker = "no_matching_link";
		}
		if (blocker !== null) {
			return {
				ok: false,
				taskId: input.taskId,
				selectedAutomationPrKey: card.selectedAutomationPrKey ?? null,
				settingsRevision: currentRevision,
				candidates,
				blocker,
				error: null,
			};
		}
		// The selection write happens INSIDE the workspace-state mutation:
		// setTaskSelectedAutomationPr re-checks the revision against the
		// just-read card, so a concurrent settings write between the pre-read
		// and this write is a conflict, never silently overwritten.
		let written = false;
		let writtenRevision = 0;
		await mutateWorkspaceState<null>(scope.workspacePath, (state) => {
			const result = setTaskSelectedAutomationPr(state.board, input.taskId, selected, currentRevision);
			if (result.conflict || !result.changed) {
				return { value: null, board: state.board, save: false };
			}
			written = true;
			writtenRevision = result.settingsRevision;
			return { value: null, board: result.board, save: true };
		});
		if (!written) {
			return {
				ok: false,
				taskId: input.taskId,
				selectedAutomationPrKey: card.selectedAutomationPrKey ?? null,
				settingsRevision: currentRevision,
				candidates,
				blocker: "conflict",
				error: null,
			};
		}
		await reconcileDemand();
		const boards = await deps.listManagedWorkspaceBoards();
		if (selected) {
			await autoSelectOwnerFor(selected, boards);
		}
		await deps.broadcastRuntimeWorkspaceStateUpdated(scope);
		return {
			ok: true,
			taskId: input.taskId,
			selectedAutomationPrKey: selected,
			settingsRevision: writtenRevision,
			candidates,
			blocker: null,
			error: null,
		};
	};

	const getTaskTrackingState = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeTaskTrackingStateRequest,
	): Promise<RuntimeTaskTrackingStateResponse> => {
		const registry = deps.getPrConsumerRegistry();
		const coordinator = deps.getPrTrackingCoordinator();
		const installedFlags = toInstalledConsumerFlags(registry);
		const found = await loadScopedCard(scope, input.taskId);
		if (!found) {
			return {
				ok: false,
				taskId: input.taskId,
				settingsRevision: 0,
				staleRevision: false,
				autoAddressComments: false,
				autoFinishOnMerge: false,
				selectedAutomationPrKey: null,
				eligible: false,
				legacyCompletionGated: false,
				mergeFinishesInReview: false,
				blockers: [{ kind: "feature_unavailable", message: "Task not found" }],
				installedConsumers: installedConsumersOf(registry),
				commentsSupportedForTask: false,
				owner: null,
				ownerLabel: null,
				ownerCandidates: [],
				reservation: { state: "none", reservedBy: null, reservedOperation: null, fencingGeneration: 0 },
				snapshot: null,
				terminalStop: null,
				error: null,
			};
		}
		const card = found.card;
		const settingsRevision = card.settingsRevision ?? 0;
		const resolved = resolveCardAutomationPrKey(card);
		const gate = evaluatePrLifecycleGate({ card, installed: installedFlags });
		const blockers: Array<{ kind: RuntimeTaskTrackingStateResponse["blockers"][number]["kind"]; message: string }> =
			[];
		// Zero-consumer short-circuit: no consumer installed means no demand
		// can ever exist, so no board enumeration (or owner scan) is needed.
		const noConsumers = !installedFlags.comments && !installedFlags.mergeCompletion;
		// Per-task agent support: comment follow-up is native-Cline only;
		// merge completion is provider-independent. An UNSET card agentId
		// means "use the workspace's selected agent", not Cline — resolve
		// the effective agent the same way task start does.
		let effectiveAgentId: RuntimeAgentId | null = null;
		if (deps.getEffectiveTaskAgentId) {
			try {
				effectiveAgentId = await deps.getEffectiveTaskAgentId(scope, input.taskId);
			} catch {
				effectiveAgentId = null;
			}
		}
		if (effectiveAgentId === null && card.agentId === "cline") {
			// Resolver unavailable: only an explicit per-card Cline counts.
			effectiveAgentId = "cline";
		}
		const nativeClineTask = effectiveAgentId === "cline";
		const commentsSupportedForTask = installedFlags.comments && nativeClineTask;
		const coordinatorState = coordinator ? coordinator.getState() : null;
		if (coordinatorState?.authBlocker) {
			blockers.push({ kind: "auth", message: coordinatorState.authBlocker });
		}
		if (coordinatorState?.schedulerBlocked) {
			blockers.push({ kind: "scheduler", message: "The PR tracking scheduler is blocked; reads are paused." });
		}
		// Per-task access blocker from the live subscription (e.g. an
		// unsupported host or scope failure for this task's PR).
		const subscriptionState = coordinator
			? coordinator
					.listSubscriptions()
					.find((entry) => entry.workspaceId === scope.workspaceId && entry.taskId === input.taskId)
			: undefined;
		if (subscriptionState?.blocker) {
			const mapping = SUBSCRIPTION_BLOCKER_MESSAGES[subscriptionState.blocker];
			blockers.push({
				kind: mapping.kind,
				message: mapping.message,
			});
		}
		const active = found.columnId === "in_progress" || found.columnId === "review";
		if (resolved.ambiguous) {
			blockers.push({
				kind: "ambiguous_selection",
				message: "Multiple PR links are recorded; select the Automation PR explicitly.",
			});
		}
		if (!resolved.key) {
			blockers.push({ kind: "waiting_for_linked_pr", message: "No PR link is recorded for this task yet." });
		}
		if (card.autoAddressComments === true && !installedFlags.comments) {
			// Consumer not installed: "Feature unavailable" (distinct from the
			// per-task agent-support blocker below).
			blockers.push({
				kind: "feature_unavailable",
				message: "Comment follow-up automation is not installed in this runtime.",
			});
		} else if (card.autoAddressComments === true && !nativeClineTask) {
			blockers.push({
				kind: "comments_unsupported",
				message: "Comment follow-up automation requires a native Cline task.",
			});
		}
		if (card.autoFinishOnMerge === true && !installedFlags.mergeCompletion) {
			blockers.push({
				kind: "feature_unavailable",
				message: "Merge completion automation is not installed in this runtime.",
			});
		}
		const eligible = !noConsumers && active && resolved.key !== null && gate.legacyCompletionGated;
		let record: GitHubPrTrackingRecord | null = null;
		let binding: GitHubPrTaskBinding | null = null;
		if (resolved.key) {
			const loaded = await deps.getPrTrackingStore().loadRecord(resolved.key);
			if (loaded.ok) {
				record = loaded.record;
				binding =
					record.taskBindings.find(
						(item) => item.workspaceId === scope.workspaceId && item.taskId === input.taskId,
					) ?? null;
			}
		}
		const boards = noConsumers ? [] : await deps.listManagedWorkspaceBoards();
		const candidates = resolved.key && !noConsumers ? listRepairOwnerCandidates(resolved.key, boards) : [];
		const owner = resolved.key && record ? record.commentAutomation.repairOwner : null;
		// With zero consumers no board scan happened, so "not found on a
		// board" is indeterminate here and must not surface as a deletion.
		const rawOwnerView = toOwnerView(owner, candidates, boards);
		const ownerView =
			noConsumers && rawOwnerView?.state === "deleted"
				? { ...rawOwnerView, state: "active" as const }
				: rawOwnerView;
		if (owner && ownerView?.state === "deleted") {
			blockers.push({ kind: "owner_deleted", message: "The repair owner task was deleted; reassign to continue." });
		}
		if (owner && ownerView?.state === "disabled") {
			blockers.push({
				kind: "owner_invalidated",
				message: "The repair owner is no longer eligible; work stopped without handoff.",
			});
		}
		if (resolved.key && candidates.length > 1 && (!owner || ownerView?.state !== "active")) {
			blockers.push({
				kind: "choose_repair_owner",
				message: "Multiple tasks qualify to repair this PR; choose the owner.",
			});
		}
		if (binding?.terminalStop?.reason === "merged_unresolved") {
			blockers.push({ kind: "needs_human", message: "Merge reconciliation needs a human decision." });
		}
		const snapshot = coordinator ? coordinator.getTaskAuthorizedSnapshot(scope.workspaceId, input.taskId) : null;
		return {
			ok: true,
			taskId: input.taskId,
			settingsRevision,
			staleRevision:
				typeof input.expectedSettingsRevision === "number" && input.expectedSettingsRevision !== settingsRevision,
			autoAddressComments: card.autoAddressComments === true,
			autoFinishOnMerge: card.autoFinishOnMerge === true,
			selectedAutomationPrKey: resolved.key,
			eligible,
			legacyCompletionGated: gate.legacyCompletionGated,
			mergeFinishesInReview: gate.mergeFinishesInReview,
			blockers,
			installedConsumers: installedConsumersOf(registry),
			commentsSupportedForTask,
			owner: ownerView,
			ownerLabel: owner && owner.workspaceId !== scope.workspaceId ? (ownerView?.label ?? null) : null,
			ownerCandidates: candidates.map((candidate) => ({
				workspaceId: candidate.workspaceId,
				taskId: candidate.taskId,
			})),
			reservation: toReservationView(record),
			snapshot: snapshot
				? {
						checkedAt: snapshot.checkedAt,
						isStale: snapshot.isStale,
						prState: snapshot.snapshot ? snapshot.snapshot.metadata.state : null,
					}
				: null,
			terminalStop: binding?.terminalStop
				? { reason: binding.terminalStop.reason, observedAt: binding.terminalStop.observedAt }
				: null,
			error: null,
		};
	};

	const getTaskPrSnapshot = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimePrAuthorizedSnapshotRequest,
	): Promise<RuntimePrAuthorizedSnapshotResponse> => {
		const coordinator = deps.getPrTrackingCoordinator();
		if (!coordinator) {
			return {
				ok: false,
				taskId: input.taskId,
				version: 0,
				snapshot: null,
				isStale: true,
				checkedAt: null,
				error: null,
			};
		}
		const result = coordinator.getTaskAuthorizedSnapshot(scope.workspaceId, input.taskId);
		return {
			ok: true,
			taskId: input.taskId,
			version: result.version ?? 0,
			snapshot: result.snapshot,
			isStale: result.isStale,
			checkedAt: result.checkedAt,
			error: null,
		};
	};

	const refreshTaskPrSnapshot = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimePrSnapshotRefreshRequest,
	): Promise<RuntimePrSnapshotRefreshResponse> => {
		const coordinator = deps.getPrTrackingCoordinator();
		if (!coordinator) {
			return { ok: false, coalesced: false, checkedAt: null, error: "PR tracking coordinator is not available" };
		}
		const sub = coordinator
			.listSubscriptions()
			.find((entry) => entry.workspaceId === scope.workspaceId && entry.taskId === input.taskId);
		if (!sub) {
			return { ok: false, coalesced: false, checkedAt: null, error: "No active subscription for this task" };
		}
		const found = await loadScopedCard(scope, input.taskId);
		const resolved = found ? resolveCardAutomationPrKey(found.card) : null;
		if (!resolved?.key) {
			return { ok: false, coalesced: false, checkedAt: null, error: "No resolvable Automation PR for this task" };
		}
		const refreshed = await coordinator.refresh(sub.canonicalPrKey, sub.accessScopeId);
		const after = coordinator.getTaskAuthorizedSnapshot(scope.workspaceId, input.taskId);
		return { ok: true, coalesced: refreshed.coalesced, checkedAt: after.checkedAt, error: null };
	};

	/**
	 * Resolve the caller's task -> canonical PR key + record + repair-owner
	 * check. `ambiguous_selection` / `missing_task` / `no_record` /
	 * `not_owner` are the only preconditions for record mutators.
	 */
	async function resolveRecordContext(
		scope: RuntimeTrpcWorkspaceScope,
		taskId: string,
	): Promise<
		| { ok: true; prKey: string; record: GitHubPrTrackingRecord; isOwner: boolean }
		| {
				ok: false;
				reason: "missing_task" | "ambiguous_selection" | "no_record" | "not_owner";
				recordRevision: number | null;
		  }
	> {
		const found = await loadScopedCard(scope, taskId);
		if (!found) {
			return { ok: false, reason: "missing_task", recordRevision: null };
		}
		const resolved = resolveCardAutomationPrKey(found.card);
		if (!resolved.key) {
			return { ok: false, reason: resolved.ambiguous ? "ambiguous_selection" : "no_record", recordRevision: null };
		}
		const loaded = await deps.getPrTrackingStore().loadRecord(resolved.key);
		if (!loaded.ok) {
			return { ok: false, reason: "no_record", recordRevision: null };
		}
		const owner = loaded.record.commentAutomation.repairOwner;
		const isOwner = owner !== null && owner.workspaceId === scope.workspaceId && owner.taskId === taskId;
		return { ok: true, prKey: resolved.key, record: loaded.record, isOwner };
	}

	const updateTaskCommentDispatch = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimePrCommentDispatchUpdateRequest,
	): Promise<RuntimePrRecordMutationResponse> => {
		const context = await resolveRecordContext(scope, input.taskId);
		if (!context.ok) {
			return { ok: false, recordRevision: context.recordRevision, reason: context.reason, error: null };
		}
		if (!context.isOwner) {
			return {
				ok: false,
				recordRevision: context.record.revision,
				reason: "not_owner",
				error: "Only the repair owner may dispatch comment follow-ups.",
			};
		}
		// Consumer-side CAS: the caller must hold the same owner tenure it
		// observed (a handoff between read and write is a conflict, even
		// though the record CAS already covers the revision bump).
		if (
			typeof input.expectedOwnerRevision === "number" &&
			context.record.commentAutomation.repairOwner?.ownerRevision !== input.expectedOwnerRevision
		) {
			return {
				ok: false,
				recordRevision: context.record.revision,
				reason: "conflict",
				error: "Owner revision mismatch: a repair-owner handoff occurred.",
			};
		}
		const store = deps.getPrTrackingStore();
		const expected = input.expectedRecordRevision;
		const result = await store.updateRecord(context.prKey, expected, (record) => ({
			...record,
			commentAutomation: {
				...record.commentAutomation,
				dispatch: input.dispatch,
			},
		}));
		if (!result.ok) {
			return { ok: false, recordRevision: null, reason: "conflict", error: `Record conflict: ${result.reason}` };
		}
		return { ok: true, recordRevision: result.record.revision, reason: null, error: null };
	};

	const resumeTaskPrTracking = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeTaskPrTrackingResumeRequest,
	): Promise<RuntimeTaskPrTrackingResumeResponse> => {
		const coordinator = deps.getPrTrackingCoordinator();
		const found = await loadScopedCard(scope, input.taskId);
		if (!coordinator) {
			return { ok: false, resumed: false, reason: "no_subscription", error: null };
		}
		if (!found) {
			return { ok: false, resumed: false, reason: "no_subscription", error: "Task not found" };
		}
		const resolved = resolveCardAutomationPrKey(found.card);
		if (!resolved.key) {
			return {
				ok: false,
				resumed: false,
				reason: resolved.ambiguous ? "ineligible" : "no_subscription",
				error: null,
			};
		}
		const result = await coordinator.resumePrTracking(scope.workspaceId, input.taskId);
		if (!result.ok) {
			const known = new Set([
				"no_subscription",
				"auth",
				"scope",
				"record",
				"no_binding",
				"still_terminal",
				"ineligible",
				"unsupported_host",
			]);
			return {
				ok: false,
				resumed: false,
				reason: known.has(result.reason)
					? (result.reason as RuntimeTaskPrTrackingResumeResponse["reason"])
					: "failed",
				error: null,
			};
		}
		return { ok: true, resumed: result.resumed, reason: null, error: null };
	};

	const updateTaskMergeBinding = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeTaskMergeBindingUpdateRequest,
	): Promise<RuntimePrRecordMutationResponse> => {
		const context = await resolveRecordContext(scope, input.taskId);
		if (!context.ok) {
			return { ok: false, recordRevision: context.recordRevision, reason: context.reason, error: null };
		}
		// The merge binding is per TASK, not per owner: any task whose own
		// binding selects this PR consumes its own merge completion. The
		// revision-checked record CAS (required expectedRecordRevision) is
		// the only concurrency guard.
		const store = deps.getPrTrackingStore();
		const expected = input.expectedRecordRevision;
		const result = await store.updateRecord(context.prKey, expected, (record) => ({
			...record,
			taskBindings: record.taskBindings.map((item) =>
				item.workspaceId === scope.workspaceId && item.taskId === input.taskId
					? { ...item, mergeCompletion: input.mergeCompletion }
					: item,
			),
		}));
		if (!result.ok) {
			return { ok: false, recordRevision: null, reason: "conflict", error: `Record conflict: ${result.reason}` };
		}
		return { ok: true, recordRevision: result.record.revision, reason: null, error: null };
	};

	const selectRepairOwnerProcedure = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimePrRepairOwnerSelectRequest,
	): Promise<RuntimePrRepairOwnerResponse> => {
		// Explicit owner assignment (the ambiguity-resolution path): the
		// caller names the task to assign; validation against the live
		// candidate list happens inside assignRepairOwner.
		const found = await loadScopedCard(scope, input.taskId);
		if (!found) {
			return { ok: false, owner: null, reason: "missing_task", candidates: [], error: null };
		}
		const resolved = resolveCardAutomationPrKey(found.card);
		if (!resolved.key) {
			return {
				ok: false,
				owner: null,
				reason: resolved.ambiguous ? "ambiguous" : "no_candidates",
				candidates: [],
				error: null,
			};
		}
		const boards = await deps.listManagedWorkspaceBoards();
		const result = await assignRepairOwner(
			deps.getPrTrackingStore(),
			resolved.key,
			boards,
			{ workspaceId: scope.workspaceId, taskId: input.taskId },
			{ expectedOwnerRevision: input.expectedOwnerRevision },
		);
		return {
			ok: result.ok,
			owner: result.owner ? toOwnerView(result.owner, result.candidates, boards) : null,
			reason: result.reason,
			candidates: toOwnerList(result.candidates, result.owner),
			error: null,
		};
	};

	const transferRepairOwnerProcedure = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimePrRepairOwnerTransferRequest,
	): Promise<RuntimePrRepairOwnerResponse> => {
		const fromFound = await loadScopedCard(scope, input.fromTaskId);
		if (!fromFound) {
			return { ok: false, owner: null, reason: "missing_task", candidates: [], error: null };
		}
		const resolved = resolveCardAutomationPrKey(fromFound.card);
		if (!resolved.key) {
			return {
				ok: false,
				owner: null,
				reason: resolved.ambiguous ? "ambiguous" : "no_candidates",
				candidates: [],
				error: null,
			};
		}
		// Drain precondition: no live writer session on source or target.
		const toWorkspaceId = input.toWorkspaceId ?? scope.workspaceId;
		let drained = true;
		try {
			if (await deps.isTaskWriterActive?.(scope.workspaceId, input.fromTaskId)) {
				drained = false;
			}
			if (drained && input.toTaskId && (await deps.isTaskWriterActive?.(toWorkspaceId, input.toTaskId)) === true) {
				drained = false;
			}
		} catch {
			drained = false;
		}
		const boards = await deps.listManagedWorkspaceBoards();
		const result = await transferRepairOwner(
			deps.getPrTrackingStore(),
			resolved.key,
			{ workspaceId: scope.workspaceId, taskId: input.fromTaskId },
			input.toTaskId ? { workspaceId: toWorkspaceId, taskId: input.toTaskId } : null,
			boards,
			{ writerActionsDrained: drained, expectedOwnerRevision: input.expectedOwnerRevision },
		);
		return {
			ok: result.ok,
			owner: result.owner ? toOwnerView(result.owner, result.candidates, boards) : null,
			reason: result.reason,
			candidates: toOwnerList(result.candidates, result.owner),
			error: null,
		};
	};

	const reservePrOperationProcedure = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimePrOperationReservationRequest,
	): Promise<RuntimePrOperationReservationResponse> => {
		const context = await resolveRecordContext(scope, input.taskId);
		if (!context.ok) {
			return { ok: false, status: "blocked", reservation: toReservationView(null), error: context.reason };
		}
		const result = await reservePrOperation(
			deps.getPrTrackingStore(),
			context.prKey,
			input.operation,
			{
				workspaceId: scope.workspaceId,
				taskId: input.taskId,
			},
			{
				// Per-operation authorization: comment follow-ups are
				// owner-gated; merge completion is claimable by the task
				// whose own binding selects this PR (already verified by
				// resolveRecordContext from the caller's card).
				requireOwner: input.operation === "comment_followup",
				headRepository: input.headRepository ?? null,
				headRef: input.headRef ?? null,
				expectedFencingGeneration: input.expectedFencingGeneration,
			},
		);
		const record = await deps.getPrTrackingStore().loadRecord(context.prKey);
		return {
			ok: result.status === "reserved",
			status: result.status,
			reservation: toReservationView(record.ok ? record.record : null),
			error: result.status === "reserved" ? null : `Reservation ${result.status}`,
		};
	};

	const validatePrOperationProcedure = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimePrOperationValidateRequest,
	): Promise<RuntimePrOperationReservationResponse> => {
		const context = await resolveRecordContext(scope, input.taskId);
		if (!context.ok) {
			return { ok: false, status: "blocked", reservation: toReservationView(null), error: context.reason };
		}
		const result = await validatePrOperation(deps.getPrTrackingStore(), context.prKey, input.operation, {
			workspaceId: scope.workspaceId,
			taskId: input.taskId,
		});
		const record = await deps.getPrTrackingStore().loadRecord(context.prKey);
		return {
			ok: result.status === "reserved",
			status: result.status,
			reservation: toReservationView(record.ok ? record.record : null),
			error: result.status === "reserved" ? null : `Operation validation ${result.status}`,
		};
	};

	const releasePrOperationProcedure = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimePrOperationReleaseRequest,
	): Promise<RuntimePrOperationReservationResponse> => {
		const context = await resolveRecordContext(scope, input.taskId);
		if (!context.ok) {
			return { ok: false, status: "blocked", reservation: toReservationView(null), error: context.reason };
		}
		const force = input.force === true;
		if (force) {
			const reservation = context.record.reservation;
			const held =
				reservation.state === "reserved" && reservation.reservedBy !== null
					? {
							operation: reservation.reservedOperation,
							holder: reservation.reservedBy,
							generation: reservation.fencingGeneration,
						}
					: null;
			if (
				!input.expectedHolder ||
				typeof input.expectedFencingGeneration !== "number" ||
				!held ||
				held.operation !== input.operation ||
				held.holder.workspaceId !== input.expectedHolder.workspaceId ||
				held.holder.taskId !== input.expectedHolder.taskId ||
				held.generation !== input.expectedFencingGeneration
			) {
				// The reservation changed since the operator observed it (or the
				// observation was incomplete): a stale operator click must not
				// clear a newer reservation. Audited even when refused.
				deps.warn?.(
					`PR tracking operator force release refused on ${context.prKey} (${input.operation}) by ${scope.workspaceId}/${input.taskId}: observed holder/generation does not match the record`,
				);
				return {
					ok: false,
					status: "stale",
					reservation: toReservationView(context.record),
					error: "Force release requires the holder and fencing generation the operator actually observed.",
				};
			}
			// A live holder can finish its write: verify prior process/session
			// exit before taking over. An uncertain (or unavailable) probe refuses.
			let holderActive: boolean;
			if (!deps.isTaskWriterActive) {
				holderActive = true;
				deps.warn?.(
					`PR tracking operator force release refused on ${context.prKey} (${input.operation}): holder-exit probe unavailable`,
				);
			} else {
				try {
					holderActive = await deps.isTaskWriterActive(held.holder.workspaceId, held.holder.taskId);
				} catch (error: unknown) {
					holderActive = true;
					deps.warn?.(
						`PR tracking operator force release refused on ${context.prKey} (${input.operation}): holder-exit probe failed (${String(error)})`,
					);
				}
			}
			if (holderActive) {
				deps.warn?.(
					`PR tracking operator force release refused on ${context.prKey} (${input.operation}) by ${scope.workspaceId}/${input.taskId}: holder ${held.holder.workspaceId}/${held.holder.taskId} is still active`,
				);
				return {
					ok: false,
					status: "busy",
					reservation: toReservationView(context.record),
					error: "The reservation holder's writer is still active; it can finish or must be stopped first.",
				};
			}
		}
		const result = await releasePrOperation(
			deps.getPrTrackingStore(),
			context.prKey,
			input.operation,
			{
				workspaceId: scope.workspaceId,
				taskId: input.taskId,
			},
			undefined,
			// Re-validate the operator's observed reservation INSIDE the
			// registry transaction: the holder-exit probe above is async, so a
			// re-reservation can land between the record read and this call.
			// A stale observation must return `stale`, never clear a newer
			// reservation.
			{
				force,
				...(force
					? { expectedHolder: input.expectedHolder, expectedFencingGeneration: input.expectedFencingGeneration }
					: {}),
			},
		);
		if (force) {
			// Audited operator action: an explicit release of a reservation
			// held by another (verified-dead) holder.
			deps.warn?.(
				`PR tracking operator force-release of ${input.operation} reservation on ${context.prKey} by ${scope.workspaceId}/${input.taskId} (cleared holder ${input.expectedHolder?.workspaceId}/${input.expectedHolder?.taskId} gen ${input.expectedFencingGeneration}, status ${result.status})`,
			);
		}
		const record = await deps.getPrTrackingStore().loadRecord(context.prKey);
		return {
			ok: result.status === "reserved",
			status: result.status,
			reservation: toReservationView(record.ok ? record.record : null),
			error: result.status === "reserved" ? null : `Release ${result.status}`,
		};
	};

	const readPrSnapshotEvents = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimePrSubscriptionRequest,
	): Promise<RuntimePrSubscriptionResponse> => {
		const coordinator = deps.getPrTrackingCoordinator();
		if (!coordinator) {
			return { ok: false, events: [], nextCursor: input.fromCursor ?? 0, error: null };
		}
		const result = await coordinator.readTaskSnapshotEvents(
			scope.workspaceId,
			input.taskId,
			input.consumer,
			input.fromCursor,
		);
		return { ok: true, events: result.events, nextCursor: result.nextCursor, error: null };
	};

	return {
		setTaskPrSettings,
		selectTaskAutomationPr,
		resumeTaskPrTracking,
		getTaskTrackingState,
		getTaskPrSnapshot,
		refreshTaskPrSnapshot,
		updateTaskCommentDispatch,
		updateTaskMergeBinding,
		selectRepairOwner: selectRepairOwnerProcedure,
		transferRepairOwner: transferRepairOwnerProcedure,
		reservePrOperation: reservePrOperationProcedure,
		validatePrOperation: validatePrOperationProcedure,
		releasePrOperation: releasePrOperationProcedure,
		readPrSnapshotEvents,
	};
}

function toOwnerList(
	candidates: Array<{ workspaceId: string; taskId: string; label: string }>,
	currentOwner: (GitHubPrTaskIdentity & { ownerRevision: number }) | null,
): RuntimePrTaskOwner[] {
	return candidates.map((candidate) => ({
		workspaceId: candidate.workspaceId,
		taskId: candidate.taskId,
		// Only the current owner holds a fencing generation; candidates are
		// reported at generation 0 (the value a fresh assignment would start from).
		ownerRevision:
			currentOwner && candidate.workspaceId === currentOwner.workspaceId && candidate.taskId === currentOwner.taskId
				? currentOwner.ownerRevision
				: 0,
		label: candidate.label,
		state: "active" as const,
	}));
}
