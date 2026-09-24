import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeCompletionAttempt, RuntimeCompletionPhase, RuntimeTaskCompletionResponse } from "@/runtime/types";

const COMPLETION_POLL_MS = 1500;
const GIT_PHASES: readonly RuntimeCompletionPhase[] = [
	"committing",
	"integrating",
	"integrated_verification",
	"pushing",
	"remote_verification",
];

/**
 * B-4.7: an unfinished reliable attempt that already reached the Git phases
 * must finish under reliable mode, even after reliable mode is turned off —
 * never through the legacy prompt path.
 */
export function isUnfinishedReliableGitAttempt(attempt: RuntimeCompletionAttempt | null): boolean {
	return attempt !== null && attempt.status !== "complete" && GIT_PHASES.includes(attempt.phase);
}

export async function fetchTaskCompletion(
	workspaceId: string,
	taskId: string,
): Promise<RuntimeCompletionAttempt | null> {
	try {
		return (await getRuntimeTrpcClient(workspaceId).runtime.getTaskCompletion.query({ taskId })).attempt;
	} catch {
		return null;
	}
}

/**
 * B-4.4: starts (or joins, or resumes) the task's backend completion attempt
 * and waits until it stops. The attempt runs in the runtime, so closing the
 * browser does not stop it.
 */
export async function runTaskCompletionToEnd(
	workspaceId: string,
	taskId: string,
): Promise<RuntimeTaskCompletionResponse> {
	const client = getRuntimeTrpcClient(workspaceId);
	let response = await client.runtime.startTaskCompletion.mutate({ taskId });
	while (response.ok && response.attempt?.status === "running") {
		await new Promise((resolve) => window.setTimeout(resolve, COMPLETION_POLL_MS));
		response = await client.runtime.getTaskCompletion.query({ taskId });
	}
	return response;
}
