// Owns the live SDK session host plus taskId to sessionId bindings.
// This is the runtime-facing layer for starting, looking up, resuming, and
// stopping native Cline sessions without exposing SDK details upstream.
import { stat } from "node:fs/promises";
import type { RuntimeClineReasoningEffort, RuntimeTaskImage, RuntimeTaskSessionMode } from "../core/api-contract";
import { createClineCompactionBeforeModelHook } from "./cline-compaction-before-model-hook";
import { type ClineCompactionObservedInfo, createClineCompactionCompactCallback } from "./cline-compaction-callback";
import type { ClineCompactionConfig } from "./cline-compaction-config";
import {
	buildClineCompactionConfig,
	CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT,
	calibrateClineCompactionConfig,
} from "./cline-compaction-config";
import type { ContextLimitSource } from "./cline-context-policy";
import { extractClineSessionId } from "./cline-event-adapter";
import { createClineInterruptedToolCallRepairHook } from "./cline-interrupted-tool-call-repair";
import {
	type ClineMcpRuntimeService,
	type ClineMcpToolBundle,
	createClineMcpRuntimeService,
} from "./cline-mcp-runtime-service";
import type { ResolvedClineLaunchConfig } from "./cline-provider-service";
import { createKanbanClineLogger } from "./cline-runtime-logger";
import { buildSessionIdPrefix, createSessionId } from "./cline-session-state";
import {
	buildPersistedTaskLaunchConfig,
	mergeTaskLaunchConfigIntoMetadata,
	readPersistedTaskLaunchConfig,
	TASK_LAUNCH_CONFIG_METADATA_KEY,
} from "./cline-task-launch-config";
import { createClineToolFailureRecoveryHooks } from "./cline-tool-failure-recovery";
import { createClineToolResultBoundingHook } from "./cline-tool-result-bounding-hook";
import { type ClineTurnScheduler, sharedClineTurnScheduler } from "./cline-turn-scheduler";
import { CLINE_MODEL_CATALOG_DEFAULTS, SDK_DEFAULT_MODEL_ID, SDK_DEFAULT_PROVIDER_ID } from "./sdk-provider-boundary";
import {
	CLINE_SDK_DEFAULT_CONTEXT_WINDOW_TOKENS,
	type ClineSdkAgentHooks,
	type ClineSdkPersistedMessage,
	type ClineSdkSessionHost,
	type ClineSdkSessionRecord,
	type ClineSdkStartSessionInput,
	type ClineSdkToolApprovalRequest,
	type ClineSdkToolApprovalResult,
	type ClineSdkUserInstructionService,
	createClineSdkSessionHost,
	getClineCorePackageVersion,
} from "./sdk-runtime-boundary";

export { CLINE_MODEL_CATALOG_DEFAULTS } from "./sdk-provider-boundary";

const DEFAULT_CLINE_MAX_CONSECUTIVE_MISTAKES = 6;

interface ClineSessionHostBoundary {
	start(input: ClineSdkStartSessionInput): Promise<{ sessionId: string; result?: unknown }>;
	send(input: Parameters<ClineSdkSessionHost["send"]>[0]): Promise<unknown>;
	stop(sessionId: string): Promise<void>;
	abort(sessionId: string): Promise<void>;
	delete(sessionId: string): Promise<boolean>;
	dispose(reason?: string): Promise<void>;
	get(sessionId: string): Promise<ClineSdkSessionRecord | undefined>;
	list(limit?: number): Promise<ClineSdkSessionRecord[]>;
	update?(
		sessionId: string,
		updates: {
			prompt?: string | null;
			metadata?: Record<string, unknown> | null;
			title?: string | null;
		},
	): Promise<{ updated: boolean }>;
	readMessages(sessionId: string): Promise<ClineSdkPersistedMessage[]>;
	subscribe(listener: (event: unknown) => void): () => void;
}

function toSdkUserImages(images?: RuntimeTaskImage[]): string[] | undefined {
	if (!images || images.length === 0) {
		return undefined;
	}
	const userImages = images
		.map((image) => {
			const mimeType = image.mimeType.trim();
			const data = image.data.trim();
			if (!mimeType || !data) {
				return null;
			}
			return `data:${mimeType};base64,${data}`;
		})
		.filter((image): image is string => image !== null);
	return userImages.length > 0 ? userImages : undefined;
}

/**
 * Resolves the host (host:port) of a configured provider base URL for
 * diagnostics. Never returns a full URL, path, or credentials.
 */
function resolveSessionStartLogHost(baseUrl?: string | null): string | null {
	const normalized = baseUrl?.trim();
	if (!normalized) {
		return null;
	}
	try {
		return new URL(normalized).host;
	} catch {
		// Malformed URLs are skipped rather than logged verbatim, since they
		// may embed credentials.
		return null;
	}
}

export interface StartClineSessionRuntimeRequest {
	taskId: string;
	cwd: string;
	prompt: string;
	/** Normalized Kanban task title; persisted to SDK session metadata when supported. */
	taskTitle?: string;
	initialMessages?: ClineSdkPersistedMessage[];
	images?: RuntimeTaskImage[];
	providerId: string;
	modelId: string;
	mode?: RuntimeTaskSessionMode;
	apiKey?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeClineReasoningEffort | null;
	systemPrompt: string;
	userInstructionService?: ClineSdkUserInstructionService;
	requestToolApproval?: (request: ClineSdkToolApprovalRequest) => Promise<ClineSdkToolApprovalResult>;
	/** B-2.2: resolved effective context limit (tokens) for the session-start diagnostic. */
	contextWindowTokens?: number;
	/** Which tier supplied the resolved effective context limit. */
	contextWindowSource?: ContextLimitSource;
	/** B-2.4: explicit SDK compaction config (window, threshold, reserve, local summarizer). */
	compaction?: ClineCompactionConfig;
	/**
	 * B-2.9: user-set safety margin (tokens) from the global context budget.
	 * Wins over the computed margin in both the config calibration and the
	 * beforeModel compaction hook; absent falls back to the computed margin.
	 */
	compactionSafetyMarginTokens?: number;
}

