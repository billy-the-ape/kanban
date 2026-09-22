// B-6.2 / B-6.4 / B-6.5 / B-6.7 — bounded, fresh-context review sessions.
//
// A review session is a separate, bounded Cline session that reviews one task's
// change set. It starts from a fresh context: no implementation transcript —
// only the handoff artifact (acceptance criteria, fingerprinted plan documents,
// the recorded starting revision, and the change set). It applies scoped fixes
// across a bounded number of repair rounds and persists a durable verdict bound
// to the candidate content tree. Git delivery is deliberately out of scope here
// (the B-6.6 tool policy denies publication); that is B-8's job.
//
// The service is a thin orchestrator over the existing in-memory Cline task
// session service (its own instance, so a review never collides with the
// task's working session). The git/FS work (handoff, diff, tree hash, durable
// artifacts) is abstracted behind ClineReviewEvidencePort so the orchestration
// is unit-testable without a live worktree.
import type {
	RuntimeReviewHandoffArtifact,
	RuntimeReviewOutcomeFile,
	RuntimeReviewPolicy,
	RuntimeReviewResult,
	RuntimeReviewResultOutput,
	RuntimeTaskReviewInfoResponse,
	RuntimeTaskReviewStartRequest,
	RuntimeTaskReviewStartResponse,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { runtimeReviewResultOutputSchema } from "../core/api-contract";
import {
	type BuildReviewHandoffInput,
	buildReviewHandoffArtifact,
	computeCandidateTreeHash,
	extractReviewDiff,
	findTaskBaseRef,
	persistReviewHandoff,
	persistReviewOutcome,
	readReviewHandoff,
	readReviewOutcome,
	readTaskReviewRequest,
	type TaskReviewRequest,
} from "../workspace/task-review-handoff";
import { resolveTaskCwd } from "../workspace/task-worktree";
import { buildClineCompactionConfig } from "./cline-compaction-config";
import type { ResolvedClineLaunchConfig } from "./cline-provider-service";
import type { ClineLaunchConfigResolver } from "./cline-session-runtime";
import type { ClineTaskSessionService } from "./cline-task-session-service";
import { buildReviewInitialPrompt, buildReviewRepairPrompt } from "./review-prompt";
import { createReviewToolPolicy } from "./review-tool-policy";

/** Suffix that makes the review session id distinct from the task's working session. */
const REVIEW_SESSION_SUFFIX = "::review";
/** B-6.5: default bounded repair-round budget (initial evaluation value is two). */
const DEFAULT_MAX_REPAIR_ROUNDS = 2;

/** B-6.2: the review session id is derived from (and distinct from) the task id. */
export function reviewSessionIdForTask(taskId: string): string {
	return `${taskId}${REVIEW_SESSION_SUFFIX}`;
}

/** B-6: the evidence a review run needs, abstracted for unit testing. */
export interface ClineReviewEvidencePort {
	loadTaskBaseRef(taskId: string): Promise<string | null>;
	resolveWorktreePath(taskId: string, baseRef: string): Promise<string>;
	readReviewRequest(taskId: string): Promise<TaskReviewRequest>;
	buildHandoffArtifact(input: BuildReviewHandoffInput): Promise<RuntimeReviewHandoffArtifact>;
	persistHandoff(artifact: RuntimeReviewHandoffArtifact): Promise<string>;
	readHandoff(taskId: string): Promise<RuntimeReviewHandoffArtifact | null>;
	extractDiff(worktreePath: string, startingCommit: string | null): Promise<string>;
	computeTreeHash(worktreePath: string): Promise<string | null>;
	persistOutcome(taskId: string, outcome: RuntimeReviewOutcomeFile): Promise<string>;
	readOutcome(taskId: string): Promise<RuntimeReviewOutcomeFile | null>;
}

/** B-6.2: the start input — the validated request plus the effective review policy. */
export interface ClineReviewStartInput extends RuntimeTaskReviewStartRequest {
	/** Effective review policy; absent means all defaults (off, 2 repair rounds). */
	reviewPolicy?: RuntimeReviewPolicy;
}

export interface ClineReviewSessionService {
	startTaskReview(input: ClineReviewStartInput): Promise<RuntimeTaskReviewStartResponse>;
	getReviewInfo(taskId: string): Promise<RuntimeTaskReviewInfoResponse>;
	dispose(): Promise<void>;
}

export interface CreateClineReviewSessionServiceOptions {
	/** The review session's own in-memory Cline task session service (fresh context + isolated single-session guard). */
	clineTaskSessionService: ClineTaskSessionService;
	/** Resolves the review model configuration (honoring the policy's explicit override). */
	resolveClineLaunchConfig: ClineLaunchConfigResolver;
	/** Workspace that owns the task under review (board + worktrees home scope). */
	workspaceId: string;
	/** Absolute path to the main repository checkout (worktree resolution root). */
	repoPath: string;
	/** Injectable evidence port (defaults to the real git/FS implementation). */
	evidence?: ClineReviewEvidencePort;
}

function createDefaultReviewEvidencePort(workspaceId: string, repoPath: string): ClineReviewEvidencePort {
	return {
		loadTaskBaseRef: (taskId) => findTaskBaseRef(workspaceId, taskId),
		resolveWorktreePath: (taskId, baseRef) => resolveTaskCwd({ cwd: repoPath, taskId, baseRef, ensure: false }),
		readReviewRequest: (taskId) => readTaskReviewRequest(taskId),
		buildHandoffArtifact: (input) => buildReviewHandoffArtifact(input),
		persistHandoff: (artifact) => persistReviewHandoff(artifact),
		readHandoff: (taskId) => readReviewHandoff(taskId),
		extractDiff: (worktreePath, startingCommit) => extractReviewDiff(worktreePath, startingCommit),
		computeTreeHash: (worktreePath) => computeCandidateTreeHash(worktreePath),
		persistOutcome: (taskId, outcome) => persistReviewOutcome(taskId, outcome),
		readOutcome: (taskId) => readReviewOutcome(taskId),
	};
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) {
		return error.message.trim();
	}
	return "Unknown error";
}

