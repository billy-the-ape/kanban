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
import type { PrConsumerRegistry, PrInstalledConsumers } from "../pr-tracking/pr-consumer-registry";
import { evaluatePrLifecycleGate } from "../pr-tracking/pr-lifecycle-gate";
import {
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
		const coordinator = deps.getPrTrackingCoordinator();
		if (!coordinator) {
			return;
		}
		await reconcileTaskSubscriptions(coordinator, source);
	}

	/**
	 * Best-effort auto owner-selection for one canonical PR: exactly one
	 * eligible candidate is assigned atomically; multiple candidates report
	 * ambiguity (no assignment).
	 */
	async function autoSelectOwnerFor(canonicalPrKey: string, boards: PrBoardSnapshot[]): Promise<void> {
		await selectRepairOwner(deps.getPrTrackingStore(), canonicalPrKey, boards);
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
			const found = findTaskCard(state.board, input.taskId);
			if (!found) {
				return {
					value: {
						ok: false,
						taskId: input.taskId,
						autoAddressComments: false,
						autoFinishOnMerge: false,
						selectedAutomationPrKey: null,
						settingsRevision: 0,
						reason: "missing_task",
						error: null,
					},
					board: state.board,
					save: false,
				};
			}
			const card = found.card;
			const currentRevision = card.settingsRevision ?? 0;
			if (typeof input.expectedSettingsRevision === "number" && input.expectedSettingsRevision !== currentRevision) {
				return {
					value: {
						ok: false,
						taskId: input.taskId,
						autoAddressComments: card.autoAddressComments === true,
						autoFinishOnMerge: card.autoFinishOnMerge === true,
						selectedAutomationPrKey: card.selectedAutomationPrKey ?? null,
						settingsRevision: currentRevision,
						reason: "conflict",
						error: null,
					},
					board: state.board,
					save: false,
				};
			}
			const nextCard: RuntimeBoardCard = {
				...card,
				autoAddressComments:
					input.autoAddressComments === undefined ? card.autoAddressComments === true : input.autoAddressComments,
				autoFinishOnMerge:
					input.autoFinishOnMerge === undefined ? card.autoFinishOnMerge === true : input.autoFinishOnMerge,
				settingsRevision: currentRevision + 1,
			};
			return {
				value: {
					ok: true,
					taskId: input.taskId,
					autoAddressComments: nextCard.autoAddressComments === true,
					autoFinishOnMerge: nextCard.autoFinishOnMerge === true,
					selectedAutomationPrKey: nextCard.selectedAutomationPrKey ?? null,
					settingsRevision: currentRevision + 1,
					reason: null,
					error: null,
				},
				board: {
					...state.board,
					columns: state.board.columns.map((column) => ({
						...column,
						cards: column.cards.map((c) => (c.id === input.taskId ? nextCard : c)),
					})),
				},
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
		const nextCard: RuntimeBoardCard = {
			...card,
			selectedAutomationPrKey: selected ?? undefined,
			settingsRevision: currentRevision + 1,
		};
		await mutateWorkspaceState<null>(scope.workspacePath, (state) => ({
			value: null,
			board: {
				...state.board,
				columns: state.board.columns.map((column) => ({
					...column,
					cards: column.cards.map((c) => (c.id === input.taskId ? nextCard : c)),
				})),
			},
		}));
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
			settingsRevision: currentRevision + 1,
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
		const coordinatorState = coordinator ? coordinator.getState() : null;
		if (coordinatorState?.authBlocker) {
			blockers.push({ kind: "auth", message: coordinatorState.authBlocker });
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
			blockers.push({
				kind: "feature_unavailable",
				message: "Comment follow-up automation is not installed in this runtime.",
			});
		}
		if (card.autoFinishOnMerge === true && !installedFlags.mergeCompletion) {
			blockers.push({
				kind: "feature_unavailable",
				message: "Merge completion automation is not installed in this runtime.",
			});
		}
		const eligible = active && resolved.key !== null && gate.legacyCompletionGated;
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
		const boards = await deps.listManagedWorkspaceBoards();
		const candidates = resolved.key ? listRepairOwnerCandidates(resolved.key, boards) : [];
		const owner = resolved.key && record ? record.commentAutomation.repairOwner : null;
		const ownerView = toOwnerView(owner, candidates, boards);
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
			commentsSupportedForTask: true,
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
		await coordinator.refresh(sub.canonicalPrKey, sub.accessScopeId);
		const after = coordinator.getTaskAuthorizedSnapshot(scope.workspaceId, input.taskId);
		return { ok: true, coalesced: false, checkedAt: after.checkedAt, error: null };
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
		const store = deps.getPrTrackingStore();
		const expected = input.expectedRecordRevision ?? context.record.revision;
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
		if (!context.isOwner) {
			return {
				ok: false,
				recordRevision: context.record.revision,
				reason: "not_owner",
				error: "Only the repair owner may consume merge completion for this PR.",
			};
		}
		const store = deps.getPrTrackingStore();
		const expected = input.expectedRecordRevision ?? context.record.revision;
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
		const result = await selectRepairOwner(deps.getPrTrackingStore(), resolved.key, boards);
		return {
			ok: result.ok,
			owner: result.owner ? toOwnerView(result.owner, result.candidates, boards) : null,
			reason: result.reason,
			candidates: toOwnerList(result.candidates),
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
		let drained = true;
		try {
			if (await deps.isTaskWriterActive?.(scope.workspaceId, input.fromTaskId)) {
				drained = false;
			}
			if (
				drained &&
				input.toTaskId &&
				(await deps.isTaskWriterActive?.(scope.workspaceId, input.toTaskId)) === true
			) {
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
			input.toTaskId ? { workspaceId: scope.workspaceId, taskId: input.toTaskId } : null,
			boards,
			{ writerActionsDrained: drained, expectedOwnerRevision: input.expectedOwnerRevision },
		);
		return {
			ok: result.ok,
			owner: result.owner ? toOwnerView(result.owner, result.candidates, boards) : null,
			reason: result.reason,
			candidates: toOwnerList(result.candidates),
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
		const result = await releasePrOperation(deps.getPrTrackingStore(), context.prKey, input.operation, {
			workspaceId: scope.workspaceId,
			taskId: input.taskId,
		});
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
			input.fromCursor ?? 0,
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

function toOwnerList(candidates: Array<{ workspaceId: string; taskId: string; label: string }>): RuntimePrTaskOwner[] {
	return candidates.map((candidate) => ({
		workspaceId: candidate.workspaceId,
		taskId: candidate.taskId,
		ownerRevision: 0,
		label: candidate.label,
		state: "active" as const,
	}));
}
