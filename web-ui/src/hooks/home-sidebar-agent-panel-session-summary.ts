import { pickNewerSessionSummary } from "@runtime-task-display-state";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export function selectNewestTaskSessionSummary(
	left: RuntimeTaskSessionSummary | null,
	right: RuntimeTaskSessionSummary | null,
): RuntimeTaskSessionSummary | null {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}
	// pickNewerSessionSummary(current, candidate) returns `candidate` on
	// `updatedAt` ties, so an incoming summary (right) always wins here.
	return pickNewerSessionSummary(left, right);
}
