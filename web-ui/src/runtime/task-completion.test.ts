import { describe, expect, it } from "vitest";

import { isUnfinishedReliableGitAttempt } from "@/runtime/task-completion";
import type { RuntimeCompletionAttempt } from "@/runtime/types";

function attempt(phase: RuntimeCompletionAttempt["phase"], status: RuntimeCompletionAttempt["status"]) {
	return { phase, status } as RuntimeCompletionAttempt;
}

describe("isUnfinishedReliableGitAttempt (B-4.7)", () => {
	it("routes unfinished Git-phase attempts back to reliable completion", () => {
		expect(isUnfinishedReliableGitAttempt(attempt("pushing", "failed"))).toBe(true);
		expect(isUnfinishedReliableGitAttempt(attempt("committing", "running"))).toBe(true);
	});

	it("lets the legacy path run when no Git side effect is pending", () => {
		expect(isUnfinishedReliableGitAttempt(null)).toBe(false);
		expect(isUnfinishedReliableGitAttempt(attempt("review", "blocked"))).toBe(false);
		expect(isUnfinishedReliableGitAttempt(attempt("complete", "complete"))).toBe(false);
	});
});