/** Extracts the fenced `kanban-review-result` JSON body from a message (null when absent). */
function extractReviewResultBlock(text: string): string | null {
	const match = text.match(/```kanban-review-result[ \t]*\r?\n([\s\S]*?)```/);
	const body = match?.[1]?.trim();
	return body && body.length > 0 ? body : null;
}

/** A terminal summary is a failure when the session was interrupted or the agent errored. */
function isFailedTerminal(summary: RuntimeTaskSessionSummary): boolean {
	return summary.state === "interrupted" || summary.reviewReason === "error";
}

function terminalFailureReason(summary: RuntimeTaskSessionSummary): string | null {
	if (summary.warningMessage && summary.warningMessage.trim()) {
		return summary.warningMessage.trim();
	}
	if (summary.state === "interrupted") {
		return "The review session was interrupted before it produced a result.";
	}
	return null;
}

/** B-6: applies the documented defaults when no review policy is configured (off, 2 repair rounds). */
function resolveEffectiveReviewPolicy(policy: RuntimeReviewPolicy | undefined): RuntimeReviewPolicy {
	if (policy) {
		return {
			enabled: policy.enabled,
			instructions: policy.instructions ?? "",
			modelOverride: policy.modelOverride ?? null,
			maxRepairRounds: policy.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS,
		};
	}
	return { enabled: "off", instructions: "", modelOverride: null, maxRepairRounds: DEFAULT_MAX_REPAIR_ROUNDS };
}

class ClineReviewSessionServiceImpl implements ClineReviewSessionService {
	private readonly sessionService: ClineTaskSessionService;
	private readonly resolveLaunchConfig: ClineLaunchConfigResolver;
	private readonly repoPath: string;
	private readonly evidence: ClineReviewEvidencePort;

