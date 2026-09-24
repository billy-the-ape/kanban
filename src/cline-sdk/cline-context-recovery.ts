// B-3 — Safe bounded context-overflow recovery.
//
// B-3.1 — Classification of provider context-overflow errors. The retired
// Kanban fallback (cline-context-overflow-compaction.ts) had two known
// defects, both fixed here:
//
// 1. It required `instanceof Error` before any matching ran, so structured
//    provider error objects (plain JSON from the API gateway or SDK) and
//    errors nested under `cause` were never classified.
// 2. Its pattern list matched any message merely mentioning "context
//    window" or "context length" (e.g. a UI error about a "context window
//    panel"), so unrelated failures were retried as overflows.
//
// This module classifies on structured fields (provider error `code`, HTTP
// status) first and treats message-string matching as the last resort. It
// walks the error `cause` chain (depth-bounded, cycle-guarded) and unwraps
// provider envelopes such as `{ error: { message, code, status } }`.
//
// B-3.4 / B-3.7 — Pre-restart budget verdicts for the reactive recovery
// path (InMemoryClineTaskSessionService.retryAfterContextOverflow):
//
// - evaluateClineRecoveryRequirements: when the ORIGINAL task requirements
//   (first user message) alone exceed the calibrated compaction target,
//   compaction would have to truncate them — pause with an actionable
//   reason instead of silently dropping them (B-3.4).
// - evaluateClineContextRecoveryBudget: when the pinned, non-compactable
//   request material (system prompt + restart prompt + images) alone
//   exceeds the effective input budget, no amount of history compaction can
//   make the turn fit — pause with that specific reason instead of burning
//   a bounded recovery attempt (B-3.7).
//
// All token math uses the documented chars/4 estimator from B-2.3
// (cline-context-budget.ts), the same approach the B-2.5 calibration uses.
// Every function here is pure: no SDK, provider, or filesystem involvement.

import type { RuntimeTaskImage } from "../core/api-contract";
import { computeClineCompactionSafetyMarginTokens } from "./cline-compaction-config";
import { createFallbackMessageTokenEstimator, estimateTextTokens } from "./cline-context-budget";
import type { ClineSdkPersistedMessage } from "./sdk-runtime-boundary";

// ---------------------------------------------------------------------------
// B-3.1 — Overflow error classification
// ---------------------------------------------------------------------------

/** Depth bound for walking the `cause` chain (guards against pathological cycles). */
const MAX_CONTEXT_OVERFLOW_CAUSE_DEPTH = 8;

/**
 * Structured provider error codes that unambiguously mean "the request
 * exceeded the model's context". Matched case-insensitively on the `code`
 * field of any error in the chain.
 */
const STRUCTURED_CONTEXT_OVERFLOW_CODES = new Set<string>([
	"context_length_exceeded",
	"max_context_length_exceeded",
	"prompt_too_long",
]);

/**
 * Narrow message patterns, the last-resort classification. Each pattern
 * ties the overflow explicitly to the model's context/input size; a mere
 * mention of "context window" (UI panels, file names, ...) must not match.
 */
const CONTEXT_OVERFLOW_MESSAGE_PATTERNS: readonly RegExp[] = [
	/prompt is too long/i,
	/maximum context (length|window)/i,
	/maximum prompt length/i,
	/context length exceeded/i,
	/exceeds? the (available )?context (size|length|window)/i,
	/exceeds? .{0,60}?(context (limit|length|size|window)|token limit)/i,
	/too many (input )?tokens/i,
	/input (length )?(is |was )?too long/i,
	/total number of tokens.{0,80}?exceeds?/i,
	/requested (input )?(length|tokens)/i,
	/context window (is full|has been (full|reached|exceeded)|exceeded|limit)/i,
	/(context (size|length)|context window) (exceeded|exhausted)/i,
	/request payload size exceeds/i,
];

interface ContextOverflowErrorCandidate {
	record: Record<string, unknown> | null;
	text: string | null;
}

function toContextOverflowCandidate(value: unknown): ContextOverflowErrorCandidate {
	if (typeof value === "string") {
		return { record: null, text: value };
	}
	if (typeof value !== "object" || value === null) {
		return { record: null, text: null };
	}
	const record = value as Record<string, unknown>;
	const message = typeof record.message === "string" ? record.message : null;
	return { record, text: message };
}

/**
 * Collects the values to inspect: the error itself, any structured provider
 * payload nested under `error` (API gateway envelope), and each `cause`
 * further down the chain (depth-bounded, cycle-guarded).
 */