export interface StartClineSessionRuntimeResult {
	sessionId: string;
	result: unknown;
	warnings?: string[];
}

export interface ClinePersistedTaskSessionSnapshot {
	record: ClineSdkSessionRecord;
	messages: ClineSdkPersistedMessage[];
}

export type ClineSessionRestartStartRequest = Omit<
	StartClineSessionRuntimeRequest,
	"prompt" | "images" | "initialMessages"
>;

export interface ClineSessionRuntime {
	startTaskSession(request: StartClineSessionRuntimeRequest): Promise<StartClineSessionRuntimeResult>;
	restartTaskSession(input: {
		taskId: string;
		prompt: string;
		initialMessages?: ClineSdkPersistedMessage[];
		images?: RuntimeTaskImage[];
		mode?: RuntimeTaskSessionMode;
		contextWindowCapTokens?: number;
	}): Promise<StartClineSessionRuntimeResult>;
	sendTaskSessionInput(
		taskId: string,
		prompt: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
		delivery?: "queue" | "steer",
	): Promise<unknown>;
	resumeTaskSession(taskId: string): Promise<ClinePersistedTaskSessionSnapshot | null>;
	cancelQueuedUnstartedTask(taskId: string): boolean;
	stopTaskSession(taskId: string): Promise<void>;
	abortTaskSession(taskId: string): Promise<void>;
	clearTaskSessions(taskId: string): Promise<void>;
	getTaskSessionId(taskId: string): string | null;
	getTaskProviderId(taskId: string): string | null;
	canRestartTaskSession(taskId: string): boolean;
	/**
	 * The start request a restart of this task would use: the in-memory one,
	 * or (after a process restart) the one reconstructed from the durable
	 * session record (B-4.8) with the live launch policy (B-2.8). Null when
	 * neither is available. Overflow recovery budgets against this (B-3).
	 */
	resolveRestartStartRequest(taskId: string): Promise<ClineSessionRestartStartRequest | null>;
	readPersistedTaskSession(taskId: string): Promise<ClinePersistedTaskSessionSnapshot | null>;
	dispose(): Promise<void>;
}

/**
 * B-2.8: re-resolves the launch config for a restart. The provider and model
 * are pinned to the saved start request so the conversation continues with
 * the same model; credentials, context limit, and compaction policy come
 * from the provider settings in force at restart time.
 */
export type ClineLaunchConfigResolver = (overrides: {
	providerIdOverride?: string;
	modelIdOverride?: string;
}) => Promise<ResolvedClineLaunchConfig>;

/**
 * B-4.8: live workspace services for a task whose start request is
 * reconstructed from durable session metadata after a process restart. The
 * runtime cannot construct these itself (they belong to the per-workspace
 * runtime setup owned by the task session service), so the service wires a
 * resolver here.
 */
export type ClineWorkspaceRuntimeResolver = (input: {
	taskId: string;
	cwd: string;
	/** Only legacy recovery needs to regenerate the missing prompt. */
	rebuildSystemPromptForProvider?: string;
}) => Promise<ClineRestoredWorkspaceRuntime | null> | ClineRestoredWorkspaceRuntime | null;

export interface ClineRestoredWorkspaceRuntime {
	systemPrompt?: string;
	userInstructionService?: ClineSdkUserInstructionService;
	requestToolApproval?: (request: ClineSdkToolApprovalRequest) => Promise<ClineSdkToolApprovalResult>;
}

export interface CreateInMemoryClineSessionRuntimeOptions {
	turnScheduler?: ClineTurnScheduler;
	onTaskEvent?: (taskId: string, event: unknown) => void;
	createSessionHost?: () => Promise<ClineSessionHostBoundary>;
	createMcpRuntimeService?: () => ClineMcpRuntimeService;
	/**
	 * B-2.8: on restart, re-resolve the launch config (credentials, context
	 * limit, compaction policy) instead of replaying the start-time snapshot.
	 * When omitted, restart replays the stored request unchanged.
	 */
	resolveClineLaunchConfig?: ClineLaunchConfigResolver;
	/**
	 * B-4.8: resolves live workspace services (rules, tool approval) when a
	 * start request is reconstructed from the durable session record after a
	 * process restart. When omitted, a restored session starts without the
	 * workspace user-instruction service and custom tool approval.
	 */
	resolveWorkspaceRuntime?: ClineWorkspaceRuntimeResolver;
	/**
	 * B-10.4: observer notified when a compaction actually changed a
	 * session's transcript (the hub `compact` callback or the local
	 * beforeModel hook). Never called for no-op compactions; a throwing
	 * observer cannot break the compaction pipeline.
	 */
	onCompactionObserved?: (taskId: string, info: ClineCompactionObservedInfo) => void;
}

// Own the SDK session host plus the taskId <-> sessionId bindings so higher layers can stay task-oriented.
export class InMemoryClineSessionRuntime implements ClineSessionRuntime {
	private readonly onTaskEvent: ((taskId: string, event: unknown) => void) | null;
	private readonly createSessionHost: () => Promise<ClineSessionHostBoundary>;
	private readonly clineMcpRuntimeService: ClineMcpRuntimeService;
	private readonly sessionIdByTaskId = new Map<string, string>();
	private readonly taskIdBySessionId = new Map<string, string>();
	private readonly lastStartRequestByTaskId = new Map<
		string,
		Omit<StartClineSessionRuntimeRequest, "prompt" | "images" | "initialMessages">
	>();
	private readonly mcpToolBundleByTaskId = new Map<string, ClineMcpToolBundle>();
	private readonly resolveClineLaunchConfig: ClineLaunchConfigResolver | null;
	private readonly resolveWorkspaceRuntime: ClineWorkspaceRuntimeResolver | null;
	private readonly onCompactionObserved: ((taskId: string, info: ClineCompactionObservedInfo) => void) | null;
	private sessionHostPromise: Promise<ClineSessionHostBoundary> | null = null;
	private readonly turnScheduler: ClineTurnScheduler;
	private readonly schedulerOwner = Symbol("cline-runtime");
	private readonly turnGenerationByTaskId = new Map<string, number>();
	private disposed = false;

