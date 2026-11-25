import {
	type ClineTurnScheduler,
	type ClineTurnTarget,
	sharedClineTurnScheduler,
} from "../cline-sdk/cline-turn-scheduler";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TerminalSessionManager } from "./session-manager";

/**
 * What one Pi turn request ended up doing.
 *
 * - `launched`: the work this request owns is running now — the CLI is up for a
 *   start, or the input was written to the live session — and `summary`
 *   describes it.
 * - `queued`: the work waits for a model slot, so `summary` is the manager's
 *   waiting record and the work runs in the background when capacity frees.
 */
export type PiTurnAdmission =
	| { readonly status: "launched"; readonly summary: RuntimeTaskSessionSummary }
	| {
			readonly status: "queued";
			readonly summary: RuntimeTaskSessionSummary;
			readonly queuePosition: number | null;
	  };

/**
 * One Pi turn Kanban is asking the shared model queue to admit.
 *
 * `kind` decides only which record the manager keeps while the turn waits: an
 * initial start has no process yet, so it needs the idle process-less waiting
 * record; a follow-up turn runs on a live session, so its own summary is
 * annotated instead of being replaced.
 */
export interface PiTurnRequest {
	workspaceId: string;
	taskId: string;
	manager: TerminalSessionManager;
	target: ClineTurnTarget;
	kind: "start" | "turn";
	/**
	 * Runs the work and reports the summary it produced: spawn the CLI for a
	 * start, or write the input to the live session for a follow-up turn. The
	 * gate calls it once per admission, including from the background when the
	 * turn waited for a slot.
	 */
	run: () => Promise<RuntimeTaskSessionSummary>;
	/** The task worktree a queued CLI will run in. Starts only. */
	workspacePath?: string;
	/**
	 * A queued turn is checked against this again when its slot frees: a card
	 * returned to Backlog (or relaunched) while it waited must never launch, and
	 * an input that no longer describes current work must never be written.
	 */
	isCurrent?: () => boolean;
}

/** Which outcome the caller was told about, or null while it still awaits. */
type ReportedOutcome = "launched" | "queued" | "ended";

interface RunningPiTurn {
	owner: symbol;
	/** The owning workspace, so a bulk stop can drop only its own claims. */
	workspaceId: string;
	taskId: string;
	kind: "start" | "turn";
	admission: Promise<PiTurnAdmission>;
	reported: ReportedOutcome | null;
	/** The capacity queue's position while this turn waits. */
	queuePosition: number | null;
	/** Set by Stop so a canceled wait settles as canceled, not failed. */
	canceled: boolean;
	/**
	 * Replaced when newer input arrives for a turn that is still waiting: the
	 * card owns one conversation, so only the newest input should be written
	 * when its slot frees.
	 */
	run: () => Promise<RuntimeTaskSessionSummary>;
}

/** A queued start whose card moved on; its CLI must never launch. */
class ObsoletePiTurnError extends Error {}

/** A canceled or obsolete turn is not a failure, so it must never read as one. */
function describeFailure(error: unknown, canceled: boolean): string | null {
	if (canceled || error instanceof ObsoletePiTurnError) return null;
	return error instanceof Error ? error.message : String(error);
}

/**
 * Shares model admission with native Cline for **every** Kanban-driven Pi
 * coding turn: the initial prompt and every later input Kanban submits (task
 * chat, and the automated PR feedback handoff).
 *
 * A reservation is held for the whole turn — it outlives CLI spawn and is
 * released when the Pi extension reports `agent_settled` or the task process
 * exits, so a Pi turn that runs shell commands or sleeps keeps the slot it was
 * given. Capping only the first turn would let a card that already settled keep
 * working outside the budget, which is how a limit of 2 was observed running
 * three tasks at once.
 *
 * A turn never waits inside the caller's request. Task dispatch awaits
 * `startTaskSession` while it holds the per-workspace dispatch lock (a lock
 * documented as brief), so a queued turn resolves immediately with the
 * manager's waiting record and this gate runs the work once a slot frees. Stop
 * cancels the admission, and a queued CLI is never launched after that.
 *
 * Typing directly into a card's own terminal is not routed through this gate —
 * Kanban cannot queue another client's keystrokes — so this is still not a hard
 * provider request-rate limit.
 */
