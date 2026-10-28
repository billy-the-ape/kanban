import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseGitActionsResult, useGitActions } from "@/hooks/use-git-actions";
import type { RuntimeConfigResponse, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import { clearTaskWorkspaceInfo, clearTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { BoardData } from "@/types";

const showAppToastMock = vi.hoisted(() => vi.fn());
const useGitHistoryDataMock = vi.hoisted(() => vi.fn());
const acquireGitActionPromptMock = vi.hoisted(() =>
	vi.fn(
		async (): Promise<{
			ok: boolean;
			status: "acquired" | "already_sent" | "no_task" | "not_in_review" | "error";
		}> => ({ ok: true, status: "acquired" }),
	),
);
const releaseGitActionPromptMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
}));

vi.mock("@/components/git-history/use-git-history-data", () => ({
	useGitHistoryData: useGitHistoryDataMock,
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			acquireTaskGitActionPrompt: { mutate: acquireGitActionPromptMock },
			releaseTaskGitActionPrompt: { mutate: releaseGitActionPromptMock },
		},
	}),
}));

interface HookSnapshot {
	handleAgentCommitTask: UseGitActionsResult["handleAgentCommitTask"];
	runAutoReviewGitAction: UseGitActionsResult["runAutoReviewGitAction"];
}

function createGitHistoryResult(): UseGitActionsResult["gitHistory"] {
	return {
		viewMode: "commit",
		refs: [],
		activeRef: null,
		refsErrorMessage: null,
		isRefsLoading: false,
		workingCopyFileCount: 0,
		hasWorkingCopy: false,
		commits: [],
		totalCommitCount: 0,
		selectedCommitHash: null,
		selectedCommit: null,
		isLogLoading: false,
		isLoadingMoreCommits: false,
		logErrorMessage: null,
		diffSource: null,
		isDiffLoading: false,
		diffErrorMessage: null,
		selectedDiffPath: null,
		selectWorkingCopy: () => {},
		selectRef: () => {},
		selectCommit: () => {},
		selectDiffPath: () => {},
		loadMoreCommits: () => {},
		refresh: () => {},
	};
}

function createBoard(): BoardData {
	return {
		columns: [
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Ship it",
						prompt: "Ship it",
						startInPlanMode: false,
						autoReviewEnabled: false,
						autoReviewMode: "commit",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
		],
		dependencies: [],
	};
}

function createRuntimeConfig(selectedAgentId: RuntimeConfigResponse["selectedAgentId"]): RuntimeConfigResponse {
	return {
		selectedAgentId,
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		effectiveCommand: null,
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		readyForReviewNotificationsEnabled: true,
		detectedCommands: [],
		agents: [
			{
				id: selectedAgentId,
				label: selectedAgentId,
				binary: selectedAgentId,
				command: selectedAgentId,
				defaultArgs: [],
				installed: true,
				configured: true,
			},
		],
		shortcuts: [],
		clineProviderSettings: {
			providerId: "anthropic",
			modelId: "claude-sonnet-4",
			baseUrl: null,
			apiKeyConfigured: true,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		},
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		contextBudget: null,
		effectiveContextWindow: null,
		reviewPolicy: null,
		verification: null,
		gitDeliveryPolicy: null,
		taskDispatchPolicy: null,
		reliableCompletion: {
			enabled: false,
			reviewRequired: false,
			checksRequired: false,
			pushRequired: false,
			dispatchEnabled: false,
			workerLimit: 1,
		},
	};
}

function createWorkspaceInfo(): RuntimeTaskWorkspaceInfoResponse {
	return {
		taskId: "task-1",
		path: "/tmp/task-1",
		exists: true,
		baseRef: "main",
		branch: "task-1",
		isDetached: false,
		headCommit: "abc1234",
	};
}

function HookHarness({
	onSnapshot,
	sendTaskSessionInput,
	sendTaskChatMessage,
}: {
	onSnapshot: (snapshot: HookSnapshot) => void;
	sendTaskSessionInput: Parameters<typeof useGitActions>[0]["sendTaskSessionInput"];
	sendTaskChatMessage: Parameters<typeof useGitActions>[0]["sendTaskChatMessage"];
}): null {
	const gitActions = useGitActions({
		currentProjectId: "project-1",
		board: createBoard(),
		selectedCard: null,
		runtimeProjectConfig: createRuntimeConfig("cline"),
		sendTaskSessionInput,
		sendTaskChatMessage,
		fetchTaskWorkspaceInfo: async () => createWorkspaceInfo(),
		isGitHistoryOpen: false,
		refreshWorkspaceState: async () => {},
	});

	useEffect(() => {
		onSnapshot({
			handleAgentCommitTask: gitActions.handleAgentCommitTask,
			runAutoReviewGitAction: gitActions.runAutoReviewGitAction,
		});
	}, [gitActions.handleAgentCommitTask, gitActions.runAutoReviewGitAction, onSnapshot]);

	return null;
}

