// Turn-based deterministic compaction shared by both Kanban compactors (the
// local-mode beforeModel hook over agent-runtime messages and the SDK
// `compact` callback / overflow recovery over persisted messages).
//
// Why turns, not roles: the earlier strategy deleted every old assistant
// message before touching any tool result. Assistant messages are tiny
// (a tool call plus a little text), so a request that needed a 5% trim lost
// every assistant message; the orphan repair then dropped every tool result,
// leaving the first prompt plus the last step (~2% of the history). Because
// the beforeModel rewrite is request-scoped and re-runs over the full
// transcript on every call, the model kept a one-step memory for the rest of
// the session: it re-discovered its own edits as unexplained changes and
// looped investigating them.
//
// This module instead:
// - groups the conversation into turns (an assistant message together with
//   the tool results that answer it; a user text message starts its own
//   turn), so dropping a turn never orphans tool results and only removes
//   what the budget needs;
// - drops turns oldest-first at chunk boundaries fixed by the transcript
//   prefix, so consecutive requests reuse the same cut (and the provider's
//   prompt prefix cache) until the kept tail outgrows the budget again;
// - records a bounded digest of what the dropped turns did (tool calls,
//   failures, and user instructions) in the compaction notice, so the model
//   knows the changes it finds in the workspace are its own work.
//
// Domain specifics (message shapes, estimators, truncation) stay in the two
// callers via `CompactionMessageAdapter`. Pure: no provider, SDK, or
// filesystem involvement.

import { formatClineToolCallLabel, getClineToolCallDisplay } from "./cline-tool-call-display";
import type { ClineSdkBasicLogger } from "./sdk-runtime-boundary";

/** Shared prefix of every compaction notice (tests and callers match on it). */
export const COMPACTION_NOTICE_PREFIX = "[Earlier conversation turns were removed to fit the context window.";

/** Notice used when no digest line fits the budget. */
export const COMPACTION_NOTICE_PLAIN = `${COMPACTION_NOTICE_PREFIX} Infer prior actions from the current environment state.]`;

const COMPACTION_NOTICE_DIGEST_HEADER =
	`${COMPACTION_NOTICE_PREFIX} You already did the following in this task (oldest first). ` +
	"File changes from these actions are your own work, not external edits:";
/** Closing line of a digest notice; digest lines are single-line, so this is unambiguous. */
const COMPACTION_NOTICE_DIGEST_END = "\n]";
const DIGEST_LINE_PREFIX = "- ";

/** Share of the target the turn-drop cut advances by (cut stability vs. over-trimming). */
const CUT_CHUNK_RATIO = 0.2;
/** Share of the target the notice digest may use. */
const DIGEST_BUDGET_RATIO = 0.1;
/** Hard cap on digest tokens regardless of the target. */
const DIGEST_MAX_TOKENS = 2_000;
/** Maximum characters of one digest line. */
const DIGEST_LINE_MAX_CHARS = 200;
/** Minimum truncated-message size (mirrors the SDK's basic strategy). */
const MIN_TRUNCATED_MESSAGE_TOKENS = 16;

/**
 * Splits a leading compaction notice off `text`. Returns null when `text`
 * does not start with one; `rest` drops the separator that followed it.
 */
export function splitLeadingCompactionNotice(text: string): { notice: string; rest: string } | null {
	if (!text.startsWith(COMPACTION_NOTICE_PREFIX)) {
		return null;
	}
	let end = -1;
	if (text.startsWith(COMPACTION_NOTICE_PLAIN)) {
		end = COMPACTION_NOTICE_PLAIN.length;
	} else if (text.startsWith(COMPACTION_NOTICE_DIGEST_HEADER)) {
		const close = text.indexOf(COMPACTION_NOTICE_DIGEST_END);
		end = close < 0 ? -1 : close + COMPACTION_NOTICE_DIGEST_END.length;
	}
	if (end < 0) {
		return null;
	}
	return { notice: text.slice(0, end), rest: text.slice(end).replace(/^\n\n/, "") };
}

export interface CompactionToolCall {
	toolCallId: string;
	toolName: string;
	input: unknown;
}

