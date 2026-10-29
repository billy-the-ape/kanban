// DIAG-2 (2c) — the typed schemaVersion 3 diagnostic export bundle.
//
// Unlike the schemaVersion 2 bundle (which redacted task content), this bundle
// carries the full, unmodified transcript of every session the task owns
// (working + review + verification repair) together with the complete
// operational diagnostics response (task title, review details, warning /
// activity text, dispatch data, workspace paths, diagnostics errors) — nothing
// is redacted (Decision 1). The original messages are kept as-is under each
// segment; all additional evidence (tool origins, full outputs, unmatched
// annotations, capture/completeness) is attached through message/part
// references and enclosing export entries, never by rewriting the messages
// (Decision 2c).
//
// The bundle is a point-in-time capture (Decision 5): it carries the capture
// time and an overall completeness (complete / partial / unavailable) with
// explicit reasons and warnings.
//
// `buildTaskDiagnosticsExportV3` produces the typed plan; the streamed JSON
// serializer lives in task-diagnostics-export-stream.ts (artifacts are streamed
// one at a time and never held as a second huge JSON string).

import type { TaskEditorCallEvidence } from "../cline-sdk/cline-editor-call-evidence";
import type {
	ClineTaskExportKind,
	ClineTaskExportLaunchConfig,
	ClineTaskExportLiveTail,
	ClineTaskExportSegmentHeader,
	ClineTaskExportSnapshot,
	ClineTaskExportToolOriginEntry,
} from "../cline-sdk/cline-task-export-snapshot";
import type { ClineSdkPersistedMessage } from "../cline-sdk/sdk-runtime-boundary";
import type { RuntimeTaskDiagnosticsResponse, RuntimeTaskSessionSummary } from "./api-contract";
import {
	resolveTaskToolFullOutput,
	TASK_ARTIFACT_TRUNCATION_MARKER_PATTERN,
	type TaskArtifactFullOutputEvidence,
	type TaskArtifactFullOutputStatus,
} from "./task-diagnostics-export-artifacts";

/** Schema version of the full-fidelity diagnostic export bundle. */
export const TASK_DIAGNOSTICS_EXPORT_SCHEMA_VERSION = 3;

/** Decision 5: overall capture completeness. */
export interface TaskDiagnosticsExportCompleteness {
	status: "complete" | "partial" | "unavailable";
	/** Reasons that drive the status (partial or unavailable). */
	reasons: string[];
	/** Informational gaps that do not change the status (e.g. lost artifacts). */
	warnings: string[];
}

export type TaskDiagnosticsExportTranscriptStatus = "complete" | "partial" | "unavailable";

/** The resolved full output attached to a truncated tool result. */
export interface TaskDiagnosticsExportToolFullOutput {
	status: TaskArtifactFullOutputStatus;
	artifactFileName: string | null;
	artifactPath: string | null;
	contentFormat: "json-text" | "text" | null;
	/** Explicit gap when the artifact is missing, ambiguous, or invalid. */
	gap: string | null;
}

/**
 * Tool evidence attached by message/part reference. `fullOutput` is present
 * only for tool results stored as truncated excerpts; `annotation` only for
 * unmatched tool calls (interrupted turns stay unmatched, the message history
 * is never repaired just for the export).
 */
export interface TaskDiagnosticsExportToolEvidence {
	messageIndex: number;
	partIndex: number;
	toolCallId: string;
	kind: "tool_result" | "unmatched_tool_call";
	fullOutput?: TaskDiagnosticsExportToolFullOutput;
	annotation?: string;
}

export interface TaskDiagnosticsExportSegment {
	header: ClineTaskExportSegmentHeader;
	/** Service-scoped task id owning this segment's context-artifacts directory. */
	artifactTaskId: string;
	launchConfig: ClineTaskExportLaunchConfig | null;
	transcript: { status: TaskDiagnosticsExportTranscriptStatus; reason: string | null };
	/** Durable SDK messages, raw and in original persisted order. */
	messages: ClineSdkPersistedMessage[];
	liveTail: ClineTaskExportLiveTail | null;
	toolOrigins: ClineTaskExportToolOriginEntry[];
	toolEvidence: TaskDiagnosticsExportToolEvidence[];
	/**
	 * Additive editor transport evidence for this session (raw pre-parse
	 * fragments + parsed/execution/result stages + factual old_text
	 * comparison). "unavailable" keeps historical sessions/exports
	 * compatible.
	 */
	editorCallEvidence: TaskEditorCallEvidence;
}

