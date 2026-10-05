import type { ClineSdkAgentAfterToolContext, ClineSdkAgentHooks } from "./sdk-runtime-boundary";

type Tool = ClineSdkAgentAfterToolContext["tool"];
const REPLAY_SAFE_TOOLS = new Set(["read_files", "search_codebase", "fetch_web_content"]);

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

function summarize(value: unknown): string {
	const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
	return (text ?? "Unknown tool error").slice(0, 4000);
}

/** Local SDK hooks: one safe replay, one model repair, then a failed run. Reset only on a new user turn. */
export function createClineToolFailureRecoveryHooks(): ClineSdkAgentHooks {
	const wrapped = new WeakSet<Tool>();
	const attempts = new Map<string, number>();
	const seen = new Set<string>();
	let repairIteration: number | null = null;
	let terminalError: string | null = null;

	function failure(toolName: string, input: unknown, error: string, count: number, iteration: number): string {
		const details = `Tool: ${toolName}\nInput: ${summarize(input)}\nError: ${summarize(error)}`;
		if (repairIteration !== null && iteration > repairIteration) {
			terminalError = `Tool recovery exhausted after the model repair attempt.\n${details}`;
			return terminalError;
		}
		repairIteration ??= iteration;
		return [
			count === 2
				? "The last tool call failed twice."
				: "The last tool call failed. Automatic replay was skipped because its outcome may include side effects.",
			details,
			"Try reformatting the call or using a different tool. You have one repair opportunity; another tool failure will stop this task.",
			"Before repeating a command or write, check whether it already succeeded (especially PR creation, commits, and pushes). A timeout does not prove it failed remotely.",
		].join("\n");
	}

	return {
		beforeRun: () => {
			attempts.clear();
			seen.clear();
			repairIteration = null;
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
				const maxAttempts =
					(repairIteration === null || context.iteration <= repairIteration) && REPLAY_SAFE_TOOLS.has(tool.name)
						? 2
						: 1;
				for (let attempt = 1; ; attempt++) {
					context.signal?.throwIfAborted();
					if (context.toolCallId) attempts.set(context.toolCallId, attempt);
					try {
						const output = await execute(input, context);
						context.signal?.throwIfAborted();
						if (!readClineToolFailure(output) || attempt >= maxAttempts) return output;
					} catch (error) {
						context.signal?.throwIfAborted();
						if (attempt >= maxAttempts) throw error;
					}
					context.emitUpdate?.({
						status: "retrying",
						attempt: 2,
						message: "Tool failed; retrying once without a model call.",
					});
				}
			};
			return undefined;
		},
		afterTool: ({ snapshot, toolCall, input, result }) => {
			const error = readClineToolFailure(result.output) ?? (result.isError ? summarize(result.output) : null);
			const count = attempts.get(toolCall.toolCallId) ?? 1;
			attempts.delete(toolCall.toolCallId);
			seen.add(toolCall.toolCallId);
			if (!error) return;
			return {
				result: {
					...result,
					isError: true,
					output: {
						recovery: failure(toolCall.toolName, input, error, count, snapshot.iteration),
						output: result.output,
					},
				},
			};
		},
		beforeModel: ({ snapshot, request }) => {
			// Unknown tools / malformed call JSON bypass beforeTool and afterTool in the SDK.
			// Inspect only the latest batch, so historical failures do not consume a new turn's budget.
			const latest: (typeof request.messages)[number][] = [];
			for (let index = request.messages.length - 1; index >= 0; index--) {
				const message = request.messages[index];
				if (message.role !== "tool") break;
				latest.unshift(message);
			}
			const latestAssistant = request.messages.at(request.messages.length - latest.length - 1);
			const calls = new Map(
				latestAssistant?.role === "assistant"
					? latestAssistant.content.flatMap((part) =>
							part.type === "tool-call" ? [[part.toolCallId, part.input] as const] : [],
						)
					: [],
			);
			const messages = request.messages.map((message) => {
				if (!latest.includes(message)) return message;
				return {
					...message,
					content: message.content.map((part) => {
						if (part.type !== "tool-result" || seen.has(part.toolCallId)) return part;
						seen.add(part.toolCallId);
						const error = readClineToolFailure(part.output) ?? (part.isError ? summarize(part.output) : null);
						if (!error) return part;
						return {
							...part,
							isError: true,
							output: failure(
								part.toolName,
								calls.get(part.toolCallId) ?? "Unavailable (invalid or unknown tool call)",
								error,
								1,
								snapshot.iteration,
							),
						};
					}),
				};
			});
			seen.clear();
			// Throw here, after the SDK has persisted the failed tool result, rather than stopping
			// in afterTool (which reports an interruption and loses the tool-result pairing).
			if (terminalError) throw new Error(terminalError);
			return { messages };
		},
	};
}
