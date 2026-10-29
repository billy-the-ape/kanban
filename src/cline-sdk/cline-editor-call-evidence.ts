// Correlates the four stages of an editor tool call — raw transport fragments
// (pre-parse), the parsed SDK tool call, the pre-execution arguments, and the
// original execution result — into per-call evidence for the task diagnostics
// export.
//
// Interpretation contract: the comparison is strictly factual. "present-only-in-raw"
// means the loss occurred at or below the client argument-parsing boundary;
// "absent-in-both" means the raw provider response already omitted the field —
// upstream of the client boundary (model, inference-server tool parser, or an
// intervening gateway). It must never be presented as proven model error, and
// truncated / missing / unmatched evidence always yields "not-comparable".
import { readFileSync } from "node:fs";
import { getEditorTraceFileDestination } from "./cline-editor-trace";
import { EDITOR_TRANSPORT_CAPTURE_SCHEMA_VERSION, type EditorRawCaptureRecord } from "./cline-editor-transport-capture";
import type { ClineSdkPersistedMessage } from "./sdk-runtime-boundary";

export const EDITOR_CALL_EVIDENCE_SCHEMA_VERSION = 1;

/** Editor tool-call ids observed in a persisted transcript, in order. */
export function collectEditorToolCallIds(messages: readonly ClineSdkPersistedMessage[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content) {
			if (
				typeof part === "object" &&
				part !== null &&
				part.type === "tool_use" &&
				part.name === "editor" &&
				typeof part.id === "string" &&
				part.id.length > 0
			) {
				ids.push(part.id);
			}
		}
	}
	return ids;
}

/** Factual stage-to-stage comparison of `old_text` presence. Never a blame assignment. */
export type EditorCallComparison =
	| "present-in-both"
	| "present-only-in-raw"
	| "present-only-in-parsed"
	| "absent-in-both"
	| "not-comparable";

export type EditorStageStatus = "captured" | "unavailable" | "unmatched" | "ambiguous";

export interface EditorRawStageEvidence {
	status: EditorStageStatus;
	note: string | null;
	/** Complete raw records matched for this tool-call id (possibly several on retries/id reuse). */
	records: EditorRawCaptureRecord[];
	/** True when every matched record was captured completely (no truncation, stream completed, no parse errors). */
	complete: boolean;
}

export interface EditorInputStageEvidence {
	status: EditorStageStatus;
	note: string | null;
	ts: string | null;
	input: Record<string, unknown> | null;
	hasOldText: boolean | null;
	oldTextChars: number | null;
	newTextChars: number | null;
}

export interface EditorResultStageEvidence {
	status: EditorStageStatus;
	note: string | null;
	ts: string | null;
	/** The original execution result exactly as recorded (thrown-error text or raw tool output). Never modified. */
	result: unknown;
}

export interface EditorCallEvidence {
	toolCallId: string;
	raw: EditorRawStageEvidence;
	parsed: EditorInputStageEvidence;
	beforeExecution: EditorInputStageEvidence;
	result: EditorResultStageEvidence;
	comparison: EditorCallComparison | null;
	comparisonNote: string | null;
}

export interface TaskEditorCallEvidence {
	schemaVersion: typeof EDITOR_CALL_EVIDENCE_SCHEMA_VERSION;
	/**
	 * "captured" = every recorded editor call has all four stages completely
	 * captured; "partial" = some stage/record is missing, truncated, or
	 * unmatched; "unavailable" = no evidence was recorded for the session
	 * (capture disabled, or the session predates capture).
	 */
	status: "captured" | "partial" | "unavailable";
	reason: string | null;
	calls: EditorCallEvidence[];
	/** Raw captures recorded for the session that matched no known editor tool-call id. */
	unmatchedRawCaptures: number;
}

/** "unavailable" evidence for sessions with no recorded capture (also used by test fixtures). */
export function emptyTaskEditorCallEvidence(): TaskEditorCallEvidence {
	return {
		schemaVersion: EDITOR_CALL_EVIDENCE_SCHEMA_VERSION,
		status: "unavailable",
		reason: "no editor evidence was recorded for this session (capture disabled, or the session predates capture)",
		calls: [],
		unmatchedRawCaptures: 0,
	};
}