export interface TaskDiagnosticsExportSession {
	kind: ClineTaskExportKind;
	taskId: string;
	listingTruncated: boolean;
	transcript: { status: TaskDiagnosticsExportTranscriptStatus; reason: string | null };
	/** The session summary for terminal agent sessions (no structured transcript). */
	summary: RuntimeTaskSessionSummary | null;
	segments: TaskDiagnosticsExportSegment[];
}

export interface TaskDiagnosticsExportV3Plan {
	schemaVersion: typeof TASK_DIAGNOSTICS_EXPORT_SCHEMA_VERSION;
	exportedAt: string;
	capture: {
		capturedAt: number;
		note: string;
	};
	completeness: TaskDiagnosticsExportCompleteness;
	/** The full operational diagnostics response, unredacted (Decision 1). */
	diagnostics: RuntimeTaskDiagnosticsResponse;
	/** The card's prompt — the authoritative task description. */
	taskPrompt: string | null;
	sessions: TaskDiagnosticsExportSession[];
}

export interface BuildTaskDiagnosticsExportV3Input {
	/** The card's task id (used for terminal-agent session entries). */
	taskId: string;
	diagnostics: RuntimeTaskDiagnosticsResponse;
	taskPrompt: string | null;
	/** Task + review/repair export snapshots (kind-tagged, creation order). */
	sessionSnapshots: ClineTaskExportSnapshot[];
	/** Source of the task's current session, if any. */
	sessionSource: "cline" | "terminal" | null;
	sessionSummary: RuntimeTaskSessionSummary | null;
	capturedAt: number;
	exportedAt: string;
	/**
	 * Snapshot class read/enumeration failures reported by the runtime (Decision
	 * 5): e.g. the task snapshot succeeded but the review/repair lineage
	 * snapshot read threw. Each entry is a completeness gap, never silently
	 * dropped (and distinct from "the class has no recorded sessions").
	 */
	snapshotFailures?: Array<{ kind: ClineTaskExportKind; reason: string }>;
	/** Full-output resolver override (tests). */
	artifactResolver?: (input: {
		taskId: string;
		toolCallId: string;
		persistedResultText?: string | null;
	}) => Promise<TaskArtifactFullOutputEvidence>;
}

const UNMATCHED_TOOL_CALL_ANNOTATION =
	"No matching tool result in this transcript: the turn was interrupted or the result was lost. The message history was not repaired for the export.";

function isTerminalAgentSession(source: "cline" | "terminal" | null): boolean {
	return source === "terminal";
}

function collectToolResultIds(messages: readonly ClineSdkPersistedMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content) {
			if (part && part.type === "tool_result" && typeof part.tool_use_id === "string") {
				ids.add(part.tool_use_id);
			}
		}
	}
	return ids;
}

/** The text of a tool result part (string content or the text blocks of an array). */
function extractToolResultText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

