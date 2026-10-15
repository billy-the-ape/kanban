/** Internal execution hook: runs only after model capacity is granted, never from RPC input. */
export type ClineTurnPreparation = (context: { cwd: string; signal: AbortSignal }) => Promise<string | null>;

/** A null prepared prompt cancels an obsolete automatic turn without calling the model. */
export const CLINE_TURN_SKIPPED = { kanbanTurnSkipped: true } as const;
