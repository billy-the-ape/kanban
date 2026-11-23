import type { MutableRefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getTerminalThemeColors, useTheme } from "@/hooks/use-theme";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { disposePersistentTerminal, ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";
import { registerTerminalController } from "@/terminal/terminal-controller-registry";

interface UsePersistentTerminalSessionInput {
	taskId: string;
	workspaceId: string | null;
	enabled?: boolean;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onConnectionReady?: (taskId: string) => void;
	autoFocus?: boolean;
	isVisible?: boolean;
	sessionStartedAt?: number | null;
	sessionSummary?: RuntimeTaskSessionSummary | null;
	baseRef?: string;
	terminalBackgroundColor: string;
	cursorColor: string;
}

export interface UsePersistentTerminalSessionResult {
	containerRef: MutableRefObject<HTMLDivElement | null>;
	lastError: string | null;
	isStopping: boolean;
	clearTerminal: () => void;
	stopTerminal: () => Promise<void>;
}

export function usePersistentTerminalSession({
	taskId,
	workspaceId,
	enabled = true,
	onSummary,
	onConnectionReady,
	autoFocus = false,
	isVisible = true,
	sessionStartedAt = null,
	sessionSummary = null,
	baseRef,
	terminalBackgroundColor,
	cursorColor,
}: UsePersistentTerminalSessionInput): UsePersistentTerminalSessionResult {
	const { themeId } = useTheme();
	const themeColors = useMemo(() => getTerminalThemeColors(themeId), [themeId]);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const terminalRef = useRef<ReturnType<typeof ensurePersistentTerminal> | null>(null);
	const callbackRef = useRef<{
		onSummary?: (summary: RuntimeTaskSessionSummary) => void;
		onConnectionReady?: (taskId: string) => void;
	}>({
		onSummary,
		onConnectionReady,
	});
	const previousSessionRef = useRef<{
		workspaceId: string;
		taskId: string;
		sessionStartedAt: number | null;
	} | null>(null);
	const [lastError, setLastError] = useState<string | null>(null);
	const [isStopping, setIsStopping] = useState(false);
	const lastRestorationAttemptRef = useRef<string | null>(null);
	callbackRef.current = {
		onSummary,
		onConnectionReady,
	};

	useEffect(() => {
		if (!enabled) {
			const previousSession = previousSessionRef.current;
			if (previousSession) {
				disposePersistentTerminal(previousSession.workspaceId, previousSession.taskId);
			}
			terminalRef.current?.unmount(containerRef.current);
			terminalRef.current = null;
			previousSessionRef.current = null;
			setLastError(null);
			setIsStopping(false);
			return;
		}

		if (!workspaceId) {
			const previousSession = previousSessionRef.current;
			if (previousSession) {
				disposePersistentTerminal(previousSession.workspaceId, previousSession.taskId);
			}
			terminalRef.current?.unmount(containerRef.current);
			terminalRef.current = null;
			previousSessionRef.current = null;
			setLastError("No project selected.");
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const previousSession = previousSessionRef.current;
		const didSessionRestart =
			previousSession !== null &&
			previousSession.workspaceId === workspaceId &&
			previousSession.taskId === taskId &&
			previousSession.sessionStartedAt !== sessionStartedAt;

		const terminal = ensurePersistentTerminal({
			taskId,
			workspaceId,
			cursorColor,
			terminalBackgroundColor,
			themeColors,
		});
		if (didSessionRestart) {
			terminal.reset();
		}
		previousSessionRef.current = {
			workspaceId,
			taskId,
			sessionStartedAt,
		};
		terminalRef.current = terminal;
		const unsubscribe = terminal.subscribe({
			onConnectionReady: (connectedTaskId) => {
				callbackRef.current.onConnectionReady?.(connectedTaskId);
			},
			onLastError: setLastError,
			onSummary: (summary) => {
				callbackRef.current.onSummary?.(summary);
			},
		});
		terminal.mount(
			container,
			{
				cursorColor,
				terminalBackgroundColor,
				themeColors,
			},
			{
				autoFocus,
				isVisible,
			},
		);
		setLastError(null);
		setIsStopping(false);
		return () => {
			unsubscribe();
			terminal.unmount(container);
			if (terminalRef.current === terminal) {
				terminalRef.current = null;
			}
		};
	}, [
		autoFocus,
		cursorColor,
		enabled,
		isVisible,
		sessionStartedAt,
		taskId,
		terminalBackgroundColor,
		themeColors,
		workspaceId,
	]);

	// After a server restart, a persisted Pi task can have no backing PTY.
	// Reattach only an existing conversation; the backend verifies its session id,
	// worktree, lifecycle and actual process liveness before starting anything.
	useEffect(() => {
		if (!enabled || !workspaceId || !baseRef || sessionSummary?.agentId !== "pi") return;
		const recoverable =
			sessionSummary.state === "interrupted" ||
			((sessionSummary.state === "running" || sessionSummary.state === "awaiting_review") &&
				sessionSummary.pid !== null);
		if (!recoverable) return;
		// Cap reconnection to one attempt per open task view, not one per
		// restarted process (which would create a client-side crash loop).
		const key = `${workspaceId}:${taskId}`;
		if (lastRestorationAttemptRef.current === key) return;
		lastRestorationAttemptRef.current = key;
		let cancelled = false;
		void getRuntimeTrpcClient(workspaceId).runtime.startTaskSession
			.mutate({ taskId, agentId: "pi", prompt: "", baseRef, restoreDetachedSession: true })
			.then((response) => {
				if (!cancelled && response.ok && response.summary) callbackRef.current.onSummary?.(response.summary);
			})
			.catch(() => {
				// Do not fall back to starting a new conversation if reattachment fails.
			});
		return () => { cancelled = true; };
	}, [enabled, workspaceId, taskId, baseRef, sessionSummary?.agentId,
		sessionSummary?.state, sessionSummary?.pid]);

	useEffect(() => {
		return registerTerminalController(taskId, {
			input: (text) => terminalRef.current?.input(text) ?? false,
			paste: (text) => terminalRef.current?.paste(text) ?? false,
			waitForLikelyPrompt: async (timeoutMs) => await (terminalRef.current?.waitForLikelyPrompt(timeoutMs) ?? false),
		});
	}, [taskId]);

	const stopTerminal = useCallback(async () => {
		const terminal = terminalRef.current;
		if (!terminal) {
			return;
		}
		setIsStopping(true);
		try {
			await terminal.stop();
		} catch {
			// Keep terminal usable even if stop API fails.
		} finally {
			setIsStopping(false);
		}
	}, []);

	const clearTerminal = useCallback(() => {
		terminalRef.current?.clear();
	}, []);

	return {
		containerRef,
		lastError,
		isStopping,
		clearTerminal,
		stopTerminal,
	};
}