export interface CompactionToolResult {
	toolCallId: string;
	isError: boolean;
}

/** Domain-specific operations the turn compactor needs from a message shape. */
export interface CompactionMessageAdapter<M> {
	estimate(message: M): number;
	isAssistant(message: M): boolean;
	isUser(message: M): boolean;
	toolCalls(message: M): CompactionToolCall[];
	toolResults(message: M): CompactionToolResult[];
	/** Text a user wrote in this message (excluding tool results and compaction notices). */
	userText(message: M): string;
	/** Removes tool results whose call ids are not in `toolCallIds`; null when nothing is left. */
	pruneOrphanToolResults(message: M, toolCallIds: ReadonlySet<string>): M | null;
	/** Shrinks text-like content to roughly `maxTokens`; null when nothing could shrink. */
	truncate(message: M, maxTokens: number): M | null;
	/** Returns the message with the leading compaction notice removed, plus that notice's text. */
	stripNotice(message: M): { message: M; notice: string | null };
	prependNotice(message: M, notice: string): M;
}

export interface CompactConversationTurnsResult<M> {
	messages: M[];
	changed: boolean;
	/** Estimated message tokens before compaction. */
	tokensBefore: number;
	/** Estimated message tokens after compaction. */
	tokensAfter: number;
	/** Turns dropped (0 when only truncation happened). */
	turnsDropped: number;
}

interface Turn<M> {
	messages: M[];
	tokens: number;
}

function toSingleLine(text: string, maxChars: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

/** Digest lines for one dropped turn: user instructions and tool calls (with failures). */
function describeTurn<M>(turn: Turn<M>, adapter: CompactionMessageAdapter<M>): string[] {
	const failedToolCallIds = new Set(
		turn.messages.flatMap((message) =>
			adapter
				.toolResults(message)
				.filter((result) => result.isError)
				.map((result) => result.toolCallId),
		),
	);
	const lines: string[] = [];
	for (const message of turn.messages) {
		if (adapter.isUser(message)) {
			const text = adapter.userText(message);
			if (text.trim()) {
				lines.push(toSingleLine(`User: ${text}`, DIGEST_LINE_MAX_CHARS));
			}
		}
		for (const call of adapter.toolCalls(message)) {
			const display = getClineToolCallDisplay(call.toolName, call.input);
			const label = formatClineToolCallLabel(display.toolName, display.inputSummary);
			const suffix = failedToolCallIds.has(call.toolCallId) ? " (failed)" : "";
			lines.push(`${toSingleLine(label, DIGEST_LINE_MAX_CHARS - suffix.length)}${suffix}`);
		}
	}
	return lines;
}

/** Digest lines carried by an earlier (persisted) compaction notice. */
function parseNoticeDigest(notice: string | null): string[] {
	if (!notice?.startsWith(COMPACTION_NOTICE_DIGEST_HEADER)) {
		return [];
	}
	return notice
		.split("\n")
		.filter((line) => line.startsWith(DIGEST_LINE_PREFIX))
		.map((line) => line.slice(DIGEST_LINE_PREFIX.length));
}

/**
 * Builds the notice text for `lines`, keeping the newest lines that fit
 * `maxTokens` (chars/4). Returns the plain notice when no line fits.
 */
function buildNotice(lines: readonly string[], maxTokens: number): string {
	const maxChars = maxTokens * 4 - COMPACTION_NOTICE_DIGEST_HEADER.length - COMPACTION_NOTICE_DIGEST_END.length;
	const kept: string[] = [];
	let chars = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = `\n${DIGEST_LINE_PREFIX}${lines[index]}`;
		if (chars + line.length > maxChars) {
			break;
		}
		kept.unshift(line);
		chars += line.length;
	}
	if (kept.length === 0) {
		return COMPACTION_NOTICE_PLAIN;
	}
	const omitted = lines.length - kept.length;
	if (omitted > 0) {
		const omittedLine = `\n${DIGEST_LINE_PREFIX}(${omitted} earlier actions omitted)`;
		if (chars + omittedLine.length <= maxChars) {
			kept.unshift(omittedLine);
		} else {
			kept.shift();
			kept.unshift(`\n${DIGEST_LINE_PREFIX}(${omitted + 1} earlier actions omitted)`);
		}
	}
	return `${COMPACTION_NOTICE_DIGEST_HEADER}${kept.join("")}${COMPACTION_NOTICE_DIGEST_END}`;
}

