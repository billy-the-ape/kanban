// DIAG-PANEL — pure, versioned task-quality summary reducer for the
// diagnostics panel.
//
// This module owns:
// - `analyzeTaskQualitySummary`: a deterministic analysis over a minimal
//   structural input (session kinds, headers, messages, tool-origin
//   annotations). No I/O, no SDK schema duplication, no classification
//   framework, no LLM. The same reducer can analyze a live export snapshot
//   (`adaptSessionSnapshotToSessions`) or a downloaded schemaVersion 3
//   bundle (`adaptExportedV3PlanSessions`) in a local script/test without a
//   server or a model call.
// - `buildTaskQualitySummaryResponse` /
//   `buildUnavailableTaskQualitySummaryResponse`: thin response assembly
//   with explicit capture completeness (complete/partial/unavailable) and
//   reasons. Historical exports cannot establish exact executing-agent
//   runtime; the summary only reports recorded session spans, reported
//   usage counters, and structural tool evidence — never active runtime.
//
// Deduplication rules (docs/plans/diagnostics-task-quality-summary.md):
// - Messages dedupe on (role, canonical content, ts, metrics, model info).
//   Stable ids are a fast path; conflicting id reuse is reported as an
//   ambiguity, never silently merged.
// - Tool calls dedupe on (tool id, tool name, canonical arguments). An id
//   alone is not enough when evidence conflicts; distinct ids with identical
//   arguments are separate calls (potential retries). Seeded/compacted
//   copies count once, keeping the first observed reference as evidence.
// - `liveTail` display messages are never counted; the gap is exposed.
// - Sessions themselves are deduplicated before any counting.

import type {
	ClineTaskExportKind,
	ClineTaskExportSegmentHeader,
	ClineTaskExportSnapshot,
	ClineTaskExportToolOrigin,
	ClineTaskExportToolOriginEntry,
} from "../cline-sdk/cline-task-export-snapshot";
import type { ClineSdkPersistedMessage } from "../cline-sdk/sdk-runtime-boundary";
import type { RuntimeTaskQualitySummaryResponse } from "./api-contract";
import { TASK_ARTIFACT_TRUNCATION_MARKER_PATTERN } from "./task-diagnostics-export-artifacts";
import type { TaskDiagnosticsExportV3Plan } from "./task-diagnostics-export-v3";

/** Version of the reducer's analysis semantics (bump when rules change). */
export const TASK_QUALITY_SUMMARY_VERSION = 1;

/** Structural tool part analyzed by the reducer (no SDK schema duplication). */
export interface TaskQualitySummaryToolPart {
	/** Index of the part inside the original message's content array. */
	index: number;
	kind: "tool_use" | "tool_result";
	toolCallId: string;
	/** Tool name for tool_use parts; null otherwise/unknown. */
	toolName: string | null;
	/** Raw tool_use input (for command extraction only; never echoed out). */
	arguments: unknown;
	/** Canonicalized argument comparison key (sorted object key order). */
	argumentKey: string | null;
	/** tool_result `is_error` flag. */
	isResultError: boolean;
	/** Extracted tool result text (string or joined text blocks). */
	resultText: string | null;
	/** Origin annotation from the snapshot's toolOrigins (Decision 4). */
	origin: ClineTaskExportToolOrigin;
}

export interface TaskQualitySummaryMetrics {
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
}

/** Structural persisted message analyzed by the reducer. */
export interface TaskQualitySummaryMessage {
	id: string | null;
	role: "user" | "assistant";
	ts: number | null;
	/** Canonicalized content signature (full content, key-order normalized). */
	contentKey: string;
	modelProvider: string | null;
	modelId: string | null;
	metrics: TaskQualitySummaryMetrics | null;
	toolParts: TaskQualitySummaryToolPart[];
}

/** One recorded session segment (a task run) of the task's lineage. */
export interface TaskQualitySummarySession {
	kind: ClineTaskExportKind;
	sessionId: string;
	provider: string;
	model: string;
	/** ISO timestamps from the allowlisted header (null when unknown). */
	startedAt: string | null;
	endedAt: string | null;
	/** False when the durable transcript could not be read (a gap). */
	transcriptReadable: boolean;
	transcriptReason: string | null;
	/** True when the capture has a live display tail (excluded from totals). */
	hasLiveTail: boolean;
	messages: TaskQualitySummaryMessage[];
}

export interface TaskQualitySummaryInput {
	capturedAt: number;
	sessions: TaskQualitySummarySession[];
}

/** Rule ids: confirmed failures, unmatched/retry evidence, heuristic tags, ambiguities. */
export type TaskQualitySummaryRuleId =
	| "tool_result_is_error"
	| "structured_success_false"
	| "run_commands_nested_failure"
	| "editor_replacement_mismatch"
	| "editor_missing_old_text"
	| "editor_input_too_large"
	| "editor_other"
	| "unmatched_tool_call"
	| "unchanged_failed_retry"
	| "suspected_masked_command_failure"
	| "expected_negative_probe"
	| "nonzero_exit_status"
	| "message_id_reuse_conflict"
	| "tool_id_reuse_conflict"
	| "duplicate_session";

