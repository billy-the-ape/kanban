// COMMENT-0: the comment-handling observer/coordinator.
//
// One runtime-wide service (not per-workspace): active task cards with
// "auto address comments" enabled subscribe their github.com PRs to the
// service's ~60s poller (jittered, exponential backoff on transient
// failure). Owner selection: exactly one valid enabled task for a PR owns
// its comment handling; multiple candidates block all with a visible
// "choose repair owner" state; a held owner survives restarts until release
// or transfer. When eligible feedback is pending, a 120s quiet deadline
// (capped at 600s from first pending) schedules one debounced follow-up
// through the normal task chat path in Act mode. A failed dispatch stops
// further automatic instructions for that PR until an explicit Resume;
// restarts reconcile in-flight dispatches without ever re-running an
// accepted prompt.
//
// Implementation-agent publication attribution: the implementation session's
// own `gh pr comment` / `gh api` / `gh pr review --comment` writes are
// observed from native Cline tool events (implementation sessions only) and
// their exact comment/review identities are persisted in the record's
// `publication` block, then excluded from every fingerprint, pending count,
// deadline, and captured dispatch aggregate. A rolling safety cap allows at
// most five automatic send attempts per PR in 60 minutes; a sixth pauses
// automation until an explicit Resume.

import { randomUUID } from "node:crypto";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { ClineTurnPreparation } from "../cline-sdk/cline-turn-preparation";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeGitHubPrTrackingRecord,
	RuntimePrCommentAutomation,
	RuntimePrCommentOwner,
	RuntimePrFeedbackFingerprint,
	RuntimePrPublicationPending,
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
	RuntimeTaskPrCommentResumeResponse,
	RuntimeTaskPrTrackingState,
	RuntimeTaskPrTrackingStateResponse,
	RuntimeTaskPullRequest,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { getPullRequestIdentityKey } from "../core/pull-request-links";
import { resolveWorkspaceSessionSummaries } from "../core/workspace-session-summaries";
import { isTaskWriterActive } from "../server/task-writer-activity";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { refreshCommentWorktree } from "./comment-git-refresh";
import { buildCommentHandlingInstruction } from "./comment-handling-prompt";
import type { PrFeedbackEvent } from "./feedback-fingerprint";
import { computePrFeedbackFingerprint, findPrFeedbackPendingEvents } from "./feedback-fingerprint";
import type { GitHubPrClient, GitHubPrSnapshot } from "./github-pr-client";
import { listPrTrackingRecords, loadPrTrackingRecord, upsertPrTrackingRecord } from "./pr-comment-record-store";
import {
	analyzePrPublication,
	type PrPublicationObservation,
	type PrPublishedIdentity,
	prPublishedIdentityKey,
	resolvePublicationOutput,
} from "./pr-publication-attribution";

export { buildCommentHandlingInstruction } from "./comment-handling-prompt";

export interface PrCommentAutomationWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}

export interface PrCommentCandidate {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
}

interface PrSubscriptionState {
	key: string;
	pr: RuntimeTaskPullRequest;
	candidates: Map<string, PrCommentCandidate>;
	nextPollAt: number;
	dispatchRetryAt: number | null;
	consecutiveFailures: number;
	pollInFlight: boolean;
	settleInFlight: boolean;
}

/**
 * What a dispatch attempt did: sent the instruction, found nothing left to
 * address, or was held (pause, unresolved capture, failed send, ...) with a
 * user-visible reason.
 */
type DispatchOutcome = { status: "sent" } | { status: "nothing-pending" } | { status: "held"; reason: string };

const POLL_INTERVAL_MS = 60_000;
const POLL_JITTER_MS = 5_000;
const TICK_INTERVAL_MS = 10_000;
const DEBOUNCE_MS = 120_000;
const MAX_PENDING_MS = 600_000;
const DISPATCH_RETRY_MS = 30_000;
/** How long dispose() waits for already-running work before giving up on it. */
const DISPOSE_GRACE_MS = 3_000;
const BACKOFF_SCHEDULE_MS = [60_000, 120_000, 240_000, 480_000, 900_000];
/** Bounded automatic-turn backstop: at most N sends per PR per window. */
const MAX_AUTO_SEND_PER_WINDOW = 5;
const AUTO_SEND_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_PAUSED_REASON = `Automatic comment handling is paused after ${MAX_AUTO_SEND_PER_WINDOW} attempts in the last hour. Resume to continue.`;
/**
 * A start-phase capture whose tool result never arrived (turn cancelled,
 * host interrupted, ...) is stale after this long: it becomes an explicit
 * uncertainty so the visible blocker/Resume flow surfaces instead of a
 * silent settle block that only a restart would resolve.
 */
const CAPTURE_PENDING_STALE_MS = 10 * 60 * 1000;
const STALE_PENDING_CAPTURE_REASON =
	"A publication command started but its result never arrived; the published identity could not be confirmed.";
/** Columns whose tasks count as active comment-handling subscriptions. */
const ACTIVE_COLUMN_IDS = new Set(["backlog", "in_progress", "review"]);

function backoffMs(consecutiveFailures: number): number {
	return BACKOFF_SCHEDULE_MS[Math.min(Math.max(consecutiveFailures, 1) - 1, BACKOFF_SCHEDULE_MS.length - 1)];
}

