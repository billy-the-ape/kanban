import { z } from "zod";
import { resolveTaskTitle } from "./task-title.js";

export const runtimeWorkspaceFileStatusSchema = z.enum([
	"modified",
	"added",
	"deleted",
	"renamed",
	"copied",
	"untracked",
	"unknown",
]);
export type RuntimeWorkspaceFileStatus = z.infer<typeof runtimeWorkspaceFileStatusSchema>;

export const runtimeWorkspaceFileChangeSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: runtimeWorkspaceFileStatusSchema,
	additions: z.number(),
	deletions: z.number(),
	oldText: z.string().nullable(),
	newText: z.string().nullable(),
});
export type RuntimeWorkspaceFileChange = z.infer<typeof runtimeWorkspaceFileChangeSchema>;

export const runtimeWorkspaceChangesRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	mode: z.enum(["working_copy", "last_turn"]).optional(),
});
export type RuntimeWorkspaceChangesRequest = z.infer<typeof runtimeWorkspaceChangesRequestSchema>;

export const runtimeWorkspaceChangesModeSchema = z.enum(["working_copy", "last_turn"]);
export type RuntimeWorkspaceChangesMode = z.infer<typeof runtimeWorkspaceChangesModeSchema>;

export const runtimeWorkspaceChangesResponseSchema = z.object({
	repoRoot: z.string(),
	generatedAt: z.number(),
	files: z.array(runtimeWorkspaceFileChangeSchema),
});
export type RuntimeWorkspaceChangesResponse = z.infer<typeof runtimeWorkspaceChangesResponseSchema>;

export const runtimeWorkspaceFileSearchRequestSchema = z.object({
	query: z.string(),
	limit: z.number().int().positive().optional(),
});
export type RuntimeWorkspaceFileSearchRequest = z.infer<typeof runtimeWorkspaceFileSearchRequestSchema>;

export const runtimeWorkspaceFileSearchMatchSchema = z.object({
	path: z.string(),
	name: z.string(),
	changed: z.boolean(),
});
export type RuntimeWorkspaceFileSearchMatch = z.infer<typeof runtimeWorkspaceFileSearchMatchSchema>;

export const runtimeWorkspaceFileSearchResponseSchema = z.object({
	query: z.string(),
	files: z.array(runtimeWorkspaceFileSearchMatchSchema),
});
export type RuntimeWorkspaceFileSearchResponse = z.infer<typeof runtimeWorkspaceFileSearchResponseSchema>;

export const runtimeSlashCommandSchema = z.object({
	name: z.string(),
	instructions: z.string(),
	description: z.string().optional(),
});
export type RuntimeSlashCommand = z.infer<typeof runtimeSlashCommandSchema>;

export const runtimeSlashCommandsResponseSchema = z.object({
	commands: z.array(runtimeSlashCommandSchema),
});
export type RuntimeSlashCommandsResponse = z.infer<typeof runtimeSlashCommandsResponseSchema>;

export const runtimeAgentIdSchema = z.enum(["claude", "codex", "gemini", "opencode", "droid", "kiro", "cline"]);
export type RuntimeAgentId = z.infer<typeof runtimeAgentIdSchema>;

// Board columns are split into a distinct "done" column (completed work,
// workspace retained) and a "trash" column (discarded work, safety-gated
// cleanup). Legacy persisted boards that only have a "trash" column are
// migrated by workspace-state normalization (trash cards -> done).
const runtimeBoardColumnIdEnum = z.enum(["backlog", "in_progress", "review", "done", "trash"]);
export const runtimeBoardColumnIdSchema = runtimeBoardColumnIdEnum;
export type RuntimeBoardColumnId = z.infer<typeof runtimeBoardColumnIdEnum>;

const runtimeTaskAutoReviewModeEnum = z.enum(["commit", "pr"]);
export const runtimeTaskAutoReviewModeSchema = z.preprocess(
	(val) => (val === "move_to_trash" || val === "move_to_done" ? "commit" : val),
	runtimeTaskAutoReviewModeEnum,
);
export type RuntimeTaskAutoReviewMode = z.infer<typeof runtimeTaskAutoReviewModeEnum>;

export const runtimeClineReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type RuntimeClineReasoningEffort = z.infer<typeof runtimeClineReasoningEffortSchema>;
export const runtimeTaskClineSettingsSchema = z.object({
	providerId: z.string().optional(),
	modelId: z.string().optional(),
	reasoningEffort: runtimeClineReasoningEffortSchema.optional(),
});
export type RuntimeTaskClineSettings = z.infer<typeof runtimeTaskClineSettingsSchema>;
export const runtimeTaskImageSchema = z.object({
	id: z.string(),
	data: z.string(),
	mimeType: z.string(),
	name: z.string().optional(),
});
export type RuntimeTaskImage = z.infer<typeof runtimeTaskImageSchema>;

const runtimeLegacyTaskClineReasoningEffortSchema = z.enum(["default", "low", "medium", "high", "xhigh"]);

function normalizeRuntimeTaskClineSettings(input: {
	clineSettings?: RuntimeTaskClineSettings;
	clineProviderId?: string;
	clineModelId?: string;
	clineReasoningEffort?: z.infer<typeof runtimeLegacyTaskClineReasoningEffortSchema>;
}): RuntimeTaskClineSettings | undefined {
	if (input.clineSettings !== undefined) {
		return input.clineSettings;
	}
	const providerId = input.clineProviderId?.trim();
	const modelId = input.clineModelId?.trim();
	if (!providerId && !modelId && input.clineReasoningEffort === undefined) {
		return undefined;
	}
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(input.clineReasoningEffort && input.clineReasoningEffort !== "default"
			? { reasoningEffort: input.clineReasoningEffort }
			: {}),
	};
}

export const runtimeBoardCardSchema = z
	.object({
		id: z.string(),
		title: z.string().optional(),
		prompt: z.string(),
		startInPlanMode: z.boolean(),
		autoReviewEnabled: z.boolean().optional(),
		autoReviewMode: runtimeTaskAutoReviewModeSchema.optional(),
		images: z.array(runtimeTaskImageSchema).optional(),
		agentId: runtimeAgentIdSchema.optional(),
		clineSettings: runtimeTaskClineSettingsSchema.optional(),
		clineProviderId: z.string().optional(),
		clineModelId: z.string().optional(),
		clineReasoningEffort: runtimeLegacyTaskClineReasoningEffortSchema.optional(),
		baseRef: z.string(),
		createdAt: z.number(),
		updatedAt: z.number(),
	})
	.transform(
		({
			clineProviderId: _legacyProviderId,
			clineModelId: _legacyModelId,
			clineReasoningEffort: _legacyReasoningEffort,
			...card
		}) => {
			const clineSettings = normalizeRuntimeTaskClineSettings({
				clineSettings: card.clineSettings,
				clineProviderId: _legacyProviderId,
				clineModelId: _legacyModelId,
				clineReasoningEffort: _legacyReasoningEffort,
			});
			return {
				...card,
				...(clineSettings !== undefined ? { clineSettings } : {}),
				title: resolveTaskTitle(card.title, card.prompt),
			};
		},
	);
export type RuntimeBoardCard = z.infer<typeof runtimeBoardCardSchema>;

export const runtimeBoardColumnSchema = z.object({
	id: runtimeBoardColumnIdSchema,
	title: z.string(),
	cards: z.array(runtimeBoardCardSchema),
});
export type RuntimeBoardColumn = z.infer<typeof runtimeBoardColumnSchema>;

export const runtimeBoardDependencySchema = z.object({
	id: z.string(),
	fromTaskId: z.string(),
	toTaskId: z.string(),
	createdAt: z.number(),
});
export type RuntimeBoardDependency = z.infer<typeof runtimeBoardDependencySchema>;

export const runtimeBoardDataSchema = z.object({
	columns: z.array(runtimeBoardColumnSchema),
	dependencies: z.array(runtimeBoardDependencySchema).default([]),
});
export type RuntimeBoardData = z.infer<typeof runtimeBoardDataSchema>;

export const runtimeGitRepositoryInfoSchema = z.object({
	currentBranch: z.string().nullable(),
	defaultBranch: z.string().nullable(),
	branches: z.array(z.string()),
});
export type RuntimeGitRepositoryInfo = z.infer<typeof runtimeGitRepositoryInfoSchema>;

export const runtimeGitSyncActionSchema = z.enum(["fetch", "pull", "push"]);
export type RuntimeGitSyncAction = z.infer<typeof runtimeGitSyncActionSchema>;

export const runtimeGitSyncSummarySchema = z.object({
	currentBranch: z.string().nullable(),
	upstreamBranch: z.string().nullable(),
	changedFiles: z.number(),
	additions: z.number(),
	deletions: z.number(),
	aheadCount: z.number(),
	behindCount: z.number(),
});
export type RuntimeGitSyncSummary = z.infer<typeof runtimeGitSyncSummarySchema>;

export const runtimeGitSummaryResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	error: z.string().optional(),
});
export type RuntimeGitSummaryResponse = z.infer<typeof runtimeGitSummaryResponseSchema>;