function collectContextOverflowCandidates(error: unknown): ContextOverflowErrorCandidate[] {
	const seen = new Set<object>();
	const candidates: ContextOverflowErrorCandidate[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CONTEXT_OVERFLOW_CAUSE_DEPTH; depth += 1) {
		if (current === null || current === undefined || typeof current !== "object") {
			break;
		}
		if (seen.has(current)) {
			break;
		}
		seen.add(current);
		candidates.push(toContextOverflowCandidate(current));
		const record = current as Record<string, unknown>;
		const payload = record.error;
		if (payload !== null && payload !== undefined) {
			if (typeof payload === "object") {
				seen.add(payload);
			}
			candidates.push(toContextOverflowCandidate(payload));
			// The envelope usually owns the rest of the cause chain.
			const payloadCause =
				typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).cause : undefined;
			current = payloadCause !== undefined ? payloadCause : record.cause;
		} else {
			current = record.cause;
		}
	}
	return candidates;
}

function readHttpStatus(record: Record<string, unknown>): number | null {
	for (const key of ["status", "statusCode", "status_code"]) {
		const value = record[key];
		if (typeof value === "number" && Number.isInteger(value)) {
			return value;
		}
		if (typeof value === "string" && /^\d{3}$/.test(value)) {
			return Number(value);
		}
	}
	return null;
}

function candidateHasStructuredOverflow(candidate: ContextOverflowErrorCandidate): boolean {
	const record = candidate.record;
	if (!record) {
		return false;
	}
	const code = typeof record.code === "string" ? record.code.toLowerCase() : null;
	if (code && STRUCTURED_CONTEXT_OVERFLOW_CODES.has(code)) {
		return true;
	}
	// HTTP 413 (Payload Too Large) from the model endpoint means the request
	// itself was too big — for a chat model that is a context overflow, and
	// compaction is the correct recovery.
	return readHttpStatus(record) === 413;
}

/**
 * Classifies a provider error (of any shape) as a context overflow.
 *
 * Structured fields win: a known provider error `code` or HTTP 413 status
 * anywhere in the `cause` chain is authoritative. Only when no structured
 * field matches does the message text get checked against the narrow
 * overflow patterns.
 */
