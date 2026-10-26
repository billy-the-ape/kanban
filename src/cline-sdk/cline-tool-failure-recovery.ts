import { collectEditorEvidence, type EditorEvidence } from "./cline-editor-evidence";
import type { ClineSdkAgentAfterToolContext, ClineSdkAgentHooks } from "./sdk-runtime-boundary";

type Tool = ClineSdkAgentAfterToolContext["tool"];
const REPLAY_SAFE_TOOLS = new Set(["read_files", "search_codebase", "fetch_web_content"]);
/** A call that has timed out this many times (the original plus one retry) ends the run. */
const MAX_TIMEOUTS_PER_CALL = 2;
/** The same call failing with the same error this many times in a row, with no successful tool call between, ends the run. */
const MAX_IDENTICAL_FAILURES = 3;
/** AR-2: the repeated-failure sentence. The call and error are identical, so the relevant fields are unchanged. */
const REPEATED_EDITOR_FAILURE_SENTENCE =
	"This repeats the earlier failed arguments. The relevant fields have not changed. Correct the identified mismatch or read a targeted current section before another attempt. ";
/**
 * Timeouts are recognised by the exact shapes the SDK and Kanban's MCP layer emit, one error line at a time.
 * A free-text search is wrong here: stderr, file paths, regexes, and echoed model input routinely contain
 * "timeout" / "timed out" (`Test timed out in 5000ms`, `src/utils/timeout.ts`, `--timeout=5`) and are the
 * model's to fix, not transient failures. Optional leading `Prefix: ` covers the SDK's `Command failed: ...`
 * style wrappers and Kanban's `MCP server "x" failed: ...`.
 */
