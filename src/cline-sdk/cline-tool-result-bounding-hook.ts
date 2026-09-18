// B-2.6 — Bound oversized read-family tool results at ingestion time.
//
// Investigation findings (verified against @clinebot/core 0.0.38 + @clinebot/agents bundles):
// - The SDK truncates oversized tool results at REQUEST ASSEMBLY time:
//   MessageBuilder.buildForApi caps each target tool result (read, read_files, search,
//   search_codebase, bash, run_commands) at 50,000 chars. That rewrite is request-scoped:
//   the persisted transcript keeps the full (multi-MB) content, so Kanban's B-2.5 estimator
//   and any later provider still see the unbounded content, and the truncated request has
//   no way to point the agent at the full content.
// - The agent runtime (@clinebot/agents) invokes `hooks.afterTool` after every tool
//   execution, and any `result` a hook returns replaces the tool result before the
//   `tool-result` message is persisted. That is a supported, typed session-config surface
//   (AgentHooks), so no SDK patch is needed for this bound.
//
// This hook uses that surface to enforce a persistent per-result bound at ingestion time:
// when a read-family tool result exceeds the bound, the full content is written to a local
// artifact (src/workspace/task-artifacts.ts, outside any repo checkout) and the persisted
// result is replaced with a bounded head+tail excerpt plus a `Full content: <absolute path>`
// reference the agent can page through by reading.
//
// Bound: min(50_000, max(4_000, round(limitTokens * 0.1) * 4)) chars, where limitTokens is
// the session's effective (uncalibrated) context window (B-2.2). The 50,000 cap matches the
// SDK's own request-assembly per-tool cap, so Kanban's bound never exceeds what the SDK
// would keep; the 10% window ratio means a single read can never occupy more than a tenth
// of the window, even when prior usage is zero. All values are char-based, matching the
// chars/4 estimator convention from B-2.3.
//
// Scope: read-family tools only (B-2.6). B-2.7 extends CLINE_TOOL_RESULT_BOUND_TOOL_NAMES
// with command output / diff producers once their artifact semantics are defined.
//
// Failure mode: if the artifact write fails, the result is still bounded (excerpt without
// the reference line) so the session never breaks; the failure is logged.

import type { WriteTaskContextArtifactInput } from "../workspace/task-artifacts";
import { writeTaskContextArtifact } from "../workspace/task-artifacts";
import type { ClineSdkAgentAfterToolHook, ClineSdkBasicLogger } from "./sdk-runtime-boundary";
import { CLINE_SDK_DEFAULT_CONTEXT_WINDOW_TOKENS } from "./sdk-runtime-boundary";

/**
 * Per-tool-result cap in chars. Mirrors the SDK's request-assembly per-tool cap (50,000
 * chars in @clinebot/core 0.0.38's MessageBuilder) so Kanban's ingestion-time bound never
 * exceeds what the SDK would keep at request time.
 */
export const CLINE_TOOL_RESULT_BOUND_MAX_CHARS = 50_000;
/** Floor so very small windows still get a usable excerpt (tiny windows are covered by the B-2.5 overflow backstop). */
export const CLINE_TOOL_RESULT_BOUND_MIN_CHARS = 4_000;
/** Fraction of the effective window a single tool result may occupy. */
export const CLINE_TOOL_RESULT_BOUND_WINDOW_RATIO = 0.1;
/** Chars per token estimate (B-2.3 chars/4 convention). */
const ESTIMATED_CHARS_PER_TOKEN = 4;
/** Tool names bounded by this hook (B-2.6 scope: file reads). */
export const CLINE_TOOL_RESULT_BOUND_TOOL_NAMES = ["read_files", "read"] as const;

/**
 * Computes the per-result bound in chars for a session with the given effective
 * (uncalibrated) context window. Unknown or non-positive windows fall back to the SDK
 * default window; the result is always within [MIN, MAX] chars.
 */
export function computeToolResultBoundChars(limitTokens?: number): number {
	const effectiveLimitTokens =
		typeof limitTokens === "number" && Number.isFinite(limitTokens) && limitTokens > 0
			? limitTokens
			: CLINE_SDK_DEFAULT_CONTEXT_WINDOW_TOKENS;
	const targetChars =
		Math.round(effectiveLimitTokens * CLINE_TOOL_RESULT_BOUND_WINDOW_RATIO) * ESTIMATED_CHARS_PER_TOKEN;
	return Math.min(CLINE_TOOL_RESULT_BOUND_MAX_CHARS, Math.max(CLINE_TOOL_RESULT_BOUND_MIN_CHARS, targetChars));
}