export interface PrCommentAutomationServiceDependencies {
	listManagedWorkspaces: () => Array<PrCommentAutomationWorkspaceScope>;
	loadWorkspaceState: (workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	getClineTaskSessionService: (scope: PrCommentAutomationWorkspaceScope) => Promise<ClineTaskSessionService>;
	getTerminalManager: (scope: PrCommentAutomationWorkspaceScope) => Promise<TerminalSessionManager>;
	/**
	 * Resolves a workspaceId to its path from the durable workspace index —
	 * including workspaces that are not (yet) in `listManagedWorkspaces`.
	 * Restart reconciliation uses this so a queued dispatch for a not-yet
	 * loaded workspace is never wrongly failed at startup. Optional for test
	 * harnesses; when absent, only managed workspaces are reconciled.
	 */
	resolveWorkspacePathById?: (workspaceId: string) => Promise<string | null>;
	/** Reusable backend chat send — the same path the browser's sendTaskChatMessage uses. */
	sendTaskChatMessage: (
		scope: PrCommentAutomationWorkspaceScope,
		body: RuntimeTaskChatSendRequest,
		preparePrompt?: ClineTurnPreparation,
	) => Promise<RuntimeTaskChatSendResponse>;
	/**
	 * Effective agent for a card — a live session's agent when one exists,
	 * else the workspace's selected agent (same precedence as task start).
	 * Optional for test harnesses; when absent, only an explicit per-card
	 * `agentId: "cline"` counts as supported.
	 */
	getEffectiveTaskAgentId?: (
		scope: PrCommentAutomationWorkspaceScope,
		taskId: string,
	) => Promise<RuntimeAgentId | null>;
	getGitHubAccessScopeId: () => Promise<string>;
	ghClient: GitHubPrClient;
	refreshGit?: typeof refreshCommentWorktree;
	now?: () => number;
	warn?: (message: string) => void;
}

/**
 * Drops feedback events whose exact identities the implementation session
 * published (attribution metadata from the record's `publication` block).
 * Inline comments submitted inside a published review carry that review's id
 * but no captured identity of their own, so they are excluded via the review
 * id as well. Applied before every fingerprint, pending, deadline, and
 * captured aggregate computation — polling, dispatch validation, Resume, and
 * restart recovery all go through it.
 */
function excludePublishedEvents(
	events: PrFeedbackEvent[],
	published: Array<{ kind: "conversation" | "inline" | "review"; id: number }>,
): PrFeedbackEvent[] {
	if (published.length === 0) {
		return events;
	}
	const excluded = new Set(published.map(prPublishedIdentityKey));
	const publishedReviewIds = new Set(
		published.filter((identity) => identity.kind === "review").map((identity) => identity.id),
	);
	return events.filter(
		(event) =>
			!excluded.has(event.providerId) &&
			!(
				event.pullRequestReviewId !== undefined &&
				event.pullRequestReviewId !== null &&
				publishedReviewIds.has(event.pullRequestReviewId)
			),
	);
}

/** Keeps only distinct attempts inside the rolling safety window. */
function pruneAutoSendAttempts(
	attempts: Array<{ dispatchId: string; attemptedAt: number }>,
	nowMs: number,
): Array<{ dispatchId: string; attemptedAt: number }> {
	const seen = new Set<string>();
	const kept: Array<{ dispatchId: string; attemptedAt: number }> = [];
	for (const attempt of attempts) {
		if (attempt.attemptedAt < nowMs - AUTO_SEND_WINDOW_MS || seen.has(attempt.dispatchId)) {
			continue;
		}
		seen.add(attempt.dispatchId);
		kept.push(attempt);
	}
	return kept;
}

/**
 * Applies one successful GitHub poll outcome to a PR tracking record.
 * Owner selection, terminal observation, debounce scheduling, and pending
 * bookkeeping all happen here; the returned record is either unchanged (skip
 * the write) or advanced by exactly one revision.
 */
export function applyPrPollOutcome(
	record: RuntimeGitHubPrTrackingRecord,
	input: {
		candidates: PrCommentCandidate[];
		snapshot: GitHubPrSnapshot;
		nowMs: number;
	},
): RuntimeGitHubPrTrackingRecord {
	const automation = record.commentAutomation;
	const terminal = input.snapshot.prState !== "open";
	const candidateKey = (candidate: PrCommentCandidate) => `${candidate.workspaceId}/${candidate.taskId}`;
	const candidateMap = new Map(input.candidates.map((candidate) => [candidateKey(candidate), candidate]));

	// Bindings: upsert candidates, drop tasks that are no longer enabled.
	const nextBindings = [...record.taskBindings];
	for (const candidate of input.candidates) {
		const existing = nextBindings.find(
			(binding) => binding.workspaceId === candidate.workspaceId && binding.taskId === candidate.taskId,
		);
		if (!existing) {
			nextBindings.push({ workspaceId: candidate.workspaceId, taskId: candidate.taskId, terminal });
		} else if (existing.terminal !== terminal) {
			nextBindings[nextBindings.indexOf(existing)] = { ...existing, terminal };
		}
	}
	const keptBindings = nextBindings.filter((binding) => candidateMap.has(`${binding.workspaceId}/${binding.taskId}`));

	// Owner: held until released; assigned atomically for exactly one valid
	// candidate; blocked (null) when several candidates remain.
	let owner = automation.repairOwner;
	if (owner && !candidateMap.has(`${owner.workspaceId}/${owner.taskId}`)) {
		owner = null;
	}
	if (!owner) {
		const active = input.candidates.filter((_candidate) => !terminal);
		if (active.length === 1) {
			owner = {
				workspaceId: active[0].workspaceId,
				taskId: active[0].taskId,
				revision: (automation.repairOwner?.revision ?? 0) + 1,
			};
		}
	}

	const nextAutomation: RuntimePrCommentAutomation = { ...automation, repairOwner: owner };
	// A sent dispatch belongs to the owner it was sent to. When ownership
	// moves to another task, its turn can no longer be settled from the new
	// owner's session: fail it visibly (Resume) instead of waiting forever.
	const previousOwner = automation.repairOwner;
	const ownerChanged =
		previousOwner !== null &&
		(owner === null || owner.workspaceId !== previousOwner.workspaceId || owner.taskId !== previousOwner.taskId);
	const sentDispatch = automation.dispatch;
	if (
		ownerChanged &&
		sentDispatch !== null &&
		(sentDispatch.status === "running" ||
			sentDispatch.status === "waiting" ||
			(sentDispatch.status === "queued" && sentDispatch.attemptedAt !== null))
	) {
		if (sentDispatch.previousFeedbackFingerprint !== undefined)
			nextAutomation.lastDispatchedFeedbackFingerprint = sentDispatch.previousFeedbackFingerprint;
		nextAutomation.dispatch = {
			...sentDispatch,
			status: "failed",
			error: `The repair owner changed while comments were being addressed; resume manually.`,
		};
	}
	if (terminal || owner === null) {
		// Terminal PR observation or blocked owner: cancel the queued intent
		// and pending scheduling. The dispatched watermark and in-flight or
		// failed dispatch survive on purpose.
		nextAutomation.pendingFeedbackFingerprint = null;
		nextAutomation.pendingCount = null;
		nextAutomation.debounceDeadline = null;
		nextAutomation.firstPendingAt = null;
		if (
			nextAutomation.dispatch !== null &&
			nextAutomation.dispatch.status === "queued" &&
			nextAutomation.dispatch.attemptedAt === null
		) {
			nextAutomation.dispatch = null;
		}
	} else {
		const events = excludePublishedEvents(input.snapshot.events, automation.publication.published);
		const pending = findPrFeedbackPendingEvents(events, automation.lastDispatchedFeedbackFingerprint);
		const dispatch = automation.dispatch;
		const inFlight =
			dispatch !== null &&
			(dispatch.status === "queued" || dispatch.status === "waiting" || dispatch.status === "running");
		const failed = dispatch !== null && dispatch.status === "failed";
		if (pending.length === 0) {
			nextAutomation.pendingFeedbackFingerprint = null;
			nextAutomation.pendingCount = null;
			nextAutomation.debounceDeadline = null;
			nextAutomation.firstPendingAt = null;
			if (dispatch !== null && dispatch.status === "queued") {
				// Nothing left to dispatch: cancel the queued intent.
				nextAutomation.dispatch = dispatch.attemptedAt === null ? null : dispatch;
			}
		} else if (!inFlight && !failed) {
			const fingerprint = computePrFeedbackFingerprint(pending);
			if (fingerprint === null) {
				nextAutomation.pendingFeedbackFingerprint = null;
				nextAutomation.pendingCount = 0;
				nextAutomation.debounceDeadline = null;
				nextAutomation.firstPendingAt = null;
			} else {
				const firstPendingAt = automation.firstPendingAt ?? input.nowMs;
				nextAutomation.pendingFeedbackFingerprint = fingerprint;
				nextAutomation.pendingCount = pending.length;
				nextAutomation.firstPendingAt = firstPendingAt;
				// 120s after the last feedback change, capped at 600s from
				// first pending.
				nextAutomation.debounceDeadline = Math.min(
					fingerprint.watermark + DEBOUNCE_MS,
					firstPendingAt + MAX_PENDING_MS,
				);
				// Persist the queued intent up front so settle, restart
				// reconciliation, and cancellation have a durable target.
				if (dispatch === null || dispatch.status === "completed") {
					nextAutomation.dispatch = {
						dispatchId: randomUUID(),
						attemptedAt: null,
						fingerprint,
						ownerRevision: owner?.revision ?? 0,
						status: "queued",
						turnRef: null,
						error: null,
					};
				}
			}
		} else if (inFlight) {
			// A batch is queued/running: new feedback waits for the next batch;
			// the accepted instruction is never mutated.
			const fingerprint = computePrFeedbackFingerprint(pending);
			if (fingerprint !== null) {
				nextAutomation.pendingFeedbackFingerprint = fingerprint;
				nextAutomation.pendingCount = pending.length;
				nextAutomation.firstPendingAt = automation.firstPendingAt ?? input.nowMs;
				const baseDeadline = automation.debounceDeadline ?? automation.firstPendingAt ?? input.nowMs;
				nextAutomation.debounceDeadline = Math.min(
					Math.max(fingerprint.watermark + DEBOUNCE_MS, baseDeadline),
					nextAutomation.firstPendingAt + MAX_PENDING_MS,
				);
			}
		} else {
			// Failed dispatch: sticky until the explicit Resume. Track the
			// pending aggregate for visibility but never schedule a deadline.
			const fingerprint = computePrFeedbackFingerprint(pending);
			nextAutomation.pendingFeedbackFingerprint = fingerprint;
			nextAutomation.pendingCount = pending.length;
			nextAutomation.debounceDeadline = null;
			nextAutomation.firstPendingAt = null;
		}
	}

	const unchanged =
		JSON.stringify(nextAutomation) === JSON.stringify(automation) &&
		JSON.stringify(keptBindings) === JSON.stringify(record.taskBindings);
	if (unchanged) {
		return record;
	}
	return {
		...record,
		revision: record.revision + 1,
		taskBindings: keptBindings,
		commentAutomation: nextAutomation,
	};
}

export class PrCommentAutomationService {
	private readonly subscriptions = new Map<string, PrSubscriptionState>();
	/**
	 * In-memory capture-pause fallback: PR keys whose attribution update
	 * could not be persisted (store failure or an unresolvable GitHub access
	 * scope). Settle waits on these until a later publication capture for
	 * the same PR is persisted or the user resumes with acknowledgment.
	 * Being in memory, the pause does not survive a process restart.
	 */
	private readonly captureBlocked = new Set<string>();
	/** PR keys with a send in progress (between the `attemptedAt` write and the outcome write). */
	private readonly sendsInFlight = new Set<string>();
	private timer: NodeJS.Timeout | null = null;
	private started = false;
	private disposed = false;
	/** Fire-and-forget work that dispose() lets finish before the process exits. */
	private readonly inFlight = new Set<Promise<unknown>>();

	constructor(private readonly deps: PrCommentAutomationServiceDependencies) {}