	constructor(options: CreateInMemoryClineSessionRuntimeOptions = {}) {
		this.onTaskEvent = options.onTaskEvent ?? null;
		this.turnScheduler = options.turnScheduler ?? sharedClineTurnScheduler;
		this.createSessionHost = options.createSessionHost ?? createClineSdkSessionHost;
		this.resolveClineLaunchConfig = options.resolveClineLaunchConfig ?? null;
		this.resolveWorkspaceRuntime = options.resolveWorkspaceRuntime ?? null;
		this.onCompactionObserved = options.onCompactionObserved ?? null;
		const createMcpRuntimeService = options.createMcpRuntimeService ?? createClineMcpRuntimeService;
		this.clineMcpRuntimeService = createMcpRuntimeService();
	}

	async startTaskSession(request: StartClineSessionRuntimeRequest): Promise<StartClineSessionRuntimeResult> {
		if (this.disposed) throw new Error("Cline runtime disposed.");
		return this.turnScheduler.run(
			this.schedulerOwner,
			request.taskId,
			request,
			(signal) => this.startAdmittedTaskSession(request, signal),
			(queued, position) =>
				this.emitConcurrencyState(
					request.taskId,
					queued,
					position,
					!this.canRestartTaskSession(request.taskId) && !request.initialMessages?.length,
				),
			request.prompt.trim().length > 0 || Boolean(toSdkUserImages(request.images)?.length),
		);
	}

