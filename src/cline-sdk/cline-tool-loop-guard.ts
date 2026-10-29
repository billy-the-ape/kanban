import { isDeepStrictEqual } from "node:util";
import { readClineToolFailure } from "./cline-tool-failure-recovery";
import type { ClineSdkAgentHooks } from "./sdk-runtime-boundary";
import { VALIDATION_JOB_TOOL_NAME } from "./validation-job-service";

/** Replace the SDK's input-only detector locally, retaining its 3/5 thresholds. */
export function createClineToolLoopGuard(isRunningValidationJob: (jobId: string) => boolean): ClineSdkAgentHooks {
	let previous: { name: string; input: unknown } | null = null;
	let count = 0;
	let terminalError: string | null = null;
	const resetStreak = () => {
		previous = null;
		count = 0;
	};
	return {
		beforeRun: () => {
			resetStreak();
			terminalError = null;
			return undefined;
		},
		afterTool: ({ toolCall, input, result }) => {
			if (terminalError) return;
			const args = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : null;
			const observing = args && ["status", "wait", "read"].includes(String(args.action));
			if (
				toolCall.toolName === VALIDATION_JOB_TOOL_NAME &&
				observing &&
				typeof args.jobId === "string" &&
				!result.isError &&
				!readClineToolFailure(result.output) &&
				isRunningValidationJob(args.jobId.trim())
			) {
				resetStreak();
				return;
			}
			count = previous?.name === toolCall.toolName && isDeepStrictEqual(previous.input, input) ? count + 1 : 1;
			previous = { name: toolCall.toolName, input: structuredClone(input) };
			if (count !== 3 && count < 5) return;
			const message = `Detected ${count} consecutive identical calls to \`${toolCall.toolName}\`; ${
				count >= 5 ? "stopping to avoid a loop." : "consider trying a different approach."
			}`;
			if (count >= 5) terminalError = message;
			return { result: { ...result, output: { loopWarning: message, output: result.output } } };
		},
		beforeModel: () => {
			// Stop only after the last result has been persisted, keeping tool pairing intact.
			if (terminalError) throw new Error(terminalError);
			return undefined;
		},
	};
}
