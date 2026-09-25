// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions, but detailed Cline, terminal, and config behavior
// should stay in focused services instead of accumulating here.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import {
	buildClineCompactionConfig,
	CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT,
} from "../cline-sdk/cline-compaction-config";
import { buildTaskContextUsage } from "../cline-sdk/cline-context-usage";
import { createClineMcpRuntimeService } from "../cline-sdk/cline-mcp-runtime-service";
import { createClineMcpSettingsService } from "../cline-sdk/cline-mcp-settings-service";
import { createClineProviderService } from "../cline-sdk/cline-provider-service";
import type { ClineReviewSessionService } from "../cline-sdk/cline-review-session-service";
import { isClineClearSlashCommand } from "../cline-sdk/cline-slash-commands";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import type {
	RuntimeCommandRunResponse,
	RuntimeEffectiveContextWindow,
	RuntimeGitDeliveryReceipt,
	RuntimeRunUpdateResponse,
	RuntimeTaskDeliveryInfoResponse,
	RuntimeTaskDeliveryStartResponse,
	RuntimeTaskDiagnosticsActionResponse,
	RuntimeTaskDiagnosticsResponse,
	RuntimeTaskDispatchRecord,
	RuntimeTaskPhaseSummary,
	RuntimeTaskPhasesResponse,
	RuntimeTaskPreservationInfoResponse,
	RuntimeTaskPreservationRecord,
	RuntimeTaskReviewInfoResponse,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionSummary,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import {
	parseClineAccountSwitchRequest,
	parseClineAddProviderRequest,
	parseClineDeviceAuthCompleteRequest,
	parseClineMcpOAuthRequest,
	parseClineMcpSettingsSaveRequest,
	parseClineOauthLoginRequest,
	parseClineProviderModelsRequest,
	parseClineProviderSettingsSaveRequest,
	parseClineUpdateProviderRequest,
	parseCommandRunRequest,
	parseDiagnosticsExportRequest,
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskChatAbortRequest,
	parseTaskChatCancelRequest,
	parseTaskChatMessagesRequest,
	parseTaskChatReloadRequest,
	parseTaskChatSendRequest,
	parseTaskDeliveryInfoRequest,
	parseTaskDeliveryStartRequest,
	parseTaskDiagnosticsActionRequest,
	parseTaskDiagnosticsRequest,
	parseTaskPhasesRequest,
	parseTaskReviewInfoRequest,
	parseTaskReviewStartRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
} from "../core/api-validation";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { computeTaskPhase, isDeliveryResumable, type TaskPhaseInput } from "../core/task-diagnostics";
import { buildTaskDiagnosticsExportBundle } from "../core/task-diagnostics-export";
import { resolveTaskTitle } from "../core/task-title.js";
import { lockedFileSystem } from "../fs/locked-file-system";
import { openInBrowser } from "../server/browser";
import { getRuntimeHomePath, loadWorkspaceBoardById, mutateWorkspaceState } from "../state/workspace-state";
import { readTaskDispatchRecord } from "../task-dispatch/dispatch-records";
import {
	collectTaskDispatchSessions,
	getTaskDispatchStatus,
	reconcileTaskDispatch,
	releaseTaskFromDispatchQueue,
	dispatchReadyTasks as runTaskDispatchPass,
	type TaskDispatchDeps,
} from "../task-dispatch/task-dispatch-service";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createVerificationRunner } from "../verification/verification-service";
import { evaluateDependentsUnlock, getGitDeliveryService, readTaskDeliveryReceipt } from "../workspace/git-delivery";
import { readTaskPreservationRecord } from "../workspace/task-preservation";
import { findTaskBaseRef, readReviewOutcome } from "../workspace/task-review-handoff";
import {
	getTaskPreservationInfo,
	recoverTaskWorktree,
	resolveTaskCwd,
	taskWorktreeExists,
} from "../workspace/task-worktree";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

export interface CreateRuntimeApiDependencies {
	getActiveWorkspaceId: () => string | null;
	getActiveRuntimeConfig?: () => RuntimeConfigState;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	getScopedClineTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<ClineTaskSessionService>;
	/** B-6: the per-workspace bounded review session service (its own Cline session instance). */
	getScopedReviewSessionService?: (scope: RuntimeTrpcWorkspaceScope) => Promise<ClineReviewSessionService>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	broadcastClineMcpAuthStatusesUpdated?: (
		statuses: Awaited<ReturnType<ReturnType<typeof createClineMcpRuntimeService>["getAuthStatuses"]>>,
	) => void;
	broadcastTaskChatCleared?: (workspaceId: string, taskId: string) => void;
	bumpClineSessionContextVersion?: () => void;
	prepareForStateReset?: () => Promise<void>;
	getUpdateStatus: () => RuntimeUpdateStatusResponse;
	runUpdateNow: () => Promise<RuntimeRunUpdateResponse>;
	/** B-9: broadcast after dispatch-driven board mutations (fire-and-forget is fine). */
	broadcastRuntimeWorkspaceStateUpdated?: (workspaceId: string, workspacePath: string) => void;
	/** B-9: surface fire-and-forget dispatch pass failures (a missed pass is retried by the next trigger). */
	warnTaskDispatchError?: (error: unknown) => void;
}

