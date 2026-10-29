import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ClineSdkAgentHooks, resolveClineSdkDataDir } from "./sdk-runtime-boundary";

/** Best-effort cap for the shared editor-trace file (bytes). */
export const MAX_TRACE_FILE_BYTES = 32_000_000;

let traceFileLimitNotified = false;

/** Shared editor-trace file destination (hook stages and raw transport captures). */
export function getEditorTraceFileDestination(): string {
	return join(resolveClineSdkDataDir(), "logs", "editor-trace.jsonl");
}

/**
 * Appends one JSONL record to the shared editor-trace file. Best effort: any
 * filesystem failure is swallowed (logging must not fail a task). Created
 * files use 0600 permissions. Once the file reaches the size cap, a single
 * `capture-limit-reached` marker is appended and further writes are skipped.
 */
export function appendEditorTraceRecord(record: Record<string, unknown>): void {
	try {
		const destination = getEditorTraceFileDestination();
		mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
		try {
			const size = statSync(destination).size;
			if (size >= MAX_TRACE_FILE_BYTES) {
				if (!traceFileLimitNotified) {
					traceFileLimitNotified = true;
					appendFileSync(
						destination,
						`${JSON.stringify({
							schema: 1,
							ts: new Date().toISOString(),
							phase: "capture-limit-reached",
							note: `Editor trace file reached its ${MAX_TRACE_FILE_BYTES}-byte cap; further records were not written.`,
						})}\n`,
						{ encoding: "utf8", mode: 0o600 },
					);
				}
				return;
			}
		} catch {
			// The file may not exist yet; the first append creates it.
		}
		appendFileSync(destination, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		// Trace failures must never affect tool execution or the agent loop.
	}
}

/** Temporary opt-in evidence capture; remove this module and its session wiring after diagnostics replaces it. */
export function createClineEditorTraceHooks(taskId: string, sessionId: string): ClineSdkAgentHooks {
	if (process.env.KANBAN_TRACE_EDITOR !== "1") return {};
	const write = (phase: string, toolCallId: string, input: unknown, evidence: Record<string, unknown> = {}) => {
		const fields = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
		appendEditorTraceRecord({
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
