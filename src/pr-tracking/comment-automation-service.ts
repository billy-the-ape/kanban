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
import { randomUUID } from "node:crypto";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type {
	RuntimeGitHubPrTrackingRecord,
	RuntimePrCommentAutomation,
	RuntimePrCommentOwner,
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
	RuntimeTaskPrCommentResumeResponse,
	RuntimeTaskPrTrackingState,
	RuntimeTaskPrTrackingStateResponse,
	RuntimeTaskPullRequest,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { getPullRequestIdentityKey } from "../core/pull-request-links";
import { isTaskWriterActive } from "../server/task-writer-activity";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type { PrFeedbackEvent } from "./feedback-fingerprint";
import { computePrFeedbackFingerprint, findPrFeedbackPendingEvents } from "./feedback-fingerprint";
import type { GitHubPrClient, GitHubPrSnapshot } from "./github-pr-client";
import { listPrTrackingRecords, loadPrTrackingRecord, upsertPrTrackingRecord } from "./pr-comment-record-store";

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
}

const POLL_INTERVAL_MS = 60_000;
const POLL_JITTER_MS = 5_000;
const TICK_INTERVAL_MS = 10_000;
const DEBOUNCE_MS = 120_000;
const MAX_PENDING_MS = 600_000;
const DISPATCH_RETRY_MS = 30_000;
const BACKOFF_SCHEDULE_MS = [60_000, 120_000, 240_000, 480_000, 900_000];
/** Columns whose tasks count as active comment-handling subscriptions. */
const ACTIVE_COLUMN_IDS = new Set(["backlog", "in_progress", "review"]);

function backoffMs(consecutiveFailures: number): number {
	return BACKOFF_SCHEDULE_MS[Math.min(Math.max(consecutiveFailures, 1) - 1, BACKOFF_SCHEDULE_MS.length - 1)];
}

/** The fixed follow-up instruction (the same text is never re-sent for a
 * previously dispatched fingerprint). */
export function buildCommentHandlingInstruction(prUrl: string): string {
	return [
		`Address comments on the linked PR: ${prUrl}.`,
		"Check the feedback against the current code and original task requirements.",
		"Fix valid issues, explain any disagreements, and update the same PR.",
		"Explain changes and disagreements in task chat; do not post PR comments.",
	].join(" ");
}

