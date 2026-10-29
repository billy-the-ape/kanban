// B-6.2 / B-6.4 / B-6.5 / B-6.7 / B-6.9 — bounded, fresh-context review sessions.
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
//
// AR-6 — outcome correlation: the session service dispatches turns
// fire-and-forget and can reject an input outright, so every dispatched turn
// carries a receipt (the transcript's user message holding its accepted
// input). A turn's terminal state is only consumed after its receipt proves
// the input was accepted — an already-terminal prior summary is never
// completion evidence for a newer turn, and the structured result is extracted
// from that turn's own messages only (an inherited earlier block is a parse
// failure, never a fallback).
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
	RuntimeVerificationConfig,
	RuntimeVerificationReceipt,
} from "../core/api-contract";
import { runtimeReviewResultOutputSchema } from "../core/api-contract";
import { createVerificationRunner, type VerificationRunner } from "../verification/verification-service";
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
import {
	baseTaskIdForReviewSessionId,
	reviewSessionIdForTask,
	VERIFICATION_REPAIR_SESSION_SUFFIX,
} from "./cline-session-ids";
import type { ClineLaunchConfigResolver } from "./cline-session-runtime";
import { buildSessionIdPrefix } from "./cline-session-state";
import {
	type ClineTaskExportSegment,
	type ClineTaskExportSnapshot,
	type ClineTaskExportSnapshotOptions,
	compareExportStringValues,
	labelSegmentToolOrigins,
} from "./cline-task-export-snapshot";
import type { ClineTaskSessionService, StartClineTaskSessionRequest } from "./cline-task-session-service";
import { buildReviewInitialPrompt, buildReviewRepairPrompt, buildVerificationRepairPrompt } from "./review-prompt";
import { createReviewToolPolicy } from "./review-tool-policy";

export { baseTaskIdForReviewSessionId, reviewSessionIdForTask };

/** B-6.5: default bounded repair-round budget (initial evaluation value is two). */
const DEFAULT_MAX_REPAIR_ROUNDS = 2;
/** B-6: a single review/repair turn that runs longer than this is stopped and reported as failed. */
const DEFAULT_REVIEW_TURN_TIMEOUT_MS = 30 * 60_000;
/** AR-6: bounded settle for a turn's reply landing in the transcript after the terminal state. */
const TURN_RESULT_SETTLE_MS = 5_000;
/** AR-6: poll interval while settling a turn's reply into the transcript. */
const TURN_RESULT_SETTLE_POLL_MS = 25;

/** B-6: the evidence a review run needs, abstracted for unit testing. */
export interface ClineReviewEvidencePort {
	loadTaskBaseRef(taskId: string): Promise<string | null>;
	resolveWorktreePath(taskId: string, baseRef: string): Promise<string>;
	readReviewRequest(taskId: string): Promise<TaskReviewRequest>;
	buildHandoffArtifact(input: BuildReviewHandoffInput): Promise<RuntimeReviewHandoffArtifact>;
	persistHandoff(artifact: RuntimeReviewHandoffArtifact): Promise<string>;
	readHandoff(taskId: string): Promise<RuntimeReviewHandoffArtifact | null>;
	/**
	 * AR-6: derives the review diff against the trusted baseline (recorded
	 * start, preserved start, or the task's base branch) — the same resolution
	 * as the handoff artifact, so the prompt's diff matches its changed paths.
	 */
	extractDiff(
		worktreePath: string,
		taskId: string,
		startingCommit: string | null,
		baseRef: string | null,
	): Promise<string>;
	computeTreeHash(worktreePath: string): Promise<string | null>;
	persistOutcome(taskId: string, outcome: RuntimeReviewOutcomeFile): Promise<string>;
	readOutcome(taskId: string): Promise<RuntimeReviewOutcomeFile | null>;
}

/** B-6.2: the start input — the validated request plus the effective review policy. */
export interface ClineReviewStartInput extends RuntimeTaskReviewStartRequest {
	/** Effective review policy; absent means all defaults (off, 2 repair rounds). */
	reviewPolicy?: RuntimeReviewPolicy;
	/** B-7.1: effective verification gate config; absent/null means the gate is inactive. */
	verification?: RuntimeVerificationConfig | null;
}

