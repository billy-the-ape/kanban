/** Internal execution hook: runs only after model capacity is granted, never from RPC input. */
export type ClineTurnOutcome = { status: "completed" | "skipped" } | { status: "failed" | "canceled"; error: string };

export interface ClineTurnPreparation {
	(context: { cwd: string; signal: AbortSignal }): Promise<string | null>;
	/** Called synchronously when the task service accepts this particular turn. */
	onQueued?: () => void;
	/** Runs once when this turn leaves the task queue, including before admission. */
	onSettled?: (outcome: ClineTurnOutcome) => Promise<void>;
}

/** A null prepared prompt cancels an obsolete automatic turn without calling the model. */
export const CLINE_TURN_SKIPPED = { kanbanTurnSkipped: true } as const;