	private async startAdmittedTaskSession(
		request: StartClineSessionRuntimeRequest,
		signal: AbortSignal,
	): Promise<StartClineSessionRuntimeResult> {
		const requestedSessionId = createSessionId(request.taskId);
		const resolvedMode: RuntimeTaskSessionMode = request.mode ?? "act";
		this.lastStartRequestByTaskId.set(request.taskId, {
			taskId: request.taskId,
			cwd: request.cwd,
			providerId: request.providerId,
			modelId: request.modelId,
			mode: resolvedMode,
			apiKey: request.apiKey,
			baseUrl: request.baseUrl,
			reasoningEffort: request.reasoningEffort,
			systemPrompt: request.systemPrompt,
			taskTitle: request.taskTitle,
			userInstructionService: request.userInstructionService,
			requestToolApproval: request.requestToolApproval,
			contextWindowTokens: request.contextWindowTokens,
			contextWindowSource: request.contextWindowSource,
			compaction: request.compaction,
			compactionSafetyMarginTokens: request.compactionSafetyMarginTokens,
		});
		this.bindTaskSession(request.taskId, requestedSessionId);

		let mcpToolBundle: ClineMcpToolBundle | null = null;
		let startWarnings: string[] = [];
		try {
			mcpToolBundle = await this.clineMcpRuntimeService.createToolBundle();
			startWarnings = mcpToolBundle.warnings;
		} catch (error) {
			mcpToolBundle = null;
			const message = error instanceof Error ? error.message.trim() : String(error);
			if (message.length > 0) {
				startWarnings = [`Failed to load MCP tools: ${message}`];
			}
		}
		this.replaceTaskMcpToolBundle(request.taskId, mcpToolBundle);
		const hasMcpExtraTools = Boolean(mcpToolBundle && mcpToolBundle.tools.length > 0);

		if (signal.aborted) {
			this.clearTaskSessionBinding(request.taskId, requestedSessionId);
			await this.releaseTaskMcpToolBundle(request.taskId);
			signal.throwIfAborted();
		}
		const sessionHost = await this.ensureSessionHost();
		const userImages = toSdkUserImages(request.images);
		const shouldSendInitialTurn = request.prompt.trim().length > 0 || Boolean(userImages?.length);
		let startResult: Awaited<ReturnType<ClineSessionHostBoundary["start"]>>;
		const sessionLogger = createKanbanClineLogger({
			runtime: "kanban",
			taskId: request.taskId,
			requestedSessionId,
			providerId: request.providerId,
			modelId: request.modelId,
		});
		// B-2.1 diagnostic: record the effective model-context configuration for
		// every session start (restarts reuse this path). Gated behind
		// CLINE_LOG_ENABLED like the rest of the Cline runtime logs.
		// B-2.2: resolveLaunchConfig supplies the resolved limit + source;
		// callers without a resolver keep the unconfigured-SDK-default values.
		sessionLogger.log("Cline session start: effective context metadata", {
			baseUrlHost: resolveSessionStartLogHost(request.baseUrl),
			contextLimitTokens: request.contextWindowTokens ?? CLINE_SDK_DEFAULT_CONTEXT_WINDOW_TOKENS,
			contextLimitSource: request.contextWindowSource ?? "unconfigured-sdk-default",
			clineCoreVersion: getClineCorePackageVersion(),
		});
		// B-2.5: calibrate the compaction window against the assembled request.
		// The SDK trigger counts only conversation messages, so subtract the
		// estimated system-prompt and tool-schema overhead from the window and
		// fold the safety margin into the reserve (see cline-compaction-config
		// for the derivation). Runs here — not in the tRPC layer — because the
		// resolved system prompt and the MCP tool bundle only exist at this
		// point. The captured start request keeps the UNCALIBRATED config, so
		// restarts re-derive the same calibration instead of double-subtracting.
		// B-2.8: restarts first re-resolve the uncalibrated config from the
		// current launch config (resolveClineLaunchConfig) when a resolver is
		// wired in, then this calibration runs again on the fresh config.
		let effectiveCompaction = request.compaction;
		if (request.compaction) {
			const calibration = calibrateClineCompactionConfig({
				config: request.compaction,
				systemPrompt: request.systemPrompt,
				providerId: request.providerId,
				extraTools: hasMcpExtraTools ? (mcpToolBundle?.tools ?? []) : [],
				safetyMarginTokens: request.compactionSafetyMarginTokens,
			});
			effectiveCompaction = calibration.config;
			if (calibration.breakdown) {
				sessionLogger.log("Cline compaction calibrated for the assembled request (token values are estimates)", {
					limitTokens: calibration.breakdown.limitTokens,
					systemPromptTokens: calibration.breakdown.systemPromptTokens,
					toolSchemaTokens: calibration.breakdown.toolSchemaTokens,
					safetyMarginTokens: calibration.breakdown.safetyMarginTokens,
					calibratedWindowTokens: calibration.breakdown.contextWindowTokens,
					reserveTokens: calibration.breakdown.reserveTokens,
					triggerTokens: calibration.breakdown.triggerTokens,
				});
			}
		}
		// B-2.5: in @clinebot/core 0.0.38 local mode the SDK's own compaction
		// pipeline (the calibrated trigger above + the compact callback below)
		// is never executed — the agent config's prepareTurn is set but never
		// invoked by the agent runtime (upstream bug, see docs/plans/B-2-5.md).
		// The beforeModel hook is the local-mode guard: it evaluates the real
		// assembled request and rewrites its messages to stay within the same
		// calibrated budget. `hooks` is a local-only config key, so in hub
		// mode the compact capability takes over instead.
		// B-2.6/B-2.7: the afterTool hook bounds oversized tool results at
		// ingestion time (read-family char excerpts; command output / diff
		// line excerpts with the exit status kept in the head — see
		// cline-tool-result-bounding-hook.ts) and preserves the full content
		// as a local artifact. It complements the SDK's own 50k
		// request-assembly truncation, which is request-scoped only and
		// leaves the persisted transcript unbounded.
		// A tool call interrupted mid-execution leaves the transcript without
		// its result, and the AI SDK then rejects every later request. The
		// repair hook always runs first, so compaction sees a well-formed
		// history (see cline-interrupted-tool-call-repair.ts).
		const repairInterruptedToolCallsHook = createClineInterruptedToolCallRepairHook({ logger: sessionLogger });
		const recoveryHooks = createClineToolFailureRecoveryHooks();
		const compactionHook =
			request.compaction &&
			typeof request.compaction.contextWindowTokens === "number" &&
			request.compaction.contextWindowTokens > 0
				? createClineCompactionBeforeModelHook({
						limitTokens: request.compaction.contextWindowTokens,
						outputReserveTokens: request.compaction.reserveTokens ?? CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT,
						safetyMarginTokens: request.compactionSafetyMarginTokens,
						logger: sessionLogger,
						onCompacted: (info) => this.onCompactionObserved?.(request.taskId, info),
					})
				: undefined;
		const boundingHook =
			request.compaction &&
			typeof request.compaction.contextWindowTokens === "number" &&
			request.compaction.contextWindowTokens > 0
				? createClineToolResultBoundingHook({
						taskId: request.taskId,
						limitTokens: request.compaction.contextWindowTokens,
						logger: sessionLogger,
					})
				: undefined;
		const agentHooks: ClineSdkAgentHooks = {
			...recoveryHooks,
			beforeModel: async (context) => {
				const repaired = await repairInterruptedToolCallsHook(context);
				const recovered = await recoveryHooks.beforeModel?.({
					...context,
					request: { ...context.request, messages: repaired?.messages ?? context.request.messages },
				});
				const messages = recovered?.messages ?? repaired?.messages ?? context.request.messages;
				return (await compactionHook?.({ ...context, request: { ...context.request, messages } })) ?? { messages };
			},
			afterTool: async (context) => {
				const recovered = await recoveryHooks.afterTool?.(context);
				return (await boundingHook?.({ ...context, result: recovered?.result ?? context.result })) ?? recovered;
			},
		};
		try {
			signal.throwIfAborted();
			// Hub-backed SDK hosts create the interactive session in start; the first turn runs through send.
			startResult = await sessionHost.start({
				config: {
					sessionId: requestedSessionId,
					providerId: request.providerId,
					modelId: request.modelId,
					apiKey: request.apiKey?.trim() || undefined,
					baseUrl: request.baseUrl?.trim() || undefined,
					reasoningEffort:
						request.reasoningEffort === null
							? ("none" as ClineSdkStartSessionInput["config"]["reasoningEffort"])
							: (request.reasoningEffort ?? undefined),
					cwd: request.cwd,
					mode: resolvedMode,
					enableTools: true,
					enableSpawnAgent: false,
					enableAgentTeams: false,
					...(hasMcpExtraTools ? { disableMcpSettingsTools: true } : {}),
					execution: {
						maxConsecutiveMistakes: DEFAULT_CLINE_MAX_CONSECUTIVE_MISTAKES,
					},
					systemPrompt: request.systemPrompt,
					// B-2.4: explicit compaction config so the SDK uses the
					// resolved effective window, reserve, and the same local
					// summarizer instead of its built-in defaults. B-2.5: window
					// and reserve calibrated for the assembled request above.
					compaction: effectiveCompaction,
					// B-2.5: local-mode proactive compaction guard (see above).
					// B-2.6: ingestion-time tool-result bounding (see above).
					hooks: agentHooks,
				},
				// Local SDK mode creates its durable record on the first send,
				// so update() before that turn cannot persist recovery metadata.
				// Seed the live session as well as the eventual durable record.
				sessionMetadata: mergeTaskLaunchConfigIntoMetadata(
					request.taskTitle?.trim() ? { title: request.taskTitle.trim() } : undefined,
					buildPersistedTaskLaunchConfig({
						mode: resolvedMode,
						systemPrompt: request.systemPrompt,
						taskTitle: request.taskTitle,
						reasoningEffort: request.reasoningEffort,
					}),
				),
				initialMessages: request.initialMessages,
				interactive: true,
				localRuntime: {
					modelCatalogDefaults: CLINE_MODEL_CATALOG_DEFAULTS,
					...(request.userInstructionService ? { userInstructionService: request.userInstructionService } : {}),
					logger: sessionLogger,
					// B-2.5: deterministic, model-free compaction callback. It
					// completely replaces the SDK's built-in strategy (returning
					// undefined would mean NO compaction), and is registered as a
					// session capability so it also applies in hub mode.
					...(effectiveCompaction
						? {
								compaction: {
									// B-10.4: observe SDK-triggered (hub-mode)
									// compactions through the same observer as
									// the local-mode beforeModel hook.
									compact: createClineCompactionCompactCallback(sessionLogger, {
										onCompacted: (info) => this.onCompactionObserved?.(request.taskId, info),
									}),
								},
							}
						: {}),
					...(hasMcpExtraTools ? { extraTools: mcpToolBundle?.tools ?? [] } : {}),
				},
				...(request.requestToolApproval
					? { capabilities: { requestToolApproval: request.requestToolApproval } }
					: {}),
			});
		} catch (error) {
			this.clearTaskSessionBinding(request.taskId, requestedSessionId);
			await this.releaseTaskMcpToolBundle(request.taskId);
			throw error;
		}

		if (signal.aborted) {
			await sessionHost.abort(startResult.sessionId).catch(() => undefined);
			this.clearTaskSessionBinding(request.taskId, requestedSessionId);
			await this.releaseTaskMcpToolBundle(request.taskId);
			signal.throwIfAborted();
		}
		this.bindTaskSession(request.taskId, startResult.sessionId);
		if (startResult.sessionId !== requestedSessionId) {
			this.taskIdBySessionId.delete(requestedSessionId);
		}

		let result: unknown = startResult.result ?? null;
		if (shouldSendInitialTurn) {
			try {
				result = await sessionHost.send({
					sessionId: startResult.sessionId,
					prompt: request.prompt,
					userImages,
				});
			} catch (error) {
				this.clearTaskSessionBinding(request.taskId, startResult.sessionId);
				await this.releaseTaskMcpToolBundle(request.taskId);
				throw error;
			}
		}

		return {
			sessionId: startResult.sessionId,
			result,
			...(startWarnings.length > 0 ? { warnings: startWarnings } : {}),
		};
	}

