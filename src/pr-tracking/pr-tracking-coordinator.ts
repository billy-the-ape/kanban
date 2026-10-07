// PRTRACK-0: the runtime-wide PR tracking coordinator.
//
// One coordinator per Kanban runtime covers all managed workspaces: eligible
// fake/inspect-only subscriptions (this PR; PRTRACK-1 replaces the demand
// source with live task-derived subscriptions) drive deduplicated 60-second
// polls per canonical PR per access scope, coalesced in-flight reads, a
// 60/120/240/480/900s backoff ladder with Retry-After deadlines, eligibility
// and terminal stop/resume rules, orphan record safety, and the scheduler
// lock for the automation storage root.
import { mkdirSync } from "node:fs";
import * as lockfile from "proper-lockfile";

import type {
	GitHubPrFeedbackCompleteness,
	GitHubPrMetadataSnapshot,
	GitHubPrNormalizedFeedbackEvent,
	GitHubPrTaskBinding,
	GitHubPrTerminalStopReason,
	RuntimeBoardColumnId,
	RuntimeBoardData,
} from "../core/api-contract";
import { getPullRequestIdentityKey } from "../core/pull-request-links";
import type { LockRequest } from "../fs/locked-file-system";
import { listWorkspaceIndexEntries, loadWorkspaceBoardById } from "../state/workspace-state";
import {
	type AccessScope,
	createGitHubGhAdapter,
	type GhAdapterFailure,
	type GitHubGhAdapter,
} from "./github-gh-adapter";
import { isTrackingSupportedPr, type ParsedCanonicalPrKey, parseCanonicalPrKey } from "./pr-identity";
import { getPrTrackingSchedulerLockRequest, PrRecordStore } from "./pr-record-store";
import {
	backoffBaseMs,
	isPrSnapshotStale,
	normalizeConversationComments,
	normalizeInlineComments,
	normalizeReviews,
	PR_POLL_JITTER_MAX_MS,
	PR_TERMINAL_RECONCILIATION_MAX_READS,
	type PrThreadInfo,
} from "./pr-snapshots";

export type PrTrackingConsumerKind = "comments" | "mergeCompletion";

/**
 * A fake/inspect-only subscription (the PRTRACK-0 seam). PRTRACK-1 replaces
 * this demand source with live task-derived subscriptions but keeps the same
 * descriptor shape.
 */
export interface PrTrackingSubscriptionDescriptor {
	workspaceId: string;
	taskId: string;
	canonicalPrKey: string;
	column: RuntimeBoardColumnId;
	consumers: Record<PrTrackingConsumerKind, boolean>;
	/** Optional opaque access scope (tests with disjoint scopes). */
	accessScopeId?: string;
}

export type SubscriptionBlocker =
	| "malformed_key"
	| "unsupported_host"
	| "auth"
	| "scope"
	| "scheduler"
	| "record_malformed";

export type SubscriptionAddResult = { status: "active" } | { status: "blocked"; blocker: SubscriptionBlocker };

interface TrackedSubscription {
	workspaceId: string;
	taskId: string;
	canonicalPrKey: string;
	column: RuntimeBoardColumnId;
	consumers: Record<PrTrackingConsumerKind, boolean>;
	accessScopeId: string;
	/** Non-null when the subscription exists but must not schedule reads. */
	blocker: string | null;
}

type PrDemandMode = "poll" | "reconcile" | "none";

interface SubscriptionVerdict {
	subscription: TrackedSubscription;
	binding: GitHubPrTaskBinding | null;
	mode: "poll" | "reconcile" | "stopped" | "blocked";
	stopReason: GitHubPrTerminalStopReason | null;
	blocker: string | null;
}

interface PrPollState {
	prKey: string;
	accessScopeId: string;
	timer: ReturnType<typeof setTimeout> | null;
	nextPollAt: number | null;
	consecutiveFailures: number;
	rateLimitDeadline: number | null;
	pollInFlight: Promise<void> | null;
	metadata: GitHubPrMetadataSnapshot | null;
	nodeId: string | null;
	feedback: GitHubPrNormalizedFeedbackEvent[] | null;
	feedbackCompleteness: GitHubPrFeedbackCompleteness | null;
	snapshotCheckedAt: number | null;
	/** Last fully-read thread state (transient) keyed by inline comment id. */
	threadState: Map<string, PrThreadInfo> | null;
}

export interface CoordinatorState {
	started: boolean;
	schedulerBlocked: boolean;
	authBlocker: string | null;
	subscriptions: Array<{
		workspaceId: string;
		taskId: string;
		canonicalPrKey: string;
		accessScopeId: string;
		active: boolean;
		blocker: string | null;
	}>;
	polls: Array<{
		prKey: string;
		accessScopeId: string;
		nextPollAt: number | null;
		consecutiveFailures: number;
		rateLimitDeadline: number | null;
		metadataState: GitHubPrMetadataSnapshot["state"] | null;
	}>;
}

