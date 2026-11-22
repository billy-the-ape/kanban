// AA-P1: turns the payload reported by Kanban's Pi extension into the bounded
// activity metadata every agent integration shares. Pi has no hook payloads of
// its own, so this reads only Kanban's own field names, and explicit CLI flags
// always win over inference.
import type { RuntimeHookEvent, RuntimeTaskHookActivity } from "../../core/api-contract";
import { normalizeWhitespace, readStringField } from "./hook-utils";

interface NormalizePiHookMetadataArgs {
	event: RuntimeHookEvent;
	payload: Record<string, unknown> | null;
	flagMetadata: Partial<RuntimeTaskHookActivity>;
	sourceHint?: string | null;
}

const PI_ACTIVITY_LIMIT = 600;

function readPiSessionReason(payload: Record<string, unknown> | null): string | null {
	return payload ? readStringField(payload, "pi_session_reason") : null;
}

function readPiError(payload: Record<string, unknown> | null): string | null {
	if (!payload) {
		return null;
	}
	return readStringField(payload, "pi_error") ?? readStringField(payload, "error");
}

function clip(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function inferPiActivityText(args: {
	event: RuntimeHookEvent;
	hookEventName: string | null;
	toolName: string | null;
	notificationType: string | null;
	finalMessage: string | null;
	payload: Record<string, unknown> | null;
}): string | null {
	const { event, hookEventName, toolName, notificationType, finalMessage, payload } = args;
	switch (hookEventName) {
		case "session_start": {
			const reason = readPiSessionReason(payload);
			return reason ? `Pi session ${reason}` : "Pi session started";
		}
		case "agent_start":
			return "Pi is working";
		case "tool_execution_end": {
			const target = toolName ?? "tool";
			return notificationType === "error" ? `Failed ${target}` : `Completed ${target}`;
		}
		case "model_select": {
			const model = payload ? readStringField(payload, "pi_model") : null;
			return model ? `Model: ${model}` : "Model changed";
		}
		case "ui_prompt_start":
			return "Pi is waiting for input in the terminal";
		case "ui_prompt_end":
			return "Pi resumed the turn after the terminal prompt";
		case "agent_settled": {
			if (notificationType === "aborted") {
				return "Pi stopped before finishing the turn";
			}
			if (notificationType === "error") {
				const failure = readPiError(payload);
				return failure ? `Pi stopped: ${clip(failure, PI_ACTIVITY_LIMIT)}` : "Pi stopped after an error";
			}
			return finalMessage ? `Final: ${clip(finalMessage, PI_ACTIVITY_LIMIT)}` : "Pi finished the turn";
		}
		case "session_before_switch":
		case "session_before_fork":
			return "Kanban kept this task in its own Pi session";
		case "session_changed":
			return "Pi switched away from the Kanban session; this card no longer follows it";
		default:
			// An unrecognized Pi event name carries no meaning of its own, so
			// only the coarse Kanban event is used and nothing is invented.
			if (event === "to_review") {
				return finalMessage ? `Final: ${clip(finalMessage, PI_ACTIVITY_LIMIT)}` : "Pi finished the turn";
			}
			return null;
	}
}

/**
 * `pi_session_id` / `pi_session_file` are recorded as part of the activity only
 * through the fields the shared contract has room for; the session identity
 * itself stays in the launch record, so nothing here is inferred from it.
 */
export function normalizePiHookMetadata({
	event,
	payload,
	flagMetadata,
	sourceHint,
}: NormalizePiHookMetadataArgs): Partial<RuntimeTaskHookActivity> | undefined {
	const hookEventName =
		flagMetadata.hookEventName ?? (payload ? readStringField(payload, "hook_event_name") : null) ?? null;
	const toolName = flagMetadata.toolName ?? (payload ? readStringField(payload, "tool_name") : null) ?? null;
	const notificationType =
		flagMetadata.notificationType ?? (payload ? readStringField(payload, "notification_type") : null) ?? null;
	const finalMessage =
		flagMetadata.finalMessage ??
		(payload ? (readStringField(payload, "final_message") ?? readStringField(payload, "finalMessage")) : null) ??
		null;
	const activityText =
		flagMetadata.activityText ??
		inferPiActivityText({ event, hookEventName, toolName, notificationType, finalMessage, payload });
	const normalizedFinalMessage = finalMessage ? normalizeWhitespace(finalMessage) : null;

	const merged: Partial<RuntimeTaskHookActivity> = {
		source: flagMetadata.source ?? sourceHint ?? "pi",
		hookEventName,
		toolName,
		notificationType,
		finalMessage: normalizedFinalMessage,
		activityText: activityText ? normalizeWhitespace(clip(activityText, PI_ACTIVITY_LIMIT)) : null,
	};

	const hasValue = Object.values(merged).some(
		(value) => (typeof value === "string" && value.trim().length > 0) || typeof value === "number",
	);
	if (!hasValue) {
		return undefined;
	}

	return merged;
}