export interface PrCommentAutomationServiceDependencies {
	listManagedWorkspaces: () => Array<PrCommentAutomationWorkspaceScope>;
	loadWorkspaceState: (workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	getClineTaskSessionService: (scope: PrCommentAutomationWorkspaceScope) => Promise<ClineTaskSessionService>;
	getTerminalManager: (scope: PrCommentAutomationWorkspaceScope) => Promise<TerminalSessionManager>;
	/** Reusable backend chat send — the same path the browser's sendTaskChatMessage uses. */
	sendTaskChatMessage: (
		scope: PrCommentAutomationWorkspaceScope,
		body: RuntimeTaskChatSendRequest,
	) => Promise<RuntimeTaskChatSendResponse>;
	getGitHubAccessScopeId: () => Promise<string>;
	ghClient: GitHubPrClient;
	now?: () => number;
	warn?: (message: string) => void;
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
		const pending = findPrFeedbackPendingEvents(input.snapshot.events, automation.lastDispatchedFeedbackFingerprint);
		const dispatch = automation.dispatch;
		const inFlight = dispatch !== null && (dispatch.status === "queued" || dispatch.status === "running");
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
	private timer: NodeJS.Timeout | null = null;
	private started = false;

	constructor(private readonly deps: PrCommentAutomationServiceDependencies) {}

	private nowMs(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	private warn(message: string): void {
		this.deps.warn ? this.deps.warn(message) : process.stderr.write(`[pr-comment-automation] ${message}\n`);
	}

	/** Reconciles durable state from a restart, then starts the poll tick. */
	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		void (async () => {
			try {
				await this.reconcileRestartedDispatches();
				for (const scope of this.deps.listManagedWorkspaces()) {
					await this.refreshWorkspace(scope);
				}
			} catch (error) {
				this.warn(`startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		})();
		this.timer = setInterval(() => {
			void this.tick().catch((error: unknown) => {
				this.warn(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, TICK_INTERVAL_MS);
		this.timer.unref?.();
	}

	dispose(): void {
		this.started = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Rescans one workspace's board and updates PR subscriptions. Called on
	 * startup and after every board save. Disabling, unlinking, or moving a
	 * card to a terminal column cancels its queued intent.
	 */
	async refreshWorkspace(scope: PrCommentAutomationWorkspaceScope): Promise<void> {
		let state: RuntimeWorkspaceStateResponse;
		try {
			state = await this.deps.loadWorkspaceState(scope.workspacePath);
		} catch {
			return;
		}
		const removedCandidates: Array<{ key: string; candidate: PrCommentCandidate }> = [];
		const activeCandidateIds = new Map<string, PrCommentCandidate>();
		for (const column of state.board.columns) {
			if (!ACTIVE_COLUMN_IDS.has(column.id)) {
				continue;
			}
			for (const card of column.cards) {
				if (card.autoAddressComments !== true) {
					continue;
				}
				for (const pullRequest of card.pullRequests ?? []) {
					if (pullRequest.provider !== "github" || pullRequest.host !== "github.com") {
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
		}
		for (const [key, sub] of [...this.subscriptions]) {
			for (const [candidateId, candidate] of [...sub.candidates]) {
				if (candidate.workspaceId !== scope.workspaceId) {
					continue;
				}
				if (!activeCandidateIds.has(`${key}/${candidateId}`)) {
					sub.candidates.delete(candidateId);
					removedCandidates.push({ key, candidate });
				}
			}
			if (sub.candidates.size === 0) {
				this.subscriptions.delete(key);
			}
		}
		for (const { key } of removedCandidates) {
			try {
				await this.cancelPendingForTask(key);
			} catch (error) {
				this.warn(`cancel pending failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	private async tick(): Promise<void> {
		const nowMs = this.nowMs();
		for (const sub of [...this.subscriptions.values()]) {
			if (sub.pollInFlight || nowMs < sub.nextPollAt) {
				continue;
			}
			sub.pollInFlight = true;
			void this.pollSubscription(sub)
				.catch((error: unknown) => {
					this.warn(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
				})
				.finally(() => {
					sub.pollInFlight = false;
				});
		}
		for (const sub of [...this.subscriptions.values()]) {
			void this.settleDispatch(sub).catch((error: unknown) => {
				this.warn(`settle failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
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
		const snapshot = await this.deps.ghClient.fetchSnapshot(
			{ host: sub.pr.host, repository: sub.pr.repository, number: sub.pr.number },
			scope.workspacePath,
			accessScopeId,
		);
		if (!snapshot.complete) {
			// Partial failures cannot dispatch: back off and retry later.
			sub.consecutiveFailures += 1;
			sub.nextPollAt = nowMs + backoffMs(sub.consecutiveFailures);
			return;
		}
		sub.consecutiveFailures = 0;
		const candidates = [...sub.candidates.values()];
		await upsertPrTrackingRecord(sub.key, { accessScopeId, pr: sub.pr }, (record) =>
			applyPrPollOutcome(record, { candidates, snapshot, nowMs }),
		);
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
		const dispatch = automation.dispatch;
		const owner = automation.repairOwner;

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
			const state = await this.deps.loadWorkspaceState(candidate.workspacePath).catch(() => null);
			const session = state?.sessions[owner.taskId] ?? null;
			if (session?.state === "running") {
				return;
			}
			if (session?.state === "failed" || session?.state === "interrupted") {
				await this.setDispatchFailed(sub, `The comment-handling turn ended without completion.`);
				return;
			}
			if (session?.state === "idle" || session?.state === "awaiting_review") {
				await this.setDispatchCompleted(sub);
				return;
			}
			// Unknown turn state: do not guess; require an explicit resume.
			await this.setDispatchFailed(sub, `The turn state could not be determined; resume manually.`);
			return;
		}

		if (dispatch === null || dispatch.status !== "queued") {
			return;
		}
		if (sub.dispatchRetryAt !== null && nowMs < sub.dispatchRetryAt) {
			return;
		}
		if (nowMs < (automation.debounceDeadline ?? 0)) {
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
		const pending = findPrFeedbackPendingEvents(snapshot.events, automation.lastDispatchedFeedbackFingerprint);
		if (pending.length === 0) {
			await this.cancelPendingRecord(sub);
			return;
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
		await this.executeDispatch(sub, owner, candidate, accessScopeId, snapshot.events);
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
		events: PrFeedbackEvent[],
	): Promise<void> {
		const identity = { accessScopeId, pr: sub.pr };
		const dispatchId = randomUUID();
		const captured = computePrFeedbackFingerprint(events);
		if (captured === null) {
			await this.cancelPendingRecord(sub);
			return;
		}
		const nowMs = this.nowMs();
		await upsertPrTrackingRecord(sub.key, identity, (record) => ({
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				dispatch: {
					dispatchId,
					attemptedAt: null,
					fingerprint: captured,
					ownerRevision: record.commentAutomation.repairOwner?.revision ?? 0,
					status: "queued",
					turnRef: null,
					error: null,
				},
			},
		}));
		// Persist the attempted-at timestamp immediately before invoking the
		// send so a crash in flight is never ambiguous.
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
					dispatch: { ...dispatch, attemptedAt: nowMs },
				},
			};
		});
		const response = await this.deps.sendTaskChatMessage(scope, {
			taskId: owner.taskId,
			text: buildCommentHandlingInstruction(sub.pr.url),
			mode: "act",
		});
		if (response.ok) {
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
						pendingFeedbackFingerprint: null,
						pendingCount: null,
						debounceDeadline: null,
						firstPendingAt: null,
						lastDispatchedFeedbackFingerprint: captured,
						dispatch: {
							...dispatch,
							status: "running",
							turnRef: response.message?.id ?? null,
							error: null,
						},
					},
				};
			});
			return;
		}
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
					dispatch: {
						...dispatch,
						status: "failed",
						error: response.error ?? `Could not send the comment-handling instruction.`,
					},
				},
			};
		});
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
		if (dispatch === null || (dispatch.status !== "running" && dispatch.status !== "queued")) {
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

	/** Cancels the queued intent when a candidate task stops qualifying. */
	async cancelPendingForTask(key: string): Promise<void> {
		const sub = this.subscriptions.get(key);
		if (!sub) {
			return;
		}
		await this.cancelPendingRecord(sub);
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
			const dispatch = record.commentAutomation.dispatch;
			if (dispatch === null || (dispatch.status !== "queued" && dispatch.status !== "running")) {
				continue;
			}
			const owner = record.commentAutomation.repairOwner;
			let sessionState: string | null = null;
			let taskExists = false;
			if (owner) {
				const workspace = this.deps
					.listManagedWorkspaces()
					.find((scope) => scope.workspaceId === owner.workspaceId);
				if (workspace) {
					const state = await this.deps.loadWorkspaceState(workspace.workspacePath).catch(() => null);
					if (state) {
						taskExists = state.board.columns.some((column) =>
							column.cards.some((card) => card.id === owner.taskId),
						);
						sessionState = state.sessions[owner.taskId]?.state ?? null;
					}
				}
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
			if (sessionState === "running") {
				continue; // The turn may still be our turn; settle it live.
			}
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
								error: `A restart interrupted comment handling and the outcome is unknown; resume manually.`,
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
		const supported = (card.agentId ?? "cline") === "cline";
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
		const blocker =
			sub !== undefined && sub.candidates.size > 1 && automation.repairOwner === null
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
				resumable: automation.dispatch?.status === "failed",
			},
		};
	}

	/**
	 * Explicit "Resume comment handling": allowed only for a failed dispatch,
	 * rechecks PR open state and scope with a fresh read, and dispatches
	 * exactly one new instruction. Fingerprint history is retained.
	 */
	async resumeCommentHandling(
		scope: PrCommentAutomationWorkspaceScope,
		taskId: string,
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
		if (automation.dispatch?.status !== "failed") {
			return { ok: false, error: `There is no failed comment-handling dispatch to resume.`, dispatched: false };
		}
		if (automation.repairOwner?.taskId !== taskId) {
			return { ok: false, error: `This task is not the current repair owner.`, dispatched: false };
		}
		// Re-check PR/scope before resuming.
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
		const pending = findPrFeedbackPendingEvents(snapshot.events, automation.lastDispatchedFeedbackFingerprint);
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
		await this.executeDispatch(sub, owner, candidate, record.accessScopeId, snapshot.events);
		return { ok: true, dispatched: true };
	}
}

export function createPrCommentAutomationService(
	deps: PrCommentAutomationServiceDependencies,
): PrCommentAutomationService {
	return new PrCommentAutomationService(deps);
}
