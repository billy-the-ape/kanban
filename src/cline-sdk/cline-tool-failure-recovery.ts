import type { ClineSdkAgentAfterToolContext, ClineSdkAgentHooks } from "./sdk-runtime-boundary";

type Tool = ClineSdkAgentAfterToolContext["tool"];
const REPLAY_SAFE_TOOLS = new Set(["read_files", "search_codebase", "fetch_web_content"]);
/** A call that has timed out this many times (the original plus one retry) ends the run. */
const MAX_TIMEOUTS_PER_CALL = 2;
// "time out" is deliberately not matched: the SDK's own validation errors mention it in prose
// (e.g. "...less likely to be truncated or time out"), and those are fixable by the model.
const TIMEOUT_PATTERN = /\btimed out\b|\btimeout\b|\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|\bdeadline exceeded\b/i;

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
 * or counted here.
 */
export function isClineToolTimeout(error: string | null): error is string {
	return error !== null && TIMEOUT_PATTERN.test(error);
}

function summarize(value: unknown): string {
	const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
	return (text ?? "Unknown tool error").slice(0, 4000);
}

function errorText(error: unknown): string {
	return summarize(error);
}

/**
 * Local SDK hooks that bound *timeout* recovery only. A timed-out replay-safe tool is retried once inside tool
 * execution; any other timed-out tool goes back to the model with instructions to verify side effects before
 * retrying. A call (same tool and input) that times out again after that retry ends the run. All other tool
 * errors pass through untouched so the model can repair them itself. Reset only on a new user turn.
 */
export function createClineToolFailureRecoveryHooks(): ClineSdkAgentHooks {
	const wrapped = new WeakSet<Tool>();
	const attempts = new Map<string, number>();
	const timeouts = new Map<string, { count: number; iteration: number }>();
	let terminalError: string | null = null;

	function callKey(toolName: string, input: unknown): string {
		return `${toolName}\n${summarize(input)}`;
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
		afterTool: ({ snapshot, toolCall, input, result }) => {
			const error = readClineToolFailure(result.output) ?? (result.isError ? summarize(result.output) : null);
			const count = attempts.get(toolCall.toolCallId) ?? 1;
			attempts.delete(toolCall.toolCallId);
			if (!isClineToolTimeout(error)) {
				// A call that went through (or failed for a model-fixable reason) is no longer on its timeout strike.
				if (!error) timeouts.delete(callKey(toolCall.toolName, input));
				return;
			}
			return {
				result: {
					...result,
					isError: true,
					output: {
						recovery: timeoutFailure(toolCall.toolName, input, error, count, snapshot.iteration),
						output: result.output,
					},
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
