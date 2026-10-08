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
	GitHubPrNormalizedSnapshot,
	GitHubPrTaskBinding,
	GitHubPrTerminalStopReason,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimePrSnapshotEvent,
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
import { getPrTrackingSchedulerLockRequest, PrRecordStore, type PrRecordStorePort } from "./pr-record-store";
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

/** Per-source retained feedback state (transient, never persisted whole). */
interface PrFeedbackSourceState {
	reviews: GitHubPrNormalizedFeedbackEvent[] | null;
	conversation: GitHubPrNormalizedFeedbackEvent[] | null;
	inline: GitHubPrNormalizedFeedbackEvent[] | null;
	threads: Map<string, PrThreadInfo> | null;
}

type PrFeedbackSource = "reviews" | "conversationComments" | "inlineComments" | "threads";

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
	/**
	 * Combined feedback events published in the last COMPLETE read, with
	 * thread flags applied (transient). Retained while any feedback consumer
	 * exists; a source that reports not_modified contributes its retained
	 * events, so an unchanged conversation page never freezes a changed one.
	 */
	feedback: GitHubPrNormalizedFeedbackEvent[] | null;
	feedbackCompleteness: GitHubPrFeedbackCompleteness | null;
	snapshotCheckedAt: number | null;
	/** Per-source last successfully-read normalized events (retention). */
	sourceEvents: PrFeedbackSourceState;
	/**
	 * Sources that must be re-read freshly this cycle (a failed store write
	 * forces a fresh re-read so applied state never lags the recorded body
	 * digest).
	 */
	freshSources: Set<PrFeedbackSource>;
	/**
	 * Access blocker for THIS (PR, scope) only: the resolved identity exists
	 * but cannot see this data (e.g. HTTP 403 permission denied on one
	 * repository). Access is a per-repository condition, so only this poll
	 * is cancelled; an explicit refresh re-probes the API (a permission
	 * change does not require a new auth context).
	 */
	accessBlocker: string | null;
	/** Metadata must be re-read freshly this cycle. */
	metadataNeedsFresh: boolean;
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
		accessBlocker: string | null;
	}>;
}

export interface CreatePrTrackingCoordinatorDependencies {
	adapter?: GitHubGhAdapter;
	/**
	 * The record storage backend (port). Production uses the disk
	 * `PrRecordStore`; tests inject an in-memory store.
	 */
	store?: PrRecordStorePort;
	schedulerLockRequest?: LockRequest;
	listManagedWorkspaceBoards?: () => Promise<Array<{ workspaceId: string; board: RuntimeBoardData }>>;
	/**
	 * Poll-time backstop: re-derive task-derived subscription demand from the
	 * live board view before each poll cycle, so a board change that bypassed
	 * the mutation triggers still drops/updates demand here. Best-effort.
	 * Called with the canonical PR key being polled so the implementation can
	 * revalidate only that PR's subscriptions (cheap single-board reads)
	 * instead of enumerating every workspace.
	 */
	revalidateSubscriptions?: (canonicalPrKey?: string) => Promise<void>;
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
	private readonly store: PrRecordStorePort;
	private readonly schedulerLockRequest: LockRequest;
	private readonly listBoards: () => Promise<Array<{ workspaceId: string; board: RuntimeBoardData }>>;
	private readonly warn: (message: string) => void;
	private readonly logError: (message: string) => void;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly revalidateSubscriptions: ((canonicalPrKey?: string) => Promise<void>) | null;

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
	private orphanPassStarted = false;
	/**
	 * PRTRACK-1: transient per-subscription snapshot/terminal event logs
	 * (hints). Durable replay cursors persist per consumer kind on the task
	 * binding; these logs only replay within a session.
	 */
	private readonly snapshotEvents = new Map<string, RuntimePrSnapshotEvent[]>();
	private readonly snapshotSeq = new Map<string, number>();
	private static readonly SNAPSHOT_EVENT_LIMIT = 1000;

