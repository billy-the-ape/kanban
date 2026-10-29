// DIAG-2 (2a) — read-only, typed transcript export snapshot for a task session.
//
// This module owns the snapshot shape and the pure helpers that build it:
// - the allowlisted segment header (no raw metadata object, no prompt, no
//   messagesPath/hookPath/pid ever leave the runtime),
// - the live-tail merge with the fixed Decision-4 start points (latest durable
//   `ts` -> last durable tool_result position -> whole live list),
// - the seeded/compacted/native tool-origin labeling across restart segments.
//
// The snapshot is strictly additive: building one never pauses, clears, or
// mutates the task session state.

import type { TaskEditorCallEvidence } from "./cline-editor-call-evidence";
import type { ClineTaskMessage } from "./cline-session-state";
import { readPersistedTaskLaunchConfig } from "./cline-task-launch-config";
import type { ClineSdkPersistedMessage, ClineSdkSessionRecord } from "./sdk-runtime-boundary";

/** Session class exported in the bundle: the working session or a review session. */
export type ClineTaskExportKind = "task" | "review" | "verification-repair";

/**
 * Segment header with the explicit field allowlist (Decision 6). The record's
 * raw metadata object, prompt, messagesPath, hookPath, and pid are never
 * exported; the launch-config exception lives in `ClineTaskExportLaunchConfig`.
 */
export interface ClineTaskExportSegmentHeader {
	sessionId: string;
	kind: ClineTaskExportKind;
	/** SDK session source ("core" for local sessions). */
	source: string;
	/** SDK session status ("running" | "completed" | "failed" | "cancelled"). */
	status: string;
	/** ISO timestamp; null only for a live-bound session with no durable record yet. */
	startedAt: string | null;
	endedAt: string | null;
	updatedAt: string | null;
	provider: string;
	model: string;
	cwd: string;
	workspaceRoot: string;
	exitCode: number | null;
}

/** Decision 6 allowlisted exception from the persisted taskLaunchConfig. */
export interface ClineTaskExportLaunchConfig {
	mode: string;
	systemPrompt: string;
	/** "none" when the task explicitly disabled reasoning; null when unset. */
	reasoningEffort: string | null;
	/** Recorded @clinebot/core version at launch (AR-7); null for older sessions. */
	sdkVersion: string | null;
	/** Kanban-owned guidance version at launch (AR-7); null for older sessions. */
	guidanceVersion: string | null;
}

/**
 * Kanban display messages not yet present in the durable transcript (Decision
 * 4). Display messages use Kanban's representation, never the SDK's, and user /
 * assistant / reasoning messages cannot be stably matched against durable
 * messages, so the tail is flagged `possibleOverlap` instead of deduplicated.
 */
export interface ClineTaskExportLiveTail {
	messages: ClineTaskMessage[];
	representation: "kanban-display";
	possibleOverlap: boolean;
}

/** Decision 4: stable tool identity origin across restart segments. */
export type ClineTaskExportToolOrigin = "seeded-or-compacted" | "native" | "unknown";

export interface ClineTaskExportToolOriginEntry {
	/** Index of the durable message inside the segment's `messages`. */
	messageIndex: number;
	/** Index of the tool part inside that message's content block array. */
	partIndex: number;
	toolCallId: string;
	origin: ClineTaskExportToolOrigin;
}

export type ClineTaskExportTranscriptStatus = "complete" | "unavailable";

export interface ClineTaskExportTranscript {
	status: ClineTaskExportTranscriptStatus;
	/** Explanation when the transcript is unavailable (null when complete). */
	reason: string | null;
}

/** One SDK session segment (a task run) of the task's session lineage. */
export interface ClineTaskExportSegment {
	header: ClineTaskExportSegmentHeader;
	/**
	 * Service-scoped task id whose context-artifacts directory owns this
	 * session's full tool-result outputs (e.g. `<base>::review` for a review
	 * session). Used by the export's full-output lookup.
	 */
	artifactTaskId: string;
	launchConfig: ClineTaskExportLaunchConfig | null;
	transcript: ClineTaskExportTranscript;
	/** Durable SDK messages, raw and in original persisted order. */
	messages: ClineSdkPersistedMessage[];
	/** Live tail beyond the durable transcript for the currently bound session. */
	liveTail: ClineTaskExportLiveTail | null;
	/** Non-null when the durable transcript could not be read (a gap, not an error). */
	readError: string | null;
	/** Tool-origin evidence with message/part references (Decision 4). */
	toolOrigins: ClineTaskExportToolOriginEntry[];
	/**
	 * Additive editor transport evidence for this session's editor tool calls
	 * (raw pre-parse fragments + parsed/execution/result stages + factual
	 * old_text comparison). Null is not used: when no evidence was recorded
	 * the value's `status` is "unavailable", keeping old exports compatible.
	 */
	editorCallEvidence: TaskEditorCallEvidence;
}