export const runtimeGitSyncResponseSchema = z.object({
	ok: z.boolean(),
	action: runtimeGitSyncActionSchema,
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitSyncResponse = z.infer<typeof runtimeGitSyncResponseSchema>;

export const runtimeGitCheckoutRequestSchema = z.object({
	branch: z.string(),
});
export type RuntimeGitCheckoutRequest = z.infer<typeof runtimeGitCheckoutRequestSchema>;

export const runtimeGitCheckoutResponseSchema = z.object({
	ok: z.boolean(),
	branch: z.string(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitCheckoutResponse = z.infer<typeof runtimeGitCheckoutResponseSchema>;

export const runtimeGitDiscardResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitDiscardResponse = z.infer<typeof runtimeGitDiscardResponseSchema>;

export const runtimeTaskSessionStateSchema = z.enum(["idle", "running", "awaiting_review", "failed", "interrupted"]);
export type RuntimeTaskSessionState = z.infer<typeof runtimeTaskSessionStateSchema>;

export const runtimeTaskSessionModeSchema = z.enum(["act", "plan"]);
export type RuntimeTaskSessionMode = z.infer<typeof runtimeTaskSessionModeSchema>;

export const runtimeTaskSessionReviewReasonSchema = z
	.enum(["attention", "exit", "error", "interrupted", "hook"])
	.nullable();
export type RuntimeTaskSessionReviewReason = z.infer<typeof runtimeTaskSessionReviewReasonSchema>;

export const runtimeTaskHookActivitySchema = z.object({
	activityText: z.string().nullable().default(null),
	toolName: z.string().nullable().default(null),
	toolInputSummary: z.string().nullable().default(null),
	finalMessage: z.string().nullable().default(null),
	hookEventName: z.string().nullable().default(null),
	notificationType: z.string().nullable().default(null),
	source: z.string().nullable().default(null),
});
export type RuntimeTaskHookActivity = z.infer<typeof runtimeTaskHookActivitySchema>;

export const runtimeTaskTurnCheckpointSchema = z.object({
	turn: z.number().int().positive(),
	ref: z.string(),
	commit: z.string(),
	createdAt: z.number(),
});
export type RuntimeTaskTurnCheckpoint = z.infer<typeof runtimeTaskTurnCheckpointSchema>;

export const runtimeTaskSessionSummarySchema = z.object({
	taskId: z.string(),
	state: runtimeTaskSessionStateSchema,
	mode: runtimeTaskSessionModeSchema.nullable().optional(),
	agentId: runtimeAgentIdSchema.nullable(),
	workspacePath: z.string().nullable(),
	pid: z.number().nullable(),
	startedAt: z.number().nullable(),
	updatedAt: z.number(),
	lastOutputAt: z.number().nullable(),
	reviewReason: runtimeTaskSessionReviewReasonSchema,
	exitCode: z.number().nullable(),
	lastHookAt: z.number().nullable().default(null),
	latestHookActivity: runtimeTaskHookActivitySchema.nullable().default(null),
	warningMessage: z.string().nullable().optional(),
	latestTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
	previousTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
});
export type RuntimeTaskSessionSummary = z.infer<typeof runtimeTaskSessionSummarySchema>;

export const runtimeWorkspaceStateResponseSchema = z.object({
	repoPath: z.string(),
	statePath: z.string(),
	git: runtimeGitRepositoryInfoSchema,
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	revision: z.number(),
});
export type RuntimeWorkspaceStateResponse = z.infer<typeof runtimeWorkspaceStateResponseSchema>;

export const runtimeWorkspaceStateSaveRequestSchema = z.object({
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	expectedRevision: z.number().int().nonnegative().optional(),
});
export type RuntimeWorkspaceStateSaveRequest = z.infer<typeof runtimeWorkspaceStateSaveRequestSchema>;

export const runtimeWorkspaceStateConflictResponseSchema = z.object({
	error: z.string(),
	currentRevision: z.number(),
});
export type RuntimeWorkspaceStateConflictResponse = z.infer<typeof runtimeWorkspaceStateConflictResponseSchema>;

export const runtimeWorkspaceStateNotifyResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeWorkspaceStateNotifyResponse = z.infer<typeof runtimeWorkspaceStateNotifyResponseSchema>;

export const runtimeProjectTaskCountsSchema = z.object({
	backlog: z.number(),
	in_progress: z.number(),
	review: z.number(),
	done: z.number(),
	trash: z.number(),
});
export type RuntimeProjectTaskCounts = z.infer<typeof runtimeProjectTaskCountsSchema>;

export const runtimeProjectSummarySchema = z.object({
	id: z.string(),
	path: z.string(),
	name: z.string(),
	taskCounts: runtimeProjectTaskCountsSchema,
});
export type RuntimeProjectSummary = z.infer<typeof runtimeProjectSummarySchema>;

export const runtimeTaskWorkspaceMetadataSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
	changedFiles: z.number().nullable(),
	additions: z.number().nullable(),
	deletions: z.number().nullable(),
	stateVersion: z.number().int().nonnegative(),
});
export type RuntimeTaskWorkspaceMetadata = z.infer<typeof runtimeTaskWorkspaceMetadataSchema>;

export const runtimeWorkspaceMetadataSchema = z.object({
	homeGitSummary: runtimeGitSyncSummarySchema.nullable(),
	homeGitStateVersion: z.number().int().nonnegative(),
	taskWorkspaces: z.array(runtimeTaskWorkspaceMetadataSchema),
});
export type RuntimeWorkspaceMetadata = z.infer<typeof runtimeWorkspaceMetadataSchema>;

export const runtimeClineMcpServerAuthStatusSchema = z.object({
	serverName: z.string(),
	oauthSupported: z.boolean(),
	oauthConfigured: z.boolean(),
	lastError: z.string().nullable(),
	lastAuthenticatedAt: z.number().nullable(),
});
export type RuntimeClineMcpServerAuthStatus = z.infer<typeof runtimeClineMcpServerAuthStatusSchema>;

export const runtimeStateStreamSnapshotMessageSchema = z.object({
	type: z.literal("snapshot"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
	workspaceState: runtimeWorkspaceStateResponseSchema.nullable(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema.nullable(),
	clineSessionContextVersion: z.number().int().nonnegative(),
});
export type RuntimeStateStreamSnapshotMessage = z.infer<typeof runtimeStateStreamSnapshotMessageSchema>;

export const runtimeStateStreamWorkspaceStateMessageSchema = z.object({
	type: z.literal("workspace_state_updated"),
	workspaceId: z.string(),
	workspaceState: runtimeWorkspaceStateResponseSchema,
});
export type RuntimeStateStreamWorkspaceStateMessage = z.infer<typeof runtimeStateStreamWorkspaceStateMessageSchema>;

export const runtimeStateStreamTaskSessionsMessageSchema = z.object({
	type: z.literal("task_sessions_updated"),
	workspaceId: z.string(),
	summaries: z.array(runtimeTaskSessionSummarySchema),
});
export type RuntimeStateStreamTaskSessionsMessage = z.infer<typeof runtimeStateStreamTaskSessionsMessageSchema>;

export const runtimeStateStreamProjectsMessageSchema = z.object({
	type: z.literal("projects_updated"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeStateStreamProjectsMessage = z.infer<typeof runtimeStateStreamProjectsMessageSchema>;

export const runtimeStateStreamWorkspaceMetadataMessageSchema = z.object({
	type: z.literal("workspace_metadata_updated"),
	workspaceId: z.string(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema,
});
export type RuntimeStateStreamWorkspaceMetadataMessage = z.infer<
	typeof runtimeStateStreamWorkspaceMetadataMessageSchema
>;

export const runtimeStateStreamTaskReadyForReviewMessageSchema = z.object({
	type: z.literal("task_ready_for_review"),
	workspaceId: z.string(),
	taskId: z.string(),
	triggeredAt: z.number(),
});
export type RuntimeStateStreamTaskReadyForReviewMessage = z.infer<
	typeof runtimeStateStreamTaskReadyForReviewMessageSchema
>;

export const runtimeStateStreamTaskChatMessageSchema = z.object({
	type: z.literal("task_chat_message"),
	workspaceId: z.string(),
	taskId: z.string(),
	message: z.lazy(() => runtimeTaskChatMessageSchema),
});
export type RuntimeStateStreamTaskChatMessage = z.infer<typeof runtimeStateStreamTaskChatMessageSchema>;

export const runtimeStateStreamTaskChatClearedMessageSchema = z.object({
	type: z.literal("task_chat_cleared"),
	workspaceId: z.string(),
	taskId: z.string(),
});
export type RuntimeStateStreamTaskChatClearedMessage = z.infer<typeof runtimeStateStreamTaskChatClearedMessageSchema>;

export const runtimeStateStreamMcpAuthUpdatedMessageSchema = z.object({
	type: z.literal("mcp_auth_updated"),
	statuses: z.array(runtimeClineMcpServerAuthStatusSchema),
});
export type RuntimeStateStreamMcpAuthUpdatedMessage = z.infer<typeof runtimeStateStreamMcpAuthUpdatedMessageSchema>;

export const runtimeStateStreamClineSessionContextUpdatedMessageSchema = z.object({
	type: z.literal("cline_session_context_updated"),
	version: z.number().int().nonnegative(),
});
export type RuntimeStateStreamClineSessionContextUpdatedMessage = z.infer<
	typeof runtimeStateStreamClineSessionContextUpdatedMessageSchema
>;

export const runtimeStateStreamErrorMessageSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
});
export type RuntimeStateStreamErrorMessage = z.infer<typeof runtimeStateStreamErrorMessageSchema>;

export const runtimeStateStreamMessageSchema = z.discriminatedUnion("type", [
	runtimeStateStreamSnapshotMessageSchema,
	runtimeStateStreamWorkspaceStateMessageSchema,
	runtimeStateStreamTaskSessionsMessageSchema,
	runtimeStateStreamProjectsMessageSchema,
	runtimeStateStreamWorkspaceMetadataMessageSchema,
	runtimeStateStreamTaskReadyForReviewMessageSchema,
	runtimeStateStreamTaskChatMessageSchema,
	runtimeStateStreamTaskChatClearedMessageSchema,
	runtimeStateStreamMcpAuthUpdatedMessageSchema,
	runtimeStateStreamClineSessionContextUpdatedMessageSchema,
	runtimeStateStreamErrorMessageSchema,
]);
export type RuntimeStateStreamMessage = z.infer<typeof runtimeStateStreamMessageSchema>;

export const runtimeProjectsResponseSchema = z.object({
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeProjectsResponse = z.infer<typeof runtimeProjectsResponseSchema>;

export const runtimeProjectAddRequestSchema = z
	.object({
		path: z.string().optional(),
		gitUrl: z.string().optional(),
		initializeGit: z.boolean().optional(),
	})
	.refine((data) => data.path || data.gitUrl, { message: "Either path or gitUrl is required" });
export type RuntimeProjectAddRequest = z.infer<typeof runtimeProjectAddRequestSchema>;

export const runtimeProjectAddResponseSchema = z.object({
	ok: z.boolean(),
	project: runtimeProjectSummarySchema.nullable(),
	requiresGitInitialization: z.boolean().optional(),
	error: z.string().optional(),
});
export type RuntimeProjectAddResponse = z.infer<typeof runtimeProjectAddResponseSchema>;

export const runtimeProjectDirectoryPickerResponseSchema = z.object({
	ok: z.boolean(),
	path: z.string().nullable(),
	error: z.string().optional(),
});
export type RuntimeProjectDirectoryPickerResponse = z.infer<typeof runtimeProjectDirectoryPickerResponseSchema>;

export const runtimeDirectoryListEntrySchema = z.object({
	name: z.string(),
	path: z.string(),
	isGitRepository: z.boolean(),
});
export type RuntimeDirectoryListEntry = z.infer<typeof runtimeDirectoryListEntrySchema>;

export const runtimeDirectoryListRequestSchema = z.object({
	path: z.string().optional(),
});
export type RuntimeDirectoryListRequest = z.infer<typeof runtimeDirectoryListRequestSchema>;

export const runtimeDirectoryListResponseSchema = z.object({
	ok: z.boolean(),
	currentPath: z.string(),
	parentPath: z.string().nullable(),
	rootPath: z.string(),
	entries: z.array(runtimeDirectoryListEntrySchema),
	error: z.string().optional(),
});
export type RuntimeDirectoryListResponse = z.infer<typeof runtimeDirectoryListResponseSchema>;

export const runtimeProjectRemoveRequestSchema = z.object({
	projectId: z.string(),
});
export type RuntimeProjectRemoveRequest = z.infer<typeof runtimeProjectRemoveRequestSchema>;

export const runtimeProjectRemoveResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeProjectRemoveResponse = z.infer<typeof runtimeProjectRemoveResponseSchema>;

export const runtimeWorktreeEnsureRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
});
export type RuntimeWorktreeEnsureRequest = z.infer<typeof runtimeWorktreeEnsureRequestSchema>;

export const runtimeWorktreeEnsureResponseSchema = z.union([
	z.object({
		ok: z.literal(true),
		path: z.string(),
		baseRef: z.string(),
		baseCommit: z.string(),
		warning: z.string().optional(),
		error: z.string().optional(),
		restoredFromPreservation: z.boolean().default(false),
	}),
	z.object({
		ok: z.literal(false),
		path: z.null(),
		baseRef: z.string(),
		baseCommit: z.null(),
		error: z.string().optional(),
	}),
]);
export type RuntimeWorktreeEnsureResponse = z.infer<typeof runtimeWorktreeEnsureResponseSchema>;

export const runtimeWorktreeDeleteRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeWorktreeDeleteRequest = z.infer<typeof runtimeWorktreeDeleteRequestSchema>;

export const runtimeWorktreeDeleteResponseSchema = z.object({
	ok: z.boolean(),
	removed: z.boolean(),
	// Whether the task work was durably preserved (ref + patch + archive)
	// before the worktree was removed. When cleanup is blocked, removed is
	// false and the worktree is retained as-is.
	preserved: z.boolean().default(false),
	blockedReason: z.string().nullable().default(null),
	error: z.string().optional(),
});
export type RuntimeWorktreeDeleteResponse = z.infer<typeof runtimeWorktreeDeleteResponseSchema>;

export const runtimeTaskPreservationRecordSchema = z.object({
	taskId: z.string(),
	worktreePath: z.string(),
	repoPath: z.string(),
	// Commit the worktree was created from (the task's starting point).
	startingCommit: z.string().nullable().default(null),
	// Latest commit observed at the worktree HEAD during the last
	// preservation/reconciliation pass.
	latestCommit: z.string().nullable().default(null),
	status: z.enum(["active", "preserved", "blocked"]),
	blockedReasons: z.array(z.string()).default([]),
	patchPath: z.string().nullable().default(null),
	archivePath: z.string().nullable().default(null),
	// refs/kanban/tasks/<taskId> captured in the repository object store.
	refName: z.string().nullable().default(null),
	preservedAt: z.number().nullable().default(null),
	updatedAt: z.number(),
});
export type RuntimeTaskPreservationRecord = z.infer<typeof runtimeTaskPreservationRecordSchema>;

export const runtimeTaskPreservationRecordStoreSchema = z.record(z.string(), runtimeTaskPreservationRecordSchema);
export type RuntimeTaskPreservationRecordStore = z.infer<typeof runtimeTaskPreservationRecordStoreSchema>;

export const runtimeTaskPreservationRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskPreservationRequest = z.infer<typeof runtimeTaskPreservationRequestSchema>;

export const runtimeTaskPreservationInfoResponseSchema = z.object({
	ok: z.boolean(),
	worktreeExists: z.boolean(),
	worktreePath: z.string(),
	headCommit: z.string().nullable().default(null),
	dirty: z.boolean(),
	changedFiles: z.array(z.string()).default([]),
	commitsAheadOfBase: z.number().int().min(0).default(0),
	preservation: runtimeTaskPreservationRecordSchema.nullable().default(null),
	error: z.string().optional(),
});
export type RuntimeTaskPreservationInfoResponse = z.infer<typeof runtimeTaskPreservationInfoResponseSchema>;

export const runtimeTaskWorktreeRecoverResponseSchema = z.object({
	ok: z.boolean(),
	restored: z.boolean(),
	path: z.string().nullable(),
	headCommit: z.string().nullable().default(null),
	warning: z.string().optional(),
	error: z.string().optional(),
});
export type RuntimeTaskWorktreeRecoverResponse = z.infer<typeof runtimeTaskWorktreeRecoverResponseSchema>;

export const runtimeTaskWorkspaceInfoRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
});
export type RuntimeTaskWorkspaceInfoRequest = z.infer<typeof runtimeTaskWorkspaceInfoRequestSchema>;

export const runtimeTaskWorkspaceInfoResponseSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
});
export type RuntimeTaskWorkspaceInfoResponse = z.infer<typeof runtimeTaskWorkspaceInfoResponseSchema>;

export const runtimeProjectShortcutSchema = z.object({
	label: z.string(),
	command: z.string(),
	icon: z.string().optional(),
});
export type RuntimeProjectShortcut = z.infer<typeof runtimeProjectShortcutSchema>;

export const runtimeClineOauthProviderSchema = z.enum(["cline", "oca", "openai-codex"]);
export type RuntimeClineOauthProvider = z.infer<typeof runtimeClineOauthProviderSchema>;

export const runtimeClineProviderSettingsSchema = z.object({
	providerId: z.string().nullable(),
	modelId: z.string().nullable(),
	baseUrl: z.string().nullable(),
	reasoningEffort: runtimeClineReasoningEffortSchema.nullable().optional(),
	apiKeyConfigured: z.boolean(),
	oauthProvider: runtimeClineOauthProviderSchema.nullable(),
	oauthAccessTokenConfigured: z.boolean(),
	oauthRefreshTokenConfigured: z.boolean(),
	oauthAccountId: z.string().nullable(),
	oauthExpiresAt: z.number().int().positive().nullable(),
});
export type RuntimeClineProviderSettings = z.infer<typeof runtimeClineProviderSettingsSchema>;

export const runtimeClineAccountProfileSchema = z.object({
	accountId: z.string().nullable(),
	email: z.string().nullable(),
	displayName: z.string().nullable(),
});
export type RuntimeClineAccountProfile = z.infer<typeof runtimeClineAccountProfileSchema>;

export const runtimeClineAccountProfileResponseSchema = z.object({
	profile: runtimeClineAccountProfileSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeClineAccountProfileResponse = z.infer<typeof runtimeClineAccountProfileResponseSchema>;

export const runtimeClineKanbanAccessResponseSchema = z.object({
	enabled: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeClineKanbanAccessResponse = z.infer<typeof runtimeClineKanbanAccessResponseSchema>;

export const runtimeClineAccountOrganizationSchema = z.object({
	organizationId: z.string(),
	name: z.string(),
	active: z.boolean(),
	roles: z.array(z.string()),
});
export type RuntimeClineAccountOrganization = z.infer<typeof runtimeClineAccountOrganizationSchema>;

export const runtimeClineAccountOrganizationsResponseSchema = z.object({
	organizations: z.array(runtimeClineAccountOrganizationSchema),
	error: z.string().optional(),
});
export type RuntimeClineAccountOrganizationsResponse = z.infer<typeof runtimeClineAccountOrganizationsResponseSchema>;

export const runtimeClineAccountBalanceResponseSchema = z.object({
	balance: z.number().nullable(),
	activeAccountLabel: z.string().nullable(),
	activeOrganizationId: z.string().nullable(),
	error: z.string().optional(),
});
export type RuntimeClineAccountBalanceResponse = z.infer<typeof runtimeClineAccountBalanceResponseSchema>;

export const runtimeClineAccountSwitchRequestSchema = z.object({
	organizationId: z.string().nullable(),
});
export type RuntimeClineAccountSwitchRequest = z.infer<typeof runtimeClineAccountSwitchRequestSchema>;

export const runtimeClineAccountSwitchResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeClineAccountSwitchResponse = z.infer<typeof runtimeClineAccountSwitchResponseSchema>;

export const runtimeFeaturebaseTokenResponseSchema = z.object({
	featurebaseJwt: z.string(),
});
export type RuntimeFeaturebaseTokenResponse = z.infer<typeof runtimeFeaturebaseTokenResponseSchema>;

export const runtimeClineProviderCatalogItemSchema = z.object({
	id: z.string(),
	name: z.string(),
	oauthSupported: z.boolean(),
	enabled: z.boolean(),
	defaultModelId: z.string().nullable(),
	baseUrl: z.string().nullable(),
	supportsBaseUrl: z.boolean(),
	env: z.array(z.string()).optional(),
});
export type RuntimeClineProviderCatalogItem = z.infer<typeof runtimeClineProviderCatalogItemSchema>;

export const runtimeClineProviderCatalogResponseSchema = z.object({
	providers: z.array(runtimeClineProviderCatalogItemSchema),
});
export type RuntimeClineProviderCatalogResponse = z.infer<typeof runtimeClineProviderCatalogResponseSchema>;

export const runtimeClineProviderModelsRequestSchema = z.object({
	providerId: z.string(),
});
export type RuntimeClineProviderModelsRequest = z.infer<typeof runtimeClineProviderModelsRequestSchema>;

export const runtimeClineProviderModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	supportsVision: z.boolean().optional(),
	supportsAttachments: z.boolean().optional(),
	supportsReasoningEffort: z.boolean().optional(),
	// Optional context capacity in tokens, reported by the model's source
	// (SDK catalog or LiteLLM /model/info). Absent (undefined) and null both
	// mean "unknown" — never "unlimited".
	contextWindow: z.number().int().positive().nullable().optional(),
	// Optional max output tokens per model (SDK catalog ModelInfo.maxTokens
	// or LiteLLM /model/info max_output_tokens). B-2.4: feeds the SDK
	// compaction reserve. Same unknown semantics as contextWindow.
	maxTokens: z.number().int().positive().nullable().optional(),
});
export type RuntimeClineProviderModel = z.infer<typeof runtimeClineProviderModelSchema>;

export const runtimeClineProviderModelsResponseSchema = z.object({
	providerId: z.string(),
	models: z.array(runtimeClineProviderModelSchema),
});
export type RuntimeClineProviderModelsResponse = z.infer<typeof runtimeClineProviderModelsResponseSchema>;

export const runtimeClineProviderCapabilitySchema = z.enum([
	"streaming",
	"tools",
	"reasoning",
	"vision",
	"prompt-cache",
]);
export type RuntimeClineProviderCapability = z.infer<typeof runtimeClineProviderCapabilitySchema>;

export const runtimeClineAddProviderRequestSchema = z.object({
	providerId: z.string(),
	name: z.string(),
	baseUrl: z.string(),
	apiKey: z.string().nullable().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	timeoutMs: z.number().int().positive().optional(),
	models: z.array(z.string()),
	defaultModelId: z.string().nullable().optional(),
	modelsSourceUrl: z.string().nullable().optional(),
	capabilities: z.array(runtimeClineProviderCapabilitySchema).optional(),
});
export type RuntimeClineAddProviderRequest = z.infer<typeof runtimeClineAddProviderRequestSchema>;

export const runtimeClineAddProviderResponseSchema = runtimeClineProviderSettingsSchema;
export type RuntimeClineAddProviderResponse = z.infer<typeof runtimeClineAddProviderResponseSchema>;

export const runtimeClineUpdateProviderRequestSchema = z.object({
	providerId: z.string(),
	name: z.string().optional(),
	baseUrl: z.string().optional(),
	apiKey: z.string().nullable().optional(),
	headers: z.record(z.string(), z.string()).nullable().optional(),
	timeoutMs: z.number().int().positive().nullable().optional(),
	models: z.array(z.string()).optional(),
	defaultModelId: z.string().nullable().optional(),
	modelsSourceUrl: z.string().nullable().optional(),
	capabilities: z.array(runtimeClineProviderCapabilitySchema).optional(),
});
export type RuntimeClineUpdateProviderRequest = z.infer<typeof runtimeClineUpdateProviderRequestSchema>;

export const runtimeClineUpdateProviderResponseSchema = runtimeClineProviderSettingsSchema;
export type RuntimeClineUpdateProviderResponse = z.infer<typeof runtimeClineUpdateProviderResponseSchema>;

export const runtimeClineOauthLoginRequestSchema = z.object({
	provider: runtimeClineOauthProviderSchema,
	baseUrl: z.string().nullable().optional(),
});
export type RuntimeClineOauthLoginRequest = z.infer<typeof runtimeClineOauthLoginRequestSchema>;

export const runtimeClineOauthLoginResponseSchema = z.object({
	ok: z.boolean(),
	provider: runtimeClineOauthProviderSchema,
	settings: runtimeClineProviderSettingsSchema.optional(),
	error: z.string().optional(),
});
export type RuntimeClineOauthLoginResponse = z.infer<typeof runtimeClineOauthLoginResponseSchema>;

export const runtimeClineDeviceAuthStartResponseSchema = z.object({
	deviceCode: z.string(),
	userCode: z.string(),
	verificationUrl: z.string(),
	expiresInSeconds: z.number(),
	pollIntervalSeconds: z.number(),
});
export type RuntimeClineDeviceAuthStartResponse = z.infer<typeof runtimeClineDeviceAuthStartResponseSchema>;

export const runtimeClineDeviceAuthCompleteRequestSchema = z.object({
	deviceCode: z.string(),
	expiresInSeconds: z.number(),
	pollIntervalSeconds: z.number(),
	baseUrl: z.string().nullable().optional(),
});
export type RuntimeClineDeviceAuthCompleteRequest = z.infer<typeof runtimeClineDeviceAuthCompleteRequestSchema>;

export const runtimeClineDeviceAuthCompleteResponseSchema = runtimeClineOauthLoginResponseSchema;
export type RuntimeClineDeviceAuthCompleteResponse = z.infer<typeof runtimeClineDeviceAuthCompleteResponseSchema>;

export const runtimeClineProviderSettingsSaveRequestSchema = z.object({
	providerId: z.string(),
	modelId: z.string().nullable().optional(),
	apiKey: z.string().nullable().optional(),
	baseUrl: z.string().nullable().optional(),
	reasoningEffort: runtimeClineReasoningEffortSchema.nullable().optional(),
	region: z.string().nullable().optional(),
	aws: z
		.object({
			accessKey: z.string().nullable().optional(),
			secretKey: z.string().nullable().optional(),
			sessionToken: z.string().nullable().optional(),
			region: z.string().nullable().optional(),
			profile: z.string().nullable().optional(),
			authentication: z.enum(["iam", "api-key", "profile"]).nullable().optional(),
			endpoint: z.string().nullable().optional(),
		})
		.optional(),
	gcp: z
		.object({
			projectId: z.string().nullable().optional(),
			region: z.string().nullable().optional(),
		})
		.optional(),
});
export type RuntimeClineProviderSettingsSaveRequest = z.infer<typeof runtimeClineProviderSettingsSaveRequestSchema>;

export const runtimeClineProviderSettingsSaveResponseSchema = runtimeClineProviderSettingsSchema;
export type RuntimeClineProviderSettingsSaveResponse = z.infer<typeof runtimeClineProviderSettingsSaveResponseSchema>;

const runtimeClineMcpServerBaseSchema = z.object({
	name: z.string(),
	disabled: z.boolean(),
});

export const runtimeClineMcpServerSchema = z.discriminatedUnion("type", [
	runtimeClineMcpServerBaseSchema.extend({
		type: z.literal("stdio"),
		command: z.string(),
		args: z.array(z.string()).optional(),
		cwd: z.string().optional(),
		env: z.record(z.string(), z.string()).optional(),
	}),
	runtimeClineMcpServerBaseSchema.extend({
		type: z.literal("sse"),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
	runtimeClineMcpServerBaseSchema.extend({
		type: z.literal("streamableHttp"),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
]);
export type RuntimeClineMcpServer = z.infer<typeof runtimeClineMcpServerSchema>;

export const runtimeClineMcpSettingsResponseSchema = z.object({
	path: z.string(),
	servers: z.array(runtimeClineMcpServerSchema),
});
export type RuntimeClineMcpSettingsResponse = z.infer<typeof runtimeClineMcpSettingsResponseSchema>;

export const runtimeClineMcpSettingsSaveRequestSchema = z.object({
	servers: z.array(runtimeClineMcpServerSchema),
});
export type RuntimeClineMcpSettingsSaveRequest = z.infer<typeof runtimeClineMcpSettingsSaveRequestSchema>;

export const runtimeClineMcpSettingsSaveResponseSchema = runtimeClineMcpSettingsResponseSchema;
export type RuntimeClineMcpSettingsSaveResponse = z.infer<typeof runtimeClineMcpSettingsSaveResponseSchema>;

export const runtimeClineMcpAuthStatusResponseSchema = z.object({
	statuses: z.array(runtimeClineMcpServerAuthStatusSchema),
});
export type RuntimeClineMcpAuthStatusResponse = z.infer<typeof runtimeClineMcpAuthStatusResponseSchema>;

export const runtimeClineMcpOAuthRequestSchema = z.object({
	serverName: z.string(),
});
export type RuntimeClineMcpOAuthRequest = z.infer<typeof runtimeClineMcpOAuthRequestSchema>;

export const runtimeClineMcpOAuthResponseSchema = z.object({
	serverName: z.string(),
	authorized: z.literal(true),
	message: z.string(),
});
export type RuntimeClineMcpOAuthResponse = z.infer<typeof runtimeClineMcpOAuthResponseSchema>;

export const runtimeCommandRunRequestSchema = z.object({
	command: z.string(),
});
export type RuntimeCommandRunRequest = z.infer<typeof runtimeCommandRunRequestSchema>;

export const runtimeCommandRunResponseSchema = z.object({
	exitCode: z.number(),
	stdout: z.string(),
	stderr: z.string(),
	combinedOutput: z.string(),
	durationMs: z.number(),
});
export type RuntimeCommandRunResponse = z.infer<typeof runtimeCommandRunResponseSchema>;

export const runtimeOpenFileRequestSchema = z.object({
	filePath: z.string(),
});
export type RuntimeOpenFileRequest = z.infer<typeof runtimeOpenFileRequestSchema>;

export const runtimeOpenFileResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeOpenFileResponse = z.infer<typeof runtimeOpenFileResponseSchema>;

export const runtimeDebugResetAllStateResponseSchema = z.object({
	ok: z.boolean(),
	clearedPaths: z.array(z.string()),
});
export type RuntimeDebugResetAllStateResponse = z.infer<typeof runtimeDebugResetAllStateResponseSchema>;

export const runtimeUpdateStatusResponseSchema = z.object({
	currentVersion: z.string(),
	latestVersion: z.string().nullable(),
	updateAvailable: z.boolean(),
	updateTiming: z.enum(["startup", "shutdown"]).nullable(),
	installCommand: z.string().nullable(),
});
export type RuntimeUpdateStatusResponse = z.infer<typeof runtimeUpdateStatusResponseSchema>;

export const runtimeRunUpdateResponseSchema = z.object({
	status: z.enum([
		"updated",
		"already_up_to_date",
		"cache_refreshed",
		"unsupported_installation",
		"check_failed",
		"update_failed",
	]),
	currentVersion: z.string(),
	latestVersion: z.string().nullable(),
	message: z.string(),
});
export type RuntimeRunUpdateResponse = z.infer<typeof runtimeRunUpdateResponseSchema>;

export const runtimeAgentDefinitionSchema = z.object({
	id: runtimeAgentIdSchema,
	label: z.string(),
	binary: z.string(),
	command: z.string(),
	defaultArgs: z.array(z.string()),
	installed: z.boolean(),
	configured: z.boolean(),
});
export type RuntimeAgentDefinition = z.infer<typeof runtimeAgentDefinitionSchema>;

// B-2.9: user-facing context budget settings (global scope, stored in the
// global runtime config). All fields are optional — absent/null means "use
// the default" for that setting.
export const runtimeCompactionStrategySchema = z.enum(["basic", "agentic"]);
export type RuntimeCompactionStrategy = z.infer<typeof runtimeCompactionStrategySchema>;

export const runtimeContextBudgetSchema = z.object({
	contextWindowOverrideTokens: z.number().int().positive().optional(),
	compactionStrategy: runtimeCompactionStrategySchema.optional(),
	triggerThresholdRatio: z.number().gt(0).max(1).optional(),
	outputReserveTokens: z.number().int().positive().optional(),
	safetyMarginTokens: z.number().int().positive().optional(),
});
export type RuntimeContextBudget = z.infer<typeof runtimeContextBudgetSchema>;

const CONTEXT_WINDOW_OVERRIDE_TOKENS_ERROR = "contextWindowOverrideTokens must be a positive integer token count.";
const OUTPUT_RESERVE_TOKENS_ERROR = "outputReserveTokens must be a positive integer token count.";
const SAFETY_MARGIN_TOKENS_ERROR = "safetyMarginTokens must be a positive integer token count.";
const TRIGGER_THRESHOLD_RATIO_ERROR = "triggerThresholdRatio must be a number between 0 and 1 (exclusive of 0).";
const COMPACTION_STRATEGY_ERROR = "compactionStrategy must be either 'basic' or 'agentic'.";

/**
 * B-2.9: save variant of the context budget. `null` clears a field (resets
 * it to the default); `undefined` leaves the stored value untouched.
 */
export const runtimeContextBudgetSaveSchema = z.object({
	contextWindowOverrideTokens: z
		.number({ message: CONTEXT_WINDOW_OVERRIDE_TOKENS_ERROR })
		.int(CONTEXT_WINDOW_OVERRIDE_TOKENS_ERROR)
		.positive(CONTEXT_WINDOW_OVERRIDE_TOKENS_ERROR)
		.nullable()
		.optional(),
	compactionStrategy: z.enum(["basic", "agentic"], { message: COMPACTION_STRATEGY_ERROR }).nullable().optional(),
	triggerThresholdRatio: z
		.number({ message: TRIGGER_THRESHOLD_RATIO_ERROR })
		.gt(0, TRIGGER_THRESHOLD_RATIO_ERROR)
		.max(1, TRIGGER_THRESHOLD_RATIO_ERROR)
		.nullable()
		.optional(),
	outputReserveTokens: z
		.number({ message: OUTPUT_RESERVE_TOKENS_ERROR })
		.int(OUTPUT_RESERVE_TOKENS_ERROR)
		.positive(OUTPUT_RESERVE_TOKENS_ERROR)
		.nullable()
		.optional(),
	safetyMarginTokens: z
		.number({ message: SAFETY_MARGIN_TOKENS_ERROR })
		.int(SAFETY_MARGIN_TOKENS_ERROR)
		.positive(SAFETY_MARGIN_TOKENS_ERROR)
		.nullable()
		.optional(),
});
export type RuntimeContextBudgetSave = z.infer<typeof runtimeContextBudgetSaveSchema>;

/** B-2.9: which tier supplied the effective context window shown in settings. */
export const runtimeContextLimitSourceSchema = z.enum(["override", "provider-metadata", "fallback"]);
export type RuntimeContextLimitSource = z.infer<typeof runtimeContextLimitSourceSchema>;

/** B-2.9: the effective context window for the selected provider/model, including the user budget override. */
export const runtimeEffectiveContextWindowSchema = z.object({
	limitTokens: z.number().int().positive(),
	source: runtimeContextLimitSourceSchema,
});
export type RuntimeEffectiveContextWindow = z.infer<typeof runtimeEffectiveContextWindowSchema>;

/** B-6: review lifecycle policy — global settings for the review/repair phase. */
export const runtimeReviewPolicySchema = z.object({
	/** "required" gates delivery on a review; "off" leaves review opt-in. */
	enabled: z.enum(["required", "off"]),
	/** Free-form reviewer instructions injected into every review prompt. */
	instructions: z.string(),
	/** Explicit model override for review sessions; null means reuse the card's model. */
	modelOverride: z
		.object({
			providerId: z.string().min(1),
			modelId: z.string().min(1),
		})
		.nullable(),
	/** Bounded repair rounds a review session may apply before it must stop and report. */
	maxRepairRounds: z.number().int().min(1).max(10),
});
export type RuntimeReviewPolicy = z.infer<typeof runtimeReviewPolicySchema>;

export const runtimeReviewPolicySaveSchema = z.object({
	enabled: z.enum(["required", "off"]).optional(),
	instructions: z.string().optional(),
	modelOverride: z
		.object({
			providerId: z.string().min(1),
			modelId: z.string().min(1),
		})
		.nullable()
		.optional(),
	maxRepairRounds: z.number().int().min(1).max(10).optional(),
});
export type RuntimeReviewPolicySave = z.infer<typeof runtimeReviewPolicySaveSchema>;

// --- B-7: deterministic verification gate ------------------------------------

/** B-7.1: one operator-configured verification check (trusted executable config). */
export const runtimeVerificationCheckSchema = z.object({
	/** Stable identifier used in receipts and logs (unique within the config). */
	id: z.string().min(1),
	/** Executable invoked directly (never through a shell). */
	command: z.string().min(1),
	/** Arguments passed verbatim to the executable. */
	args: z.array(z.string()).default([]),
	/** Working directory relative to the task worktree root (defaults to the root). */
	cwd: z.string().min(1).optional(),
	/** Per-check timeout in milliseconds (the service default applies when omitted). */
	timeoutMs: z.number().int().positive().max(86_400_000).optional(),
	/** Explicit environment values handed to the check (on top of the minimal base env). */
	env: z.record(z.string(), z.string()).optional(),
	/** Exit codes that count as success — the only configured exit semantics. */
	successExitCodes: z.array(z.number().int().min(0).max(255)).min(1).default([0]),
	/** Required checks gate delivery; optional checks are informational only. */
	required: z.boolean().default(true),
});
export type RuntimeVerificationCheck = z.infer<typeof runtimeVerificationCheckSchema>;

/** B-7.1: the global verification gate config (trusted, operator-managed). */
export const runtimeVerificationConfigSchema = z.object({
	/** "required" gates delivery on the checks; "off" leaves the gate inactive. */
	enabled: z.enum(["required", "off"]),
	checks: z.array(runtimeVerificationCheckSchema),
});
export type RuntimeVerificationConfig = z.infer<typeof runtimeVerificationConfigSchema>;

/** B-7.1: partial save request for one check; provided entries replace the stored check. */
export const runtimeVerificationCheckSaveSchema = z.object({
	id: z.string().min(1),
	command: z.string().min(1),
	args: z.array(z.string()).optional(),
	cwd: z.string().min(1).optional(),
	timeoutMs: z.number().int().positive().max(86_400_000).optional(),
	env: z.record(z.string(), z.string()).optional(),
	successExitCodes: z.array(z.number().int().min(0).max(255)).min(1).optional(),
	required: z.boolean().optional(),
});
export type RuntimeVerificationCheckSave = z.infer<typeof runtimeVerificationCheckSaveSchema>;

/** Partial save request for the verification gate; `undefined` leaves it untouched. */
export const runtimeVerificationConfigSaveSchema = z.object({
	enabled: z.enum(["required", "off"]).optional(),
	checks: z.array(runtimeVerificationCheckSaveSchema).optional(),
});
export type RuntimeVerificationConfigSave = z.infer<typeof runtimeVerificationConfigSaveSchema>;

/** B-7.3: outcome of one verification check run (decided by exit semantics only). */
export const runtimeVerificationCheckResultSchema = z.object({
	id: z.string().min(1),
	command: z.string().min(1),
	args: z.array(z.string()),
	status: z.enum(["passed", "failed", "timeout", "missing_executable", "cancelled", "error"]),
	exitCode: z.number().int().nullable(),
	/** True when the check produced no stdout/stderr at all (never a pass by itself). */
	emptyOutput: z.boolean(),
	/** Bounded head excerpt of the combined stdout/stderr. */
	outputExcerpt: z.string(),
	/** Absolute path to the full log artifact (null when unavailable). */
	logPath: z.string().nullable(),
	startedAt: z.number().int(),
	finishedAt: z.number().int(),
	/** Operational error detail (spawn failure, bad cwd, cancellation, ...). */
	error: z.string().nullable(),
});
export type RuntimeVerificationCheckResult = z.infer<typeof runtimeVerificationCheckResultSchema>;

/** B-7.2/B-7.3/B-7.6: durable receipt binding the check results to an exact tree identity. */
export const runtimeVerificationReceiptSchema = z.object({
	/** Tree identity recorded before the checks ran. */
	treeHashBefore: z.string().nullable(),
	/** Tree identity recorded after the checks ran. */
	treeHashAfter: z.string().nullable(),
	/** True only when before === after (checks did not mutate the tree). */
	treeIdentityPreserved: z.boolean(),
	/** True only when the checks ran on the exact candidate that was reviewed. */
	matchesCandidate: z.boolean(),
	checks: z.array(runtimeVerificationCheckResultSchema),
	/** Delivery gate: all required checks passed and the tree identity is bound. */
	passed: z.boolean(),
	/** Non-empty when the gate failed for a configured or operational reason. */
	error: z.string().nullable(),
	startedAt: z.number().int(),
	finishedAt: z.number().int(),
});
export type RuntimeVerificationReceipt = z.infer<typeof runtimeVerificationReceiptSchema>;

// --- B-8: deterministic git delivery -----------------------------------------

/** B-8.4: how the task commit is integrated into the destination branch. */
export const runtimeGitDeliveryIntegrationStrategySchema = z.enum(["fast_forward", "merge"]);
export type RuntimeGitDeliveryIntegrationStrategy = z.infer<typeof runtimeGitDeliveryIntegrationStrategySchema>;

/**
 * B-8.3: global git delivery policy (trusted, operator-managed). When
 * `enabled`, commit/integrate/push/delivery are application-controlled and
 * independent of model availability (B-8.1..B-8.9).
 */
export const runtimeGitDeliveryPolicySchema = z.object({
	enabled: z.boolean(),
	/** Remote name used for the explicit-refspec push (B-8.6). */
	remote: z.string().min(1),
	/**
	 * Delivery destination branch. `null` means "the task's base ref" (the
	 * branch the task worktree was based on).
	 */
	destinationBranch: z.string().nullable(),
	/** True when delivery is incomplete until the remote contains the commit (B-8.6/B-8.7). */
	pushRequired: z.boolean(),
	/** B-8.3: branches that direct push/integration must never target. */
	protectedBranches: z.array(z.string()),
	integrationStrategy: runtimeGitDeliveryIntegrationStrategySchema,
	/** B-8.9: open (or reuse) a PR from the destination branch after delivery. */
	requirePullRequest: z.boolean(),
	/** B-8.9: PR base branch; `null` lets the forge use the repository default branch. */
	pullRequestBaseBranch: z.string().nullable(),
});
export type RuntimeGitDeliveryPolicy = z.infer<typeof runtimeGitDeliveryPolicySchema>;

/** Partial save request for git delivery; `undefined` leaves the stored policy untouched. */
export const runtimeGitDeliveryPolicySaveSchema = z.object({
	enabled: z.boolean().optional(),
	remote: z.string().optional(),
	destinationBranch: z.string().nullable().optional(),
	pushRequired: z.boolean().optional(),
	protectedBranches: z.array(z.string()).optional(),
	integrationStrategy: runtimeGitDeliveryIntegrationStrategySchema.optional(),
	requirePullRequest: z.boolean().optional(),
	pullRequestBaseBranch: z.string().nullable().optional(),
});
export type RuntimeGitDeliveryPolicySave = z.infer<typeof runtimeGitDeliveryPolicySaveSchema>;

// B-9: backend-owned sequential task dispatch ("reliable queue"). The backend
// decides which backlog task is ready (delivery-receipt based), resolves the
// base SHA, starts a fresh-context session, and records the dispatch durably.
export const runtimeTaskDeliveryStartRequestSchema = z.object({
	taskId: z.string(),
	/** Optional model-supplied commit message; sanitized to a subject/body (B-8.2). */
	commitMessage: z.string().max(5000).optional(),
});
export type RuntimeTaskDeliveryStartRequest = z.infer<typeof runtimeTaskDeliveryStartRequestSchema>;

export const runtimeTaskDeliveryInfoRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskDeliveryInfoRequest = z.infer<typeof runtimeTaskDeliveryInfoRequestSchema>;

/**
 * B-8.8: delivery status. `in_progress` is what a crash mid-pipeline leaves
 * behind; the next attempt resumes from the recorded stage.
 */
export const runtimeGitDeliveryStatusSchema = z.enum(["in_progress", "delivered", "no_op", "paused", "failed"]);
export type RuntimeGitDeliveryStatus = z.infer<typeof runtimeGitDeliveryStatusSchema>;

/** B-8.8: last pipeline stage completed successfully. */
export const runtimeGitDeliveryStageSchema = z.enum([
	"validated",
	"staged",
	"committed",
	"integrated",
	"pushed",
	"verified",
	"pr",
]);
export type RuntimeGitDeliveryStage = z.infer<typeof runtimeGitDeliveryStageSchema>;

// ── B-9: backend-owned sequential task dispatch ("reliable queue") ──────────

export const runtimeTaskDispatchPolicySchema = z.object({
	/** False: the browser keeps its legacy local auto-start behavior. */
	enabled: z.boolean(),
	/** Max concurrent dispatched model workers per workspace (default 1). */
	workerLimit: z.number().int().min(1).max(4),
});
export type RuntimeTaskDispatchPolicy = z.infer<typeof runtimeTaskDispatchPolicySchema>;

export const runtimeTaskDispatchPolicySaveSchema = z.object({
	enabled: z.boolean().optional(),
	workerLimit: z.number().int().min(1).max(4).optional(),
});
export type RuntimeTaskDispatchPolicySave = z.infer<typeof runtimeTaskDispatchPolicySaveSchema>;

export const runtimeTaskDispatchStatusSchema = z.enum(["dispatching", "dispatched", "failed", "blocked", "exhausted"]);
export type RuntimeTaskDispatchStatus = z.infer<typeof runtimeTaskDispatchStatusSchema>;

export const runtimeTaskDispatchPrerequisiteSchema = z.object({
	taskId: z.string(),
	/** Integrated commit sha for delivered prerequisites (null for no-op / undelivered). */
	integratedSha: z.string().nullable(),
	/** The prerequisite's delivery task commit (null for no-op / undelivered). */
	taskCommitSha: z.string().nullable(),
	/** null when the prerequisite has no durable delivery receipt yet. */
	deliveryStatus: runtimeGitDeliveryStatusSchema.nullable(),
});
export type RuntimeTaskDispatchPrerequisite = z.infer<typeof runtimeTaskDispatchPrerequisiteSchema>;

/**
 * Durable per-task dispatch record (B-9.4): what was dispatched, from which
 * verified base, with which prompt. Written before the session is started and
 * before the board mutation, so restart reconciliation can always recover.
 */
export const runtimeTaskDispatchRecordSchema = z.object({
	taskId: z.string(),
	workspaceId: z.string().min(1),
	/** The card's base ref at dispatch time. */
	baseRef: z.string(),
	/** Verified baseline commit the dispatched worktree sits on (null for blocked records without a resolved base). */
	baseSha: z.string().nullable(),
	/** 1-based dispatch attempt count; bounds automatic retries. */
	attempt: z.number().int().min(1),
	status: runtimeTaskDispatchStatusSchema,
	error: z.string().nullable(),
	prerequisites: z.array(runtimeTaskDispatchPrerequisiteSchema),
	/** The fresh-context prompt handed to the worker (audit + restart reuse). */
	prompt: z.string().nullable(),
	agentId: z.string().nullable(),
	dispatchedAt: z.number().int(),
	updatedAt: z.number().int(),
});
export type RuntimeTaskDispatchRecord = z.infer<typeof runtimeTaskDispatchRecordSchema>;

export const runtimeTaskDispatchTaskViewSchema = z.object({
	taskId: z.string(),
	title: z.string(),
	baseRef: z.string(),
	/** null when the task can be dispatched right now. */
	blockedReason: z.string().nullable(),
	prerequisites: z.array(runtimeTaskDispatchPrerequisiteSchema),
});
export type RuntimeTaskDispatchTaskView = z.infer<typeof runtimeTaskDispatchTaskViewSchema>;

export const runtimeTaskDispatchStatusResponseSchema = z.object({
	enabled: z.boolean(),
	workerLimit: z.number().int().min(1).max(4),
	/** Task id currently holding a worker slot (null when free). */
	activeWorkerTaskId: z.string().nullable(),
	readyTasks: z.array(runtimeTaskDispatchTaskViewSchema),
	blockedTasks: z.array(runtimeTaskDispatchTaskViewSchema),
	records: z.array(runtimeTaskDispatchRecordSchema),
});
export type RuntimeTaskDispatchStatusResponse = z.infer<typeof runtimeTaskDispatchStatusResponseSchema>;

export const runtimeTaskDispatchRunResponseSchema = z.object({
	dispatchedTaskId: z.string().nullable(),
	/** null when a task was dispatched. */
	skippedReason: z.enum(["disabled", "worker_busy", "no_ready_tasks", "none"]).nullable(),
	readyTasks: z.array(runtimeTaskDispatchTaskViewSchema),
	blockedTasks: z.array(runtimeTaskDispatchTaskViewSchema),
});
export type RuntimeTaskDispatchRunResponse = z.infer<typeof runtimeTaskDispatchRunResponseSchema>;

export const runtimeTaskDispatchReconcileResponseSchema = z.object({
	relaunchedTaskIds: z.array(z.string()),
	skippedTaskIds: z.array(z.string()),
});
export type RuntimeTaskDispatchReconcileResponse = z.infer<typeof runtimeTaskDispatchReconcileResponseSchema>;

export const runtimeGitDeliveryPrStatusSchema = z.enum(["not_required", "created", "existing", "skipped", "failed"]);
export type RuntimeGitDeliveryPrStatus = z.infer<typeof runtimeGitDeliveryPrStatusSchema>;

export const runtimeGitDeliveryEvidenceSchema = z.object({
	stage: z.string().min(1),
	detail: z.string(),
});
export type RuntimeGitDeliveryEvidence = z.infer<typeof runtimeGitDeliveryEvidenceSchema>;

/**
 * B-8.8: durable per-task delivery receipt — the single source of truth for
 * whether a task's work was delivered (and the evidence for how).
 */
export const runtimeGitDeliveryReceiptSchema = z.object({
	taskId: z.string(),
	workspaceId: z.string().min(1),
	repoPath: z.string().min(1),
	worktreePath: z.string().min(1),
	/** The task's base ref from the card (null when unknown). */
	baseRef: z.string().nullable(),
	/** The recorded starting commit (review handoff; null when unrecorded). */
	baseSha: z.string().nullable(),
	destinationBranch: z.string().min(1),
	remote: z.string().min(1),
	/** Remote branch sha verified to contain the delivery (null when unverified). */
	remoteBranchSha: z.string().nullable(),
	/** The task commit (null for no-op deliveries). */
	taskCommitSha: z.string().nullable(),
	/** Destination branch sha after integration (null for no-op deliveries). */
	integratedSha: z.string().nullable(),
	status: runtimeGitDeliveryStatusSchema,
	stage: runtimeGitDeliveryStageSchema,
	/** Policy snapshot under which this delivery ran. */
	policy: runtimeGitDeliveryPolicySchema,
	commitMessageSource: z.enum(["model", "fallback", "reused"]).nullable(),
	stagedPaths: z.array(z.string()),
	excludedPaths: z.array(z.string()),
	/** Review gate status observed at delivery start (null when never checked). */
	reviewOutcome: z.enum(["ready", "not_ready", "absent"]).nullable(),
	/** Verification gate outcome from the stored receipt (null when no receipt). */
	verificationPassed: z.boolean().nullable(),
	/** B-7.6: content hash of the candidate tree that was committed (null when not computed). */
	candidateTreeHash: z.string().nullable().default(null),
	pr: z
		.object({
			status: runtimeGitDeliveryPrStatusSchema,
			number: z.number().int().nullable(),
			url: z.string().nullable(),
			error: z.string().nullable(),
		})
		.nullable(),
	/** Bounded evidence trail (most recent last); carries divergence detail when paused. */
	evidence: z.array(runtimeGitDeliveryEvidenceSchema),
	/** 1-based delivery attempt counter (crash + retry diagnostics). */
	attempt: z.number().int().min(1),
	startedAt: z.number().int(),
	updatedAt: z.number().int(),
});
export type RuntimeGitDeliveryReceipt = z.infer<typeof runtimeGitDeliveryReceiptSchema>;

export const runtimeTaskDeliveryStartResponseSchema = z.object({
	ok: z.boolean(),
	receipt: runtimeGitDeliveryReceiptSchema.nullable(),
	error: z.string().nullable(),
});
export type RuntimeTaskDeliveryStartResponse = z.infer<typeof runtimeTaskDeliveryStartResponseSchema>;

/**
 * B-5.9/B-8.8: whether completing this task may start its linked backlog
 * tasks. With deterministic delivery enabled only a completed delivery
 * receipt unlocks dependents; without it the legacy behavior (unlock on
 * completion) applies.
 */
export const runtimeTaskDependentsUnlockSchema = z.object({
	allowed: z.boolean(),
	reason: z.string().nullable(),
});
export type RuntimeTaskDependentsUnlock = z.infer<typeof runtimeTaskDependentsUnlockSchema>;

export const runtimeTaskDeliveryInfoResponseSchema = z.object({
	ok: z.boolean(),
	receipt: runtimeGitDeliveryReceiptSchema.nullable(),
	error: z.string().nullable(),
	dependentsUnlock: runtimeTaskDependentsUnlockSchema,
});
export type RuntimeTaskDeliveryInfoResponse = z.infer<typeof runtimeTaskDeliveryInfoResponseSchema>;

export const runtimeConfigResponseSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema,
	selectedShortcutLabel: z.string().nullable(),
	agentAutonomousModeEnabled: z.boolean(),
	debugModeEnabled: z.boolean().optional(),
	effectiveCommand: z.string().nullable(),
	globalConfigPath: z.string(),
	projectConfigPath: z.string().nullable(),
	readyForReviewNotificationsEnabled: z.boolean(),
	detectedCommands: z.array(z.string()),
	agents: z.array(runtimeAgentDefinitionSchema),
	shortcuts: z.array(runtimeProjectShortcutSchema),
	clineProviderSettings: runtimeClineProviderSettingsSchema,
	commitPromptTemplate: z.string(),
	openPrPromptTemplate: z.string(),
	commitPromptTemplateDefault: z.string(),
	openPrPromptTemplateDefault: z.string(),
	contextBudget: runtimeContextBudgetSchema.nullable(),
	/** B-6: global review lifecycle policy; null means all defaults (off, 2 repair rounds). */
	reviewPolicy: runtimeReviewPolicySchema.nullable(),
	/** B-7: global verification gate; null means the gate is inactive (off, no checks). */
	verification: runtimeVerificationConfigSchema.nullable(),
	/** B-8: global git delivery policy; null means delivery is disabled (model-driven git flow). */
	gitDeliveryPolicy: runtimeGitDeliveryPolicySchema.nullable(),
	/** B-9: global sequential task dispatch policy; null means the queue is off (legacy browser auto-start). */
	taskDispatchPolicy: runtimeTaskDispatchPolicySchema.nullable(),
	effectiveContextWindow: runtimeEffectiveContextWindowSchema.nullable(),
});
export type RuntimeConfigResponse = z.infer<typeof runtimeConfigResponseSchema>;

export const runtimeConfigSaveRequestSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema.optional(),
	selectedShortcutLabel: z.string().nullable().optional(),
	agentAutonomousModeEnabled: z.boolean().optional(),
	shortcuts: z.array(runtimeProjectShortcutSchema).optional(),
	readyForReviewNotificationsEnabled: z.boolean().optional(),
	commitPromptTemplate: z.string().optional(),
	openPrPromptTemplate: z.string().optional(),
	contextBudget: runtimeContextBudgetSaveSchema.optional(),
	/** B-6: `null` clears the stored review policy; `undefined` leaves it untouched. */
	reviewPolicy: runtimeReviewPolicySaveSchema.optional(),
	/** B-7: verification gate; `undefined` leaves it untouched. */
	verification: runtimeVerificationConfigSaveSchema.optional(),
	/** B-8: git delivery policy; `null` clears the stored policy, `undefined` leaves it untouched. */
	gitDeliveryPolicy: runtimeGitDeliveryPolicySaveSchema.optional(),
	/** B-9: sequential task dispatch policy; `null` clears, `undefined` leaves untouched. */
	taskDispatchPolicy: runtimeTaskDispatchPolicySaveSchema.optional(),
});
export type RuntimeConfigSaveRequest = z.infer<typeof runtimeConfigSaveRequestSchema>;

export const runtimeTaskSessionStartRequestSchema = z.object({
	taskId: z.string(),
	prompt: z.string(),
	/** Display title from the Kanban task card. Propagated to SDK session metadata as a convenience copy. */
	taskTitle: z.string().optional(),
	images: z.array(runtimeTaskImageSchema).optional(),
	startInPlanMode: z.boolean().optional(),
	mode: runtimeTaskSessionModeSchema.optional(),
	resumeFromTrash: z.boolean().optional(),
	baseRef: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	agentId: runtimeAgentIdSchema.optional(),
	clineSettings: runtimeTaskClineSettingsSchema.optional(),
});
export type RuntimeTaskSessionStartRequest = z.infer<typeof runtimeTaskSessionStartRequestSchema>;

export const runtimeTaskSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionStartResponse = z.infer<typeof runtimeTaskSessionStartResponseSchema>;

// ---------------------------------------------------------------------------
// B-6: task review lifecycle (handoff artifact, structured findings, result).
// ---------------------------------------------------------------------------

/**
 * B-6.4: one structured review finding. `evidence` is mandatory so every
 * finding carries file/line or diff evidence instead of a bare claim.
 */
export const runtimeReviewFindingSchema = z.object({
	severity: z.enum(["blocking", "non-blocking"]),
	/** Worktree-relative file path the finding points at; null for whole-change findings. */
	file: z.string().nullable(),
	line: z.number().int().positive().nullable(),
	description: z.string().min(1),
	evidence: z.string().min(1),
});
export type RuntimeReviewFinding = z.infer<typeof runtimeReviewFindingSchema>;

/**
 * B-6.4: the JSON payload the reviewer must emit in its final message
 * (inside a fenced `kanban-review-result` block). Kanban stamps taskId,
 * candidateTreeHash, and reviewedAt when persisting the full result.
 */
export const runtimeReviewResultOutputSchema = z.object({
	findings: z.array(runtimeReviewFindingSchema),
	/** True when an acceptance criterion is unmet or a required fix could not complete. */
	blocking: z.boolean(),
	/** Human-readable summary of each scoped fix the reviewer applied. */
	fixesApplied: z.array(z.string()),
	/** Acceptance criteria / changed paths the reviewer explicitly covered. */
	requirementsCovered: z.array(z.string()),
	/** Items the reviewer could not resolve within its repair-round budget. */
	unresolvedItems: z.array(z.string()),
});
export type RuntimeReviewResultOutput = z.infer<typeof runtimeReviewResultOutputSchema>;

/** B-6.4/B-6.7: persisted review result, bound to the candidate content tree. */
export const runtimeReviewResultSchema = runtimeReviewResultOutputSchema.extend({
	taskId: z.string().min(1),
	/** Git tree hash of the whole worktree (tracked + untracked) at review time (B-6.7). */
	candidateTreeHash: z.string().nullable(),
	reviewedAt: z.number().int(),
});
export type RuntimeReviewResult = z.infer<typeof runtimeReviewResultSchema>;

/**
 * B-6.4: terminal status of a review run. A missing/malformed result block is
 * `parse_failed` and never treated as a pass.
 */
export const runtimeTaskReviewStatusSchema = z.enum(["ready", "blocked", "failed", "parse_failed"]);
export type RuntimeTaskReviewStatus = z.infer<typeof runtimeTaskReviewStatusSchema>;

/** B-6.7: durable per-task review outcome (status + result or failure detail). */
export const runtimeReviewOutcomeFileSchema = z.object({
	status: runtimeTaskReviewStatusSchema,
	result: runtimeReviewResultSchema.nullable(),
	error: z.string().nullable(),
	sessionId: z.string().nullable(),
	warnings: z.array(z.string()),
	/** B-7.2: durable verification receipt bound to the candidate tree (null when the gate is off or failed before running). Optional in the durable file so pre-B-7 stored outcomes keep loading; readers normalize to null. */
	verification: runtimeVerificationReceiptSchema.nullable().optional(),
	updatedAt: z.number().int(),
});
export type RuntimeReviewOutcomeFile = z.infer<typeof runtimeReviewOutcomeFileSchema>;

/** B-6.1: authoritative plan document referenced by a review handoff. */
export const runtimeReviewHandoffPlanDocumentSchema = z.object({
	/** Worktree-relative path. */
	path: z.string().min(1),
	/** SHA-256 of the current file content (null when the file is missing). */
	sha256: z.string().nullable(),
	/** Last commit that touched the path (null when untracked or unknown). */
	revision: z.string().nullable(),
	exists: z.boolean(),
});
export type RuntimeReviewHandoffPlanDocument = z.infer<typeof runtimeReviewHandoffPlanDocumentSchema>;

/**
 * B-6.1: the implementation handoff — everything a fresh review session needs
 * without the implementation transcript: authoritative description criteria,
 * plan documents, recorded starting revision, and the exact change set.
 */
export const runtimeReviewHandoffArtifactSchema = z.object({
	taskId: z.string().min(1),
	worktreePath: z.string().min(1),
	repoPath: z.string().min(1),
	/** Recorded starting revision (null when no baseline was recorded). */
	startingCommit: z.string().nullable(),
	/** Worktree HEAD at handoff time (null for a repository without commits). */
	latestCommit: z.string().nullable(),
	/** Worktree-relative paths changed vs the starting revision (committed + uncommitted). */
	changedPaths: z.array(z.string()),
	/** Worktree-relative untracked files. */
	untrackedPaths: z.array(z.string()),
	planDocuments: z.array(runtimeReviewHandoffPlanDocumentSchema),
	acceptanceCriteria: z.array(z.string()),
	designDecisions: z.array(z.string()),
	testsAttempted: z.array(z.string()),
	knownLimitations: z.array(z.string()),
	unresolvedQuestions: z.array(z.string()),
	createdAt: z.number().int(),
});
export type RuntimeReviewHandoffArtifact = z.infer<typeof runtimeReviewHandoffArtifactSchema>;

export const runtimeTaskReviewStartRequestSchema = z.object({
	taskId: z.string().min(1),
	/** Authoritative task description the review is judged against. */
	description: z.string().min(1),
	taskTitle: z.string().optional(),
	planDocumentPaths: z.array(z.string().min(1)).optional(),
	/** Structured self-report from the implementation session (unverified claims). */
	agentNotes: z
		.object({
			designDecisions: z.array(z.string()).optional(),
			testsAttempted: z.array(z.string()).optional(),
			knownLimitations: z.array(z.string()).optional(),
			unresolvedQuestions: z.array(z.string()).optional(),
		})
		.nullable()
		.optional(),
	/** Recorded starting revision; falls back to the preservation record. */
	startingCommit: z.string().nullable().optional(),
});
export type RuntimeTaskReviewStartRequest = z.infer<typeof runtimeTaskReviewStartRequestSchema>;

export const runtimeTaskReviewStartResponseSchema = z.object({
	ok: z.boolean(),
	status: runtimeTaskReviewStatusSchema,
	handoff: runtimeReviewHandoffArtifactSchema.nullable(),
	result: runtimeReviewResultSchema.nullable(),
	candidateTreeHash: z.string().nullable(),
	sessionId: z.string().nullable(),
	error: z.string().nullable(),
	warnings: z.array(z.string()),
	/** B-7: the verification receipt for this run (null when the gate is off or never ran). */
	verification: runtimeVerificationReceiptSchema.nullable(),
});
export type RuntimeTaskReviewStartResponse = z.infer<typeof runtimeTaskReviewStartResponseSchema>;

export const runtimeTaskReviewInfoRequestSchema = z.object({
	taskId: z.string().min(1),
});
export type RuntimeTaskReviewInfoRequest = z.infer<typeof runtimeTaskReviewInfoRequestSchema>;

/**
 * B-6.7: review status for a card, including the live candidate tree hash so
 * callers can tell whether later edits invalidated the stored result.
 */
export const runtimeTaskReviewInfoResponseSchema = z.object({
	ok: z.boolean(),
	/** null when no review handoff exists for the task yet. */
	status: runtimeTaskReviewStatusSchema.nullable(),
	handoff: runtimeReviewHandoffArtifactSchema.nullable(),
	result: runtimeReviewResultSchema.nullable(),
	/** Current worktree tree hash (recomputed on read). */
	candidateTreeHash: z.string().nullable(),
	/** True only when the stored result was bound to the current tree hash. */
	resultMatchesTree: z.boolean().nullable(),
	error: z.string().nullable(),
	warnings: z.array(z.string()),
	/** B-7: the stored verification receipt (null when the gate never ran). */
	verification: runtimeVerificationReceiptSchema.nullable(),
});
export type RuntimeTaskReviewInfoResponse = z.infer<typeof runtimeTaskReviewInfoResponseSchema>;

export const runtimeTaskSessionStopRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskSessionStopRequest = z.infer<typeof runtimeTaskSessionStopRequestSchema>;

export const runtimeTaskSessionStopResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionStopResponse = z.infer<typeof runtimeTaskSessionStopResponseSchema>;

export const runtimeTaskSessionInputRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	appendNewline: z.boolean().optional(),
});
export type RuntimeTaskSessionInputRequest = z.infer<typeof runtimeTaskSessionInputRequestSchema>;

export const runtimeTaskSessionInputResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionInputResponse = z.infer<typeof runtimeTaskSessionInputResponseSchema>;

export const runtimeTaskChatMessageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant", "system", "tool", "reasoning", "status"]),
	content: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	createdAt: z.number(),
	meta: z
		.object({
			toolName: z.string().nullable().optional(),
			hookEventName: z.string().nullable().optional(),
			toolCallId: z.string().nullable().optional(),
			streamType: z.string().nullable().optional(),
			messageKind: z.string().nullable().optional(),
			displayRole: z.string().nullable().optional(),
			reason: z.string().nullable().optional(),
		})
		.nullable()
		.optional(),
});
export type RuntimeTaskChatMessage = z.infer<typeof runtimeTaskChatMessageSchema>;

export const runtimeTaskChatMessagesRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatMessagesRequest = z.infer<typeof runtimeTaskChatMessagesRequestSchema>;

export const runtimeTaskChatMessagesResponseSchema = z.object({
	ok: z.boolean(),
	messages: z.array(runtimeTaskChatMessageSchema),
	error: z.string().optional(),
});
export type RuntimeTaskChatMessagesResponse = z.infer<typeof runtimeTaskChatMessagesResponseSchema>;

export const runtimeTaskChatSendRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	mode: runtimeTaskSessionModeSchema.optional(),
});
export type RuntimeTaskChatSendRequest = z.infer<typeof runtimeTaskChatSendRequestSchema>;