/** Splits `body` into turns: assistant messages and tool-result-free user messages start a turn. */
function splitTurns<M>(body: readonly M[], adapter: CompactionMessageAdapter<M>): Turn<M>[] {
	const turns: Turn<M>[] = [];
	for (const message of body) {
		const startsTurn =
			turns.length === 0 ||
			adapter.isAssistant(message) ||
			(adapter.isUser(message) && adapter.toolResults(message).length === 0);
		if (startsTurn) {
			turns.push({ messages: [], tokens: 0 });
		}
		const turn = turns[turns.length - 1];
		turn.messages.push(message);
		turn.tokens += adapter.estimate(message);
	}
	return turns;
}

/**
 * Candidate drop counts (turns removed from the front), smallest first.
 * Boundaries advance by roughly `chunkTokens` and depend only on the
 * transcript prefix, so they stay put as new turns are appended.
 */
function candidateDropCounts<M>(turns: readonly Turn<M>[], droppableCount: number, chunkTokens: number): number[] {
	const counts = [0];
	let accumulated = 0;
	for (let index = 0; index < droppableCount; index += 1) {
		accumulated += turns[index].tokens;
		if (accumulated >= chunkTokens || index === droppableCount - 1) {
			counts.push(index + 1);
			accumulated = 0;
		}
	}
	return counts;
}

function removeOrphanToolResults<M>(messages: readonly M[], adapter: CompactionMessageAdapter<M>): M[] {
	const toolCallIds = new Set(
		messages.flatMap((message) => adapter.toolCalls(message).map((call) => call.toolCallId)),
	);
	return messages.flatMap((message) => {
		if (adapter.toolResults(message).length === 0) {
			return [message];
		}
		const pruned = adapter.pruneOrphanToolResults(message, toolCallIds);
		return pruned ? [pruned] : [];
	});
}

/**
 * Deterministically compacts a conversation so its estimated message tokens
 * fit `targetTokens`. Order of resort:
 *
 * 1. drop the oldest turns (at stable chunk boundaries), keeping the first
 *    user message, the most recent user instruction, and the latest turn;
 * 2. drop the most recent user instruction's turn;
 * 3. truncate the remaining turns' text-like content from the back;
 * 4. drop the latest turn;
 * 5. truncate the first user message.
 *
 * Every dropped turn is summarized in the notice prepended to the first
 * surviving message (bounded; newest actions win).
 */