	private nowMs(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	private warn(message: string): void {
		this.deps.warn ? this.deps.warn(message) : process.stderr.write(`[pr-comment-automation] ${message}\n`);
	}

	/** Reconciles durable state from a restart, then starts the poll tick. */
	async start(): Promise<void> {
		if (this.started || this.disposed) {
			return;
		}
		this.started = true;
		this.timer = setInterval(() => {
			void this.runTick().catch((error: unknown) => {
				this.warn(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, TICK_INTERVAL_MS);
		this.timer.unref?.();
		await this.track(this.reconcileOnStartup());
	}

	private async reconcileOnStartup(): Promise<void> {
		try {
			await this.reconcileRestartedDispatches();
			await this.reconcilePublicationCaptures();
			for (const scope of this.deps.listManagedWorkspaces()) {
				await this.refreshWorkspace(scope);
			}
		} catch (error) {
			this.warn(`startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Stops scheduling and waits (bounded) for work that is already running;
	 * work requested afterwards is dropped. Refreshes, ticks, and the startup
	 * reconcile are fire-and-forget and each reads workspace state, which takes
	 * the workspace-index lock. A process that exits while one holds it leaves
	 * the lockfile behind, and the next start then fails with "Lock file is
	 * already being held".
	 */
	async dispose(): Promise<void> {
		this.disposed = true;
		this.started = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		await this.waitForInFlight();
	}

	private track<T>(operation: Promise<T>): Promise<T> {
		this.inFlight.add(operation);
		const forget = () => {
			this.inFlight.delete(operation);
		};
		void operation.then(forget, forget);
		return operation;
	}

	private async waitForInFlight(): Promise<void> {
		if (this.inFlight.size === 0) {
			return;
		}
		let graceTimer: NodeJS.Timeout | undefined;
		const graceElapsed = new Promise<void>((resolve) => {
			graceTimer = setTimeout(resolve, DISPOSE_GRACE_MS);
		});
		try {
			await Promise.race([this.settleInFlight(), graceElapsed]);
		} finally {
			clearTimeout(graceTimer);
		}
	}

	private async settleInFlight(): Promise<void> {
		while (this.inFlight.size > 0) {
			await Promise.allSettled([...this.inFlight]);
		}
	}

	/**
	 * Rescans one workspace's board and updates PR subscriptions. Called on
	 * startup and after every board save. Disabling, unlinking, or moving a
	 * card to a terminal column cancels its queued intent. A no-op once the
	 * service is disposed.
	 */
	async refreshWorkspace(scope: PrCommentAutomationWorkspaceScope): Promise<void> {
		if (this.disposed) {
			return;
		}
		await this.track(this.syncWorkspaceSubscriptions(scope));
	}

	/**
	 * COMMENT-0 v1 support gate: the task's effective agent must be the
	 * native Cline agent. An unset per-card agentId inherits the
	 * workspace's selected agent (resolved like task start), not Cline.
	 */
	private async isClineAgentTask(scope: PrCommentAutomationWorkspaceScope, card: RuntimeBoardCard): Promise<boolean> {
		let effectiveAgentId: RuntimeAgentId | null = null;
		if (this.deps.getEffectiveTaskAgentId) {
			try {
				effectiveAgentId = await this.deps.getEffectiveTaskAgentId(scope, card.id);
			} catch {
				effectiveAgentId = null;
			}
		}
		if (effectiveAgentId === null && card.agentId === "cline") {
			// Resolver unavailable: only an explicit per-card Cline counts.
			effectiveAgentId = "cline";
		}
		return effectiveAgentId === "cline";
	}

	/**
	 * Live session summary for a task: persisted state reconciled against
	 * the terminal manager and the in-memory Cline summaries (the same
	 * resolution buildWorkspaceStateSnapshot uses). The raw persisted
	 * sessions file is only written on browser saves/shutdown and must
	 * never settle dispatch turns on its own.
	 */
	private async resolveLiveSessionSummary(
		candidate: PrCommentCandidate,
		taskId: string,
	): Promise<RuntimeTaskSessionSummary | null> {
		const state = await this.deps.loadWorkspaceState(candidate.workspacePath).catch(() => null);
		if (!state) {
			return null;
		}
		let terminal: TerminalSessionManager | null = null;
		let cline: ClineTaskSessionService | null = null;
		try {
			terminal = await this.deps.getTerminalManager(candidate);
			cline = await this.deps.getClineTaskSessionService(candidate);
		} catch {
			terminal = null;
			cline = null;
		}
		if (!terminal || !cline) {
			return state.sessions[taskId] ?? null;
		}
		return resolveWorkspaceSessionSummaries(state.sessions, terminal, cline.listSummaries())[taskId] ?? null;
	}

	private async syncWorkspaceSubscriptions(scope: PrCommentAutomationWorkspaceScope): Promise<void> {
		let state: RuntimeWorkspaceStateResponse;
		try {
			state = await this.deps.loadWorkspaceState(scope.workspacePath);
		} catch {
			return;
		}
		const emptiedSubscriptions: PrSubscriptionState[] = [];
		const activeCandidateIds = new Map<string, PrCommentCandidate>();
		for (const column of state.board.columns) {
			if (!ACTIVE_COLUMN_IDS.has(column.id)) {
				continue;
			}
			for (const card of column.cards) {
				if (card.autoAddressComments !== true) {
					continue;
				}
				// Same eligibility as the detail surface and Resume: exactly
				// one linked github.com PR and the native Cline agent.
				const prs = (card.pullRequests ?? []).filter(
					(pullRequest) => pullRequest.provider === "github" && pullRequest.host === "github.com",
				);
				const pullRequest = prs.length === 1 ? (prs[0] ?? null) : null;
				if (pullRequest === null || !(await this.isClineAgentTask(scope, card))) {
					continue;
				}
				const key = getPullRequestIdentityKey(pullRequest);
				const candidateId = `${scope.workspaceId}/${card.id}`;
				const candidate: PrCommentCandidate = {
					workspaceId: scope.workspaceId,
					workspacePath: scope.workspacePath,
					taskId: card.id,
				};
				activeCandidateIds.set(`${key}/${candidateId}`, candidate);
				const existing = this.subscriptions.get(key);
				const sub =
					existing ??
					({
						key,
						pr: pullRequest,
						candidates: new Map<string, PrCommentCandidate>(),
						nextPollAt: 0,
						dispatchRetryAt: null,
						consecutiveFailures: 0,
						pollInFlight: false,
						settleInFlight: false,
					} satisfies PrSubscriptionState);
				if (!existing) {
					this.subscriptions.set(key, sub);
				}
				if (!sub.candidates.has(candidateId)) {
					// New candidate: poll immediately.
					sub.nextPollAt = 0;
				}
				sub.candidates.set(candidateId, candidate);
			}
		}
		for (const [key, sub] of [...this.subscriptions]) {
			for (const [candidateId, candidate] of [...sub.candidates]) {
				if (candidate.workspaceId !== scope.workspaceId) {
					continue;
				}
				if (!activeCandidateIds.has(`${key}/${candidateId}`)) {
					sub.candidates.delete(candidateId);
				}
			}
			if (sub.candidates.size === 0) {
				this.subscriptions.delete(key);
				emptiedSubscriptions.push(sub);
			}
		}
		// Only a PR with no remaining candidate loses its scheduling; while
		// any candidate remains, the next applyPrPollOutcome re-derives the
		// bindings and owner.
		for (const sub of emptiedSubscriptions) {
			try {
				await this.cancelPendingRecord(sub);
			} catch (error) {
				this.warn(`cancel pending failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	/**
	 * One poll/settle cycle. Polls are awaited before settles so the settle
	 * always sees the freshest record; the per-subscription in-flight flags
	 * keep overlapping ticks from double-polling or double-sending. A no-op
	 * once the service is disposed.
	 */
	async runTick(): Promise<void> {
		if (this.disposed) {
			return;
		}
		await this.track(this.pollAndSettle());
	}

	private async pollAndSettle(): Promise<void> {
		const nowMs = this.nowMs();
		const polls: Promise<void>[] = [];
		for (const sub of [...this.subscriptions.values()]) {
			if (sub.pollInFlight || nowMs < sub.nextPollAt) {
				continue;
			}
			sub.pollInFlight = true;
			polls.push(
				this.pollSubscription(sub)
					.catch((error: unknown) => {
						this.warn(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
					})
					.finally(() => {
						sub.pollInFlight = false;
					}),
			);
		}
		await Promise.all(polls);
		if (this.disposed) {
			// Shutting down: leave durable state untouched; settle resumes on the next start.
			return;
		}
		const settles: Promise<void>[] = [];
		for (const sub of [...this.subscriptions.values()]) {
			if (sub.settleInFlight) {
				continue;
			}
			sub.settleInFlight = true;
			settles.push(
				this.settleDispatch(sub)
					.catch((error: unknown) => {
						this.warn(`settle failed: ${error instanceof Error ? error.message : String(error)}`);
					})
					.finally(() => {
						sub.settleInFlight = false;
					}),
			);
		}
		await Promise.all(settles);
	}

	private async pollSubscription(sub: PrSubscriptionState): Promise<void> {
		const nowMs = this.nowMs();
		if (sub.candidates.size === 0) {
			this.subscriptions.delete(sub.key);
			return;
		}
		let accessScopeId: string;
		try {
			accessScopeId = await this.deps.getGitHubAccessScopeId();
		} catch (_error) {
			// Visible auth blocker: back off, never hot-loop or auto-login.
			sub.consecutiveFailures += 1;
			sub.nextPollAt = nowMs + backoffMs(sub.consecutiveFailures);
			return;
		}
		const scope = this.firstCandidateScope(sub);
		const backOff = (): void => {
			sub.consecutiveFailures += 1;
			sub.nextPollAt = nowMs + backoffMs(sub.consecutiveFailures);
		};
		try {
			const snapshot = await this.deps.ghClient.fetchSnapshot(
				{ host: sub.pr.host, repository: sub.pr.repository, number: sub.pr.number },
				scope.workspacePath,
				accessScopeId,
			);
			if (!snapshot.complete) {
				// Partial failures cannot dispatch: back off and retry later.
				backOff();
				return;
			}
			const candidates = [...sub.candidates.values()];
			await upsertPrTrackingRecord(sub.key, { accessScopeId, pr: sub.pr }, (record) =>
				applyPrPollOutcome(record, { candidates, snapshot, nowMs }),
			);
		} catch (error) {
			// A throwing fetch or record write (malformed record, disk error)
			// must back off too; otherwise every tick re-polls GitHub.
			backOff();
			throw error;
		}
		sub.consecutiveFailures = 0;
		sub.nextPollAt = nowMs + POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS);
	}

	private firstCandidateScope(sub: PrSubscriptionState): PrCommentAutomationWorkspaceScope {
		const candidate = sub.candidates.values().next().value;
		if (candidate === undefined) {
			throw new Error("No candidate scopes available for subscription.");
		}
		return { workspaceId: candidate.workspaceId, workspacePath: candidate.workspacePath };
	}

	/**
	 * Settles dispatch lifecycle for one subscription: completes/fails
	 * running turns from session state, and attempts due queued dispatches
	 * after a fresh successful re-read.
	 */
	private async settleDispatch(sub: PrSubscriptionState): Promise<void> {
		const nowMs = this.nowMs();
		const loaded = await loadPrTrackingRecord(sub.key);
		if (loaded.status === "missing") {
			return;
		}
		if (loaded.status === "malformed") {
			this.warn(`record for ${sub.key} is malformed; skipping settle`);
			return;
		}
		const record = loaded.record;
		const automation = record.commentAutomation;
		// A start-phase capture whose tool result never arrived becomes an
		// explicit uncertainty: the visible blocker/Resume flow surfaces
		// instead of a silent settle block that only a restart would resolve.
		await this.markStalePendingCaptures(sub.key, record);
		const dispatch = automation.dispatch;
		const owner = automation.repairOwner;

		if (dispatch?.status === "waiting") {
			const candidate = owner ? sub.candidates.get(`${owner.workspaceId}/${owner.taskId}`) : undefined;
			const session = candidate ? await this.resolveLiveSessionSummary(candidate, candidate.taskId) : null;
			if (!candidate || (session && session.state !== "running")) {
				await this.setDispatchFailed(sub, "The queued PR repair was canceled before execution; Resume to retry.");
			}
			return;
		}
		if (dispatch !== null && dispatch.status === "running") {
			if (!owner) {
				await this.setDispatchFailed(sub, `The repair owner is unavailable; resume manually.`);
				return;
			}
			const candidate = sub.candidates.get(`${owner.workspaceId}/${owner.taskId}`);
			if (!candidate) {
				await this.setDispatchFailed(sub, `The repair owner task is no longer enabled; resume manually.`);
				return;
			}
			const session = await this.resolveLiveSessionSummary(candidate, owner.taskId);
			if (session?.state === "running") {
				return;
			}
			// Only settle turns that produced output after the dispatch was
			// accepted: a stale persisted state from before the dispatch must
			// never complete or fail it. No evidence yet: keep waiting.
			if (
				session === null ||
				dispatch.attemptedAt === null ||
				session.lastOutputAt === null ||
				session.lastOutputAt < dispatch.attemptedAt
			) {
				sub.dispatchRetryAt = nowMs + DISPATCH_RETRY_MS;
				return;
			}
			if (session.state === "failed" || session.state === "interrupted" || session.reviewReason === "error") {
				await this.setDispatchFailed(sub, `The comment-handling turn ended without completion.`);
				return;
			}
			if (session.state === "idle" || session.state === "awaiting_review") {
				await this.setDispatchCompleted(sub);
				return;
			}
			// Unknown turn state: do not guess; require an explicit resume.
			await this.setDispatchFailed(sub, `The turn state could not be determined; resume manually.`);
			return;
		}

		// A queued dispatch whose send was already attempted (the post-send
		// write failed, or a restart left it behind) has an unknown outcome:
		// never send it again automatically; surface it for an explicit Resume.
		if (
			dispatch !== null &&
			dispatch.status === "queued" &&
			dispatch.attemptedAt !== null &&
			!this.sendsInFlight.has(sub.key)
		) {
			await this.setDispatchFailed(sub, `A previous send attempt's outcome is unknown; resume manually.`);
			return;
		}
		// A failed dispatch is sticky: only an explicit Resume can retry it.
		// dispatch === null or completed stays dispatchable so records that
		// predate queued-intent creation (or lost it) still settle when due.
		if (dispatch !== null && dispatch.status !== "queued" && dispatch.status !== "completed") {
			return;
		}
		// Safety cap tripped: only an explicit Resume continues (it resets
		// the attempt history). Never auto-resumes when the window expires.
		if (automation.autoSendPaused) {
			return;
		}
		// Wait while a publication capture is unresolved: a dispatch racing
		// an in-flight implementation reply could send work the reply is
		// already addressing or that was never recorded.
		if (automation.publication.pending.length > 0 || this.captureBlocked.has(sub.key)) {
			sub.dispatchRetryAt = nowMs + DISPATCH_RETRY_MS;
			return;
		}
		if (sub.dispatchRetryAt !== null && nowMs < sub.dispatchRetryAt) {
			return;
		}
		// No scheduled deadline means the last successful poll saw no pending
		// feedback: settle must not burn gh API calls to re-derive that.
		if (automation.debounceDeadline === null || nowMs < automation.debounceDeadline) {
			return;
		}
		if (!owner) {
			await this.cancelPendingRecord(sub);
			return;
		}
		const candidate = sub.candidates.get(`${owner.workspaceId}/${owner.taskId}`);
		if (!candidate) {
			await this.cancelPendingRecord(sub);
			return;
		}
		let accessScopeId: string;
		try {
			accessScopeId = await this.deps.getGitHubAccessScopeId();
		} catch {
			sub.dispatchRetryAt = nowMs + DISPATCH_RETRY_MS;
			return;
		}
		// At the due time: a successful fresh read re-validates the owner,
		// link, settings, PR open state, and eligible feedback before sending.
		const snapshot = await this.deps.ghClient.fetchSnapshot(
			{ host: sub.pr.host, repository: sub.pr.repository, number: sub.pr.number },
			candidate.workspacePath,
			accessScopeId,
		);
		if (!snapshot.complete) {
			sub.dispatchRetryAt = nowMs + DISPATCH_RETRY_MS;
			return;
		}
		if (snapshot.prState !== "open") {
			// Terminal observation cancels the queued intent (keeps the
			// dispatched watermark).
			await this.cancelPendingRecord(sub);
			return;
		}
		const pending = findPrFeedbackPendingEvents(
			excludePublishedEvents(snapshot.events, automation.publication.published),
			automation.lastDispatchedFeedbackFingerprint,
		);
		if (pending.length === 0) {
			await this.cancelPendingRecord(sub);
			return;
		}
		// The persisted deadline came from the last poll. Feedback that
		// arrived since then restarts the quiet window (still capped from
		// first pending), so a reviewer who is still commenting is never
		// interrupted mid-batch.
		const freshFingerprint = computePrFeedbackFingerprint(pending);
		if (freshFingerprint !== null) {
			const freshDeadline = Math.min(
				Math.max(freshFingerprint.watermark + DEBOUNCE_MS, automation.debounceDeadline),
				(automation.firstPendingAt ?? nowMs) + MAX_PENDING_MS,
			);
			if (nowMs < freshDeadline) {
				const candidates = [...sub.candidates.values()];
				await upsertPrTrackingRecord(sub.key, { accessScopeId, pr: sub.pr }, (current) =>
					applyPrPollOutcome(current, { candidates, snapshot, nowMs }),
				);
				return;
			}
		}
		// Wait while a conflicting writer, review, or manual operation is
		// active: never inject feedback mid-turn.
		try {
			const clineTaskSessionService = await this.deps.getClineTaskSessionService(candidate);
			const terminalManager = await this.deps.getTerminalManager(candidate);
			if (isTaskWriterActive(owner.taskId, { clineTaskSessionService, terminalManager })) {
				sub.dispatchRetryAt = nowMs + DISPATCH_RETRY_MS;
				return;
			}
		} catch (error) {
			this.warn(`writer check failed: ${error instanceof Error ? error.message : String(error)}`);
			sub.dispatchRetryAt = nowMs + DISPATCH_RETRY_MS;
			return;
		}
		await this.executeDispatch(sub, owner, candidate, accessScopeId, snapshot, nowMs);
	}

	/**
	 * The send path: persist the queued intent first, then `attemptedAt`,
	 * then send through the normal chat send, then record the outcome.
	 * Restart between any two steps leaves a durable, unambiguous state.
	 */
	private async executeDispatch(
		sub: PrSubscriptionState,
		owner: RuntimePrCommentOwner,
		scope: PrCommentAutomationWorkspaceScope,
		accessScopeId: string,
		snapshot: GitHubPrSnapshot,
		capturedAt: number,
	): Promise<DispatchOutcome> {
		// One send per PR at a time: a concurrent settle or Resume (two tabs)
		// must never deliver the instruction twice.
		if (this.sendsInFlight.has(sub.key)) {
			return { status: "held", reason: `A comment-handling send is already in progress for this pull request.` };
		}
		this.sendsInFlight.add(sub.key);
		try {
			return await this.sendDispatch(sub, owner, scope, accessScopeId, snapshot, capturedAt);
		} finally {
			this.sendsInFlight.delete(sub.key);
		}
	}

	private async sendDispatch(
		sub: PrSubscriptionState,
		owner: RuntimePrCommentOwner,
		scope: PrCommentAutomationWorkspaceScope,
		accessScopeId: string,
		snapshot: GitHubPrSnapshot,
		capturedAt: number,
	): Promise<DispatchOutcome> {
		const identity = { accessScopeId, pr: sub.pr };
		const nowMs = this.nowMs();
		// Final fresh attribution check before sending: a capture that lands
		// after the settle's initial read must still hold the send, and the
		// safety cap is enforced against the durable attempt history.
		const preCheck = await loadPrTrackingRecord(sub.key);
		if (preCheck.status !== "ok") {
			return { status: "held", reason: `The PR tracking record is unavailable.` };
		}
		const preAutomation = preCheck.record.commentAutomation;
		if (preAutomation.publication.pending.length > 0 || this.captureBlocked.has(sub.key)) {
			sub.dispatchRetryAt = nowMs + DISPATCH_RETRY_MS;
			return {
				status: "held",
				reason: `An implementation comment is still being captured; comment handling continues once it resolves.`,
			};
		}
		if (preAutomation.autoSendPaused) {
			return { status: "held", reason: RATE_LIMIT_PAUSED_REASON };
		}
		const currentDispatch = preAutomation.dispatch;
		if (
			currentDispatch !== null &&
			(currentDispatch.status === "running" ||
				currentDispatch.status === "waiting" ||
				(currentDispatch.status === "queued" && currentDispatch.attemptedAt !== null))
		) {
			// Another send (e.g. a second Resume) already went out.
			return { status: "held", reason: `The comment-handling instruction was already sent.` };
		}
		const windowStart = nowMs - AUTO_SEND_WINDOW_MS;
		const attemptsInWindow = preAutomation.autoSendAttempts.filter((attempt) => attempt.attemptedAt >= windowStart);
		if (attemptsInWindow.length >= MAX_AUTO_SEND_PER_WINDOW) {
			// Bounded backstop tripped: pause with a durable, visible state
			// that requires an explicit Resume (never auto-resumes).
			await upsertPrTrackingRecord(sub.key, identity, (record) => ({
				...record,
				revision: record.revision + 1,
				commentAutomation: {
					...record.commentAutomation,
					autoSendAttempts: pruneAutoSendAttempts(record.commentAutomation.autoSendAttempts, nowMs),
					autoSendPaused: true,
				},
			}));
			return { status: "held", reason: RATE_LIMIT_PAUSED_REASON };
		}
		const dispatchId = randomUUID();
		const captured = computePrFeedbackFingerprint(
			excludePublishedEvents(snapshot.events, preAutomation.publication.published),
		);
		if (captured === null) {
			await this.cancelPendingRecord(sub);
			return { status: "nothing-pending" };
		}
		await upsertPrTrackingRecord(sub.key, identity, (record) => ({
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				dispatch: {
					dispatchId,
					attemptedAt: null,
					fingerprint: captured,
					previousFeedbackFingerprint: preAutomation.lastDispatchedFeedbackFingerprint,
					ownerRevision: record.commentAutomation.repairOwner?.revision ?? 0,
					status: "queued",
					turnRef: null,
					error: null,
				},
			},
		}));
		// Persist the attempted-at timestamp immediately before invoking the
		// send so a crash in flight is never ambiguous. The attempt joins the
		// durable safety-cap history (unique per dispatchId) in the same write.
		const attempted = await upsertPrTrackingRecord(sub.key, identity, (record) => {
			const dispatch = record.commentAutomation.dispatch;
			if (dispatch === null || dispatch.dispatchId !== dispatchId) {
				return record;
			}
			return {
				...record,
				revision: record.revision + 1,
				commentAutomation: {
					...record.commentAutomation,
					autoSendAttempts: [
						...pruneAutoSendAttempts(record.commentAutomation.autoSendAttempts, nowMs),
						{ dispatchId, attemptedAt: nowMs },
					],
					dispatch: { ...dispatch, attemptedAt: nowMs, status: "waiting" },
				},
			};
		});
		// The intent can be cancelled between the two writes (toggle off,
		// feedback resolved, PR closed): never send without a durable attempt.
		if (attempted.commentAutomation.dispatch?.dispatchId !== dispatchId) {
			return { status: "nothing-pending" };
		}
		const prepare: ClineTurnPreparation = (context) =>
			this.prepareDispatch({
				sub,
				owner,
				scope,
				accessScopeId,
				snapshot,
				capturedAt,
				dispatchId,
				baseline: preAutomation.lastDispatchedFeedbackFingerprint,
				...context,
			});
		const response = await this.deps.sendTaskChatMessage(
			scope,
			{
				taskId: owner.taskId,
				text: `Queued automatic PR repair for ${sub.pr.url}. Feedback will be captured when execution begins.`,
				mode: "act",
			},
			prepare,
		);
		if (response.ok) {
			await upsertPrTrackingRecord(sub.key, identity, (record) => {
				const dispatch = record.commentAutomation.dispatch;
				if (dispatch?.dispatchId !== dispatchId) return record;
				return {
					...record,
					revision: record.revision + 1,
					commentAutomation: {
						...record.commentAutomation,
						dispatch: { ...dispatch, turnRef: response.message?.id ?? null },
					},
				};
			});
			return { status: "sent" };
		}
		const error = response.error ?? `Could not send the comment-handling instruction.`;
		await upsertPrTrackingRecord(sub.key, identity, (record) => {
			const dispatch = record.commentAutomation.dispatch;
			if (dispatch === null || dispatch.dispatchId !== dispatchId) {
				return record;
			}
			return {
				...record,
				revision: record.revision + 1,
				commentAutomation: {
					...record.commentAutomation,
					dispatch: { ...dispatch, status: "failed", error },
				},
			};
		});
		return { status: "held", reason: error };
	}

	/** Executes inside model admission, after both the task queue and capacity queue. */
	private async prepareDispatch(input: {
		sub: PrSubscriptionState;
		owner: RuntimePrCommentOwner;
		scope: PrCommentAutomationWorkspaceScope;
		accessScopeId: string;
		snapshot: GitHubPrSnapshot;
		capturedAt: number;
		dispatchId: string;
		baseline: RuntimePrFeedbackFingerprint | null;
		cwd: string;
		signal: AbortSignal;
	}): Promise<string | null> {
		const { sub, scope, owner, dispatchId, signal } = input;
		const identity = { accessScopeId: input.accessScopeId, pr: sub.pr };
		let errorCode: "preparation_failed" | "git_refresh_blocked" = "preparation_failed";
		const update = async (mutate: (automation: RuntimePrCommentAutomation) => RuntimePrCommentAutomation) => {
			await upsertPrTrackingRecord(sub.key, identity, (record) => {
				if (record.commentAutomation.dispatch?.dispatchId !== dispatchId) return record;
				return { ...record, revision: record.revision + 1, commentAutomation: mutate(record.commentAutomation) };
			});
		};
		const skip = async () => {
			await update((automation) => ({
				...automation,
				pendingFeedbackFingerprint: null,
				pendingCount: null,
				debounceDeadline: null,
				firstPendingAt: null,
				dispatch: automation.dispatch ? { ...automation.dispatch, status: "completed", error: null } : null,
			}));
			return null;
		};
		try {
			signal.throwIfAborted();
			if (this.disposed) throw new Error("Comment handling stopped before execution; Resume after restart.");
			const state = await this.deps.loadWorkspaceState(scope.workspacePath);
			const card = state.board.columns
				.filter((column) => ACTIVE_COLUMN_IDS.has(column.id))
				.flatMap((column) => column.cards)
				.find((card) => card.id === owner.taskId);
			const prs = (card?.pullRequests ?? []).filter((pr) => pr.host === "github.com" && pr.provider === "github");
			if (
				!card?.autoAddressComments ||
				prs.length !== 1 ||
				getPullRequestIdentityKey(prs[0]) !== sub.key ||
				!(await this.isClineAgentTask(scope, card))
			)
				return skip();
			const loaded = await loadPrTrackingRecord(sub.key);
			if (loaded.status !== "ok") throw new Error("The PR tracking record is unavailable.");
			const automation = loaded.record.commentAutomation;
			if (
				automation.dispatch?.dispatchId !== dispatchId ||
				automation.repairOwner?.revision !== owner.revision ||
				automation.repairOwner.taskId !== owner.taskId ||
				automation.repairOwner.workspaceId !== owner.workspaceId
			)
				return null;
			if (automation.publication.pending.length || this.captureBlocked.has(sub.key))
				throw new Error("Publication capture is unresolved; Resume after it is reconciled.");
			if ((await this.deps.getGitHubAccessScopeId()) !== input.accessScopeId)
				throw new Error("GitHub authentication changed while queued; Resume to revalidate.");
			const reuseSnapshot = this.nowMs() - input.capturedAt < 30_000;
			const snapshot = reuseSnapshot
				? input.snapshot
				: await this.deps.ghClient.fetchSnapshot(
						{ host: sub.pr.host, repository: sub.pr.repository, number: sub.pr.number },
						scope.workspacePath,
						input.accessScopeId,
					);
			const capturedAt = reuseSnapshot ? input.capturedAt : this.nowMs();
			if (!snapshot.complete)
				throw new Error(
					snapshot.authError ?? "Cannot refresh complete PR feedback; Resume when GitHub is reachable.",
				);
			if (snapshot.prState !== "open") return skip();
			const events = excludePublishedEvents(snapshot.events, automation.publication.published);
			const pending = findPrFeedbackPendingEvents(events, input.baseline);
			if (pending.length === 0) return skip();
			// Build before touching Git so oversized feedback never mutates the worktree.
			const prompt = buildCommentHandlingInstruction(sub.pr.url, {
				events: pending,
				capturedAt,
				headSha: snapshot.headSha ?? "unknown",
			});
			errorCode = "git_refresh_blocked";
			await (this.deps.refreshGit ?? refreshCommentWorktree)(input.cwd, snapshot, signal);
			errorCode = "preparation_failed";
			signal.throwIfAborted();
			const finalState = await this.deps.loadWorkspaceState(scope.workspacePath);
			const finalCard = finalState.board.columns
				.filter((column) => ACTIVE_COLUMN_IDS.has(column.id))
				.flatMap((column) => column.cards)
				.find((card) => card.id === owner.taskId);
			const finalPrs = (finalCard?.pullRequests ?? []).filter(
				(pr) => pr.host === "github.com" && pr.provider === "github",
			);
			if (
				!finalCard?.autoAddressComments ||
				finalPrs.length !== 1 ||
				getPullRequestIdentityKey(finalPrs[0]) !== sub.key
			)
				return skip();
			let authorized = false;
			await update((current) => {
				if (
					current.repairOwner?.revision !== owner.revision ||
					current.repairOwner.taskId !== owner.taskId ||
					current.repairOwner.workspaceId !== owner.workspaceId
				)
					return current;
				if (current.dispatch?.status !== "waiting" && current.dispatch?.status !== "running") return current;
				if (current.publication.pending.length || this.captureBlocked.has(sub.key))
					throw new Error("Publication capture changed during preparation.");
				authorized = true;
				return {
					...current,
					pendingFeedbackFingerprint: null,
					pendingCount: null,
					debounceDeadline: null,
					firstPendingAt: null,
					lastDispatchedFeedbackFingerprint: computePrFeedbackFingerprint(events),
					dispatch: current.dispatch
						? {
								...current.dispatch,
								status: "running",
								fingerprint: computePrFeedbackFingerprint(events) ?? current.dispatch.fingerprint,
								error: null,
							}
						: null,
				};
			});
			return authorized ? prompt : null;
		} catch (error) {
			const message = `${errorCode === "git_refresh_blocked" ? "Git refresh blocked" : "PR repair preparation failed"}: ${error instanceof Error ? error.message : String(error)}`;
			await update((automation) => ({
				...automation,
				lastDispatchedFeedbackFingerprint: input.baseline,
				dispatch: automation.dispatch
					? { ...automation.dispatch, status: "failed", errorCode, error: message }
					: null,
			}));
			throw new Error(message);
		}
	}

	private async setDispatchCompleted(sub: PrSubscriptionState): Promise<void> {
		const loaded = await loadPrTrackingRecord(sub.key);
		if (loaded.status !== "ok") {
			return;
		}
		const record = loaded.record;
		const dispatch = record.commentAutomation.dispatch;
		if (dispatch === null || dispatch.status !== "running") {
			return;
		}
		await upsertPrTrackingRecord(sub.key, { accessScopeId: record.accessScopeId, pr: record.pr }, (current) => {
			const currentDispatch = current.commentAutomation.dispatch;
			if (
				currentDispatch === null ||
				currentDispatch.dispatchId !== dispatch.dispatchId ||
				currentDispatch.status !== "running"
			) {
				return current;
			}
			return {
				...current,
				revision: current.revision + 1,
				commentAutomation: {
					...current.commentAutomation,
					dispatch: { ...currentDispatch, status: "completed" },
				},
			};
		});
	}

	private async setDispatchFailed(sub: PrSubscriptionState, error: string): Promise<void> {
		const loaded = await loadPrTrackingRecord(sub.key);
		if (loaded.status !== "ok") {
			return;
		}
		const record = loaded.record;
		const dispatch = record.commentAutomation.dispatch;
		if (
			dispatch === null ||
			(dispatch.status !== "running" && dispatch.status !== "waiting" && dispatch.status !== "queued")
		) {
			return;
		}
		await upsertPrTrackingRecord(sub.key, { accessScopeId: record.accessScopeId, pr: record.pr }, (current) => {
			const currentDispatch = current.commentAutomation.dispatch;
			if (currentDispatch === null || currentDispatch.dispatchId !== dispatch.dispatchId) {
				return current;
			}
			return {
				...current,
				revision: current.revision + 1,
				commentAutomation: {
					...current.commentAutomation,
					// A failed dispatch also releases the queued scheduling.
					pendingFeedbackFingerprint: null,
					pendingCount: null,
					debounceDeadline: null,
					firstPendingAt: null,
					lastDispatchedFeedbackFingerprint:
						currentDispatch.previousFeedbackFingerprint !== undefined
							? currentDispatch.previousFeedbackFingerprint
							: current.commentAutomation.lastDispatchedFeedbackFingerprint,
					dispatch: { ...currentDispatch, status: "failed", error },
				},
			};
		});
	}

	/** Cancels the pending scheduling and the provably-unsent queued intent. */
	private async cancelPendingRecord(sub: PrSubscriptionState): Promise<void> {
		const loaded = await loadPrTrackingRecord(sub.key);
		if (loaded.status !== "ok") {
			return;
		}
		const record = loaded.record;
		const automation = record.commentAutomation;
		const shouldCancel =
			automation.pendingFeedbackFingerprint !== null ||
			automation.pendingCount !== null ||
			automation.debounceDeadline !== null ||
			automation.firstPendingAt !== null ||
			(automation.dispatch !== null &&
				automation.dispatch.status === "queued" &&
				automation.dispatch.attemptedAt === null);
		if (!shouldCancel) {
			return;
		}
		await upsertPrTrackingRecord(sub.key, { accessScopeId: record.accessScopeId, pr: record.pr }, (current) => {
			const currentAutomation = current.commentAutomation;
			return {
				...current,
				revision: current.revision + 1,
				commentAutomation: {
					...currentAutomation,
					pendingFeedbackFingerprint: null,
					pendingCount: null,
					debounceDeadline: null,
					firstPendingAt: null,
					...(currentAutomation.dispatch !== null &&
					currentAutomation.dispatch.status === "queued" &&
					currentAutomation.dispatch.attemptedAt === null
						? { dispatch: null }
						: {}),
				},
			};
		});
	}

	/**
	 * Capture entry point from implementation-session tool events. Only task
	 * session services wire this observer (review sessions never do), so
	 * reviewer output is never attributed as implementation output. The
	 * observer never denies, rewrites, or fails the terminal command; it
	 * only establishes pending state before execution and persists exact
	 * identities after.
	 */
	async recordPrPublicationToolEvent(input: {
		workspaceId: string;
		workspacePath: string;
		taskId: string;
		phase: "started" | "finished";
		toolCallId: string | null;
		toolName: string | null;
		commands: string[];
		output: string | null;
		error: string | null;
	}): Promise<void> {
		const state = await this.deps.loadWorkspaceState(input.workspacePath).catch(() => null);
		if (!state) {
			return;
		}
		const card = state.board.columns
			.flatMap((column) => column.cards)
			.find((candidate) => candidate.id === input.taskId);
		if (!card) {
			return;
		}
		// Captured regardless of the "auto address comments" setting, so
		// later enabling it cannot process already-recorded implementation
		// replies.
		const linked = (card.pullRequests ?? []).filter(
			(pullRequest) => pullRequest.provider === "github" && pullRequest.host === "github.com",
		);
		if (linked.length === 0) {
			return;
		}
		const targets = linked.map((pullRequest) => ({
			host: pullRequest.host,
			repository: pullRequest.repository,
			number: pullRequest.number,
		}));
		const observation = analyzePrPublication({
			toolName: input.toolName,
			commands: input.commands,
			phase: input.phase,
			output: input.phase === "started" ? null : input.output,
			error: input.error,
			linkedPullRequests: targets,
		});
		if (observation.status === "none") {
			// Includes an explicit selector that targets a PR not linked to
			// this task: the write demonstrably does not touch our PRs.
			return;
		}
		if (observation.target === null) {
			// Ambiguous: the write may touch any of this task's linked PRs
			// but the exact target cannot be established. Every linked PR
			// gets an uncertain capture so automation pauses visibly (a
			// silent drop would let the reply retrigger handling).
			await this.markAmbiguousCapture(input, linked, observation);
			return;
		}
		const pullRequest = linked.find(
			(candidate) =>
				candidate.host === observation.target?.host &&
				candidate.repository === observation.target?.repository &&
				candidate.number === observation.target?.number,
		);
		if (!pullRequest) {
			return;
		}
		const key = getPullRequestIdentityKey(pullRequest);
		let accessScopeId: string;
		try {
			accessScopeId = await this.deps.getGitHubAccessScopeId();
		} catch {
			// No resolvable scope: nothing could have been published through
			// gh, but do not let dispatch race an unresolvable capture.
			this.captureBlocked.add(key);
			this.warn(`cannot resolve GitHub access scope for publication capture`);
			return;
		}
		const identity = { accessScopeId, pr: pullRequest };
		const captureId = input.toolCallId ?? randomUUID();
		try {
			if (input.phase === "started" && observation.status === "pending") {
				await this.upsertCapturePending(key, identity, {
					captureId,
					taskId: input.taskId,
					workspaceId: input.workspaceId,
					operation: observation.operation ?? "pr publication",
					kind: observation.kind ?? "conversation",
					target: observation.target,
					uncertain: false,
					uncertainReason: null,
				});
			} else if (observation.status === "failed") {
				// The write clearly failed: nothing was published; drop any
				// start-phase pending entry.
				await this.upsertCapturePending(key, identity, null, captureId);
			} else if (observation.status === "published") {
				await this.applyPublishedIdentities(key, identity, observation.identities, captureId);
			} else {
				// uncertain: visible pause until reconciled or explicitly resumed.
				await this.upsertCapturePending(key, identity, {
					captureId,
					taskId: input.taskId,
					workspaceId: input.workspaceId,
					operation: observation.operation ?? "pr publication",
					kind: observation.kind ?? "conversation",
					target: observation.target,
					uncertain: true,
					uncertainReason: observation.reason ?? "The publication identity could not be confirmed.",
				});
			}
		} catch (error) {
			// Storage failure: pause in memory; settle must not race a
			// capture that could not be recorded.
			this.captureBlocked.add(key);
			this.warn(`publication capture persistence failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		this.captureBlocked.delete(key);
	}

	/**
	 * Marks every linked PR with an uncertain capture: a recognized write
	 * happened but none of this task's linked PRs could be attributed with
	 * confidence. Automation pauses visibly until the ambiguity is resolved
	 * or explicitly resumed.
	 */
	private async markAmbiguousCapture(
		input: { workspaceId: string; taskId: string; toolCallId: string | null },
		linked: RuntimeTaskPullRequest[],
		observation: PrPublicationObservation,
	): Promise<void> {
		let accessScopeId: string;
		try {
			accessScopeId = await this.deps.getGitHubAccessScopeId();
		} catch {
			for (const pullRequest of linked) {
				this.captureBlocked.add(getPullRequestIdentityKey(pullRequest));
			}
			this.warn(`cannot resolve GitHub access scope for publication capture`);
			return;
		}
		const captureId = input.toolCallId ?? randomUUID();
		for (const pullRequest of linked) {
			const key = getPullRequestIdentityKey(pullRequest);
			try {
				await this.upsertCapturePending(
					key,
					{ accessScopeId, pr: pullRequest },
					{
						captureId,
						taskId: input.taskId,
						workspaceId: input.workspaceId,
						operation: observation.operation ?? "pr publication",
						kind: observation.kind ?? "conversation",
						target: null,
						uncertain: true,
						uncertainReason:
							observation.reason ??
							"Could not identify which linked pull request the implementation comment posted to.",
					},
				);
			} catch (error) {
				this.captureBlocked.add(key);
				this.warn(
					`publication capture persistence failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	/**
	 * True for a start-phase (non-uncertain) capture whose tool result never
	 * arrived within the stale window (turn cancelled, host interrupted, ...).
	 */
	private isCapturePendingStale(entry: RuntimePrPublicationPending, nowMs: number): boolean {
		return !entry.uncertain && nowMs - entry.startedAt > CAPTURE_PENDING_STALE_MS;
	}

	/**
	 * Persists stale pending captures as explicit uncertainties (visible in
	 * the panel and resumable with acknowledgment). Idempotent per captureId.
	 */
	private async markStalePendingCaptures(key: string, record: RuntimeGitHubPrTrackingRecord): Promise<void> {
		const nowMs = this.nowMs();
		const staleIds = record.commentAutomation.publication.pending
			.filter((entry) => this.isCapturePendingStale(entry, nowMs))
			.map((entry) => entry.captureId);
		if (staleIds.length === 0) {
			return;
		}
		const stale = new Set(staleIds);
		await upsertPrTrackingRecord(key, { accessScopeId: record.accessScopeId, pr: record.pr }, (current) => {
			const automation = current.commentAutomation;
			const changed = automation.publication.pending.some((entry) => stale.has(entry.captureId) && !entry.uncertain);
			if (!changed) {
				return current;
			}
			return {
				...current,
				revision: current.revision + 1,
				commentAutomation: {
					...automation,
					publication: {
						...automation.publication,
						pending: automation.publication.pending.map((entry) =>
							stale.has(entry.captureId) && !entry.uncertain
								? { ...entry, uncertain: true, uncertainReason: STALE_PENDING_CAPTURE_REASON }
								: entry,
						),
					},
				},
			};
		});
	}

	/**
	 * Persists one capture-pending entry (idempotent per captureId), or
	 * removes the entry for `removeCaptureId` when `pending` is null.
	 */
	private async upsertCapturePending(
		key: string,
		identity: { accessScopeId: string; pr: RuntimeTaskPullRequest },
		pending: Omit<RuntimePrPublicationPending, "startedAt"> | null,
		removeCaptureId?: string,
	): Promise<void> {
		await upsertPrTrackingRecord(key, identity, (record) => {
			const automation = record.commentAutomation;
			const current = automation.publication.pending;
			const next = current.filter((entry) => entry.captureId !== removeCaptureId);
			let changed = next.length !== current.length;
			if (pending !== null) {
				const index = next.findIndex((entry) => entry.captureId === pending.captureId);
				if (index < 0) {
					next.push({ ...pending, startedAt: this.nowMs() });
					changed = true;
				} else {
					const existing = next[index];
					if (
						existing !== undefined &&
						(existing.uncertain !== pending.uncertain || existing.uncertainReason !== pending.uncertainReason)
					) {
						next[index] = { ...existing, uncertain: pending.uncertain, uncertainReason: pending.uncertainReason };
						changed = true;
					}
				}
			}
			if (!changed) {
				return record;
			}
			return {
				...record,
				revision: record.revision + 1,
				commentAutomation: {
					...automation,
					publication: { ...automation.publication, pending: next },
				},
			};
		});
	}

	/**
	 * Persists newly captured published identities (deduplicated; retained
	 * for the tracked PR's lifetime) and drops the capture's pending entry.
	 * Recording a reply also removes any pending scheduling caused solely by
	 * it; a forced re-poll re-derives the reviewer-only state with the
	 * exclusion applied. Idempotent for duplicate events.
	 */
	private async applyPublishedIdentities(
		key: string,
		identity: { accessScopeId: string; pr: RuntimeTaskPullRequest },
		identities: PrPublishedIdentity[],
		captureId: string,
	): Promise<void> {
		let added = false;
		await upsertPrTrackingRecord(key, identity, (record) => {
			const automation = record.commentAutomation;
			const published = [...automation.publication.published];
			const seen = new Set(published.map(prPublishedIdentityKey));
			for (const entry of identities) {
				const entryKey = prPublishedIdentityKey(entry);
				if (!seen.has(entryKey)) {
					published.push(entry);
					seen.add(entryKey);
					added = true;
				}
			}
			const pending = automation.publication.pending.filter((entry) => entry.captureId !== captureId);
			if (!added && pending.length === automation.publication.pending.length) {
				return record;
			}
			// The pending scheduling and queued intent are intentionally left
			// in place: the forced re-poll (or the due settle) re-derives
			// them with the exclusion applied, which drops scheduling caused
			// solely by the recorded reply while preserving a reviewer's
			// existing quiet-time deadline.
			return {
				...record,
				revision: record.revision + 1,
				commentAutomation: {
					...automation,
					publication: { published, pending },
				},
			};
		});
		if (!added) {
			return;
		}
		// Force an immediate re-poll so remaining reviewer feedback keeps its
		// own quiet window (not the reply's extended one).
		const subscription = this.subscriptions.get(key);
		if (subscription) {
			subscription.nextPollAt = 0;
		}
	}

	/**
	 * Restart reconciliation for unresolved publication captures. Each
	 * pending entry is re-resolved from the exact existing tool result in the
	 * task transcript (read-only); when the transcript no longer holds the
	 * result, the entry becomes an explicit uncertainty that pauses
	 * automatic handling until reconciled or explicitly resumed. Nothing is
	 * silently cleared because a session finished or restarted, and no
	 * publication command is ever run here.
	 */
	/**
	 * Resolves a workspaceId to a scope: managed workspaces first, then the
	 * durable workspace index (for workspaces not loaded yet at startup).
	 */
	private async resolveWorkspaceScope(workspaceId: string): Promise<PrCommentAutomationWorkspaceScope | null> {
		const managed = this.deps.listManagedWorkspaces().find((scope) => scope.workspaceId === workspaceId);
		if (managed) {
			return managed;
		}
		const resolver = this.deps.resolveWorkspacePathById;
		if (!resolver) {
			return null;
		}
		const workspacePath = await resolver(workspaceId).catch(() => null);
		return workspacePath ? { workspaceId, workspacePath } : null;
	}

	private async reconcilePublicationCaptures(): Promise<void> {
		const records = await listPrTrackingRecords();
		for (const record of records) {
			const pending = record.commentAutomation.publication.pending;
			if (pending.length === 0) {
				continue;
			}
			const newIdentities: PrPublishedIdentity[] = [];
			const dropped = new Set<string>();
			const uncertainties = new Map<string, string>();
			for (const entry of pending) {
				let resolution: ReturnType<typeof resolvePublicationOutput> | null = null;
				const scope = await this.resolveWorkspaceScope(entry.workspaceId);
				if (scope) {
					try {
						const sessionService = await this.deps.getClineTaskSessionService(scope);
						const messages = await sessionService.loadTaskSessionMessages(entry.taskId);
						const toolResult = messages.find(
							(message) =>
								message.meta?.toolCallId === entry.captureId && message.meta?.hookEventName === "tool_call_end",
						);
						if (toolResult) {
							resolution = resolvePublicationOutput({
								operations: [
									{
										operation: entry.operation,
										kind: entry.kind,
										explicitRepository: null,
										explicitNumber: null,
										// Restart recovery has the transcript content but not
										// the original fragment: plain-text scan with the
										// multi-object guard.
										fragment: "",
									},
								],
								target: entry.target,
								output: toolResult.content,
								error: null,
							});
						}
					} catch {
						// Transcript unavailable: fall through to uncertainty.
					}
				}
				if (resolution?.status === "published") {
					newIdentities.push(...resolution.identities);
					dropped.add(entry.captureId);
				} else if (resolution?.status === "failed") {
					dropped.add(entry.captureId);
				} else {
					uncertainties.set(
						entry.captureId,
						entry.uncertainReason ?? `Capture was interrupted; the published identity could not be confirmed.`,
					);
				}
			}
			if (dropped.size === 0 && uncertainties.size === 0) {
				continue;
			}
			await upsertPrTrackingRecord(
				record.canonicalPrKey,
				{ accessScopeId: record.accessScopeId, pr: record.pr },
				(current) => {
					const automation = current.commentAutomation;
					const published = [...automation.publication.published];
					const seen = new Set(published.map(prPublishedIdentityKey));
					for (const identity of newIdentities) {
						const identityKey = prPublishedIdentityKey(identity);
						if (!seen.has(identityKey)) {
							published.push(identity);
							seen.add(identityKey);
						}
					}
					const nextPending = automation.publication.pending
						.filter((entry) => !dropped.has(entry.captureId))
						.map((entry) => {
							const reason = uncertainties.get(entry.captureId);
							return reason !== undefined && !entry.uncertain
								? { ...entry, uncertain: true, uncertainReason: reason }
								: entry;
						});
					const changed =
						published.length !== automation.publication.published.length ||
						nextPending.length !== automation.publication.pending.length ||
						nextPending.some((entry, index) => {
							const original = automation.publication.pending[index];
							return original === undefined || original.uncertain !== entry.uncertain;
						});
					if (!changed) {
						return current;
					}
					return {
						...current,
						revision: current.revision + 1,
						commentAutomation: {
							...automation,
							...(newIdentities.length > 0
								? {
										pendingFeedbackFingerprint: null,
										pendingCount: null,
										debounceDeadline: null,
										firstPendingAt: null,
									}
								: {}),
							publication: { published, pending: nextPending },
						},
					};
				},
			);
		}
	}

	/**
	 * Restart reconciliation: a queued intent that was provably never sent is
	 * re-queued (re-validated at its deadline); a dispatched or running
	 * intent whose turn state cannot be established becomes a failed dispatch
	 * that requires an explicit resume. No prompt is ever re-sent here.
	 */
	private async reconcileRestartedDispatches(): Promise<void> {
		const records = await listPrTrackingRecords();
		for (const record of records) {
			if (this.disposed) {
				return;
			}
			const dispatch = record.commentAutomation.dispatch;
			if (
				dispatch === null ||
				(dispatch.status !== "queued" && dispatch.status !== "waiting" && dispatch.status !== "running")
			) {
				continue;
			}

			const owner = record.commentAutomation.repairOwner;
			let sessionState: string | null = null;
			let sessionLastOutputAt: number | null = null;
			let taskExists = false;
			let workspaceStateUnavailable = false;
			if (owner) {
				const workspace = await this.resolveWorkspaceScope(owner.workspaceId);
				if (workspace) {
					const state = await this.deps.loadWorkspaceState(workspace.workspacePath).catch(() => null);
					if (state) {
						taskExists = state.board.columns.some((column) =>
							column.cards.some((card) => card.id === owner.taskId),
						);
						// Live resolution: the persisted sessions file alone is not
						// trustworthy evidence of a turn's outcome.
						const session =
							(await this.resolveLiveSessionSummary(
								{
									workspaceId: owner.workspaceId,
									workspacePath: workspace.workspacePath,
									taskId: owner.taskId,
								},
								owner.taskId,
							)) ??
							state.sessions[owner.taskId] ??
							null;
						sessionState = session?.state ?? null;
						sessionLastOutputAt = session?.lastOutputAt ?? null;
					} else {
						// The owner's workspace exists but is not loaded yet:
						// no evidence either way. Leave the dispatch as-is; it
						// reconciles when the workspace loads.
						workspaceStateUnavailable = true;
					}
				}
			}
			if (workspaceStateUnavailable) {
				continue;
			}
			if (dispatch.status === "queued" && dispatch.attemptedAt === null) {
				if (!owner || !taskExists) {
					await upsertPrTrackingRecord(
						record.canonicalPrKey,
						{ accessScopeId: record.accessScopeId, pr: record.pr },
						(current) => {
							const currentDispatch = current.commentAutomation.dispatch;
							if (currentDispatch === null || currentDispatch.dispatchId !== dispatch.dispatchId) {
								return current;
							}
							return {
								...current,
								revision: current.revision + 1,
								commentAutomation: {
									...current.commentAutomation,
									dispatch: {
										...currentDispatch,
										status: "failed",
										error: `The repair owner is unavailable; resume manually.`,
									},
								},
							};
						},
					);
				}
				// Otherwise: keep queued; the deadline pass re-validates.
				continue;
			}
			if (sessionState === "running" && dispatch.status !== "waiting") {
				continue; // The turn may still be our turn; settle it live.
			}
			// Live post-dispatch evidence settles the dispatch as it actually
			// ended; without it the outcome is unknown.
			const completed =
				dispatch.status !== "waiting" &&
				dispatch.attemptedAt !== null &&
				sessionLastOutputAt !== null &&
				sessionLastOutputAt >= dispatch.attemptedAt &&
				(sessionState === "idle" || sessionState === "awaiting_review");
			await upsertPrTrackingRecord(
				record.canonicalPrKey,
				{ accessScopeId: record.accessScopeId, pr: record.pr },
				(current) => {
					const currentDispatch = current.commentAutomation.dispatch;
					if (currentDispatch === null || currentDispatch.dispatchId !== dispatch.dispatchId) {
						return current;
					}
					return {
						...current,
						revision: current.revision + 1,
						commentAutomation: {
							...current.commentAutomation,
							// The turn provably produced post-attempt output, so
							// the captured batch was dispatched: advance the
							// watermark (and clear the pending-tracking fields,
							// as the post-send upsert does) so the same
							// feedback cannot be requeued after restart.
							...(!completed && currentDispatch.previousFeedbackFingerprint !== undefined
								? { lastDispatchedFeedbackFingerprint: currentDispatch.previousFeedbackFingerprint }
								: {}),
							...(completed
								? {
										pendingFeedbackFingerprint: null,
										pendingCount: null,
										debounceDeadline: null,
										firstPendingAt: null,
										lastDispatchedFeedbackFingerprint: currentDispatch.fingerprint,
									}
								: {}),
							dispatch: {
								...currentDispatch,
								status: completed ? "completed" : "failed",
								error: completed
									? null
									: `A restart interrupted comment handling and the outcome is unknown; resume manually.`,
							},
						},
					};
				},
			);
		}
	}

	/** Read-only tracking state for the task detail surface. */
	async getTaskPrTrackingState(
		scope: PrCommentAutomationWorkspaceScope,
		taskId: string,
	): Promise<RuntimeTaskPrTrackingStateResponse> {
		const neutral: RuntimeTaskPrTrackingState = {
			enabled: false,
			supported: true,
			pr: null,
			pendingCount: 0,
			pendingDeadline: null,
			dispatch: null,
			blocker: null,
			resumable: false,
			resumeRequiresAcknowledgment: false,
		};
		const state = await this.deps.loadWorkspaceState(scope.workspacePath);
		const card = state.board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
		if (!card) {
			return { ok: false, error: `Task "${taskId}" not found.`, state: neutral };
		}
		const enabled = card.autoAddressComments === true;
		const prs = (card.pullRequests ?? []).filter(
			(pullRequest) => pullRequest.provider === "github" && pullRequest.host === "github.com",
		);
		// Same effective-agent gate as subscription and dispatch (an unset
		// card agentId inherits the workspace's selected agent, not Cline).
		const supported = enabled ? await this.isClineAgentTask(scope, card) : (card.agentId ?? "cline") === "cline";
		if (!enabled) {
			return { ok: true, state: { ...neutral, pr: prs[0] ?? null } };
		}
		if (!supported) {
			return {
				ok: true,
				state: {
					...neutral,
					enabled: true,
					supported: false,
					pr: prs[0] ?? null,
					blocker: `Comment handling supports the native Cline agent only in v1.`,
				},
			};
		}
		if (prs.length === 0) {
			return {
				ok: true,
				state: {
					...neutral,
					enabled: true,
					blocker: `Link a github.com pull request to enable comment handling.`,
				},
			};
		}
		if (prs.length > 1) {
			return {
				ok: true,
				state: {
					...neutral,
					enabled: true,
					blocker: `Multiple github.com pull requests are linked; keep exactly one for comment handling.`,
				},
			};
		}
		const pr = prs[0];
		const key = getPullRequestIdentityKey(pr);
		const loaded = await loadPrTrackingRecord(key);
		if (loaded.status === "malformed") {
			return {
				ok: true,
				state: {
					...neutral,
					enabled: true,
					pr,
					blocker: `The PR tracking record is malformed; tracking is blocked. ${loaded.error}`,
				},
			};
		}
		if (loaded.status === "missing") {
			return { ok: true, state: { ...neutral, enabled: true, pr } };
		}
		const record = loaded.record;
		const automation = record.commentAutomation;
		const sub = this.subscriptions.get(key);
		const nowMs = this.nowMs();
		// A stale start-phase capture (result never arrived) surfaces as the
		// same blocker/resume flow as an explicit uncertainty.
		const uncertainEntry = automation.publication.pending.find(
			(entry) => entry.uncertain || this.isCapturePendingStale(entry, nowMs),
		);
		const capturePaused = this.captureBlocked.has(key);
		const blocker = capturePaused
			? `Publication capture could not be persisted; automatic comment handling is paused for this pull request.`
			: uncertainEntry
				? (uncertainEntry.uncertainReason ??
					(this.isCapturePendingStale(uncertainEntry, nowMs)
						? STALE_PENDING_CAPTURE_REASON
						: `An implementation comment could not be identified; automatic comment handling is paused.`))
				: automation.autoSendPaused === true
					? RATE_LIMIT_PAUSED_REASON
					: sub !== undefined && sub.candidates.size > 1 && automation.repairOwner === null
						? `Multiple tasks have comment handling enabled for this pull request. Choose one repair owner.`
						: null;
		return {
			ok: true,
			state: {
				enabled: true,
				supported: true,
				pr,
				pendingCount: automation.pendingCount ?? 0,
				pendingDeadline: automation.debounceDeadline,
				dispatch: automation.dispatch,
				blocker,
				resumable:
					automation.dispatch?.status === "failed" ||
					automation.autoSendPaused === true ||
					uncertainEntry !== undefined ||
					capturePaused,
				resumeRequiresAcknowledgment: uncertainEntry !== undefined || capturePaused,
			},
		};
	}

	/**
	 * Clears the state an explicit Resume acknowledges: uncertain/stale
	 * capture entries and the rate-limit history (attempts + pause). Called
	 * only after every validation that can fail has passed, so a resume that
	 * fails never clears the pause it was asked to resolve.
	 */
	private async clearResumedCommentAutomation(
		key: string,
		record: RuntimeGitHubPrTrackingRecord,
		nowMs: number,
	): Promise<void> {
		await upsertPrTrackingRecord(key, { accessScopeId: record.accessScopeId, pr: record.pr }, (current) => {
			const currentAutomation = current.commentAutomation;
			if (
				!currentAutomation.autoSendPaused &&
				currentAutomation.autoSendAttempts.length === 0 &&
				!currentAutomation.publication.pending.some(
					(entry) => entry.uncertain || this.isCapturePendingStale(entry, nowMs),
				)
			) {
				return current;
			}
			return {
				...current,
				revision: current.revision + 1,
				commentAutomation: {
					...currentAutomation,
					publication: {
						...currentAutomation.publication,
						pending: currentAutomation.publication.pending.filter(
							(entry) => !(entry.uncertain || this.isCapturePendingStale(entry, nowMs)),
						),
					},
					autoSendAttempts: [],
					autoSendPaused: false,
				},
			};
		});
		this.captureBlocked.delete(key);
	}

	/**
	 * Explicit "Resume comment handling": allowed for a failed dispatch, a
	 * tripped safety-cap pause, or an unresolved capture uncertainty (the
	 * last two require nothing else; an uncertain capture additionally
	 * requires explicit acknowledgment). Rechecks PR open state and scope
	 * with a fresh read, and dispatches exactly one new instruction when a
	 * failed dispatch is involved; `dispatched` reports whether it was
	 * actually sent. Fingerprint history is retained; the rate-limit history
	 * is reset by this explicit action only.
	 */
	async resumeCommentHandling(
		scope: PrCommentAutomationWorkspaceScope,
		taskId: string,
		options: { acknowledgeCaptureUncertainty?: boolean } = {},
	): Promise<RuntimeTaskPrCommentResumeResponse> {
		const state = await this.deps.loadWorkspaceState(scope.workspacePath);
		const card = state.board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
		if (!card || card.autoAddressComments !== true) {
			return { ok: false, error: `Comment handling is not enabled for this task.`, dispatched: false };
		}
		const prs = (card.pullRequests ?? []).filter(
			(pullRequest) => pullRequest.provider === "github" && pullRequest.host === "github.com",
		);
		if (prs.length !== 1) {
			return {
				ok: false,
				error: `Exactly one github.com pull request must be linked to resume.`,
				dispatched: false,
			};
		}
		const pr = prs[0];
		const key = getPullRequestIdentityKey(pr);
		const loaded = await loadPrTrackingRecord(key);
		if (loaded.status !== "ok") {
			return { ok: false, error: `The PR tracking record is unavailable.`, dispatched: false };
		}
		const record = loaded.record;
		const automation = record.commentAutomation;
		const hasFailedDispatch = automation.dispatch?.status === "failed";
		const ratePaused = automation.autoSendPaused === true;
		const nowMs = this.nowMs();
		// A stale start-phase capture follows the same acknowledgment flow.
		const uncertainEntry = automation.publication.pending.find(
			(entry) => entry.uncertain || this.isCapturePendingStale(entry, nowMs),
		);
		// An unpersisted capture is surfaced as resumable (with
		// acknowledgment) by getTaskPrTrackingState; Resume must accept it.
		const capturePaused = this.captureBlocked.has(key);
		const captureUnresolved = uncertainEntry !== undefined || capturePaused;
		if (!hasFailedDispatch && !ratePaused && !captureUnresolved) {
			return { ok: false, error: `There is nothing to resume.`, dispatched: false };
		}
		if (captureUnresolved && options.acknowledgeCaptureUncertainty !== true) {
			return {
				ok: false,
				error: `Publication capture is unresolved: an unidentified implementation comment could retrigger comment handling. Resume with acknowledgment to accept that risk.`,
				dispatched: false,
			};
		}
		if (!hasFailedDispatch) {
			// A pause-only resume resolves the acknowledged pause; normal
			// scheduling continues from the next poll once feedback is pending.
			await this.clearResumedCommentAutomation(key, record, nowMs);
			return { ok: true, dispatched: false };
		}
		// Re-check the PR and GitHub reachability BEFORE clearing the pause a
		// failed-dispatch Resume resolves: a resume that cannot proceed must
		// leave the pause intact.
		if (automation.repairOwner?.taskId !== taskId) {
			return { ok: false, error: `This task is not the current repair owner.`, dispatched: false };
		}
		let accessScopeId: string;
		try {
			accessScopeId = await this.deps.getGitHubAccessScopeId();
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error), dispatched: false };
		}
		const snapshot = await this.deps.ghClient.fetchSnapshot(
			{ host: pr.host, repository: pr.repository, number: pr.number },
			scope.workspacePath,
			accessScopeId,
		);
		if (!snapshot.complete) {
			return { ok: false, error: `Cannot reach GitHub right now; try again.`, dispatched: false };
		}
		if (snapshot.prState !== "open") {
			return { ok: false, error: `The pull request is no longer open.`, dispatched: false };
		}
		const pending = findPrFeedbackPendingEvents(
			excludePublishedEvents(snapshot.events, automation.publication.published),
			automation.lastDispatchedFeedbackFingerprint,
		);
		// Explicit user Resume: clear the acknowledged capture uncertainty and
		// reset the rate-limit history, so a failed-dispatch Resume is not
		// immediately re-paused by the cap. This is the explicit
		// acknowledgment itself, never a silent bypass.
		await this.clearResumedCommentAutomation(key, record, nowMs);
		if (pending.length === 0) {
			// Nothing left to address: close the failure, keep the history.
			const identity = { accessScopeId: record.accessScopeId, pr: record.pr };
			await upsertPrTrackingRecord(key, identity, (current) => {
				const currentDispatch = current.commentAutomation.dispatch;
				if (currentDispatch === null || currentDispatch.status !== "failed") {
					return current;
				}
				return {
					...current,
					revision: current.revision + 1,
					commentAutomation: {
						...current.commentAutomation,
						pendingFeedbackFingerprint: null,
						pendingCount: null,
						debounceDeadline: null,
						firstPendingAt: null,
						dispatch: { ...currentDispatch, status: "completed" },
					},
				};
			});
			return { ok: true, dispatched: false };
		}
		if (!this.subscriptions.has(key)) {
			await this.refreshWorkspace(scope);
		}
		const sub = this.subscriptions.get(key);
		const candidate = sub?.candidates.get(`${scope.workspaceId}/${taskId}`);
		if (!sub || !candidate) {
			return { ok: false, error: `Comment handling is not currently enabled for this task.`, dispatched: false };
		}
		try {
			const clineTaskSessionService = await this.deps.getClineTaskSessionService(candidate);
			const terminalManager = await this.deps.getTerminalManager(candidate);
			if (isTaskWriterActive(taskId, { clineTaskSessionService, terminalManager })) {
				return { ok: false, error: `The task agent is active; try again when it is idle.`, dispatched: false };
			}
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error), dispatched: false };
		}
		const owner = automation.repairOwner;
		if (!owner) {
			return { ok: false, error: `The repair owner is unavailable.`, dispatched: false };
		}
		const outcome = await this.executeDispatch(sub, owner, candidate, record.accessScopeId, snapshot, nowMs);
		if (outcome.status === "held") {
			return { ok: false, error: outcome.reason, dispatched: false };
		}
		return { ok: true, dispatched: outcome.status === "sent" };
	}
}

export function createPrCommentAutomationService(
	deps: PrCommentAutomationServiceDependencies,
): PrCommentAutomationService {
	return new PrCommentAutomationService(deps);
}
