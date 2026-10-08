import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ClineSdkAgentHooks, resolveClineSdkDataDir } from "./sdk-runtime-boundary";

/** Temporary opt-in evidence capture; remove this module and its session wiring after diagnostics replaces it. */
export function createClineEditorTraceHooks(taskId: string, sessionId: string): ClineSdkAgentHooks {
	if (process.env.KANBAN_TRACE_EDITOR !== "1") return {};
	const destination = join(resolveClineSdkDataDir(), "logs", "editor-trace.jsonl");
	const write = (phase: string, toolCallId: string, input: unknown, evidence: Record<string, unknown> = {}) => {
		try {
			const fields = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
			const line = JSON.stringify({
				ts: new Date().toISOString(),
				taskId,
				sessionId,
				phase,
				toolCallId,
				input,
				hasOldText: Object.hasOwn(fields, "old_text"),
				oldTextChars: typeof fields.old_text === "string" ? fields.old_text.length : null,
				newTextChars: typeof fields.new_text === "string" ? fields.new_text.length : null,
				...evidence,
			});
			mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
			appendFileSync(destination, `${line}\n`, { encoding: "utf8", mode: 0o600 });
		} catch {
			// Trace failures must never affect tool execution or the agent loop.
		}
	};
	return {
		afterModel: ({ assistantMessage }) => {
			for (const part of assistantMessage.content) {
				if (part.type === "tool-call" && part.toolName === "editor") {
					write("model-call", part.toolCallId, part.input, { metadata: part.metadata });
				}
			}
			return undefined;
		},
		beforeTool: ({ toolCall, input }) => {
			if (toolCall.toolName === "editor") write("before-execution", toolCall.toolCallId, input);
			return undefined;
		},
		afterTool: ({ toolCall, input, result }) => {
			if (toolCall.toolName === "editor") write("result", toolCall.toolCallId, input, { result });
			return undefined;
		},
	};
}
