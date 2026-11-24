import type { ClineTurnTarget } from "../cline-sdk/cline-turn-scheduler";
import { type ClineTurnScheduler, sharedClineTurnScheduler } from "../cline-sdk/cline-turn-scheduler";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TerminalSessionManager } from "./session-manager";

/**
 * What one start request ended up doing.
 *
 * - `launched`: the CLI is already running and `summary` describes it.
 * - `queued`: the start waits for a model slot, so `summary` is the manager's
 *   waiting record and the CLI spawns in the background when capacity frees.
 */
export type PiStartAdmission =
	| { readonly status: "launched"; readonly summary: RuntimeTaskSessionSummary }
	| {
			readonly status: "queued";
			readonly summary: RuntimeTaskSessionSummary;
			readonly queuePosition: number | null;
	  };

export interface PiStartRequest {
	workspaceId: string;
	taskId: string;
	/** The task worktree the queued CLI will run in. */
	workspacePath: string;
	manager: TerminalSessionManager;
	target: ClineTurnTarget;
	launch: () => Promise<RuntimeTaskSessionSummary>;
	/**
	 * A queued spawn is checked against this again when its slot frees: a card
	 * returned to Backlog (or relaunched) while it waited must never launch.
	 */
	isCurrent?: () => boolean;
}

/** Which outcome the caller was told about, or null while it still awaits. */
type ReportedOutcome = "launched" | "queued" | "ended";

interface RunningPiStart {
	owner: symbol;
	admission: Promise<PiStartAdmission>;
	reported: ReportedOutcome | null;
	/** Set by Stop so a canceled wait settles as canceled, not failed. */
	canceled: boolean;
}

/** A start whose card moved on while it waited; its CLI must never spawn. */
class ObsoletePiStartError extends Error {}

/** A canceled or obsolete wait is not a failure, so it must never read as one. */
function describeFailure(error: unknown, canceled: boolean): string | null {
	if (canceled || error instanceof ObsoletePiStartError) return null;
	return error instanceof Error ? error.message : String(error);
}

/**
 * Shares model admission with native Cline *for the initial Pi coding turn*.
 * The reservation outlives CLI spawn and is released when the Pi extension
 * reports agent_settled or the task process exits. Pi can run shell tools and
 * sleep while holding a slot; raising the global override intentionally allows
 * other work to be admitted during those gaps.
 *
 * A start never waits inside the caller's request. Task dispatch awaits
 * `startTaskSession` while it holds the per-workspace dispatch lock (a lock
 * documented as brief), so a queued start resolves immediately with a waiting
 * record and this gate spawns its CLI once a slot frees. Stop cancels the
 * admission, and a queued CLI is never launched after that.
 *
 * Existing Pi interactive terminals can accept follow-up turns directly and do
 * not pass through this start gate. Do not claim this is a hard provider
 * request-rate limit.
 */
export class PiInitialTurnCapacityGate {
	private readonly starts = new Map<string, RunningPiStart>();

	constructor(private readonly scheduler: ClineTurnScheduler = sharedClineTurnScheduler) {}

	private key(workspaceId: string, taskId: string): string {
		return JSON.stringify([workspaceId, taskId]);
	}

	private forget(key: string, record: RunningPiStart): void {
		if (this.starts.get(key) === record) this.starts.delete(key);
	}

	/**
	 * Aborts a waiting admission and settles its waiting record. A running Pi
	 * process is stopped separately by the session manager.
	 */
	cancel(workspaceId: string, taskId: string): boolean {
		const record = this.starts.get(this.key(workspaceId, taskId));
		if (!record) return false;
		record.canceled = true;
		this.scheduler.cancel(record.owner, taskId);
		return true;
	}

	/**
	 * Asks the shared model queue to admit an initial Pi turn and resolves as
	 * soon as the outcome is known: the CLI launched, or the start is queued.
	 * Only capacity discovery and the spawn itself are awaited, so the caller
	 * never holds a lock across another task's whole first turn.
	 */
	async request(request: PiStartRequest): Promise<PiStartAdmission> {
		const key = this.key(request.workspaceId, request.taskId);
		const existing = this.starts.get(key);
		if (existing) return await existing.admission;

		const owner = Symbol(key);
		let settle!: (admission: PiStartAdmission) => void;
		let fail!: (error: unknown) => void;
		const admission = new Promise<PiStartAdmission>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		const record: RunningPiStart = { owner, admission, reported: null, canceled: false };
		this.starts.set(key, record);

		/** Publishes the wait once the queue reports it, and only to the caller. */
		const reportQueued = (queuePosition: number | null): void => {
			if (record.reported !== null) return;
			record.reported = "queued";
			// Until the queued CLI exists, the manager's waiting record is the only
			// state the card, the terminal viewer, and Stop can point at.
			settle({
				status: "queued",
				queuePosition,
				summary: request.manager.recordModelCapacityWait({
					taskId: request.taskId,
					agentId: "pi",
					workspacePath: request.workspacePath,
				}),
			});
		};
		/**
		 * Routes the outcome of a start that stopped progressing. While the caller
		 * still knows nothing the failure is its own; after a queued report it
		 * already holds a waiting record, so settling that record is the only way
		 * the outcome can be seen.
		 */
		const handleFailure = (error: unknown): void => {
			if (record.reported === "queued") {
				request.manager.settleModelCapacityWait(request.taskId, describeFailure(error, record.canceled));
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
						// A queued start can wait long enough for its card to be
						// returned to Backlog; that CLI must never spawn.
						throw new ObsoletePiStartError("Task was returned to Backlog during launch.");
					}
					const summary = await request.launch();
					if (record.reported === null) {
						record.reported = "launched";
						settle({ status: "launched", summary });
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
				// An admission that failed before the operation ever ran: a canceled
				// queue claim, or capacity discovery that never resolved.
				handleFailure(error);
				this.forget(key, record);
			},
		);

		return await admission;
	}
}

export const sharedPiInitialTurnCapacityGate = new PiInitialTurnCapacityGate();