const TIMEOUT_LINE_PATTERNS = [
	/^(?:[A-Za-z_ ]{1,40}: )?(?:Command|File read|Search|Web fetch|Editor operation|apply_patch|Skills operation|submit_and_exit|Request) timed out after \d+ ?ms\b/,
	/^(?:MCP server "[^"\n]*" failed: )?MCP error -32001: Request timed out\b/,
	/^(?:MCP server "[^"\n]*" failed: )?MCP request timed out for "[^"\n]*"/,
	/^(?:Error fetching web content: )?HTTP (?:408|504|524)\b/,
];

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** No-match searches and nonzero test exit codes are ordinary results, not transport failures. */
export function readClineToolFailure(output: unknown): string | null {
	if (Array.isArray(output)) {
		const errors = output.map(readClineToolFailure).filter((error): error is string => error !== null);
		return errors.length ? errors.join("\n") : null;
	}
	const item = record(output);
	if (!item) return null;
	if (typeof item.error === "string" && item.error.trim()) return item.error.trim();
	// MCP's error envelope is nested inside the SDK's ordinary output.
	if (item.isError === true) return summarize(item.content ?? output);
	return null;
}

/**
 * Only timeouts are transient. Every other failure (bad input, oversized edit, missing file, unknown tool)
 * is the model's to fix: it sees the error in the ordinary tool result and adapts, so it is never retried
 * and only the repeated-failure guard counts it.
 */
export function isClineToolTimeout(error: string | null): error is string {
	return (
		error?.split("\n").some((line) => TIMEOUT_LINE_PATTERNS.some((pattern) => pattern.test(line.trim()))) ?? false
	);
}

function summarize(value: unknown): string {
	const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
	return (text ?? "Unknown tool error").slice(0, 4000);
}

function errorText(error: unknown): string {
	return summarize(error);
}

/** Strike key. Unlike `summarize`, never truncated, so distinct long inputs do not share a strike. */
function callKey(toolName: string, input: unknown): string {
	return `${toolName}\n${JSON.stringify(input) ?? ""}`;
}

type EditorFailureKind =
	| "missing_old_text"
	| "no_match"
	| "ambiguous_match"
	| "invalid_insert_line"
	| "input_too_large";

function classifyEditorFailure(error: string): EditorFailureKind | null {
	if (error.startsWith("Editor operation failed: No replacement performed: multiple occurrences"))
		return "ambiguous_match";
	if (error.startsWith("Editor operation failed: No replacement performed: text not found")) return "no_match";
	if (error.startsWith("Editor operation failed: Parameter `old_text` is required")) return "missing_old_text";
	if (error.startsWith("Editor operation failed: Invalid insert_line:")) return "invalid_insert_line";
	if (error.startsWith("Editor input too large:")) return "input_too_large";
	return null;
}

/**
 * AR-2: builds the model-facing editor recovery sentence from the measured
 * condition. Only the sentence appropriate to what was actually observed is
 * emitted; facts (match counts, whitespace, skip reasons) are substituted from
 * the evidence. `editorRecovery` (kept for the uninstrumented fallback) covers
 * the same shapes without evidence.
 */
function buildEditorRecovery(kind: EditorFailureKind, evidence: EditorEvidence | null): string {
	const oldTextField = evidence?.fields.old_text;
	switch (kind) {
		case "missing_old_text": {
			const head =
				oldTextField?.present && oldTextField.length === 0
					? "The parsed editor call has an empty old_text."
					: "The parsed editor call is missing old_text.";
			return `${head} For a replacement, include path, an exact unique old_text anchor, and new_text in the actual arguments. Use insert_line only for an intended insertion.`;
		}
		case "no_match": {
			const matchCount = evidence?.oldText?.matchCount;
			const count = typeof matchCount === "number" ? matchCount : 0;
			if (evidence?.file?.state === "skipped") {
				return `The submitted anchor did not match the current file. Current-source evidence was skipped: ${evidence.file.reason ?? "unknown reason"}. Read a targeted section of the current file with read_files, then copy a short exact anchor from that fresh read. Do not repeat unchanged arguments or guess whitespace.`;
			}
			if (evidence?.candidates && evidence.candidates.windows.length > 0) {
				return `The submitted anchor matched ${count} time${count === 1 ? "" : "s"} in the current file. The nearby source below is diagnostic evidence, not an automatically corrected anchor. Copy a short exact anchor from current source and include enough context to make it unique. Let the repository formatter handle indentation introduced by your edit.`;
			}
			return `The submitted anchor matched ${count} time${count === 1 ? "" : "s"} in the current file. No nearby candidate could be located. Read a targeted section of the current file with read_files, then copy a short exact anchor from that fresh read. Do not repeat unchanged arguments or guess whitespace.`;
		}
		case "ambiguous_match": {
			const matchCount = evidence?.oldText?.matchCount;
			const head =
				typeof matchCount === "number" && matchCount > 1
					? `The replacement anchor matched ${matchCount} times in the current file.`
					: "The replacement anchor matched more than once.";
			return `${head} Include enough surrounding text in old_text to identify exactly one occurrence. Do not repeat the ambiguous anchor.`;
		}
		case "invalid_insert_line":
			return "Read the current file to determine its line count and insertion boundary. insert_line is one-based; use line_count + 1 to append. Do not repeat the invalid line number.";
		case "input_too_large":
			return "Split the edit into smaller sequential calls; keep old_text and new_text below 30000 characters each. Read the current file before anchoring the next edit. Do not retry the same oversized payload.";
	}
}

/**
 * Local SDK hooks that bound *timeout* recovery only. A timed-out replay-safe tool is retried once inside tool
 * execution; any other timed-out tool goes back to the model with instructions to verify side effects before
 * retrying. A call (same tool and input) that times out again after that retry ends the run. All other tool
 * editor input errors receive targeted instructions in their model-facing result; other errors pass through.
 * Only the same call failing with the same
 * error repeatedly, with no successful tool call in between, ends the run. Reset only on a new user turn.
 */
export function createClineToolFailureRecoveryHooks(cwd?: string): ClineSdkAgentHooks {
	const wrapped = new WeakSet<Tool>();
	const attempts = new Map<string, number>();
	const timeouts = new Map<string, { count: number; iteration: number }>();
	// Keyed by call + error text. Cleared entirely by any successful tool call.
	const identicalFailures = new Map<string, { count: number; iteration: number }>();
	let terminalError: string | null = null;

	function repeatedFailure(toolName: string, input: unknown, error: string, iteration: number): string | null {
		const key = `${callKey(toolName, input)}\n${error}`;
		const previous = identicalFailures.get(key);
		// Identical calls in one batch share a single strike.
		const count = previous && previous.iteration === iteration ? previous.count : (previous?.count ?? 0) + 1;
		identicalFailures.set(key, { count, iteration });
		if (count < MAX_IDENTICAL_FAILURES) return null;
		terminalError = [
			`Tool call failed ${MAX_IDENTICAL_FAILURES} times in a row with the same error and no successful tool call in between.`,
			`Tool: ${toolName}\nInput: ${summarize(input)}\nError: ${summarize(error)}`,
		].join("\n");
		return terminalError;
	}

	function timeoutFailure(
		toolName: string,
		input: unknown,
		error: string,
		attemptCount: number,
		iteration: number,
	): string {
		const key = callKey(toolName, input);
		const previous = timeouts.get(key);
		// Identical calls in one batch share a single strike.
		const count = previous && previous.iteration === iteration ? previous.count : (previous?.count ?? 0) + 1;
		timeouts.set(key, { count, iteration });
		const details = `Tool: ${toolName}\nInput: ${summarize(input)}\nError: ${summarize(error)}`;
		if (count >= MAX_TIMEOUTS_PER_CALL) {
			terminalError = `Tool timed out again after one retry.\n${details}`;
			return terminalError;
		}
		return [
			attemptCount === 2
				? "The last tool call timed out twice."
				: "The last tool call timed out. Automatic replay was skipped because its outcome may include side effects.",
			details,
			"You may retry this call once, ideally narrowed or split into smaller steps, or use a different tool. If it times out again the task will stop.",
			"Before repeating a command or write, check whether it already succeeded (especially PR creation, commits, and pushes). A timeout does not prove it failed remotely.",
		].join("\n");
	}

	return {
		beforeRun: () => {
			attempts.clear();
			timeouts.clear();
			terminalError = null;
			return undefined;
		},
		beforeTool: ({ tool }) => {
			if (wrapped.has(tool)) return;
			wrapped.add(tool);
			const execute = tool.execute.bind(tool);
			tool.execute = async (input, context) => {
				context.signal?.throwIfAborted();
				if (terminalError) throw new Error(terminalError);
				// A call the model is retrying after a timeout already had its automatic retry; same-batch twins have not.
				const priorTimeout = timeouts.get(callKey(tool.name, input));
				const replaySafe =
					REPLAY_SAFE_TOOLS.has(tool.name) && !(priorTimeout && priorTimeout.iteration < context.iteration);
				const maxAttempts = replaySafe ? 2 : 1;
				for (let attempt = 1; ; attempt++) {
					context.signal?.throwIfAborted();
					if (context.toolCallId) attempts.set(context.toolCallId, attempt);
					try {
						const output = await execute(input, context);
						context.signal?.throwIfAborted();
						if (attempt >= maxAttempts || !isClineToolTimeout(readClineToolFailure(output))) return output;
					} catch (error) {
						context.signal?.throwIfAborted();
						if (attempt >= maxAttempts || !isClineToolTimeout(errorText(error))) throw error;
					}
					context.emitUpdate?.({
						status: "retrying",
						attempt: 2,
						message: "Tool timed out; retrying once without a model call.",
					});
				}
			};
			return undefined;
		},
		afterTool: async ({ snapshot, toolCall, input, result }) => {
			const error = readClineToolFailure(result.output) ?? (result.isError ? summarize(result.output) : null);
			const count = attempts.get(toolCall.toolCallId) ?? 1;
			attempts.delete(toolCall.toolCallId);
			// A call blocked by the terminal error was never executed; leave its result alone.
			if (terminalError) return;
			if (!error) {
				// Progress: this call is off its timeout strike and every failure streak starts over.
				timeouts.delete(callKey(toolCall.toolName, input));
				identicalFailures.clear();
				return;
			}
			const boundedRecovery = isClineToolTimeout(error)
				? timeoutFailure(toolCall.toolName, input, error, count, snapshot.iteration)
				: repeatedFailure(toolCall.toolName, input, error, snapshot.iteration);
			const key = `${callKey(toolCall.toolName, input)}\n${error}`;
			const repeated = (identicalFailures.get(key)?.count ?? 0) > 1;
			// AR-2: a genuine failed editor call (executed and rejected) gets a
			// bounded current-source evidence read attached to its recovery
			// envelope. Approval denials and policy skips fail before execution
			// and never reach this path, so no hidden enrichment read follows a
			// denial. Timeouts keep their existing bounded recovery without evidence.
			let recovery: string | null = boundedRecovery;
			let evidence: EditorEvidence | null = null;
			if (recovery === null && toolCall.toolName === "editor") {
				const kind = classifyEditorFailure(error);
				if (kind) {
					evidence = cwd ? await collectEditorEvidence({ cwd, input, repeated }) : null;
					recovery = `${repeated ? REPEATED_EDITOR_FAILURE_SENTENCE : ""}${buildEditorRecovery(kind, evidence)}`;
				}
			}
			if (!recovery) return;
			return {
				result: {
					...result,
					isError: true,
					output: { recovery, ...(evidence ? { evidence } : {}), output: result.output },
				},
			};
		},
		beforeModel: () => {
			// Throw here, after the SDK has persisted the failed tool result, rather than stopping
			// in afterTool (which reports an interruption and loses the tool-result pairing).
			if (terminalError) throw new Error(terminalError);
			return undefined;
		},
	};
}
