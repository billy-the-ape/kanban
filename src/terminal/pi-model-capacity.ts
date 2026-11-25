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
 *   `onNotRun` on the request is how that background outcome reaches a caller
 *   that has already returned.
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
	 * gate calls it once, including from the background when the turn waited for
	 * a slot. It is never replaced: a card owns one conversation, so queued input
	 * is kept and delivered in arrival order.
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
	/**
	 * Fires exactly once when this request's work never reached the model: the
	 * wait was canceled, the card moved on, the write failed, or an earlier
	 * queued input for the same card failed first. A caller answered `queued`
	 * sees no other outcome, so anything owning a durable receipt (an automated
	 * PR repair) must settle it here. Never called for a request answered
	 * `launched`, or for a request whose promise rejected - those callers
	 * already know.
	 */
	onNotRun?: (reason: string) => void;
}

/** One input waiting behind the card's claim, with the way back to its caller. */
interface QueuedPiInput {
	run: () => Promise<RuntimeTaskSessionSummary>;
	onNotRun?: (reason: string) => void;
	/**
	 * Whether this input's terminal outcome has been reported to its caller:
	 * either it reached the model, or it was abandoned with a reason.
	 */
	reported: boolean;
}

/** Which outcome the creating caller was told about, or null while it awaits. */
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
	/** True once input has been written: later input goes straight to that turn. */
	workStarted: boolean;
	/** Input waiting for the claim, in arrival order and never replaced. */
	inputs: QueuedPiInput[];
	/** How many of `inputs` have been handed to the model. */
	delivered: number;
}

/** A queued start whose card moved on; its CLI must never launch. */
class ObsoletePiTurnError extends Error {}