export interface CreatePrTrackingCoordinatorDependencies {
	adapter?: GitHubGhAdapter;
	store?: PrRecordStore;
	schedulerLockRequest?: LockRequest;
	listManagedWorkspaceBoards?: () => Promise<Array<{ workspaceId: string; board: RuntimeBoardData }>>;
	warn?: (message: string) => void;
	/** Visible stderr line for scheduler-lock failures (second process). */
	logError?: (message: string) => void;
	now?: () => number;
	/** Injectable jitter source (tests). */
	random?: () => number;
}

const SCHEDULER_LOCK_STALE_MS = 15_000;

export class PrTrackingCoordinator {
	private readonly adapter: GitHubGhAdapter;
	private readonly store: PrRecordStore;
	private readonly schedulerLockRequest: LockRequest;
	private readonly listBoards: () => Promise<Array<{ workspaceId: string; board: RuntimeBoardData }>>;
	private readonly warn: (message: string) => void;
	private readonly logError: (message: string) => void;
	private readonly now: () => number;
	private readonly random: () => number;

	private readonly subscriptions = new Map<string, TrackedSubscription>();
	private readonly polls = new Map<string, PrPollState>();
	private readonly scopes = new Map<string, AccessScope>();
	private scopeCache: AccessScope | null = null;
	private scopeFailure: GhAdapterFailure | null = null;
	private schedulerLockRelease: (() => Promise<void>) | null = null;
	private schedulerBlocked = false;
	private authBlocker: string | null = null;
	private started = false;
	private stopping = false;

	constructor(deps: CreatePrTrackingCoordinatorDependencies = {}) {
		this.adapter = deps.adapter ?? createGitHubGhAdapter();
		this.store = deps.store ?? new PrRecordStore();
		this.schedulerLockRequest = deps.schedulerLockRequest ?? getPrTrackingSchedulerLockRequest();
		this.listBoards =
			deps.listManagedWorkspaceBoards ??
			(async () => {
				const entries = await listWorkspaceIndexEntries();
				const boards: Array<{ workspaceId: string; board: RuntimeBoardData }> = [];
				for (const entry of entries) {
					try {
						boards.push({
							workspaceId: entry.workspaceId,
							board: await loadWorkspaceBoardById(entry.workspaceId),
						});
					} catch {
						// Unreadable boards cannot link PRs; skip them.
					}
				}
				return boards;
			});
		this.warn = deps.warn ?? (() => {});
		this.logError = deps.logError ?? (() => {});
		this.now = deps.now ?? Date.now;
		this.random = deps.random ?? Math.random;
	}

	/**
	 * Start the coordinator. Never blocks or fails runtime startup: the
	 * startup pass only classifies orphan records, and the scheduler lock is
	 * acquired lazily on the first eligible subscription.
	 */
	async start(): Promise<void> {
		this.started = true;
		void this.runOrphanClassificationPass().catch((error: unknown) => {
			this.warn(`PR tracking startup pass failed: ${String(error)}`);
		});
	}

	async stop(): Promise<void> {
		this.stopping = true;
		for (const state of this.polls.values()) {
			this.clearTimer(state);
		}
		const inFlight: Array<Promise<void>> = [];
		for (const state of this.polls.values()) {
			if (state.pollInFlight) {
				inFlight.push(state.pollInFlight);
			}
		}
		await Promise.all(inFlight);
		if (this.schedulerLockRelease) {
			const release = this.schedulerLockRelease;
			this.schedulerLockRelease = null;
			await release();
		}
	}

	private subscriptionKey(workspaceId: string, taskId: string): string {
		return `${workspaceId}\u0000${taskId}`;
	}

	private pollKey(prKey: string, accessScopeId: string): string {
		return `${prKey}\u0000${accessScopeId}`;
	}

	private trackSubscription(sub: TrackedSubscription): void {
		this.subscriptions.set(this.subscriptionKey(sub.workspaceId, sub.taskId), sub);
	}

	private activeSubscriptionsFor(prKey: string, accessScopeId: string): TrackedSubscription[] {
		const result: TrackedSubscription[] = [];
		for (const sub of this.subscriptions.values()) {
			if (sub.canonicalPrKey === prKey && sub.accessScopeId === accessScopeId && sub.blocker === null) {
				result.push(sub);
			}
		}
		return result;
	}

	private subscriptionCountForPr(prKey: string): number {
		let count = 0;
		for (const sub of this.subscriptions.values()) {
			if (sub.canonicalPrKey === prKey) {
				count += 1;
			}
		}
		return count;
	}

	private getPollState(prKey: string, accessScopeId: string): PrPollState {
		const key = this.pollKey(prKey, accessScopeId);
		let state = this.polls.get(key);
		if (!state) {
			state = {
				prKey,
				accessScopeId,
				timer: null,
				nextPollAt: null,
				consecutiveFailures: 0,
				rateLimitDeadline: null,
				pollInFlight: null,
				metadata: null,
				nodeId: null,
				feedback: null,
				feedbackCompleteness: null,
				snapshotCheckedAt: null,
				threadState: null,
			};
			this.polls.set(key, state);
		}
		return state;
	}