export const runtimeTaskChatSendResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	message: runtimeTaskChatMessageSchema.nullable().optional(),
	error: z.string().optional(),
});
export type RuntimeTaskChatSendResponse = z.infer<typeof runtimeTaskChatSendResponseSchema>;

export const runtimeTaskChatReloadRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatReloadRequest = z.infer<typeof runtimeTaskChatReloadRequestSchema>;

export const runtimeTaskChatReloadResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatReloadResponse = z.infer<typeof runtimeTaskChatReloadResponseSchema>;

export const runtimeTaskChatAbortRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatAbortRequest = z.infer<typeof runtimeTaskChatAbortRequestSchema>;

export const runtimeTaskChatAbortResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatAbortResponse = z.infer<typeof runtimeTaskChatAbortResponseSchema>;

export const runtimeTaskChatCancelRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatCancelRequest = z.infer<typeof runtimeTaskChatCancelRequestSchema>;

export const runtimeTaskChatCancelResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatCancelResponse = z.infer<typeof runtimeTaskChatCancelResponseSchema>;

export const runtimeShellSessionStartRequestSchema = z.object({
	taskId: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	workspaceTaskId: z.string().optional(),
	baseRef: z.string(),
});
export type RuntimeShellSessionStartRequest = z.infer<typeof runtimeShellSessionStartRequestSchema>;