	private cancelPendingTaskTurns(taskId: string): void {
		this.turnGenerationByTaskId.set(taskId, (this.turnGenerationByTaskId.get(taskId) ?? 0) + 1);
		this.turnScheduler.cancel(this.schedulerOwner, taskId);
	}

	private assertCurrentTurnGeneration(taskId: string, generation: number): void {
		if (this.disposed || generation !== (this.turnGenerationByTaskId.get(taskId) ?? 0)) {
			throw new Error("Cline turn canceled.");
		}
	}

	private emitConcurrencyState(
		taskId: string,
		queued: boolean,
		queuePosition?: number,
		canReturnToBacklog = false,
	): void {
		this.onTaskEvent?.(taskId, {
			type: "kanban_concurrency",
			queued,
			queuePosition,
			canReturnToBacklog: queued && canReturnToBacklog,
		});
	}

	async restartTaskSession(input: {
		taskId: string;
		prompt: string;
		initialMessages?: ClineSdkPersistedMessage[];
		images?: RuntimeTaskImage[];
		mode?: RuntimeTaskSessionMode;
		contextWindowCapTokens?: number;
	}): Promise<StartClineSessionRuntimeResult> {
		const generation = this.turnGenerationByTaskId.get(input.taskId) ?? 0;
		const restartRequest = await this.resolveRestartStartRequest(input.taskId);
		this.assertCurrentTurnGeneration(input.taskId, generation);
		if (!restartRequest) {
			throw new Error(`No previous Cline session config is available for task ${input.taskId}.`);
		}
		// A prior restart or stale binding may have left another SDK session
		// running for this task. Abort it before starting a replacement; keep
		// the persisted record for transcript recovery.
		await this.abortSupersededTaskSessions(input.taskId);
		this.assertCurrentTurnGeneration(input.taskId, generation);
		const cappedLimit =
			input.contextWindowCapTokens && restartRequest.compaction
				? Math.min(
						input.contextWindowCapTokens,
						restartRequest.compaction.contextWindowTokens ?? input.contextWindowCapTokens,
					)
				: null;
		return await this.startTaskSession({
			...restartRequest,
			...(cappedLimit !== null && restartRequest.compaction
				? {
						contextWindowTokens: cappedLimit,
						compaction: { ...restartRequest.compaction, contextWindowTokens: cappedLimit },
					}
				: {}),
			prompt: input.prompt,
			initialMessages: input.initialMessages,
			images: input.images,
			mode: input.mode ?? restartRequest.mode,
		});
	}

	async resolveRestartStartRequest(taskId: string): Promise<ClineSessionRestartStartRequest | null> {
		// B-4.8: after a Kanban process restart the in-memory start-request map
		// is empty; reconstruct the request from the durable session record
		// (persisted launch config plus provider/model/cwd).
		const lastStartRequest =
			this.lastStartRequestByTaskId.get(taskId) ?? (await this.restoreStartRequestFromPersistence(taskId));
		if (!lastStartRequest) {
			return null;
		}
		const launchPolicy = await this.resolveRestartedLaunchPolicy(lastStartRequest);
		return { ...lastStartRequest, ...launchPolicy };
	}

