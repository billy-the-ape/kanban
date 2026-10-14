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
	// pickNewerSessionSummary(current, candidate) keeps `current` on ties,
	// preserving the existing keep-left behavior.
	return pickNewerSessionSummary(left, right);
}