	private clearTimer(state: PrPollState): void {
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = null;
		}
		state.nextPollAt = null;
	}

	private cancelAllPolls(): void {
		for (const state of this.polls.values()) {
			this.clearTimer(state);
		}
	}

	private async ensureScope(
		requestedScopeId?: string,
	): Promise<{ ok: true; scope: AccessScope } | { ok: false; blocker: "auth" | "scope" }> {
		if (this.scopeFailure) {
			return { ok: false, blocker: "auth" };
		}
		if (this.scopeCache) {
			if (!requestedScopeId || this.scopeCache.accessScopeId === requestedScopeId) {
				this.scopes.set(this.scopeCache.accessScopeId, this.scopeCache);
				return { ok: true, scope: this.scopeCache };
			}
			const known = this.scopes.get(requestedScopeId);
			if (known) {
				return { ok: true, scope: known };
			}
			return { ok: false, blocker: "scope" };
		}
		const resolved = await this.adapter.resolveAccessScope();
		if (!resolved.ok) {
			this.scopeFailure = resolved.failure;
			this.authBlocker = resolved.failure.message;
			this.warn(`PR tracking auth blocker: ${resolved.failure.message}`);
			this.cancelAllPolls();
			return { ok: false, blocker: "auth" };
		}
		this.scopeCache = resolved.scope;
		this.scopes.set(resolved.scope.accessScopeId, resolved.scope);
		if (requestedScopeId && requestedScopeId !== resolved.scope.accessScopeId) {
			return { ok: false, blocker: "scope" };
		}
		return { ok: true, scope: resolved.scope };
	}

	/**
	 * Acquire the scheduler lock lazily (first eligible subscription). A
	 * second process holding it blocks only the scheduler: the runtime keeps
	 * serving, with a visible stderr line.
	 */
	private async ensureSchedulerLock(): Promise<void> {
		if (this.schedulerLockRelease || this.schedulerBlocked) {
			return;
		}
		mkdirSync(this.schedulerLockRequest.path, { recursive: true });
		try {
			const release = await lockfile.lock(this.schedulerLockRequest.path, {
				stale: SCHEDULER_LOCK_STALE_MS,
				retries: 0,
				realpath: false,
				lockfilePath: this.schedulerLockRequest.lockfilePath,
			});
			this.schedulerLockRelease = () => release();
		} catch (error) {
			const candidate = error as { code?: string };
			if (candidate.code === "ELOCKED") {
				this.schedulerBlocked = true;
				this.logError(
					"[pr-tracking] scheduler lock is held by another Kanban process on this storage root; " +
						"PR tracking scheduling is disabled in this runtime.",
				);
			} else {
				this.warn(`PR tracking scheduler lock failed: ${String(error)}`);
			}
		}
	}

	/**
	 * Register a fake/inspect-only subscription. Blocked subscriptions (unsupported
	 * host, auth, locked scheduler, malformed record) never schedule reads but
	 * remain visible in coordinator state.
	 */
	async addSubscription(descriptor: PrTrackingSubscriptionDescriptor): Promise<SubscriptionAddResult> {
		const parsed = parseCanonicalPrKey(descriptor.canonicalPrKey);
		if (!parsed) {
			return { status: "blocked", blocker: "malformed_key" };
		}
		if (!isTrackingSupportedPr(descriptor.canonicalPrKey)) {
			this.trackSubscription({
				workspaceId: descriptor.workspaceId,
				taskId: descriptor.taskId,
				canonicalPrKey: descriptor.canonicalPrKey,
				column: descriptor.column,
				consumers: descriptor.consumers,
				accessScopeId: descriptor.accessScopeId ?? "unresolved",
				blocker: "unsupported_host",
			});
			return { status: "blocked", blocker: "unsupported_host" };
		}
		const scopeResult = await this.ensureScope(descriptor.accessScopeId);
		if (!scopeResult.ok) {
			this.trackSubscription({
				workspaceId: descriptor.workspaceId,
				taskId: descriptor.taskId,
				canonicalPrKey: descriptor.canonicalPrKey,
				column: descriptor.column,
				consumers: descriptor.consumers,
				accessScopeId: descriptor.accessScopeId ?? "unresolved",
				blocker: scopeResult.blocker,
			});
			return { status: "blocked", blocker: scopeResult.blocker };
		}
		const record = await this.store.loadRecord(descriptor.canonicalPrKey);
		if (record.ok) {
			return await this.finishSubscriptionAdd(descriptor, scopeResult.scope);
		}
		if (record.reason === "malformed") {
			return this.blockedSubscription(descriptor, scopeResult.scope, "record_malformed");
		}
		const created = await this.store.createRecord({
			canonicalPrKey: descriptor.canonicalPrKey,
			provider: "github",
			host: parsed.host,
			repository: parsed.repository,
			number: parsed.number,
		});
		if (!created.ok) {
			return this.blockedSubscription(descriptor, scopeResult.scope, "record_malformed");
		}
		return await this.finishSubscriptionAdd(descriptor, scopeResult.scope);
	}

	private async finishSubscriptionAdd(
		descriptor: PrTrackingSubscriptionDescriptor,
		scope: AccessScope,
	): Promise<SubscriptionAddResult> {
		const bindingResult = await this.store.upsertTaskBinding(descriptor.canonicalPrKey, {
			workspaceId: descriptor.workspaceId,
			taskId: descriptor.taskId,
		});
		if (!bindingResult.ok) {
			return this.blockedSubscription(descriptor, scope, "record_malformed");
		}
		if (this.schedulerBlocked) {
			return this.blockedSubscription(descriptor, scope, "scheduler");
		}
		await this.ensureSchedulerLock();
		if (this.schedulerBlocked) {
			return this.blockedSubscription(descriptor, scope, "scheduler");
		}
		this.trackSubscription({
			workspaceId: descriptor.workspaceId,
			taskId: descriptor.taskId,
			canonicalPrKey: descriptor.canonicalPrKey,
			column: descriptor.column,
			consumers: descriptor.consumers,
			accessScopeId: scope.accessScopeId,
			blocker: null,
		});
		await this.reevaluate(descriptor.canonicalPrKey, scope.accessScopeId);
		return { status: "active" };
	}

	private blockedSubscription(
		descriptor: PrTrackingSubscriptionDescriptor,
		scope: AccessScope,
		blocker: string,
	): SubscriptionAddResult {
		this.trackSubscription({
			workspaceId: descriptor.workspaceId,
			taskId: descriptor.taskId,
			canonicalPrKey: descriptor.canonicalPrKey,
			column: descriptor.column,
			consumers: descriptor.consumers,
			accessScopeId: scope.accessScopeId,
			blocker,
		});
		return { status: "blocked", blocker: blocker as Exclude<SubscriptionBlocker, "malformed_key"> };
	}

	/**
	 * Remove a subscription. When the last subscription for a PR leaves, the
	 * transient feedback snapshot is dropped immediately (no GitHub call) and
	 * the record is marked orphaned if no live card still links the PR.
	 */
	async removeSubscription(workspaceId: string, taskId: string): Promise<void> {
		const sub = this.subscriptions.get(this.subscriptionKey(workspaceId, taskId));
		if (!sub) {
			return;
		}
		this.subscriptions.delete(this.subscriptionKey(workspaceId, taskId));
		if (this.subscriptionCountForPr(sub.canonicalPrKey) === 0) {
			for (const state of this.polls.values()) {
				if (state.prKey === sub.canonicalPrKey) {
					this.clearTimer(state);
					state.feedback = null;
					state.feedbackCompleteness = null;
				}
			}
			await this.markOrphanIfUnlinked(sub.canonicalPrKey);
		}
	}

	/**
	 * Startup orphan classification: enumerate currently managed workspaces'
	 * cards, join them with PR records, and start/clear the 24-hour retention
	 * clock. Never schedules work and never enumerates PR records to discover
	 * tasks.
	 */
	private async runOrphanClassificationPass(): Promise<void> {
		const linkedKeys = new Set<string>();
		const boards = await this.listBoards();
		for (const { board } of boards) {
			for (const column of board.columns) {
				for (const card of column.cards) {
					for (const pr of card.pullRequests ?? []) {
						linkedKeys.add(getPullRequestIdentityKey(pr));
					}
				}
			}
		}
		const { records } = await this.store.listRecords();
		for (const record of records) {
			if (linkedKeys.has(record.canonicalPrKey)) {
				if (record.orphanedAt !== null) {
					await this.store.updateRecord(record.canonicalPrKey, record.revision, (current) => ({
						...current,
						orphanedAt: null,
					}));
				}
				continue;
			}
			const now = this.now();
			let orphanedAt = record.orphanedAt;
			if (orphanedAt === null) {
				const marked = await this.store.updateRecord(record.canonicalPrKey, record.revision, (current) => ({
					...current,
					orphanedAt: now,
				}));
				if (!marked.ok) {
					continue;
				}
				orphanedAt = now;
			}
			await this.store.deleteOrphanRecord(record.canonicalPrKey, {});
		}
	}

	private async markOrphanIfUnlinked(canonicalPrKey: string): Promise<void> {
		const boards = await this.listBoards();
		for (const { board } of boards) {
			for (const column of board.columns) {
				for (const card of column.cards) {
					for (const pr of card.pullRequests ?? []) {
						if (getPullRequestIdentityKey(pr) === canonicalPrKey) {
							return;
						}
					}
				}
			}
		}
		await this.store.updateRecord(canonicalPrKey, undefined, (current) =>
			current.orphanedAt === null ? { ...current, orphanedAt: this.now() } : current,
		);
	}

	/**
	 * Re-evaluate eligibility for one (PR, scope) demand union and arm or
	 * cancel its poll. Called before every read, after read effects, and on
	 * subscription changes.
	 */
	private async reevaluate(prKey: string, accessScopeId: string): Promise<void> {
		const state = this.getPollState(prKey, accessScopeId);
		const subs = this.activeSubscriptionsFor(prKey, accessScopeId);
		if (subs.length === 0 || this.authBlocker !== null || this.schedulerBlocked) {
			this.clearTimer(state);
			return;
		}
		const record = await this.store.loadRecord(prKey);
		if (!record.ok) {
			this.clearTimer(state);
			return;
		}
		const prState = state.metadata?.state ?? null;
		const verdicts = subs.map((sub) => this.evaluateSubscription(sub, record.record.taskBindings, prState));
		if (this.demandModeOf(verdicts) === "none") {
			this.clearTimer(state);
			return;
		}
		this.scheduleNext(state);
	}

	/**
	 * Eligibility table:
	 * - In Progress/In Review + PR open/draft + at least one enabled consumer
	 *   -> poll every 60s.
	 * - Merged + merge-completion enabled + completion reconciliation pending
	 *   -> bounded temporary polling (<= 3 reads per terminal episode).
	 * - Already-handled merge, closed-unmerged, inactive task, both checkboxes
	 *   off, unsupported host -> stop.
	 * Terminal stops persist; restart/checkbox/history moves never rearm.
	 */
	private evaluateSubscription(
		sub: TrackedSubscription,
		bindings: GitHubPrTaskBinding[],
		prState: GitHubPrMetadataSnapshot["state"] | null,
	): SubscriptionVerdict {
		const binding =
			bindings.find((item) => item.workspaceId === sub.workspaceId && item.taskId === sub.taskId) ?? null;
		if (!isTrackingSupportedPr(sub.canonicalPrKey)) {
			return {
				subscription: sub,
				binding,
				mode: "blocked",
				stopReason: "unsupported_host",
				blocker: "unsupported_host",
			};
		}
		const anyConsumer = sub.consumers.comments || sub.consumers.mergeCompletion;
		if (!anyConsumer) {
			return { subscription: sub, binding, mode: "stopped", stopReason: "no_enabled_consumers", blocker: null };
		}
		if (sub.column !== "in_progress" && sub.column !== "review") {
			return { subscription: sub, binding, mode: "stopped", stopReason: "inactive_task", blocker: null };
		}
		const terminalStop = binding?.terminalStop ?? null;
		if (terminalStop && terminalStop.reason !== "merged_reconciling") {
			// Terminal observation: no rearm until an explicit resume confirms
			// an open/draft PR with a fresh authoritative read.
			return { subscription: sub, binding, mode: "stopped", stopReason: terminalStop.reason, blocker: null };
		}
		if (terminalStop?.reason === "merged_reconciling") {
			if (prState === "merged") {
				if (sub.consumers.mergeCompletion) {
					return {
						subscription: sub,
						binding,
						mode: "reconcile",
						stopReason: "merged_reconciling",
						blocker: null,
					};
				}
				return { subscription: sub, binding, mode: "stopped", stopReason: "no_enabled_consumers", blocker: null };
			}
			if (prState === "closed") {
				return { subscription: sub, binding, mode: "stopped", stopReason: "closed_unmerged", blocker: null };
			}
		}
		if (prState === null || prState === "open" || prState === "draft") {
			return { subscription: sub, binding, mode: "poll", stopReason: null, blocker: null };
		}
		if (prState === "merged") {
			if (sub.consumers.mergeCompletion && binding?.mergeCompletion?.status !== "completed") {
				return { subscription: sub, binding, mode: "reconcile", stopReason: null, blocker: null };
			}
			return {
				subscription: sub,
				binding,
				mode: "stopped",
				stopReason: sub.consumers.mergeCompletion ? "merged_completed" : "no_enabled_consumers",
				blocker: null,
			};
		}
		return { subscription: sub, binding, mode: "stopped", stopReason: "closed_unmerged", blocker: null };
	}

	/** Arm the next poll for one (PR, scope), honoring backoff and rate limits. */
	private scheduleNext(state: PrPollState): void {
		if (this.stopping) {
			return;
		}
		const now = this.now();
		const jitter = this.random() * PR_POLL_JITTER_MAX_MS;
		const base = backoffBaseMs(state.consecutiveFailures);
		const due = now + base + jitter;
		const rateDeadline = state.rateLimitDeadline ?? 0;
		const nextPollAt = Math.max(due, rateDeadline);
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = null;
		}
		state.nextPollAt = nextPollAt;
		state.timer = setTimeout(
			() => {
				state.timer = null;
				void this.runPoll(state.prKey, state.accessScopeId);
			},
			Math.max(0, nextPollAt - now),
		);
		state.timer.unref?.();
	}

	private demandModeOf(verdicts: SubscriptionVerdict[]): PrDemandMode {
		let mode: PrDemandMode = "none";
		for (const verdict of verdicts) {
			if (verdict.mode === "poll") {
				return "poll";
			}
			if (verdict.mode === "reconcile") {
				mode = "reconcile";
			}
		}
		return mode;
	}

	/**
	 * Run one poll cycle for a (PR, scope). Explicit refreshes coalesce onto
	 * the same in-flight cycle.
	 */
	private async runPoll(prKey: string, accessScopeId: string): Promise<void> {
		const state = this.polls.get(this.pollKey(prKey, accessScopeId));
		if (!state || this.stopping) {
			return;
		}
		if (state.pollInFlight) {
			await state.pollInFlight;
			return;
		}
		const job = this.performPollCycle(state);
		state.pollInFlight = job;
		try {
			await job;
		} finally {
			state.pollInFlight = null;
		}
	}

	private async performPollCycle(state: PrPollState): Promise<void> {
		const { prKey, accessScopeId } = state;
		const parsed = parseCanonicalPrKey(prKey);
		const scope = this.scopes.get(accessScopeId) ?? this.scopeCache;
		if (!parsed || !scope) {
			return;
		}
		// Re-evaluate before every read.
		const recordBefore = await this.store.loadRecord(prKey);
		if (!recordBefore.ok) {
			return;
		}
		const subsBefore = this.activeSubscriptionsFor(prKey, accessScopeId);
		const verdictsBefore = subsBefore.map((sub) =>
			this.evaluateSubscription(sub, recordBefore.record.taskBindings, state.metadata?.state ?? null),
		);
		if (this.demandModeOf(verdictsBefore) === "none") {
			this.clearTimer(state);
			return;
		}
		// Reconciliation budget: an exhausted episode reads no further.
		const reconcileVerdicts = verdictsBefore.filter((verdict) => verdict.mode === "reconcile");
		const episodeExhausted =
			reconcileVerdicts.length > 0 &&
			reconcileVerdicts.every((verdict) => {
				const reads =
					verdict.binding?.terminalStop?.reason === "merged_reconciling"
						? verdict.binding.terminalStop.reconciliationReads
						: 0;
				return reads >= PR_TERMINAL_RECONCILIATION_MAX_READS;
			});
		if (episodeExhausted && this.demandModeOf(verdictsBefore) === "reconcile") {
			for (const verdict of reconcileVerdicts) {
				await this.store.setTaskTerminalStop(
					prKey,
					{ workspaceId: verdict.subscription.workspaceId, taskId: verdict.subscription.taskId },
					{
						reason: "merged_unresolved",
						observedAt: this.now(),
						reconciliationReads: PR_TERMINAL_RECONCILIATION_MAX_READS,
					},
				);
			}
			this.clearTimer(state);
			await this.reevaluate(prKey, accessScopeId);
			return;
		}
		const metadataResult = await this.adapter.readPrMetadata(parsed, scope);
		if (metadataResult.kind === "failed") {
			this.handleFailure(state, metadataResult.failure);
			await this.reevaluate(prKey, accessScopeId);
			return;
		}
		const readCounted = true; // the request reached the adapter
		if (metadataResult.kind === "ok") {
			state.metadata = metadataResult.metadata;
			if (metadataResult.nodeId.length > 0) {
				state.nodeId = metadataResult.nodeId;
			}
			state.snapshotCheckedAt = metadataResult.metadata.checkedAt;
			await this.store.setMetadataSnapshot(prKey, metadataResult.metadata);
		}
		// "not_modified" keeps last metadata (snapshot retained).
		const prState = state.metadata?.state ?? null;

		const wantsFeedback = verdictsBefore.some((verdict) => verdict.subscription.consumers.comments);
		if (wantsFeedback && prState !== "merged" && prState !== "closed") {
			await this.readFeedback(state, parsed, scope);
		}

		// In-flight responses re-validate every consumer before applying
		// state or scheduling effects.
		const recordAfter = await this.store.loadRecord(prKey);
		if (!recordAfter.ok) {
			return;
		}
		for (const sub of this.activeSubscriptionsFor(prKey, accessScopeId)) {
			const binding =
				recordAfter.record.taskBindings.find(
					(item) => item.workspaceId === sub.workspaceId && item.taskId === sub.taskId,
				) ?? null;
			await this.applyPrStateEffects(sub, binding, prState, readCounted);
		}
		if (!this.stopping) {
			state.consecutiveFailures = 0;
		}
		await this.reevaluate(prKey, accessScopeId);
	}

	/**
	 * Read all feedback sources. A snapshot is published only after every
	 * source succeeds; any `not_modified` source retains the last published
	 * combined snapshot (no completeness regression); a failed source keeps
	 * last state and counts as a failure.
	 */
	private async readFeedback(state: PrPollState, parsed: ParsedCanonicalPrKey, scope: AccessScope): Promise<void> {
		const repo = parsed.repository;
		const number = parsed.number;
		const [reviews, conversation, inline, threads] = await Promise.all([
			this.adapter.readRestListSource(
				parsed,
				scope,
				"reviews",
				`repos/${repo}/pulls/${number}/reviews`,
				(items, login) => normalizeReviews(items, login),
			),
			this.adapter.readRestListSource(
				parsed,
				scope,
				"conversationComments",
				`repos/${repo}/issues/${number}/comments`,
				(items, login) => normalizeConversationComments(items, login),
			),
			this.adapter.readRestListSource(
				parsed,
				scope,
				"inlineComments",
				`repos/${repo}/pulls/${number}/comments`,
				(items, login) => normalizeInlineComments(items, login, state.threadState ?? new Map()),
			),
			state.nodeId
				? this.adapter.readReviewThreads(parsed, scope, state.nodeId)
				: Promise.resolve({
						kind: "failed" as const,
						failure: { category: "network" as const, message: "missing PR node id", at: this.now() },
					}),
		]);
		const failedSources: Array<GhAdapterFailure> = [];
		for (const result of [reviews, conversation, inline, threads]) {
			if (result.kind === "failed") {
				failedSources.push(result.failure);
			}
		}
		if (failedSources.length > 0) {
			for (const failure of failedSources) {
				this.handleFailure(state, failure);
			}
			return;
		}
		const notModified = [reviews, conversation, inline, threads].some((result) => result.kind === "not_modified");
		if (notModified) {
			// Retain last published snapshot; completeness is unchanged.
			return;
		}
		if (threads.kind === "ok_threads") {
			state.threadState = threads.threads;
		}
		const inlineEvents = inline.kind === "ok" ? inline.events : [];
		state.feedback = [
			...(reviews.kind === "ok" ? reviews.events : []),
			...(conversation.kind === "ok" ? conversation.events : []),
			...normalizeInlineComments(inlineEvents, scope.login, state.threadState ?? new Map<string, PrThreadInfo>()),
		];
		state.feedbackCompleteness = {
			reviews: true,
			conversationComments: true,
			inlineComments: true,
			threads: threads.kind === "ok_threads",
		};
	}

	/**
	 * Apply authoritative PR-state transitions to a task binding's terminal
	 * stop marker. Terminal stops persist; a fresh open/draft read clears
	 * them; merged/closed observations are written exactly once per reason.
	 */
	private async applyPrStateEffects(
		sub: TrackedSubscription,
		binding: GitHubPrTaskBinding | null,
		prState: GitHubPrMetadataSnapshot["state"] | null,
		readCounted: boolean,
	): Promise<void> {
		if (!binding || prState === null) {
			return;
		}
		const bindingId = { workspaceId: sub.workspaceId, taskId: sub.taskId };
		const existing = binding.terminalStop;
		if (prState === "open" || prState === "draft") {
			if (existing !== null) {
				await this.store.setTaskTerminalStop(sub.canonicalPrKey, bindingId, null);
			}
			return;
		}
		if (prState === "closed") {
			if (existing?.reason !== "closed_unmerged") {
				await this.store.setTaskTerminalStop(sub.canonicalPrKey, bindingId, {
					reason: "closed_unmerged",
					observedAt: this.now(),
					reconciliationReads: 0,
				});
			}
			return;
		}
		// prState === "merged"
		if (!sub.consumers.mergeCompletion) {
			if (existing?.reason !== "no_enabled_consumers") {
				await this.store.setTaskTerminalStop(sub.canonicalPrKey, bindingId, {
					reason: "no_enabled_consumers",
					observedAt: this.now(),
					reconciliationReads: 0,
				});
			}
			return;
		}
		if (binding.mergeCompletion?.status === "completed") {
			if (existing?.reason !== "merged_completed") {
				await this.store.setTaskTerminalStop(sub.canonicalPrKey, bindingId, {
					reason: "merged_completed",
					observedAt: this.now(),
					reconciliationReads: existing?.reconciliationReads ?? 0,
				});
			}
			return;
		}
		const priorReads = existing?.reason === "merged_reconciling" ? existing.reconciliationReads : 0;
		if (existing?.reason === "merged_unresolved" || priorReads >= PR_TERMINAL_RECONCILIATION_MAX_READS) {
			return; // terminal/needs human; no rearm
		}
		const nextReads = readCounted ? priorReads + 1 : priorReads;
		if (existing?.reason === "merged_reconciling" && existing.reconciliationReads === nextReads) {
			return; // no change
		}
		await this.store.setTaskTerminalStop(sub.canonicalPrKey, bindingId, {
			reason: "merged_reconciling",
			observedAt: this.now(),
			reconciliationReads: nextReads,
		});
	}

	/** Classify a read failure: auth stops everything; others back off. */
	private handleFailure(state: PrPollState, failure: GhAdapterFailure): void {
		if (failure.category === "auth") {
			this.authBlocker = failure.message;
			this.warn(`PR tracking auth blocker: ${failure.message}`);
			this.cancelAllPolls();
			return;
		}
		state.consecutiveFailures += 1;
		if (failure.category === "rate_limit") {
			const deadline = failure.rateLimitResetAt ?? this.now() + 900_000;
			state.rateLimitDeadline = Math.max(state.rateLimitDeadline ?? 0, deadline);
		}
	}

	/**
	 * Explicit refresh: joins the in-flight read when one is running,
	 * otherwise performs one cycle. Source completion is only published after
	 * all pages succeed. Never re-arms a stopped terminal subscription.
	 */
	async refresh(prKey: string, accessScopeId: string): Promise<void> {
		const state = this.polls.get(this.pollKey(prKey, accessScopeId));
		if (!state) {
			return;
		}
		if (state.pollInFlight) {
			await state.pollInFlight;
			return;
		}
		if (this.stopping) {
			return;
		}
		const job = this.performPollCycle(state);
		state.pollInFlight = job;
		try {
			await job;
		} finally {
			state.pollInFlight = null;
		}
	}

	/**
	 * Explicit resume: one fresh authoritative read. Polling resumes only if
	 * the read confirms open/draft and eligibility still holds.
	 */
	async resumePrTracking(
		workspaceId: string,
		taskId: string,
	): Promise<{ ok: true; resumed: boolean } | { ok: false; reason: string }> {
		const sub = this.subscriptions.get(this.subscriptionKey(workspaceId, taskId));
		if (!sub) {
			return { ok: false, reason: "no_subscription" };
		}
		if (sub.blocker === "unsupported_host") {
			return { ok: false, reason: "unsupported_host" };
		}
		// Auth may have recovered since the last failure.
		this.scopeFailure = null;
		const scopeResult = await this.ensureScope(sub.accessScopeId === "unresolved" ? undefined : sub.accessScopeId);
		if (!scopeResult.ok) {
			return { ok: false, reason: scopeResult.blocker };
		}
		const parsed = parseCanonicalPrKey(sub.canonicalPrKey);
		const record = await this.store.loadRecord(sub.canonicalPrKey);
		if (!parsed || !record.ok) {
			return { ok: false, reason: "record" };
		}
		const binding =
			record.record.taskBindings.find((item) => item.workspaceId === workspaceId && item.taskId === taskId) ?? null;
		if (!binding) {
			return { ok: false, reason: "no_binding" };
		}
		const state = this.getPollState(sub.canonicalPrKey, sub.accessScopeId);
		const scope = this.scopes.get(sub.accessScopeId) ?? scopeResult.scope;
		const result = await this.adapter.readPrMetadata(parsed, scope, { fresh: true });
		if (result.kind === "failed") {
			return { ok: false, reason: result.failure.category };
		}
		if (result.kind === "not_modified") {
			return { ok: false, reason: "not_modified" };
		}
		state.metadata = result.metadata;
		if (result.nodeId.length > 0) {
			state.nodeId = result.nodeId;
		}
		await this.store.setMetadataSnapshot(sub.canonicalPrKey, result.metadata);
		if (result.metadata.state !== "open" && result.metadata.state !== "draft") {
			return { ok: false, reason: "still_terminal" };
		}
		const verdict = this.evaluateSubscription(sub, record.record.taskBindings, result.metadata.state);
		if (verdict.mode !== "poll") {
			return { ok: false, reason: "ineligible" };
		}
		await this.store.setTaskTerminalStop(sub.canonicalPrKey, { workspaceId, taskId }, null);
		await this.reevaluate(sub.canonicalPrKey, sub.accessScopeId);
		return { ok: true, resumed: true };
	}

	/**
	 * Inspect-only snapshot access for a task's subscription. Returns last
	 * state with a freshness label; never triggers reads here.
	 */
	getSnapshotsForTask(
		workspaceId: string,
		taskId: string,
	): {
		metadata: GitHubPrMetadataSnapshot | null;
		feedback: GitHubPrNormalizedFeedbackEvent[] | null;
		feedbackCompleteness: GitHubPrFeedbackCompleteness | null;
		checkedAt: number | null;
		isStale: boolean;
	} | null {
		const sub = this.subscriptions.get(this.subscriptionKey(workspaceId, taskId));
		if (!sub) {
			return null;
		}
		const state = this.polls.get(this.pollKey(sub.canonicalPrKey, sub.accessScopeId));
		const checkedAt = state?.snapshotCheckedAt ?? null;
		return {
			metadata: state?.metadata ?? null,
			feedback: state?.feedback ?? null,
			feedbackCompleteness: state?.feedbackCompleteness ?? null,
			checkedAt,
			isStale: checkedAt === null || isPrSnapshotStale(checkedAt, this.now()),
		};
	}

	getState(): CoordinatorState {
		return {
			started: this.started,
			schedulerBlocked: this.schedulerBlocked,
			authBlocker: this.authBlocker,
			subscriptions: [...this.subscriptions.values()].map((sub) => ({
				workspaceId: sub.workspaceId,
				taskId: sub.taskId,
				canonicalPrKey: sub.canonicalPrKey,
				accessScopeId: sub.accessScopeId,
				active: sub.blocker === null,
				blocker: sub.blocker,
			})),
			polls: [...this.polls.values()].map((state) => ({
				prKey: state.prKey,
				accessScopeId: state.accessScopeId,
				nextPollAt: state.nextPollAt,
				consecutiveFailures: state.consecutiveFailures,
				rateLimitDeadline: state.rateLimitDeadline,
				metadataState: state.metadata?.state ?? null,
			})),
		};
	}
}

export function createPrTrackingCoordinator(deps: CreatePrTrackingCoordinatorDependencies = {}): PrTrackingCoordinator {
	return new PrTrackingCoordinator(deps);
}
