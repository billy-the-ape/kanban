import { type ClineToolCallDisplay, getClineToolCallDisplay } from "@runtime-cline-tool-call-display";
import type { ClineChatMessage } from "@/hooks/use-cline-chat-session";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { stripAnsi } from "@/utils/strip-ansi";

export interface ParsedToolMessageContent {
	toolName: string;
	input: string | null;
	output: string | null;
	error: string | null;
	durationMs: number | null;
}

/**
 * Extracts a short, human-readable summary from the tool's input parameters.
 * Uses tool-specific logic for known Cline SDK tools, then falls back to generic extraction.
 */
export function getToolSummary(toolName: string, input: string | null): string | null {
	return getClineToolCallDisplay(toolName, input).inputSummary;
}

/**
 * Returns the full display object for a tool call, including a display-friendly
 * tool name (e.g. "Creating task" for kanban commands) and input summary.
 */
export function getToolDisplay(toolName: string, input: string | null): ClineToolCallDisplay {
	return getClineToolCallDisplay(toolName, input);
}

/**
 * Formats the raw tool input into a string for the expanded view.
 * For run_commands, this extracts the full command list so users can see the complete
 * commands that were executed (readability preserved from the original behaviour).
 * For every other tool, the exact recorded input is shown: pretty-printed when it parses
 * as a JSON object/array, otherwise the raw recorded text. Recorded input must not
 * disappear solely because the tool is not run_commands.
 * Returns null when the input adds no value beyond the collapsed summary.
 */
export function formatToolInputForDisplay(toolName: string, input: string | null): string | null {
	if (!input) {
		return null;
	}

	const normalized = toolName.toLowerCase().replace(/[^a-z]/g, "");

	if (normalized === "runcommands") {
		try {
			const parsed: unknown = JSON.parse(input);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const record = parsed as Record<string, unknown>;
				if (Array.isArray(record.commands)) {
					const commands = record.commands.map((cmd) => String(cmd)).filter((cmd) => cmd.length > 0);
					if (commands.length > 0) {
						return commands.join("\n");
					}
				}
			}
		} catch {
			// Invalid JSON: run_commands has no readable command view.
		}
		return null;
	}

	try {
		const parsed: unknown = JSON.parse(input);
		if (typeof parsed === "object" && parsed !== null) {
			return JSON.stringify(parsed, null, 2);
		}
	} catch {
		// Raw (non-JSON) input: show the recorded text as-is.
	}
	return input;
}

/**
 * Section label for the expanded tool input block: "Command" for run_commands
 * (readable joined commands), "Input" for every other tool (recorded JSON).
 */
export function getToolInputSectionLabel(toolName: string): string {
	return toolName.toLowerCase().replace(/[^a-z]/g, "") === "runcommands" ? "Command" : "Input";
}

/**
 * Detects persisted excerpts in tool output/error prose: the `Full content:` reference,
 * the `full output: <path>` reference, or a `...[truncated ...]` marker written by the
 * tool-result bounding hook. Used only to label the UI section as an excerpt.
 */
export function isExcerptedToolText(text: string): boolean {
	return text.includes("Full content:") || text.includes("full output:") || text.includes("[truncated");
}

export interface ToolOutputResult {
	query: string;
	content: string;
	error: string | null;
	success: boolean;
}

export interface ParsedToolOutput {
	results: ToolOutputResult[];
}

function isToolOperationResult(
	value: unknown,
): value is { query: string; result: string; success: boolean; error?: string } {
	if (typeof value !== "object" || value === null) return false;
	if (!("success" in value) || !("result" in value)) return false;
	const obj = value as Record<string, unknown>;
	return typeof obj.result === "string" && typeof obj.success === "boolean";
}

function toToolOutputResult(item: {
	query: string;
	result: string;
	success: boolean;
	error?: string;
}): ToolOutputResult {
	return {
		query: String(item.query ?? ""),
		content: stripAnsi(item.result),
		error: typeof item.error === "string" ? stripAnsi(item.error) : null,
		success: item.success,
	};
}

/**
 * Parses raw tool output JSON into structured results.
 * Handles both single ToolOperationResult and ToolOperationResult[] (batch tools).
 */
export function parseToolOutput(output: string): ParsedToolOutput | null {
	try {
		const parsed: unknown = JSON.parse(output);

		if (Array.isArray(parsed) && parsed.length > 0 && isToolOperationResult(parsed[0])) {
			return { results: parsed.filter(isToolOperationResult).map(toToolOutputResult) };
		}

		if (isToolOperationResult(parsed)) {
			return { results: [toToolOutputResult(parsed)] };
		}
	} catch {
		return null;
	}

	return null;
}

function normalizeSectionValue(lines: string[]): string | null {
	const value = lines.join("\n").trim();
	return value.length > 0 ? value : null;
}

/**
 * Parses the persisted line-oriented tool message format (Tool:/Input:/Output:/Error:/
 * Duration: sections).
 *
 * Known limitation: section detection matches lines that are exactly `Input:`, `Output:`,
 * `Error:`, or start with `Tool:` / `Duration:`. A raw (non-JSON) string output containing
 * a line that is exactly `Error:` (or another section prefix) will be mis-sectioned.
 * Pretty-printed JSON inputs/outputs are safe because JSON strings are escaped. The
 * diagnostics export deliberately avoids this parsing.
 */
export function parseToolMessageContent(content: string): ParsedToolMessageContent {
	const lines = content.split("\n");
	let toolName = "unknown";
	let durationMs: number | null = null;

	const sections = {
		input: [] as string[],
		output: [] as string[],
		error: [] as string[],
	};

	type ActiveSection = keyof typeof sections | null;
	let activeSection: ActiveSection = null;

	for (const line of lines) {
		if (line.startsWith("Tool:")) {
			toolName = line.slice("Tool:".length).trim() || "unknown";
			activeSection = null;
			continue;
		}
		if (line === "Input:") {
			activeSection = "input";
			continue;
		}
		if (line === "Output:") {
			activeSection = "output";
			continue;
		}
		if (line === "Error:") {
			activeSection = "error";
			continue;
		}
		if (line.startsWith("Duration:")) {
			activeSection = null;
			const durationMatch = /Duration:\s*(\d+)ms/i.exec(line);
			if (durationMatch?.[1]) {
				durationMs = Number.parseInt(durationMatch[1], 10);
			}
			continue;
		}
		if (activeSection) {
			sections[activeSection].push(line);
		}
	}

	const rawOutput = normalizeSectionValue(sections.output);
	const rawError = normalizeSectionValue(sections.error);

	return {
		toolName,
		input: normalizeSectionValue(sections.input),
		output: rawOutput !== null ? stripAnsi(rawOutput) : null,
		error: rawError !== null ? stripAnsi(rawError) : null,
		durationMs,
	};
}

/** Identify the final response after SDK end events or a persisted Done task reload. */
export function getCompletedAssistantMessageId(
	messages: ClineChatMessage[],
	summary: RuntimeTaskSessionSummary | null,
	taskColumnId: string,
): string | null {
	if (summary?.reviewReason === "error" || summary?.reviewReason === "interrupted") {
		return null;
	}
	const finalText = summary?.latestHookActivity?.finalMessage?.trim();
	const hasCompletionEvent = summary?.latestHookActivity?.hookEventName === "agent_end" && Boolean(finalText);
	if (!hasCompletionEvent && taskColumnId !== "done") {
		return null;
	}
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") {
			return message.content.trim() && (taskColumnId === "done" || message.content.trim() === finalText)
				? message.id
				: null;
		}
	}
	return null;
}
