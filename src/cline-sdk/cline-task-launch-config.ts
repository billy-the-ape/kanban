// B-4.8 — Durable task launch configuration.
//
// The launch configuration of a Cline task session (resolved system prompt,
// mode, task title, reasoning effort) is persisted into the SDK session
// record's `metadata` so a Kanban process restart can reconstruct the start
// request from durable storage instead of failing with "No previous Cline
// session config is available for task ...".
//
// Credentials are never persisted here: restarts re-resolve apiKey/baseUrl
// (and the context/compaction policy) live from the current provider
// settings through the B-2.8 launch-config resolver, pinning provider and
// model to the persisted session record. This keeps task records free of
// secrets, mirroring the B-2.1 diagnostic no-leak contract.
//
// The SDK session update API replaces `metadata` wholesale, so every write
// is read-merge-write: read the record, spread its existing metadata, add
// or replace the Kanban key, and pass the full object back.
import type { RuntimeClineReasoningEffort, RuntimeTaskSessionMode } from "../core/api-contract";
import type { ClineSdkSessionRecord } from "./sdk-runtime-boundary";

export const TASK_LAUNCH_CONFIG_METADATA_KEY = "kanban.taskLaunchConfig";

/**
 * Schema version of the persisted launch config. Bump it when the shape
 * changes; `readPersistedTaskLaunchConfig` rejects unknown versions so
 * records written by other versions degrade to the in-memory-only behavior.
 */
export const TASK_LAUNCH_CONFIG_SCHEMA_VERSION = 1;

export interface PersistedTaskLaunchConfig {
	version: number;
	mode: RuntimeTaskSessionMode;
	systemPrompt: string;
	taskTitle?: string;
	/**
	 * `null` means the task explicitly disabled reasoning ("none"); `undefined`
	 * means the task did not set an effort and the provider default applies.
	 */
	reasoningEffort?: RuntimeClineReasoningEffort | null;
	savedAt: string;
}

const CLINE_REASONING_EFFORTS: readonly RuntimeClineReasoningEffort[] = ["low", "medium", "high", "xhigh"];

function isClineReasoningEffort(value: unknown): value is RuntimeClineReasoningEffort {
	return typeof value === "string" && (CLINE_REASONING_EFFORTS as readonly string[]).includes(value);
}

function isTaskSessionMode(value: unknown): value is RuntimeTaskSessionMode {
	return value === "act" || value === "plan";
}

/**
 * Builds the persisted launch config from a session start request. Only
 * credential-free launch inputs are stored; provider, model, and cwd are
 * read from the session record itself at recovery time.
 */
export function buildPersistedTaskLaunchConfig(input: {
	mode?: RuntimeTaskSessionMode | null;
	systemPrompt?: string | null;
	taskTitle?: string | null;
	reasoningEffort?: RuntimeClineReasoningEffort | null;
}): PersistedTaskLaunchConfig {
	const config: PersistedTaskLaunchConfig = {
		version: TASK_LAUNCH_CONFIG_SCHEMA_VERSION,
		mode: input.mode ?? "act",
		systemPrompt: input.systemPrompt ?? "",
		savedAt: new Date().toISOString(),
	};
	const taskTitle = input.taskTitle?.trim();
	if (taskTitle) {
		config.taskTitle = taskTitle;
	}
	if (input.reasoningEffort !== undefined) {
		config.reasoningEffort = input.reasoningEffort;
	}
	return config;
}

/**
 * Reads and validates the persisted launch config from a session record.
 * Returns null when the record has no config, the schema version is
 * unknown, or any stored field is malformed — recovery then falls back to
 * the in-memory-only behavior (and the B-1.7 error when that is empty).
 */
export function readPersistedTaskLaunchConfig(
	record: ClineSdkSessionRecord | null | undefined,
): PersistedTaskLaunchConfig | null {
	const metadata = record?.metadata;
	if (!metadata || typeof metadata !== "object") {
		return null;
	}
	const raw = metadata[TASK_LAUNCH_CONFIG_METADATA_KEY];
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const value = raw as Record<string, unknown>;
	if (value.version !== TASK_LAUNCH_CONFIG_SCHEMA_VERSION) {
		return null;
	}
	if (!isTaskSessionMode(value.mode)) {
		return null;
	}
	if (typeof value.systemPrompt !== "string" || value.systemPrompt.trim().length === 0) {
		return null;
	}
	if (typeof value.savedAt !== "string") {
		return null;
	}
	const config: PersistedTaskLaunchConfig = {
		version: value.version,
		mode: value.mode,
		systemPrompt: value.systemPrompt,
		savedAt: value.savedAt,
	};
	if (typeof value.taskTitle === "string" && value.taskTitle.trim().length > 0) {
		config.taskTitle = value.taskTitle;
	}
	if (value.reasoningEffort === null) {
		config.reasoningEffort = null;
	} else if (isClineReasoningEffort(value.reasoningEffort)) {
		config.reasoningEffort = value.reasoningEffort;
	}
	return config;
}

/**
 * Merges the persisted launch config into existing session record metadata.
 * The SDK replaces `metadata` wholesale on update, so callers must pass the
 * full merged object back to preserve foreign keys (e.g. the persisted
 * Kanban title).
 */
export function mergeTaskLaunchConfigIntoMetadata(
	metadata: Record<string, unknown> | null | undefined,
	config: PersistedTaskLaunchConfig,
): Record<string, unknown> {
	return {
		...(metadata && typeof metadata === "object" ? metadata : {}),
		[TASK_LAUNCH_CONFIG_METADATA_KEY]: config,
	};
}