	/**
	 * B-2.8: restarts re-resolve the launch policy from the current provider
	 * settings instead of cache-and-replay of the start-time snapshot —
	 * credentials may have rotated (OAuth refresh) and the context limit +
	 * compaction config must reflect the settings in force at restart time.
	 * The provider and model stay pinned to the saved request so the
	 * conversation continues with the same model. Without a resolver the
	 * stored snapshot is replayed unchanged (unit tests, embedded hosts).
	 */
	private async resolveRestartedLaunchPolicy(
		lastStartRequest: Omit<StartClineSessionRuntimeRequest, "prompt" | "images" | "initialMessages">,
	): Promise<Partial<StartClineSessionRuntimeRequest>> {
		if (!this.resolveClineLaunchConfig) {
			return {};
		}
		const launchConfig = await this.resolveClineLaunchConfig({
			providerIdOverride: lastStartRequest.providerId,
			modelIdOverride: lastStartRequest.modelId ?? undefined,
		});
		return {
			providerId: launchConfig.providerId,
			modelId: launchConfig.modelId ?? lastStartRequest.modelId,
			apiKey: launchConfig.apiKey,
			baseUrl: launchConfig.baseUrl,
			reasoningEffort: launchConfig.reasoningEffort ?? lastStartRequest.reasoningEffort,
			contextWindowTokens: launchConfig.contextWindowTokens,
			contextWindowSource: launchConfig.contextWindowSource,
			compaction: buildClineCompactionConfig({ launchConfig }),
			compactionSafetyMarginTokens: launchConfig.compactionSettings?.safetyMarginTokens,
		};
	}

	/**
	 * B-4.8: reconstructs a start request for a task that has a persisted
	 * session record but no in-memory start request (i.e. the Kanban process
	 * restarted). Provider, model, and cwd come from the session record;
	 * mode, system prompt, task title, and reasoning effort come from the
	 * persisted launch config (mode/system prompt/task title carry the
	 * workspace rules baked in at start time); credentials and the
	 * context/compaction policy are re-resolved live by
	 * `resolveRestartedLaunchPolicy` (B-2.8) — secrets are never read back
	 * from the record. Workspace services (user instructions, tool approval)
	 * come from `resolveWorkspaceRuntime`, which the task session service
	 * wires to the per-workspace runtime setup. Legacy records without launch
	 * metadata rebuild workspace instructions
	 * using live services, but only with a usable original worktree, transcript,
	 * and pinned provider/model. Invalid metadata is never silently replaced.
	 */
	private async restoreStartRequestFromPersistence(
		taskId: string,
	): Promise<Omit<StartClineSessionRuntimeRequest, "prompt" | "images" | "initialMessages"> | null> {
		const sessionHost = await this.ensureSessionHost();
		const record = await this.findPersistedTaskSessionRecord(taskId, sessionHost);
		if (!record) {
			return null;
		}

		let launchConfig = readPersistedTaskLaunchConfig(record);
		const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
		if (!cwd) {
			throw new Error("Cline session recovery unavailable: the saved worktree path is missing.");
		}
		let workspaceRuntime: ClineRestoredWorkspaceRuntime | null;
		if (!launchConfig) {
			// Recover only the old missing-metadata defect, never malformed or
			// future configuration whose meaning this version does not know.
			if (record.metadata && TASK_LAUNCH_CONFIG_METADATA_KEY in record.metadata) {
				throw new Error(
					"Cline session recovery unavailable: the saved launch configuration is invalid or unsupported.",
				);
			}
			const provider = typeof record.provider === "string" ? record.provider.trim() : "";
			const model = typeof record.model === "string" ? record.model.trim() : "";
			if (!provider || !model || !this.resolveClineLaunchConfig || !this.resolveWorkspaceRuntime) {
				throw new Error(
					"Cline session recovery unavailable: the saved provider/model or live recovery services are missing.",
				);
			}
			const worktree = await stat(cwd).catch(() => null);
			if (!worktree?.isDirectory()) {
				throw new Error(
					"Cline session recovery unavailable: restore the original worktree directory before retrying.",
				);
			}
			const messages = await sessionHost.readMessages(record.sessionId);
			if (messages.length === 0) {
				throw new Error(
					"Cline session recovery unavailable: the saved conversation transcript is empty or missing.",
				);
			}
			workspaceRuntime = await this.resolveWorkspaceRuntime({
				taskId,
				cwd,
				rebuildSystemPromptForProvider: provider,
			});
			if (!workspaceRuntime?.systemPrompt?.trim()) {
				throw new Error("Cline session recovery unavailable: workspace instructions could not be rebuilt.");
			}
			launchConfig = buildPersistedTaskLaunchConfig({
				systemPrompt: workspaceRuntime.systemPrompt,
				taskTitle: typeof record.metadata?.title === "string" ? record.metadata.title : undefined,
			});
		} else {
			workspaceRuntime = (await this.resolveWorkspaceRuntime?.({ taskId, cwd })) ?? null;
		}

		return {
			taskId,
			cwd,
			providerId: (typeof record.provider === "string" ? record.provider.trim() : "") || SDK_DEFAULT_PROVIDER_ID,
			modelId: (typeof record.model === "string" ? record.model.trim() : "") || SDK_DEFAULT_MODEL_ID,
			mode: launchConfig.mode,
			reasoningEffort: launchConfig.reasoningEffort,
			systemPrompt: launchConfig.systemPrompt,
			...(launchConfig.taskTitle ? { taskTitle: launchConfig.taskTitle } : {}),
			...(workspaceRuntime?.userInstructionService
				? { userInstructionService: workspaceRuntime.userInstructionService }
				: {}),
			...(workspaceRuntime?.requestToolApproval
				? { requestToolApproval: workspaceRuntime.requestToolApproval }
				: {}),
		};
	}