/** All sessions owned by one service-scoped task id (e.g. `<base>::review`). */
export interface ClineTaskExportSnapshot {
	kind: ClineTaskExportKind;
	/** Service-scoped task id the snapshot was requested for. */
	taskId: string;
	/** Epoch millis of the point-in-time capture (Decision 5). */
	capturedAt: number;
	/**
	 * True when the session listing returned exactly the enumeration limit;
	 * the oldest segments may then be missing (Decision 3).
	 */
	listingTruncated: boolean;
	/**
	 * Per-session snapshot read failures encountered while enumerating this
	 * class (Decision 5: a failed read/enumeration is carried into the export
	 * as a gap, never silently dropped). Distinguishes "the class has no
	 * recorded sessions" from "one of them could not be read".
	 */
	enumerationErrors: string[];
	/** Segments in creation order (oldest first). */
	segments: ClineTaskExportSegment[];
}

/** Deterministic code-point ordering for session ids and timestamps (localeCompare is locale-dependent). */
export function compareExportStringValues(left: string, right: string): number {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

export interface ClineTaskExportSnapshotOptions {
	/**
	 * Ownership filter (Decision 3): recorded session cwd / workspaceRoot
	 * strings that are allowed to count as this task's sessions (typically the
	 * task worktree path and the workspace repo path). Absent/empty means no
	 * filtering.
	 */
	ownerPaths?: readonly string[];
	/**
	 * Session-id prefix override (DIAG-2): enumerate sessions matching this
	 * prefix instead of the default `buildSessionIdPrefix(taskId)`. The review
	 * lineage snapshot uses it to query every verification-repair round in one
	 * pass (no single task id prefixes all rounds).
	 */
	sessionIdPrefix?: string;
}

export function buildAllowlistedSessionHeader(
	record: ClineSdkSessionRecord,
	kind: ClineTaskExportKind,
): ClineTaskExportSegmentHeader {
	return {
		sessionId: record.sessionId,
		kind,
		source: record.source,
		status: record.status,
		startedAt: record.startedAt ?? null,
		endedAt: record.endedAt ?? null,
		updatedAt: record.updatedAt ?? null,
		provider: record.provider,
		model: record.model,
		cwd: record.cwd,
		workspaceRoot: record.workspaceRoot,
		exitCode: record.exitCode ?? null,
	};
}

/**
 * Header for a currently bound session whose durable record has not been
 * created yet (local SDK mode persists on the first send). Timestamps are
 * unknown at capture time and stay null rather than being invented.
 */
export function buildSyntheticSessionHeader(input: {
	sessionId: string;
	kind: ClineTaskExportKind;
	providerId: string | null;
	modelId: string | null;
	cwd: string | null;
}): ClineTaskExportSegmentHeader {
	return {
		sessionId: input.sessionId,
		kind: input.kind,
		source: "core",
		status: "running",
		startedAt: null,
		endedAt: null,
		updatedAt: null,
		provider: input.providerId ?? "",
		model: input.modelId ?? "",
		cwd: input.cwd ?? "",
		workspaceRoot: input.cwd ?? "",
		exitCode: null,
	};
}

export function extractLaunchConfigFromRecord(record: ClineSdkSessionRecord): ClineTaskExportLaunchConfig | null {
	const config = readPersistedTaskLaunchConfig(record);
	if (!config) {
		return null;
	}
	return {
		mode: config.mode,
		systemPrompt: config.systemPrompt,
		reasoningEffort: config.reasoningEffort ?? null,
		sdkVersion: config.sdkVersion,
		guidanceVersion: config.guidanceVersion,
	};
}

export function buildLaunchConfigFromStartRequest(input: {
	mode?: string | null;
	systemPrompt: string | null;
	reasoningEffort?: string | null;
	sdkVersion?: string | null;
	guidanceVersion?: string | null;
}): ClineTaskExportLaunchConfig {
	return {
		mode: input.mode ?? "act",
		systemPrompt: input.systemPrompt ?? "",
		reasoningEffort: input.reasoningEffort ?? null,
		sdkVersion: input.sdkVersion ?? null,
		guidanceVersion: input.guidanceVersion ?? null,
	};
}

/** The SDK's content-part union (discriminable on `type`). */
type DurableContentPart = Extract<ClineSdkPersistedMessage["content"], readonly unknown[]>[number];

function messageParts(message: ClineSdkPersistedMessage): DurableContentPart[] {
	return Array.isArray(message.content) ? message.content : [];
}

/** All stable tool ids (tool_use.id and tool_result.tool_use_id) in a durable transcript. */
export function collectDurableToolCallIds(messages: readonly ClineSdkPersistedMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		for (const part of messageParts(message)) {
			if (part.type === "tool_use") {
				ids.add(part.id);
			} else if (part.type === "tool_result") {
				ids.add(part.tool_use_id);
			}
		}
	}
	return ids;
}

