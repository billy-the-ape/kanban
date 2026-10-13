// DIAG-2 (2b/2c): the schemaVersion 3 plan builder — full-fidelity transcript
// assembly, tool evidence attachment, and Decision-5 completeness semantics.
import { describe, expect, it } from "vitest";
import type { ClineTaskExportSnapshot } from "../../../src/cline-sdk/cline-task-export-snapshot";
import { buildSyntheticSessionHeader } from "../../../src/cline-sdk/cline-task-export-snapshot";
import type { ClineSdkPersistedMessage } from "../../../src/cline-sdk/sdk-runtime-boundary";
import type { RuntimeTaskDiagnosticsResponse, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	type BuildTaskDiagnosticsExportV3Input,
	buildTaskDiagnosticsExportV3,
} from "../../../src/core/task-diagnostics-export-v3";

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
			result: null,
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

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: `${HOME}/.cline/worktrees/task-1/repo`,
		pid: 1234,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function message(parts: Array<Record<string, unknown>>): ClineSdkPersistedMessage {
	return { role: "assistant", content: parts as never, sessionId: "task-1-1000-abc12345" };
}

function createSnapshot(
	overrides: Partial<ClineTaskExportSnapshot> & { messages?: ClineSdkPersistedMessage[] },
): ClineTaskExportSnapshot {
	const { messages, ...rest } = overrides;
	return {
		kind: "task",
		taskId: "task-1",
		capturedAt: 1000,
		listingTruncated: false,
		segments: [
			{
				header: buildSyntheticSessionHeader({
					sessionId: "task-1-1000-abc12345",
					kind: "task",
					providerId: "anthropic",
					modelId: "claude-sonnet-4.6",
					cwd: `${HOME}/.cline/worktrees/task-1/repo`,
				}),
				artifactTaskId: "task-1",
				launchConfig: null,
				transcript: { status: "complete", reason: null },
				messages: messages ?? [],
				liveTail: null,
				readError: null,
				toolOrigins: [],
			},
		],
		...rest,
	};
}

function baseInput(overrides: Partial<BuildTaskDiagnosticsExportV3Input> = {}): BuildTaskDiagnosticsExportV3Input {
	return {
		taskId: "task-1",
		diagnostics: createDiagnostics(),
		taskPrompt: "Add billing export for ACME",
		sessionSnapshots: [],
		sessionSource: null,
		sessionSummary: null,
		capturedAt: 1760246400000,
		exportedAt: "2026-10-12T10:00:00.000Z",
		...overrides,
	};
}