	async sendTaskSessionInput(
		taskId: string,
		prompt: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
		delivery?: "queue" | "steer",
	): Promise<unknown> {
		const generation = this.turnGenerationByTaskId.get(taskId) ?? 0;
		const sessionId = this.sessionIdByTaskId.get(taskId);
		if (!sessionId) {
			throw new Error(`No active Cline session for task ${taskId}.`);
		}
		const sessionHost = await this.ensureSessionHost();
		if (mode) {
			this.updateActiveSessionMode(sessionHost, sessionId, mode);
			this.updateLastStartRequestMode(taskId, mode);
		}
		const target = this.lastStartRequestByTaskId.get(taskId);
		const record = target ? null : await this.findPersistedTaskSessionRecord(taskId, sessionHost);
		const persistedTarget = record
			? {
					providerId: record.provider || SDK_DEFAULT_PROVIDER_ID,
					modelId: record.model || SDK_DEFAULT_MODEL_ID,
				}
			: null;
		const resolvedTarget =
			persistedTarget && this.resolveClineLaunchConfig
				? await this.resolveClineLaunchConfig({
						providerIdOverride: persistedTarget.providerId,
						modelIdOverride: persistedTarget.modelId,
					})
				: persistedTarget;
		// Sending to a live resumed session needs capacity metadata, not a rebuilt system prompt.
		this.assertCurrentTurnGeneration(taskId, generation);
		const turnTarget = target ?? resolvedTarget;
		if (!turnTarget) throw new Error(`No Cline launch config is available for task ${taskId}.`);
		return this.turnScheduler.run(
			this.schedulerOwner,
			taskId,
			turnTarget,
			async (signal) => {
				signal.throwIfAborted();
				return sessionHost.send({
					sessionId,
					prompt,
					userImages: toSdkUserImages(images),
					...(delivery ? { delivery } : {}),
				});
			},
			(queued, position) => this.emitConcurrencyState(taskId, queued, position),
		);
	}

	async resumeTaskSession(taskId: string): Promise<ClinePersistedTaskSessionSnapshot | null> {
		const sessionHost = await this.ensureSessionHost();
		const record = await this.findPersistedTaskSessionRecord(taskId, sessionHost);
		if (!record) {
			return null;
		}
		this.bindTaskSession(taskId, record.sessionId);
		const messages = await sessionHost.readMessages(record.sessionId);
		return {
			record,
			messages,
		};
	}

	private async abortSupersededTaskSessions(taskId: string): Promise<void> {
		const sessionHost = await this.ensureSessionHost();
		const prefix = buildSessionIdPrefix(taskId);
		const records = await sessionHost.list();
		for (const record of records) {
			if (!record.sessionId.startsWith(prefix) || record.status !== "running") {
				continue;
			}
			try {
				await sessionHost.abort(record.sessionId);
			} catch (error) {
				// A durable record can outlive its live SDK session.
				if (!/^session not found(?::|$)/i.test(error instanceof Error ? error.message : String(error))) {
					throw error;
				}
			}
		}
	}

	cancelQueuedUnstartedTask(taskId: string): boolean {
		if (this.canRestartTaskSession(taskId) || this.getTaskSessionId(taskId)) return false;
		if (!this.turnScheduler.cancelQueued(this.schedulerOwner, taskId)) return false;
		this.turnGenerationByTaskId.set(taskId, (this.turnGenerationByTaskId.get(taskId) ?? 0) + 1);
		return true;
	}

	async stopTaskSession(taskId: string): Promise<void> {
		this.cancelPendingTaskTurns(taskId);
		const sessionId = this.sessionIdByTaskId.get(taskId);
		if (!sessionId) {
			try {
				await this.abortSupersededTaskSessions(taskId);
			} finally {
				await this.releaseTaskMcpToolBundle(taskId);
			}
			return;
		}
		const sessionHost = await this.ensureSessionHost();
		try {
			await sessionHost.stop(sessionId);
			this.clearTaskSessionBinding(taskId, sessionId);
		} catch (error) {
			const persistedRecord = await sessionHost.get(sessionId).catch(() => undefined);
			if (!persistedRecord) {
				this.clearTaskSessionBinding(taskId, sessionId);
			}
			throw error;
		} finally {
			try {
				await this.abortSupersededTaskSessions(taskId);
			} finally {
				await this.releaseTaskMcpToolBundle(taskId);
			}
		}
	}

	async abortTaskSession(taskId: string): Promise<void> {
		this.cancelPendingTaskTurns(taskId);
		const sessionId = this.sessionIdByTaskId.get(taskId);
		if (!sessionId) {
			try {
				await this.abortSupersededTaskSessions(taskId);
			} finally {
				await this.releaseTaskMcpToolBundle(taskId);
			}
			return;
		}
		const sessionHost = await this.ensureSessionHost();
		try {
			await sessionHost.abort(sessionId);
			this.clearTaskSessionBinding(taskId, sessionId);
		} catch (error) {
			const persistedRecord = await sessionHost.get(sessionId).catch(() => undefined);
			if (!persistedRecord) {
				this.clearTaskSessionBinding(taskId, sessionId);
			}
			throw error;
		} finally {
			try {
				await this.abortSupersededTaskSessions(taskId);
			} finally {
				await this.releaseTaskMcpToolBundle(taskId);
			}
		}
	}

	async clearTaskSessions(taskId: string): Promise<void> {
		this.cancelPendingTaskTurns(taskId);
		const sessionHost = await this.ensureSessionHost();
		const sessionIdPrefix = buildSessionIdPrefix(taskId);
		const records = await sessionHost.list();
		const matchingSessionIds = new Set(
			records.filter((record) => record.sessionId.startsWith(sessionIdPrefix)).map((record) => record.sessionId),
		);
		const activeSessionId = this.sessionIdByTaskId.get(taskId);
		if (activeSessionId) {
			matchingSessionIds.add(activeSessionId);
			await sessionHost.abort(activeSessionId).catch(() => undefined);
		}

		for (const sessionId of matchingSessionIds) {
			await sessionHost.delete(sessionId).catch(() => false);
			this.taskIdBySessionId.delete(sessionId);
		}
		this.clearTaskSessionBinding(taskId);
		await this.releaseTaskMcpToolBundle(taskId);
	}

	getTaskSessionId(taskId: string): string | null {
		return this.sessionIdByTaskId.get(taskId) ?? null;
	}

	getTaskProviderId(taskId: string): string | null {
		return this.lastStartRequestByTaskId.get(taskId)?.providerId ?? null;
	}