export interface ClineReviewSessionService {
	startTaskReview(input: ClineReviewStartInput): Promise<RuntimeTaskReviewStartResponse>;
	/**
	 * B-11.2: live review/repair sessions. Their ids are `<taskId>::review` /
	 * `<taskId>::verification-repair-N`; the base task ids hold worker slots.
	 */
	listSessionSummaries(): RuntimeTaskSessionSummary[];
	/**
	 * DIAG-2 (2a): read-only export snapshot of the task's review lineage:
	 * the review session (kind "review") plus every verification repair
	 * session (kind "verification-repair"), in creation order, each with its
	 * durable transcript and (while running) its live tail. Never pauses,
	 * clears, or mutates review state.
	 */
	getSessionExportSnapshot(
		baseTaskId: string,
		options?: ClineTaskExportSnapshotOptions,
	): Promise<ClineTaskExportSnapshot>;
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
	/** B-7: injectable deterministic verification runner (defaults to the spawned-check service). */
	verificationRunner?: VerificationRunner;
	/**
	 * B-6.2: true while the task's implementation writer (its own agent
	 * session) is still running; a review must not start against a worktree
	 * that is still being written.
	 */
	isTaskWriterActive?: (taskId: string) => Promise<boolean>;
	/** Upper bound for one review/repair turn (default 30 minutes). */
	turnTimeoutMs?: number;
}

