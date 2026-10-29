// Opt-in raw transport capture for the editor tool: records the exact
// `function.arguments` fragments of editor tool calls as they arrive over the
// OpenAI-compatible SSE stream, before any argument JSON parsing or
// validation. Pairs with the parsed/execution/result stages recorded by
// `cline-editor-trace.ts` so diagnostics can distinguish "the raw response
// omitted old_text" from "the client boundary dropped it".
//
// Seam note (verified against @clinebot/core 0.0.38, see the integration
// tests): the documented `ClineCoreOptions.fetch` option does not reach the
// gateway that local sessions actually use — it is stored on
// `ProviderConfig.fetch` during bootstrap but dropped when the session
// runtime builds its gateway. The AI SDK provider resolves `globalThis.fetch`
// at request time, so when `KANBAN_TRACE_EDITOR=1` this module wraps
// `globalThis.fetch` with a strict pass-through: every request is forwarded
// unmodified; only SSE chat-completion responses for tracked session hosts
// are additionally observed (bytes are forwarded unchanged through a
// TransformStream while an incremental parser extracts editor argument
// fragments). No credentials, headers, prompts, or unrelated responses are
// stored. Logging failures never affect the stream or the task.
import { appendEditorTraceRecord } from "./cline-editor-trace";

export const EDITOR_TRANSPORT_CAPTURE_SCHEMA_VERSION = 1;

/** Cap for the assembled editor argument text per tool call (chars). */
export const MAX_ASSEMBLED_ARGUMENT_CHARS = 32_000;
/** Cap for a single SSE line held in the incremental parser (chars). Sized to
 * hold one data line carrying a full-size editor argument (32k) plus envelope
 * overhead; longer lines are finalized as truncated so memory stays bounded. */
const MAX_SSE_LINE_CHARS = 64_000;
/** Cap for tool-call indexes tracked per SSE request. */
const MAX_TOOL_CALL_INDEXES_PER_REQUEST = 32;
/** Cap for the captured editor schema (serialized chars). */
const MAX_EDITOR_SCHEMA_CHARS = 8_000;

export type EditorRawStreamStatus = "completed" | "ended-early" | "interrupted";

/** One raw capture record: the editor tool-argument fragments of one tool call in one SSE request. */
export interface EditorRawCaptureRecord {
	schema: typeof EDITOR_TRANSPORT_CAPTURE_SCHEMA_VERSION;
	/** ISO timestamp of the request start (capture intercept time). */
	ts: string;
	/** ISO timestamp of stream end, when known. */
	tsEnd: string | null;
	/** Task id of the uniquely tracked session for the host at request start, when unambiguous. */
	taskId: string | null;
	/** Session id of the uniquely tracked session for the host at request start, when unambiguous. */
	sessionId: string | null;
	phase: "raw-arguments";
	/** Per-process monotonic request identifier (distinguishes concurrent/retried requests). */
	requestId: string;
	/** Host (host:port) of the provider base URL the request was sent to. */
	host: string;
	toolCallId: string;
	toolName: "editor";
	/** The exact `function.arguments` text fragments in arrival order. */
	argumentFragments: string[];
	/** The fragments joined verbatim (no re-encoding); exact unless truncated. */
	assembledArguments: string;
	/** True when the assembled text was cut off at the capture cap. */
	assembledTruncated: boolean;
	/** "completed" = stream closed after `data: [DONE]`; "ended-early" = closed without [DONE]; "interrupted" = aborted/errored before close. */
	streamStatus: EditorRawStreamStatus;
	/** True when the request's AbortSignal fired (session stop/abort/timeout). */
	aborted: boolean;
	/** Number of SSE data lines that were not valid JSON. */
	parseErrors: number;
	/** Provider-reported model id from the request body, when readable. */
	model: string | null;
	/** The model-facing editor tool schema sent for this request (properties + required), when readable. */
	editorSchema: { properties: Record<string, unknown>; required: string[] } | null;
	/** "captured" or "unavailable" (request body not readable as a JSON string). */
	schemaStatus: "captured" | "unavailable";
}

interface ToolCallIndexState {
	id: string | null;
	name: string | null;
	fragments: string[];
	assembledLength: number;
	truncated: boolean;
}