export const runtimeShellSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	shellBinary: z.string().nullable().optional(),
	error: z.string().optional(),
});
export type RuntimeShellSessionStartResponse = z.infer<typeof runtimeShellSessionStartResponseSchema>;

export const runtimeTerminalWsResizeMessageSchema = z.object({
	type: z.literal("resize"),
	cols: z.number().int().positive(),
	rows: z.number().int().positive(),
	pixelWidth: z.number().int().positive().optional(),
	pixelHeight: z.number().int().positive().optional(),
});
export type RuntimeTerminalWsResizeMessage = z.infer<typeof runtimeTerminalWsResizeMessageSchema>;

export const runtimeTerminalWsStopMessageSchema = z.object({
	type: z.literal("stop"),
});
export type RuntimeTerminalWsStopMessage = z.infer<typeof runtimeTerminalWsStopMessageSchema>;

export const runtimeTerminalWsOutputAckMessageSchema = z.object({
	type: z.literal("output_ack"),
	bytes: z.number().int().nonnegative(),
});
export type RuntimeTerminalWsOutputAckMessage = z.infer<typeof runtimeTerminalWsOutputAckMessageSchema>;

export const runtimeTerminalWsRestoreCompleteMessageSchema = z.object({
	type: z.literal("restore_complete"),
});
export type RuntimeTerminalWsRestoreCompleteMessage = z.infer<typeof runtimeTerminalWsRestoreCompleteMessageSchema>;

