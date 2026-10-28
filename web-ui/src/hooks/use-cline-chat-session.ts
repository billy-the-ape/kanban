// Manages the message list and send or cancel lifecycle for one native Cline session.
// It merges loaded history with streamed updates and guards against stale task
// switches so chat surfaces can stay reactive without duplicating logic.
import { useCallback, useEffect, useState } from "react";
import type { ClineChatActionResult } from "@/hooks/use-cline-chat-runtime-actions";
import type { RuntimeTaskChatMessage, RuntimeTaskImage, RuntimeTaskSessionMode } from "@/runtime/types";

export type ClineChatMessage = RuntimeTaskChatMessage;

interface UseClineChatSessionInput {
	taskId: string;
	onSendMessage?: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
	) => Promise<ClineChatActionResult>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<ClineChatMessage[] | null>;
	incomingMessages?: ClineChatMessage[] | null;
	incomingMessage?: ClineChatMessage | null;
}

interface UseClineChatSessionResult {
	messages: ClineChatMessage[];
	isSending: boolean;
	isCanceling: boolean;
	error: string | null;
	sendMessage: (
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
	) => Promise<boolean>;
	cancelTurn: () => Promise<boolean>;
}

/**
 * Image payloads can be multi-megabyte base64 strings. Compare the known
 * schema fields directly rather than constructing another serialized copy.
 */
function areMessageImagesEqual(left: ClineChatMessage["images"], right: ClineChatMessage["images"]): boolean {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((image, index) => {
		const other = right[index];
		return (
			other !== undefined &&
			image.id === other.id &&
			image.mimeType === other.mimeType &&
			image.name === other.name &&
			image.data === other.data
		);
	});
}

function areMessagesEqual(left: ClineChatMessage, right: ClineChatMessage): boolean {
	if (left === right) {
		return true;
	}
	return (
		left.content === right.content &&
		left.role === right.role &&
		left.createdAt === right.createdAt &&
		(left.meta === right.meta || JSON.stringify(left.meta ?? null) === JSON.stringify(right.meta ?? null)) &&
		areMessageImagesEqual(left.images, right.images)
	);
}

function upsertMessage(currentMessages: ClineChatMessage[], nextMessage: ClineChatMessage): ClineChatMessage[] {
	// Streaming usually updates the final message; avoid a history scan per token.
	const lastIndex = currentMessages.length - 1;
	const existingIndex = currentMessages[lastIndex]?.id === nextMessage.id
		? lastIndex
		: currentMessages.findIndex((message) => message.id === nextMessage.id);
	if (existingIndex < 0) {
		return [...currentMessages, nextMessage];
	}
	const existingMessage = currentMessages[existingIndex];
	if (!existingMessage || areMessagesEqual(existingMessage, nextMessage)) {
		return currentMessages;
	}
	const nextMessages = [...currentMessages];
	nextMessages[existingIndex] = nextMessage;
	return nextMessages;
}

/**
 * Merge by message ID in O(base + incoming) time rather than repeatedly
 * scanning and copying the growing history. Preserve the original order and
 * references for unchanged messages so virtualized rows do not rerender.
 */
export function mergeClineChatMessages(
	baseMessages: ClineChatMessage[],
	additionalMessages: ClineChatMessage[],
): ClineChatMessage[] {
	if (additionalMessages.length === 0) {
		return baseMessages;
	}
	const indexes = new Map(baseMessages.map((message, index) => [message.id, index]));
	let result = baseMessages;
	for (const message of additionalMessages) {
		const index = indexes.get(message.id);
		if (index === undefined) {
			if (result === baseMessages) result = [...baseMessages];
			indexes.set(message.id, result.length);
			result.push(message);
			continue;
		}
		const existing = result[index];
		if (existing && !areMessagesEqual(existing, message)) {
			if (result === baseMessages) result = [...baseMessages];
			result[index] = message;
		}
	}
	return result;
}

export function useClineChatSession({
	taskId,
	onSendMessage,
	onCancelTurn,
	onLoadMessages,
	incomingMessages = null,
	incomingMessage = null,
}: UseClineChatSessionInput): UseClineChatSessionResult {
	const [messages, setMessages] = useState<ClineChatMessage[]>([]);
	const [isSending, setIsSending] = useState(false);
	const [isCanceling, setIsCanceling] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setMessages([]);
		setError(null);
	}, [taskId]);

	useEffect(() => {
		if (!onLoadMessages) {
			setMessages([]);
			return;
		}
		setError(null);
		let cancelled = false;
		setIsLoading(true);
		void onLoadMessages(taskId)
			.then((loadedMessages) => {
				if (cancelled) {
					return;
				}
				setMessages((currentMessages) => mergeClineChatMessages(loadedMessages ?? [], currentMessages));
			})
			.catch((loadError) => {
				if (cancelled) {
					return;
				}
				const message = loadError instanceof Error ? loadError.message : String(loadError);
				setError(message);
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [onLoadMessages, taskId]);

	useEffect(() => {
		if (incomingMessages === null) {
			return;
		}
		if (incomingMessages.length === 0) {
			setMessages([]);
			return;
		}
		setMessages((currentMessages) => mergeClineChatMessages(currentMessages, incomingMessages));
	}, [incomingMessages]);

	useEffect(() => {
		if (!incomingMessage) {
			return;
		}
		setMessages((currentMessages) => upsertMessage(currentMessages, incomingMessage));
	}, [incomingMessage]);

	const cancelTurn = useCallback(async (): Promise<boolean> => {
		if (!onCancelTurn || isCanceling) {
			return false;
		}
		setError(null);
		setIsCanceling(true);
		try {
			const result = await onCancelTurn(taskId);
			if (!result.ok) {
				setError(result.message ?? "Could not cancel turn.");
				return false;
			}
			return true;
		} catch (cancelError) {
			const message = cancelError instanceof Error ? cancelError.message : String(cancelError);
			setError(message);
			return false;
		} finally {
			setIsCanceling(false);
		}
	}, [isCanceling, onCancelTurn, taskId]);

	const sendMessage = useCallback(
		async (
			text: string,
			options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
		): Promise<boolean> => {
			const trimmed = text.trim();
			const hasImages = Boolean(options?.images && options.images.length > 0);
			if ((!trimmed && !hasImages) || !onSendMessage) {
				return false;
			}

			setError(null);
			setIsSending(true);

			try {
				const result = options
					? await onSendMessage(taskId, trimmed, options)
					: await onSendMessage(taskId, trimmed);
				if (!result.ok) {
					const message = result.message ?? "Could not send message.";
					setError(message);
					return false;
				}
				const sentMessage = result.chatMessage ?? null;
				if (sentMessage) {
					setMessages((currentMessages) => upsertMessage(currentMessages, sentMessage));
				} else if (onLoadMessages) {
					const loadedMessages = await onLoadMessages(taskId);
					// A post-send reload is authoritative (notably for /clear).
					// Merging stale local messages would restore a cleared transcript.
					setMessages(loadedMessages ?? []);
				}
				return true;
			} catch (sendError) {
				const message = sendError instanceof Error ? sendError.message : String(sendError);
				setError(message);
				return false;
			} finally {
				setIsSending(false);
			}
		},
		[onLoadMessages, onSendMessage, taskId],
	);

	return {
		messages,
		isSending: isSending || isLoading,
		isCanceling,
		error,
		sendMessage,
		cancelTurn,
	};
}
