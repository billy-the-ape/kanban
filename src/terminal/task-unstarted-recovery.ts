// AA-UNSUPPORTED: deciding whether a task that never started an agent
// conversation can be recovered in place.
//
// A task can end up with a prepared worktree and no agent session: the start
// created the worktree, then the launch itself failed (an unsupported setting,
// an adapter error, a refused spawn) or the process died before it ever
// persisted a conversation. Those cards are not ordinary paused tasks — there is
// nothing to resume — but the worktree, the branch and the baseline are all
// still exactly as the start left them, so recreating the task would throw away
// a clean baseline for no reason.
//
// Two different kinds of proof meet here and only the first is shared:
//
//   - Agent-independent proof that the worktree is untouched: it exists, its
//     HEAD is still the persisted baseline, nothing is dirty, nothing is ahead,
//     nothing was preserved or patched, and no delivery receipt exists. Without
//     all of it, a relaunch could discard work or replay delivered work.
//   - Adapter-specific proof that no conversation exists. Kanban can only know
//     this for an agent whose exact session it names itself
//     (`explicitSessionResume`), and even then only by reading that agent's own
//     durable record. Every other CLI resumes "the most recent session", so
//     Kanban cannot tell a never-started conversation from a finished one and
//     refuses instead of guessing.
//
// Recovery therefore relaunches with the task's stored prompt as a genuinely new
// conversation; it never refreshes the baseline, recreates the worktree, resets
// a dirty tree, or replays already delivered work.
import { getRuntimeAgentCapabilities } from "../core/agent-capabilities";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeGitDeliveryReceipt,
	RuntimeTaskPreservationInfoResponse,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { checkTaskLaunchRequirements } from "../core/task-launch-requirements";
import type { TaskInitialStartRecord } from "../workspace/task-initial-start";

/** A reason the task cannot be recovered, phrased so the user can act on it. */
export interface UnstartedTaskRecoveryAssessment {
	/** True only when a relaunch of the stored prompt is safe right now. */
	recoverable: boolean;
	/** The effective agent a relaunch would use. */
	agentId: RuntimeAgentId | null;
	/** The stored task prompt, so recovery never invents a generic "resume". */
	prompt: string;
	/** Null when `recoverable`, otherwise what to do about it. */
	reason: string | null;
	/**
	 * Set when the task's saved settings are not executable by its effective
	 * agent. The user must fix them in the task editor first; recovery never
	 * silently drops the request (an Act run instead of a plan would edit files
	 * the user only wanted planned).
	 */
	settingsError: string | null;
	/**
	 * Whether nothing shows that an agent ever ran for this task: no process, no
	 * session record that ever started, and no agent-side conversation.
	 *
	 * This is the signal that a card is not an ordinary paused task. A prepared
	 * worktree with no agent behind it otherwise looks exactly like a task the
	 * user stopped themselves, which is how a failed launch went unnoticed.
	 */
	neverLaunched: boolean;
}

/** Minimal view of the terminal manager, so callers can pass a partial harness. */
export interface UnstartedRecoveryTerminalView {
	getSummary(taskId: string): RuntimeTaskSessionSummary | null;
	hasActiveProcess(taskId: string): boolean;
}

export interface UnstartedTaskRecoveryInput {
	taskId: string;
	/** The card as persisted on the board, or null when it no longer exists. */
	card: RuntimeBoardCard | null;
	/** The agent a relaunch would actually run (card override → project default). */
	agentId: RuntimeAgentId | null;
	terminal: UnstartedRecoveryTerminalView;
	/**
	 * Session records that live outside the terminal manager (a native Cline
	 * session is the only one). They are guarded by the same liveness rules: a
	 * running conversation is never replaced by a relaunch.
	 */
	additionalSummaries?: RuntimeTaskSessionSummary[];
	/** Durable initial-start record (the baseline the worktree was created at). */
	baseline: TaskInitialStartRecord | null;
	/** Worktree/HEAD/dirty/preservation facts, or null when they cannot be read. */
	work: RuntimeTaskPreservationInfoResponse | null;
	/** The task's durable delivery receipt, when it has one. */
	deliveryReceipt?: RuntimeGitDeliveryReceipt | null;
	/** Whether a trashed-task patch exists (already-delivered work waiting to land). */
	hasStoredPatch?: boolean;
	/**
	 * Whether the agent's own durable conversation for this task exists. Only
	 * called for an agent Kanban can prove this about.
	 */
	hasAgentConversation?: () => Promise<boolean>;
}

/**
 * Only agents Kanban names its own session for can be proven conversation-less,
 * and even then only through a probe of that agent's durable record.
 */
function canProbeAgentConversation(agentId: RuntimeAgentId | null): boolean {
	if (!agentId) {
		return false;
	}
	return getRuntimeAgentCapabilities(agentId).explicitSessionResume;
}

/**
 * Assess whether this card is an unstarted-but-prepared task that can be
 * relaunched with its stored prompt. Every guard is a read-only check over
 * persisted state; nothing here mutates the worktree, the board, or a session.
 */