export const runtimeTerminalWsClientMessageSchema = z.discriminatedUnion("type", [
	runtimeTerminalWsResizeMessageSchema,
	runtimeTerminalWsStopMessageSchema,
	runtimeTerminalWsOutputAckMessageSchema,
	runtimeTerminalWsRestoreCompleteMessageSchema,
]);
export type RuntimeTerminalWsClientMessage = z.infer<typeof runtimeTerminalWsClientMessageSchema>;

export const runtimeTerminalWsStateMessageSchema = z.object({
	type: z.literal("state"),
	summary: runtimeTaskSessionSummarySchema,
});
export type RuntimeTerminalWsStateMessage = z.infer<typeof runtimeTerminalWsStateMessageSchema>;

export const runtimeTerminalWsErrorMessageSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
});
export type RuntimeTerminalWsErrorMessage = z.infer<typeof runtimeTerminalWsErrorMessageSchema>;

export const runtimeTerminalWsExitMessageSchema = z.object({
	type: z.literal("exit"),
	code: z.number().nullable(),
});
export type RuntimeTerminalWsExitMessage = z.infer<typeof runtimeTerminalWsExitMessageSchema>;

export const runtimeTerminalWsRestoreMessageSchema = z.object({
	type: z.literal("restore"),
	snapshot: z.string(),
	cols: z.number().int().positive().nullable().optional(),
	rows: z.number().int().positive().nullable().optional(),
});
export type RuntimeTerminalWsRestoreMessage = z.infer<typeof runtimeTerminalWsRestoreMessageSchema>;

