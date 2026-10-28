// Layout component for the native Cline chat panel.
// Rendering lives here, while session state and action wiring come from the
// controller hook so multiple surfaces can share the same behavior.

import { AlertTriangle } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import React, {
	type ReactElement,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ClineChatComposer } from "@/components/detail-panels/cline-chat-composer";
import { ClineChatMessageItem } from "@/components/detail-panels/cline-chat-message-item";
import { getCompletedAssistantMessageId } from "@/components/detail-panels/cline-chat-message-utils";
import { ClineChatPrLinkNotice } from "@/components/detail-panels/cline-chat-pr-link-notice";
import {
	buildClineAgentModelPickerOptions,
	buildClineSelectedModelButtonText,
	getClineReasoningEnabledModelIds,
} from "@/components/detail-panels/cline-model-picker-options";
import { ClineThinkingIndicator } from "@/components/detail-panels/cline-thinking-indicator";
import { Button } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { Spinner } from "@/components/ui/spinner";
import { useClineChatPanelController } from "@/hooks/use-cline-chat-panel-controller";
import type { ClineChatActionResult } from "@/hooks/use-cline-chat-runtime-actions";
import type { ClineChatMessage } from "@/hooks/use-cline-chat-session";
import { useRuntimeSettingsClineController } from "@/hooks/use-runtime-settings-cline-controller";
import type {
	RuntimeClineReasoningEffort,
	RuntimeConfigResponse,
	RuntimeTaskClineSettings,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import type { TaskImage } from "@/types";

const BOTTOM_LOCK_THRESHOLD_PX = 24;
// Keep the existing, simpler DOM for short chats and virtualize larger histories.
// This avoids mounting hundreds of Markdown/tool components on mobile.
export const CHAT_VIRTUALIZATION_THRESHOLD = 80;

type VirtualChatFooterContext = {
	showThinking: boolean;
	showCreditLimit: boolean;
};

function VirtualChatHeader(): ReactElement {
	return <div className="h-3" aria-hidden="true" />;
}

function VirtualChatFooter({ context }: { context?: VirtualChatFooterContext }): ReactElement {
	return (
		<div className="px-2 pb-3">
			{context?.showThinking ? <ClineThinkingIndicator /> : null}
			{context?.showCreditLimit ? <ClineCreditLimitNotice /> : null}
		</div>
	);
}

const VIRTUAL_CHAT_COMPONENTS = { Header: VirtualChatHeader, Footer: VirtualChatFooter };

const VirtualChatMessageRow = React.memo(function VirtualChatMessageRow({
	message,
	isCompletedResponse,
	expanded,
	onExpandedChange,
}: {
	message: ClineChatMessage;
	isCompletedResponse: boolean;
	expanded: boolean;
	onExpandedChange: (id: string, expanded: boolean) => void;
}): ReactElement {
	const handleExpandedChange = useCallback(
		(next: boolean) => onExpandedChange(message.id, next),
		[message.id, onExpandedChange],
	);
	return (
		<div className="px-2 pb-2" data-testid="virtual-chat-message">
			<ClineChatMessageItem
				message={message}
				isCompletedResponse={isCompletedResponse}
				expanded={expanded}
				onExpandedChange={handleExpandedChange}
			/>
		</div>
	);
});
const CLINE_BUY_CREDITS_URL = "https://app.cline.bot/";

const ClineCreditLimitNotice = React.memo(function ClineCreditLimitNotice() {
	return (
		<div className="mx-1 flex items-start gap-2 rounded-md border border-status-orange/40 bg-status-orange/10 px-3 py-2 text-xs text-status-orange">
			<AlertTriangle size={14} className="mt-0.5 shrink-0" />
			<p className="m-0 min-w-0">
				Out of Cline credits.{" "}
				<Link href={CLINE_BUY_CREDITS_URL} external>
					Buy more credits
				</Link>{" "}
				to continue.
			</p>
		</div>
	);
});

export interface ClineAgentChatPanelHandle {
	appendToDraft: (text: string) => void;
	sendText: (text: string) => Promise<void>;
}

export interface ClineAgentChatPanelProps {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null;
	taskColumnId?: string;
	defaultMode?: RuntimeTaskSessionMode;
	composerPlaceholder?: string;
	showComposerModeToggle?: boolean;
	workspaceId?: string | null;
	runtimeConfig?: RuntimeConfigResponse | null;
	taskClineSettings?: RuntimeTaskClineSettings;
	taskHasExplicitClineSettings?: boolean;
	onClineSettingsSaved?: () => void;
	onTaskClineSettingsChanged?: (settings: {
		providerId: string;
		modelId: string;
		reasoningEffort: RuntimeClineReasoningEffort | "";
	}) => void;
	onSendMessage?: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: TaskImage[] },
	) => Promise<ClineChatActionResult>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<ClineChatMessage[] | null>;
	incomingMessages?: ClineChatMessage[] | null;
	incomingMessage?: ClineChatMessage | null;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	onMoveToTrash?: () => void;
	onComplete?: () => void;
	isMoveToTrashLoading?: boolean;
	isCompleteLoading?: boolean;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
	showComplete?: boolean;
}

