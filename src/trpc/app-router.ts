// Defines the typed TRPC boundary between the browser and the local runtime.
// Keep request and response contracts plus workspace-scoped procedures here,
// and delegate domain behavior to runtime-api.ts and lower-level services.
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

import type {
	RuntimeBlockedTaskCleanupsResponse,
	RuntimeClineAccountBalanceResponse,
	RuntimeClineAccountOrganizationsResponse,
	RuntimeClineAccountProfileResponse,
	RuntimeClineAccountSwitchRequest,
	RuntimeClineAccountSwitchResponse,
	RuntimeClineAddProviderRequest,
	RuntimeClineAddProviderResponse,
	RuntimeClineDeviceAuthCompleteRequest,
	RuntimeClineDeviceAuthCompleteResponse,
	RuntimeClineDeviceAuthStartResponse,
	RuntimeClineKanbanAccessResponse,
	RuntimeClineMcpAuthStatusResponse,
	RuntimeClineMcpOAuthRequest,
	RuntimeClineMcpOAuthResponse,
	RuntimeClineMcpSettingsResponse,
	RuntimeClineMcpSettingsSaveRequest,
	RuntimeClineMcpSettingsSaveResponse,
	RuntimeClineOauthLoginRequest,
	RuntimeClineOauthLoginResponse,
	RuntimeClineProviderCatalogResponse,
	RuntimeClineProviderModelsRequest,
	RuntimeClineProviderModelsResponse,
	RuntimeClineProviderSettingsSaveRequest,
	RuntimeClineProviderSettingsSaveResponse,
	RuntimeClineUpdateProviderRequest,
	RuntimeClineUpdateProviderResponse,
	RuntimeCommandRunRequest,
	RuntimeCommandRunResponse,
	RuntimeConfigResponse,
	RuntimeConfigSaveRequest,
	RuntimeDebugResetAllStateResponse,
	RuntimeDiagnosticsExportRequest,
	RuntimeDiagnosticsExportResponse,
	RuntimeDirectoryListRequest,
	RuntimeDirectoryListResponse,
	RuntimeFeaturebaseTokenResponse,
	RuntimeGitCheckoutRequest,
	RuntimeGitCheckoutResponse,
	RuntimeGitCommitDiffRequest,
	RuntimeGitCommitDiffResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitLogRequest,
	RuntimeGitLogResponse,
	RuntimeGitRefsResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeOpenFileRequest,
	RuntimeOpenFileResponse,
	RuntimePrAuthorizedSnapshotRequest,
	RuntimePrAuthorizedSnapshotResponse,
	RuntimePrCommentDispatchUpdateRequest,
	RuntimePrOperationReleaseRequest,
	RuntimePrOperationReservationRequest,
	RuntimePrOperationReservationResponse,
	RuntimePrOperationValidateRequest,
	RuntimeProjectAddRequest,
	RuntimeProjectAddResponse,
	RuntimeProjectDirectoryPickerResponse,
	RuntimeProjectRemoveRequest,
	RuntimeProjectRemoveResponse,
	RuntimeProjectsResponse,
	RuntimePrRecordMutationResponse,
	RuntimePrRepairOwnerResponse,
	RuntimePrRepairOwnerSelectRequest,
	RuntimePrRepairOwnerTransferRequest,
	RuntimePrSnapshotRefreshRequest,
	RuntimePrSnapshotRefreshResponse,
	RuntimePrSubscriptionRequest,
	RuntimePrSubscriptionResponse,
	RuntimeRunUpdateResponse,
	RuntimeShellSessionStartRequest,
	RuntimeShellSessionStartResponse,
	RuntimeSlashCommandsResponse,
	RuntimeTaskAutomationPrSelectRequest,
	RuntimeTaskAutomationPrSelectResponse,
	RuntimeTaskChatAbortRequest,
	RuntimeTaskChatAbortResponse,
	RuntimeTaskChatCancelRequest,
	RuntimeTaskChatCancelResponse,
	RuntimeTaskChatMessagesRequest,
	RuntimeTaskChatMessagesResponse,
	RuntimeTaskChatReloadRequest,
	RuntimeTaskChatReloadResponse,
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
	RuntimeTaskDeliveryInfoRequest,
	RuntimeTaskDeliveryInfoResponse,
	RuntimeTaskDeliveryStartRequest,
	RuntimeTaskDeliveryStartResponse,
	RuntimeTaskDiagnosticsActionRequest,
	RuntimeTaskDiagnosticsActionResponse,
	RuntimeTaskDiagnosticsRequest,
	RuntimeTaskDiagnosticsResponse,
	RuntimeTaskDispatchReconcileResponse,
	RuntimeTaskDispatchRunResponse,
	RuntimeTaskDispatchStatusResponse,
	RuntimeTaskInitialStartStatusRequest,
	RuntimeTaskInitialStartStatusResponse,
	RuntimeTaskMergeBindingUpdateRequest,
	RuntimeTaskPhasesRequest,
	RuntimeTaskPhasesResponse,
	RuntimeTaskPreservationInfoResponse,
	RuntimeTaskPreservationRequest,
	RuntimeTaskPrSettingsRequest,
	RuntimeTaskPrSettingsResponse,
	RuntimeTaskPrTrackingResumeRequest,
	RuntimeTaskPrTrackingResumeResponse,
	RuntimeTaskPullRequestLinkRequest,
	RuntimeTaskPullRequestLinkResponse,
	RuntimeTaskPullRequestPrimaryRequest,
	RuntimeTaskPullRequestsRefreshRequest,
	RuntimeTaskPullRequestsRefreshResponse,
	RuntimeTaskReviewInfoRequest,
	RuntimeTaskReviewInfoResponse,
	RuntimeTaskReviewStartRequest,
	RuntimeTaskReviewStartResponse,
	RuntimeTaskSessionInputRequest,
	RuntimeTaskSessionInputResponse,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionStopRequest,
	RuntimeTaskSessionStopResponse,
	RuntimeTaskTrackingStateRequest,
	RuntimeTaskTrackingStateResponse,
	RuntimeTaskWorkspaceInfoRequest,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeTaskWorkspaceMaintenanceReport,
	RuntimeTaskWorktreeRecoverResponse,
	RuntimeUpdateStatusResponse,
	RuntimeWorkspaceChangesRequest,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileSearchRequest,
	RuntimeWorkspaceFileSearchResponse,
	RuntimeWorkspaceStateNotifyResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceStateSaveRequest,
	RuntimeWorktreeDeleteRequest,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureRequest,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";
import {
	runtimeBlockedTaskCleanupsResponseSchema,
	runtimeClineAccountBalanceResponseSchema,
	runtimeClineAccountOrganizationsResponseSchema,
	runtimeClineAccountProfileResponseSchema,
	runtimeClineAccountSwitchRequestSchema,
	runtimeClineAccountSwitchResponseSchema,
	runtimeClineAddProviderRequestSchema,
	runtimeClineAddProviderResponseSchema,
	runtimeClineDeviceAuthCompleteRequestSchema,
	runtimeClineDeviceAuthCompleteResponseSchema,
	runtimeClineDeviceAuthStartResponseSchema,
	runtimeClineKanbanAccessResponseSchema,
	runtimeClineMcpAuthStatusResponseSchema,
	runtimeClineMcpOAuthRequestSchema,
	runtimeClineMcpOAuthResponseSchema,
	runtimeClineMcpSettingsResponseSchema,
	runtimeClineMcpSettingsSaveRequestSchema,
	runtimeClineMcpSettingsSaveResponseSchema,
	runtimeClineOauthLoginRequestSchema,
	runtimeClineOauthLoginResponseSchema,
	runtimeClineProviderCatalogResponseSchema,
	runtimeClineProviderModelsRequestSchema,
	runtimeClineProviderModelsResponseSchema,
	runtimeClineProviderSettingsSaveRequestSchema,
	runtimeClineProviderSettingsSaveResponseSchema,
	runtimeClineUpdateProviderRequestSchema,
	runtimeClineUpdateProviderResponseSchema,
	runtimeCommandRunRequestSchema,
	runtimeCommandRunResponseSchema,
	runtimeConfigResponseSchema,
	runtimeConfigSaveRequestSchema,
	runtimeDebugResetAllStateResponseSchema,
	runtimeDiagnosticsExportRequestSchema,
	runtimeDiagnosticsExportResponseSchema,
	runtimeDirectoryListRequestSchema,
	runtimeDirectoryListResponseSchema,
	runtimeFeaturebaseTokenResponseSchema,
	runtimeGitCheckoutRequestSchema,
	runtimeGitCheckoutResponseSchema,
	runtimeGitCommitDiffRequestSchema,
	runtimeGitCommitDiffResponseSchema,
	runtimeGitDiscardResponseSchema,
	runtimeGitLogRequestSchema,
	runtimeGitLogResponseSchema,
	runtimeGitRefsResponseSchema,
	runtimeGitSummaryResponseSchema,
	runtimeGitSyncActionSchema,
	runtimeGitSyncResponseSchema,
	runtimeHookIngestRequestSchema,
	runtimeHookIngestResponseSchema,
	runtimeOpenFileRequestSchema,
	runtimeOpenFileResponseSchema,
	runtimePrAuthorizedSnapshotRequestSchema,
	runtimePrAuthorizedSnapshotResponseSchema,
	runtimePrCommentDispatchUpdateRequestSchema,
	runtimePrOperationReleaseRequestSchema,
	runtimePrOperationReservationRequestSchema,
	runtimePrOperationReservationResponseSchema,
	runtimePrOperationValidateRequestSchema,
	runtimeProjectAddRequestSchema,
	runtimeProjectAddResponseSchema,
	runtimeProjectDirectoryPickerResponseSchema,
	runtimeProjectRemoveRequestSchema,
	runtimeProjectRemoveResponseSchema,
	runtimeProjectsResponseSchema,
	runtimePrRecordMutationResponseSchema,
	runtimePrRepairOwnerResponseSchema,
	runtimePrRepairOwnerSelectRequestSchema,
	runtimePrRepairOwnerTransferRequestSchema,
	runtimePrSnapshotRefreshRequestSchema,
	runtimePrSnapshotRefreshResponseSchema,
	runtimePrSubscriptionRequestSchema,
	runtimePrSubscriptionResponseSchema,
	runtimeRunUpdateResponseSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeShellSessionStartResponseSchema,
	runtimeSlashCommandsResponseSchema,
	runtimeTaskAutomationPrSelectRequestSchema,
	runtimeTaskAutomationPrSelectResponseSchema,
	runtimeTaskChatAbortRequestSchema,
	runtimeTaskChatAbortResponseSchema,
	runtimeTaskChatCancelRequestSchema,
	runtimeTaskChatCancelResponseSchema,
	runtimeTaskChatMessagesRequestSchema,
	runtimeTaskChatMessagesResponseSchema,
	runtimeTaskChatReloadRequestSchema,
	runtimeTaskChatReloadResponseSchema,
	runtimeTaskChatSendRequestSchema,
	runtimeTaskChatSendResponseSchema,
	runtimeTaskDeliveryInfoRequestSchema,
	runtimeTaskDeliveryInfoResponseSchema,
	runtimeTaskDeliveryStartRequestSchema,
	runtimeTaskDeliveryStartResponseSchema,
	runtimeTaskDiagnosticsActionRequestSchema,
	runtimeTaskDiagnosticsActionResponseSchema,
	runtimeTaskDiagnosticsRequestSchema,
	runtimeTaskDiagnosticsResponseSchema,
	runtimeTaskDispatchReconcileResponseSchema,
	runtimeTaskDispatchRunResponseSchema,
	runtimeTaskDispatchStatusResponseSchema,
	runtimeTaskInitialStartStatusRequestSchema,
	runtimeTaskInitialStartStatusResponseSchema,
	runtimeTaskMergeBindingUpdateRequestSchema,
	runtimeTaskPhasesRequestSchema,
	runtimeTaskPhasesResponseSchema,
	runtimeTaskPreservationInfoResponseSchema,
	runtimeTaskPreservationRequestSchema,
	runtimeTaskPrSettingsRequestSchema,
	runtimeTaskPrSettingsResponseSchema,
	runtimeTaskPrTrackingResumeRequestSchema,
	runtimeTaskPrTrackingResumeResponseSchema,
	runtimeTaskPullRequestLinkRequestSchema,
	runtimeTaskPullRequestLinkResponseSchema,
	runtimeTaskPullRequestPrimaryRequestSchema,
	runtimeTaskPullRequestsRefreshRequestSchema,
	runtimeTaskPullRequestsRefreshResponseSchema,
	runtimeTaskReviewInfoRequestSchema,
	runtimeTaskReviewInfoResponseSchema,
	runtimeTaskReviewStartRequestSchema,
	runtimeTaskReviewStartResponseSchema,
	runtimeTaskSessionInputRequestSchema,
	runtimeTaskSessionInputResponseSchema,
	runtimeTaskSessionStartRequestSchema,
	runtimeTaskSessionStartResponseSchema,
	runtimeTaskSessionStopRequestSchema,
	runtimeTaskSessionStopResponseSchema,
	runtimeTaskTrackingStateRequestSchema,
	runtimeTaskTrackingStateResponseSchema,
	runtimeTaskWorkspaceInfoRequestSchema,
	runtimeTaskWorkspaceInfoResponseSchema,
	runtimeTaskWorkspaceMaintenanceReportSchema,
	runtimeTaskWorktreeRecoverResponseSchema,
	runtimeUpdateStatusResponseSchema,
	runtimeWorkspaceChangesRequestSchema,
	runtimeWorkspaceChangesResponseSchema,
	runtimeWorkspaceFileSearchRequestSchema,
	runtimeWorkspaceFileSearchResponseSchema,
	runtimeWorkspaceStateNotifyResponseSchema,
	runtimeWorkspaceStateResponseSchema,
	runtimeWorkspaceStateSaveRequestSchema,
	runtimeWorktreeDeleteRequestSchema,
	runtimeWorktreeDeleteResponseSchema,
	runtimeWorktreeEnsureRequestSchema,
	runtimeWorktreeEnsureResponseSchema,
} from "../core/api-contract";

export interface RuntimeTrpcWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}

