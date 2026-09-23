import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskDependentsUnlock } from "@/runtime/types";

/**
 * B-5.9/B-8.8: asks the runtime whether completing a task may start its linked
 * backlog tasks. The runtime owns the rule (a completed delivery receipt when
 * deterministic delivery is enabled); an unreadable answer keeps them locked.
 */
export async function fetchTaskDependentsUnlock(
	workspaceId: string,
	taskId: string,
): Promise<RuntimeTaskDependentsUnlock> {
	try {
		const info = await getRuntimeTrpcClient(workspaceId).runtime.getTaskDeliveryInfo.query({ taskId });
		return info.dependentsUnlock;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { allowed: false, reason: `Could not read the delivery receipt: ${message}` };
	}
}
