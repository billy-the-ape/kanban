import type { ClineReviewSessionService } from "../cline-sdk/cline-review-session-service";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import { resolveTaskTitle } from "../core/task-title";
import { isTaskWriterActive } from "../server/task-writer-activity";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createVerificationRunner } from "../verification/verification-service";
import { getGitDeliveryService, readTaskDeliveryReceipt } from "../workspace/git-delivery";
import { runGit } from "../workspace/git-utils";
import {
	computeCandidateTreeHash,
	findTaskBaseRef,
	persistVerificationReceipt,
} from "../workspace/task-review-handoff";
import { resolveTaskCwd } from "../workspace/task-worktree";
import { type CompletionScope, TaskCompletionCoordinator } from "./completion-coordinator";

export interface CreateTaskCompletionCoordinatorOptions {
	loadScopedRuntimeConfig: (scope: CompletionScope) => Promise<RuntimeConfigState>;
	getScopedReviewSessionService: (scope: CompletionScope) => Promise<ClineReviewSessionService>;
	getScopedClineTaskSessionService: (scope: CompletionScope) => Promise<ClineTaskSessionService>;
	getScopedTerminalManager: (scope: CompletionScope) => Promise<TerminalSessionManager>;
}

/** Wires the B-4 completion coordinator to the runtime's real services. */
export function createTaskCompletionCoordinator(
	options: CreateTaskCompletionCoordinatorOptions,
): TaskCompletionCoordinator {
	const verificationRunner = createVerificationRunner();
	const sessionsFor = async (scope: CompletionScope) => ({
		clineTaskSessionService: await options.getScopedClineTaskSessionService(scope),
		terminalManager: await options.getScopedTerminalManager(scope),
	});
	return new TaskCompletionCoordinator({
		loadPolicy: async (scope) => {
			const config = await options.loadScopedRuntimeConfig(scope);
			return {
				gitDelivery: config.gitDeliveryPolicy ?? null,
				reviewRequired: config.reviewPolicy?.enabled === "required",
				verificationRequired: config.verification?.enabled === "required",
				reviewPolicy: config.reviewPolicy,
				verification: config.verification ?? null,
			};
		},
		resolveTask: async (scope, taskId) => {
			const baseRef = await findTaskBaseRef(scope.workspaceId, taskId);
			if (!baseRef) {
				return null;
			}
			const worktreePath = await resolveTaskCwd({ cwd: scope.workspacePath, taskId, baseRef, ensure: false }).catch(
				() => null,
			);
			if (!worktreePath) {
				return null;
			}
			const board = await loadWorkspaceBoardById(scope.workspaceId);
			const card = board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
			const { clineTaskSessionService, terminalManager } = await sessionsFor(scope);
			const summary = clineTaskSessionService.getSummary(taskId) ?? terminalManager.getSummary(taskId);
			return {
				baseRef,
				worktreePath,
				description: card?.prompt ?? "",
				taskTitle: card ? resolveTaskTitle(card.title, card.prompt) || null : null,
				implementationSessionId:
					summary?.startedAt != null ? `${summary.agentId ?? "agent"}@${summary.startedAt}` : null,
			};
		},
		isTaskWriterActive: async (scope, taskId) => isTaskWriterActive(taskId, await sessionsFor(scope)),
		runReview: async (scope, input) => {
			const reviewService = await options.getScopedReviewSessionService(scope);
			return await reviewService.startTaskReview({
				taskId: input.taskId,
				description: input.description,
				...(input.taskTitle ? { taskTitle: input.taskTitle } : {}),
				reviewPolicy: input.reviewPolicy,
				verification: input.verification,
			});
		},
		cancelReview: async (scope, taskId) => {
			await (await options.getScopedReviewSessionService(scope)).cancelTaskReview(taskId);
		},
		runVerification: (config, input) => verificationRunner.run(config, input),
		persistVerificationReceipt,
		computeTreeHash: computeCandidateTreeHash,
		deliver: (input) => getGitDeliveryService().startDelivery(input),
		readDeliveryReceipt: readTaskDeliveryReceipt,
		readTreeId: async (repoPath, commit) => {
			const result = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`]);
			return result.ok && result.stdout ? result.stdout : null;
		},
		readRepoRootCommit: async (repoPath) => {
			const result = await runGit(repoPath, ["rev-list", "--max-parents=0", "HEAD"]);
			return result.ok ? (result.stdout.split("\n").sort()[0] ?? null) : null;
		},
	});
}
