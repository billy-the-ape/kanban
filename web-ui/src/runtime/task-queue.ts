import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskSessionStopResponse } from "@/runtime/types";

export async function returnQueuedTaskToBacklog(
	workspaceId: string,
	taskId: string,
): Promise<RuntimeTaskSessionStopResponse> {
	return getRuntimeTrpcClient(workspaceId).runtime.returnQueuedTaskToBacklog.mutate({ taskId });
}