describe("useGitActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		showAppToastMock.mockReset();
		useGitHistoryDataMock.mockReset();
		useGitHistoryDataMock.mockReturnValue(createGitHistoryResult());
		acquireGitActionPromptMock.mockReset();
		acquireGitActionPromptMock.mockResolvedValue({ ok: true, status: "acquired" });
		releaseGitActionPromptMock.mockReset();
		releaseGitActionPromptMock.mockResolvedValue({ ok: true });
		clearTaskWorkspaceInfo("task-1");
		clearTaskWorkspaceSnapshot("task-1");
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		clearTaskWorkspaceInfo("task-1");
		clearTaskWorkspaceSnapshot("task-1");
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("sends commit prompts through the native cline chat API", async () => {
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		const sendTaskChatMessage = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					sendTaskChatMessage={sendTaskChatMessage}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot?.handleAgentCommitTask("task-1");
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// LASTPROMPT: generated commit instructions are automated and must
		// not update the card's latest user prompt preview.
		expect(sendTaskChatMessage).toHaveBeenCalledWith("task-1", expect.any(String), {
			mode: "act",
			source: "automated",
		});
		expect(sendTaskSessionInput).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	describe("AUTOGIT: git-action prompt dedupe", () => {
		async function renderWithHooks(
			sendTaskChatMessage: Parameters<typeof useGitActions>[0]["sendTaskChatMessage"],
		): Promise<HookSnapshot> {
			const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
			let snapshot: HookSnapshot | null = null;
			await act(async () => {
				root.render(
					<HookHarness
						sendTaskSessionInput={sendTaskSessionInput}
						sendTaskChatMessage={sendTaskChatMessage}
						onSnapshot={(next) => {
							snapshot = next;
						}}
					/>,
				);
				await Promise.resolve();
			});
			if (snapshot === null) {
				throw new Error("Expected a hook snapshot.");
			}
			return snapshot;
		}

		it("records a manual commit send through the server-owned record", async () => {
			const snapshot = await renderWithHooks(vi.fn(async () => ({ ok: true })));
			await act(async () => {
				snapshot.handleAgentCommitTask("task-1");
				for (let i = 0; i < 5; i += 1) {
					await Promise.resolve();
				}
			});
			expect(acquireGitActionPromptMock).toHaveBeenCalledWith({
				taskId: "task-1",
				action: "commit",
				intent: "manual",
			});
		});

		it("suppresses the auto prompt when the episode already has a record", async () => {
			const sendTaskChatMessage = vi.fn(async () => ({ ok: true }));
			acquireGitActionPromptMock.mockResolvedValueOnce({ ok: true, status: "already_sent" });
			const snapshot = await renderWithHooks(sendTaskChatMessage);
			let triggered: boolean | undefined;
			await act(async () => {
				triggered = await snapshot.runAutoReviewGitAction("task-1", "commit");
			});
			expect(triggered).toBe(false);
			expect(sendTaskChatMessage).not.toHaveBeenCalled();
			expect(releaseGitActionPromptMock).not.toHaveBeenCalled();
		});

		it("sends the auto prompt when the server acquire degrades to no_task", async () => {
			const sendTaskChatMessage = vi.fn(async () => ({ ok: true }));
			acquireGitActionPromptMock.mockResolvedValueOnce({ ok: true, status: "no_task" });
			const snapshot = await renderWithHooks(sendTaskChatMessage);
			let triggered: boolean | undefined;
			await act(async () => {
				triggered = await snapshot.runAutoReviewGitAction("task-1", "commit");
			});
			expect(triggered).toBe(true);
			expect(sendTaskChatMessage).toHaveBeenCalledTimes(1);
			expect(releaseGitActionPromptMock).not.toHaveBeenCalled();
		});

		it("releases the record when an auto prompt send fails", async () => {
			const sendTaskChatMessage = vi.fn(async () => ({ ok: false, message: "boom" }));
			const snapshot = await renderWithHooks(sendTaskChatMessage);
			let triggered: boolean | undefined;
			await act(async () => {
				triggered = await snapshot.runAutoReviewGitAction("task-1", "commit");
			});
			expect(triggered).toBe(false);
			expect(acquireGitActionPromptMock).toHaveBeenCalledWith({
				taskId: "task-1",
				action: "commit",
				intent: "auto",
			});
			expect(releaseGitActionPromptMock).toHaveBeenCalledWith({ taskId: "task-1", action: "commit" });
		});
	});
});