	canRestartTaskSession(taskId: string): boolean {
		return this.lastStartRequestByTaskId.has(taskId);
	}

	async readPersistedTaskSession(taskId: string): Promise<ClinePersistedTaskSessionSnapshot | null> {
		const sessionHost = await this.ensureSessionHost();
		const record = await this.findPersistedTaskSessionRecord(taskId, sessionHost);
		if (!record) {
			return null;
		}
		const messages = await sessionHost.readMessages(record.sessionId);
		return {
			record,
			messages,
		};
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.turnScheduler.cancel(this.schedulerOwner);
		const hostPromise = this.sessionHostPromise;
		this.sessionHostPromise = null;
		if (hostPromise) {
			try {
				const host = await hostPromise;
				await host.dispose("kanban-runtime-dispose");
			} catch {
				// Ignore host disposal errors.
			}
		}
		this.sessionIdByTaskId.clear();
		this.taskIdBySessionId.clear();
		this.lastStartRequestByTaskId.clear();

		const mcpBundles = [...this.mcpToolBundleByTaskId.values()];
		this.mcpToolBundleByTaskId.clear();
		await Promise.all(
			mcpBundles.map(async (bundle) => {
				await bundle.dispose().catch(() => undefined);
			}),
		);
	}

	private replaceTaskMcpToolBundle(taskId: string, bundle: ClineMcpToolBundle | null): void {
		const current = this.mcpToolBundleByTaskId.get(taskId);
		if (current) {
			void current.dispose().catch(() => undefined);
			this.mcpToolBundleByTaskId.delete(taskId);
		}
		if (bundle) {
			this.mcpToolBundleByTaskId.set(taskId, bundle);
		}
	}

	private async releaseTaskMcpToolBundle(taskId: string): Promise<void> {
		const current = this.mcpToolBundleByTaskId.get(taskId);
		if (!current) {
			return;
		}
		this.mcpToolBundleByTaskId.delete(taskId);
		await current.dispose().catch(() => undefined);
	}

	private bindTaskSession(taskId: string, sessionId: string): void {
		const previousSessionId = this.sessionIdByTaskId.get(taskId);
		if (previousSessionId) {
			this.taskIdBySessionId.delete(previousSessionId);
		}
		this.sessionIdByTaskId.set(taskId, sessionId);
		this.taskIdBySessionId.set(sessionId, taskId);
	}

	private clearTaskSessionBinding(taskId: string, sessionId?: string): void {
		const activeSessionId = this.sessionIdByTaskId.get(taskId);
		if (!activeSessionId) {
			return;
		}
		if (sessionId && activeSessionId !== sessionId) {
			return;
		}
		this.sessionIdByTaskId.delete(taskId);
		this.taskIdBySessionId.delete(activeSessionId);
	}

	private async findPersistedTaskSessionRecord(
		taskId: string,
		sessionHost: ClineSessionHostBoundary,
	): Promise<ClineSdkSessionRecord | null> {
		const activeSessionId = this.sessionIdByTaskId.get(taskId);
		if (activeSessionId) {
			const activeRecord = (await sessionHost.get(activeSessionId)) ?? null;
			if (activeRecord) {
				return activeRecord;
			}
		}

		const sessionIdPrefix = buildSessionIdPrefix(taskId);
		const records: ClineSdkSessionRecord[] = await sessionHost.list();
		const matchingRecord = records
			.filter((record: ClineSdkSessionRecord) => record.sessionId.startsWith(sessionIdPrefix))
			.sort((left: ClineSdkSessionRecord, right: ClineSdkSessionRecord) => {
				const leftTimestamp = Date.parse(left.updatedAt || left.startedAt);
				const rightTimestamp = Date.parse(right.updatedAt || right.startedAt);
				return rightTimestamp - leftTimestamp;
			})[0];
		return matchingRecord ?? null;
	}

	private async ensureSessionHost(): Promise<ClineSessionHostBoundary> {
		if (!this.sessionHostPromise) {
			this.sessionHostPromise = this.createSessionHost().then((sessionHost: ClineSessionHostBoundary) => {
				sessionHost.subscribe((event: unknown) => {
					this.handleSessionEvent(event);
				});
				return sessionHost;
			});
		}
		return await this.sessionHostPromise;
	}

	private updateActiveSessionMode(
		sessionHost: ClineSessionHostBoundary,
		sessionId: string,
		mode: RuntimeTaskSessionMode,
	): void {
		const hostWithSessions = sessionHost as unknown as {
			sessions?: Map<string, { config?: { mode?: RuntimeTaskSessionMode } }>;
		};
		const activeSession = hostWithSessions.sessions?.get(sessionId);
		if (activeSession?.config) {
			activeSession.config.mode = mode;
		}
	}

	private updateLastStartRequestMode(taskId: string, mode: RuntimeTaskSessionMode): void {
		const lastStartRequest = this.lastStartRequestByTaskId.get(taskId);
		if (!lastStartRequest) {
			return;
		}
		this.lastStartRequestByTaskId.set(taskId, {
			...lastStartRequest,
			mode,
		});
	}

	private handleSessionEvent(event: unknown): void {
		const sessionId = extractClineSessionId(event);
		if (!sessionId) {
			return;
		}
		const taskId = this.taskIdBySessionId.get(sessionId);
		if (!taskId) {
			return;
		}
		const eventRecord = event && typeof event === "object" ? (event as { type?: unknown }) : null;
		const ended = eventRecord?.type === "ended";
		if (this.onTaskEvent) {
			this.onTaskEvent(taskId, event);
		}
		if (ended) {
			this.clearTaskSessionBinding(taskId, sessionId);
			void this.releaseTaskMcpToolBundle(taskId);
		}
	}
}

export function createInMemoryClineSessionRuntime(
	options: CreateInMemoryClineSessionRuntimeOptions = {},
): ClineSessionRuntime {
	return new InMemoryClineSessionRuntime(options);
}
