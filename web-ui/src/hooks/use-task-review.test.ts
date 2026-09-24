import { describe, expect, it } from "vitest";

import { resolveTaskReviewVerdict } from "@/hooks/use-task-review";
import type { RuntimeTaskReviewInfoResponse } from "@/runtime/types";

function info(overrides: Partial<RuntimeTaskReviewInfoResponse>): RuntimeTaskReviewInfoResponse {
	return {
		ok: true,
		status: null,
		handoff: null,
		result: null,
		candidateTreeHash: null,
		resultMatchesTree: null,
		error: null,
		warnings: [],
		verification: null,
		...overrides,
	};
}

describe("resolveTaskReviewVerdict", () => {
	it("maps stored review outcomes to verdicts", () => {
		expect(resolveTaskReviewVerdict(null)).toBeNull();
		expect(resolveTaskReviewVerdict(info({}))).toBeNull();
		expect(resolveTaskReviewVerdict(info({ status: "ready", resultMatchesTree: true }))).toBe("ready");
		expect(resolveTaskReviewVerdict(info({ status: "blocked", resultMatchesTree: true }))).toBe("blocked");
		expect(resolveTaskReviewVerdict(info({ status: "parse_failed" }))).toBe("failed");
	});

	it("marks a verdict stale once the worktree no longer matches the reviewed tree (B-6.7)", () => {
		expect(resolveTaskReviewVerdict(info({ status: "ready", resultMatchesTree: false }))).toBe("stale");
	});
});
