// Owns the live SDK session host plus taskId to sessionId bindings.
// This is the runtime-facing layer for starting, looking up, resuming, and
// stopping native Cline sessions without exposing SDK details upstream.
import type { RuntimeClineReasoningEffort, RuntimeTaskImage, RuntimeTaskSessionMode } from "../core/api-contract";
import { createClineCompactionBeforeModelHook } from "./cline-compaction-before-model-hook";
import { createClineCompactionCompactCallback } from "./cline-compaction-callback";
import type { ClineCompactionConfig } from "./cline-compaction-config";
import {
	buildClineCompactionConfig,
	CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT,
	calibrateClineCompactionConfig,
} from "./cline-compaction-config";
import type { ContextLimitSource } from "./cline-context-policy";
import { extractClineSessionId } from "./cline-event-adapter";
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
} from "./cline-task-launch-config";
import { createClineToolResultBoundingHook } from "./cline-tool-result-bounding-hook";
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

export interface ClineSessionRuntime {
	startTaskSession(request: StartClineSessionRuntimeRequest): Promise<StartClineSessionRuntimeResult>;
	restartTaskSession(input: {
		taskId: string;
		prompt: string;
		initialMessages?: ClineSdkPersistedMessage[];
		images?: RuntimeTaskImage[];
		mode?: RuntimeTaskSessionMode;
	}): Promise<StartClineSessionRuntimeResult>;
	sendTaskSessionInput(
		taskId: string,
		prompt: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
		delivery?: "queue" | "steer",
	): Promise<unknown>;
	resumeTaskSession(taskId: string): Promise<ClinePersistedTaskSessionSnapshot | null>;
	stopTaskSession(taskId: string): Promise<void>;
	abortTaskSession(taskId: string): Promise<void>;
	clearTaskSessions(taskId: string): Promise<void>;
	getTaskSessionId(taskId: string): string | null;
	getTaskProviderId(taskId: string): string | null;
	canRestartTaskSession(taskId: string): boolean;
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
}) => Promise<ClineRestoredWorkspaceRuntime | null> | ClineRestoredWorkspaceRuntime | null;

export interface ClineRestoredWorkspaceRuntime {
	userInstructionService?: ClineSdkUserInstructionService;
	requestToolApproval?: (request: ClineSdkToolApprovalRequest) => Promise<ClineSdkToolApprovalResult>;
}

export interface CreateInMemoryClineSessionRuntimeOptions {
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
}