	constructor(deps: CreatePrTrackingCoordinatorDependencies = {}) {
		this.adapter = deps.adapter ?? createGitHubGhAdapter();
		this.store = deps.store ?? new PrRecordStore();
		this.schedulerLockRequest = deps.schedulerLockRequest ?? getPrTrackingSchedulerLockRequest();
		this.listBoards =
			deps.listManagedWorkspaceBoards ??
			(async () => {
				const entries = await listWorkspaceIndexEntries();
				const boards: Array<{ workspaceId: string; board: RuntimeBoardData }> = [];
				// A board read failure propagates: orphan classification and
				// unlinked checks must never run on a silently partial board
				// view (a missing card would wrongly orphan a live PR).
				for (const entry of entries) {
					boards.push({
						workspaceId: entry.workspaceId,
						board: await loadWorkspaceBoardById(entry.workspaceId),
					});
				}
				return boards;
			});
		this.warn = deps.warn ?? (() => {});
		this.logError = deps.logError ?? (() => {});
		this.now = deps.now ?? Date.now;
		this.random = deps.random ?? Math.random;
		this.revalidateSubscriptions = deps.revalidateSubscriptions ?? null;
	}

	/**
	 * Start the coordinator. Never blocks or fails runtime startup and
	 * acquires no lock: the scheduler lock is acquired lazily on the first
	 * eligible subscription, and the orphan pass runs once after that first
	 * successful acquisition.
	 */
	async start(): Promise<void> {
		this.started = true;
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

	// --- PRTRACK-1: snapshot events, subscriptions, and authorized reads ---

	/**
	 * Read-only view of the current subscriptions (task-derived demand),
	 * including consumer flags, for reconciliation and diagnostics.
	 */
	listSubscriptions(): Array<{
		workspaceId: string;
		taskId: string;
		accessScopeId: string;
		canonicalPrKey: string;
		column: RuntimeBoardColumnId;
		consumers: Record<PrTrackingConsumerKind, boolean>;
		blocker: string | null;
	}> {
		return [...this.subscriptions.values()].map((sub) => ({
			workspaceId: sub.workspaceId,
			taskId: sub.taskId,
			canonicalPrKey: sub.canonicalPrKey,
			accessScopeId: sub.accessScopeId,
			column: sub.column,
			consumers: { ...sub.consumers },
			blocker: sub.blocker,
		}));
	}

	/**
	 * Seed the in-memory event sequence from the binding's durable replay
	 * cursors so a fresh session resumes above the last consumed seq
	 * (already-replayed hints below the persisted cursor are never re-emitted).
	 */
	private async seedSnapshotSeq(descriptor: PrTrackingSubscriptionDescriptor): Promise<void> {
		const key = this.subscriptionKey(descriptor.workspaceId, descriptor.taskId);
		if (this.snapshotSeq.has(key)) {
			return;
		}
		const loaded = await this.store.loadRecord(descriptor.canonicalPrKey);
		if (!loaded.ok) {
			return;
		}
		const binding = loaded.record.taskBindings.find(
			(item) => item.workspaceId === descriptor.workspaceId && item.taskId === descriptor.taskId,
		);
		if (!binding) {
			return;
		}
		const persisted = [binding.replayCursors.comments, binding.replayCursors.mergeCompletion].filter(
			(cursor): cursor is number => typeof cursor === "number",
		);
		if (persisted.length > 0) {
			this.snapshotSeq.set(key, Math.max(...persisted));
		}
	}

	private emitSnapshotEvent(sub: TrackedSubscription, event: Omit<RuntimePrSnapshotEvent, "seq">): void {
		const key = this.subscriptionKey(sub.workspaceId, sub.taskId);
		const seq = (this.snapshotSeq.get(key) ?? 0) + 1;
		this.snapshotSeq.set(key, seq);
		const log = this.snapshotEvents.get(key) ?? [];
		log.push({ ...event, seq });
		while (log.length > PrTrackingCoordinator.SNAPSHOT_EVENT_LIMIT) {
			log.shift();
		}
		this.snapshotEvents.set(key, log);
	}

	/**
	 * Authorized, versioned snapshot read for one subscribed task. The data
	 * comes from the coordinator's in-memory poll state (the same read every
	 * consumer sees); `isStale` reports whether a fresh read is pending.
	 */
	getTaskAuthorizedSnapshot(
		workspaceId: string,
		taskId: string,
	): {
		version: number | null;
		snapshot: GitHubPrNormalizedSnapshot | null;
		checkedAt: number | null;
		isStale: boolean;
	} {
		const sub = this.subscriptions.get(this.subscriptionKey(workspaceId, taskId));
		if (!sub) {
			return { version: null, snapshot: null, checkedAt: null, isStale: true };
		}
		const state = this.polls.get(this.pollKey(sub.canonicalPrKey, sub.accessScopeId));
		if (!state || !state.metadata) {
			return { version: null, snapshot: null, checkedAt: null, isStale: true };
		}
		const snapshot: GitHubPrNormalizedSnapshot = {
			canonicalPrKey: sub.canonicalPrKey,
			accessScopeId: sub.accessScopeId,
			checkedAt: state.snapshotCheckedAt ?? state.metadata.checkedAt,
			metadata: state.metadata,
			feedback: state.feedback,
			feedbackCompleteness: state.feedbackCompleteness,
		};
		return {
			version: state.snapshotCheckedAt,
			snapshot,
			checkedAt: state.snapshotCheckedAt,
			isStale: state.snapshotCheckedAt === null || isPrSnapshotStale(state.snapshotCheckedAt, this.now()),
		};
	}

	/**
	 * Versioned subscription: replay events with seq > fromCursor and advance
	 * the durable per-consumer replay cursor on the task binding. Events are
	 * HINTS — consumers must reconcile authoritative state on startup and
	 * after any hint. An omitted fromCursor resumes from the binding's
	 * persisted cursor for this consumer (never restarts at 0).
	 */
	async readTaskSnapshotEvents(
		workspaceId: string,
		taskId: string,
		consumer: "comments" | "mergeCompletion",
		fromCursor?: number,
	): Promise<{ events: RuntimePrSnapshotEvent[]; nextCursor: number }> {
		const sub = this.subscriptions.get(this.subscriptionKey(workspaceId, taskId));
		if (!sub) {
			return { events: [], nextCursor: fromCursor ?? 0 };
		}
		const key = this.subscriptionKey(workspaceId, taskId);
		let cursor = fromCursor;
		if (typeof cursor !== "number") {
			// Resume from the durable per-consumer cursor persisted on the
			// binding: a fresh session never replays already-consumed hints.
			const loaded = await this.store.loadRecord(sub.canonicalPrKey);
			const persisted = loaded.ok
				? loaded.record.taskBindings.find((item) => item.workspaceId === workspaceId && item.taskId === taskId)
						?.replayCursors[consumer]
				: undefined;
			cursor = typeof persisted === "number" ? persisted : 0;
		}
		const log = this.snapshotEvents.get(key) ?? [];
		const events = log.filter((event) => event.seq > cursor).map((event) => ({ ...event }));
		const nextCursor = events.length > 0 ? events[events.length - 1].seq : cursor;
		if (nextCursor > cursor) {
			// Best-effort durable cursor: a failed write only means the same
			// hints replay again next session (authoritative reconciliation
			// on startup is the safety net).
			await this.store
				.updateTaskBinding(sub.canonicalPrKey, { workspaceId, taskId }, undefined, (item) => ({
					...item,
					replayCursors: {
						...item.replayCursors,
						[consumer]: nextCursor,
					},
				}))
				.then((result) => {
					if (!result.ok) {
						this.warn(`PR tracking replay cursor update failed (${result.reason})`);
					}
				})
				.catch((error: unknown) => {
					this.warn(`PR tracking replay cursor update failed: ${String(error)}`);
				});
		}
		return { events, nextCursor };
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
				sourceEvents: { reviews: null, conversation: null, inline: null, threads: null },
				freshSources: new Set(),
				accessBlocker: null,
				metadataNeedsFresh: false,
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
		forceFresh = false,
	): Promise<{ ok: true; scope: AccessScope } | { ok: false; blocker: "auth" | "scope" }> {
		if (!forceFresh) {
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
		} else {
			// Explicit re-probe: a re-login, token rotation, or `gh auth
			// switch` since the last failure/resolution must be detected.
			this.scopeFailure = null;
		}
		const resolved = await this.adapter.resolveAccessScope();
		if (!resolved.ok) {
			this.scopeFailure = resolved.failure;
			this.authBlocker = resolved.failure.message;
			this.warn(`PR tracking auth blocker: ${resolved.failure.message}`);
			this.cancelAllPolls();
			return { ok: false, blocker: "auth" };
		}
		const previousScope = this.scopeCache;
		this.scopeCache = resolved.scope;
		this.scopes.set(resolved.scope.accessScopeId, resolved.scope);
		this.applyScopeChange(resolved.scope, previousScope);
		if (requestedScopeId && requestedScopeId !== resolved.scope.accessScopeId) {
			return { ok: false, blocker: "scope" };
		}
		return { ok: true, scope: resolved.scope };
	}

	/**
	 * A newly resolved identity invalidates prior snapshots: drop transient
	 * poll state for any other scope (metadata, feedback, thread state) so
	 * data is never shown for the wrong account, clear auth/access blockers
	 * (the identity resolved successfully), and re-key every tracked
	 * subscription to the resolved scope (the runtime follows its active
	 * credential; old-scope subscriptions must not be stranded).
	 */
	private applyScopeChange(scope: AccessScope, previousScope: AccessScope | null): void {
		this.authBlocker = null;
		for (const state of this.polls.values()) {
			state.accessBlocker = null;
		}
		if (!previousScope || previousScope.accessScopeId === scope.accessScopeId) {
			for (const sub of this.subscriptions.values()) {
				if (sub.accessScopeId !== scope.accessScopeId) {
					sub.accessScopeId = scope.accessScopeId;
				}
			}
			return;
		}
		for (const [key, state] of this.polls) {
			if (state.accessScopeId === scope.accessScopeId) {
				continue;
			}
			this.clearTimer(state);
			this.polls.delete(key);
		}
		for (const sub of this.subscriptions.values()) {
			if (sub.accessScopeId !== scope.accessScopeId) {
				sub.accessScopeId = scope.accessScopeId;
			}
		}
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
				onCompromised: () => {
					// Proper-lockfile detected a stale/reacquired lock: this
					// runtime can no longer be the sole scheduler.
					this.schedulerBlocked = true;
					this.schedulerLockRelease = null;
					this.logError(
						"[pr-tracking] scheduler lock was compromised (another process took it over); " +
							"PR tracking scheduling is disabled in this runtime until restart.",
					);
					this.cancelAllPolls();
				},
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
		// Acquire the scheduler lock BEFORE the binding write: a second
		// process must never persist record state while blocked.
		if (this.schedulerBlocked) {
			return this.blockedSubscription(descriptor, scope, "scheduler");
		}
		await this.ensureSchedulerLock();
		if (this.schedulerBlocked) {
			return this.blockedSubscription(descriptor, scope, "scheduler");
		}
		const bindingResult = await this.store.upsertTaskBinding(descriptor.canonicalPrKey, {
			workspaceId: descriptor.workspaceId,
			taskId: descriptor.taskId,
		});
		if (!bindingResult.ok) {
			return this.blockedSubscription(descriptor, scope, "record_malformed");
		}
		await this.seedSnapshotSeq(descriptor);
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
		// The orphan pass runs ONCE per runtime, right after the first
		// successful lazy scheduler-lock acquisition (the lock is already
		// held, so ensureSchedulerLock inside is a no-op).
		if (!this.orphanPassStarted) {
			this.orphanPassStarted = true;
			void this.runOrphanClassificationPass().catch((error: unknown) => {
				this.warn(`PR tracking orphan pass failed: ${String(error)}`);
			});
		}
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
	 * transient feedback snapshot is dropped immediately (no GitHub call),
	 * and the next re-subscribe forces FRESH reads for all sources: the
	 * adapter's body-digest cache outlives the dropped retained events, so
	 * without a fresh flag every source would report not_modified forever
	 * and feedback could never repopulate. The record is also marked
	 * orphaned if no live card still links the PR.
	 */
	async removeSubscription(workspaceId: string, taskId: string): Promise<void> {
		const sub = this.subscriptions.get(this.subscriptionKey(workspaceId, taskId));
		if (!sub) {
			return;
		}
		this.subscriptions.delete(this.subscriptionKey(workspaceId, taskId));
		// The transient event log is per-task: with the last (only)
		// subscription gone, nothing may replay from it.
		const subKey = this.subscriptionKey(workspaceId, taskId);
		this.snapshotEvents.delete(subKey);
		this.snapshotSeq.delete(subKey);
		if (this.subscriptionCountForPr(sub.canonicalPrKey) === 0) {
			for (const state of this.polls.values()) {
				if (state.prKey === sub.canonicalPrKey) {
					this.clearTimer(state);
					state.feedback = null;
					state.feedbackCompleteness = null;
					state.sourceEvents = { reviews: null, conversation: null, inline: null, threads: null };
					state.freshSources = new Set(["reviews", "conversationComments", "inlineComments", "threads"]);
				}
			}
			await this.markOrphanIfUnlinked(sub.canonicalPrKey);
		}
	}

	/**
	 * Collect canonical PR keys linked by ANY current card (active or
	 * history, any column) across currently managed workspaces. A read
	 * failure propagates (no silent empty set — orphan marking must never
	 * run on a partial board view).
	 */
	private async collectLinkedPrKeys(): Promise<Set<string>> {
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
		return linkedKeys;
	}

	/**
	 * Orphan classification: join managed cards (any column) with PR records
	 * and start/clear the 24-hour retention clock. Runs once per runtime
	 * after the first successful lazy scheduler-lock acquisition. Never
	 * schedules work and never enumerates PR records to discover tasks.
	 */
	private async runOrphanClassificationPass(): Promise<void> {
		// Shared-record mutations require the scheduler lock: a second
		// process must never mark or delete orphan records.
		await this.ensureSchedulerLock();
		if (this.schedulerBlocked) {
			return;
		}
		const linkedKeys = await this.collectLinkedPrKeys();
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
		// Shared-record mutation: skip entirely while scheduler-blocked.
		if (this.schedulerBlocked) {
			return;
		}
		await this.ensureSchedulerLock();
		if (this.schedulerBlocked) {
			return;
		}
		const linkedKeys = await this.collectLinkedPrKeys();
		if (linkedKeys.has(canonicalPrKey)) {
			return;
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
		if (subs.length === 0 || this.authBlocker !== null || state.accessBlocker !== null || this.schedulerBlocked) {
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
	 * Re-evaluate every tracked (PR, scope). Called whenever a GLOBAL blocker
	 * (auth) clears so the polls that were cancelled by it re-arm.
	 */
	private async reevaluateAll(): Promise<void> {
		const keys = [...this.polls.keys()];
		for (const key of keys) {
			const state = this.polls.get(key);
			if (state) {
				await this.reevaluate(state.prKey, state.accessScopeId);
			}
		}
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
		// Poll-time backstop: re-derive task-derived demand from the live board
		// view so eligibility is re-read before every poll (a board change that
		// bypassed the mutation triggers is picked up here). Best-effort: a
		// revalidation failure never cancels this read.
		if (this.revalidateSubscriptions) {
			try {
				await this.revalidateSubscriptions(state.prKey);
			} catch (error: unknown) {
				this.warn(`PR tracking revalidation failed: ${String(error)}`);
			}
		}
		const { prKey, accessScopeId } = state;
		const parsed = parseCanonicalPrKey(prKey);
		// Use the requested scope exactly; never fall back to the cached
		// (possibly different-account) scope.
		const scope =
			this.scopes.get(accessScopeId) ?? (this.scopeCache?.accessScopeId === accessScopeId ? this.scopeCache : null);
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
		const metadataResult = await this.adapter.readPrMetadata(parsed, scope, {
			fresh: state.metadataNeedsFresh,
		});
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
			const snapshotWrite = await this.store.setMetadataSnapshot(prKey, metadataResult.metadata);
			if (!snapshotWrite.ok) {
				// Persisted state lagged the last read: force a fresh re-read
				// next cycle so applied state catches the recorded body digest.
				state.metadataNeedsFresh = true;
				this.warn(`PR tracking metadata snapshot write failed (${snapshotWrite.reason}); forcing fresh re-read`);
			} else {
				state.metadataNeedsFresh = false;
			}
		} else {
			// "not_modified": GitHub confirmed the metadata is unchanged, so
			// freshness advances even though no new body was read — a
			// healthy PR must not read as stale in its steady state (almost
			// every poll is not_modified).
			const checkedAt = this.now();
			state.snapshotCheckedAt = checkedAt;
			if (state.metadata) {
				const updated = await this.store.setMetadataSnapshot(prKey, {
					...state.metadata,
					checkedAt,
				});
				if (!updated.ok) {
					state.metadataNeedsFresh = true;
				}
			}
		}
		const prState = state.metadata?.state ?? null;

		const wantsFeedback = verdictsBefore.some((verdict) => verdict.subscription.consumers.comments);
		let feedbackOk = true;
		if (wantsFeedback && prState !== "merged" && prState !== "closed") {
			feedbackOk = await this.readFeedback(state, parsed, scope);
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
			// PRTRACK-1: publish a snapshot hint for every active subscriber.
			this.emitSnapshotEvent(sub, {
				kind: "snapshot",
				version: recordAfter.record.revision,
				checkedAt: state.snapshotCheckedAt,
				prState,
				terminalReason: null,
			});
		}
		if (!this.stopping && feedbackOk) {
			state.consecutiveFailures = 0;
			// A successful authoritative read proves the current credential
			// works: a sticky auth blocker must clear without a restart.
			const authWasBlocked = this.authBlocker !== null;
			this.authBlocker = null;
			// And this (PR, scope) is accessible: clear its per-poll blocker.
			state.accessBlocker = null;
			if (authWasBlocked) {
				// The global blocker cleared: re-arm every poll it cancelled.
				await this.reevaluateAll();
			}
		}
		await this.reevaluate(prKey, accessScopeId);
	}

	/**
	 * Read all feedback sources with PER-SOURCE retention: a source that
	 * reports `not_modified` contributes its last successfully-read events, so
	 * an unchanged page never freezes a changed one; thread flags apply to
	 * the inline events at publish time (transient, never persisted). A
	 * source that fails keeps last state and counts as a cycle failure.
	 */
	private async readFeedback(state: PrPollState, parsed: ParsedCanonicalPrKey, scope: AccessScope): Promise<boolean> {
		const repo = parsed.repository;
		const number = parsed.number;
		const [reviews, conversation, inline, threads] = await Promise.all([
			this.adapter.readRestListSource(
				parsed,
				scope,
				"reviews",
				`repos/${repo}/pulls/${number}/reviews`,
				(items, login) => normalizeReviews(items, login),
				{ fresh: state.freshSources.has("reviews") },
			),
			this.adapter.readRestListSource(
				parsed,
				scope,
				"conversationComments",
				`repos/${repo}/issues/${number}/comments`,
				(items, login) => normalizeConversationComments(items, login),
				{ fresh: state.freshSources.has("conversationComments") },
			),
			this.adapter.readRestListSource(
				parsed,
				scope,
				"inlineComments",
				`repos/${repo}/pulls/${number}/comments`,
				(items, login) => normalizeInlineComments(items, login, state.sourceEvents.threads ?? new Map()),
				{ fresh: state.freshSources.has("inlineComments") },
			),
			state.nodeId
				? this.adapter.readReviewThreads(parsed, scope, state.nodeId, {
						fresh: state.freshSources.has("threads"),
					})
				: Promise.resolve({
						kind: "failed" as const,
						failure: { category: "network" as const, message: "missing PR node id", at: this.now() },
					}),
		]);
		// Persist each source's events as soon as THAT source returns ok —
		// before the failed-source check — so a source that changed is never
		// lost because a different source failed in the same cycle (the
		// adapter already recorded the new body digest for it; without the
		// stored events the next cycle would report not_modified against the
		// stale retention and drop the change permanently). Only the PUBLISH
		// is withheld when any source fails.
		if (reviews.kind === "ok") {
			state.sourceEvents.reviews = reviews.events;
		}
		if (conversation.kind === "ok") {
			state.sourceEvents.conversation = conversation.events;
		}
		if (inline.kind === "ok") {
			state.sourceEvents.inline = inline.events;
		}
		if (threads.kind === "ok_threads") {
			state.sourceEvents.threads = threads.threads;
		}
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
			return false;
		}
		// Latest known thread state: fresh read wins, else the retained map.
		const threadState = threads.kind === "ok_threads" ? threads.threads : state.sourceEvents.threads;
		// Per-source retained events; `not_modified` falls back to the last
		// successfully-read events for that source.
		const reviewsEvents = reviews.kind === "ok" ? reviews.events : state.sourceEvents.reviews;
		const conversationEvents = conversation.kind === "ok" ? conversation.events : state.sourceEvents.conversation;
		const inlineEvents = inline.kind === "ok" ? inline.events : state.sourceEvents.inline;
		// Publish only when every source has events (freshly read or
		// retained from a prior complete read); thread state must be known.
		if (reviewsEvents === null || conversationEvents === null || inlineEvents === null || threadState === null) {
			return true;
		}
		state.feedback = [...reviewsEvents, ...conversationEvents, ...this.applyThreadFlags(inlineEvents, threadState)];
		state.feedbackCompleteness = {
			reviews: true,
			conversationComments: true,
			inlineComments: true,
			threads: true,
		};
		state.freshSources.clear();
		return true;
	}

	/**
	 * Apply the latest known thread resolution/outdated flags to inline
	 * comment events (in-memory only). Retained events already carry the
	 * flags from their publish time; fresh events may be corrected here when
	 * the threads source was fresher than the inline read. `threadDeleted`
	 * is always null: GitHub exposes no deleted-thread signal.
	 */
	private applyThreadFlags(
		events: GitHubPrNormalizedFeedbackEvent[],
		threads: Map<string, PrThreadInfo>,
	): GitHubPrNormalizedFeedbackEvent[] {
		return events.map((event) => {
			if (event.kind !== "inline_comment") {
				return event;
			}
			const info = threads.get(event.providerId);
			if (!info) {
				return event;
			}
			return {
				...event,
				threadResolved: info.resolved,
				threadDeleted: null,
				threadOutdated: info.outdated,
			};
		});
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
				this.emitTerminalInvalidation(sub, "closed_unmerged");
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
				this.emitTerminalInvalidation(sub, "no_enabled_consumers");
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
				this.emitTerminalInvalidation(sub, "merged_completed");
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
		this.emitTerminalInvalidation(sub, "merged_reconciling");
	}

	/** PRTRACK-1: publish a terminal-invalidation hint to the subscription. */
	private emitTerminalInvalidation(sub: TrackedSubscription, reason: GitHubPrTerminalStopReason): void {
		this.emitSnapshotEvent(sub, {
			kind: "terminal_invalidation",
			version: null,
			checkedAt: this.now(),
			prState: null,
			terminalReason: reason,
		});
	}

	/**
	 * Classify a read failure. `auth` is a runtime-wide condition (the
	 * credential is bad everywhere): it stops ALL polling. `access` is a
	 * per-(PR, scope) condition (e.g. 403 on one repository): only that poll
	 * stops, the others keep running. Other failures back off only this
	 * (PR, scope).
	 */
	private handleFailure(state: PrPollState, failure: GhAdapterFailure): void {
		if (failure.category === "auth") {
			this.authBlocker = failure.message;
			this.warn(`PR tracking auth blocker: ${failure.message}`);
			this.cancelAllPolls();
			return;
		}
		if (failure.category === "access") {
			state.accessBlocker = failure.message;
			this.warn(`PR tracking access blocker for ${state.prKey}: ${failure.message}`);
			this.clearTimer(state);
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
	 * An explicit refresh re-probes the API when an access/auth blocker is
	 * set (permission changes do not require a new auth context).
	 */
	async refresh(prKey: string, accessScopeId: string): Promise<{ coalesced: boolean }> {
		const state = this.polls.get(this.pollKey(prKey, accessScopeId));
		if (!state) {
			return { coalesced: false };
		}
		if (state.pollInFlight) {
			// Joined an identical in-flight read: no duplicate request.
			await state.pollInFlight;
			return { coalesced: true };
		}
		if (this.stopping) {
			return { coalesced: false };
		}
		// Re-probe: a prior access/auth blocker must not suppress an
		// explicit refresh. Clearing scopeFailure lets ensureScope re-resolve
		// the identity (a re-login or `gh auth switch` is now detected); a
		// successful resolution clears the auth blocker and, when the
		// credential identity changed, invalidates the old scope's state.
		const wasBlocked = this.authBlocker !== null || state.accessBlocker !== null;
		state.accessBlocker = null;
		this.authBlocker = null;
		const scopeResult = await this.ensureScope(accessScopeId !== "unresolved" ? accessScopeId : undefined, true);
		if (!scopeResult.ok) {
			// The re-probe failed: the blocker is re-set by ensureScope and
			// polling stays cancelled until the next explicit refresh/resume.
			return { coalesced: false };
		}
		if (wasBlocked && this.authBlocker === null) {
			// A blocker cleared: re-arm the polls it cancelled, not just the
			// one being refreshed.
			await this.reevaluateAll();
		}
		if (state.pollInFlight) {
			// Another refresh started its cycle while we re-probed: coalesce.
			await state.pollInFlight;
			return { coalesced: true };
		}
		const job = this.performPollCycle(state);
		state.pollInFlight = job;
		try {
			await job;
		} finally {
			state.pollInFlight = null;
		}
		return { coalesced: false };
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
		// Auth may have recovered since the last failure; force a fresh
		// identity probe so re-login / account switches are detected.
		const priorState = this.polls.get(this.pollKey(sub.canonicalPrKey, sub.accessScopeId));
		const wasBlocked = this.authBlocker !== null || priorState?.accessBlocker !== null;
		const scopeResult = await this.ensureScope(
			sub.accessScopeId === "unresolved" ? undefined : sub.accessScopeId,
			true,
		);
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
		// A successful fresh authoritative read proves this (PR, scope) is
		// accessible: clear the per-poll access blocker.
		state.accessBlocker = null;
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
		if (wasBlocked && this.authBlocker === null) {
			// A blocker cleared: re-arm every poll it cancelled, not just the
			// one being resumed.
			await this.reevaluateAll();
		} else {
			await this.reevaluate(sub.canonicalPrKey, sub.accessScopeId);
		}
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
				accessBlocker: state.accessBlocker,
			})),
		};
	}
}

export function createPrTrackingCoordinator(deps: CreatePrTrackingCoordinatorDependencies = {}): PrTrackingCoordinator {
	return new PrTrackingCoordinator(deps);
}