/**
 * Incremental SSE `data:` line parser that accumulates editor
 * `function.arguments` fragments per tool-call index. Handles fragments split
 * across arbitrary chunk boundaries, tool-call id/name arriving in any chunk,
 * and interleaved indexes without mixing calls. Pure and allocation-bounded;
 * never throws.
 */
export class EditorArgumentFragmentExtractor {
	private lineBuffer = "";
	private readonly indexes = new Map<number, ToolCallIndexState>();
	parseErrors = 0;
	/** True when an SSE line exceeded the line cap; all captures are then marked truncated. */
	lineTruncated = false;
	/** True when the terminal `data: [DONE]` event was seen (authoritative stream completion). */
	doneSeen = false;
	/** True when the total captured fragment budget for the request was exhausted. */
	fragmentBudgetExhausted = false;
	/** While true, bytes are the remainder of an oversized line and are dropped until the next newline. */
	private droppingOversizedLine = false;

	/** Feed one decoded chunk of the SSE body. Never throws. */
	feed(chunk: string): void {
		if (this.droppingOversizedLine) {
			const newlineIndex = chunk.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}
			this.droppingOversizedLine = false;
			chunk = chunk.slice(newlineIndex + 1);
			if (chunk.length === 0) {
				return;
			}
		}
		this.lineBuffer += chunk;
		// Bound memory: a single line longer than the cap is finalized as
		// truncated immediately, and the rest of that line is dropped.
		if (this.lineBuffer.length > MAX_SSE_LINE_CHARS && !this.lineBuffer.includes("\n")) {
			this.lineTruncated = true;
			this.handleLine(this.lineBuffer.slice(0, MAX_SSE_LINE_CHARS));
			this.droppingOversizedLine = true;
			this.lineBuffer = "";
			return;
		}
		let newlineIndex = this.lineBuffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.lineBuffer.slice(0, newlineIndex);
			this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
			this.handleLine(line);
			newlineIndex = this.lineBuffer.indexOf("\n");
		}
	}

	private handleLine(rawLine: string): void {
		// SSE framing may be CRLF: strip one trailing CR so "data: [DONE]\r"
		// and JSON payloads still parse identically to LF framing.
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0) {
			return;
		}
		if (line.length > MAX_SSE_LINE_CHARS) {
			// A complete line above the cap cannot be parsed whole; mark the
			// capture truncated and drop it (bytes still pass through).
			this.lineTruncated = true;
			return;
		}
		if (!line.startsWith("data:")) {
			return;
		}
		const payload = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
		if (payload === "[DONE]") {
			this.doneSeen = true;
			return;
		}
		let envelope: unknown;
		try {
			envelope = JSON.parse(payload);
		} catch {
			this.parseErrors += 1;
			return;
		}
		const choices =
			typeof envelope === "object" && envelope !== null && Array.isArray((envelope as { choices?: unknown }).choices)
				? (envelope as { choices: unknown[] }).choices
				: [];
		for (const choice of choices) {
			const toolCalls =
				typeof choice === "object" && choice !== null
					? (choice as { delta?: { tool_calls?: unknown } }).delta?.tool_calls
					: undefined;
			if (!Array.isArray(toolCalls)) {
				continue;
			}
			for (const toolCall of toolCalls) {
				if (typeof toolCall !== "object" || toolCall === null) {
					continue;
				}
				const record = toolCall as {
					index?: unknown;
					id?: unknown;
					function?: { name?: unknown; arguments?: unknown };
				};
				if (typeof record.index !== "number" || !Number.isInteger(record.index) || record.index < 0) {
					continue;
				}
				if (!this.indexes.has(record.index) && this.indexes.size >= MAX_TOOL_CALL_INDEXES_PER_REQUEST) {
					this.fragmentBudgetExhausted = true;
					return;
				}
				let state = this.indexes.get(record.index);
				if (!state) {
					state = { id: null, name: null, fragments: [], assembledLength: 0, truncated: false };
					this.indexes.set(record.index, state);
				}
				if (typeof record.id === "string" && record.id.length > 0) {
					state.id = record.id;
				}
				if (typeof record.function?.name === "string" && record.function.name.length > 0) {
					state.name = record.function.name;
				}
				const fragment = record.function?.arguments;
				if (typeof fragment === "string" && fragment.length > 0 && !state.truncated) {
					if (this.fragmentBudgetExhausted) {
						state.truncated = true;
						return;
					}
					const remaining = MAX_ASSEMBLED_ARGUMENT_CHARS - state.assembledLength;
					if (remaining <= 0) {
						state.truncated = true;
						return;
					}
					if (fragment.length > remaining) {
						state.fragments.push(fragment.slice(0, remaining));
						state.assembledLength = MAX_ASSEMBLED_ARGUMENT_CHARS;
						state.truncated = true;
					} else {
						state.fragments.push(fragment);
						state.assembledLength += fragment.length;
					}
				}
			}
		}
	}

	/** Editor tool-call captures keyed by index, in index order. */
	finish(): Array<{ index: number; id: string | null; name: string | null; fragments: string[]; truncated: boolean }> {
		// A final "data:" line without a trailing newline is still a complete
		// SSE event for our purposes; process any residual buffer.
		if (this.lineBuffer.length > 0) {
			const residual = this.lineBuffer;
			this.lineBuffer = "";
			this.handleLine(residual);
		}
		const result: Array<{
			index: number;
			id: string | null;
			name: string | null;
			fragments: string[];
			truncated: boolean;
		}> = [];
		const sortedIndexes = [...this.indexes.keys()].sort((a, b) => a - b);
		for (const index of sortedIndexes) {
			const state = this.indexes.get(index);
			if (!state || state.name !== "editor" || state.fragments.length === 0) {
				continue;
			}
			result.push({
				index,
				id: state.id,
				name: "editor",
				fragments: state.fragments,
				truncated: state.truncated || this.lineTruncated || this.fragmentBudgetExhausted,
			});
		}
		return result;
	}
}