/** One parsed line of the shared editor-trace JSONL file. */
export interface TraceLine {
	ts: string;
	taskId?: string | null;
	sessionId?: string | null;
	phase?: string;
	toolCallId?: string;
	/** Hook stages (model-call / before-execution / result). */
	input?: unknown;
	hasOldText?: boolean | null;
	oldTextChars?: number | null;
	newTextChars?: number | null;
	result?: unknown;
	/** Raw transport capture (raw-arguments phase). */
	tsEnd?: string | null;
	requestId?: string;
	host?: string;
	argumentFragments?: unknown;
	assembledArguments?: unknown;
	assembledTruncated?: unknown;
	streamStatus?: string;
	aborted?: unknown;
	parseErrors?: unknown;
	model?: unknown;
	editorSchema?: unknown;
	schemaStatus?: unknown;
	[key: string]: unknown;
}

/** Reads the shared editor-trace JSONL, tolerating malformed or partial lines. */
export function readEditorTraceLines(destination?: string): TraceLine[] {
	const path = destination ?? getEditorTraceFileDestination();
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const lines: TraceLine[] = [];
	for (const line of content.split("\n")) {
		if (line.trim().length === 0) {
			continue;
		}
		try {
			const parsed = JSON.parse(line) as TraceLine;
			if (typeof parsed === "object" && parsed !== null && typeof parsed.ts === "string") {
				lines.push(parsed);
			}
		} catch {
			// A torn/partial line never breaks evidence collection.
		}
	}
	return lines;
}

function isRawLine(line: TraceLine): boolean {
	return line.phase === "raw-arguments";
}

function toRawRecord(line: TraceLine): EditorRawCaptureRecord {
	const editorSchema = line.editorSchema;
	return {
		schema: EDITOR_TRANSPORT_CAPTURE_SCHEMA_VERSION,
		ts: line.ts,
		tsEnd: typeof line.tsEnd === "string" ? line.tsEnd : null,
		taskId: typeof line.taskId === "string" ? line.taskId : null,
		sessionId: typeof line.sessionId === "string" ? line.sessionId : null,
		phase: "raw-arguments",
		requestId: typeof line.requestId === "string" ? line.requestId : "",
		host: typeof line.host === "string" ? line.host : "",
		toolCallId: typeof line.toolCallId === "string" ? line.toolCallId : "",
		toolName: "editor",
		argumentFragments: Array.isArray(line.argumentFragments)
			? line.argumentFragments.filter((fragment): fragment is string => typeof fragment === "string")
			: [],
		assembledArguments: typeof line.assembledArguments === "string" ? line.assembledArguments : "",
		assembledTruncated: line.assembledTruncated === true,
		streamStatus:
			line.streamStatus === "completed" || line.streamStatus === "ended-early" || line.streamStatus === "interrupted"
				? line.streamStatus
				: "interrupted",
		aborted: line.aborted === true,
		parseErrors: typeof line.parseErrors === "number" ? line.parseErrors : 0,
		model: typeof line.model === "string" ? line.model : null,
		editorSchema:
			typeof editorSchema === "object" && editorSchema !== null
				? {
						properties:
							typeof (editorSchema as { properties?: unknown }).properties === "object" &&
							(editorSchema as { properties?: unknown }).properties !== null
								? ((editorSchema as { properties: Record<string, unknown> }).properties as Record<
										string,
										unknown
									>)
								: {},
						required: Array.isArray((editorSchema as { required?: unknown }).required)
							? (editorSchema as { required: unknown[] }).required.filter(
									(value): value is string => typeof value === "string",
								)
							: [],
					}
				: null,
		schemaStatus: line.schemaStatus === "captured" ? "captured" : "unavailable",
	};
}