/**
 * Builds a bounded excerpt: head + tail with an omission marker, plus a
 * `Full content: <path>` reference when the full content has an artifact. The returned
 * text is guaranteed to be at most `budgetChars` long even when the reference line is
 * present (the head/tail sizes account for the marker's digit count).
 */
export function buildBoundedToolResultExcerpt(fullText: string, budgetChars: number, artifactPath?: string): string {
	const referenceSuffix = artifactPath ? `\nFull content: ${artifactPath}` : "";
	// Nothing to truncate when the full text (plus its reference) already fits.
	if (fullText.length + referenceSuffix.length <= budgetChars) {
		return `${fullText}${referenceSuffix}`;
	}
	const bodyBudget = Math.max(0, budgetChars - referenceSuffix.length);
	// Layout: head + "\n\n" + marker + "\n\n" + tail (+ referenceSuffix). The marker's digit
	// count shifts the head/tail sizes, so iterate until the size stabilizes.
	let headLength = Math.max(0, Math.floor((bodyBudget - 4 - 32) / 2));
	for (let pass = 0; pass < 4; pass += 1) {
		const omittedChars = Math.max(0, fullText.length - headLength * 2);
		const markerLength = `...[truncated ${omittedChars} chars]...`.length;
		const nextHeadLength = Math.max(0, Math.floor((bodyBudget - 4 - markerLength) / 2));
		if (nextHeadLength === headLength) {
			break;
		}
		headLength = nextHeadLength;
	}
	const omittedChars = Math.max(0, fullText.length - headLength * 2);
	const head = fullText.slice(0, headLength);
	const tail = fullText.slice(Math.max(0, fullText.length - headLength));
	return `${head}\n\n...[truncated ${omittedChars} chars]...\n\n${tail}${referenceSuffix}`;
}

function serializeToolResultOutput(output: unknown): string {
	if (typeof output === "string") {
		return output;
	}
	if (output === undefined || output === null) {
		return "";
	}
	try {
		return JSON.stringify(output);
	} catch {
		return String(output);
	}
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface CreateClineToolResultBoundingHookOptions {
	/** Task that owns the artifact directory for this session. */
	taskId: string;
	/** Effective (uncalibrated) context window in tokens; the bound scales with this. */
	limitTokens?: number;
	/** Session logger; diagnostics only, never fatal. */
	logger?: ClineSdkBasicLogger;
	/** Tool names to bound; defaults to the read-family tools. */
	toolNames?: readonly string[];
	/** Artifact writer override (tests); defaults to writeTaskContextArtifact. */
	writeArtifact?: (input: WriteTaskContextArtifactInput) => Promise<string>;
}

/**
 * Creates the agent-runtime `afterTool` hook that bounds oversized read-family tool results
 * at ingestion time and preserves the full content as a local artifact (module header for
 * the investigation findings and bound derivation).
 */
export function createClineToolResultBoundingHook(
	options: CreateClineToolResultBoundingHookOptions,
): ClineSdkAgentAfterToolHook {
	const boundChars = computeToolResultBoundChars(options.limitTokens);
	const toolNames = new Set(options.toolNames ?? CLINE_TOOL_RESULT_BOUND_TOOL_NAMES);
	const writeArtifact = options.writeArtifact ?? writeTaskContextArtifact;
	return async (context) => {
		const toolName = context.toolCall.toolName;
		if (!toolNames.has(toolName)) {
			return;
		}
		const fullText = serializeToolResultOutput(context.result.output);
		if (fullText.length <= boundChars) {
			return;
		}
		const toolCallId = context.toolCall.toolCallId;
		let artifactPath: string | undefined;
		try {
			artifactPath = await writeArtifact({
				taskId: options.taskId,
				toolCallId,
				content: fullText,
			});
		} catch (error) {
			options.logger?.log(
				"Failed to write full tool-result content to artifact; bounding without the full-content reference",
				{
					severity: "warn",
					toolName,
					toolCallId,
					error: toErrorMessage(error),
				},
			);
		}
		const excerpt = buildBoundedToolResultExcerpt(fullText, boundChars, artifactPath);
		options.logger?.log("Bounded oversized tool result at ingestion (full content preserved as a local artifact)", {
			toolName,
			toolCallId,
			originalChars: fullText.length,
			boundedChars: excerpt.length,
			boundChars,
			artifactPath: artifactPath ?? null,
		});
		return {
			result: { ...context.result, output: excerpt },
		};
	};
}
