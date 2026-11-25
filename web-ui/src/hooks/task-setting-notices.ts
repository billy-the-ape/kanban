import {
	describeUnsupportedTaskSetting,
	imagesUnsupported,
	planModeUnsupported,
} from "@runtime-task-launch-requirements";
import type { RuntimeAgentId } from "@/runtime/types";

/**
 * The explanatory text beside a launch setting the effective agent cannot honor.
 *
 * The rule itself lives in `src/core/task-launch-requirements.ts` so the browser
 * and the runtime answer with the same capability table; this module only turns
 * that answer into what a form should show. Keeping it out of the editor hook
 * means the create form, the edit form and their tests share one definition.
 */
export interface TaskSettingNotices {
	/** True when the plan-mode option must be disabled rather than deselected. */
	planModeDisabled: boolean;
	/** Why plan mode is unavailable, or null when the option is usable. */
	planModeNotice: string | null;
	/** Why image attachments would be dropped, or null when they can be sent. */
	attachmentsNotice: string | null;
}

const FALLBACK_PLAN_MODE_NOTICE = "The selected agent does not support plan mode.";
const FALLBACK_ATTACHMENTS_NOTICE = "The selected agent cannot receive image attachments.";

export function resolveTaskSettingNotices(input: {
	/** The agent that would actually run the task (its override, else the default). */
	agentId: RuntimeAgentId | null | undefined;
	/**
	 * The card already asked for plan mode. Disabling the option then *clears* a
	 * saved setting, and silently dropping plan mode would let the user start an
	 * Act run believing they had asked for a plan — so the edit says it out loud.
	 */
	storedPlanModeRequested?: boolean;
	/** There is something to attach right now (a draft image or a saved one). */
	hasAttachments?: boolean;
	/** The attachments belong to the saved card rather than to an unsent draft. */
	storedAttachments?: boolean;
}): TaskSettingNotices {
	const planModeDisabled = planModeUnsupported(input.agentId);
	const planModeNotice = planModeDisabled
		? `${input.storedPlanModeRequested ? "Saved setting cleared. " : ""}${
				describeUnsupportedTaskSetting(input.agentId, "plan-mode") ?? FALLBACK_PLAN_MODE_NOTICE
			}`
		: null;
	const attachmentsNotice = imagesUnsupported(input.agentId)
		? `${
				input.storedAttachments
					? "Saved attachments cannot be sent: "
					: input.hasAttachments
						? "These attachments cannot be sent: "
						: ""
			}${describeUnsupportedTaskSetting(input.agentId, "image-attachment") ?? FALLBACK_ATTACHMENTS_NOTICE}`
		: null;
	return { planModeDisabled, planModeNotice, attachmentsNotice };
}