function inputFieldsOf(input: unknown): Record<string, unknown> {
	return input !== null && typeof input === "object" && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

/**
 * Correlates the recorded stages for one session.
 *
 * @param sessionId the session to collect evidence for.
 * @param knownEditorToolCallIds editor tool-call ids observed in the durable
 *   transcript (tool_use parts) — the union with ids seen in hook records forms
 *   the call set.
 * @param lines all shared-trace lines (callers pass a single read per export).
 */
export function collectTaskEditorCallEvidence(input: {
	sessionId: string;
	knownEditorToolCallIds: readonly string[];
	lines?: TraceLine[];
}): TaskEditorCallEvidence {
	const lines = input.lines ?? readEditorTraceLines();
	const sessionLines = lines.filter((line) => line.sessionId === input.sessionId);
	const sessionRawLines = sessionLines.filter(isRawLine);
	// Raw records attributed to another session can still match by tool-call id
	// when no session attribution was possible at capture time (concurrent
	// sessions on one provider host).
	const unattributedRawLines = lines.filter(
		(line) => isRawLine(line) && line.sessionId === null && line.toolCallId !== null,
	);
	const sessionRawRecords = sessionRawLines.map(toRawRecord);
	const unattributedRawRecords = unattributedRawLines.map(toRawRecord);
	const hookLines = sessionLines.filter(
		(line) => line.phase === "model-call" || line.phase === "before-execution" || line.phase === "result",
	);

	const knownIds: string[] = [
		...new Set([
			...input.knownEditorToolCallIds,
			...hookLines
				.map((line) => line.toolCallId)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		]),
	];
	const hasAnyEvidence =
		sessionLines.length > 0 || unattributedRawRecords.some((record) => knownIds.includes(record.toolCallId));
	if (knownIds.length === 0 && sessionRawRecords.length === 0) {
		return {
			schemaVersion: EDITOR_CALL_EVIDENCE_SCHEMA_VERSION,
			status: hasAnyEvidence ? "partial" : "unavailable",
			reason: hasAnyEvidence
				? "no editor tool calls were recorded for this session"
				: "no editor evidence was recorded for this session (capture disabled, or the session predates capture)",
			calls: [],
			unmatchedRawCaptures: 0,
		};
	}

	const calls: EditorCallEvidence[] = [];
	const matchedRawKeys = new Set<string>();

	for (const callId of knownIds) {
		const matched = [
			...sessionRawRecords,
			...unattributedRawRecords.filter((record) => record.toolCallId === callId),
		].filter((record) => record.toolCallId === callId);
		for (const record of matched) {
			matchedRawKeys.add(`${record.requestId}:${record.host}:${record.toolCallId}`);
		}
		let raw: EditorRawStageEvidence;
		let rawComplete = false;
		if (matched.length === 0) {
			raw = {
				status: sessionRawRecords.length === 0 && unattributedRawRecords.length === 0 ? "unavailable" : "unmatched",
				note:
					sessionRawRecords.length === 0 && unattributedRawRecords.length === 0
						? "no raw transport capture was recorded for this session"
						: "no raw transport capture matched this tool-call id",
				records: [],
				complete: false,
			};
		} else if (matched.length === 1) {
			const record = matched[0];
			rawComplete = !record.assembledTruncated && record.streamStatus === "completed" && record.parseErrors === 0;
			raw = {
				status: "captured",
				note: rawComplete ? null : describeRawIncompleteness(record),
				records: [record],
				complete: rawComplete,
			};
		} else {
			raw = {
				status: "ambiguous",
				note: `${matched.length} raw captures share this tool-call id (retry or id reuse across requests); each is listed`,
				records: matched,
				complete: false,
			};
		}
		const parsed = buildInputStageFor(callId, hookLines);
		const beforeExecution = buildInputStageFor(callId, hookLines, "before-execution");
		const resultLine = hookLines.find((line) => line.phase === "result" && line.toolCallId === callId);
		const result: EditorResultStageEvidence = resultLine
			? {
					status: "captured",
					note: null,
					ts: typeof resultLine.ts === "string" ? resultLine.ts : null,
					result: resultLine.result,
				}
			: {
					status: "unavailable",
					note: "no recorded stage (capture disabled at the time, or the record was not written)",
					ts: null,
					result: null,
				};

		const { comparison, comparisonNote } = compareStages(raw, parsed);

		calls.push({
			toolCallId: callId,
			raw,
			parsed,
			beforeExecution,
			result,
			comparison,
			comparisonNote,
		});
	}

	const unmatchedRaw =
		sessionRawRecords.filter(
			(record) => !matchedRawKeys.has(`${record.requestId}:${record.host}:${record.toolCallId}`),
		).length +
		unattributedRawRecords.filter(
			(record) =>
				!matchedRawKeys.has(`${record.requestId}:${record.host}:${record.toolCallId}`) &&
				!knownIds.includes(record.toolCallId),
		).length;

	const problems: string[] = [];
	if (unmatchedRaw > 0) {
		problems.push(`${unmatchedRaw} raw capture(s) did not match any recorded editor tool-call id`);
	}
	let allComplete = calls.length > 0;
	for (const call of calls) {
		if (
			call.raw.status !== "captured" ||
			!call.raw.complete ||
			call.parsed.status !== "captured" ||
			call.beforeExecution.status !== "captured" ||
			call.result.status !== "captured"
		) {
			allComplete = false;
		}
	}
	if (calls.length === 0) {
		allComplete = false;
		problems.push("no editor tool calls with recorded stages");
	}
	const status: TaskEditorCallEvidence["status"] = allComplete && unmatchedRaw === 0 ? "captured" : "partial";
	return {
		schemaVersion: EDITOR_CALL_EVIDENCE_SCHEMA_VERSION,
		status,
		reason: problems.length > 0 ? problems.join("; ") : null,
		calls,
		unmatchedRawCaptures: unmatchedRaw,
	};
}

function buildInputStageFor(
	callId: string,
	hookLines: TraceLine[],
	phase: "model-call" | "before-execution" = "model-call",
): EditorInputStageEvidence {
	const line = hookLines.find((candidate) => candidate.phase === phase && candidate.toolCallId === callId);
	if (!line) {
		return {
			status: "unavailable",
			note: "no recorded stage (capture disabled at the time, or the record was not written)",
			ts: null,
			input: null,
			hasOldText: null,
			oldTextChars: null,
			newTextChars: null,
		};
	}
	const fields = inputFieldsOf(line.input);
	return {
		status: "captured",
		note: null,
		ts: typeof line.ts === "string" ? line.ts : null,
		input: fields,
		hasOldText: Object.hasOwn(fields, "old_text"),
		oldTextChars: typeof fields.old_text === "string" ? fields.old_text.length : null,
		newTextChars: typeof fields.new_text === "string" ? fields.new_text.length : null,
	};
}

function describeRawIncompleteness(record: EditorRawCaptureRecord): string {
	const parts: string[] = [];
	if (record.assembledTruncated) {
		parts.push("assembled argument text truncated at the capture cap");
	}
	if (record.streamStatus !== "completed") {
		parts.push(
			`stream ${record.streamStatus === "interrupted" ? "interrupted before completion" : "ended without data: [DONE]"}`,
		);
	}
	if (record.parseErrors > 0) {
		parts.push(`${record.parseErrors} SSE data line(s) were not valid JSON`);
	}
	return parts.length > 0 ? parts.join("; ") : "raw capture incomplete";
}

function compareStages(
	raw: EditorRawStageEvidence,
	parsed: EditorInputStageEvidence,
): { comparison: EditorCallComparison | null; comparisonNote: string | null } {
	if (raw.status !== "captured" || !raw.complete || parsed.status !== "captured") {
		const reasons: string[] = [];
		if (raw.status !== "captured") {
			reasons.push(`raw stage ${raw.status}`);
		} else if (!raw.complete) {
			reasons.push(`raw capture incomplete${raw.note ? ` (${raw.note})` : ""}`);
		}
		if (parsed.status !== "captured") {
			reasons.push(`parsed stage ${parsed.status}`);
		}
		return {
			comparison: "not-comparable",
			comparisonNote: reasons.length > 0 ? `not comparable: ${reasons.join("; ")}` : "not comparable",
		};
	}
	const record = raw.records[0];
	if (!record) {
		return { comparison: "not-comparable", comparisonNote: "not comparable: raw record missing" };
	}
	let rawArgs: Record<string, unknown> | null = null;
	try {
		const parsedJson = JSON.parse(record.assembledArguments);
		if (typeof parsedJson === "object" && parsedJson !== null && !Array.isArray(parsedJson)) {
			rawArgs = parsedJson as Record<string, unknown>;
		}
	} catch {
		return {
			comparison: "not-comparable",
			comparisonNote: "not comparable: the raw argument text is not valid JSON (no inference made)",
		};
	}
	if (rawArgs === null) {
		return {
			comparison: "not-comparable",
			comparisonNote: "not comparable: the raw argument text is not a JSON object (no inference made)",
		};
	}
	const rawHasOldText = Object.hasOwn(rawArgs, "old_text");
	const parsedHasOldText = parsed.hasOldText === true;
	if (rawHasOldText && parsedHasOldText) {
		return { comparison: "present-in-both", comparisonNote: null };
	}
	if (rawHasOldText && !parsedHasOldText) {
		return {
			comparison: "present-only-in-raw",
			comparisonNote:
				"the raw provider response contained old_text but the parsed SDK tool call did not; the loss occurred at or below the client argument-parsing boundary",
		};
	}
	if (!rawHasOldText && parsedHasOldText) {
		return {
			comparison: "present-only-in-parsed",
			comparisonNote:
				"the parsed SDK tool call contained old_text but the captured raw fragments did not; treat as inconclusive (capture mismatch)",
		};
	}
	return {
		comparison: "absent-in-both",
		comparisonNote:
			"the raw provider response already omitted old_text; the omission is upstream of the client boundary (model, inference-server tool parser, or an intervening gateway) and is not proven model error",
	};
}