export class PiModelCapacityGate {
	private readonly turns = new Map<string, RunningPiTurn>();

	constructor(private readonly scheduler: ClineTurnScheduler = sharedClineTurnScheduler) {}

	private key(workspaceId: string, taskId: string): string {
		return JSON.stringify([workspaceId, taskId]);
	}

	private forget(key: string, record: RunningPiTurn): void {
		if (this.turns.get(key) === record) this.turns.delete(key);
	}

	/**
	 * Aborts a waiting admission and settles its waiting record. A running Pi
	 * process is stopped separately by the session manager.
	 */
	cancel(workspaceId: string, taskId: string): boolean {
		const record = this.turns.get(this.key(workspaceId, taskId));
		if (!record) return false;
		record.canceled = true;
		this.scheduler.cancel(record.owner, taskId);
		return true;
	}

	/**
	 * Whether a turn for this card still holds a claim in this process.
	 *
	 * The queue is the only thing that knows its own waits, so task dispatch
	 * asks here whether a card is waiting for a model slot instead of reading it
	 * off the summary: a waiting record left behind by a restart describes a
	 * wait nothing is still honoring, and would hold a slot forever.
	 */
	hasPending(workspaceId: string, taskId: string): boolean {
		return this.turns.has(this.key(workspaceId, taskId));
	}

	/**
	 * Drops one workspace's queued turns when its terminal manager is bulk-stopped
	 * or disposed. `markInterruptedAndStopAll` can only stop processes, so a turn
	 * waiting for a model slot outlives it - and the slot that shutdown, project
	 * removal or workspace disposal just freed would otherwise admit a fresh CLI
	 * against a manager that is being torn down. Only turns still waiting are
	 * dropped: a launched Pi CLI is a live process, and the bulk stop stops it
	 * itself. A dropped wait settles idle rather than failed, because teardown is
	 * not the card's failure; the card keeps its dispatch record and is relaunched
	 * by the next reconciliation.
	 */
	cancelWorkspace(workspaceId: string): number {
		let dropped = 0;
		for (const record of [...this.turns.values()]) {
			if (record.workspaceId !== workspaceId || record.reported !== "queued" || record.canceled) {
				continue;
			}
			record.canceled = true;
			this.scheduler.cancel(record.owner, record.taskId);
			dropped += 1;
		}
		return dropped;
	}