export interface RuntimeTrpcContext {
	requestedWorkspaceId: string | null;
	workspaceScope: RuntimeTrpcWorkspaceScope | null;
	runtimeApi: {
		loadConfig: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeConfigResponse>;
		saveConfig: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeConfigSaveRequest,
		) => Promise<RuntimeConfigResponse>;
		saveClineProviderSettings: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineProviderSettingsSaveRequest,
		) => Promise<RuntimeClineProviderSettingsSaveResponse>;
		addClineProvider: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineAddProviderRequest,
		) => Promise<RuntimeClineAddProviderResponse>;
		updateClineProvider: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineUpdateProviderRequest,
		) => Promise<RuntimeClineUpdateProviderResponse>;
		startTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStartRequest,
		) => Promise<RuntimeTaskSessionStartResponse>;
		/** UPD-0: pollable initial-start preparation status (live stage or durable outcome). */
		getTaskInitialStartStatus: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskInitialStartStatusRequest,
		) => Promise<RuntimeTaskInitialStartStatusResponse>;
		startTaskReview: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskReviewStartRequest,
		) => Promise<RuntimeTaskReviewStartResponse>;
		getTaskReviewInfo: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskReviewInfoRequest,
		) => Promise<RuntimeTaskReviewInfoResponse>;
		startTaskDelivery: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskDeliveryStartRequest,
		) => Promise<RuntimeTaskDeliveryStartResponse>;
		getTaskDeliveryInfo: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskDeliveryInfoRequest,
		) => Promise<RuntimeTaskDeliveryInfoResponse>;
		/** B-10.2: aggregated task diagnostics (phase, delivery, review, dispatch, preservation, context). */
		getTaskDiagnostics: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskDiagnosticsRequest,
		) => Promise<RuntimeTaskDiagnosticsResponse>;
		/** B-10.3: run an operator action (retry/resume/cancel/recover) with in-flight dedup. */
		runTaskDiagnosticsAction: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskDiagnosticsActionRequest,
		) => Promise<RuntimeTaskDiagnosticsActionResponse>;
		/** B-10.1: batched phase summaries for board chips. */
		getTaskPhases: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskPhasesRequest,
		) => Promise<RuntimeTaskPhasesResponse>;
		/** B-10.7: write the redacted diagnostic bundle to disk. */
		exportTaskDiagnostics: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeDiagnosticsExportRequest,
		) => Promise<RuntimeDiagnosticsExportResponse>;
		/** B-9: backend-owned sequential task dispatch — run one queue pass for this workspace. */
		dispatchReadyTasks: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeTaskDispatchRunResponse>;
		/** B-9: read-only queue status (ready/blocked tasks, active worker, dispatch records). */
		getDispatchStatus: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeTaskDispatchStatusResponse>;
		/** B-9.6: restart reconciliation — relaunch dispatched tasks that lost their session. */
		reconcileTaskDispatch: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeTaskDispatchReconcileResponse>;
		returnQueuedTaskToBacklog: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStopRequest,
		) => Promise<RuntimeTaskSessionStopResponse>;
		stopTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStopRequest,
		) => Promise<RuntimeTaskSessionStopResponse>;
		sendTaskSessionInput: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionInputRequest,
		) => Promise<RuntimeTaskSessionInputResponse>;
		getTaskChatMessages: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatMessagesRequest,
		) => Promise<RuntimeTaskChatMessagesResponse>;
		getClineSlashCommands: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeSlashCommandsResponse>;
		sendTaskChatMessage: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatSendRequest,
		) => Promise<RuntimeTaskChatSendResponse>;
		reloadTaskChatSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatReloadRequest,
		) => Promise<RuntimeTaskChatReloadResponse>;
		abortTaskChatTurn: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatAbortRequest,
		) => Promise<RuntimeTaskChatAbortResponse>;
		cancelTaskChatTurn: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatCancelRequest,
		) => Promise<RuntimeTaskChatCancelResponse>;
		getClineProviderCatalog: (
			scope: RuntimeTrpcWorkspaceScope | null,
		) => Promise<RuntimeClineProviderCatalogResponse>;
		getClineAccountProfile: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeClineAccountProfileResponse>;
		getClineKanbanAccess: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeClineKanbanAccessResponse>;
		getFeaturebaseToken: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeFeaturebaseTokenResponse>;
		getClineAccountBalance: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeClineAccountBalanceResponse>;
		getClineAccountOrganizations: (
			scope: RuntimeTrpcWorkspaceScope | null,
		) => Promise<RuntimeClineAccountOrganizationsResponse>;
		switchClineAccount: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineAccountSwitchRequest,
		) => Promise<RuntimeClineAccountSwitchResponse>;
		getClineProviderModels: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineProviderModelsRequest,
		) => Promise<RuntimeClineProviderModelsResponse>;
		runClineProviderOAuthLogin: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineOauthLoginRequest,
		) => Promise<RuntimeClineOauthLoginResponse>;
		startClineDeviceAuth: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeClineDeviceAuthStartResponse>;
		completeClineDeviceAuth: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineDeviceAuthCompleteRequest,
		) => Promise<RuntimeClineDeviceAuthCompleteResponse>;
		getClineMcpAuthStatuses: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeClineMcpAuthStatusResponse>;
		runClineMcpServerOAuth: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineMcpOAuthRequest,
		) => Promise<RuntimeClineMcpOAuthResponse>;
		getClineMcpSettings: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeClineMcpSettingsResponse>;
		saveClineMcpSettings: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineMcpSettingsSaveRequest,
		) => Promise<RuntimeClineMcpSettingsSaveResponse>;
		startShellSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeShellSessionStartRequest,
		) => Promise<RuntimeShellSessionStartResponse>;
		runCommand: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeCommandRunRequest,
		) => Promise<RuntimeCommandRunResponse>;
		resetAllState: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeDebugResetAllStateResponse>;
		openFile: (input: RuntimeOpenFileRequest) => Promise<RuntimeOpenFileResponse>;
		getUpdateStatus: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeUpdateStatusResponse>;
		runUpdateNow: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeRunUpdateResponse>;
	};
	workspaceApi: {
		loadGitSummary: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitSummaryResponse>;
		runGitSyncAction: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { action: RuntimeGitSyncAction },
		) => Promise<RuntimeGitSyncResponse>;
		checkoutGitBranch: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCheckoutRequest,
		) => Promise<RuntimeGitCheckoutResponse>;
		discardGitChanges: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitDiscardResponse>;
		loadChanges: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceChangesRequest,
		) => Promise<RuntimeWorkspaceChangesResponse>;
		ensureWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorktreeEnsureRequest,
		) => Promise<RuntimeWorktreeEnsureResponse>;
		deleteWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorktreeDeleteRequest,
		) => Promise<RuntimeWorktreeDeleteResponse>;
		getTaskPreservationInfo: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskPreservationRequest,
		) => Promise<RuntimeTaskPreservationInfoResponse>;
		recoverTaskWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskPreservationRequest,
		) => Promise<RuntimeTaskWorktreeRecoverResponse>;
		runTaskWorkspaceMaintenance: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeTaskWorkspaceMaintenanceReport>;
		listBlockedTaskCleanups: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeBlockedTaskCleanupsResponse>;
		loadTaskContext: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest,
		) => Promise<RuntimeTaskWorkspaceInfoResponse>;
		searchFiles: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceFileSearchRequest,
		) => Promise<RuntimeWorkspaceFileSearchResponse>;
		loadState: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceStateResponse>;
		notifyStateUpdated: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceStateNotifyResponse>;
		saveState: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceStateSaveRequest,
		) => Promise<RuntimeWorkspaceStateResponse>;
		loadWorkspaceChanges: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceChangesResponse>;
		loadGitLog: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeGitLogRequest) => Promise<RuntimeGitLogResponse>;
		loadGitRefs: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitRefsResponse>;
		loadCommitDiff: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCommitDiffRequest,
		) => Promise<RuntimeGitCommitDiffResponse>;
		/** PRLINK-5: manually link a PR URL to a task (source: "manual"). */
		addTaskPullRequest: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskPullRequestLinkRequest,
		) => Promise<RuntimeTaskPullRequestLinkResponse>;
		/** PRLINK-5: manually remove a recorded PR link from a task. */
		removeTaskPullRequest: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskPullRequestLinkRequest,
		) => Promise<RuntimeTaskPullRequestLinkResponse>;
		/** PRLINK-6: set (url) or clear (null) the display-only explicit primary. */
		setPrimaryTaskPullRequest: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskPullRequestPrimaryRequest,
		) => Promise<RuntimeTaskPullRequestLinkResponse>;
		/** PRLINK-5: re-run the branch lookup for a task (opt-in refresh). */
		refreshTaskPullRequests: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskPullRequestsRefreshRequest,
		) => Promise<RuntimeTaskPullRequestsRefreshResponse>;
	};
	projectsApi: {
		listProjects: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectsResponse>;
		addProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectAddRequest,
		) => Promise<RuntimeProjectAddResponse>;
		removeProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectRemoveRequest,
		) => Promise<RuntimeProjectRemoveResponse>;
		pickProjectDirectory: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectDirectoryPickerResponse>;
		listDirectoryContents: (
			preferredWorkspaceId: string | null,
			input: RuntimeDirectoryListRequest,
		) => Promise<RuntimeDirectoryListResponse>;
	};
	hooksApi: {
		ingest: (input: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>;
	};
	prTrackingApi: {
		setTaskPrSettings: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskPrSettingsRequest,
		) => Promise<RuntimeTaskPrSettingsResponse>;
		selectTaskAutomationPr: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskAutomationPrSelectRequest,
		) => Promise<RuntimeTaskAutomationPrSelectResponse>;
		resumeTaskPrTracking: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskPrTrackingResumeRequest,
		) => Promise<RuntimeTaskPrTrackingResumeResponse>;
		getTaskTrackingState: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskTrackingStateRequest,
		) => Promise<RuntimeTaskTrackingStateResponse>;
		getTaskPrSnapshot: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimePrAuthorizedSnapshotRequest,
		) => Promise<RuntimePrAuthorizedSnapshotResponse>;
		refreshTaskPrSnapshot: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimePrSnapshotRefreshRequest,
		) => Promise<RuntimePrSnapshotRefreshResponse>;
		updateTaskCommentDispatch: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimePrCommentDispatchUpdateRequest,
		) => Promise<RuntimePrRecordMutationResponse>;
		updateTaskMergeBinding: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskMergeBindingUpdateRequest,
		) => Promise<RuntimePrRecordMutationResponse>;
		selectRepairOwner: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimePrRepairOwnerSelectRequest,
		) => Promise<RuntimePrRepairOwnerResponse>;
		transferRepairOwner: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimePrRepairOwnerTransferRequest,
		) => Promise<RuntimePrRepairOwnerResponse>;
		reservePrOperation: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimePrOperationReservationRequest,
		) => Promise<RuntimePrOperationReservationResponse>;
		validatePrOperation: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimePrOperationValidateRequest,
		) => Promise<RuntimePrOperationReservationResponse>;
		releasePrOperation: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimePrOperationReleaseRequest,
		) => Promise<RuntimePrOperationReservationResponse>;
		readPrSnapshotEvents: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimePrSubscriptionRequest,
		) => Promise<RuntimePrSubscriptionResponse>;
	};
}