/**
 * Decision 4 fixed-priority live tail:
 * 1. when any durable message carries a `ts`, start after the latest durable `ts`;
 * 2. otherwise, after the last durable tool_result position (matched by its
 *    stable tool_use_id against the display messages);
 * 3. otherwise, the whole live list.
 * Returns null when the live list is empty or nothing survives the start point.
 */
export function buildSessionExportLiveTail(
	durableMessages: readonly ClineSdkPersistedMessage[],
	liveMessages: readonly ClineTaskMessage[],
): ClineTaskExportLiveTail | null {
	if (!Array.isArray(liveMessages) || liveMessages.length === 0) {
		return null;
	}
	let start = 0;
	const durableTimestamps: number[] = [];
	for (const message of durableMessages) {
		if (typeof message.ts === "number" && Number.isFinite(message.ts)) {
			durableTimestamps.push(message.ts);
		}
	}
	if (durableTimestamps.length > 0) {
		const maxTimestamp = Math.max(...durableTimestamps);
		start = liveMessages.findIndex((message) => message.createdAt > maxTimestamp);
		if (start < 0) {
			start = liveMessages.length;
		}
	} else {
		const lastToolResultId = findLastDurableToolResultId(durableMessages);
		if (lastToolResultId !== null) {
			const index = liveMessages.findIndex((message) => message.meta?.toolCallId === lastToolResultId);
			// Found: everything after it. Not found: the durable transcript
			// already covers the latest known tool activity and no display
			// message can be proven newer.
			start = index >= 0 ? index + 1 : liveMessages.length;
		}
	}
	const tail = liveMessages.slice(start);
	if (tail.length === 0) {
		return null;
	}
	return {
		messages: tail,
		representation: "kanban-display",
		possibleOverlap: true,
	};
}

function findLastDurableToolResultId(messages: readonly ClineSdkPersistedMessage[]): string | null {
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
		const message = messages[messageIndex];
		if (!message) {
			continue;
		}
		const parts = messageParts(message);
		for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
			const part = parts[partIndex];
			if (part && part.type === "tool_result") {
				return part.tool_use_id;
			}
		}
	}
	return null;
}

/**
 * Decision 4 tool-origin labeling. For every tool part of a segment, its
 * stable id is tested against the union of the immediately preceding segment's
 * tool ids: a member is `seeded-or-compacted` (the seeded restart or the
 * compactor carried it over), a non-member is `native`. The first segment has
 * no predecessor and is `native`. Parts with no id to test are `unknown`.
 * Segments must be in creation order (oldest first); the labels are written
 * onto each segment in place.
 */
export function labelSegmentToolOrigins(segments: ClineTaskExportSegment[]): void {
	let predecessorIds: Set<string> | null = null;
	for (const segment of segments) {
		const entries: ClineTaskExportToolOriginEntry[] = [];
		segment.messages.forEach((message, messageIndex) => {
			const parts = messageParts(message);
			parts.forEach((part, partIndex) => {
				if (!part) {
					return;
				}
				if (part.type !== "tool_use" && part.type !== "tool_result") {
					return;
				}
				const toolCallId = part.type === "tool_use" ? part.id : part.tool_use_id;
				const origin: ClineTaskExportToolOrigin =
					typeof toolCallId !== "string" || toolCallId.length === 0
						? "unknown"
						: predecessorIds
							? predecessorIds.has(toolCallId)
								? "seeded-or-compacted"
								: "native"
							: "native";
				entries.push({ messageIndex, partIndex, toolCallId: toolCallId ?? "", origin });
			});
		});
		segment.toolOrigins = entries;
		predecessorIds = collectDurableToolCallIds(segment.messages);
	}
}
