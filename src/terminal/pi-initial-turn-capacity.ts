import type { ClineTurnTarget } from "../cline-sdk/cline-turn-scheduler";
import { ClineTurnScheduler, sharedClineTurnScheduler } from "../cline-sdk/cline-turn-scheduler";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TerminalSessionManager } from "./session-manager";

interface RunningPiStart {
	owner: symbol;
	started: Promise<RuntimeTaskSessionSummary>;
}

/**
 * Shares model admission with native Cline *for the initial Pi coding turn*.
 * The reservation outlives CLI spawn and is released when the Pi extension
 * reports agent_settled or the task process exits. Pi can run shell tools and
 * sleep while holding a slot; raising the global override intentionally
 * allows other work to be admitted during those gaps.
 *
 * Existing Pi interactive terminals can accept follow-up turns directly and
 * do not pass through this start gate. Do not claim this is a hard provider
 * request-rate limit.
 */
export class PiInitialTurnCapacityGate {
	private readonly starts = new Map<string, RunningPiStart>();

	constructor(private readonly scheduler: ClineTurnScheduler = sharedClineTurnScheduler) {}

	private key(workspaceId: string, taskId: string): string {
		return JSON.stringify([workspaceId, taskId]);
	}

	async start(
		workspaceId: string,
		taskId: string,
		manager: TerminalSessionManager,
		target: ClineTurnTarget,
		launch: () => Promise<RuntimeTaskSessionSummary>,
	): Promise<RuntimeTaskSessionSummary> {
		const key = this.key(workspaceId, taskId);
		const existing = this.starts.get(key);
		if (existing) return await existing.started;

		const owner = Symbol(key);
		let resolveStart!: (summary: RuntimeTaskSessionSummary) => void;
		let rejectStart!: (reason: unknown) => void;
		const started = new Promise<RuntimeTaskSessionSummary>((resolve, reject) => {
			resolveStart = resolve;
			rejectStart = reject;
		});
		const record: RunningPiStart = { owner, started };
		this.starts.set(key, record);

		const hold = this.scheduler.run(owner, taskId, target, async (signal) => {
			signal.throwIfAborted();
			let resolveFinished!: () => void;
			const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
			const admissionTime = Date.now();
			const detach = manager.onSummary((summary) => {
				if (summary.taskId !== taskId || summary.agentId !== "pi") return;
				if (
					(summary.latestHookActivity?.hookEventName === "agent_settled" &&
						(summary.lastHookAt ?? 0) >= admissionTime) ||
					(summary.pid === null && summary.state !== "running") ||
					summary.state === "failed"
				) resolveFinished();
			});
			try {
				signal.throwIfAborted();
				const summary = await launch();
				resolveStart(summary);
				if (summary.pid === null || summary.state === "failed") resolveFinished();
				await finished;
			} catch (error) {
				rejectStart(error);
				throw error;
			} finally {
				detach();
			}
		});
		void hold.then(
			() => {
				if (this.starts.get(key) === record) this.starts.delete(key);
			},
			(error) => {
				rejectStart(error);
				if (this.starts.get(key) === record) this.starts.delete(key);
			},
		);
		return await started;
	}

	/** Abort a waiting admission. A running Pi process is stopped separately. */
	cancel(workspaceId: string, taskId: string): boolean {
		const record = this.starts.get(this.key(workspaceId, taskId));
		if (!record) return false;
		this.scheduler.cancel(record.owner, taskId);
		return true;
	}
}

export const sharedPiInitialTurnCapacityGate = new PiInitialTurnCapacityGate();