interface RuntimeTrpcContextWithWorkspaceScope extends RuntimeTrpcContext {
	workspaceScope: RuntimeTrpcWorkspaceScope;
}

function readConflictRevision(cause: unknown): number | null {
	if (!cause || typeof cause !== "object" || !("currentRevision" in cause)) {
		return null;
	}
	const revision = (cause as { currentRevision?: unknown }).currentRevision;
	if (typeof revision !== "number") {
		return null;
	}
	return Number.isFinite(revision) ? revision : null;
}

const t = initTRPC.context<RuntimeTrpcContext>().create({
	errorFormatter({ shape, error }) {
		const conflictRevision = error.code === "CONFLICT" ? readConflictRevision(error.cause) : null;
		return {
			...shape,
			data: {
				...shape.data,
				conflictRevision,
			},
		};
	},
});

const workspaceProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.requestedWorkspaceId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Missing workspace scope. Include x-kanban-workspace-id header or workspaceId query parameter.",
		});
	}
	if (!ctx.workspaceScope) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Unknown workspace ID: ${ctx.requestedWorkspaceId}`,
		});
	}
	return next({
		ctx: {
			...ctx,
			workspaceScope: ctx.workspaceScope,
		} satisfies RuntimeTrpcContextWithWorkspaceScope,
	});
});

const optionalTaskWorkspaceInfoRequestSchema = runtimeTaskWorkspaceInfoRequestSchema.nullable().optional();
const gitSyncActionInputSchema = z.object({
	action: runtimeGitSyncActionSchema,
});

export const runtimeAppRouter = t.router({
	runtime: t.router({
		getConfig: t.procedure.output(runtimeConfigResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.loadConfig(ctx.workspaceScope);
		}),
		saveConfig: t.procedure
			.input(runtimeConfigSaveRequestSchema)
			.output(runtimeConfigResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveConfig(ctx.workspaceScope, input);
			}),
		saveClineProviderSettings: t.procedure
			.input(runtimeClineProviderSettingsSaveRequestSchema)
			.output(runtimeClineProviderSettingsSaveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveClineProviderSettings(ctx.workspaceScope, input);
			}),
		addClineProvider: t.procedure
			.input(runtimeClineAddProviderRequestSchema)
			.output(runtimeClineAddProviderResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.addClineProvider(ctx.workspaceScope, input);
			}),
		updateClineProvider: t.procedure
			.input(runtimeClineUpdateProviderRequestSchema)
			.output(runtimeClineUpdateProviderResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.updateClineProvider(ctx.workspaceScope, input);
			}),
		startTaskSession: workspaceProcedure
			.input(runtimeTaskSessionStartRequestSchema)
			.output(runtimeTaskSessionStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.startTaskSession(ctx.workspaceScope, input);
			}),
		// UPD-0: pollable initial-start preparation status.
		taskInitialStartStatus: workspaceProcedure
			.input(runtimeTaskInitialStartStatusRequestSchema)
			.output(runtimeTaskInitialStartStatusResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getTaskInitialStartStatus(ctx.workspaceScope, input);
			}),
		startTaskReview: workspaceProcedure
			.input(runtimeTaskReviewStartRequestSchema)
			.output(runtimeTaskReviewStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.startTaskReview(ctx.workspaceScope, input);
			}),
		getTaskReviewInfo: workspaceProcedure
			.input(runtimeTaskReviewInfoRequestSchema)
			.output(runtimeTaskReviewInfoResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getTaskReviewInfo(ctx.workspaceScope, input);
			}),
		// B-8: deterministic git delivery (commit → integrate → push → verify →
		// receipt), application-controlled and independent of model availability.
		startTaskDelivery: workspaceProcedure
			.input(runtimeTaskDeliveryStartRequestSchema)
			.output(runtimeTaskDeliveryStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.startTaskDelivery(ctx.workspaceScope, input);
			}),
		getTaskDeliveryInfo: workspaceProcedure
			.input(runtimeTaskDeliveryInfoRequestSchema)
			.output(runtimeTaskDeliveryInfoResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getTaskDeliveryInfo(ctx.workspaceScope, input);
			}),
		// B-10: operational controls & diagnostics.
		getTaskDiagnostics: workspaceProcedure
			.input(runtimeTaskDiagnosticsRequestSchema)
			.output(runtimeTaskDiagnosticsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getTaskDiagnostics(ctx.workspaceScope, input);
			}),
		runTaskDiagnosticsAction: workspaceProcedure
			.input(runtimeTaskDiagnosticsActionRequestSchema)
			.output(runtimeTaskDiagnosticsActionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.runTaskDiagnosticsAction(ctx.workspaceScope, input);
			}),
		getTaskPhases: workspaceProcedure
			.input(runtimeTaskPhasesRequestSchema)
			.output(runtimeTaskPhasesResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getTaskPhases(ctx.workspaceScope, input);
			}),
		exportTaskDiagnostics: workspaceProcedure
			.input(runtimeDiagnosticsExportRequestSchema)
			.output(runtimeDiagnosticsExportResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.exportTaskDiagnostics(ctx.workspaceScope, input);
			}),
		// B-9: backend-owned sequential task dispatch ("reliable queue").
		dispatchReadyTasks: workspaceProcedure.output(runtimeTaskDispatchRunResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.runtimeApi.dispatchReadyTasks(ctx.workspaceScope);
		}),
		getDispatchStatus: workspaceProcedure.output(runtimeTaskDispatchStatusResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getDispatchStatus(ctx.workspaceScope);
		}),
		reconcileTaskDispatch: workspaceProcedure
			.output(runtimeTaskDispatchReconcileResponseSchema)
			.mutation(async ({ ctx }) => {
				return await ctx.runtimeApi.reconcileTaskDispatch(ctx.workspaceScope);
			}),
		returnQueuedTaskToBacklog: workspaceProcedure
			.input(runtimeTaskSessionStopRequestSchema)
			.output(runtimeTaskSessionStopResponseSchema)
			.mutation(async ({ ctx, input }) => ctx.runtimeApi.returnQueuedTaskToBacklog(ctx.workspaceScope, input)),
		stopTaskSession: workspaceProcedure
			.input(runtimeTaskSessionStopRequestSchema)
			.output(runtimeTaskSessionStopResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.stopTaskSession(ctx.workspaceScope, input);
			}),
		sendTaskSessionInput: workspaceProcedure
			.input(runtimeTaskSessionInputRequestSchema)
			.output(runtimeTaskSessionInputResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.sendTaskSessionInput(ctx.workspaceScope, input);
			}),
		getTaskChatMessages: workspaceProcedure
			.input(runtimeTaskChatMessagesRequestSchema)
			.output(runtimeTaskChatMessagesResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getTaskChatMessages(ctx.workspaceScope, input);
			}),
		getClineSlashCommands: t.procedure.output(runtimeSlashCommandsResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineSlashCommands(ctx.workspaceScope);
		}),
		reloadTaskChatSession: workspaceProcedure
			.input(runtimeTaskChatReloadRequestSchema)
			.output(runtimeTaskChatReloadResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.reloadTaskChatSession(ctx.workspaceScope, input);
			}),
		sendTaskChatMessage: workspaceProcedure
			.input(runtimeTaskChatSendRequestSchema)
			.output(runtimeTaskChatSendResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.sendTaskChatMessage(ctx.workspaceScope, input);
			}),
		abortTaskChatTurn: workspaceProcedure
			.input(runtimeTaskChatAbortRequestSchema)
			.output(runtimeTaskChatAbortResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.abortTaskChatTurn(ctx.workspaceScope, input);
			}),
		cancelTaskChatTurn: workspaceProcedure
			.input(runtimeTaskChatCancelRequestSchema)
			.output(runtimeTaskChatCancelResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.cancelTaskChatTurn(ctx.workspaceScope, input);
			}),
		getClineProviderCatalog: t.procedure.output(runtimeClineProviderCatalogResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineProviderCatalog(ctx.workspaceScope);
		}),
		getClineAccountProfile: t.procedure.output(runtimeClineAccountProfileResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineAccountProfile(ctx.workspaceScope);
		}),
		getClineKanbanAccess: t.procedure.output(runtimeClineKanbanAccessResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineKanbanAccess(ctx.workspaceScope);
		}),
		getFeaturebaseToken: t.procedure.output(runtimeFeaturebaseTokenResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getFeaturebaseToken(ctx.workspaceScope);
		}),
		getClineAccountBalance: t.procedure.output(runtimeClineAccountBalanceResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineAccountBalance(ctx.workspaceScope);
		}),
		getClineAccountOrganizations: t.procedure
			.output(runtimeClineAccountOrganizationsResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.getClineAccountOrganizations(ctx.workspaceScope);
			}),
		switchClineAccount: t.procedure
			.input(runtimeClineAccountSwitchRequestSchema)
			.output(runtimeClineAccountSwitchResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.switchClineAccount(ctx.workspaceScope, input);
			}),
		getClineProviderModels: t.procedure
			.input(runtimeClineProviderModelsRequestSchema)
			.output(runtimeClineProviderModelsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getClineProviderModels(ctx.workspaceScope, input);
			}),
		getClineMcpAuthStatuses: t.procedure.output(runtimeClineMcpAuthStatusResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineMcpAuthStatuses(ctx.workspaceScope);
		}),
		runClineMcpServerOAuth: t.procedure
			.input(runtimeClineMcpOAuthRequestSchema)
			.output(runtimeClineMcpOAuthResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.runClineMcpServerOAuth(ctx.workspaceScope, input);
			}),
		getClineMcpSettings: t.procedure.output(runtimeClineMcpSettingsResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineMcpSettings(ctx.workspaceScope);
		}),
		saveClineMcpSettings: t.procedure
			.input(runtimeClineMcpSettingsSaveRequestSchema)
			.output(runtimeClineMcpSettingsSaveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveClineMcpSettings(ctx.workspaceScope, input);
			}),
		runClineProviderOAuthLogin: t.procedure
			.input(runtimeClineOauthLoginRequestSchema)
			.output(runtimeClineOauthLoginResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.runClineProviderOAuthLogin(ctx.workspaceScope, input);
			}),
		startClineDeviceAuth: t.procedure.output(runtimeClineDeviceAuthStartResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.runtimeApi.startClineDeviceAuth(ctx.workspaceScope);
		}),
		completeClineDeviceAuth: t.procedure
			.input(runtimeClineDeviceAuthCompleteRequestSchema)
			.output(runtimeClineDeviceAuthCompleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.completeClineDeviceAuth(ctx.workspaceScope, input);
			}),
		startShellSession: workspaceProcedure
			.input(runtimeShellSessionStartRequestSchema)
			.output(runtimeShellSessionStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.startShellSession(ctx.workspaceScope, input);
			}),
		runCommand: workspaceProcedure
			.input(runtimeCommandRunRequestSchema)
			.output(runtimeCommandRunResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.runCommand(ctx.workspaceScope, input);
			}),
		resetAllState: t.procedure.output(runtimeDebugResetAllStateResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.runtimeApi.resetAllState(ctx.workspaceScope);
		}),
		openFile: t.procedure
			.input(runtimeOpenFileRequestSchema)
			.output(runtimeOpenFileResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.openFile(input);
			}),
		getUpdateStatus: t.procedure.output(runtimeUpdateStatusResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getUpdateStatus(ctx.workspaceScope);
		}),
		runUpdateNow: t.procedure.output(runtimeRunUpdateResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.runtimeApi.runUpdateNow(ctx.workspaceScope);
		}),
	}),
	workspace: t.router({
		getGitSummary: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitSummaryResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitSummary(ctx.workspaceScope, input ?? null);
			}),
		runGitSyncAction: workspaceProcedure
			.input(gitSyncActionInputSchema)
			.output(runtimeGitSyncResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.runGitSyncAction(ctx.workspaceScope, input);
			}),
		checkoutGitBranch: workspaceProcedure
			.input(runtimeGitCheckoutRequestSchema)
			.output(runtimeGitCheckoutResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.checkoutGitBranch(ctx.workspaceScope, input);
			}),
		discardGitChanges: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitDiscardResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.discardGitChanges(ctx.workspaceScope, input ?? null);
			}),
		getChanges: workspaceProcedure
			.input(runtimeWorkspaceChangesRequestSchema)
			.output(runtimeWorkspaceChangesResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadChanges(ctx.workspaceScope, input);
			}),
		ensureWorktree: workspaceProcedure
			.input(runtimeWorktreeEnsureRequestSchema)
			.output(runtimeWorktreeEnsureResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.ensureWorktree(ctx.workspaceScope, input);
			}),
		deleteWorktree: workspaceProcedure
			.input(runtimeWorktreeDeleteRequestSchema)
			.output(runtimeWorktreeDeleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.deleteWorktree(ctx.workspaceScope, input);
			}),
		getTaskPreservationInfo: workspaceProcedure
			.input(runtimeTaskPreservationRequestSchema)
			.output(runtimeTaskPreservationInfoResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.getTaskPreservationInfo(ctx.workspaceScope, input);
			}),
		recoverTaskWorktree: workspaceProcedure
			.input(runtimeTaskPreservationRequestSchema)
			.output(runtimeTaskWorktreeRecoverResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.recoverTaskWorktree(ctx.workspaceScope, input);
			}),
		// B-5.7/B-5.9: retry blocked trash cleanups, dispose delivered Done
		// worktrees, and apply preservation retention.
		runTaskWorkspaceMaintenance: workspaceProcedure
			.output(runtimeTaskWorkspaceMaintenanceReportSchema)
			.mutation(async ({ ctx }) => {
				return await ctx.workspaceApi.runTaskWorkspaceMaintenance(ctx.workspaceScope);
			}),
		listBlockedTaskCleanups: workspaceProcedure
			.output(runtimeBlockedTaskCleanupsResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.workspaceApi.listBlockedTaskCleanups(ctx.workspaceScope);
			}),
		getTaskContext: workspaceProcedure
			.input(runtimeTaskWorkspaceInfoRequestSchema)
			.output(runtimeTaskWorkspaceInfoResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadTaskContext(ctx.workspaceScope, input);
			}),
		searchFiles: workspaceProcedure
			.input(runtimeWorkspaceFileSearchRequestSchema)
			.output(runtimeWorkspaceFileSearchResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.searchFiles(ctx.workspaceScope, input);
			}),
		getState: workspaceProcedure.output(runtimeWorkspaceStateResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.loadState(ctx.workspaceScope);
		}),
		notifyStateUpdated: workspaceProcedure
			.output(runtimeWorkspaceStateNotifyResponseSchema)
			.mutation(async ({ ctx }) => {
				return await ctx.workspaceApi.notifyStateUpdated(ctx.workspaceScope);
			}),
		saveState: workspaceProcedure
			.input(runtimeWorkspaceStateSaveRequestSchema)
			.output(runtimeWorkspaceStateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.saveState(ctx.workspaceScope, input);
			}),
		// PRLINK-5: manual PR link management (add/remove/refresh).
		addTaskPullRequest: workspaceProcedure
			.input(runtimeTaskPullRequestLinkRequestSchema)
			.output(runtimeTaskPullRequestLinkResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.addTaskPullRequest(ctx.workspaceScope, input);
			}),
		removeTaskPullRequest: workspaceProcedure
			.input(runtimeTaskPullRequestLinkRequestSchema)
			.output(runtimeTaskPullRequestLinkResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.removeTaskPullRequest(ctx.workspaceScope, input);
			}),
		// PRLINK-6: explicit display-only primary (url: null clears it).
		setPrimaryTaskPullRequest: workspaceProcedure
			.input(runtimeTaskPullRequestPrimaryRequestSchema)
			.output(runtimeTaskPullRequestLinkResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.setPrimaryTaskPullRequest(ctx.workspaceScope, input);
			}),
		refreshTaskPullRequests: workspaceProcedure
			.input(runtimeTaskPullRequestsRefreshRequestSchema)
			.output(runtimeTaskPullRequestsRefreshResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.refreshTaskPullRequests(ctx.workspaceScope, input);
			}),
		getWorkspaceChanges: workspaceProcedure.output(runtimeWorkspaceChangesResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.loadWorkspaceChanges(ctx.workspaceScope);
		}),
		getGitLog: workspaceProcedure
			.input(runtimeGitLogRequestSchema)
			.output(runtimeGitLogResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitLog(ctx.workspaceScope, input);
			}),
		getGitRefs: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitRefsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitRefs(ctx.workspaceScope, input ?? null);
			}),
		getCommitDiff: workspaceProcedure
			.input(runtimeGitCommitDiffRequestSchema)
			.output(runtimeGitCommitDiffResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadCommitDiff(ctx.workspaceScope, input);
			}),
		// PRTRACK-1: the frozen consumer API for PR-driven task workflows.
		prTracking: t.router({
			setTaskPrSettings: workspaceProcedure
				.input(runtimeTaskPrSettingsRequestSchema)
				.output(runtimeTaskPrSettingsResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.setTaskPrSettings(ctx.workspaceScope, input);
				}),
			selectTaskAutomationPr: workspaceProcedure
				.input(runtimeTaskAutomationPrSelectRequestSchema)
				.output(runtimeTaskAutomationPrSelectResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.selectTaskAutomationPr(ctx.workspaceScope, input);
				}),
			resumeTaskPrTracking: workspaceProcedure
				.input(runtimeTaskPrTrackingResumeRequestSchema)
				.output(runtimeTaskPrTrackingResumeResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.resumeTaskPrTracking(ctx.workspaceScope, input);
				}),
			getTaskTrackingState: workspaceProcedure
				.input(runtimeTaskTrackingStateRequestSchema)
				.output(runtimeTaskTrackingStateResponseSchema)
				.query(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.getTaskTrackingState(ctx.workspaceScope, input);
				}),
			getTaskPrSnapshot: workspaceProcedure
				.input(runtimePrAuthorizedSnapshotRequestSchema)
				.output(runtimePrAuthorizedSnapshotResponseSchema)
				.query(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.getTaskPrSnapshot(ctx.workspaceScope, input);
				}),
			refreshTaskPrSnapshot: workspaceProcedure
				.input(runtimePrSnapshotRefreshRequestSchema)
				.output(runtimePrSnapshotRefreshResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.refreshTaskPrSnapshot(ctx.workspaceScope, input);
				}),
			updateTaskCommentDispatch: workspaceProcedure
				.input(runtimePrCommentDispatchUpdateRequestSchema)
				.output(runtimePrRecordMutationResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.updateTaskCommentDispatch(ctx.workspaceScope, input);
				}),
			updateTaskMergeBinding: workspaceProcedure
				.input(runtimeTaskMergeBindingUpdateRequestSchema)
				.output(runtimePrRecordMutationResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.updateTaskMergeBinding(ctx.workspaceScope, input);
				}),
			selectRepairOwner: workspaceProcedure
				.input(runtimePrRepairOwnerSelectRequestSchema)
				.output(runtimePrRepairOwnerResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.selectRepairOwner(ctx.workspaceScope, input);
				}),
			transferRepairOwner: workspaceProcedure
				.input(runtimePrRepairOwnerTransferRequestSchema)
				.output(runtimePrRepairOwnerResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.transferRepairOwner(ctx.workspaceScope, input);
				}),
			reservePrOperation: workspaceProcedure
				.input(runtimePrOperationReservationRequestSchema)
				.output(runtimePrOperationReservationResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.reservePrOperation(ctx.workspaceScope, input);
				}),
			validatePrOperation: workspaceProcedure
				.input(runtimePrOperationValidateRequestSchema)
				.output(runtimePrOperationReservationResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.validatePrOperation(ctx.workspaceScope, input);
				}),
			releasePrOperation: workspaceProcedure
				.input(runtimePrOperationReleaseRequestSchema)
				.output(runtimePrOperationReservationResponseSchema)
				.mutation(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.releasePrOperation(ctx.workspaceScope, input);
				}),
			readPrSnapshotEvents: workspaceProcedure
				.input(runtimePrSubscriptionRequestSchema)
				.output(runtimePrSubscriptionResponseSchema)
				.query(async ({ ctx, input }) => {
					return await ctx.prTrackingApi.readPrSnapshotEvents(ctx.workspaceScope, input);
				}),
		}),
	}),
	projects: t.router({
		list: t.procedure.output(runtimeProjectsResponseSchema).query(async ({ ctx }) => {
			return await ctx.projectsApi.listProjects(ctx.requestedWorkspaceId);
		}),
		add: t.procedure
			.input(runtimeProjectAddRequestSchema)
			.output(runtimeProjectAddResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.projectsApi.addProject(ctx.requestedWorkspaceId, input);
			}),
		remove: t.procedure
			.input(runtimeProjectRemoveRequestSchema)
			.output(runtimeProjectRemoveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.projectsApi.removeProject(ctx.requestedWorkspaceId, input);
			}),
		pickDirectory: t.procedure.output(runtimeProjectDirectoryPickerResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.projectsApi.pickProjectDirectory(ctx.requestedWorkspaceId);
		}),
		listDirectoryContents: t.procedure
			.input(runtimeDirectoryListRequestSchema)
			.output(runtimeDirectoryListResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.projectsApi.listDirectoryContents(ctx.requestedWorkspaceId, input);
			}),
	}),
	hooks: t.router({
		ingest: t.procedure
			.input(runtimeHookIngestRequestSchema)
			.output(runtimeHookIngestResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.hooksApi.ingest(input);
			}),
	}),
});

export type RuntimeAppRouter = typeof runtimeAppRouter;
export type RuntimeAppRouterInputs = inferRouterInputs<RuntimeAppRouter>;
export type RuntimeAppRouterOutputs = inferRouterOutputs<RuntimeAppRouter>;