export const runtimeTerminalWsServerMessageSchema = z.discriminatedUnion("type", [
	runtimeTerminalWsStateMessageSchema,
	runtimeTerminalWsErrorMessageSchema,
	runtimeTerminalWsExitMessageSchema,
	runtimeTerminalWsRestoreMessageSchema,
]);
export type RuntimeTerminalWsServerMessage = z.infer<typeof runtimeTerminalWsServerMessageSchema>;

export const runtimeGitCommitSchema = z.object({
	hash: z.string(),
	shortHash: z.string(),
	authorName: z.string(),
	authorEmail: z.string(),
	date: z.string(),
	message: z.string(),
	parentHashes: z.array(z.string()),
	relation: z.enum(["selected", "upstream", "shared"]).optional(),
});
export type RuntimeGitCommit = z.infer<typeof runtimeGitCommitSchema>;

export const runtimeGitRefSchema = z.object({
	name: z.string(),
	type: z.enum(["branch", "remote", "detached"]),
	hash: z.string(),
	isHead: z.boolean(),
	upstreamName: z.string().optional(),
	ahead: z.number().optional(),
	behind: z.number().optional(),
});
export type RuntimeGitRef = z.infer<typeof runtimeGitRefSchema>;

export const runtimeGitLogRequestSchema = z.object({
	ref: z.string().nullable().optional(),
	refs: z.array(z.string()).optional(),
	maxCount: z.number().int().positive().optional(),
	skip: z.number().int().nonnegative().optional(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitLogRequest = z.infer<typeof runtimeGitLogRequestSchema>;

export const runtimeGitLogResponseSchema = z.object({
	ok: z.boolean(),
	commits: z.array(runtimeGitCommitSchema),
	totalCount: z.number(),
	error: z.string().optional(),
});
export type RuntimeGitLogResponse = z.infer<typeof runtimeGitLogResponseSchema>;

export const runtimeGitCommitDiffFileSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: z.enum(["modified", "added", "deleted", "renamed"]),
	additions: z.number(),
	deletions: z.number(),
	patch: z.string(),
});
export type RuntimeGitCommitDiffFile = z.infer<typeof runtimeGitCommitDiffFileSchema>;

export const runtimeGitCommitDiffRequestSchema = z.object({
	commitHash: z.string(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitCommitDiffRequest = z.infer<typeof runtimeGitCommitDiffRequestSchema>;

export const runtimeGitCommitDiffResponseSchema = z.object({
	ok: z.boolean(),
	commitHash: z.string(),
	files: z.array(runtimeGitCommitDiffFileSchema),
	error: z.string().optional(),
});
export type RuntimeGitCommitDiffResponse = z.infer<typeof runtimeGitCommitDiffResponseSchema>;

export const runtimeGitRefsResponseSchema = z.object({
	ok: z.boolean(),
	refs: z.array(runtimeGitRefSchema),
	error: z.string().optional(),
});
export type RuntimeGitRefsResponse = z.infer<typeof runtimeGitRefsResponseSchema>;

export const runtimeHookEventSchema = z.enum(["to_review", "to_in_progress", "activity"]);
export type RuntimeHookEvent = z.infer<typeof runtimeHookEventSchema>;

export const runtimeHookIngestRequestSchema = z.object({
	taskId: z.string(),
	workspaceId: z.string(),
	event: runtimeHookEventSchema,
	metadata: runtimeTaskHookActivitySchema.partial().optional(),
});
export type RuntimeHookIngestRequest = z.infer<typeof runtimeHookIngestRequestSchema>;

export const runtimeHookIngestResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeHookIngestResponse = z.infer<typeof runtimeHookIngestResponseSchema>;