interface RequestCaptureState {
	requestId: string;
	host: string;
	requestStartedAt: string;
	model: string | null;
	schema: { properties: Record<string, unknown>; required: string[] } | null;
	schemaStatus: "captured" | "unavailable";
	attribution: { taskId: string; sessionId: string } | null;
	extractor: EditorArgumentFragmentExtractor;
	aborted: boolean;
	streamClosed: boolean;
	emitted: boolean;
}

export interface EditorTransportSessionInfo {
	taskId: string;
	sessionId: string;
	/** Provider host (host:port) the session's model requests are sent to. */
	host: string;
	providerId: string;
	modelId: string;
}

export interface EditorTransportCapture {
	trackSession(session: EditorTransportSessionInfo): void;
	untrackSession(sessionId: string): void;
	trackedSessionCount(): number;
	/** Number of raw capture request records emitted so far (diagnostics/tests). */
	emittedRecordCount(): number;
}

type FetchLike = typeof fetch;

let activeCapture: EditorTransportCapture | null = null;
let wrapperInstalled = false;
let originalFetch: FetchLike | null = null;
let requestCounter = 0;
let emittedRecordCount = 0;

function isSseResponse(response: Response): boolean {
	const contentType = response.headers.get("content-type") ?? "";
	return response.body !== null && contentType.toLowerCase().includes("text/event-stream");
}

interface RequestMeta {
	model: string | null;
	schema: { properties: Record<string, unknown>; required: string[] } | null;
}

function extractRequestMeta(body: string | undefined): RequestMeta {
	if (typeof body !== "string" || body.length === 0) {
		return { model: null, schema: null };
	}
	try {
		const parsed = JSON.parse(body) as { model?: unknown; tools?: unknown };
		let schema: { properties: Record<string, unknown>; required: string[] } | null = null;
		if (Array.isArray(parsed.tools)) {
			for (const tool of parsed.tools) {
				if (typeof tool !== "object" || tool === null) {
					continue;
				}
				const entry = tool as {
					name?: unknown;
					function?: { name?: unknown; parameters?: unknown };
					parameters?: unknown;
				};
				const name = typeof entry.function?.name === "string" ? entry.function.name : entry.name;
				if (name !== "editor") {
					continue;
				}
				const parameters = (
					typeof entry.function?.parameters === "object" && entry.function.parameters !== null
						? entry.function.parameters
						: typeof entry.parameters === "object"
							? entry.parameters
							: null
				) as { properties?: unknown; required?: unknown } | null;
				if (parameters && typeof parameters === "object") {
					const properties =
						typeof parameters.properties === "object" && parameters.properties !== null
							? (parameters.properties as Record<string, unknown>)
							: {};
					const required = Array.isArray(parameters.required)
						? parameters.required.filter((value): value is string => typeof value === "string")
						: [];
					if (JSON.stringify({ properties, required }).length <= MAX_EDITOR_SCHEMA_CHARS) {
						schema = { properties, required };
					} else {
						schema = { properties: {}, required: [] };
					}
				}
				break;
			}
		}
		return {
			model: typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model : null,
			schema,
		};
	} catch {
		return { model: null, schema: null };
	}
}