export const ClineAgentChatPanel = React.forwardRef<ClineAgentChatPanelHandle, ClineAgentChatPanelProps>(
	function ClineAgentChatPanel(
		{
			taskId,
			summary,
			taskColumnId = "in_progress",
			defaultMode = "act",
			composerPlaceholder = "Ask Cline to add, edit, start, or link tasks",
			showComposerModeToggle = true,
			workspaceId = null,
			runtimeConfig = null,
			taskClineSettings,
			taskHasExplicitClineSettings = false,
			onClineSettingsSaved,
			onTaskClineSettingsChanged,
			onSendMessage,
			onCancelTurn,
			onLoadMessages,
			incomingMessages,
			incomingMessage,
			onCommit,
			onOpenPr,
			isCommitLoading = false,
			isOpenPrLoading = false,
			onMoveToTrash,
			onComplete,
			isMoveToTrashLoading = false,
			isCompleteLoading = false,
			onCancelAutomaticAction,
			cancelAutomaticActionLabel,
			showMoveToTrash = false,
			showComplete = false,
		},
		ref,
	): ReactElement {
		const {
			draft,
			setDraft,
			messages,
			error,
			isSending,
			canSend,
			canCancel,
			showReviewActions,
			showAgentProgressIndicator,
			showActionFooter,
			showCancelAutomaticAction,
			prLinkingNotice,
			dismissPrLinkingNotice,
			handleSendText,
			handleSendDraft,
			handleCancelTurn,
		} = useClineChatPanelController({
			taskId,
			summary,
			taskColumnId,
			workspaceId,
			onSendMessage,
			onCancelTurn,
			onLoadMessages,
			incomingMessages,
			incomingMessage,
			onCommit,
			onOpenPr,
			onMoveToTrash,
			onCancelAutomaticAction,
			cancelAutomaticActionLabel,
			showMoveToTrash,
		});
		const scrollContainerRef = useRef<HTMLDivElement | null>(null);
		const virtuosoRef = useRef<VirtuosoHandle | null>(null);
		// Virtual rows unmount when scrolled away. Keep their expansion state here
		// rather than losing it when a row leaves the viewport.
		const [expandedMessages, setExpandedMessages] = useState<Map<string, boolean>>(() => new Map());
		const handleExpandedChange = useCallback((id: string, expanded: boolean) => {
			setExpandedMessages((previous) => {
				if (previous.get(id) === expanded) return previous;
				const next = new Map(previous);
				next.set(id, expanded);
				return next;
			});
		}, []);
		// Activate virtualization once a task reaches the threshold while the
		// reader is at the bottom. Deferring the switch while reading older
		// messages avoids replacing the scroller and losing their position.
		// Once activated, keep the virtualizer mounted for that task.
		const [virtualizedTaskId, setVirtualizedTaskId] = useState<string | null>(null);
		const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
		const usesVirtualizedMessages =
			virtualizedTaskId === taskId ||
			(messages.length >= CHAT_VIRTUALIZATION_THRESHOLD && isAutoScrollEnabled);
		// TODO: Persist per-task mode immediately when toggled so page refresh restores unsent mode changes.
		const modeByTaskIdRef = useRef<Map<string, RuntimeTaskSessionMode>>(new Map());
		const [composerError, setComposerError] = useState<string | null>(null);
		const [isSavingModel, setIsSavingModel] = useState(false);
		const isCreditLimitNoticeVisible = summary?.latestHookActivity?.notificationType === "credit_limit";
		const [mode, setMode] = useState<RuntimeTaskSessionMode>(() => {
			const persistedMode = modeByTaskIdRef.current.get(taskId);
			return persistedMode ?? summary?.mode ?? defaultMode;
		});
		const [draftImages, setDraftImages] = useState<TaskImage[]>([]);
		const clineSettings = useRuntimeSettingsClineController({
			open: true,
			workspaceId,
			selectedAgentId: "cline",
			config: runtimeConfig,
			taskClineSettings,
		});

		const modelPickerOptions = useMemo(
			() => buildClineAgentModelPickerOptions(clineSettings.providerId, clineSettings.providerModels),
			[clineSettings.providerId, clineSettings.providerModels],
		);
		const modelOptions = modelPickerOptions.options;

		const selectedModel = useMemo(
			() => clineSettings.providerModels.find((model) => model.id === clineSettings.modelId) ?? null,
			[clineSettings.modelId, clineSettings.providerModels],
		);
		const reasoningEnabledModelIds = useMemo(
			() => getClineReasoningEnabledModelIds(clineSettings.providerModels),
			[clineSettings.providerModels],
		);

		const selectedModelButtonText = useMemo(
			() =>
				buildClineSelectedModelButtonText({
					modelOptions,
					selectedModelId: clineSettings.modelId,
					reasoningEffort: clineSettings.reasoningEffort,
					showReasoningEffort: clineSettings.selectedModelSupportsReasoningEffort,
					isModelLoading: clineSettings.isLoadingProviderModels,
					isModelSaving: isSavingModel,
				}),
			[
				clineSettings.isLoadingProviderModels,
				clineSettings.modelId,
				clineSettings.reasoningEffort,
				clineSettings.selectedModelSupportsReasoningEffort,
				isSavingModel,
				modelOptions,
			],
		);

		const completedMessageId = getCompletedAssistantMessageId(messages, summary, taskColumnId);
		const panelError = composerError ?? error;
		const virtualFooterContext = useMemo(
			() => ({ showThinking: showAgentProgressIndicator, showCreditLimit: isCreditLimitNoticeVisible }),
			[showAgentProgressIndicator, isCreditLimitNoticeVisible],
		);
		const renderVirtualMessage = useCallback(
			(_index: number, message: ClineChatMessage) => (
				<VirtualChatMessageRow
					message={message}
					isCompletedResponse={message.id === completedMessageId}
					expanded={
						expandedMessages.get(message.id) ??
						(message.role === "reasoning" && message.meta?.hookEventName === "reasoning_delta")
					}
					onExpandedChange={handleExpandedChange}
				/>
			),
			[completedMessageId, expandedMessages, handleExpandedChange],
		);
		const getVirtualMessageKey = useCallback((_index: number, message: ClineChatMessage) => message.id, []);
		const handleVirtualAtBottom = useCallback((atBottom: boolean) => {
			setIsAutoScrollEnabled(atBottom);
		}, []);
		const followVirtualOutput = useCallback((atBottom: boolean) => {
			// Use Virtuoso's immediate internal value, not its throttled callback:
			// otherwise streaming can snap the reader back during upward scrolling.
			return atBottom ? "auto" : false;
		}, []);
		const handlePlainExpandedChange = useCallback(
			(id: string, expanded: boolean) => handleExpandedChange(id, expanded),
			[handleExpandedChange],
		);
		const attachmentWarningMessage =
			draftImages.length > 0 && selectedModel?.supportsVision === false
				? "The selected Cline model may not accept image input. Choose a vision-capable model to use these images."
				: null;

		const isPinnedToBottom = useCallback((container: HTMLDivElement): boolean => {
			const remainingDistance = container.scrollHeight - container.scrollTop - container.clientHeight;
			return remainingDistance <= BOTTOM_LOCK_THRESHOLD_PX;
		}, []);

		const handleMessageListScroll = useCallback(() => {
			const container = scrollContainerRef.current;
			if (!container) {
				return;
			}
			const nextIsAutoScrollEnabled = isPinnedToBottom(container);
			setIsAutoScrollEnabled((currentValue) =>
				currentValue === nextIsAutoScrollEnabled ? currentValue : nextIsAutoScrollEnabled,
			);
		}, [isPinnedToBottom]);

		useLayoutEffect(() => {
			const container = scrollContainerRef.current;
			if (usesVirtualizedMessages || !container || !isAutoScrollEnabled) {
				return;
			}
			container.scrollTop = container.scrollHeight;
		}, [
			isAutoScrollEnabled,
			usesVirtualizedMessages,
			messages,
			showAgentProgressIndicator,
			showActionFooter,
			showReviewActions,
			showCancelAutomaticAction,
		]);

		useEffect(() => {
			setComposerError(null);
		}, [taskId]);

		useEffect(() => {
			setIsAutoScrollEnabled(true);
			setExpandedMessages(new Map());
		}, [taskId]);

		useLayoutEffect(() => {
			if (virtualizedTaskId !== taskId && messages.length >= CHAT_VIRTUALIZATION_THRESHOLD && isAutoScrollEnabled) {
				setVirtualizedTaskId(taskId);
			}
		}, [isAutoScrollEnabled, messages.length, taskId, virtualizedTaskId]);

		// Size changes within the final streamed row do not append an item.
		// Virtuoso's autoscrollToBottom respects its internal scroll-up state,
		// unlike scrollToIndex(last) on every delta. Register before row
		// measurements to avoid tugging a reader away from older messages.
		useLayoutEffect(() => {
			if (!usesVirtualizedMessages) return;
			virtuosoRef.current?.autoscrollToBottom();
		}, [usesVirtualizedMessages, messages, showAgentProgressIndicator, isCreditLimitNoticeVisible]);

		useEffect(() => {
			const persistedMode = modeByTaskIdRef.current.get(taskId);
			const nextMode = persistedMode ?? summary?.mode ?? defaultMode;
			modeByTaskIdRef.current.set(taskId, nextMode);
			setMode(nextMode);
			setDraftImages([]);
		}, [defaultMode, summary?.mode, taskId]);

		const handleModeChange = useCallback(
			(nextMode: RuntimeTaskSessionMode) => {
				modeByTaskIdRef.current.set(taskId, nextMode);
				setMode(nextMode);
			},
			[taskId],
		);

		type PersistClineModelSettingsOverrides = {
			modelId?: string;
			reasoningEffort?: RuntimeClineReasoningEffort | "";
		};

		const persistClineModelSettings = useCallback(
			async (overrides?: PersistClineModelSettingsOverrides): Promise<boolean> => {
				if (!workspaceId) {
					setComposerError("Select a workspace before choosing a Cline model.");
					return false;
				}
				if (clineSettings.providerId.trim().length === 0) {
					setComposerError("Choose a Cline provider in Settings before selecting a model.");
					return false;
				}
				setComposerError(null);
				setIsSavingModel(true);
				try {
					const nextModelId = overrides?.modelId ?? clineSettings.modelId;
					const nextReasoningEffort =
						overrides && "reasoningEffort" in overrides
							? overrides.reasoningEffort || ""
							: clineSettings.reasoningEffort;
					if (taskHasExplicitClineSettings) {
						onTaskClineSettingsChanged?.({
							providerId: clineSettings.providerId,
							modelId: nextModelId,
							reasoningEffort: nextReasoningEffort,
						});
						return true;
					}
					const result = await clineSettings.saveProviderSettings({
						modelId: nextModelId,
						reasoningEffort: nextReasoningEffort || null,
					});
					if (!result.ok) {
						setComposerError(result.message ?? "Could not save Cline model settings.");
						return false;
					}
					onClineSettingsSaved?.();
					return true;
				} finally {
					setIsSavingModel(false);
				}
			},
			[clineSettings, onClineSettingsSaved, onTaskClineSettingsChanged, taskHasExplicitClineSettings, workspaceId],
		);

		const handleSelectModel = useCallback(
			(nextModelId: string) => {
				if (nextModelId.trim() === clineSettings.modelId.trim()) {
					return;
				}
				clineSettings.setModelId(nextModelId);
				void persistClineModelSettings({ modelId: nextModelId });
			},
			[clineSettings.modelId, clineSettings.setModelId, persistClineModelSettings],
		);

		const handleSelectReasoningEffort = useCallback(
			(nextReasoningEffort: RuntimeClineReasoningEffort | "") => {
				if (nextReasoningEffort === clineSettings.reasoningEffort) {
					return;
				}
				clineSettings.setReasoningEffort(nextReasoningEffort);
				void persistClineModelSettings({ reasoningEffort: nextReasoningEffort });
			},
			[clineSettings.reasoningEffort, clineSettings.setReasoningEffort, persistClineModelSettings],
		);

		const handleAppendToDraft = useCallback(
			(text: string) => {
				const trimmed = text.trim();
				if (trimmed.length === 0) {
					return;
				}
				if (draft.trim().length === 0) {
					setDraft(trimmed);
					return;
				}
				setDraft(`${draft.trimEnd()}\n\n${trimmed}`);
			},
			[draft, setDraft],
		);

		const handleSendComposerText = useCallback(
			async (text: string): Promise<void> => {
				if (isSavingModel) {
					return;
				}
				if (clineSettings.hasUnsavedChanges) {
					const saved = await persistClineModelSettings();
					if (!saved) {
						return;
					}
				}
				await handleSendText(text, mode);
			},
			[clineSettings.hasUnsavedChanges, handleSendText, isSavingModel, mode, persistClineModelSettings],
		);

		useImperativeHandle(
			ref,
			() => ({
				appendToDraft: handleAppendToDraft,
				sendText: handleSendComposerText,
			}),
			[handleAppendToDraft, handleSendComposerText],
		);

		const handleComposerSend = useCallback(async () => {
			if (isSavingModel) {
				return;
			}
			if (clineSettings.hasUnsavedChanges) {
				const saved = await persistClineModelSettings();
				if (!saved) {
					return;
				}
			}
			const sent = await handleSendDraft(mode, draftImages);
			if (sent) {
				setDraftImages([]);
			}
		}, [
			clineSettings.hasUnsavedChanges,
			draftImages,
			handleSendDraft,
			isSavingModel,
			mode,
			persistClineModelSettings,
		]);

		return (
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{usesVirtualizedMessages ? (
					<Virtuoso<ClineChatMessage, VirtualChatFooterContext>
						ref={virtuosoRef}
						className="min-h-0 min-w-0 flex-1 overflow-x-hidden"
						data-testid="virtual-chat-list"
						data={messages}
						computeItemKey={getVirtualMessageKey}
						itemContent={renderVirtualMessage}
						components={VIRTUAL_CHAT_COMPONENTS}
						context={virtualFooterContext}
						initialTopMostItemIndex={{ index: messages.length - 1, align: "end" }}
						alignToBottom
						atBottomThreshold={BOTTOM_LOCK_THRESHOLD_PX}
						atBottomStateChange={handleVirtualAtBottom}
						followOutput={followVirtualOutput}
						defaultItemHeight={72}
						increaseViewportBy={{ top: 150, bottom: 150 }}
					/>
				) : (
					<div
						ref={scrollContainerRef}
						className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto px-2 py-3"
						onScroll={handleMessageListScroll}
					>
						{messages.map((message) => (
							<ClineChatMessageItem
								key={message.id}
								message={message}
								isCompletedResponse={message.id === completedMessageId}
								expanded={
									expandedMessages.get(message.id) ??
									(message.role === "reasoning" && message.meta?.hookEventName === "reasoning_delta")
								}
								onExpandedChange={(expanded) => handlePlainExpandedChange(message.id, expanded)}
							/>
						))}
						{showAgentProgressIndicator ? <ClineThinkingIndicator /> : null}
						{isCreditLimitNoticeVisible ? <ClineCreditLimitNotice /> : null}
					</div>
				)}
				{panelError ? (
					<div className="border-t border-status-red/30 bg-status-red/10 px-2 py-2 text-xs text-status-red">
						{panelError}
					</div>
				) : null}
				<div className="px-2 py-3">
					<ClineChatComposer
						taskId={taskId}
						draft={draft}
						onDraftChange={setDraft}
						images={draftImages}
						onImagesChange={setDraftImages}
						placeholder={composerPlaceholder}
						mode={mode}
						onModeChange={handleModeChange}
						showModeToggle={showComposerModeToggle}
						canSend={canSend}
						canCancel={canCancel}
						onSend={handleComposerSend}
						onCancel={handleCancelTurn}
						modelOptions={modelOptions}
						recommendedModelIds={modelPickerOptions.recommendedModelIds}
						pinSelectedModelToTop={modelPickerOptions.shouldPinSelectedModelToTop}
						selectedModelId={clineSettings.modelId}
						selectedModelButtonText={selectedModelButtonText}
						onSelectModel={handleSelectModel}
						reasoningEnabledModelIds={reasoningEnabledModelIds}
						selectedReasoningEffort={clineSettings.reasoningEffort}
						onSelectReasoningEffort={handleSelectReasoningEffort}
						isModelLoading={clineSettings.isLoadingProviderModels}
						isModelSaving={isSavingModel}
						modelPickerDisabled={isSavingModel || clineSettings.providerId.trim().length === 0}
						isSending={isSavingModel || isSending}
						warningMessage={summary?.warningMessage ?? null}
						attachmentWarningMessage={attachmentWarningMessage}
						workspaceId={workspaceId}
					/>
				</div>
				{prLinkingNotice && prLinkingNotice.taskId === taskId && prLinkingNotice.workspaceId === workspaceId ? (
					<div className="px-2 pb-2">
						<ClineChatPrLinkNotice
							taskId={taskId}
							linking={prLinkingNotice.linking}
							workspaceId={workspaceId}
							onDismiss={dismissPrLinkingNotice}
						/>
					</div>
				) : null}
				{showActionFooter ? (
					<div className="flex flex-col gap-2 px-3 pb-3">
						{showReviewActions ? (
							<div className="flex gap-2">
								<Button
									variant="primary"
									size="sm"
									fill
									disabled={isCommitLoading || isOpenPrLoading}
									onClick={onCommit}
								>
									{isCommitLoading ? "..." : "Commit"}
								</Button>
								<Button
									variant="primary"
									size="sm"
									fill
									disabled={isCommitLoading || isOpenPrLoading}
									onClick={onOpenPr}
								>
									{isOpenPrLoading ? "..." : "Open PR"}
								</Button>
							</div>
						) : null}
						{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
							<Button variant="default" fill onClick={onCancelAutomaticAction}>
								{cancelAutomaticActionLabel}
							</Button>
						) : null}
						{showComplete && onComplete ? (
							<Button variant="primary" fill disabled={isCompleteLoading} onClick={onComplete}>
								{isCompleteLoading ? <Spinner size={14} /> : "Complete Task"}
							</Button>
						) : null}
						<Button variant="danger" fill disabled={isMoveToTrashLoading} onClick={onMoveToTrash}>
							{isMoveToTrashLoading ? <Spinner size={14} /> : "Move To Trash"}
						</Button>
					</div>
				) : null}
			</div>
		);
	},
);

ClineAgentChatPanel.displayName = "ClineAgentChatPanel";