export type TaskQualitySummaryClassification =
	| "confirmed_failure"
	| "unmatched_call"
	| "unchanged_retry"
	| "heuristic_tag";

/** Compact evidence reference (session/message/part) — never full text. */
export interface TaskQualitySummaryEvidence {
	sessionId: string;
	kind: ClineTaskExportKind;
	messageIndex: number;
	partIndex: number;
	toolCallId: string;
	/** Timestamp of the message carrying the evidence (null when unrecorded). */
	timestamp: number | null;
	ruleId: TaskQualitySummaryRuleId;
	classification: TaskQualitySummaryClassification;
	/** The prior identical failed call for unchanged-retry evidence. */
	priorReference: {
		sessionId: string;
		messageIndex: number;
		partIndex: number;
		toolCallId: string;
	} | null;
}

export interface TaskQualitySummaryAmbiguity {
	ruleId: TaskQualitySummaryRuleId;
	detail: string;
}

/** Cumulative reported counter across distinct measured responses. */
export interface TaskQualitySummaryUsageCounter {
	/** null when no distinct response reports this counter (zero stays zero). */
	total: number | null;
	/** Fraction of distinct assistant responses reporting the counter (0..1). */
	coverage: number;
}

export interface TaskQualitySummaryResult {
	version: typeof TASK_QUALITY_SUMMARY_VERSION;
	capturedAt: number;
	/** Earliest valid segment start; null when unknown. Not card creation. */
	firstRecordedStart: number | null;
	/** Latest valid segment end; null when unknown. Not merge time. */
	lastRecordedEnd: number | null;
	/** Segments with no valid recorded end (incomplete/open). */
	openSegmentCount: number;
	/** Segments whose end is valid but whose start is invalid or earlier than the end. */
	invalidIntervalCount: number;
	/**
	 * Union of valid closed start/end intervals across all included classes.
	 * Includes waits inside sessions; excludes gaps between sessions.
	 * Never active runtime.
	 */
	recordedSessionSpanMs: number | null;
	coveredSegmentCount: number;
	totalSegmentCount: number;
	/** Restarts are multiple recorded working segments, not automatically crashes. */
	sessionCounts: {
		working: number;
		review: number;
		verificationRepair: number;
		distinctSessions: number;
	};
	ambiguities: TaskQualitySummaryAmbiguity[];
	/** Distinct provider/model pairs from headers and assistant metadata. */
	models: {
		pairs: Array<{ provider: string; model: string }>;
		mixedModels: boolean;
	};
	responses: {
		/** Distinct assistant responses (inherited copies counted once). */
		assistantResponses: number;
		/** Responses reporting at least one usage metric. */
		withReportedMetrics: number;
		/** Maximum observed per-response input metric; not a context estimate. */
		peakReportedInput: number | null;
	};
	usage: {
		inputTokens: TaskQualitySummaryUsageCounter;
		outputTokens: TaskQualitySummaryUsageCounter;
		cacheReadTokens: TaskQualitySummaryUsageCounter;
		cacheWriteTokens: TaskQualitySummaryUsageCounter;
	};
	toolCalls: {
		/** Distinct tool calls (deduplicated across restarts). */
		total: number;
		byName: Record<string, number>;
	};
	/** Calls whose matched result explicitly reports failure (once per call). */
	reportedToolFailures: number;
	/** Calls with no observed result (separate from confirmed failures). */
	unmatchedToolCalls: number;
	/** Matched results stored as truncated excerpts (full outputs not loaded). */
	truncatedToolResults: number;
	/** Later identical calls after the prior identical call reported failure. */
	unchangedFailedRetries: number;
	/** Heuristic evidence tags (never confirmed failures, never a score). */
	heuristicTags: Record<string, number>;
	/** True when the capture has a live display tail (excluded from totals). */
	liveTailExcluded: boolean;
	evidence: TaskQualitySummaryEvidence[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON comparison key: object key order is normalized (sorted),
 * array order and string whitespace are preserved. Deterministic for
 * argument equality checks.
 */
export function canonicalizeJsonValue(value: unknown): string {
	return JSON.stringify(normalizeForCanonicalization(value));
}

function normalizeForCanonicalization(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(normalizeForCanonicalization);
	}
	if (isPlainRecord(value)) {
		const normalized: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			normalized[key] = normalizeForCanonicalization(value[key]);
		}
		return normalized;
	}
	if (typeof value === "number" && !Number.isFinite(value)) {
		return null;
	}
	return value;
}