export function compactConversationTurns<M>(
	inputMessages: readonly M[],
	targetTokens: number,
	adapter: CompactionMessageAdapter<M>,
	options: { logger?: ClineSdkBasicLogger; logLabel?: string } = {},
): CompactConversationTurnsResult<M> {
	const target = Math.max(1, targetTokens);
	const sum = (messages: readonly M[]) => messages.reduce((total, message) => total + adapter.estimate(message), 0);
	const tokensBefore = sum(inputMessages);
	if (inputMessages.length === 0 || tokensBefore <= target) {
		return { messages: [...inputMessages], changed: false, tokensBefore, tokensAfter: tokensBefore, turnsDropped: 0 };
	}

	// Head: everything up to and including the first user message (the task
	// requirements); never dropped, truncated only as a last resort.
	const firstUserIndex = inputMessages.findIndex((message) => adapter.isUser(message));
	const head = inputMessages.slice(0, firstUserIndex + 1);
	const turns = splitTurns(inputMessages.slice(firstUserIndex + 1), adapter);

	// A persisted transcript may already carry a notice from an earlier
	// compaction; lift it off so digests merge instead of nesting.
	let priorDigest: string[] = [];
	if (head.length > 0) {
		const stripped = adapter.stripNotice(head[0]);
		head[0] = stripped.message;
		priorDigest = parseNoticeDigest(stripped.notice);
	}

	const digestMaxTokens = Math.min(DIGEST_MAX_TOKENS, Math.floor(target * DIGEST_BUDGET_RATIO));
	const lastTurnIndex = turns.length - 1;
	let pinnedTurnIndex = -1;
	for (let index = lastTurnIndex - 1; index >= 0; index -= 1) {
		const first = turns[index].messages[0];
		if (adapter.isUser(first) && adapter.toolResults(first).length === 0) {
			pinnedTurnIndex = index;
			break;
		}
	}

	const dropped = new Set<number>();
	const assemble = (keptMessages: M[]): { messages: M[]; tokens: number } => {
		const digest = [
			...priorDigest,
			...turns.flatMap((turn, index) => (dropped.has(index) ? describeTurn(turn, adapter) : [])),
		];
		const messages = removeOrphanToolResults(keptMessages, adapter);
		if (messages.length > 0) {
			messages[0] = adapter.prependNotice(messages[0], buildNotice(digest, digestMaxTokens));
		}
		return { messages, tokens: sum(messages) };
	};
	const keptTurnMessages = () => turns.flatMap((turn, index) => (dropped.has(index) ? [] : turn.messages));

	// 1. Oldest turns first, at stable boundaries; the pinned instruction and
	// the latest turn are not droppable here.
	const droppable = turns
		.map((_, index) => index)
		.filter((index) => index !== lastTurnIndex && index !== pinnedTurnIndex);
	const droppableTurns = droppable.map((index) => turns[index]);
	const chunkTokens = Math.max(1, Math.floor(target * CUT_CHUNK_RATIO));
	let result = assemble([...head, ...keptTurnMessages()]);
	for (const count of candidateDropCounts(droppableTurns, droppableTurns.length, chunkTokens).slice(1)) {
		if (result.tokens <= target) {
			break;
		}
		for (const index of droppable.slice(0, count)) {
			dropped.add(index);
		}
		result = assemble([...head, ...keptTurnMessages()]);
	}

	// 2. The most recent user instruction.
	if (result.tokens > target && pinnedTurnIndex >= 0) {
		dropped.add(pinnedTurnIndex);
		result = assemble([...head, ...keptTurnMessages()]);
	}

	// 3. Truncate the kept turns from the back (tool calls and images are
	// never sliced; the adapter only shrinks text-like content).
	let body = keptTurnMessages();
	if (result.tokens > target && body.length > 0) {
		let overflow = result.tokens - target;
		for (let index = body.length - 1; index >= 0 && overflow > 0; index -= 1) {
			const current = adapter.estimate(body[index]);
			const reduced = Math.max(MIN_TRUNCATED_MESSAGE_TOKENS, current - overflow);
			const truncated = reduced < current ? adapter.truncate(body[index], reduced) : null;
			if (truncated) {
				overflow -= current - adapter.estimate(truncated);
				body[index] = truncated;
			}
		}
		result = assemble([...head, ...body]);
	}

	// 4. The latest turn itself.
	if (result.tokens > target && body.length > 0 && head.length > 0) {
		dropped.add(lastTurnIndex);
		body = [];
		result = assemble([...head]);
	}

	// 5. The first user message, as a last resort (truncated before the
	// notice is prepended, so the notice itself is never sliced).
	if (result.tokens > target && firstUserIndex >= 0) {
		const firstUser = head[firstUserIndex];
		const current = adapter.estimate(firstUser);
		const reduced = Math.max(1, current - (result.tokens - target));
		const truncated = reduced < current ? adapter.truncate(firstUser, reduced) : null;
		if (truncated) {
			head[firstUserIndex] = truncated;
			result = assemble([...head, ...body]);
		}
	}

	const tokensAfter = result.tokens;
	options.logger?.debug(options.logLabel ?? "Kanban turn compaction completed (estimates)", {
		messagesBefore: inputMessages.length,
		messagesAfter: result.messages.length,
		turnsBefore: turns.length,
		turnsDropped: dropped.size,
		messageTokensBefore: tokensBefore,
		messageTokensAfter: tokensAfter,
		target,
	});
	return { messages: result.messages, changed: true, tokensBefore, tokensAfter, turnsDropped: dropped.size };
}