export async function assessUnstartedTaskRecovery(
	input: UnstartedTaskRecoveryInput,
): Promise<UnstartedTaskRecoveryAssessment> {
	const prompt = input.card?.prompt?.trim() ?? "";
	const summaries = [input.terminal.getSummary(input.taskId), ...(input.additionalSummaries ?? [])].filter(
		(summary): summary is RuntimeTaskSessionSummary => summary !== null,
	);
	const hasActiveProcess = input.terminal.hasActiveProcess(input.taskId);
	// A record that never had a pid is not evidence of a run; `startedAt` is only
	// ever written together with one.
	let neverLaunched = !hasActiveProcess && !summaries.some((summary) => summary.startedAt !== null);
	/** Every refusal keeps the facts it did establish, especially `neverLaunched`. */
	const refuse = (reason: string, settingsError: string | null = null): UnstartedTaskRecoveryAssessment => ({
		recoverable: false,
		agentId: input.agentId,
		prompt,
		reason,
		settingsError,
		neverLaunched,
	});

	if (!input.card) {
		return refuse("This task is no longer on the board.");
	}
	if (!prompt) {
		return refuse("This task has no prompt to start with. Add one in the task editor.");
	}
	if (!input.agentId) {
		return refuse("No agent is configured for this task. Pick one in the task editor.");
	}

	// The runtime re-checks the task's saved settings here so an unstarted card
	// explains itself ("Pi does not support plan mode") instead of failing the
	// same way on every retry.
	const requirements = checkTaskLaunchRequirements(input.agentId, {
		startInPlanMode: input.card.startInPlanMode === true,
		imagesRequested: (input.card.images?.length ?? 0) > 0,
	});
	if (!requirements.ok) {
		return refuse(
			`Fix the task settings first: ${requirements.error ?? "This task requests a setting the agent cannot honor."}`,
			requirements.error,
		);
	}

	if (hasActiveProcess) {
		return refuse("The task already has a running agent process.");
	}
	if (summaries.some((summary) => summary.state === "running")) {
		return refuse("The task session is already running.");
	}
	const reviewed = summaries.find(
		(summary) => summary.state === "awaiting_review" && summary.reviewReason !== "error",
	);
	if (reviewed) {
		neverLaunched = false;
		return refuse(
			reviewed.reviewReason === "interrupted"
				? "This task has an agent conversation to restore; use Restore instead of relaunching."
				: "The task session finished and is waiting for review.",
		);
	}

	if (!canProbeAgentConversation(input.agentId) || !input.hasAgentConversation) {
		return refuse(
			`${input.agentId} sessions cannot be proven empty, so this task cannot be relaunched in place. Open a terminal for this task and start the agent by hand, or move the card back to Backlog to start a fresh task.`,
		);
	}

	const baseline = input.baseline;
	if (!baseline || baseline.state !== "prepared" || !baseline.baselineSha) {
		return refuse(
			"No prepared baseline exists for this task, so starting it normally (from Backlog) is the safe path.",
		);
	}
	const work = input.work;
	if (!work || !work.ok) {
		return refuse("Could not read the task worktree, so nothing was changed.");
	}
	if (!work.worktreeExists) {
		return refuse("The task worktree does not exist; start the task normally to create it at a fresh baseline.");
	}
	if (work.headCommit !== baseline.baselineSha) {
		neverLaunched = false;
		return refuse(
			`The worktree HEAD (${work.headCommit?.slice(0, 12) ?? "unknown"}) is no longer the saved baseline (${baseline.baselineSha.slice(0, 12)}), so its existing commits are kept as they are.`,
		);
	}
	if (work.dirty) {
		neverLaunched = false;
		return refuse("The worktree has uncommitted changes, which relaunching must not discard.");
	}
	if (work.commitsAheadOfBase !== 0) {
		neverLaunched = false;
		return refuse("The worktree already has commits of its own, which relaunching must not replay.");
	}
	if (work.preservation !== null && work.preservation.startingCommit !== baseline.baselineSha) {
		neverLaunched = false;
		return refuse("This task has preserved work that must be recovered instead of relaunched.");
	}
	if (input.deliveryReceipt) {
		neverLaunched = false;
		return refuse("This task already has a delivery receipt, so its work must not be replayed.");
	}
	if (input.hasStoredPatch) {
		neverLaunched = false;
		return refuse("This task has a stored patch of delivered work, so relaunching must not replay it.");
	}

	if (await input.hasAgentConversation()) {
		neverLaunched = false;
		return refuse(
			"An agent conversation already exists for this task, so starting again would begin a second one. Restore the session instead.",
		);
	}

	return {
		recoverable: true,
		agentId: input.agentId,
		prompt,
		reason: null,
		settingsError: null,
		// Relaunchable is not the same as never launched: a task that ran, was
		// stopped, and left a clean worktree behind may still be relaunchable.
		neverLaunched,
	};
}