describe("buildTaskDiagnosticsExportV3", () => {
	it("exports operational diagnostics with an explicit transcript gap when no sessions exist", async () => {
		const plan = await buildTaskDiagnosticsExportV3(baseInput());
		expect(plan.schemaVersion).toBe(3);
		expect(plan.diagnostics).toEqual(createDiagnostics());
		expect(plan.taskPrompt).toBe("Add billing export for ACME");
		expect(plan.sessions).toEqual([]);
		expect(plan.completeness.status).toBe("unavailable");
		expect(plan.completeness.reasons).toContain("no Cline session transcript is recorded for this task");
	});

	it("keeps messages unmodified and attaches evidence only by reference", async () => {
		const messages = [
			message([{ type: "tool_use", id: "t1", name: "editor", input: { path: "a.ts" } }]),
			message([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
		];
		const plan = await buildTaskDiagnosticsExportV3(baseInput({ sessionSnapshots: [createSnapshot({ messages })] }));
		const session = plan.sessions[0];
		const segment = session?.segments[0];
		expect(session?.kind).toBe("task");
		expect(segment?.messages).toEqual(messages);
		// t1 has a matching result and is not a truncated excerpt: no evidence.
		expect(segment?.toolEvidence).toEqual([]);
		expect(plan.completeness).toEqual({ status: "complete", reasons: [], warnings: [] });
	});

	it("annotates unmatched tool calls without repairing the message history", async () => {
		const plan = await buildTaskDiagnosticsExportV3(
			baseInput({
				sessionSnapshots: [
					createSnapshot({
						messages: [message([{ type: "tool_use", id: "t9", name: "run_command", input: {} }])],
					}),
				],
			}),
		);
		const evidence = plan.sessions[0]?.segments[0]?.toolEvidence;
		expect(evidence).toEqual([
			expect.objectContaining({
				messageIndex: 0,
				partIndex: 0,
				toolCallId: "t9",
				kind: "unmatched_tool_call",
			}),
		]);
		expect(evidence?.[0]?.annotation).toContain("No matching tool result");
	});

	it("attaches resolved full-output evidence for truncated tool results", async () => {
		const truncatedText = "head\n\n... [truncated 42 lines; full output: /tmp/artifacts/task-1/t3.txt]\n\ntail";
		const messages = [
			message([{ type: "tool_use", id: "t3", name: "run_command", input: {} }]),
			message([{ type: "tool_result", tool_use_id: "t3", content: truncatedText }]),
		];
		const plan = await buildTaskDiagnosticsExportV3(
			baseInput({
				sessionSnapshots: [createSnapshot({ messages })],
				artifactResolver: async ({ toolCallId }) => ({
					status: "resolved" as const,
					artifactFileName: `${toolCallId}.txt`,
					artifactPath: `/tmp/artifacts/task-1/${toolCallId}.txt`,
					contentFormat: "text" as const,
					gap: null,
				}),
			}),
		);
		const evidence = plan.sessions[0]?.segments[0]?.toolEvidence;
		expect(evidence).toEqual([
			{
				messageIndex: 1,
				partIndex: 0,
				toolCallId: "t3",
				kind: "tool_result",
				fullOutput: {
					status: "resolved",
					artifactFileName: "t3.txt",
					artifactPath: "/tmp/artifacts/task-1/t3.txt",
					contentFormat: "text",
					gap: null,
				},
			},
		]);
	});

	it("records a warning for truncated tool results whose artifact no longer exists", async () => {
		const truncatedText = "head\n\n...[truncated 1000 chars]...\n\ntail";
		const messages = [
			message([{ type: "tool_use", id: "t4", name: "read_file", input: {} }]),
			message([{ type: "tool_result", tool_use_id: "t4", content: truncatedText }]),
		];
		const plan = await buildTaskDiagnosticsExportV3(
			baseInput({
				sessionSnapshots: [createSnapshot({ messages })],
				artifactResolver: async () => ({
					status: "missing" as const,
					artifactFileName: null,
					artifactPath: null,
					contentFormat: null,
					gap: "No surviving artifact records the full output for this tool call.",
				}),
			}),
		);
		expect(plan.completeness.status).toBe("complete");
		expect(plan.completeness.warnings).toEqual([
			"tool result t4: No surviving artifact records the full output for this tool call.",
		]);
	});

	it("marks the capture partial when a durable transcript cannot be read", async () => {
		const unreadable: ClineTaskExportSnapshot = {
			kind: "task",
			taskId: "task-1",
			capturedAt: 1000,
			listingTruncated: false,
			segments: [
				{
					header: buildSyntheticSessionHeader({
						sessionId: "task-1-1000-abc12345",
						kind: "task",
						providerId: null,
						modelId: null,
						cwd: null,
					}),
					artifactTaskId: "task-1",
					launchConfig: null,
					transcript: { status: "unavailable", reason: "EACCES" },
					messages: [],
					liveTail: null,
					readError: "EACCES: permission denied",
					toolOrigins: [],
				},
			],
		};
		const plan = await buildTaskDiagnosticsExportV3(baseInput({ sessionSnapshots: [unreadable] }));
		expect(plan.sessions[0]?.transcript.status).toBe("unavailable");
		expect(plan.sessions[0]?.segments[0]?.transcript.reason).toBe("EACCES: permission denied");
		expect(plan.completeness.status).toBe("partial");
		expect(plan.completeness.reasons).toContain("transcript for session task-1-1000-abc12345 could not be read");
	});

	it("marks the transcript partial when the session listing was truncated", async () => {
		const plan = await buildTaskDiagnosticsExportV3(
			baseInput({
				sessionSnapshots: [createSnapshot({ listingTruncated: true, messages: [] })],
			}),
		);
		expect(plan.sessions[0]?.transcript.status).toBe("partial");
		expect(plan.sessions[0]?.transcript.reason).toBe("at least one session transcript of this class is partial");
		expect(plan.completeness.status).toBe("partial");
		expect(plan.completeness.reasons).toContain("session listing may be truncated");
	});

	it("keeps the capture complete but warns when a segment carries a live tail", async () => {
		const snapshot = createSnapshot({ messages: [] });
		const segment = snapshot.segments[0];
		if (!segment) {
			throw new Error("missing segment");
		}
		segment.liveTail = {
			messages: [
				{ id: "m1", role: "assistant", content: "working on it", createdAt: 2000 },
				{ id: "m2", role: "tool", content: "tool output", createdAt: 2001, meta: { toolCallId: "t1" } },
			],
			representation: "kanban-display",
			possibleOverlap: true,
		};
		const plan = await buildTaskDiagnosticsExportV3(baseInput({ sessionSnapshots: [snapshot] }));
		expect(plan.completeness.status).toBe("complete");
		expect(plan.completeness.warnings).toEqual([
			"session task-1-1000-abc12345 carries a live tail of 2 Kanban display message(s) that may overlap the durable transcript",
		]);
	});

	it("exports terminal agent sessions as summary-only with an explicit unavailable transcript", async () => {
		const summary = createSummary();
		const plan = await buildTaskDiagnosticsExportV3(
			baseInput({ sessionSource: "terminal", sessionSummary: summary }),
		);
		expect(plan.sessions).toEqual([
			{
				kind: "task",
				taskId: "task-1",
				listingTruncated: false,
				transcript: {
					status: "unavailable",
					reason: "terminal agent session; no structured transcript recorded",
				},
				summary,
				segments: [],
			},
		]);
		expect(plan.completeness.status).toBe("unavailable");
	});
});