	constructor(
		sessionService: ClineTaskSessionService,
		resolveLaunchConfig: ClineLaunchConfigResolver,
		repoPath: string,
		evidence: ClineReviewEvidencePort,
	) {
		this.sessionService = sessionService;
		this.resolveLaunchConfig = resolveLaunchConfig;
		this.repoPath = repoPath;
		this.evidence = evidence;
	}

	async startTaskReview(input: ClineReviewStartInput): Promise<RuntimeTaskReviewStartResponse> {
		const taskId = input.taskId;
		const sessionId = reviewSessionIdForTask(taskId);
		const reviewPolicy = resolveEffectiveReviewPolicy(input.reviewPolicy);
		const warnings: string[] = [];

		// B-6.2: the review inspects the live worktree (never the implementation
		// transcript). Resolve the task's worktree from the board + repo.
		let baseRef: string | null = null;
		try {
			baseRef = await this.evidence.loadTaskBaseRef(taskId);
		} catch {
			baseRef = null;
		}
		if (!baseRef) {
			return this.failureResponse(
				sessionId,
				"Could not determine the task's base branch to resolve its worktree.",
				warnings,
			);
		}
		let worktreePath: string;
		try {
			worktreePath = await this.evidence.resolveWorktreePath(taskId, baseRef);
		} catch (error) {
			return this.failureResponse(
				sessionId,
				`Could not resolve the task worktree: ${toErrorMessage(error)}`,
				warnings,
			);
		}

		// B-6.2: the recorded self-report is authoritative; the request may override it.
		let selfReport: TaskReviewRequest;
		try {
			selfReport = await this.evidence.readReviewRequest(taskId);
		} catch {
			selfReport = { planDocumentPaths: [], agentNotes: null };
		}
		const planDocumentPaths = input.planDocumentPaths ?? selfReport.planDocumentPaths;
		const agentNotes = input.agentNotes !== undefined ? input.agentNotes : selfReport.agentNotes;

		// B-6.1: build + persist the handoff artifact (the fresh-context briefing).
		let artifact: RuntimeReviewHandoffArtifact;
		try {
			artifact = await this.evidence.buildHandoffArtifact({
				taskId,
				worktreePath,
				repoPath: this.repoPath,
				description: input.description,
				planDocumentPaths,
				agentNotes,
				startingCommit: input.startingCommit ?? null,
			});
		} catch (error) {
			return this.failureResponse(
				sessionId,
				`Failed to build the review handoff: ${toErrorMessage(error)}`,
				warnings,
			);
		}
		await this.evidence.persistHandoff(artifact).catch(() => {});

		// B-6.3: initial prompt = diff vs the starting revision + the briefing.
		const diff = await this.evidence.extractDiff(worktreePath, artifact.startingCommit).catch(() => "");
		const initialPrompt = buildReviewInitialPrompt({
			artifact,
			diff,
			policyInstructions: reviewPolicy.instructions,
		});

		// B-6.6: the review tool policy scopes writes to the reviewed change set
		// and denies Git publication / destructive worktree commands.
		const allowedWritePaths = new Set<string>([
			...artifact.changedPaths,
			...artifact.untrackedPaths,
			...planDocumentPaths,
		]);
		const requestToolApproval = createReviewToolPolicy({ worktreePath, allowedWritePaths: [...allowedWritePaths] });

		// B-6: honor an explicit model override; never silently switch to a cloud model.
		let launchConfig: ResolvedClineLaunchConfig;
		try {
			launchConfig = await this.resolveLaunchConfig(
				reviewPolicy.modelOverride
					? {
							providerIdOverride: reviewPolicy.modelOverride.providerId,
							modelIdOverride: reviewPolicy.modelOverride.modelId,
						}
					: {},
			);
		} catch (error) {
			return this.failureResponse(
				sessionId,
				`Failed to resolve the review model configuration: ${toErrorMessage(error)}`,
				warnings,
				artifact,
			);
		}

		// B-6.2: a fresh, bounded review session (own session id + context).
		try {
			await this.sessionService.startTaskSession({
				taskId: sessionId,
				cwd: worktreePath,
				prompt: initialPrompt,
				requestToolApproval,
				providerId: launchConfig.providerId,
				modelId: launchConfig.modelId,
				apiKey: launchConfig.apiKey,
				baseUrl: launchConfig.baseUrl,
				reasoningEffort: launchConfig.reasoningEffort,
				contextWindowTokens: launchConfig.contextWindowTokens,
				contextWindowSource: launchConfig.contextWindowSource,
				compaction: buildClineCompactionConfig({ launchConfig }),
				compactionSafetyMarginTokens: launchConfig.compactionSettings?.safetyMarginTokens,
			});
		} catch (error) {
			return this.failureResponse(
				sessionId,
				`Failed to start the review session: ${toErrorMessage(error)}`,
				warnings,
				artifact,
			);
		}

		// B-6.4: the session service dispatches turns fire-and-forget, so await the
		// terminal state before inspecting the result.
		const firstTerminal = await this.waitForTerminalState(sessionId);
		let sessionFailed = isFailedTerminal(firstTerminal);
		let failureReason = terminalFailureReason(firstTerminal);
		let result: RuntimeReviewResultOutput | null = sessionFailed ? null : this.extractResult(sessionId);

		// B-6.5: bounded repair rounds for the findings the reviewer left open.
		if (!sessionFailed) {
			let round = 0;
			while (result && result.findings.length > 0 && round < reviewPolicy.maxRepairRounds) {
				round += 1;
				const repairPrompt = buildReviewRepairPrompt({
					artifact,
					findings: result.findings,
					round,
					maxRounds: reviewPolicy.maxRepairRounds,
				});
				await this.sessionService.sendTaskSessionInput(sessionId, repairPrompt);
				const terminal = await this.waitForTerminalState(sessionId);
				if (isFailedTerminal(terminal)) {
					sessionFailed = true;
					failureReason = terminalFailureReason(terminal);
					result = null;
					break;
				}
				result = this.extractResult(sessionId);
				if (!result) {
					break;
				}
			}
		}

		// B-6.7: bind the verdict to the candidate content tree (after any fixes).
		const candidateTreeHash = await this.evidence.computeTreeHash(worktreePath).catch(() => null);

		const outcome = this.buildOutcome({
			taskId,
			sessionId,
			sessionFailed,
			failureReason,
			result,
			candidateTreeHash,
			warnings,
		});
		await this.evidence.persistOutcome(taskId, outcome).catch(() => {});

		return this.buildStartResponse({ artifact, outcome, candidateTreeHash, sessionId, warnings });
	}