function parseIsoTimestamp(value: string | null): number | null {
	if (value === null || value.trim() === "") {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse a tool result text only when it is a documented JSON result
 * (object or array). Prose, command output, and source text are never
 * parsed or searched recursively.
 */
function parseDocumentedJsonResult(text: string): unknown | null {
	const trimmed = text.trim();
	if (trimmed.length === 0 || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
		return null;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

/** The documented per-command entries of a run_commands result. */
function extractCommandEntries(parsed: unknown): Array<Record<string, unknown>> | null {
	if (Array.isArray(parsed)) {
		return parsed.filter(isPlainRecord);
	}
	if (isPlainRecord(parsed) && Array.isArray(parsed.output)) {
		return parsed.output.filter(isPlainRecord);
	}
	return null;
}

/** The raw command strings of a run_commands tool_use input. */
function extractCommandStrings(rawArguments: unknown): string[] {
	if (!isPlainRecord(rawArguments) || !Array.isArray(rawArguments.commands)) {
		return [];
	}
	const commands: string[] = [];
	for (const entry of rawArguments.commands) {
		if (typeof entry === "string") {
			commands.push(entry);
		} else if (isPlainRecord(entry) && typeof entry.command === "string") {
			commands.push(
				Array.isArray(entry.args) ? [entry.command, ...entry.args.map(String)].join(" ") : entry.command,
			);
		}
	}
	return commands;
}

/** Documented editor failure categories matched against the recorded error text. */
function editorFailureRule(errorText: string): TaskQualitySummaryRuleId {
	if (errorText.includes("No replacement performed")) {
		return "editor_replacement_mismatch";
	}
	if (errorText.includes("old_text") && errorText.includes("required")) {
		return "editor_missing_old_text";
	}
	if (errorText.includes("Editor input too large")) {
		return "editor_input_too_large";
	}
	return "editor_other";
}

// Heuristic risk patterns on the recorded command text. Neither tag is a
// failure: a pipeline containing tail/grep only masks exit status, and a
// search command with no matches can be an intentional probe.
const MASKED_PIPELINE_PATTERN = /\|\s*(?:grep|rg|ag|ack|tail|head)\b/;
const NEGATIVE_PROBE_COMMAND_PATTERN = /^\s*(?:sudo\s+)?(?:grep|rg|ag|ack|find|git\s+grep)\b/i;

function isNegativeProbeResult(text: string | null): boolean {
	if (text === null) {
		return false;
	}
	const parsed = parseDocumentedJsonResult(text);
	if (parsed === null) {
		const trimmed = text.trim();
		return trimmed === "" || trimmed === "No matches found";
	}
	const entries = extractCommandEntries(parsed);
	if (entries === null || entries.length === 0) {
		return false;
	}
	return entries.every((entry) => {
		const result = entry.result;
		return typeof result === "string" && (result.trim() === "" || result.trim() === "No matches found");
	});
}

export interface ToolCallClassification {
	/** Confirmed failure rule (structural; see docs). Null when not confirmed. */
	confirmedRule: TaskQualitySummaryRuleId | null;
	/** Heuristic evidence tags (reported separately from confirmed totals). */
	heuristicTags: TaskQualitySummaryRuleId[];
}

/**
 * Deterministic V1 classification of a matched tool call:
 * - confirmed failures: tool-result `is_error`, documented structured
 *   `success: false` (top-level object), and the run_commands nested
 *   command-entry arrays (each call counted once, even when several
 *   nested commands fail);
 * - heuristic tags: masked pipeline risk, expected negative probes, and
 *   nonzero exit statuses that the documented success flag did not flag.
 */
export function classifyToolCall(input: {
	toolName: string | null;
	arguments: unknown;
	isResultError: boolean;
	resultText: string | null;
}): ToolCallClassification {
	if (input.isResultError) {
		return { confirmedRule: "tool_result_is_error", heuristicTags: [] };
	}
	const heuristicTags: TaskQualitySummaryRuleId[] = [];
	if (input.resultText !== null) {
		const parsed = parseDocumentedJsonResult(input.resultText);
		if (parsed !== null) {
			if (isPlainRecord(parsed) && parsed.success === false) {
				return {
					confirmedRule:
						input.toolName === "editor"
							? editorFailureRule(typeof parsed.error === "string" ? parsed.error : "")
							: "structured_success_false",
					heuristicTags,
				};
			}
			if (input.toolName === "run_commands") {
				const entries = extractCommandEntries(parsed);
				if (entries !== null && entries.length > 0) {
					if (entries.some((entry) => entry.success === false)) {
						return { confirmedRule: "run_commands_nested_failure", heuristicTags };
					}
					if (entries.some((entry) => typeof entry.exitCode === "number" && entry.exitCode !== 0)) {
						heuristicTags.push("nonzero_exit_status");
					}
				}
			}
		}
	}
	if (input.toolName === "run_commands") {
		const commands = extractCommandStrings(input.arguments);
		if (commands.some((command) => MASKED_PIPELINE_PATTERN.test(command))) {
			heuristicTags.push("suspected_masked_command_failure");
		}
		if (
			commands.some((command) => NEGATIVE_PROBE_COMMAND_PATTERN.test(command)) &&
			isNegativeProbeResult(input.resultText)
		) {
			heuristicTags.push("expected_negative_probe");
		}
	}
	return { confirmedRule: null, heuristicTags };
}

/**
 * Deterministic V1 analysis of the recorded sessions. Pure: no I/O, no SDK
 * schema access beyond the structural input, no LLM. The full logs remain
 * the evidence source; this returns summary numbers plus compact evidence
 * references for failed/unmatched calls, unchanged retries, and heuristic
 * tags — never full prompts or outputs.
 */
export function analyzeTaskQualitySummary(input: TaskQualitySummaryInput): TaskQualitySummaryResult {
	const ambiguities: TaskQualitySummaryAmbiguity[] = [];

	interface DistinctMessage {
		signature: string;
		role: "user" | "assistant";
		firstRef: { sessionId: string; messageIndex: number };
		ts: number | null;
		metrics: TaskQualitySummaryMetrics | null;
		modelProvider: string | null;
		modelId: string | null;
	}

	interface DistinctCall {
		id: string;
		toolName: string | null;
		arguments: unknown;
		argumentKey: string | null;
		firstRef: {
			sessionId: string;
			kind: ClineTaskExportKind;
			messageIndex: number;
			partIndex: number;
			toolCallId: string;
		};
		timestamp: number | null;
		result: {
			text: string | null;
			isResultError: boolean;
		} | null;
		classified: ToolCallClassification | null;
	}

	/** Sessions first: a (kind, sessionId) pair is one recorded session. */
	const seenSessionKeys = new Set<string>();
	const sessions: TaskQualitySummarySession[] = [];
	for (const session of input.sessions) {
		const key = `${session.kind}\u0000${session.sessionId}`;
		if (seenSessionKeys.has(key)) {
			ambiguities.push({
				ruleId: "duplicate_session",
				detail: `session ${session.sessionId} (kind ${session.kind}) is recorded more than once; counted once`,
			});
			continue;
		}
		seenSessionKeys.add(key);
		sessions.push(session);
	}

	/**
	 * Messages: stable id + matching signature is the identity fast path;
	 * the signature (role, canonical content, ts, metrics, model) is the
	 * authority, so seeded/compacted copies contribute exactly once.
	 */
	const messageBySignature = new Map<string, DistinctMessage>();
	const messageSignatureById = new Map<string, string>();
	const distinctMessages: DistinctMessage[] = [];
	for (const session of sessions) {
		session.messages.forEach((message, messageIndex) => {
			const signature = [
				message.role,
				message.contentKey,
				message.ts ?? "",
				message.metrics ? canonicalizeJsonValue(message.metrics) : "",
				message.modelProvider ?? "",
				message.modelId ?? "",
			].join("\u0000");
			if (message.id !== null) {
				const existing = messageSignatureById.get(message.id);
				if (existing === undefined) {
					messageSignatureById.set(message.id, signature);
				} else if (existing !== signature) {
					ambiguities.push({
						ruleId: "message_id_reuse_conflict",
						detail: `message id ${message.id} is used by two distinct messages (first in ${session.sessionId}); kept separate`,
					});
				}
			}
			if (messageBySignature.has(signature)) {
				return; // inherited copy: already counted once
			}
			const distinct: DistinctMessage = {
				signature,
				role: message.role,
				firstRef: { sessionId: session.sessionId, messageIndex },
				ts: message.ts,
				metrics: message.metrics,
				modelProvider: message.modelProvider,
				modelId: message.modelId,
			};
			messageBySignature.set(signature, distinct);
			distinctMessages.push(distinct);
		});
	}

	/**
	 * Tool parts: a (tool id, name, canonical arguments) triple is one call.
	 * Same id + same arguments in a later segment is a seeded/compacted copy
	 * (counted once); same id with conflicting arguments is an identity-reuse
	 * ambiguity kept as separate calls.
	 */
	const calls: DistinctCall[] = [];
	const callRecordsById = new Map<string, DistinctCall[]>();
	const resultKeysById = new Map<string, Set<string>>();
	const firstResultById = new Map<string, { text: string | null; isResultError: boolean }>();
	for (const session of sessions) {
		session.messages.forEach((message, messageIndex) => {
			for (const part of message.toolParts) {
				const reference = {
					sessionId: session.sessionId,
					kind: session.kind,
					messageIndex,
					partIndex: part.index,
					toolCallId: part.toolCallId,
				};
				if (part.kind === "tool_result") {
					const resultKey = `${part.isResultError ? "1" : "0"}\u0000${part.resultText ?? ""}`;
					const existingKeys = resultKeysById.get(part.toolCallId);
					if (existingKeys === undefined) {
						resultKeysById.set(part.toolCallId, new Set([resultKey]));
						firstResultById.set(part.toolCallId, { text: part.resultText, isResultError: part.isResultError });
					} else if (!existingKeys.has(resultKey)) {
						existingKeys.add(resultKey);
						ambiguities.push({
							ruleId: "tool_id_reuse_conflict",
							detail: `tool result ${part.toolCallId} is recorded with conflicting content; the first recorded result is used`,
						});
					}
					continue;
				}
				// tool_use: empty ids carry no matchable identity — every one
				// stays its own call and can never match a result.
				const records = part.toolCallId === "" ? [] : (callRecordsById.get(part.toolCallId) ?? []);
				const duplicate = records.find(
					(record) => record.toolName === part.toolName && record.argumentKey === part.argumentKey,
				);
				if (duplicate !== undefined) {
					continue; // observed call already counted once
				}
				if (records.length > 0) {
					ambiguities.push({
						ruleId: "tool_id_reuse_conflict",
						detail: `tool id ${part.toolCallId} is used by calls with different arguments; kept separate`,
					});
				}
				const call: DistinctCall = {
					id: part.toolCallId,
					toolName: part.toolName,
					arguments: part.arguments,
					argumentKey: part.argumentKey,
					firstRef: reference,
					timestamp: message.ts,
					result: null,
					classified: null,
				};
				calls.push(call);
				if (part.toolCallId !== "") {
					callRecordsById.set(part.toolCallId, [...records, call]);
				}
			}
		});
	}

	for (const call of calls) {
		const result = firstResultById.get(call.id);
		if (result !== undefined) {
			call.result = result;
		}
	}

	/** Aggregate: counts, usage, failures, unmatched, truncation, heuristics. */
	const byName: Record<string, number> = {};
	const heuristicTagCounts: Record<string, number> = {};
	const evidence: TaskQualitySummaryEvidence[] = [];
	let reportedToolFailures = 0;
	let unmatchedToolCalls = 0;
	let truncatedToolResults = 0;
	for (const call of calls) {
		const name = call.toolName ?? "(unknown)";
		byName[name] = (byName[name] ?? 0) + 1;
		if (call.result === null) {
			unmatchedToolCalls += 1;
			evidence.push({
				...call.firstRef,
				timestamp: call.timestamp,
				ruleId: "unmatched_tool_call",
				classification: "unmatched_call",
				priorReference: null,
			});
			continue;
		}
		if (call.result.text !== null && TASK_ARTIFACT_TRUNCATION_MARKER_PATTERN.test(call.result.text)) {
			truncatedToolResults += 1;
		}
		const classification = classifyToolCall({
			toolName: call.toolName,
			arguments: call.arguments,
			isResultError: call.result.isResultError,
			resultText: call.result.text,
		});
		call.classified = classification;
		if (classification.confirmedRule !== null) {
			reportedToolFailures += 1;
			evidence.push({
				...call.firstRef,
				timestamp: call.timestamp,
				ruleId: classification.confirmedRule,
				classification: "confirmed_failure",
				priorReference: null,
			});
		}
		for (const tag of classification.heuristicTags) {
			heuristicTagCounts[tag] = (heuristicTagCounts[tag] ?? 0) + 1;
			evidence.push({
				...call.firstRef,
				timestamp: call.timestamp,
				ruleId: tag,
				classification: "heuristic_tag",
				priorReference: null,
			});
		}
	}

	/**
	 * Unchanged failed retries: later calls with identical tool name and
	 * canonical arguments whose immediately preceding identical call
	 * reported failure. No judgment about whether the retry was justified.
	 */
	let unchangedFailedRetries = 0;
	const lastCallByKey = new Map<string, { call: DistinctCall; failed: boolean }>();
	for (const call of calls) {
		if (call.toolName === null || call.argumentKey === null) {
			continue; // identity cannot be proven
		}
		const key = `${call.toolName}\u0000${call.argumentKey}`;
		const last = lastCallByKey.get(key);
		if (last?.failed) {
			unchangedFailedRetries += 1;
			evidence.push({
				...call.firstRef,
				timestamp: call.timestamp,
				ruleId: "unchanged_failed_retry",
				classification: "unchanged_retry",
				priorReference: {
					sessionId: last.call.firstRef.sessionId,
					messageIndex: last.call.firstRef.messageIndex,
					partIndex: last.call.firstRef.partIndex,
					toolCallId: last.call.id,
				},
			});
		}
		lastCallByKey.set(key, { call, failed: call.classified?.confirmedRule !== null });
	}

	/** Recorded session timing (never active runtime). */
	let firstRecordedStart: number | null = null;
	let lastRecordedEnd: number | null = null;
	let openSegmentCount = 0;
	let invalidIntervalCount = 0;
	let coveredSegmentCount = 0;
	const intervals: Array<[number, number]> = [];
	for (const session of sessions) {
		const start = parseIsoTimestamp(session.startedAt);
		const end = parseIsoTimestamp(session.endedAt);
		if (end === null) {
			openSegmentCount += 1;
			if (start !== null && (firstRecordedStart === null || start < firstRecordedStart)) {
				firstRecordedStart = start;
			}
			continue;
		}
		if (start === null || end < start) {
			invalidIntervalCount += 1;
			continue;
		}
		if (firstRecordedStart === null || start < firstRecordedStart) {
			firstRecordedStart = start;
		}
		if (lastRecordedEnd === null || end > lastRecordedEnd) {
			lastRecordedEnd = end;
		}
		intervals.push([start, end]);
		coveredSegmentCount += 1;
	}
	intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let recordedSessionSpanMs: number | null = null;
	let cursorEnd: number | null = null;
	for (const [start, end] of intervals) {
		if (recordedSessionSpanMs === null) {
			recordedSessionSpanMs = end - start;
			cursorEnd = end;
		} else if (cursorEnd !== null && start <= cursorEnd) {
			if (end > cursorEnd) {
				recordedSessionSpanMs += end - cursorEnd;
				cursorEnd = end;
			}
		} else {
			recordedSessionSpanMs += end - start;
			cursorEnd = end;
		}
	}

	/** Models from headers and assistant message metadata (no inference). */
	const modelPairMap = new Map<string, { provider: string; model: string }>();
	const addModelPair = (provider: string | null, model: string | null): void => {
		if (provider === null || model === null || provider === "" || model === "") {
			return;
		}
		const key = `${provider}\u0000${model}`;
		if (!modelPairMap.has(key)) {
			modelPairMap.set(key, { provider, model });
		}
	};
	for (const session of sessions) {
		addModelPair(session.provider, session.model);
	}
	for (const message of distinctMessages) {
		if (message.role === "assistant") {
			addModelPair(message.modelProvider, message.modelId);
		}
	}

	/** Distinct assistant responses and reported usage (per-counter coverage). */
	const assistantMessages = distinctMessages.filter((message) => message.role === "assistant");
	const counterTotals: Record<
		"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens",
		{ total: number; count: number }
	> = {
		inputTokens: { total: 0, count: 0 },
		outputTokens: { total: 0, count: 0 },
		cacheReadTokens: { total: 0, count: 0 },
		cacheWriteTokens: { total: 0, count: 0 },
	};
	let withReportedMetrics = 0;
	let peakReportedInput: number | null = null;
	for (const message of assistantMessages) {
		const metrics = message.metrics;
		if (metrics === null) {
			continue;
		}
		let reportsAny = false;
		for (const field of Object.keys(counterTotals) as Array<keyof typeof counterTotals>) {
			const value = metrics[field];
			if (value === null) {
				continue;
			}
			reportsAny = true;
			counterTotals[field].total += value;
			counterTotals[field].count += 1;
			if (field === "inputTokens" && (peakReportedInput === null || value > peakReportedInput)) {
				peakReportedInput = value;
			}
		}
		if (reportsAny) {
			withReportedMetrics += 1;
		}
	}
	const responseCount = assistantMessages.length;
	const toCounter = (entry: { total: number; count: number }): TaskQualitySummaryUsageCounter => ({
		total: entry.count === 0 ? null : entry.total,
		coverage: responseCount === 0 ? 0 : entry.count / responseCount,
	});

	return {
		version: TASK_QUALITY_SUMMARY_VERSION,
		capturedAt: input.capturedAt,
		firstRecordedStart,
		lastRecordedEnd,
		openSegmentCount,
		invalidIntervalCount,
		recordedSessionSpanMs,
		coveredSegmentCount,
		totalSegmentCount: sessions.length,
		sessionCounts: {
			working: sessions.filter((session) => session.kind === "task").length,
			review: sessions.filter((session) => session.kind === "review").length,
			verificationRepair: sessions.filter((session) => session.kind === "verification-repair").length,
			distinctSessions: sessions.length,
		},
		ambiguities,
		models: {
			pairs: [...modelPairMap.values()],
			mixedModels: modelPairMap.size > 1,
		},
		responses: {
			assistantResponses: responseCount,
			withReportedMetrics,
			peakReportedInput,
		},
		usage: {
			inputTokens: toCounter(counterTotals.inputTokens),
			outputTokens: toCounter(counterTotals.outputTokens),
			cacheReadTokens: toCounter(counterTotals.cacheReadTokens),
			cacheWriteTokens: toCounter(counterTotals.cacheWriteTokens),
		},
		toolCalls: {
			total: calls.length,
			byName,
		},
		reportedToolFailures,
		unmatchedToolCalls,
		truncatedToolResults,
		unchangedFailedRetries,
		heuristicTags: heuristicTagCounts,
		liveTailExcluded: sessions.some((session) => session.hasLiveTail),
		evidence,
	};
}

// ---------------------------------------------------------------------------
// Adapters: live export snapshots and downloaded schemaVersion 3 bundles both
// feed the same structural input.
// ---------------------------------------------------------------------------

interface DurableToolResultContent {
	type: string;
	text?: string;
}

/** Extract the text of a durable tool result (string or joined text blocks). */
function extractDurableToolResultText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((part): part is DurableToolResultContent => isPlainRecord(part) && part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function toMetricCount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function adaptMessageToInput(
	message: ClineSdkPersistedMessage,
	messageIndex: number,
	origins: Map<string, ClineTaskExportToolOrigin>,
): TaskQualitySummaryMessage {
	const parts: TaskQualitySummaryToolPart[] = [];
	const content = Array.isArray(message.content) ? message.content : [];
	content.forEach((part, partIndex) => {
		if (part === null || part === undefined) {
			return;
		}
		const origin = origins.get(`${messageIndex}:${partIndex}`) ?? "unknown";
		if (part.type === "tool_use") {
			const toolArguments = part.input;
			parts.push({
				index: partIndex,
				kind: "tool_use",
				toolCallId: typeof part.id === "string" ? part.id : "",
				toolName: typeof part.name === "string" ? part.name : null,
				arguments: toolArguments,
				argumentKey: canonicalizeJsonValue(toolArguments),
				isResultError: false,
				resultText: null,
				origin,
			});
			return;
		}
		if (part.type === "tool_result") {
			parts.push({
				index: partIndex,
				kind: "tool_result",
				toolCallId: typeof part.tool_use_id === "string" ? part.tool_use_id : "",
				toolName: null,
				arguments: null,
				argumentKey: null,
				isResultError: part.is_error === true,
				resultText: extractDurableToolResultText(part.content),
				origin,
			});
		}
	});
	const metrics = message.metrics
		? {
				inputTokens: toMetricCount(message.metrics.inputTokens),
				outputTokens: toMetricCount(message.metrics.outputTokens),
				cacheReadTokens: toMetricCount(message.metrics.cacheReadTokens),
				cacheWriteTokens: toMetricCount(message.metrics.cacheWriteTokens),
			}
		: null;
	return {
		id: typeof message.id === "string" && message.id !== "" ? message.id : null,
		role: message.role,
		ts: typeof message.ts === "number" && Number.isFinite(message.ts) ? message.ts : null,
		contentKey: canonicalizeJsonValue(message.content),
		modelProvider: message.modelInfo?.provider ?? null,
		modelId: message.modelInfo?.id ?? null,
		metrics,
		toolParts: parts,
	};
}

interface SegmentInput {
	header: ClineTaskExportSegmentHeader;
	messages: ClineSdkPersistedMessage[];
	hasLiveTail: boolean;
	readable: boolean;
	reason: string | null;
	toolOrigins: ClineTaskExportToolOriginEntry[];
}

function adaptSegmentToSession(segment: SegmentInput): TaskQualitySummarySession {
	const origins = new Map<string, ClineTaskExportToolOrigin>();
	for (const entry of segment.toolOrigins) {
		origins.set(`${entry.messageIndex}:${entry.partIndex}`, entry.origin);
	}
	return {
		kind: segment.header.kind,
		sessionId: segment.header.sessionId,
		provider: segment.header.provider,
		model: segment.header.model,
		startedAt: segment.header.startedAt,
		endedAt: segment.header.endedAt,
		transcriptReadable: segment.readable,
		transcriptReason: segment.reason,
		hasLiveTail: segment.hasLiveTail,
		messages: segment.messages.map((message, messageIndex) => adaptMessageToInput(message, messageIndex, origins)),
	};
}

/**
 * Adapt a scoped export snapshot (task or review/repair lineage) to the
 * reducer's structural sessions. `null` means the class was not read.
 */
export function adaptSessionSnapshotToSessions(snapshot: ClineTaskExportSnapshot | null): TaskQualitySummarySession[] {
	if (snapshot === null) {
		return [];
	}
	return snapshot.segments.map((segment) =>
		adaptSegmentToSession({
			header: segment.header,
			messages: segment.messages,
			hasLiveTail: segment.liveTail !== null,
			readable: segment.readError === null,
			reason: segment.readError,
			toolOrigins: segment.toolOrigins,
		}),
	);
}

/**
 * Adapt a downloaded schemaVersion 3 export bundle to the reducer's
 * structural sessions, so the exact same analysis runs on exported JSON in a
 * local script/test (no server, no LLM call). Terminal-only session entries
 * carry no durable segments and contribute nothing to the totals.
 */
export function adaptExportedV3PlanSessions(plan: TaskDiagnosticsExportV3Plan): TaskQualitySummarySession[] {
	const sessions: TaskQualitySummarySession[] = [];
	for (const group of plan.sessions) {
		for (const segment of group.segments) {
			sessions.push(
				adaptSegmentToSession({
					header: segment.header,
					messages: segment.messages,
					hasLiveTail: segment.liveTail !== null,
					readable: segment.transcript.status !== "unavailable",
					reason: segment.transcript.reason,
					toolOrigins: segment.toolOrigins,
				}),
			);
		}
	}
	return sessions;
}

// ---------------------------------------------------------------------------
// Response assembly (runtime API layer keeps its shape in api-contract).
// ---------------------------------------------------------------------------

export interface TaskQualitySummarySource {
	taskId: string;
	capturedAt: number;
	taskSnapshot: ClineTaskExportSnapshot | null;
	taskSnapshotError: string | null;
	reviewSnapshot: ClineTaskExportSnapshot | null;
	reviewSnapshotError: string | null;
	/** Source of the task's current session, if any. */
	sessionSource: "cline" | "terminal" | null;
	/** A terminal session summary exists for the current session. */
	terminalSummaryAvailable: boolean;
}

const EMPTY_USAGE_COUNTER: TaskQualitySummaryUsageCounter = { total: null, coverage: 0 };

/**
 * Assemble the diagnostics response from the task's scoped snapshots.
 * Completeness mirrors the export bundle: explicit reasons for every gap,
 * `unavailable` when nothing recorded, never a silent zero.
 */
export function buildTaskQualitySummaryResponse(source: TaskQualitySummarySource): RuntimeTaskQualitySummaryResponse {
	const reasons: string[] = [];
	const warnings: string[] = [];
	if (source.taskSnapshotError !== null) {
		reasons.push(`session class task snapshot failed: ${source.taskSnapshotError}`);
	}
	if (source.reviewSnapshotError !== null) {
		reasons.push(`session class review snapshot failed: ${source.reviewSnapshotError}`);
	}
	// An empty review lineage is not a gap; only read failures/truncation are.
	const reviewUsable =
		source.reviewSnapshot !== null &&
		(source.reviewSnapshot.segments.length > 0 || source.reviewSnapshot.enumerationErrors.length > 0);
	const sessions = [
		...adaptSessionSnapshotToSessions(source.taskSnapshot),
		...adaptSessionSnapshotToSessions(reviewUsable ? source.reviewSnapshot : null),
	];
	for (const snapshot of [source.taskSnapshot, reviewUsable ? source.reviewSnapshot : null]) {
		if (snapshot === null) {
			continue;
		}
		if (snapshot.listingTruncated) {
			reasons.push("session listing may be truncated");
		}
		for (const error of snapshot.enumerationErrors) {
			reasons.push(`session class ${snapshot.kind} snapshot read failed: ${error}`);
		}
		for (const segment of snapshot.segments) {
			if (segment.readError !== null) {
				reasons.push(`transcript for session ${segment.header.sessionId} could not be read`);
			}
		}
	}
	// Native transcript availability and terminal summary availability are
	// separate: a current terminal session is a gap for *its* transcript
	// without touching the recorded native totals.
	let sourceWarning: string | null = null;
	if (source.sessionSource === "terminal") {
		reasons.push("current session is a terminal agent session; no structured transcript recorded for it");
		sourceWarning =
			"The current session is a terminal agent session with no structured transcript. Native totals below cover recorded native sessions only.";
	}
	if (sessions.length === 0 && source.sessionSource !== "terminal") {
		reasons.push("no Cline session transcript is recorded for this task");
	}
	const result = analyzeTaskQualitySummary({ capturedAt: source.capturedAt, sessions });
	if (result.liveTailExcluded) {
		warnings.push(
			"the capture includes a live tail of Kanban display messages that may overlap the durable transcript; it is excluded from all totals",
		);
	}
	if (result.truncatedToolResults > 0) {
		warnings.push(
			`${result.truncatedToolResults} tool result(s) are truncated excerpts; full outputs are not loaded in this summary`,
		);
	}
	const status: "complete" | "partial" | "unavailable" =
		sessions.length === 0 ? "unavailable" : reasons.length > 0 ? "partial" : "complete";
	return {
		ok: true,
		taskId: source.taskId,
		capturedAt: source.capturedAt,
		reducerVersion: result.version,
		coverage: { status, reasons, warnings },
		timing: {
			firstRecordedStart: result.firstRecordedStart,
			lastRecordedEnd: result.lastRecordedEnd,
			openSegmentCount: result.openSegmentCount,
			invalidIntervalCount: result.invalidIntervalCount,
			recordedSessionSpanMs: result.recordedSessionSpanMs,
			coveredSegmentCount: result.coveredSegmentCount,
			totalSegmentCount: result.totalSegmentCount,
		},
		sessionCounts: result.sessionCounts,
		ambiguities: result.ambiguities,
		models: result.models,
		responses: result.responses,
		usage: result.usage,
		tools: {
			totalCalls: result.toolCalls.total,
			byName: result.toolCalls.byName,
			reportedFailures: result.reportedToolFailures,
			unmatchedCalls: result.unmatchedToolCalls,
			truncatedResults: result.truncatedToolResults,
		},
		retries: { unchangedFailedRetries: result.unchangedFailedRetries },
		heuristicTags: result.heuristicTags,
		liveTailExcluded: result.liveTailExcluded,
		evidence: result.evidence,
		sessionSource: source.sessionSource,
		terminalSummaryAvailable: source.terminalSummaryAvailable,
		sourceWarning,
		error: null,
	};
}

/** Hard failure response (source read blew up): explicit, never invented. */
export function buildUnavailableTaskQualitySummaryResponse(
	taskId: string,
	error: string,
): RuntimeTaskQualitySummaryResponse {
	return {
		ok: false,
		taskId,
		capturedAt: Date.now(),
		reducerVersion: TASK_QUALITY_SUMMARY_VERSION,
		coverage: {
			status: "unavailable",
			reasons: [`recorded summary could not be built: ${error}`],
			warnings: [],
		},
		timing: {
			firstRecordedStart: null,
			lastRecordedEnd: null,
			openSegmentCount: 0,
			invalidIntervalCount: 0,
			recordedSessionSpanMs: null,
			coveredSegmentCount: 0,
			totalSegmentCount: 0,
		},
		sessionCounts: { working: 0, review: 0, verificationRepair: 0, distinctSessions: 0 },
		ambiguities: [],
		models: { pairs: [], mixedModels: false },
		responses: { assistantResponses: 0, withReportedMetrics: 0, peakReportedInput: null },
		usage: {
			inputTokens: { ...EMPTY_USAGE_COUNTER },
			outputTokens: { ...EMPTY_USAGE_COUNTER },
			cacheReadTokens: { ...EMPTY_USAGE_COUNTER },
			cacheWriteTokens: { ...EMPTY_USAGE_COUNTER },
		},
		tools: { totalCalls: 0, byName: {}, reportedFailures: 0, unmatchedCalls: 0, truncatedResults: 0 },
		retries: { unchangedFailedRetries: 0 },
		heuristicTags: {},
		liveTailExcluded: false,
		evidence: [],
		sessionSource: null,
		terminalSummaryAvailable: false,
		sourceWarning: null,
		error,
	};
}