// Best-effort: write the Kanban task title to the SDK session metadata so external session
// lists (e.g. the Cline extension) show a human-readable name. Kanban never reads this back.
async function persistKanbanTitleToClineSessionMetadata(
	sessionHost: ClineSessionHostBoundary,
	sessionId: string,
	taskTitle: string | undefined,
): Promise<void> {
	const title = taskTitle?.trim();
	if (!title) return;
	try {
		await sessionHost.update?.(sessionId, { title });
	} catch {
		// Best-effort only — Kanban board title remains canonical regardless.
	}
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
	private sessionHostPromise: Promise<ClineSessionHostBoundary> | null = null;

	constructor(options: CreateInMemoryClineSessionRuntimeOptions = {}) {
		this.onTaskEvent = options.onTaskEvent ?? null;
		this.createSessionHost = options.createSessionHost ?? createClineSdkSessionHost;
		this.resolveClineLaunchConfig = options.resolveClineLaunchConfig ?? null;
		this.resolveWorkspaceRuntime = options.resolveWorkspaceRuntime ?? null;
		const createMcpRuntimeService = options.createMcpRuntimeService ?? createClineMcpRuntimeService;
		this.clineMcpRuntimeService = createMcpRuntimeService();
	}

	async startTaskSession(request: StartClineSessionRuntimeRequest): Promise<StartClineSessionRuntimeResult> {
		this.assertSingleActiveClineSession(request.taskId);
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
		let agentHooks: ClineSdkAgentHooks | undefined;
		if (
			request.compaction &&
			typeof request.compaction.contextWindowTokens === "number" &&
			request.compaction.contextWindowTokens > 0
		) {
			agentHooks = {
				beforeModel: createClineCompactionBeforeModelHook({
					limitTokens: request.compaction.contextWindowTokens,
					outputReserveTokens: request.compaction.reserveTokens ?? CLINE_COMPACTION_RESERVE_TOKENS_DEFAULT,
					safetyMarginTokens: request.compactionSafetyMarginTokens,
					logger: sessionLogger,
				}),
				afterTool: createClineToolResultBoundingHook({
					taskId: request.taskId,
					limitTokens: request.compaction.contextWindowTokens,
					logger: sessionLogger,
				}),
			};
		}
		try {
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
					...(agentHooks ? { hooks: agentHooks } : {}),
				},
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
						? { compaction: { compact: createClineCompactionCompactCallback(sessionLogger) } }
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

		this.bindTaskSession(request.taskId, startResult.sessionId);
		if (startResult.sessionId !== requestedSessionId) {
			this.taskIdBySessionId.delete(requestedSessionId);
		}

		// B-4.8: persist the credential-free launch configuration into the
		// SDK session record before the initial turn starts, so a process
		// crash cannot leave the task unrestorable after a Kanban restart.
		// The title write runs first and the launch-config write last because
		// SDK session updates replace `metadata` wholesale — the read-merge-
		// write in persistTaskLaunchConfig preserves both.
		await persistKanbanTitleToClineSessionMetadata(sessionHost, startResult.sessionId, request.taskTitle);
		await this.persistTaskLaunchConfig(sessionHost, startResult.sessionId, request);

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

	/**
	 * B-2.8 single-worker guard: at most one live Cline session per workspace
	 * runtime — the default target workflow runs a single model worker
	 * (typically a local model), and concurrent sessions would overload it.
	 * The check is race-free: startTaskSession binds the requested session
	 * synchronously before its first await, so overlapping starts for distinct
	 * tasks can never both pass. A blocked start runs before any state write,
	 * so it leaves no orphaned bindings or start-request snapshots.
	 * Same-task starts (replace / resume-from-trash) are unaffected. Queuing
	 * or parallel scheduling is B-11.
	 */
	private assertSingleActiveClineSession(requestTaskId: string): void {
		for (const [taskId] of this.sessionIdByTaskId) {
			if (taskId !== requestTaskId) {
				throw new Error(
					`Another Cline session is already active (task "${taskId}"). ` +
						`Cline sessions run one at a time by default: stop that session before starting this one.`,
				);
			}
		}
	}

	async restartTaskSession(input: {
		taskId: string;
		prompt: string;
		initialMessages?: ClineSdkPersistedMessage[];
		images?: RuntimeTaskImage[];
		mode?: RuntimeTaskSessionMode;
	}): Promise<StartClineSessionRuntimeResult> {
		let lastStartRequest:
			| Omit<StartClineSessionRuntimeRequest, "prompt" | "images" | "initialMessages">
			| null
			| undefined = this.lastStartRequestByTaskId.get(input.taskId);
		if (!lastStartRequest) {
			// B-4.8: after a Kanban process restart the in-memory start-request
			// map is empty; reconstruct the request from the durable session
			// record (persisted launch config plus provider/model/cwd).
			lastStartRequest = await this.restoreStartRequestFromPersistence(input.taskId);
			if (!lastStartRequest) {
				throw new Error(`No previous Cline session config is available for task ${input.taskId}.`);
			}
		}
		const launchPolicy = await this.resolveRestartedLaunchPolicy(lastStartRequest);

		return await this.startTaskSession({
			...lastStartRequest,
			...launchPolicy,
			prompt: input.prompt,
			initialMessages: input.initialMessages,
			images: input.images,
			mode: input.mode ?? lastStartRequest.mode,
		});
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
	 * B-4.8: best-effort persistence of the credential-free launch config
	 * into the SDK session record's metadata. Runs in startTaskSession before
	 * the initial turn is sent (and again on every restart, which reuses
	 * startTaskSession), so the latest session record always carries the
	 * configuration that a process restart needs to rebuild the start
	 * request. The SDK replaces `metadata` wholesale on update, so the
	 * record's existing metadata is read back and merged first (this
	 * preserves e.g. the Kanban title). A failed write degrades restart
	 * recovery to the in-memory-only behavior; the live session is unaffected.
	 */
	private async persistTaskLaunchConfig(
		sessionHost: ClineSessionHostBoundary,
		sessionId: string,
		request: StartClineSessionRuntimeRequest,
	): Promise<void> {
		if (!sessionHost.update) {
			return;
		}
		try {
			const launchConfig = buildPersistedTaskLaunchConfig({
				mode: request.mode,
				systemPrompt: request.systemPrompt,
				taskTitle: request.taskTitle,
				reasoningEffort: request.reasoningEffort,
			});
			const record = await sessionHost.get(sessionId);
			const metadata = mergeTaskLaunchConfigIntoMetadata(record?.metadata, launchConfig);
			await sessionHost.update(sessionId, { metadata });
		} catch {
			// Best-effort persistence; see the method docs.
		}
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
	 * wires to the per-workspace runtime setup. Returns null when the record
	 * has no usable launch config (pre-B-4 records) so the caller can
	 * surface the baseline error.
	 */
	private async restoreStartRequestFromPersistence(
		taskId: string,
	): Promise<Omit<StartClineSessionRuntimeRequest, "prompt" | "images" | "initialMessages"> | null> {
		const sessionHost = await this.ensureSessionHost();
		const record = await this.findPersistedTaskSessionRecord(taskId, sessionHost);
		if (!record) {
			return null;
		}
		const launchConfig = readPersistedTaskLaunchConfig(record);
		if (!launchConfig) {
			return null;
		}
		const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
		if (!cwd) {
			return null;
		}
		const workspaceRuntime = (await this.resolveWorkspaceRuntime?.({ taskId, cwd })) ?? null;
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
		const sessionId = this.sessionIdByTaskId.get(taskId);
		if (!sessionId) {
			throw new Error(`No active Cline session for task ${taskId}.`);
		}
		const sessionHost = await this.ensureSessionHost();
		if (mode) {
			this.updateActiveSessionMode(sessionHost, sessionId, mode);
			this.updateLastStartRequestMode(taskId, mode);
		}
		return await sessionHost.send({
			sessionId,
			prompt,
			userImages: toSdkUserImages(images),
			...(delivery ? { delivery } : {}),
		});
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

	async stopTaskSession(taskId: string): Promise<void> {
		const sessionId = this.sessionIdByTaskId.get(taskId);
		if (!sessionId) {
			await this.releaseTaskMcpToolBundle(taskId);
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
			await this.releaseTaskMcpToolBundle(taskId);
		}
	}

	async abortTaskSession(taskId: string): Promise<void> {
		const sessionId = this.sessionIdByTaskId.get(taskId);
		if (!sessionId) {
			await this.releaseTaskMcpToolBundle(taskId);
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
			await this.releaseTaskMcpToolBundle(taskId);
		}
	}

	async clearTaskSessions(taskId: string): Promise<void> {
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