	async getReviewInfo(taskId: string): Promise<RuntimeTaskReviewInfoResponse> {
		const warnings: string[] = [];
		const handoff = await this.evidence.readHandoff(taskId).catch(() => null);
		const outcome = await this.evidence.readOutcome(taskId).catch(() => null);
		const result = outcome?.result ?? null;

		// B-6.7: recompute the current tree hash so callers can tell whether later
		// edits invalidated the stored verdict.
		let candidateTreeHash: string | null = null;
		try {
			const baseRef = await this.evidence.loadTaskBaseRef(taskId);
			if (baseRef) {
				const worktreePath = await this.evidence.resolveWorktreePath(taskId, baseRef);
				candidateTreeHash = await this.evidence.computeTreeHash(worktreePath);
			}
		} catch {
			candidateTreeHash = null;
		}

		const resultMatchesTree =
			result && candidateTreeHash !== null ? result.candidateTreeHash === candidateTreeHash : null;

		return {
			ok: true,
			status: outcome?.status ?? null,
			handoff,
			result,
			candidateTreeHash,
			resultMatchesTree,
			error: outcome?.error ?? null,
			warnings,
		};
	}

	async dispose(): Promise<void> {
		// Best-effort: stop any in-flight review session. The underlying in-memory
		// service is disposed separately by the caller (DI).
		for (const summary of this.sessionService.listSummaries()) {
			if (summary.state === "running") {
				await this.sessionService.stopTaskSession(summary.taskId).catch(() => null);
			}
		}
	}