function resolveRequestUrl(input: Parameters<FetchLike>[0]): string | null {
	try {
		if (typeof input === "string") {
			return input;
		}
		if (input instanceof URL) {
			return input.href;
		}
		return input.url;
	} catch {
		return null;
	}
}

function hostMatchesTracked(url: string, trackedHosts: ReadonlySet<string>): string | null {
	try {
		const parsed = new URL(url);
		return trackedHosts.has(parsed.host) ? parsed.host : null;
	} catch {
		return null;
	}
}

/** Default base URL of the SDK's managed "cline" provider (host match only). */
const DEFAULT_CLINE_PROVIDER_BASE_URL = "https://api.cline.bot";
const SDK_DEFAULT_PROVIDER_ID_VALUE = "cline";

/**
 * Resolves the provider host (host:port) that a session's model requests are
 * sent to, from the session start request. Returns null when the host cannot
 * be determined (custom provider without an explicit base URL) — the session
 * then simply has no raw transport capture.
 */
export function resolveEditorTransportHost(baseUrl: string | null | undefined, providerId: string): string | null {
	const normalized = (baseUrl ?? "").trim();
	if (normalized.length > 0) {
		try {
			return new URL(normalized).host;
		} catch {
			return null;
		}
	}
	if (providerId === SDK_DEFAULT_PROVIDER_ID_VALUE) {
		try {
			return new URL(DEFAULT_CLINE_PROVIDER_BASE_URL).host;
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Initializes the process-wide capture singleton. Returns null when
 * `KANBAN_TRACE_EDITOR` is not "1" (tracing stays off). Once installed, the
 * wrapper remains for the process lifetime (disabling requires a restart);
 * it is a strict pass-through while no sessions are tracked.
 */
export function initEditorTransportCapture(): EditorTransportCapture | null {
	if (activeCapture !== null) {
		return activeCapture;
	}
	if (process.env.KANBAN_TRACE_EDITOR !== "1") {
		return null;
	}
	if (wrapperInstalled) {
		return activeCapture;
	}
	const tracked = new Map<string, EditorTransportSessionInfo>();
	const sessionsByHost = new Map<string, EditorTransportSessionInfo[]>();
	const trackedHosts = new Set<string>();

	const capture: EditorTransportCapture = {
		trackSession(session) {
			if (tracked.has(session.sessionId)) {
				return;
			}
			tracked.set(session.sessionId, session);
			const list = sessionsByHost.get(session.host) ?? [];
			list.push(session);
			sessionsByHost.set(session.host, list);
			trackedHosts.add(session.host);
		},
		untrackSession(sessionId) {
			const session = tracked.get(sessionId);
			if (!session) {
				return;
			}
			tracked.delete(sessionId);
			const list = sessionsByHost.get(session.host);
			if (list) {
				const next = list.filter((entry) => entry.sessionId !== sessionId);
				if (next.length === 0) {
					sessionsByHost.delete(session.host);
					trackedHosts.delete(session.host);
				} else {
					sessionsByHost.set(session.host, next);
				}
			}
		},
		trackedSessionCount() {
			return tracked.size;
		},
		emittedRecordCount() {
			return emittedRecordCount;
		},
	};

	const wrapper: FetchLike = (input, init) => {
		const url = resolveRequestUrl(input);
		const host = url !== null ? hostMatchesTracked(url, trackedHosts) : null;
		const baseFetch = originalFetch ?? globalThis.fetch;
		if (host === null) {
			return baseFetch(input, init);
		}
		const sessions = sessionsByHost.get(host) ?? [];
		return baseFetch(input, init).then(
			(response) => {
				if (!isSseResponse(response)) {
					return response;
				}
				try {
					return observeSseResponse(response, init, host, sessions);
				} catch {
					// Observation must never change the response.
					return response;
				}
			},
			(error) => {
				throw error;
			},
		);
	};

	originalFetch = globalThis.fetch;
	globalThis.fetch = wrapper;
	wrapperInstalled = true;
	activeCapture = capture;
	return capture;
}

/**
 * TransformStream init shape with an optional `cancel` hook. The repo's Node
 * type declarations do not expose the `Transformer` init type globally, and
 * the typed `cancel` member is version-sensitive; Node >= 22 honors `cancel`
 * at runtime regardless.
 */
interface CancellableTransformer {
	transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void;
	flush?(controller: TransformStreamDefaultController<Uint8Array>): void;
	cancel?(reason?: unknown): void;
}

function observeSseResponse(
	response: Response,
	init: RequestInit | undefined,
	host: string,
	sessions: readonly EditorTransportSessionInfo[],
): Response {
	const requestId = `evt-${++requestCounter}`;
	const requestStartedAt = new Date().toISOString();
	const meta = extractRequestMeta(typeof init?.body === "string" ? init.body : undefined);
	const [onlySession] = sessions;
	const attribution =
		sessions.length === 1 && onlySession ? { taskId: onlySession.taskId, sessionId: onlySession.sessionId } : null;
	const state: RequestCaptureState = {
		requestId,
		host,
		requestStartedAt,
		model: meta.model,
		schema: meta.schema,
		schemaStatus: meta.schema === null ? "unavailable" : "captured",
		attribution,
		extractor: new EditorArgumentFragmentExtractor(),
		aborted: false,
		streamClosed: false,
		emitted: false,
	};

	let onAbort: (() => void) | null = null;
	const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
	const decoder = new TextDecoder();
	const emit = () => {
		if (state.emitted) {
			return;
		}
		state.emitted = true;
		if (signal && onAbort) {
			signal.removeEventListener("abort", onAbort);
		}
		try {
			state.extractor.feed(decoder.decode());
		} catch {
			// Never fail the stream over capture bookkeeping.
		}
		const calls = state.extractor.finish();
		const wasAborted = state.aborted || (signal ? signal.aborted : false);
		for (const call of calls) {
			if (call.id === null) {
				// Without a tool-call id the record cannot be correlated; keep it
				// only via the unambiguous session attribution when present.
				if (state.attribution === null) {
					continue;
				}
			}
			appendEditorTraceRecord({
				schema: EDITOR_TRANSPORT_CAPTURE_SCHEMA_VERSION,
				ts: state.requestStartedAt,
				tsEnd: new Date().toISOString(),
				taskId: state.attribution?.taskId ?? null,
				sessionId: state.attribution?.sessionId ?? null,
				phase: "raw-arguments",
				requestId: state.requestId,
				host: state.host,
				toolCallId: call.id ?? "",
				toolName: "editor",
				argumentFragments: call.fragments,
				assembledArguments: call.fragments.join(""),
				assembledTruncated: call.truncated,
				streamStatus: state.streamClosed ? (state.extractor.doneSeen ? "completed" : "ended-early") : "interrupted",
				aborted: wasAborted,
				parseErrors: state.extractor.parseErrors,
				model: state.model,
				editorSchema: state.schema,
				schemaStatus: state.schemaStatus,
			});
			emittedRecordCount += 1;
		}
	};

	if (signal) {
		onAbort = () => {
			state.aborted = true;
			// Emit even if the runtime never invokes the transform's cancel
			// callback, so aborted streams are still recorded.
			emit();
		};
		if (signal.aborted) {
			state.aborted = true;
			emit();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	// Cancellation (session stop/abort, client disconnect) fires the transform's
	// cancel callback; the stream close fires flush. Either way exactly one
	// record emission happens, and the bytes reaching the consumer are always
	// the original unmodified chunks.
	const transform: CancellableTransformer = {
		transform(chunk, controller) {
			try {
				const text = decoder.decode(chunk, { stream: true });
				state.extractor.feed(text);
			} catch {
				// Capture failures never affect the stream.
			}
			controller.enqueue(chunk);
		},
		flush() {
			state.streamClosed = true;
			emit();
		},
		cancel() {
			emit();
		},
	};
	const body = response.body;
	if (!body) {
		return response;
	}
	const transformed = body.pipeThrough(new TransformStream(transform));

	return new Response(transformed, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
