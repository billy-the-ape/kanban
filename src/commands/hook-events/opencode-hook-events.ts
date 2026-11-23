// AA-O1b: turns the payload reported by Kanban's generated OpenCode bridge into
// the bounded activity metadata every agent integration shares. The bridge is
// Kanban's own code, so these are Kanban's own field names in snake_case, and
// explicit CLI flags always win over anything read here.
import type { RuntimeHookEvent, RuntimeTaskHookActivity } from "../../core/api-contract";
import { normalizeWhitespace, readStringField } from "./hook-utils";

interface NormalizeOpenCodeHookMetadataArgs {
	event: RuntimeHookEvent;
	payload: Record<string, unknown> | null;
	flagMetadata: Partial<RuntimeTaskHookActivity>;
	sourceHint?: string | null;
}

const OPENCODE_ACTIVITY_LIMIT = 600;

function clip(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * The bridge writes its own sentence for every event that parks or finishes a
 * card, so this only fills the tool and turn lines it leaves empty. The wording
 * follows what the bridge actually observed; nothing here is invented from an
 * event name alone.
 */
function inferOpenCodeActivityText(args: {
	event: RuntimeHookEvent;
	hookEventName: string | null;
	toolName: string | null;
	notificationType: string | null;
	toolInputSummary: string | null;
	finalMessage: string | null;
}): string | null {
	const { event, hookEventName, toolName, notificationType, toolInputSummary, finalMessage } = args;
	switch (hookEventName) {
		case "BeforeTool":
		case "PreToolUse": {
			const target = toolName ?? "a tool";
			return toolInputSummary ? `Running ${target}: ${clip(toolInputSummary, 200)}` : `Running ${target}`;
		}
		case "AfterTool":
		case "PostToolUse":
			return toolName ? `Completed ${toolName}` : "Completed a tool";
		case "PostToolUseFailure":
			return toolName ? `Failed ${toolName}` : "A tool failed";
		case "PermissionRequest":
			// The bridge always sends the approval sentence itself, so this only
			// covers a payload that arrived without one.
			return notificationType === "permission.asked" ? "OpenCode is waiting for approval" : null;
		default:
			if (event === "to_review") {
				return finalMessage
					? `Final: ${clip(finalMessage, OPENCODE_ACTIVITY_LIMIT)}`
					: "OpenCode finished the turn";
			}
			if (event === "to_in_progress") {
				return "OpenCode is working";
			}
			return null;
	}
}

/**
 * The bridge reports the assistant's text, the approval summary and the tool
 * detail under its own keys, so this normalizer owns them. Without it the shared
 * parser accepts the call, records the transition, and silently drops the text:
 * the card would move without ever showing what the turn said.
 */
export function normalizeOpenCodeHookMetadata({
	event,
	payload,
	flagMetadata,
	sourceHint,
}: NormalizeOpenCodeHookMetadataArgs): Partial<RuntimeTaskHookActivity> | undefined {
	const read = (key: string, ...aliases: string[]) => {
		if (!payload) {
			return null;
		}
		for (const name of [key, ...aliases]) {
			const value = readStringField(payload, name);
			if (value) {
				return value;
			}
		}
		return null;
	};
	const hookEventName = flagMetadata.hookEventName ?? read("hook_event_name", "hookEventName");
	const toolName = flagMetadata.toolName ?? read("tool_name", "toolName");
	const notificationType = flagMetadata.notificationType ?? read("notification_type", "notificationType");
	const toolInputSummary = flagMetadata.toolInputSummary ?? read("tool_input_summary", "toolInputSummary");
	const finalMessage =
		flagMetadata.finalMessage ??
		read("final_message", "finalMessage", "last_assistant_message", "lastAssistantMessage");
	const activityText =
		flagMetadata.activityText ??
		read("activity_text", "activityText") ??
		inferOpenCodeActivityText({ event, hookEventName, toolName, notificationType, toolInputSummary, finalMessage });

	const merged: Partial<RuntimeTaskHookActivity> = {
		source: flagMetadata.source ?? sourceHint ?? "opencode",
		hookEventName,
		toolName,
		notificationType,
		toolInputSummary: toolInputSummary ? clip(normalizeWhitespace(toolInputSummary), 400) : null,
		finalMessage: finalMessage ? normalizeWhitespace(finalMessage) : null,
		activityText: activityText ? normalizeWhitespace(clip(activityText, OPENCODE_ACTIVITY_LIMIT)) : null,
	};

	const hasValue = Object.values(merged).some(
		(value) => (typeof value === "string" && value.trim().length > 0) || typeof value === "number",
	);
	if (!hasValue) {
		return undefined;
	}

	return merged;
}