	/**
	 * Resolves once the session leaves the running state. Checks the current
	 * summary first so a turn that finished before the subscription is set up is
	 * not missed (the session service dispatches turns fire-and-forget).
	 */
	private async waitForTerminalState(sessionId: string): Promise<RuntimeTaskSessionSummary> {
		const current = this.sessionService.getSummary(sessionId);
		if (current && current.state !== "running") {
			return current;
		}
		return await new Promise<RuntimeTaskSessionSummary>((resolve) => {
			const unsubscribe = this.sessionService.onSummary((summary) => {
				if (summary.taskId !== sessionId) {
					return;
				}
				if (summary.state !== "running") {
					unsubscribe();
					resolve(summary);
				}
			});
		});
	}

	/**
	 * B-6.4: extracts the reviewer's structured result. The most recent assistant
	 * message containing a fenced block is authoritative — a missing or malformed
	 * block is a parse failure (never a pass), and it never falls back to an older block.
	 */
	private extractResult(sessionId: string): RuntimeReviewResultOutput | null {
		const messages = this.sessionService.listMessages(sessionId);
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (!message || message.role !== "assistant") {
				continue;
			}
			const block = extractReviewResultBlock(message.content);
			if (block === null) {
				continue;
			}
			let parsedJson: unknown;
			try {
				parsedJson = JSON.parse(block);
			} catch {
				return null;
			}
			const parsed = runtimeReviewResultOutputSchema.safeParse(parsedJson);
			return parsed.success ? parsed.data : null;
		}
		return null;
	}

	private buildOutcome(input: {
		taskId: string;
		sessionId: string;
		sessionFailed: boolean;
		failureReason: string | null;
		result: RuntimeReviewResultOutput | null;
		candidateTreeHash: string | null;
		warnings: string[];
	}): RuntimeReviewOutcomeFile {
		const { taskId, sessionId, sessionFailed, failureReason, result, candidateTreeHash, warnings } = input;
		const updatedAt = Date.now();
		if (sessionFailed) {
			return {
				status: "failed",
				result: null,
				error: failureReason ?? "The review session failed before producing a result.",
				sessionId,
				warnings,
				updatedAt,
			};
		}
		if (result === null) {
			return {
				status: "parse_failed",
				result: null,
				error: "The reviewer did not submit a valid kanban-review-result block.",
				sessionId,
				warnings,
				updatedAt,
			};
		}
		const stamped: RuntimeReviewResult = {
			...result,
			taskId,
			candidateTreeHash,
			reviewedAt: updatedAt,
		};
		return {
			status: result.blocking ? "blocked" : "ready",
			result: stamped,
			error: null,
			sessionId,
			warnings,
			updatedAt,
		};
	}

	private failureResponse(
		sessionId: string,
		error: string,
		warnings: string[],
		handoff: RuntimeReviewHandoffArtifact | null = null,
	): RuntimeTaskReviewStartResponse {
		return {
			ok: false,
			status: "failed",
			handoff,
			result: null,
			candidateTreeHash: null,
			sessionId,
			error,
			warnings,
		};
	}

	private buildStartResponse(input: {
		artifact: RuntimeReviewHandoffArtifact;
		outcome: RuntimeReviewOutcomeFile;
		candidateTreeHash: string | null;
		sessionId: string;
		warnings: string[];
	}): RuntimeTaskReviewStartResponse {
		const { artifact, outcome, candidateTreeHash, sessionId, warnings } = input;
		return {
			ok: outcome.status === "ready" || outcome.status === "blocked",
			status: outcome.status,
			handoff: artifact,
			result: outcome.result,
			candidateTreeHash,
			sessionId,
			error: outcome.error,
			warnings,
		};
	}
}

export function createClineReviewSessionService(
	options: CreateClineReviewSessionServiceOptions,
): ClineReviewSessionService {
	const evidence = options.evidence ?? createDefaultReviewEvidencePort(options.workspaceId, options.repoPath);
	return new ClineReviewSessionServiceImpl(
		options.clineTaskSessionService,
		options.resolveClineLaunchConfig,
		options.repoPath,
		evidence,
	);
}