	/**
	 * Asks the shared model queue to admit one Pi turn and resolves as soon as the
	 * outcome is known: the work is running, or the turn is queued. Only capacity
	 * discovery and the work itself are awaited, so the caller never holds a lock
	 * across another task's whole turn.
	 */
	async request(request: PiTurnRequest): Promise<PiTurnAdmission> {
		const key = this.key(request.workspaceId, request.taskId);
		const existing = this.turns.get(key);
		if (existing) {
			if (!existing.canceled) {
				if (existing.reported === "queued" && existing.kind === request.kind && request.kind === "turn") {
					// The card's newest input wins: a queued turn runs only the latest
					// input when its slot frees.
					existing.run = request.run;
					return {
						status: "queued",
						queuePosition: existing.queuePosition,
						summary: this.recordWaiting(request, existing.queuePosition),
					};
				}
				if (request.kind === "turn") {
					// The card already holds (or is claiming) a slot for its in-flight
					// turn, so writing input into that session consumes no second slot.
					return { status: "launched", summary: await request.run() };
				}
				return await existing.admission;
			}
			// Stop ended that wait, so it owns nothing: this request takes the card's
			// capacity from here. The canceled claim forgets itself by identity.
			this.turns.delete(key);
		}

		const owner = Symbol(key);
		let settle!: (admission: PiTurnAdmission) => void;
		let fail!: (error: unknown) => void;
		const admission = new Promise<PiTurnAdmission>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		const record: RunningPiTurn = {
			owner,
			workspaceId: request.workspaceId,
			taskId: request.taskId,
			kind: request.kind,
			admission,
			reported: null,
			queuePosition: null,
			canceled: false,
			run: request.run,
		};
		this.turns.set(key, record);

		/** Publishes the wait once the queue reports it, and only to the caller. */
		const reportQueued = (queuePosition: number | null): void => {
			if (record.reported !== null) return;
			record.queuePosition = queuePosition;
			record.reported = "queued";
			// Until the work runs, the manager's waiting record is the only state
			// the card, the terminal viewer, and Stop can point at.
			settle({
				status: "queued",
				queuePosition,
				summary: this.recordWaiting(request, queuePosition),
			});
		};
		/**
		 * Routes the outcome of a turn that stopped progressing. While the caller
		 * still knows nothing the failure is its own; after a queued report it
		 * already holds a waiting record, so settling that record is the only way
		 * the outcome can be seen.
		 */
		const handleFailure = (error: unknown): void => {
			if (record.reported === "queued") {
				this.endWaiting(request, describeFailure(error, record.canceled));
			} else if (record.reported === null) {
				fail(error);
			}
			record.reported = "ended";
		};

		const hold = this.scheduler.run(
			owner,
			request.taskId,
			request.target,
			async (signal) => {
				signal.throwIfAborted();
				let resolveFinished!: () => void;
				const finished = new Promise<void>((resolve) => {
					resolveFinished = resolve;
				});
				const admissionTime = Date.now();
				const detach = request.manager.onSummary((summary) => {
					if (summary.taskId !== request.taskId || summary.agentId !== "pi") return;
					if (
						(summary.latestHookActivity?.hookEventName === "agent_settled" &&
							(summary.lastHookAt ?? 0) >= admissionTime) ||
						(summary.pid === null && summary.state !== "running") ||
						summary.state === "failed"
					)
						resolveFinished();
				});
				try {
					signal.throwIfAborted();
					if (request.isCurrent && !request.isCurrent()) {
						// A queued turn can wait long enough for its card to be
						// returned to Backlog; that CLI must never spawn.
						throw new ObsoletePiTurnError("Task was returned to Backlog during launch.");
					}
					const wasQueued = record.reported === "queued";
					const summary = await record.run();
					if (record.reported === null) {
						record.reported = "launched";
						settle({ status: "launched", summary });
					}
					if (wasQueued && record.kind === "turn") {
						// The live session is working now, so its waiting annotation
						// has to go before Pi's own turn hooks land.
						request.manager.clearTurnCapacityWait(request.taskId);
					}
					if (signal.aborted) {
						// Stop landed while the CLI was spawning: a process exists
						// now, so end it instead of stranding a live agent.
						request.manager.stopTaskSession(request.taskId);
					}
					if (summary.pid === null || summary.state === "failed") resolveFinished();
					await finished;
				} catch (error) {
					handleFailure(error);
					throw error;
				} finally {
					detach();
				}
			},
			(queued, queuePosition) => {
				if (queued) reportQueued(typeof queuePosition === "number" ? queuePosition : null);
			},
		);

		void hold.then(
			() => {
				this.forget(key, record);
			},
			(error) => {
				// An admission that failed before the work ever ran: a canceled queue
				// claim, or capacity discovery that never resolved.
				handleFailure(error);
				this.forget(key, record);
			},
		);

		return await admission;
	}

	/** Describes a turn that is waiting for a model slot, per request kind. */
	private recordWaiting(request: PiTurnRequest, queuePosition: number | null): RuntimeTaskSessionSummary {
		return request.kind === "start"
			? request.manager.recordModelCapacityWait({
					taskId: request.taskId,
					agentId: "pi",
					workspacePath: request.workspacePath ?? "",
					queuePosition,
				})
			: request.manager.markTurnCapacityWait({
					taskId: request.taskId,
					queuePosition,
				});
	}

	/** Ends a wait whose work never ran, per request kind. */
	private endWaiting(request: PiTurnRequest, error: string | null): void {
		if (request.kind === "start") {
			request.manager.settleModelCapacityWait(request.taskId, error);
			return;
		}
		request.manager.clearTurnCapacityWait(request.taskId, error);
	}
}

export const sharedPiModelCapacityGate = new PiModelCapacityGate();