export function isContextOverflowError(error: unknown): boolean {
	const candidates = collectContextOverflowCandidates(error);
	for (const candidate of candidates) {
		if (candidateHasStructuredOverflow(candidate)) {
			return true;
		}
	}
	for (const candidate of candidates) {
		const text = candidate.text;
		if (text && CONTEXT_OVERFLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(text))) {
			return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// B-3.4 / B-3.7 — Recovery budget verdicts
// ---------------------------------------------------------------------------

function toFiniteNonNegativeTokenCount(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export interface EvaluateClineContextRecoveryBudgetInput {
	/** Effective context window (tokens) from the start request's compaction config. */
	contextWindowTokens?: number | null;
	/** Output reserve (tokens) from the start request's compaction config. */
	reserveTokens?: number | null;
	/** User-set safety margin (tokens) from the start request; computed margin otherwise. */
	safetyMarginTokens?: number | null;
	/** The resolved system prompt for the session (rules included). */
	systemPrompt?: string | null;
	/** The prompt the recovery restart would (re)send. */
	prompt: string;
	images?: readonly RuntimeTaskImage[] | null;
}

export interface ClineContextRecoveryBudgetVerdict {
	/** false when no context window was known (nothing to check against). */
	checked: boolean;
	fits: boolean;
	inputBudgetTokens: number | null;
	pinnedRequestTokens: number | null;
	reason: string | null;
}

/**
 * B-3.7: measures the pinned, non-compactable material of the restart
 * request (system prompt + prompt + images) against the effective input
 * budget (window - output reserve - safety margin, the same budget the
 * B-2.5 calibration subtracts before compaction can begin).
 *
 * Returns `fits: false` with an actionable reason when that material alone
 * cannot fit — in which case removing conversation history cannot make the
 * turn fit either and recovery must pause.
 */
export function evaluateClineContextRecoveryBudget(
	input: EvaluateClineContextRecoveryBudgetInput,
): ClineContextRecoveryBudgetVerdict {
	const contextWindowTokens = toFiniteNonNegativeTokenCount(input.contextWindowTokens);
	if (contextWindowTokens === null) {
		return { checked: false, fits: true, inputBudgetTokens: null, pinnedRequestTokens: null, reason: null };
	}
	const reserveTokens = toFiniteNonNegativeTokenCount(input.reserveTokens) ?? 0;
	const safetyMarginTokens =
		toFiniteNonNegativeTokenCount(input.safetyMarginTokens) ??
		computeClineCompactionSafetyMarginTokens(contextWindowTokens);
	const inputBudgetTokens = contextWindowTokens - reserveTokens - safetyMarginTokens;
	const imageTokens = (input.images ?? []).reduce((sum, image) => sum + estimateTextTokens(image.data), 0);
	const pinnedRequestTokens =
		estimateTextTokens(input.systemPrompt ?? "") + estimateTextTokens(input.prompt) + imageTokens;
	const fits = inputBudgetTokens > 0 && pinnedRequestTokens <= inputBudgetTokens;
	const reason = fits
		? null
		: `Context overflow recovery cannot fit this turn: the system prompt, prompt, and images alone need ~${pinnedRequestTokens} tokens, but the effective input budget is ${inputBudgetTokens} tokens (window ${contextWindowTokens}, output reserve ${reserveTokens}, safety margin ${safetyMarginTokens}). Shorten the prompt or increase the context budget — removing conversation history cannot make this turn fit.`;
	return { checked: true, fits, inputBudgetTokens, pinnedRequestTokens, reason };
}

const estimatePersistedMessageTokens = createFallbackMessageTokenEstimator();

export interface EvaluateClineRecoveryRequirementsInput {
	/** The persisted transcript that recovery would compact. */
	messages: readonly ClineSdkPersistedMessage[];
	/** Calibrated compaction target (triggerTokens) the transcript must fit. */
	targetTokens: number;
}

export interface ClineRecoveryRequirementsVerdict {
	/** false when the transcript carries no user message to check. */
	checked: boolean;
	fits: boolean;
	firstUserMessageTokens: number | null;
	targetTokens: number | null;
	reason: string | null;
}

/**
 * B-3.4: the first user message carries the ORIGINAL task requirements.
 * The deterministic compactor preserves it (truncating only as a last
 * resort), so when it alone exceeds the compaction target, recovery would
 * have to truncate the requirements — pause with an actionable reason
 * instead of silently discarding pinned material.
 */
export function evaluateClineRecoveryRequirements(
	input: EvaluateClineRecoveryRequirementsInput,
): ClineRecoveryRequirementsVerdict {
	const firstUserMessage = input.messages.find((message) => message.role === "user");
	if (!firstUserMessage) {
		return { checked: false, fits: true, firstUserMessageTokens: null, targetTokens: null, reason: null };
	}
	const firstUserMessageTokens = estimatePersistedMessageTokens(firstUserMessage);
	const fits = firstUserMessageTokens <= input.targetTokens;
	const reason = fits
		? null
		: `Context overflow recovery cannot preserve the original task requirements: they need ~${firstUserMessageTokens} tokens, but the compaction target is ${input.targetTokens} tokens. Shorten the task requirements or increase the context budget — recovery will not silently truncate the original requirements.`;
	return { checked: true, fits, firstUserMessageTokens, targetTokens: input.targetTokens, reason };
}

// ---------------------------------------------------------------------------
// B-3.5 — Uncertain tool completion
// ---------------------------------------------------------------------------

export interface ClineUnresolvedToolCall {
	id: string;
	name: string;
}

/**
 * Tool calls in the persisted transcript that have no recorded result. Such
 * a call may or may not have run (and changed files) before the session was
 * interrupted, so recovery must not resend the turn as if it had not: the
 * compactor would drop the dangling call and the model would decide again.
 */
export function findClineUnresolvedToolCalls(messages: readonly ClineSdkPersistedMessage[]): ClineUnresolvedToolCall[] {
	const resolvedIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "user" || typeof message.content === "string") {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "tool_result") {
				resolvedIds.add(block.tool_use_id);
			}
		}
	}
	const unresolved: ClineUnresolvedToolCall[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || typeof message.content === "string") {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "tool_use" && !resolvedIds.has(block.id)) {
				unresolved.push({ id: block.id, name: block.name });
			}
		}
	}
	return unresolved;
}

/** The actionable pause reason for unresolved tool calls (B-3.5). */
export function describeClineUnresolvedToolCalls(unresolved: readonly ClineUnresolvedToolCall[]): string {
	const names = [...new Set(unresolved.map((call) => call.name))].join(", ");
	return `Context overflow recovery paused: ${unresolved.length} tool call(s) (${names}) have no recorded result, so it is unknown whether they ran. Check the task worktree for their effects, then send a follow-up to continue — recovery will not re-run or discard them automatically.`;
}
