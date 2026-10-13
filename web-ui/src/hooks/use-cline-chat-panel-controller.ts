// Builds the view model for the native Cline chat panel.
// Keep panel-specific UI state here so the panel component can stay mostly
// declarative and shared across detail and sidebar surfaces.
import { useCallback, useEffect, useState } from "react";

import type { ClineChatActionResult } from "@/hooks/use-cline-chat-runtime-actions";
import { type ClineChatMessage, useClineChatSession } from "@/hooks/use-cline-chat-session";
import type {
	RuntimeTaskChatPrLinking,
	RuntimeTaskImage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";

/**
 * PRLINK-8: the PR-linking notice for the latest completed chat send. Local
 * UI state only: it may disappear on reload and is never persisted or sent
 * to the model.
 */
export interface ClineChatPrLinkingNotice {
	taskId: string;
	workspaceId: string | null;
	linking: RuntimeTaskChatPrLinking;
}

interface UseClineChatPanelControllerInput {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null;
	taskColumnId?: string;
	workspaceId?: string | null;
	onSendMessage?: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
	) => Promise<ClineChatActionResult>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<ClineChatMessage[] | null>;
	incomingMessages?: ClineChatMessage[] | null;
	incomingMessage?: ClineChatMessage | null;
	onCommit?: () => void;
	onOpenPr?: () => void;
	onMoveToTrash?: () => void;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
}

interface UseClineChatPanelControllerResult {
	draft: string;
	setDraft: (draft: string) => void;
	messages: ClineChatMessage[];
	error: string | null;
	isSending: boolean;
	isCanceling: boolean;
	canSend: boolean;
	canCancel: boolean;
	showReviewActions: boolean;
	showAgentProgressIndicator: boolean;
	showActionFooter: boolean;
	showCancelAutomaticAction: boolean;
	prLinkingNotice: ClineChatPrLinkingNotice | null;
	dismissPrLinkingNotice: () => void;
	handleSendText: (text: string, mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]) => Promise<boolean>;
	handleSendDraft: (mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]) => Promise<boolean>;
	handleCancelTurn: () => void;
}

export function useClineChatPanelController({
	taskId,
	summary,
	taskColumnId = "in_progress",
	onSendMessage,
	onCancelTurn,
	onLoadMessages,
	incomingMessages = null,
	incomingMessage = null,
	onCommit,
	onOpenPr,
	onMoveToTrash,
	onCancelAutomaticAction,
	cancelAutomaticActionLabel,
	showMoveToTrash = false,
	workspaceId = null,
}: UseClineChatPanelControllerInput): UseClineChatPanelControllerResult {
	const [draft, setDraft] = useState("");
	const [prLinkingNotice, setPrLinkingNotice] = useState<ClineChatPrLinkingNotice | null>(null);
	const reviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(taskId);
	// PRLINK-8: capture the PR-linking outcome of the latest completed send.
	// Sends are serialized by isSending, so a completed send always replaces
	// the notice (with a new one or null) and never hides a pending one.
	const trackPrLinkingSendMessage = useCallback(
		async (
			sendTaskId: string,
			text: string,
			options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
		) => {
			const result = (await onSendMessage?.(sendTaskId, text, options)) ?? {
				ok: false,
				message: "No send handler.",
			};
			if (result.ok) {
				setPrLinkingNotice(
					result.pullRequestLinking
						? { taskId: sendTaskId, workspaceId, linking: result.pullRequestLinking }
						: null,
				);
			}
			return result;
		},
		[onSendMessage, workspaceId],
	);
	const { messages, isSending, isCanceling, error, sendMessage, cancelTurn } = useClineChatSession({
		taskId,
		onSendMessage: trackPrLinkingSendMessage,
		onCancelTurn,
		onLoadMessages,
		incomingMessages,
		incomingMessage,
	});
	const canSend = Boolean(onSendMessage) && !isSending && !isCanceling;
	const canCancel = Boolean(onCancelTurn) && summary?.state === "running" && !isCanceling;
	const showReviewActions =
		taskColumnId === "review" &&
		(reviewWorkspaceSnapshot?.changedFiles ?? 0) > 0 &&
		Boolean(onCommit) &&
		Boolean(onOpenPr);
	const showAgentProgressIndicator = summary?.state === "running";
	const showActionFooter = showMoveToTrash && Boolean(onMoveToTrash);
	const showCancelAutomaticAction = Boolean(cancelAutomaticActionLabel && onCancelAutomaticAction);

	const handleSendText = useCallback(
		async (text: string, mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]): Promise<boolean> => {
			return sendMessage(
				text,
				mode || images?.length
					? {
							...(mode ? { mode } : {}),
							...(images?.length ? { images } : {}),
						}
					: undefined,
			);
		},
		[sendMessage],
	);

	// Clear the notice on task/workspace change so a late response from one
	// scope can never render under another.
	useEffect(() => {
		setPrLinkingNotice(null);
	}, [taskId, workspaceId]);

	const dismissPrLinkingNotice = useCallback(() => {
		setPrLinkingNotice(null);
	}, []);

	const handleSendDraft = useCallback(
		async (mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]): Promise<boolean> => {
			const sent = await handleSendText(draft, mode, images);
			if (sent) {
				setDraft("");
			}
			return sent;
		},
		[draft, handleSendText],
	);

	const handleCancelTurn = useCallback(() => {
		void cancelTurn();
	}, [cancelTurn]);

	return {
		draft,
		setDraft,
		messages,
		error,
		isSending,
		isCanceling,
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
	};
}