async function buildSegmentToolEvidence(
	segment: {
		artifactTaskId: string;
		messages: ClineSdkPersistedMessage[];
	},
	artifactResolver: (input: {
		taskId: string;
		toolCallId: string;
		persistedResultText?: string | null;
	}) => Promise<TaskArtifactFullOutputEvidence>,
): Promise<TaskDiagnosticsExportToolEvidence[]> {
	const evidence: TaskDiagnosticsExportToolEvidence[] = [];
	const toolResultIds = collectToolResultIds(segment.messages);
	for (let messageIndex = 0; messageIndex < segment.messages.length; messageIndex += 1) {
		const message = segment.messages[messageIndex];
		if (!message || !Array.isArray(message.content)) {
			continue;
		}
		for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
			const part = message.content[partIndex];
			if (!part) {
				continue;
			}
			if (part.type === "tool_use") {
				if (!toolResultIds.has(part.id)) {
					evidence.push({
						messageIndex,
						partIndex,
						toolCallId: part.id,
						kind: "unmatched_tool_call",
						annotation: UNMATCHED_TOOL_CALL_ANNOTATION,
					});
				}
			} else if (part.type === "tool_result") {
				const text = extractToolResultText(part.content);
				if (!TASK_ARTIFACT_TRUNCATION_MARKER_PATTERN.test(text)) {
					// Not a truncated excerpt: the persisted result is already complete.
					continue;
				}
				let fullOutput: TaskDiagnosticsExportToolFullOutput;
				try {
					const resolved = await artifactResolver({
						taskId: segment.artifactTaskId,
						toolCallId: part.tool_use_id,
						persistedResultText: text,
					});
					fullOutput = {
						status: resolved.status,
						artifactFileName: resolved.artifactFileName,
						artifactPath: resolved.artifactPath,
						contentFormat: resolved.contentFormat,
						gap: resolved.gap,
					};
				} catch (error) {
					fullOutput = {
						status: "missing",
						artifactFileName: null,
						artifactPath: null,
						contentFormat: null,
						gap: `Full-output lookup failed: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
				evidence.push({
					messageIndex,
					partIndex,
					toolCallId: part.tool_use_id,
					kind: "tool_result",
					fullOutput,
				});
			}
		}
	}
	return evidence;
}

interface SnapshotSegmentForBuild {
	header: ClineTaskExportSegmentHeader;
	artifactTaskId: string;
	launchConfig: ClineTaskExportLaunchConfig | null;
	messages: ClineSdkPersistedMessage[];
	liveTail: ClineTaskExportLiveTail | null;
	readError: string | null;
	toolOrigins: ClineTaskExportToolOriginEntry[];
	editorCallEvidence: TaskEditorCallEvidence;
}

/**
 * Assembles the typed schemaVersion 3 plan. `sessionSnapshots` segments must
 * already be kind-tagged and in creation order (the snapshot builder does that).
 */
export async function buildTaskDiagnosticsExportV3(
	input: BuildTaskDiagnosticsExportV3Input,
): Promise<TaskDiagnosticsExportV3Plan> {
	const artifactResolver = input.artifactResolver ?? resolveTaskToolFullOutput;

	const reasons: string[] = [];
	const warnings: string[] = [];
	const sessions: TaskDiagnosticsExportSession[] = [];

	for (const failure of input.snapshotFailures ?? []) {
		reasons.push(`session class ${failure.kind} snapshot failed: ${failure.reason}`);
	}

	for (const snapshot of input.sessionSnapshots) {
		const groupReason: string | null = snapshot.listingTruncated
			? "session listing may be truncated"
			: snapshot.enumerationErrors.length > 0
				? "session enumeration failed for at least one session of this class"
				: null;
		const segments: TaskDiagnosticsExportSegment[] = [];
		for (const segment of snapshotSegments(snapshot)) {
			let transcriptStatus: TaskDiagnosticsExportTranscriptStatus = "complete";
			let transcriptReason: string | null = null;
			if (segment.readError !== null) {
				transcriptStatus = "unavailable";
				transcriptReason = segment.readError;
				reasons.push(`transcript for session ${segment.header.sessionId} could not be read`);
			} else if (groupReason) {
				transcriptStatus = "partial";
				transcriptReason = groupReason;
			}
			segments.push({
				header: segment.header,
				artifactTaskId: segment.artifactTaskId,
				launchConfig: segment.launchConfig,
				transcript: { status: transcriptStatus, reason: transcriptReason },
				messages: segment.messages,
				liveTail: segment.liveTail,
				toolOrigins: segment.toolOrigins,
				toolEvidence: await buildSegmentToolEvidence(
					{ artifactTaskId: segment.artifactTaskId, messages: segment.messages },
					artifactResolver,
				),
				editorCallEvidence: segment.editorCallEvidence,
			});
			if (segment.liveTail) {
				warnings.push(
					`session ${segment.header.sessionId} carries a live tail of ${segment.liveTail.messages.length} Kanban display message(s) that may overlap the durable transcript`,
				);
			}
			if (segment.editorCallEvidence.status === "partial" && segment.editorCallEvidence.reason) {
				warnings.push(
					`editor transport evidence for session ${segment.header.sessionId} is incomplete: ${segment.editorCallEvidence.reason}`,
				);
			}
		}
		if (groupReason) {
			reasons.push(groupReason);
		}
		for (const error of snapshot.enumerationErrors) {
			reasons.push(`session class ${snapshot.kind} snapshot read failed: ${error}`);
		}
		for (const segment of segments) {
			for (const evidence of segment.toolEvidence) {
				if (evidence.kind === "tool_result" && evidence.fullOutput && evidence.fullOutput.status !== "resolved") {
					warnings.push(
						`tool result ${evidence.toolCallId}: ${evidence.fullOutput.gap ?? evidence.fullOutput.status}`,
					);
				}
			}
		}
		let sessionTranscriptStatus: TaskDiagnosticsExportTranscriptStatus = "complete";
		for (const segment of segments) {
			if (segment.transcript.status === "unavailable") {
				sessionTranscriptStatus = "unavailable";
				break;
			}
			if (segment.transcript.status === "partial") {
				sessionTranscriptStatus = "partial";
			}
		}
		if (segments.length === 0) {
			sessionTranscriptStatus = "unavailable";
		}
		sessions.push({
			kind: snapshot.kind,
			taskId: snapshot.taskId,
			listingTruncated: snapshot.listingTruncated,
			transcript: {
				status: sessionTranscriptStatus,
				reason:
					sessionTranscriptStatus === "complete"
						? null
						: sessionTranscriptStatus === "partial"
							? "at least one session transcript of this class is partial"
							: segments.length === 0
								? snapshot.enumerationErrors.length > 0
									? "session enumeration failed for this class"
									: "no recorded sessions of this class"
								: "a durable transcript could not be read for at least one session of this class",
			},
			summary: null,
			segments,
		});
	}

	// Decision 9: terminal agent sessions have no structured transcript; the
	// session summary travels alongside the explicit availability status.
	const terminal = isTerminalAgentSession(input.sessionSource);
	if (terminal) {
		sessions.push({
			kind: "task",
			taskId: input.taskId,
			listingTruncated: false,
			transcript: {
				status: "unavailable",
				reason: "terminal agent session; no structured transcript recorded",
			},
			summary: input.sessionSummary,
			segments: [],
		});
		reasons.push("terminal agent session; no structured transcript recorded");
	}

	// No transcript source at all: operational diagnostics still export, the
	// transcript is explicitly unavailable.
	const hasAnySegments = sessions.some((session) => session.segments.length > 0);
	if (!hasAnySegments && !terminal) {
		reasons.push("no Cline session transcript is recorded for this task");
	}

	const status: TaskDiagnosticsExportCompleteness["status"] = !hasAnySegments
		? "unavailable"
		: reasons.length > 0
			? "partial"
			: "complete";

	return {
		schemaVersion: TASK_DIAGNOSTICS_EXPORT_SCHEMA_VERSION,
		exportedAt: input.exportedAt,
		capture: {
			capturedAt: input.capturedAt,
			note: "Point-in-time capture; the live tail uses Kanban's display representation and may overlap the durable transcript.",
		},
		completeness: { status, reasons, warnings },
		diagnostics: input.diagnostics,
		taskPrompt: input.taskPrompt,
		sessions,
	};
}

// The snapshot's segment type matches the builder's expected shape; this
// adapter keeps the v3 plan decoupled from snapshot-internal field drift.
function snapshotSegments(snapshot: ClineTaskExportSnapshot): SnapshotSegmentForBuild[] {
	return snapshot.segments.map((segment) => ({
		header: segment.header,
		artifactTaskId: segment.artifactTaskId,
		launchConfig: segment.launchConfig,
		messages: segment.messages,
		liveTail: segment.liveTail,
		readError: segment.readError,
		toolOrigins: segment.toolOrigins,
		editorCallEvidence: segment.editorCallEvidence,
	}));
}