/** Why work never reached the model, in a form a receipt can show its owner. */
function describeAbandonment(error: unknown, canceled: boolean): string {
	if (canceled) {
		return "The turn was canceled before the model had capacity.";
	}
	if (error instanceof ObsoletePiTurnError) {
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Whether an abandoned turn is a failure the card has to show. Stop and a card
 * that moved on are ordinary outcomes, so they leave the summary clean; only a
 * real error belongs on the card.
 */
function describeCardFailure(error: unknown, canceled: boolean): string | null {
	if (canceled || error instanceof ObsoletePiTurnError) {
		return null;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * A delivered turn that never started would hold a model slot until its process
 * exits, which is a stuck card rather than a working one. Pi reports every turn
 * with hooks within moments of receiving input, so silence this long means the
 * input never became a turn - Pi was blocked on a prompt, for example - and the
 * reservation is released.
 */
export const PI_TURN_START_GRACE_MS = 60_000;

/**
 * Shares model admission with native Cline for **every** Kanban-driven Pi coding
 * turn: the initial prompt, follow-up input from task chat, and the automated PR
 * feedback handoff.
 *
 * A reservation is held for the whole turn — it outlives CLI spawn and is
 * released when the Pi extension reports `agent_settled` or the task process
 * exits, so a Pi turn that runs shell commands or sleeps keeps the slot it was
 * given. Capping only the first turn would let a card that already settled keep
 * working outside the budget, which is how a limit of 2 was observed running
 * three tasks at once.
 *
 * A card holds **one** claim, because a card owns one conversation. Input that
 * arrives while the claim is still waiting is kept in arrival order and written
 * when the slot frees; input that arrives while the claim's own turn is running
 * is written straight to that session, since the turn already reserves the slot.
 * Nothing is replaced or dropped, and every request whose work never ran is
 * reported through `onNotRun`.
 *
 * A turn never waits inside the caller's request. Task dispatch awaits
 * `startTaskSession` while it holds the per-workspace dispatch lock (a lock
 * documented as brief), so a queued turn resolves immediately with the manager's
 * waiting record and this gate runs the work once a slot frees. Stop cancels the
 * admission, and a queued CLI is never launched after that.
 *
 * Input that does not submit a turn - a paste the human still has to press Enter
 * for - is not routed here (see `sendTaskSessionInput`), and neither is typing
 * directly into a card's own terminal, because Kanban cannot queue another
 * client's keystrokes. This is still not a hard provider request-rate limit.
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
	 * by the next reconciliation, and every dropped input is reported to its owner.
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
				if (request.kind === "start") {
					// The same initial start, asked for twice: one CLI, one claim.
					return await existing.admission;
				}
				if (existing.workStarted) {
					// The card's turn is already running on this claim, so writing into
					// that session consumes no second slot.
					return { status: "launched", summary: await request.run() };
				}
				// The claim is still waiting for a slot, so keep this input behind the
				// ones already waiting. A card owns one conversation, so queued input
				// is delivered in arrival order and never replaces another owner's work:
				// a queued chat message and a queued PR repair both run.
				existing.inputs.push({
					run: request.run,
					...(request.onNotRun ? { onNotRun: request.onNotRun } : {}),
					reported: false,
				});
				return {
					status: "queued",
					queuePosition: existing.queuePosition,
					summary: this.recordWaiting(request, existing.queuePosition),
				};
			}
			// Stop ended that wait, so it owns nothing: this request takes the card's
			// capacity from here. The canceled claim reports its own abandoned input.
			this.turns.delete(key);
		}

		const owner = Symbol(key);
		let settle!: (admission: PiTurnAdmission) => void;
		let reject!: (error: unknown) => void;
		const admission = new Promise<PiTurnAdmission>((resolve, rejectPromise) => {
			settle = resolve;
			reject = rejectPromise;
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
			workStarted: false,
			delivered: 0,
			inputs: [
				{
					run: request.run,
					...(request.onNotRun ? { onNotRun: request.onNotRun } : {}),
					reported: false,
				},
			],
		};
		this.turns.set(key, record);

		/**
		 * Tells every still-silent owner that its input never reached the model. A
		 * caller answered `queued` has no other channel, and the creating caller is
		 * only silent once it holds a waiting record.
		 */
		const abandon = (reason: string): void => {
			for (const input of record.inputs) {
				if (input.reported) continue;
				input.reported = true;
				input.onNotRun?.(reason);
			}
		};

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
		 * Routes the outcome of a turn that stopped progressing. While the creating
		 * caller still knows nothing the failure is its own; after a queued report it
		 * holds a waiting record, so annotating that record and reporting the
		 * abandoned input are the only ways the outcome can be seen.
		 */
		const handleFailure = (error: unknown): void => {
			const ownerReason = describeAbandonment(error, record.canceled);
			const cardError = describeCardFailure(error, record.canceled);
			if (record.reported === "queued") {
				this.endWaiting(request, cardError);
				abandon(ownerReason);
			} else if (record.reported === null) {
				abandon(ownerReason);
				reject(error);
			}
			record.reported = "ended";
		};

		const hold = this.scheduler.run(
			owner,
			request.taskId,
			request.target,
			async (signal) => {
				signal.throwIfAborted();
				// Turn ends are counted, not signalled through a single promise: a
				// settle that lands between two deliveries must still be seen by the
				// delivery that follows it, and one that is missed would strand the slot.
				let turnEnds = 0;
				const waiting = new Set<() => void>();
				const notifyTurnEnd = (): void => {
					turnEnds += 1;
					for (const wake of [...waiting]) wake();
					waiting.clear();
				};
				const waitForTurnEnd = async (seen: number): Promise<void> => {
					while (turnEnds <= seen) {
						await new Promise<void>((resolve) => waiting.add(resolve));
					}
				};
				// Hooks newer than this belong to the turn just delivered.
				let deliveredAt = 0;
				let startGrace: ReturnType<typeof setTimeout> | undefined;
				const clearGrace = (): void => {
					if (startGrace) clearTimeout(startGrace);
					startGrace = undefined;
				};
				/**
				 * A turn ends when Pi settles it or its process goes away. Any hook also
				 * disarms the start grace: past that Pi is verifiably working, and only a
				 * real settle may free the slot.
				 */
				const detach = request.manager.onSummary((summary) => {
					if (summary.taskId !== request.taskId || summary.agentId !== "pi") return;
					if (summary.state === "failed" || (summary.pid === null && summary.state !== "running")) {
						clearGrace();
						notifyTurnEnd();
						return;
					}
					if ((summary.lastHookAt ?? 0) < deliveredAt) return;
					if (!summary.latestHookActivity) return;
					clearGrace();
					if (summary.latestHookActivity.hookEventName === "agent_settled") notifyTurnEnd();
				});
				try {
					for (;;) {
						signal.throwIfAborted();
						if (record.delivered >= record.inputs.length) break;
						if (request.isCurrent && !request.isCurrent()) {
							// A queued turn can wait long enough for its card to be
							// returned to Backlog; that CLI must never spawn.
							throw new ObsoletePiTurnError("Task was returned to Backlog during launch.");
						}
						const wasQueued = record.reported === "queued";
						// A queued follow-up waits on a live session that keeps running;
						// a queued start has no process, so its launch summary replaces
						// the waiting record instead.
						const waitsOnLiveSession = record.kind === "turn";
						deliveredAt = Date.now();
						record.workStarted = true;
						clearGrace();
						const seenBeforeDelivery = turnEnds;
						startGrace = setTimeout(() => {
							// Nothing Pi reported, so no turn started: never keep a model
							// slot for input the model was never asked to work on.
							clearGrace();
							notifyTurnEnd();
						}, PI_TURN_START_GRACE_MS);
						startGrace.unref?.();
						let summary: RuntimeTaskSessionSummary | null = null;
						const batchEnd = record.inputs.length;
						for (; record.delivered < batchEnd; record.delivered += 1) {
							const input = record.inputs[record.delivered];
							if (!input) continue;
							try {
								summary = await input.run();
							} catch (error) {
								// This input never reached the model and nothing further in
								// the queue runs, so every silent owner has to be told.
								abandon(describeAbandonment(error, record.canceled));
								throw error;
							}
							// The model has it now: the card and Pi own the outcome here.
							input.reported = true;
						}
						if (!summary) {
							throw new Error("Pi task session disappeared before its turn started.");
						}
						if (record.reported === null) {
							record.reported = "launched";
							settle({ status: "launched", summary });
						}
						if (wasQueued && waitsOnLiveSession) {
							// The live session is working now, so its waiting annotation
							// has to go before Pi's own turn hooks land.
							request.manager.clearTurnCapacityWait(request.taskId);
						}
						if (signal.aborted) {
							// Stop landed while the CLI was spawning: a process exists
							// now, so end it instead of stranding a live agent.
							request.manager.stopTaskSession(request.taskId);
							abandon(describeAbandonment(undefined, true));
							break;
						}
						const ended = waitForTurnEnd(seenBeforeDelivery);
						await ended;
						clearGrace();
						if (record.canceled) {
							// Stop answers a still-queued input now: it must never be
							// written to a session that is being torn down.
							abandon(describeAbandonment(undefined, true));
							break;
						}
						if (record.delivered >= record.inputs.length) break;
						// More input arrived while the turn ran; this claim still holds the
						// slot, so write it and watch the turn it starts.
					}
				} catch (error) {
					handleFailure(error);
					throw error;
				} finally {
					clearGrace();
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
