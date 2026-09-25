// B-10.7: the export bundle keeps operational facts and drops task content.
import { describe, expect, it } from "vitest";

import type { RuntimeTaskDiagnosticsResponse } from "../../../src/core/api-contract";
import { buildTaskDiagnosticsExportBundle } from "../../../src/core/task-diagnostics-export";

const HOME = "/home/operator";

function createDiagnostics(): RuntimeTaskDiagnosticsResponse {
	return {
		ok: true,
		task: { id: "task-1", title: "Add billing export for ACME", columnId: "review", updatedAt: 1 },
		phase: "reviewing",
		lastSuccessfulPhase: "reviewing",
		needsAttention: false,
		blockedReason: null,
		branch: "feature/x",
		commit: "abc123",
		baseRef: "main",
		baseSha: "def456",
		workspace: { worktreePath: `${HOME}/.cline/worktrees/task-1/repo`, exists: true },
		preservedWork: {
			status: "none",
			refName: null,
			patchPath: null,
			archivePath: null,
			latestCommit: null,
			blockedReasons: [],
			preservedAt: null,
		},
		delivery: { ok: true, receipt: null, error: null, dependentsUnlock: { allowed: false, reason: "none" } },
		review: {
			ok: true,
			status: "ready",
			handoff: {
				taskId: "task-1",
				worktreePath: `${HOME}/.cline/worktrees/task-1/repo`,
				repoPath: `${HOME}/code/repo`,
				startingCommit: "def456",
				latestCommit: "abc123",
				changedPaths: ["src/billing.ts"],
				untrackedPaths: [],
				planDocuments: [],
				acceptanceCriteria: ["Exports ACME invoices"],
				designDecisions: ["Use CSV"],
				testsAttempted: [],
				knownLimitations: [],
				unresolvedQuestions: [],
				createdAt: 1,
			},
			result: {
				taskId: "task-1",
				candidateTreeHash: "tree",
				reviewedAt: 1,
				findings: [
					{
						severity: "non-blocking",
						file: "src/billing.ts",
						line: 3,
						description: "ACME secret",
						evidence: "const key = 1",
					},
				],
				blocking: false,
				fixesApplied: ["Fixed ACME rounding"],
				requirementsCovered: ["Exports ACME invoices"],
				unresolvedItems: [],
			},
			candidateTreeHash: "tree",
			resultMatchesTree: true,
			error: null,
			warnings: [],
			verification: null,
		},
		dispatchRecord: null,
		session: { summary: null, active: false },
		context: {
			ok: true,
			source: "unavailable",
			messageCount: null,
			estimatedMessageTokens: null,
			effectiveCapacityTokens: null,
			triggerTokens: null,
			utilizationRatio: null,
			lastCompaction: null,
			historyOmitted: false,
			omittedHistoryNotice: null,
			error: null,
		},
		actions: {
			retry_phase: { enabled: false, reason: "No failed phase to retry." },
			resume_repair: { enabled: false, reason: "No delivery to resume." },
			cancel: { enabled: false, reason: "No active session to cancel." },
			recover_workspace: { enabled: false, reason: "No preserved work for this task." },
		},
		error: null,
	};
}

describe("buildTaskDiagnosticsExportBundle", () => {
	it("removes task content and the home directory but keeps operational facts", () => {
		const { bundle, redactions } = buildTaskDiagnosticsExportBundle({
			diagnostics: createDiagnostics(),
			transcriptMessageCount: 12,
			homeDirectory: HOME,
			exportedAt: "2026-09-25T00:00:00.000Z",
		});
		const serialized = JSON.stringify(bundle);
		expect(serialized).not.toContain("ACME");
		expect(serialized).not.toContain(HOME);
		expect(serialized).toContain("~/.cline/worktrees/task-1/repo");
		expect(serialized).toContain("feature/x");
		expect(serialized).toContain("src/billing.ts");
		expect(redactions).toEqual([
			"task_title",
			"session_transcript",
			"review_handoff_text",
			"review_result_text",
			"home_directory",
		]);
	});
});