function createDefaultReviewEvidencePort(workspaceId: string, repoPath: string): ClineReviewEvidencePort {
	return {
		loadTaskBaseRef: (taskId) => findTaskBaseRef(workspaceId, taskId),
		resolveWorktreePath: (taskId, baseRef) => resolveTaskCwd({ cwd: repoPath, taskId, baseRef, ensure: false }),
		readReviewRequest: (taskId) => readTaskReviewRequest(taskId),
		buildHandoffArtifact: (input) => buildReviewHandoffArtifact(input),
		persistHandoff: (artifact) => persistReviewHandoff(artifact),
		readHandoff: (taskId) => readReviewHandoff(taskId),
		extractDiff: (worktreePath, taskId, startingCommit, baseRef) =>
			extractReviewDiff(worktreePath, taskId, startingCommit, baseRef),
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

/** Extracts every fenced `kanban-review-result` JSON body from a message, in order. */
function extractReviewResultBlocks(text: string): string[] {
	const blocks: string[] = [];
	const pattern = /```kanban-review-result[ \t]*\r?\n([\s\S]*?)```/g;
	for (const match of text.matchAll(pattern)) {
		const body = match[1]?.trim();
		if (body && body.length > 0) {
			blocks.push(body);
		}
	}
	return blocks;
}

/** A terminal summary is a failure when the session was interrupted or the agent errored. */
function isFailedTerminal(summary: RuntimeTaskSessionSummary): boolean {
	return summary.state === "interrupted" || summary.reviewReason === "error";
}

function terminalFailureReason(summary: RuntimeTaskSessionSummary): string | null {
	if (summary.warningMessage?.trim()) {
		return summary.warningMessage.trim();
	}
	if (summary.state === "interrupted") {
		return "The review session was interrupted before it produced a result.";
	}
	return null;
}

/**
 * AR-6: binds a dispatched review/repair turn to its accepted input. The
 * session service appends the accepted input as a user message before
 * dispatching the turn, so the receipt points at that exact message.
 */
interface ReviewTurnReceipt {
	sessionId: string;
	/** Id of the user message holding this turn's accepted input. */
	userMessageId: string;
}

/**
 * AR-6: locates the user message holding a turn's accepted input. Throws when
 * the dispatch did not record an accepted input (a rejected send or a start
 * that dispatched nothing) — an unsuccessful dispatch must fail explicitly,
 * never resolve against an older turn's terminal summary.
 */
function captureTurnReceipt(
	listMessages: (taskId: string) => Array<{ id: string; role: string }>,
	sessionId: string,
	messageCountBefore: number,
): ReviewTurnReceipt {
	const messages = listMessages(sessionId);
	for (let index = messages.length - 1; index >= messageCountBefore; index -= 1) {
		const message = messages[index];
		if (message && message.role === "user") {
			return { sessionId, userMessageId: message.id };
		}
	}
	throw new Error(
		"The session did not accept the review input (no user message was recorded for the dispatched turn).",
	);
}

/**
 * Parses the `<ts>-<rand8>` tail of a session id as produced by
 * createSessionId: `<taskId prefix>-<epoch ms>-<8-char base36>`.
 */
const REPAIR_SESSION_ID_SUFFIX_PATTERN = /^(\d+)-\d{13}-[0-9a-z]{8}$/;

/**
 * DIAG-2 (2a): classifies a review-lineage session id into its session kind
 * and the service-scoped task id whose context-artifacts directory owns the
 * session's full tool outputs. Null for ids outside the review lineage.
 */
function classifyReviewSegmentKind(
	sessionId: string,
	baseTaskId: string,
): { kind: "review" | "verification-repair"; serviceTaskId: string } | null {
	const reviewTaskId = reviewSessionIdForTask(baseTaskId);
	const reviewPrefix = buildSessionIdPrefix(reviewTaskId);
	if (sessionId.startsWith(reviewPrefix)) {
		return { kind: "review", serviceTaskId: reviewTaskId };
	}
	// Repair sessions are started under `<review id>::verification-repair-<N>`,
	// so their session ids share the prefix ending right after `repair-`.
	const repairPrefix = buildSessionIdPrefix(`${reviewTaskId}${VERIFICATION_REPAIR_SESSION_SUFFIX.slice(0, -1)}`);
	if (sessionId.startsWith(repairPrefix)) {
		const rest = sessionId.slice(repairPrefix.length);
		const match = REPAIR_SESSION_ID_SUFFIX_PATTERN.exec(rest);
		const round = match ? Number(match[1]) : null;
		const serviceTaskId =
			round !== null && Number.isSafeInteger(round) && round > 0
				? `${reviewTaskId}${VERIFICATION_REPAIR_SESSION_SUFFIX}${round}`
				: `${reviewTaskId}${VERIFICATION_REPAIR_SESSION_SUFFIX}`;
		return { kind: "verification-repair", serviceTaskId };
	}
	return null;
}

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

interface ReviewTurnOutcome {
	failed: boolean;
	failureReason: string | null;
}

class ClineReviewSessionServiceImpl implements ClineReviewSessionService {
	private readonly sessionService: ClineTaskSessionService;
	private readonly resolveLaunchConfig: ClineLaunchConfigResolver;
	private readonly repoPath: string;
	private readonly evidence: ClineReviewEvidencePort;
	private readonly verificationRunner: VerificationRunner;
	private readonly isTaskWriterActive: (taskId: string) => Promise<boolean>;
	private readonly turnTimeoutMs: number;
	private readonly inFlightTaskIds = new Set<string>();

	constructor(options: {
		sessionService: ClineTaskSessionService;
		resolveLaunchConfig: ClineLaunchConfigResolver;
		repoPath: string;
		evidence: ClineReviewEvidencePort;
		verificationRunner: VerificationRunner;
		isTaskWriterActive: (taskId: string) => Promise<boolean>;
		turnTimeoutMs: number;
	}) {
		this.sessionService = options.sessionService;
		this.resolveLaunchConfig = options.resolveLaunchConfig;
		this.repoPath = options.repoPath;
		this.evidence = options.evidence;
		this.verificationRunner = options.verificationRunner;
		this.isTaskWriterActive = options.isTaskWriterActive;
		this.turnTimeoutMs = options.turnTimeoutMs;
	}

	/** B-11.2: live review/repair sessions (they hold the base tasks' worker slots). */
	listSessionSummaries(): RuntimeTaskSessionSummary[] {
		return this.sessionService.listSummaries();
	}

	/**
	 * DIAG-2 (2a): read-only export snapshot of the task's review lineage.
	 * The review session's own snapshot plus one per verification repair
	 * session (each repair round owns a separate session) are merged by
	 * session id, de-duplicated, and sorted in creation order. Segments are
	 * kind-tagged ("review" / "verification-repair") and carry the
	 * service-scoped task id that owns each session's context-artifacts
	 * directory. Never pauses, clears, or mutates review state.
	 */
	async getSessionExportSnapshot(
		baseTaskId: string,
		options?: ClineTaskExportSnapshotOptions,
	): Promise<ClineTaskExportSnapshot> {
		const reviewTaskId = reviewSessionIdForTask(baseTaskId);
		const repairTaskIdBase = `${reviewTaskId}${VERIFICATION_REPAIR_SESSION_SUFFIX}`;
		const wantedTaskIds = new Set<string>([reviewTaskId, repairTaskIdBase]);
		// Live repair sessions are only enumerable through their summaries;
		// durable-only repair sessions are found through the common prefix query.
		for (const summary of this.sessionService.listSummaries()) {
			if (summary.taskId === reviewTaskId || summary.taskId.startsWith(repairTaskIdBase)) {
				wantedTaskIds.add(summary.taskId);
			}
		}
		const ownerPaths = options?.ownerPaths ?? (await this.resolveReviewExportOwnerPaths(baseTaskId));
		// The bare repair base id prefixes no session id on its own (each round
		// appends its number first); the common prefix ends after `repair-`.
		const repairSessionIdPrefix = buildSessionIdPrefix(
			`${reviewTaskId}${VERIFICATION_REPAIR_SESSION_SUFFIX.slice(0, -1)}`,
		);
		const snapshotsWithErrors = await Promise.all(
			[...wantedTaskIds].map(async (sessionTaskId) => {
				try {
					return {
						sessionTaskId,
						snapshot: await this.sessionService.getTaskExportSnapshot(sessionTaskId, {
							ownerPaths,
							...(sessionTaskId === repairTaskIdBase ? { sessionIdPrefix: repairSessionIdPrefix } : {}),
						}),
						error: null,
					};
				} catch (error) {
					// A per-session snapshot read failure is an explicit gap
					// (Decision 5), never a silently dropped transcript.
					return {
						sessionTaskId,
						snapshot: null,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);
		const enumerationErrors: string[] = [];
		const snapshots = snapshotsWithErrors.flatMap((result) => {
			if (result.error !== null) {
				enumerationErrors.push(`session ${result.sessionTaskId}: ${result.error}`);
				return [];
			}
			return result.snapshot ? [result.snapshot] : [];
		});

		const merged = new Map<string, ClineTaskExportSegment>();
		let listingTruncated = false;
		let capturedAt = Date.now();
		for (const snapshot of snapshots) {
			listingTruncated = listingTruncated || snapshot.listingTruncated;
			capturedAt = Math.max(capturedAt, snapshot.capturedAt);
			for (const segment of snapshot.segments) {
				const existing = merged.get(segment.header.sessionId);
				if (!existing) {
					merged.set(segment.header.sessionId, segment);
					continue;
				}
				// The same session may be reachable through the repair prefix
				// and the specific repair id; the specific id owns the
				// session's context-artifacts directory.
				if (segment.artifactTaskId.length > existing.artifactTaskId.length) {
					existing.artifactTaskId = segment.artifactTaskId;
				}
				if (existing.readError !== null && segment.readError === null) {
					existing.readError = null;
					existing.messages = segment.messages;
					existing.transcript = segment.transcript;
				}
				if (!existing.liveTail && segment.liveTail) {
					existing.liveTail = segment.liveTail;
				}
			}
		}
		const segments = [...merged.values()];
		segments.sort(
			(a, b) =>
				compareExportStringValues(a.header.startedAt ?? "", b.header.startedAt ?? "") ||
				compareExportStringValues(a.header.sessionId, b.header.sessionId),
		);
		for (const segment of segments) {
			const classification = classifyReviewSegmentKind(segment.header.sessionId, baseTaskId);
			if (classification) {
				segment.header.kind = classification.kind;
				segment.artifactTaskId = classification.serviceTaskId;
			}
		}
		labelSegmentToolOrigins(segments);
		return {
			kind: "review",
			taskId: baseTaskId,
			capturedAt,
			listingTruncated,
			enumerationErrors,
			segments,
		};
	}

	/**
	 * Default ownership filter for review/repair export snapshots: the main
	 * repo checkout plus the task's worktree (the review sessions' cwd).
	 * Returns undefined (no filtering) when the worktree cannot be resolved —
	 * including the transcript is better than silently dropping it.
	 */
	private async resolveReviewExportOwnerPaths(baseTaskId: string): Promise<string[] | undefined> {
		const repoPath = this.repoPath.trim();
		if (!repoPath) {
			return undefined;
		}
		try {
			const baseRef = await this.evidence.loadTaskBaseRef(baseTaskId);
			if (!baseRef) {
				return undefined;
			}
			const worktreePath = await this.evidence.resolveWorktreePath(baseTaskId, baseRef);
			return [repoPath, worktreePath];
		} catch {
			return undefined;
		}
	}

	async startTaskReview(input: ClineReviewStartInput): Promise<RuntimeTaskReviewStartResponse> {
		const sessionId = reviewSessionIdForTask(input.taskId);
		// One review owner per task: a double-click or second tab must not start
		// a competing session against the same worktree.
		if (this.inFlightTaskIds.has(input.taskId)) {
			return this.failureResponse(sessionId, "A review is already running for this task.", []);
		}
		this.inFlightTaskIds.add(input.taskId);
		try {
			return await this.runReview(input, sessionId);
		} finally {
			this.inFlightTaskIds.delete(input.taskId);
		}
	}

	private async runReview(input: ClineReviewStartInput, sessionId: string): Promise<RuntimeTaskReviewStartResponse> {
		const taskId = input.taskId;
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

		// B-6.2: review only after the implementation writer has stopped.
		if (await this.isTaskWriterActive(taskId).catch(() => false)) {
			return this.failureResponse(
				sessionId,
				"The task's implementation session is still running; wait for it to finish (or stop it) before starting a review.",
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
		// AR-6: the handoff must be built from a trusted starting/base commit
		// (recorded, preserved, or derived from the base branch); a missing
		// baseline fails here with an actionable message, never an empty diff.
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
				baseRef,
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
		// AR-6: the diff uses the same baseline resolution as the artifact so
		// the prompt's change set always matches the artifact's changed paths.
		const diff = await this.evidence
			.extractDiff(worktreePath, taskId, artifact.startingCommit, baseRef)
			.catch(() => "");
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
		// The review policy only adds denials; everything else goes through the
		// workspace's existing approval handler (existing tool approvals stay effective).
		const wrapToolApproval: StartClineTaskSessionRequest["wrapToolApproval"] = (workspaceApproval) =>
			createReviewToolPolicy({
				worktreePath,
				allowedWritePaths: [...allowedWritePaths],
				delegate: workspaceApproval,
			});

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
		// AR-6: the start returns the turn receipt (the accepted input's user
		// message); a start that records no accepted input fails explicitly.
		const startBoundedSession = async (id: string, prompt: string): Promise<ReviewTurnReceipt> => {
			await this.resetSession(id);
			const messageCountBefore = this.sessionService.listMessages(id).length;
			await this.sessionService.startTaskSession({
				taskId: id,
				cwd: worktreePath,
				prompt,
				wrapToolApproval,
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
			return captureTurnReceipt(this.sessionService.listMessages.bind(this.sessionService), id, messageCountBefore);
		};
		let firstReceipt: ReviewTurnReceipt;
		try {
			firstReceipt = await startBoundedSession(sessionId, initialPrompt);
		} catch (error) {
			return this.failureResponse(
				sessionId,
				`Failed to start the review session: ${toErrorMessage(error)}`,
				warnings,
				artifact,
			);
		}

		// B-6.4: the session service dispatches turns fire-and-forget, so await the
		// terminal state before inspecting the result. AR-6: only reached after
		// the receipt proves the input was accepted, so an older terminal
		// summary can never stand in for this turn's completion.
		const firstTurn = await this.awaitTurn(sessionId);
		let sessionFailed = firstTurn.failed;
		let failureReason = firstTurn.failureReason;
		let result: RuntimeReviewResultOutput | null = sessionFailed
			? null
			: await this.extractTurnResult(sessionId, firstReceipt);
		// B-7.5: the repair-round budget is shared between review repairs and verification repairs.
		let round = 0;

		// B-6.5: bounded repair rounds for the findings the reviewer left open.
		if (!sessionFailed) {
			while (result && result.findings.length > 0 && round < reviewPolicy.maxRepairRounds) {
				round += 1;
				const repairPrompt = buildReviewRepairPrompt({
					artifact,
					findings: result.findings,
					round,
					maxRounds: reviewPolicy.maxRepairRounds,
				});
				// AR-6: a rejected send (null) or a dispatch that records no
				// accepted input fails explicitly — the turn is never awaited
				// against an older terminal summary.
				const messageCountBefore = this.sessionService.listMessages(sessionId).length;
				const accepted = await this.sessionService.sendTaskSessionInput(sessionId, repairPrompt);
				let repairReceipt: ReviewTurnReceipt;
				try {
					repairReceipt = captureTurnReceipt(
						this.sessionService.listMessages.bind(this.sessionService),
						sessionId,
						messageCountBefore,
					);
				} catch (error) {
					sessionFailed = true;
					failureReason =
						accepted === null
							? "The repair input was not accepted by the review session; no repair turn was dispatched."
							: toErrorMessage(error);
					result = null;
					break;
				}
				const turn = await this.awaitTurn(sessionId);
				if (turn.failed) {
					sessionFailed = true;
					failureReason = turn.failureReason;
					result = null;
					break;
				}
				// AR-6: the result comes from this turn's own messages only; an
				// inherited block from an earlier turn is a parse failure, not a
				// fallback (this is what prevented the repeated-finding loop).
				result = await this.extractTurnResult(sessionId, repairReceipt);
				if (!result) {
					break;
				}
			}
		}

		// B-6.7: bind the verdict to the candidate content tree (after any fixes).
		let candidateTreeHash = await this.evidence.computeTreeHash(worktreePath).catch(() => null);

		// B-7.2/B-7.5: the deterministic verification gate runs after the review
		// is frozen and only gates the "ready" path (a blocked/failed review
		// never reaches delivery). It is independent of the reviewer's narrative.
		// Each failed run feeds a FRESH bounded repair session (write-scoped to
		// the reviewed change set), and repairs share the review's round budget.
		let verification: RuntimeVerificationReceipt | null = null;
		const verificationConfig = input.verification?.enabled === "required" ? input.verification : null;
		if (!sessionFailed && result && !result.blocking && verificationConfig) {
			let receipt = await this.verificationRunner
				.run(verificationConfig, { taskId, worktreePath, candidateTreeHash })
				.catch((error: unknown) => this.unrunnableReceipt(toErrorMessage(error), candidateTreeHash));
			while (!receipt.passed && round < reviewPolicy.maxRepairRounds) {
				round += 1;
				const repairSessionId = `${sessionId}${VERIFICATION_REPAIR_SESSION_SUFFIX}${round}`;
				const repairPrompt = buildVerificationRepairPrompt({
					artifact,
					receipt,
					round,
					maxRounds: reviewPolicy.maxRepairRounds,
				});
				try {
					await startBoundedSession(repairSessionId, repairPrompt);
				} catch (error) {
					sessionFailed = true;
					failureReason = `Failed to start the verification repair session: ${toErrorMessage(error)}`;
					result = null;
					break;
				}
				const turn = await this.awaitTurn(repairSessionId);
				if (turn.failed) {
					sessionFailed = true;
					failureReason = turn.failureReason;
					result = null;
					break;
				}
				// The repair edited the worktree: re-bind to the new tree and re-run
				// the gate (B-7.2 tree-identity binding).
				candidateTreeHash = await this.evidence.computeTreeHash(worktreePath).catch(() => null);
				receipt = await this.verificationRunner
					.run(verificationConfig, { taskId, worktreePath, candidateTreeHash })
					.catch((error: unknown) => this.unrunnableReceipt(toErrorMessage(error), candidateTreeHash));
			}
			// The verdict stays bound to the tree the checks started from; a run that
			// mutated the tree has already failed the gate (B-7.4), so nothing
			// unreviewed can be marked ready.
			verification = receipt;
		}

		const outcome = this.buildOutcome({
			taskId,
			sessionId,
			sessionFailed,
			failureReason,
			result,
			candidateTreeHash,
			verification,
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
			verification: outcome?.verification ?? null,
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

	/** Clears a previous (non-running) session with this id so the next start is a fresh context. */
	private async resetSession(sessionId: string): Promise<void> {
		if (!this.sessionService.getSummary(sessionId)) {
			return;
		}
		await this.sessionService.stopTaskSession(sessionId).catch(() => null);
		await this.sessionService.clearTaskSession(sessionId).catch(() => null);
	}

	/**
	 * Awaits the end of the turn whose input was accepted (see the turn
	 * receipt). A turn that exceeds the turn timeout is stopped and reported
	 * as a failure instead of hanging the caller.
	 */
	private async awaitTurn(sessionId: string): Promise<ReviewTurnOutcome> {
		const summary = await this.waitForTerminalState(sessionId, this.turnTimeoutMs);
		if (!summary) {
			await this.sessionService.stopTaskSession(sessionId).catch(() => null);
			return {
				failed: true,
				failureReason: `The review turn exceeded the ${Math.round(this.turnTimeoutMs / 60_000)}-minute limit and was stopped.`,
			};
		}
		return isFailedTerminal(summary)
			? { failed: true, failureReason: terminalFailureReason(summary) }
			: { failed: false, failureReason: null };
	}

	/**
	 * Resolves once the session leaves the running state (null on timeout).
	 * Checks the current summary first so a turn that started and finished
	 * before the subscription is set up is not missed (the session service
	 * dispatches turns fire-and-forget). AR-6: this is only entered after the
	 * turn receipt proves the dispatched input was accepted, so an
	 * already-terminal summary from an older turn can never be consumed as
	 * this turn's completion.
	 */
	private async waitForTerminalState(sessionId: string, timeoutMs: number): Promise<RuntimeTaskSessionSummary | null> {
		const current = this.sessionService.getSummary(sessionId);
		if (current && current.state !== "running") {
			return current;
		}
		return await new Promise<RuntimeTaskSessionSummary | null>((resolve) => {
			const timer = setTimeout(() => {
				unsubscribe();
				resolve(null);
			}, timeoutMs);
			const unsubscribe = this.sessionService.onSummary((summary) => {
				if (summary.taskId !== sessionId || summary.state === "running") {
					return;
				}
				clearTimeout(timer);
				unsubscribe();
				resolve(summary);
			});
		});
	}

	/**
	 * AR-6: extracts the turn's structured result, waiting (bounded) for the
	 * turn's reply to land in the transcript when the terminal state was
	 * observed before the reply was appended. A turn whose reply carries no
	 * result block of its own is a parse failure.
	 */
	private async extractTurnResult(
		sessionId: string,
		receipt: ReviewTurnReceipt,
	): Promise<RuntimeReviewResultOutput | null> {
		const deadline = Date.now() + TURN_RESULT_SETTLE_MS;
		for (;;) {
			const result = this.extractResult(sessionId, receipt);
			if (result !== null) {
				return result;
			}
			const messages = this.sessionService.listMessages(sessionId);
			const turnStart = messages.findIndex((message) => message.id === receipt.userMessageId);
			const replyLanded =
				turnStart >= 0 && messages.slice(turnStart + 1).some((message) => message.role === "assistant");
			if (replyLanded || Date.now() >= deadline) {
				// The reply has landed without a block (a definitive parse
				// failure), or the settle window expired.
				return null;
			}
			await new Promise((resolve) => setTimeout(resolve, TURN_RESULT_SETTLE_POLL_MS));
		}
	}

	/**
	 * AR-6: structured result from the turn's own messages only. The last
	 * assistant block after the accepted input is authoritative: a missing or
	 * malformed block is a parse failure (never a pass, never a fallback to an
	 * inherited earlier block), and multiple distinct result blocks in one
	 * turn is an explicit parse failure rather than an arbitrary choice.
	 */
	private extractResult(sessionId: string, receipt: ReviewTurnReceipt): RuntimeReviewResultOutput | null {
		const messages = this.sessionService.listMessages(sessionId);
		const turnStart = messages.findIndex((message) => message.id === receipt.userMessageId);
		if (turnStart < 0) {
			return null;
		}
		const blocks: string[] = [];
		for (let index = turnStart + 1; index < messages.length; index += 1) {
			const message = messages[index];
			if (!message || message.role !== "assistant") {
				continue;
			}
			blocks.push(...extractReviewResultBlocks(message.content));
		}
		if (blocks.length === 0) {
			return null;
		}
		const finalBlock = blocks[blocks.length - 1];
		const normalized = (block: string): string | null => {
			try {
				return JSON.stringify(JSON.parse(block));
			} catch {
				return null;
			}
		};
		const finalNormalized = normalized(finalBlock);
		for (const block of blocks.slice(0, -1)) {
			const priorNormalized = normalized(block);
			if (priorNormalized !== null && finalNormalized !== null && priorNormalized !== finalNormalized) {
				// Contradictory result blocks in one turn: no arbitrary choice.
				return null;
			}
		}
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(finalBlock);
		} catch {
			return null;
		}
		const parsed = runtimeReviewResultOutputSchema.safeParse(parsedJson);
		return parsed.success ? parsed.data : null;
	}

	private buildOutcome(input: {
		taskId: string;
		sessionId: string;
		sessionFailed: boolean;
		failureReason: string | null;
		result: RuntimeReviewResultOutput | null;
		candidateTreeHash: string | null;
		verification: RuntimeVerificationReceipt | null;
		warnings: string[];
	}): RuntimeReviewOutcomeFile {
		const { taskId, sessionId, sessionFailed, failureReason, result, candidateTreeHash, verification, warnings } =
			input;
		const updatedAt = Date.now();
		if (sessionFailed) {
			return {
				status: "failed",
				result: null,
				error: failureReason ?? "The review session failed before producing a result.",
				sessionId,
				warnings,
				verification,
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
				verification,
				updatedAt,
			};
		}
		// B-7.2: the gate is independent of the reviewer's narrative — a clean
		// verdict with a failing receipt still blocks delivery.
		const gateFailed = verification !== null && !verification.passed;
		const stamped: RuntimeReviewResult = {
			...result,
			taskId,
			candidateTreeHash,
			reviewedAt: updatedAt,
		};
		return {
			status: result.blocking || gateFailed ? "blocked" : "ready",
			result: stamped,
			error: gateFailed ? (verification?.error ?? "The verification gate failed.") : null,
			sessionId,
			warnings,
			verification,
			updatedAt,
		};
	}

	/** B-7.2: a runner that cannot execute at all still blocks delivery. */
	private unrunnableReceipt(error: string, candidateTreeHash: string | null): RuntimeVerificationReceipt {
		const now = Date.now();
		return {
			treeHashBefore: candidateTreeHash,
			treeHashAfter: candidateTreeHash,
			treeIdentityPreserved: false,
			matchesCandidate: false,
			checks: [],
			passed: false,
			error: `Verification could not run: ${error}`,
			startedAt: now,
			finishedAt: now,
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
			verification: null,
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
			verification: outcome.verification ?? null,
		};
	}
}

export function createClineReviewSessionService(
	options: CreateClineReviewSessionServiceOptions,
): ClineReviewSessionService {
	const evidence = options.evidence ?? createDefaultReviewEvidencePort(options.workspaceId, options.repoPath);
	const verificationRunner = options.verificationRunner ?? createVerificationRunner();
	return new ClineReviewSessionServiceImpl({
		sessionService: options.clineTaskSessionService,
		resolveLaunchConfig: options.resolveClineLaunchConfig,
		repoPath: options.repoPath,
		evidence,
		verificationRunner,
		isTaskWriterActive: options.isTaskWriterActive ?? (async () => false),
		turnTimeoutMs: options.turnTimeoutMs ?? DEFAULT_REVIEW_TURN_TIMEOUT_MS,
	});
}
