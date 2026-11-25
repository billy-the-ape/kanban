// AA-UNSUPPORTED: one place that decides whether a task's saved launch settings
// are executable by the agent that would actually run the task.
//
// The capability table in `agent-capabilities.ts` is the only source of truth
// here: this module never branches on an agent id, so a new agent (or a changed
// capability row) is automatically honored by task creation, task editing, the
// start/dispatch/resume paths and the recovery flow instead of needing its own
// `agentId === "pi"` check.
//
// Both sides of the boundary use it: the web UI disables the options the
// effective agent cannot honor before the user can ask for them, and the
// runtime re-checks the same rule authoritatively before it performs any
// initial-start side effect. An unsupported request is always a refusal —
// quietly running Act mode instead would let an agent edit files when the user
// only asked for a plan.
import {
	formatUnsupportedAgentLaunchError,
	getRuntimeAgentCapabilities,
	getUnsupportedAgentLaunchOperations,
} from "./agent-capabilities";
import { getRuntimeAgentCatalogEntry } from "./agent-catalog";
import type { RuntimeAgentId, RuntimeAgentLaunchOperation } from "./api-contract";

/** The per-task launch settings an agent may or may not be able to honor. */
export interface TaskLaunchSettings {
	/** The task asked to start in a read-only planning mode. */
	startInPlanMode?: boolean | undefined;
	/** The task carries image attachments. */
	imagesRequested?: boolean | undefined;
	/** Kanban's autonomous (approval-bypass) setting is on for this launch. */
	autonomousModeRequested?: boolean | undefined;
}

export interface TaskLaunchRequirementCheck {
	ok: boolean;
	unsupportedOperations: RuntimeAgentLaunchOperation[];
	/** Null when every requested setting is supported. */
	error: string | null;
}

/**
 * The requested settings this agent cannot honor. An empty array means the
 * launch is fully supported.
 */
export function getUnsupportedTaskLaunchOperations(
	agentId: RuntimeAgentId,
	settings: TaskLaunchSettings,
): RuntimeAgentLaunchOperation[] {
	return getUnsupportedAgentLaunchOperations(agentId, settings);
}

/**
 * The authoritative answer for one launch request. The message names the agent
 * and the settings it cannot honor, so the fix is in the error itself.
 */
export function checkTaskLaunchRequirements(
	agentId: RuntimeAgentId,
	settings: TaskLaunchSettings,
): TaskLaunchRequirementCheck {
	const unsupportedOperations = getUnsupportedTaskLaunchOperations(agentId, settings);
	return {
		ok: unsupportedOperations.length === 0,
		unsupportedOperations,
		error: formatUnsupportedAgentLaunchError(agentId, unsupportedOperations),
	};
}

const SETTING_NOTICES: Record<RuntimeAgentLaunchOperation, string> = {
	"plan-mode": "does not support plan mode",
	"image-attachment": "cannot receive image attachments",
	"autonomous-mode": "has no approval-bypass setting to turn on",
	"explicit-resume": "cannot resume the exact previous session",
};

/**
 * Explanatory text for one option the UI had to disable, e.g. "Pi does not
 * support plan mode." Null when the agent supports that setting, so a caller
 * can pass the result straight through as a conditional notice.
 */
export function describeUnsupportedTaskSetting(
	agentId: RuntimeAgentId | null | undefined,
	operation: RuntimeAgentLaunchOperation,
): string | null {
	if (!agentId) {
		return null;
	}
	// Every option is asked for at once: whether an agent supports one of them
	// never depends on what this particular task requested.
	const unsupported = getUnsupportedAgentLaunchOperations(agentId, {
		startInPlanMode: true,
		imagesRequested: true,
		autonomousModeRequested: true,
	});
	if (!unsupported.includes(operation)) {
		return null;
	}
	const label = getRuntimeAgentCatalogEntry(agentId)?.label ?? agentId;
	return `${label} ${SETTING_NOTICES[operation]}.`;
}

/**
 * Whether this agent can express a read-only planning request at all, so the UI
 * disables plan mode for the effective agent instead of promising a plan run
 * that cannot happen.
 */
export function agentSupportsPlanMode(agentId: RuntimeAgentId | null | undefined): boolean {
	if (!agentId) {
		return false;
	}
	return getRuntimeAgentCapabilities(agentId).planMode !== "none";
}

/** Whether image attachments actually reach this agent. */
export function agentSupportsImages(agentId: RuntimeAgentId | null | undefined): boolean {
	if (!agentId) {
		return false;
	}
	return getRuntimeAgentCapabilities(agentId).images;
}

/** Whether an approval-bypass request means anything for this agent. */
export function agentSupportsAutonomousMode(agentId: RuntimeAgentId | null | undefined): boolean {
	if (!agentId) {
		return false;
	}
	return getRuntimeAgentCapabilities(agentId).approvalMode !== "none";
}

/**
 * UI-facing helpers: an unknown agent (nothing selected yet) must not disable
 * anything, because the missing selection is reported by the agent picker.
 */
export function planModeUnsupported(agentId: RuntimeAgentId | null | undefined): boolean {
	return agentId !== null && agentId !== undefined && !agentSupportsPlanMode(agentId);
}

/** Whether the effective agent cannot receive the task's image attachments. */
export function imagesUnsupported(agentId: RuntimeAgentId | null | undefined): boolean {
	return agentId !== null && agentId !== undefined && !agentSupportsImages(agentId);
}

/**
 * The card's own agent override wins over the project/runtime default; that is
 * the same precedence the runtime applies when it launches the session, so the
 * UI disables what would actually run rather than what the dropdown shows.
 */
export function resolveEffectiveTaskAgentId(input: {
	taskAgentId?: RuntimeAgentId | undefined | null;
	defaultAgentId?: RuntimeAgentId | null | undefined;
	/** A session-recorded agent (trash resume) outranks both. */
	sessionAgentId?: RuntimeAgentId | null | undefined;
}): RuntimeAgentId | null {
	return input.sessionAgentId ?? input.taskAgentId ?? input.defaultAgentId ?? null;
}