async function resolveExistingTaskCwdOrEnsure(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<string> {
	try {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: false,
		});
	} catch {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: true,
		});
	}
}

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	const clineProviderService = createClineProviderService();
	const clineMcpSettingsService = createClineMcpSettingsService();
	const clineMcpRuntimeService = createClineMcpRuntimeService({
		onAuthStatusesChanged: (statuses) => {
			deps.broadcastClineMcpAuthStatusesUpdated?.(statuses);
		},
	});
	const debugResetTargetPaths = [
		join(homedir(), ".cline", "data"),
		join(homedir(), ".cline", "kanban"),
		join(homedir(), ".cline", "worktrees"),
	] as const;

	// B-2.9: the effective context window (budget override → provider-settings
	// override → provider metadata → fallback) is diagnostic input for the
	// settings UI; a lookup failure must never fail the whole config read.
	// B-6: the review session service is wired per-workspace by the server; a
	// missing binding (e.g. a partial test harness) is a clear, recoverable error.
	const requireReviewSessionService = (): ((
		scope: RuntimeTrpcWorkspaceScope,
	) => Promise<ClineReviewSessionService>) => {
		if (!deps.getScopedReviewSessionService) {
			throw new Error("The review session service is not configured for this workspace.");
		}
		return deps.getScopedReviewSessionService;
	};

	const buildConfigResponse = async (runtimeConfig: RuntimeConfigState) => {
		const clineProviderSettings = clineProviderService.getProviderSettingsSummary();
		let effectiveContextWindow: RuntimeEffectiveContextWindow | null = null;
		try {
			effectiveContextWindow = await clineProviderService.resolveEffectiveContextWindow(
				runtimeConfig.contextBudget?.contextWindowOverrideTokens,
			);
		} catch {
			effectiveContextWindow = null;
		}
		return buildRuntimeConfigResponse(runtimeConfig, clineProviderSettings, { effectiveContextWindow });
	};

	// Shared by the tRPC handler (manual starts) and the B-9 dispatch queue, so
	// queued tasks launch through exactly the code path the UI uses.
	const startTaskSession: RuntimeTrpcContext["runtimeApi"]["startTaskSession"] = async (workspaceScope, input) => {
		try {
			const body = parseTaskSessionStartRequest(input);
			if (body.resumeFromTrash) {
				deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
			}
			const requestedClineTaskMode = body.mode ?? "act";
			const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			const taskCwd = isHomeAgentSessionId(body.taskId)
				? workspaceScope.workspacePath
				: await resolveExistingTaskCwdOrEnsure({
						cwd: workspaceScope.workspacePath,
						taskId: body.taskId,
						baseRef: body.baseRef,
					});
			const shouldCaptureTurnCheckpoint = !body.resumeFromTrash && !isHomeAgentSessionId(body.taskId);

			// Per-task config source-of-truth precedence:
			//
			// agentId resolution (which agent runtime to use):
			//   1. previousTerminalAgentId — persisted in the terminal session summary from
			//      the last run; ensures trash-restore resumes with the same agent runtime.
			//   2. body.agentId — the card's current per-task agent override.
			//   3. scopedRuntimeConfig.selectedAgentId — the workspace-level default.
			//
			// clineSettings (which LLM model and reasoning profile the Cline agent uses):
			//   Always taken from the card's current override object. There is no
			//   session-level persistence for these;
			//   if the user changes the model on the card, the next session launch
			//   (including trash-restore) uses the updated values.
			const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
			const previousTerminalAgentId = body.resumeFromTrash
				? (terminalManager.getSummary(body.taskId)?.agentId ?? null)
				: null;
			const effectiveAgentId = previousTerminalAgentId ?? body.agentId ?? scopedRuntimeConfig.selectedAgentId;
			let useClinePath = effectiveAgentId === "cline";
			const shouldProbePersistedClineSession =
				body.resumeFromTrash && !useClinePath && previousTerminalAgentId === null;
			if (shouldProbePersistedClineSession) {
				// If the terminal summary already has a concrete non-Cline agentId,
				// skip Cline persisted-session probing. That probe can cold-start the
				// Cline session host and adds multi-second latency to Codex restores.
				const clineSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const persistedSession = await clineSessionService
					.rebindPersistedTaskSession(body.taskId)
					.catch(() => null);
				if (persistedSession) {
					useClinePath = true;
				}
			}

			if (useClinePath) {
				const hasTaskLevelClineSettingsOverride = body.clineSettings !== undefined;
				const clineLaunchConfig = await clineProviderService.resolveLaunchConfig({
					providerIdOverride: body.clineSettings?.providerId ?? undefined,
					modelIdOverride: body.clineSettings?.modelId ?? undefined,
					...(hasTaskLevelClineSettingsOverride
						? {
								reasoningEffortOverride: body.clineSettings?.reasoningEffort ?? null,
							}
						: {}),
				});
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const resolvedClineTitle = resolveTaskTitle(body.taskTitle?.trim(), body.prompt);
				const summary = await clineTaskSessionService.startTaskSession({
					taskId: body.taskId,
					cwd: taskCwd,
					prompt: body.prompt,
					taskTitle: resolvedClineTitle.length > 0 ? resolvedClineTitle : undefined,
					images: body.images,
					resumeFromTrash: body.resumeFromTrash,
					providerId: clineLaunchConfig.providerId,
					modelId: clineLaunchConfig.modelId,
					mode: requestedClineTaskMode,
					startInPlanMode: body.startInPlanMode,
					apiKey: clineLaunchConfig.apiKey,
					baseUrl: clineLaunchConfig.baseUrl,
					reasoningEffort: clineLaunchConfig.reasoningEffort,
					contextWindowTokens: clineLaunchConfig.contextWindowTokens,
					contextWindowSource: clineLaunchConfig.contextWindowSource,
					compaction: buildClineCompactionConfig({ launchConfig: clineLaunchConfig }),
					compactionSafetyMarginTokens: clineLaunchConfig.compactionSettings?.safetyMarginTokens,
				});

				let nextSummary = summary;
				if (shouldCaptureTurnCheckpoint) {
					try {
						const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
						const checkpoint = await captureTaskTurnCheckpoint({
							cwd: taskCwd,
							taskId: body.taskId,
							turn: nextTurn,
						});
						nextSummary = clineTaskSessionService.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
					} catch {
						// Best effort checkpointing only.
					}
				}

				return {
					ok: true,
					summary: nextSummary,
				};
			}

			const resolvedConfig =
				effectiveAgentId !== scopedRuntimeConfig.selectedAgentId
					? { ...scopedRuntimeConfig, selectedAgentId: effectiveAgentId }
					: scopedRuntimeConfig;
			const resolved = resolveAgentCommand(resolvedConfig);
			if (!resolved) {
				return {
					ok: false,
					summary: null,
					error: "No runnable agent command is configured. Open Settings, install a supported CLI, and select it.",
				};
			}
			const summary = await terminalManager.startTaskSession({
				taskId: body.taskId,
				agentId: resolved.agentId,
				binary: resolved.binary,
				args: resolved.args,
				autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
				cwd: taskCwd,
				prompt: body.prompt,
				images: body.images,
				startInPlanMode: body.startInPlanMode,
				resumeFromTrash: body.resumeFromTrash,
				cols: body.cols,
				rows: body.rows,
				workspaceId: workspaceScope.workspaceId,
			});

			let nextSummary = summary;
			if (shouldCaptureTurnCheckpoint) {
				try {
					const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpoint = await captureTaskTurnCheckpoint({
						cwd: taskCwd,
						taskId: body.taskId,
						turn: nextTurn,
					});
					nextSummary = terminalManager.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
				} catch {
					// Best effort checkpointing only.
				}
			}
			return {
				ok: true,
				summary: nextSummary,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				summary: null,
				error: message,
			};
		}
	};

	const buildTaskDispatchDeps = (workspaceScope: RuntimeTrpcWorkspaceScope): TaskDispatchDeps => {
		return {
			workspaceId: workspaceScope.workspaceId,
			workspacePath: workspaceScope.workspacePath,
			loadConfig: () => deps.loadScopedRuntimeConfig(workspaceScope),
			loadBoard: () => loadWorkspaceBoardById(workspaceScope.workspaceId),
			persistBoard: async (mutate) => {
				await mutateWorkspaceState<void>(workspaceScope.workspacePath, (state) => ({
					board: mutate(state.board),
					value: undefined,
				}));
			},
			listSessions: async () => {
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				// B-11.2: review/repair sessions hold model worker slots too; a missing
				// binding (partial test harness) simply means no review sessions.
				const reviewSessionService = await deps.getScopedReviewSessionService?.(workspaceScope);
				return collectTaskDispatchSessions({
					terminal: terminalManager,
					clineSummaries: clineTaskSessionService.listSummaries(),
					reviewSummaries: reviewSessionService?.listSessionSummaries() ?? [],
				});
			},
			readReceipt: (taskId) => readTaskDeliveryReceipt(taskId),
			startSession: async ({ taskId, baseRef, prompt, taskTitle }) => {
				const request: RuntimeTaskSessionStartRequest = {
					taskId,
					baseRef,
					prompt,
					taskTitle,
					mode: "act",
				};
				const response = await startTaskSession(workspaceScope, request);
				return response.ok && response.summary
					? { ok: true, summary: response.summary }
					: { ok: false, error: response.error ?? "Task session start failed." };
			},
			onStateUpdated: () => {
				deps.broadcastRuntimeWorkspaceStateUpdated?.(workspaceScope.workspaceId, workspaceScope.workspacePath);
			},
		};
	};
	const runTaskDispatchAfterStateChange = (workspaceScope: RuntimeTrpcWorkspaceScope): void => {
		void runTaskDispatchPass(buildTaskDispatchDeps(workspaceScope)).catch((error) => {
			// A missed pass is never fatal: the next state change (delivery,
			// session stop, board save, or explicit trigger) will retry it.
			deps.warnTaskDispatchError?.(error);
		});
	};

	// B-10: shared raw-data snapshot for task diagnostics. The single-task
	// core gather includes git and tree-hash work (preservation info, review
	// tree binding); the batched phases endpoint uses the durable records only
	// (gatherTaskPhaseInputs). The context snapshot (full transcript) is only
	// fetched for the single-task diagnostics and export paths.
	type TaskContextSnapshot = Awaited<ReturnType<ClineTaskSessionService["getTaskContextSnapshot"]>>;

	/** The task's session as the runtime sees it right now (Cline or terminal agent). */
	interface TaskSessionState {
		summary: RuntimeTaskSessionSummary | null;
		/** A session is live in this runtime (running or awaiting review input) and can be cancelled. */
		active: boolean;
		source: "cline" | "terminal" | null;
	}

	/**
	 * Resolve task sessions from both session sources. Terminal summaries can
	 * be hydrated from disk after a restart with no process behind them, so a
	 * terminal session only counts as active while its process is alive (the
	 * same liveness rule the dispatch queue uses).
	 */
	const createTaskSessionLookup = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
	): Promise<(taskId: string) => TaskSessionState> => {
		const [clineTaskSessionService, terminalManager] = await Promise.all([
			deps.getScopedClineTaskSessionService(workspaceScope).catch(() => null),
			deps.getScopedTerminalManager(workspaceScope).catch(() => null),
		]);
		return (taskId) => {
			const clineSummary = (clineTaskSessionService?.getSummary(taskId) ?? null) as RuntimeTaskSessionSummary | null;
			if (clineSummary) {
				return { summary: clineSummary, active: isLiveSessionState(clineSummary.state), source: "cline" };
			}
			const terminalSummary = terminalManager?.getSummary(taskId) ?? null;
			if (terminalSummary) {
				return {
					summary: terminalSummary,
					active: isLiveSessionState(terminalSummary.state) && terminalManager?.hasActiveProcess(taskId) === true,
					source: "terminal",
				};
			}
			return { summary: null, active: false, source: null };
		};
	};

	const isLiveSessionState = (state: RuntimeTaskSessionSummary["state"]): boolean =>
		state === "running" || state === "awaiting_review";

	interface TaskDiagnosticsCore {
		task: { id: string; title: string; columnId: string; updatedAt: number } | null;
		/** The card's prompt — the authoritative description a review retry needs. */
		taskPrompt: string | null;
		baseRef: string | null;
		delivery: RuntimeTaskDeliveryInfoResponse;
		review: RuntimeTaskReviewInfoResponse;
		dispatchRecord: RuntimeTaskDispatchRecord | null;
		preservation: RuntimeTaskPreservationInfoResponse | null;
		session: TaskSessionState;
	}

	const gatherTaskDiagnosticsCore = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskId: string,
	): Promise<TaskDiagnosticsCore> => {
		const board = await loadWorkspaceBoardById(workspaceScope.workspaceId).catch(() => null);
		const columnWithTask = board?.columns.find((column) => column.cards.some((card) => card.id === taskId));
		const card = columnWithTask?.cards.find((c) => c.id === taskId) ?? null;
		// Reuse the exact procedure behavior (including the cross-workspace
		// receipt filter) rather than duplicating it here.
		const [delivery, review, dispatchRecord, preservation, lookupSession] = await Promise.all([
			runtimeApi.getTaskDeliveryInfo(workspaceScope, { taskId }),
			runtimeApi.getTaskReviewInfo(workspaceScope, { taskId }),
			readTaskDispatchRecord(taskId).catch(() => null),
			getTaskPreservationInfo({ repoPath: workspaceScope.workspacePath, taskId }).catch(() => null),
			createTaskSessionLookup(workspaceScope),
		]);

		return {
			task:
				card && columnWithTask
					? {
							id: card.id,
							title: card.title,
							columnId: columnWithTask.id,
							updatedAt: card.updatedAt,
						}
					: null,
			taskPrompt: card?.prompt ?? null,
			baseRef: card?.baseRef ?? delivery.receipt?.baseRef ?? null,
			delivery,
			review,
			dispatchRecord,
			preservation,
			session: lookupSession(taskId),
		};
	};

	const gatherTaskDiagnosticsSnapshot = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskId: string,
	): Promise<TaskDiagnosticsCore & { contextSnapshot: TaskContextSnapshot }> => {
		const core = await gatherTaskDiagnosticsCore(workspaceScope, taskId);
		// Only native Cline sessions have a transcript Kanban can measure.
		const contextSnapshot =
			core.session.source === "cline"
				? await deps
						.getScopedClineTaskSessionService(workspaceScope)
						.then((service) => service.getTaskContextSnapshot(taskId))
						.catch(() => null)
				: null;
		return { ...core, contextSnapshot };
	};

	/** Map lifecycle records onto the pure phase computation's input. */
	const toTaskPhaseInput = (records: {
		sessionActive: boolean;
		receipt: RuntimeGitDeliveryReceipt | null;
		reviewStatus: RuntimeTaskReviewInfoResponse["status"];
		reviewError: string | null;
		dispatchRecord: RuntimeTaskDispatchRecord | null;
		preservationRecord: RuntimeTaskPreservationRecord | null;
		worktreeExists: boolean;
	}): TaskPhaseInput => ({
		sessionActive: records.sessionActive,
		deliveryStatus: records.receipt?.status ?? null,
		deliveryStage: records.receipt?.stage ?? null,
		deliveryEvidence: records.receipt?.evidence ?? [],
		reviewStatus: records.reviewStatus,
		reviewError: records.reviewError,
		dispatchStatus: records.dispatchRecord?.status ?? null,
		dispatchError: records.dispatchRecord?.error ?? null,
		preservationStatus: records.preservationRecord?.status ?? "none",
		preservationBlockedReasons: records.preservationRecord?.blockedReasons ?? [],
		worktreeExists: records.worktreeExists,
	});

	/** Map the single-task snapshot onto the pure phase computation's input. */
	const buildTaskPhaseInput = (core: TaskDiagnosticsCore): TaskPhaseInput =>
		toTaskPhaseInput({
			sessionActive: core.session.active,
			receipt: core.delivery.receipt,
			reviewStatus: core.review.status,
			reviewError: core.review.error,
			dispatchRecord: core.dispatchRecord,
			preservationRecord: core.preservation?.preservation ?? null,
			worktreeExists: core.preservation?.worktreeExists ?? false,
		});

	/**
	 * B-10.1: phase inputs for many tasks from the durable records alone — no
	 * board load, no git commands, no candidate-tree hashing — so the board
	 * chips can refresh often. Sessions are resolved once for the batch.
	 */
	const gatherTaskPhaseInputs = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskIds: string[],
	): Promise<Map<string, TaskPhaseInput | null>> => {
		const lookupSession = await createTaskSessionLookup(workspaceScope);
		const entries = await Promise.all(
			taskIds.map(async (taskId): Promise<[string, TaskPhaseInput | null]> => {
				try {
					const [receipt, outcome, dispatchRecord, preservationRecord, worktreeExists] = await Promise.all([
						readTaskDeliveryReceipt(taskId).catch(() => null),
						readReviewOutcome(taskId).catch(() => null),
						readTaskDispatchRecord(taskId).catch(() => null),
						readTaskPreservationRecord(taskId).catch(() => null),
						taskWorktreeExists(workspaceScope.workspacePath, taskId),
					]);
					return [
						taskId,
						toTaskPhaseInput({
							sessionActive: lookupSession(taskId).active,
							// Same cross-workspace filter as getTaskDeliveryInfo.
							receipt: receipt && receipt.workspaceId === workspaceScope.workspaceId ? receipt : null,
							reviewStatus: outcome?.status ?? null,
							reviewError: outcome?.error ?? null,
							dispatchRecord,
							preservationRecord,
							worktreeExists,
						}),
					];
				} catch {
					return [taskId, null];
				}
			}),
		);
		return new Map(entries);
	};

	const buildEmptyContextUsage = (error: string | null) => ({
		ok: error === null,
		source: "unavailable" as const,
		messageCount: null,
		estimatedMessageTokens: null,
		effectiveCapacityTokens: null,
		triggerTokens: null,
		utilizationRatio: null,
		lastCompaction: null,
		historyOmitted: false,
		omittedHistoryNotice: null,
		error,
	});

	/**
	 * B-10.4: assemble the context-usage payload from the transcript snapshot
	 * and the resolved capacity. Trigger level is the compaction trigger
	 * (window - output reserve), matching what the session will actually do.
	 */
	const buildDiagnosticsContextUsage = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		snapshot: TaskDiagnosticsCore & { contextSnapshot: TaskContextSnapshot },
	) => {
		const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
		const contextBudget = scopedRuntimeConfig.contextBudget ?? null;
		const effectiveContextWindow = await clineProviderService
			.resolveEffectiveContextWindow(contextBudget?.contextWindowOverrideTokens ?? null)
			.catch(() => null);
		const effectiveCapacityTokens = effectiveContextWindow?.limitTokens ?? null;
		const reserveTokens = contextBudget?.outputReserveTokens ?? CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT;
		const triggerTokens =
			effectiveCapacityTokens !== null ? Math.max(0, effectiveCapacityTokens - reserveTokens) : null;
		const { contextSnapshot } = snapshot;
		return buildTaskContextUsage({
			messages: contextSnapshot ? contextSnapshot.messages.map((message) => ({ content: message.content })) : null,
			effectiveCapacityTokens,
			triggerTokens,
			lastCompaction: contextSnapshot?.lastCompaction ?? null,
		});
	};

	const buildEmptyDiagnosticsResponse = (error: string | null): RuntimeTaskDiagnosticsResponse => ({
		ok: error === null,
		task: null,
		phase: "idle",
		lastSuccessfulPhase: null,
		needsAttention: false,
		blockedReason: null,
		branch: null,
		commit: null,
		baseRef: null,
		baseSha: null,
		workspace: { worktreePath: null, exists: false },
		preservedWork: {
			status: "none",
			refName: null,
			patchPath: null,
			archivePath: null,
			latestCommit: null,
			blockedReasons: [],
			preservedAt: null,
		},
		delivery: {
			ok: error === null,
			receipt: null,
			error,
			dependentsUnlock: { allowed: false, reason: error ?? "No delivery receipt." },
		},
		review: {
			ok: error === null,
			status: null,
			handoff: null,
			result: null,
			candidateTreeHash: null,
			resultMatchesTree: null,
			error,
			warnings: [],
			verification: null,
		},
		dispatchRecord: null,
		session: { summary: null, active: false },
		context: buildEmptyContextUsage(error),
		actions: {
			retry_phase: { enabled: false, reason: error ?? "No failed phase to retry." },
			resume_repair: { enabled: false, reason: error ?? "No delivery to resume." },
			cancel: { enabled: false, reason: error ?? "No active session to cancel." },
			recover_workspace: { enabled: false, reason: error ?? "No preserved work for this task." },
		},
		error,
	});

	/** B-10.2: assemble the aggregated diagnostics response from a snapshot. */
	const buildTaskDiagnosticsResponse = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		snapshot: TaskDiagnosticsCore & { contextSnapshot: TaskContextSnapshot },
	): Promise<RuntimeTaskDiagnosticsResponse> => {
		const phase = computeTaskPhase(buildTaskPhaseInput(snapshot));
		const receipt = snapshot.delivery.receipt;
		const preservation = snapshot.preservation;
		const preservationRecord = preservation?.preservation ?? null;
		return {
			ok: true,
			task: snapshot.task,
			phase: phase.phase,
			lastSuccessfulPhase: phase.lastSuccessfulPhase,
			needsAttention: phase.needsAttention,
			blockedReason: phase.blockedReason,
			branch: receipt?.destinationBranch ?? null,
			commit: receipt?.taskCommitSha ?? (preservation?.worktreeExists ? preservation.headCommit : null) ?? null,
			baseRef: snapshot.baseRef,
			baseSha: receipt?.baseSha ?? preservationRecord?.startingCommit ?? null,
			workspace: {
				worktreePath: preservation?.worktreePath ?? null,
				exists: preservation?.worktreeExists ?? false,
			},
			preservedWork: {
				status: preservationRecord?.status ?? "none",
				refName: preservationRecord?.refName ?? null,
				patchPath: preservationRecord?.patchPath ?? null,
				archivePath: preservationRecord?.archivePath ?? null,
				latestCommit: preservationRecord?.latestCommit ?? null,
				blockedReasons: preservationRecord?.blockedReasons ?? [],
				preservedAt: preservationRecord?.preservedAt
					? new Date(preservationRecord.preservedAt).toISOString()
					: null,
			},
			delivery: snapshot.delivery,
			review: snapshot.review,
			dispatchRecord: snapshot.dispatchRecord,
			session: {
				summary: snapshot.session.summary,
				active: snapshot.session.active,
			},
			context: await buildDiagnosticsContextUsage(workspaceScope, snapshot),
			actions: phase.actions,
			error: null,
		};
	};

	// B-10.3: in-flight dedup for diagnostics actions, keyed by
	// workspace:task:action so a double-click or a UI+CLI race only runs the
	// action once. The map holds the promise (never a flag) so concurrent
	// callers join the same run and all see its outcome.
	const taskDiagnosticsActionInFlight = new Map<string, Promise<RuntimeTaskDiagnosticsActionResponse>>();

	const runtimeApi: RuntimeTrpcContext["runtimeApi"] = {
		loadConfig: async (workspaceScope) => {
			const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
			if (!workspaceScope && !activeRuntimeConfig) {
				throw new Error("No active runtime config provider is available.");
			}
			let scopedRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			} else if (activeRuntimeConfig) {
				scopedRuntimeConfig = activeRuntimeConfig;
			} else {
				throw new Error("No active runtime config provider is available.");
			}
			return buildConfigResponse(scopedRuntimeConfig);
		},
		saveConfig: async (workspaceScope, input) => {
			const parsed = parseRuntimeConfigSaveRequest(input);
			// B-10.6: the reliable-completion convenience switch expands into
			// the underlying policies in the same save; any gate explicitly set
			// in this request wins per-gate. Turning it on without any
			// verification checks configured still derives as "not fully on" —
			// the response's reliableCompletion block shows which gate is
			// missing.
			if (parsed.reliableCompletion !== undefined) {
				const enabled = parsed.reliableCompletion;
				if (parsed.reviewPolicy === undefined) {
					parsed.reviewPolicy = { enabled: enabled ? "required" : "off" };
				}
				if (parsed.verification === undefined) {
					parsed.verification = { enabled: enabled ? "required" : "off" };
				}
				if (parsed.gitDeliveryPolicy === undefined) {
					parsed.gitDeliveryPolicy = { enabled, pushRequired: enabled };
				}
				if (parsed.taskDispatchPolicy === undefined) {
					parsed.taskDispatchPolicy = { enabled };
				}
			}
			let nextRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				nextRuntimeConfig = await updateRuntimeConfig(workspaceScope.workspacePath, parsed);
			} else {
				const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
				if (!activeRuntimeConfig) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "No active runtime config is available.",
					});
				}
				nextRuntimeConfig = await updateGlobalRuntimeConfig(activeRuntimeConfig, parsed);
			}
			if (workspaceScope && workspaceScope.workspaceId === deps.getActiveWorkspaceId()) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			if (!workspaceScope) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			return buildConfigResponse(nextRuntimeConfig);
		},
		saveClineProviderSettings: async (_workspaceScope, input) => {
			const body = parseClineProviderSettingsSaveRequest(input);
			const response = clineProviderService.saveProviderSettings(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		addClineProvider: async (_workspaceScope, input) => {
			const body = parseClineAddProviderRequest(input);
			const response = await clineProviderService.addCustomProvider(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		updateClineProvider: async (_workspaceScope, input) => {
			const body = parseClineUpdateProviderRequest(input);
			const response = await clineProviderService.updateCustomProvider(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		startTaskSession: async (workspaceScope, input) => {
			// B-9: a manual start takes the task over from the queue, clearing any
			// failed/blocked/exhausted dispatch state it had accumulated.
			if (!isHomeAgentSessionId(input.taskId)) {
				await releaseTaskFromDispatchQueue(input.taskId).catch(() => null);
			}
			return await startTaskSession(workspaceScope, input);
		},
		// B-6.2: start a bounded, fresh-context review session for a task. The
		// effective review policy comes from the scoped runtime config; the service
		// resolves the worktree, builds the handoff, runs the session (with the
		// review tool policy), and persists the durable, tree-bound verdict.
		startTaskReview: async (workspaceScope, input) => {
			try {
				const body = parseTaskReviewStartRequest(input);
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				const reviewService = await requireReviewSessionService()(workspaceScope);
				return await reviewService.startTaskReview({
					...body,
					reviewPolicy: scopedRuntimeConfig.reviewPolicy,
					verification: scopedRuntimeConfig.verification,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					status: "failed",
					handoff: null,
					result: null,
					candidateTreeHash: null,
					sessionId: null,
					error: message,
					warnings: [],
					verification: null,
				};
			}
		},
		// B-6.7: read the durable review verdict + the live candidate tree hash.
		getTaskReviewInfo: async (workspaceScope, input) => {
			try {
				const body = parseTaskReviewInfoRequest(input);
				const reviewService = await requireReviewSessionService()(workspaceScope);
				return await reviewService.getReviewInfo(body.taskId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					status: null,
					handoff: null,
					result: null,
					candidateTreeHash: null,
					resultMatchesTree: null,
					error: message,
					warnings: [],
					verification: null,
				};
			}
		},
		// B-8: deterministic git delivery — the application controls commit,
		// integration, push, remote verification, and the durable receipt,
		// independent of model availability.
		startTaskDelivery: async (workspaceScope, input): Promise<RuntimeTaskDeliveryStartResponse> => {
			try {
				const body = parseTaskDeliveryStartRequest(input);
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				const policy = scopedRuntimeConfig.gitDeliveryPolicy;
				const verificationConfig = scopedRuntimeConfig.verification;
				if (!policy?.enabled) {
					return {
						ok: false,
						receipt: null,
						error: "Git delivery is not enabled; enable gitDeliveryPolicy in the runtime settings first.",
					};
				}
				const baseRef = await findTaskBaseRef(workspaceScope.workspaceId, body.taskId);
				if (!baseRef) {
					return {
						ok: false,
						receipt: null,
						error: "Task has no base ref; its worktree cannot be resolved for delivery.",
					};
				}
				let worktreePath: string;
				try {
					worktreePath = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: body.taskId,
						baseRef,
						ensure: false,
					});
				} catch {
					return {
						ok: false,
						receipt: null,
						error: `Task worktree for "${body.taskId}" was not found; start the task session before delivery.`,
					};
				}
				return await getGitDeliveryService()
					.startDelivery({
						taskId: body.taskId,
						workspaceId: workspaceScope.workspaceId,
						repoPath: workspaceScope.workspacePath,
						worktreePath,
						baseRef,
						policy,
						// B-6.7/B-7.6: a required review/verification must be ready and
						// bound to the exact candidate tree before delivery commits it.
						gates: {
							reviewRequired: scopedRuntimeConfig.reviewPolicy?.enabled === "required",
							verificationRequired: scopedRuntimeConfig.verification?.enabled === "required",
						},
						commitMessage: body.commitMessage,
						// B-11.5: rerun the required checks against the combined tree
						// once parallel work has been integrated (diverged path only).
						runCombinedVerification:
							verificationConfig?.enabled === "required" && verificationConfig.checks.length > 0
								? async ({ taskId, worktreePath, candidateTreeHash }) => {
										const receipt = await createVerificationRunner().run(verificationConfig, {
											taskId,
											worktreePath,
											candidateTreeHash,
										});
										return { passed: receipt.passed, error: receipt.error };
									}
								: undefined,
					})
					.then(async (response) => {
						// B-9.2: a durable delivery receipt is the only thing that unlocks
						// dependent tasks — give the queue a pass as soon as one is written.
						if (response.receipt) {
							runTaskDispatchAfterStateChange(workspaceScope);
						}
						return response;
					});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, receipt: null, error: message };
			}
		},
		// B-8.8: read the durable delivery receipt for a task. The receipt is
		// keyed by task id only, so a receipt from another workspace is not
		// surfaced here.
		getTaskDeliveryInfo: async (workspaceScope, input): Promise<RuntimeTaskDeliveryInfoResponse> => {
			try {
				const body = parseTaskDeliveryInfoRequest(input);
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				const info = await getGitDeliveryService().getDeliveryInfo(
					body.taskId,
					scopedRuntimeConfig.gitDeliveryPolicy,
				);
				if (info.receipt && info.receipt.workspaceId !== workspaceScope.workspaceId) {
					return {
						...info,
						receipt: null,
						dependentsUnlock: evaluateDependentsUnlock(scopedRuntimeConfig.gitDeliveryPolicy, null),
					};
				}
				return info;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					receipt: null,
					error: message,
					dependentsUnlock: { allowed: false, reason: `The delivery receipt could not be read: ${message}` },
				};
			}
		},
		// B-10: operational controls & diagnostics.
		getTaskDiagnostics: async (workspaceScope, input): Promise<RuntimeTaskDiagnosticsResponse> => {
			try {
				const body = parseTaskDiagnosticsRequest(input);
				const snapshot = await gatherTaskDiagnosticsSnapshot(workspaceScope, body.taskId);
				return await buildTaskDiagnosticsResponse(workspaceScope, snapshot);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return buildEmptyDiagnosticsResponse(message);
			}
		},
		// B-10.1: batched phase summaries for board chips. Tasks without any
		// lifecycle artifact map to `idle` rather than failing the batch.
		getTaskPhases: async (workspaceScope, input): Promise<RuntimeTaskPhasesResponse> => {
			try {
				const body = parseTaskPhasesRequest(input);
				const phases: Record<string, RuntimeTaskPhaseSummary> = {};
				const inputs = await gatherTaskPhaseInputs(workspaceScope, body.taskIds);
				for (const taskId of body.taskIds) {
					const input = inputs.get(taskId);
					if (!input) {
						phases[taskId] = { phase: "idle", needsAttention: false, blockedReason: null };
						continue;
					}
					const phase = computeTaskPhase(input);
					phases[taskId] = {
						phase: phase.phase,
						needsAttention: phase.needsAttention,
						blockedReason: phase.blockedReason,
					};
				}
				return { ok: true, phases, error: null };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, phases: {}, error: message };
			}
		},
		// B-9: backend-owned sequential task dispatch ("reliable queue").
		dispatchReadyTasks: async (workspaceScope) => {
			return await runTaskDispatchPass(buildTaskDispatchDeps(workspaceScope));
		},
		getDispatchStatus: async (workspaceScope) => {
			return await getTaskDispatchStatus(buildTaskDispatchDeps(workspaceScope));
		},
		reconcileTaskDispatch: async (workspaceScope) => {
			return await reconcileTaskDispatch(buildTaskDispatchDeps(workspaceScope));
		},
		// B-10.3: run an operator action with in-flight dedup. The action is
		// re-checked against the current snapshot at run time (availability may
		// have changed since the UI rendered the button), then delegated to the
		// native handler for that phase.
		runTaskDiagnosticsAction: async (workspaceScope, input): Promise<RuntimeTaskDiagnosticsActionResponse> => {
			const body = parseTaskDiagnosticsActionRequest(input);
			const dedupKey = `${workspaceScope.workspaceId}:${body.taskId}:${body.action}`;
			const inFlight = taskDiagnosticsActionInFlight.get(dedupKey);
			if (inFlight) {
				const prior = await inFlight;
				return { ...prior, deduplicated: true };
			}
			const run: Promise<RuntimeTaskDiagnosticsActionResponse> = (async () => {
				try {
					const core = await gatherTaskDiagnosticsCore(workspaceScope, body.taskId);
					const availability = computeTaskPhase(buildTaskPhaseInput(core)).actions[body.action];
					if (!availability.enabled) {
						return {
							ok: false,
							action: body.action,
							deduplicated: false,
							result: null,
							error: availability.reason ?? "This action is not available for the task's current state.",
						};
					}
					switch (body.action) {
						case "retry_phase":
						case "resume_repair": {
							// A failed/paused receipt drives the resume from the last
							// successful stage; otherwise the retry is for a broken
							// review, which retries the review pass.
							if (isDeliveryResumable(core.delivery.receipt?.status ?? null)) {
								const response = await runtimeApi.startTaskDelivery(workspaceScope, {
									taskId: body.taskId,
								});
								return {
									ok: response.ok,
									action: body.action,
									deduplicated: false,
									result: { kind: "delivery" as const, response },
									error: response.ok ? null : (response.error ?? "Delivery retry failed."),
								};
							}
							if (core.taskPrompt) {
								const response = await runtimeApi.startTaskReview(workspaceScope, {
									taskId: body.taskId,
									description: core.taskPrompt,
								});
								return {
									ok: response.ok,
									action: body.action,
									deduplicated: false,
									result: { kind: "review" as const, response },
									error: response.ok ? null : (response.error ?? "Review retry failed."),
								};
							}
							return {
								ok: false,
								action: body.action,
								deduplicated: false,
								result: null,
								error: "No delivery receipt or task prompt to retry; start the task session first.",
							};
						}
						case "cancel": {
							const response = await runtimeApi.stopTaskSession(workspaceScope, { taskId: body.taskId });
							return {
								ok: response.ok,
								action: body.action,
								deduplicated: false,
								result: { kind: "cancel" as const, response },
								error: response.ok ? null : (response.error ?? "Session cancel failed."),
							};
						}
						case "recover_workspace": {
							const response = await recoverTaskWorktree({
								repoPath: workspaceScope.workspacePath,
								taskId: body.taskId,
							});
							return {
								ok: response.ok,
								action: body.action,
								deduplicated: false,
								result: { kind: "recover_workspace" as const, response },
								error: response.ok ? null : (response.error ?? "Workspace recovery failed."),
							};
						}
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						ok: false,
						action: body.action,
						deduplicated: false,
						result: null,
						error: message,
					};
				} finally {
					taskDiagnosticsActionInFlight.delete(dedupKey);
				}
			})();
			taskDiagnosticsActionInFlight.set(dedupKey, run);
			return await run;
		},
		// B-10.7: write the redacted diagnostic bundle for a task to
		// ~/.cline/kanban/diagnostics/ (never into the workspace itself).
		exportTaskDiagnostics: async (workspaceScope, input) => {
			try {
				const body = parseDiagnosticsExportRequest(input);
				const snapshot = await gatherTaskDiagnosticsSnapshot(workspaceScope, body.taskId);
				const diagnostics = await buildTaskDiagnosticsResponse(workspaceScope, snapshot);
				const { bundle, redactions } = buildTaskDiagnosticsExportBundle({
					diagnostics,
					transcriptMessageCount: snapshot.contextSnapshot?.messages.length ?? 0,
					homeDirectory: homedir(),
					exportedAt: new Date().toISOString(),
				});
				const safeTaskId = body.taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
				const bundlePath = join(getRuntimeHomePath(), "diagnostics", `task-${safeTaskId}-${Date.now()}.json`);
				await lockedFileSystem.writeTextFileAtomic(bundlePath, JSON.stringify(bundle, null, 2));
				return { ok: true, bundlePath, redactions, error: null };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, bundlePath: null, redactions: [], error: message };
			}
		},
		stopTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStopRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const clineSummary = await clineTaskSessionService.stopTaskSession(body.taskId);
				if (clineSummary) {
					// B-9.2: a freed worker slot may unblock the next ready task.
					runTaskDispatchAfterStateChange(workspaceScope);
					return {
						ok: true,
						summary: clineSummary,
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.stopTaskSession(body.taskId);
				if (summary) {
					runTaskDispatchAfterStateChange(workspaceScope);
				}
				return {
					ok: Boolean(summary),
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		sendTaskSessionInput: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionInputRequest(input);
				const payloadText = body.appendNewline ? `${body.text}\n` : body.text;
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const clineSummary = await clineTaskSessionService.sendTaskSessionInput(body.taskId, payloadText);
				if (clineSummary) {
					return {
						ok: true,
						summary: clineSummary,
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.writeInput(body.taskId, Buffer.from(payloadText, "utf8"));
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		getTaskChatMessages: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatMessagesRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = clineTaskSessionService.getSummary(body.taskId);
				const messages = await clineTaskSessionService.loadTaskSessionMessages(body.taskId);
				if (!summary && messages.length === 0) {
					return {
						ok: false,
						messages: [],
						error: "Task chat session is not available.",
					};
				}
				return {
					ok: true,
					messages,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					messages: [],
					error: message,
				};
			}
		},
		getClineSlashCommands: async (workspaceScope) => {
			if (!workspaceScope) {
				return {
					commands: [],
				};
			}
			const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
			return {
				commands: await clineTaskSessionService.listSlashCommands(workspaceScope.workspacePath),
			};
		},
		reloadTaskChatSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatReloadRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				let summary = await clineTaskSessionService.reloadTaskSession(body.taskId);
				if (!summary && isHomeAgentSessionId(body.taskId)) {
					const clineLaunchConfig = await clineProviderService.resolveLaunchConfig();
					summary = await clineTaskSessionService.startTaskSession({
						taskId: body.taskId,
						cwd: workspaceScope.workspacePath,
						prompt: "",
						resumeFromPersistence: true,
						providerId: clineLaunchConfig.providerId,
						modelId: clineLaunchConfig.modelId,
						apiKey: clineLaunchConfig.apiKey,
						baseUrl: clineLaunchConfig.baseUrl,
						reasoningEffort: clineLaunchConfig.reasoningEffort,
						contextWindowTokens: clineLaunchConfig.contextWindowTokens,
						contextWindowSource: clineLaunchConfig.contextWindowSource,
						compaction: buildClineCompactionConfig({ launchConfig: clineLaunchConfig }),
						compactionSafetyMarginTokens: clineLaunchConfig.compactionSettings?.safetyMarginTokens,
					});
				}
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not available.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		abortTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatAbortRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = await clineTaskSessionService.abortTaskSession(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		cancelTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatCancelRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = await clineTaskSessionService.cancelTaskTurn(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session turn is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		getClineProviderCatalog: async (_workspaceScope) => {
			return await clineProviderService.getProviderCatalog();
		},
		getClineAccountProfile: async (_workspaceScope) => {
			return await clineProviderService.getClineAccountProfile();
		},
		getClineKanbanAccess: async (_workspaceScope) => {
			return await clineProviderService.getClineKanbanAccess();
		},
		getFeaturebaseToken: async (_workspaceScope) => {
			return await clineProviderService.getFeaturebaseToken();
		},
		getClineAccountBalance: async (_workspaceScope) => {
			return await clineProviderService.getClineAccountBalance();
		},
		getClineAccountOrganizations: async (_workspaceScope) => {
			return await clineProviderService.getClineAccountOrganizations();
		},
		switchClineAccount: async (_workspaceScope, input) => {
			const body = parseClineAccountSwitchRequest(input);
			return await clineProviderService.switchClineAccount(body.organizationId);
		},
		getClineProviderModels: async (_workspaceScope, input) => {
			const body = parseClineProviderModelsRequest(input);
			return await clineProviderService.getProviderModels(body.providerId);
		},
		getClineMcpAuthStatuses: async (_workspaceScope) => {
			const statuses = await clineMcpRuntimeService.getAuthStatuses();
			return {
				statuses,
			};
		},
		runClineMcpServerOAuth: async (_workspaceScope, input) => {
			const body = parseClineMcpOAuthRequest(input);
			const response = await clineMcpRuntimeService.authorizeServer({
				serverName: body.serverName,
				onAuthorizationUrl: (url: string) => {
					openInBrowser(url);
				},
			});
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		getClineMcpSettings: async (_workspaceScope) => {
			return clineMcpSettingsService.loadSettings();
		},
		saveClineMcpSettings: async (_workspaceScope, input) => {
			const body = parseClineMcpSettingsSaveRequest(input);
			const response = await clineMcpSettingsService.saveSettings(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		runClineProviderOAuthLogin: async (_workspaceScope, input) => {
			const body = parseClineOauthLoginRequest(input);
			const response = await clineProviderService.runOauthLogin({
				providerId: body.provider,
				baseUrl: body.baseUrl,
			});
			if (response.ok) {
				deps.bumpClineSessionContextVersion?.();
			}
			return response;
		},
		startClineDeviceAuth: async () => {
			return await clineProviderService.startDeviceAuth();
		},
		completeClineDeviceAuth: async (_workspaceScope, input) => {
			const body = parseClineDeviceAuthCompleteRequest(input);
			const response = await clineProviderService.completeDeviceAuth({
				deviceCode: body.deviceCode,
				expiresInSeconds: body.expiresInSeconds,
				pollIntervalSeconds: body.pollIntervalSeconds,
				baseUrl: body.baseUrl,
			});
			if (response.ok) {
				deps.bumpClineSessionContextVersion?.();
			}
			return response;
		},
		sendTaskChatMessage: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatSendRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				if (isClineClearSlashCommand(body.text)) {
					const summary = await clineTaskSessionService.clearTaskSession(body.taskId);
					deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
					return {
						ok: true,
						summary,
						message: null,
					};
				}
				const requestedMode = body.mode;
				let summary = await clineTaskSessionService.sendTaskSessionInput(
					body.taskId,
					body.text,
					requestedMode,
					body.images,
				);
				if (!summary) {
					if (!isHomeAgentSessionId(body.taskId)) {
						const reboundSummary = await clineTaskSessionService.rebindPersistedTaskSession(body.taskId);
						if (reboundSummary) {
							summary = await clineTaskSessionService.sendTaskSessionInput(
								body.taskId,
								body.text,
								requestedMode,
								body.images,
							);
						}
						if (!summary) {
							return {
								ok: false,
								summary: null,
								error: "Task chat session is not running.",
							};
						}
					} else {
						const clineLaunchConfig = await clineProviderService.resolveLaunchConfig();
						summary = await clineTaskSessionService.startTaskSession({
							taskId: body.taskId,
							cwd: workspaceScope.workspacePath,
							prompt: body.text,
							images: body.images,
							resumeFromPersistence: true,
							providerId: clineLaunchConfig.providerId,
							modelId: clineLaunchConfig.modelId,
							mode: requestedMode,
							apiKey: clineLaunchConfig.apiKey,
							baseUrl: clineLaunchConfig.baseUrl,
							reasoningEffort: clineLaunchConfig.reasoningEffort,
							contextWindowTokens: clineLaunchConfig.contextWindowTokens,
							contextWindowSource: clineLaunchConfig.contextWindowSource,
							compaction: buildClineCompactionConfig({ launchConfig: clineLaunchConfig }),
							compactionSafetyMarginTokens: clineLaunchConfig.compactionSettings?.safetyMarginTokens,
						});
					}
				}
				const latestMessage = clineTaskSessionService.listMessages(body.taskId).at(-1) ?? null;
				return {
					ok: true,
					summary,
					message: latestMessage,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		startShellSession: async (workspaceScope, input) => {
			try {
				const body = parseShellSessionStartRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const shell = deps.resolveInteractiveShellCommand();
				const shellCwd = body.workspaceTaskId
					? await resolveTaskCwd({
							cwd: workspaceScope.workspacePath,
							taskId: body.workspaceTaskId,
							baseRef: body.baseRef,
							ensure: true,
						})
					: workspaceScope.workspacePath;
				const summary = await terminalManager.startShellSession({
					taskId: body.taskId,
					cwd: shellCwd,
					cols: body.cols,
					rows: body.rows,
					binary: shell.binary,
					args: shell.args,
				});
				return {
					ok: true,
					summary,
					shellBinary: shell.binary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					shellBinary: null,
					error: message,
				};
			}
		},
		runCommand: async (workspaceScope, input) => {
			try {
				const body = parseCommandRunRequest(input);
				return await deps.runCommand(body.command, workspaceScope.workspacePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message,
				});
			}
		},
		resetAllState: async (_workspaceScope) => {
			await deps.prepareForStateReset?.();
			await Promise.all(
				debugResetTargetPaths.map(async (path) => {
					await rm(path, { recursive: true, force: true });
				}),
			);
			return {
				ok: true,
				clearedPaths: [...debugResetTargetPaths],
			};
		},
		openFile: async (input) => {
			const filePath = input.filePath.trim();
			if (!filePath) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "File path cannot be empty.",
				});
			}
			openInBrowser(filePath);
			return { ok: true };
		},
		getUpdateStatus: async () => {
			return deps.getUpdateStatus();
		},
		runUpdateNow: async () => {
			return await deps.runUpdateNow();
		},
	};
	return runtimeApi;
}
