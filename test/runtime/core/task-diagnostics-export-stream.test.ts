// DIAG-2 (2c): the streaming JSON serializer — complete documents, exact
// artifact content streaming, split-surrogate safety, and abort semantics
// (a rejected stream must never be treated as a successful export).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSyntheticSessionHeader } from "../../../src/cline-sdk/cline-task-export-snapshot";
import type { ClineSdkPersistedMessage } from "../../../src/cline-sdk/sdk-runtime-boundary";
import type { RuntimeTaskDiagnosticsResponse } from "../../../src/core/api-contract";
import { streamTaskDiagnosticsExportV3 } from "../../../src/core/task-diagnostics-export-stream";
import type {
	TaskDiagnosticsExportSegment,
	TaskDiagnosticsExportV3Plan,
} from "../../../src/core/task-diagnostics-export-v3";

const HOME = "/home/operator";

let tempDir = "";
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "kanban-diag-export-stream-"));
});
afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

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

function createSegment(
	messages: ClineSdkPersistedMessage[],
	toolEvidence: TaskDiagnosticsExportSegment["toolEvidence"] = [],
): TaskDiagnosticsExportSegment {
	return {
		header: buildSyntheticSessionHeader({
			sessionId: "task-1-1000-abc12345",
			kind: "task",
			providerId: "anthropic",
			modelId: "claude-sonnet-4.6",
			cwd: `${HOME}/.cline/worktrees/task-1/repo`,
		}),
		artifactTaskId: "task-1",
		launchConfig: { mode: "act", systemPrompt: "", reasoningEffort: null },
		transcript: { status: "complete", reason: null },
		messages,
		liveTail: null,
		toolOrigins: [],
		toolEvidence,
	};
}

function createPlan(
	overrides: Partial<Pick<TaskDiagnosticsExportV3Plan, "sessions">> = {},
): TaskDiagnosticsExportV3Plan {
	return {
		schemaVersion: 3,
		exportedAt: "2026-10-12T10:00:00.000Z",
		capture: {
			capturedAt: 1760246400000,
			note: "Point-in-time capture; the live tail uses Kanban's display representation and may overlap the durable transcript.",
		},
		completeness: { status: "complete", reasons: [], warnings: [] },
		diagnostics: createDiagnostics(),
		taskPrompt: "Add billing export for ACME",
		sessions: [
			{
				kind: "task",
				taskId: "task-1",
				listingTruncated: false,
				transcript: { status: "complete", reason: null },
				summary: null,
				segments: [createSegment([])],
			},
		],
		...overrides,
	};
}

class CollectingWritable extends Writable {
	chunks: string[] = [];
	onWrite?: (self: CollectingWritable) => void;

	get output(): string {
		return this.chunks.join("");
	}

	_write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error) => void): void {
		this.chunks.push(chunk.toString());
		this.onWrite?.(this);
		callback();
	}
}

async function streamPlan(
	plan: TaskDiagnosticsExportV3Plan,
	options: Parameters<typeof streamTaskDiagnosticsExportV3>[2] = {},
): Promise<string> {
	const target = new CollectingWritable();
	await streamTaskDiagnosticsExportV3(target, plan, options);
	return target.output;
}

describe("streamTaskDiagnosticsExportV3", () => {
	it("streams a complete document that parses back to the exact plan", async () => {
		const messages: ClineSdkPersistedMessage[] = [
			{ role: "user", content: 'hello "quoted" \\ backslash\nnew line', sessionId: "s" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "editor", input: { path: "a.ts" } }],
				sessionId: "s",
			},
		];
		const plan = createPlan({
			sessions: [
				{
					kind: "task",
					taskId: "task-1",
					listingTruncated: false,
					transcript: { status: "complete", reason: null },
					summary: null,
					segments: [createSegment(messages)],
				},
			],
		});
		const output = await streamPlan(plan);
		const parsed: unknown = JSON.parse(output);
		expect(parsed).toEqual(plan);
	});

	it("streams the resolved artifact file content exactly (multi-byte, newlines, quotes)", async () => {
		const content = 'line one "quoted"\nsecond 行\ntrailing backslash \\ \u0001 control';
		const artifactPath = join(tempDir, "t1.txt");
		writeFileSync(artifactPath, content, "utf8");
		const plan = createPlan({
			sessions: [
				{
					kind: "task",
					taskId: "task-1",
					listingTruncated: false,
					transcript: { status: "complete", reason: null },
					summary: null,
					segments: [
						createSegment(
							[],
							[
								{
									messageIndex: 0,
									partIndex: 0,
									toolCallId: "t1",
									kind: "tool_result",
									fullOutput: {
										status: "resolved",
										artifactFileName: "t1.txt",
										artifactPath,
										contentFormat: "text",
										gap: null,
									},
								},
							],
						),
					],
				},
			],
		});
		const parsed: unknown = JSON.parse(await streamPlan(plan));
		const fullOutput = (
			parsed as {
				sessions: Array<{ segments: Array<{ toolEvidence: Array<{ fullOutput?: { content?: string } }> }> }>;
			}
		).sessions[0]?.segments[0]?.toolEvidence[0]?.fullOutput;
		expect(fullOutput?.content).toBe(content);
	});

	it("survives a surrogate pair split across encoding chunk boundaries", async () => {
		// 16383 filler chars put the emoji's high surrogate exactly on the
		// 16KiB chunk boundary; a lone high surrogate must not be emitted.
		const filler = "a".repeat(16383);
		const content = `${filler}\u{1F600} tail \u{1F600}`;
		const messages: ClineSdkPersistedMessage[] = [{ role: "user", content, sessionId: "s" }];
		const plan = createPlan({
			sessions: [
				{
					kind: "task",
					taskId: "task-1",
					listingTruncated: false,
					transcript: { status: "complete", reason: null },
					summary: null,
					segments: [createSegment(messages)],
				},
			],
		});
		const parsed: unknown = JSON.parse(await streamPlan(plan));
		const firstMessage = (
			parsed as { sessions: Array<{ segments: Array<{ messages: Array<{ content: string }> }> }> }
		).sessions[0]?.segments[0]?.messages[0];
		expect(firstMessage.content).toBe(content);
	});

	it("rejects on abort and leaves a truncated, unparseable document", async () => {
		const many = Array.from({ length: 50 }, (_, index) => ({
			role: "user" as const,
			content: `message ${index}`,
			sessionId: "s",
		}));
		const plan = createPlan({
			sessions: [
				{
					kind: "task",
					taskId: "task-1",
					listingTruncated: false,
					transcript: { status: "complete", reason: null },
					summary: null,
					segments: [createSegment(many)],
				},
			],
		});
		const controller = new AbortController();
		const target = new CollectingWritable();
		target.onWrite = (self) => {
			// Abort mid-document, after the first chunk lands.
			if (self.chunks.length >= 3) {
				controller.abort();
			}
		};
		await expect(streamTaskDiagnosticsExportV3(target, plan, { signal: controller.signal })).rejects.toThrow(
			"Export stream aborted.",
		);
		expect(target.output.startsWith('{"schemaVersion":3,')).toBe(true);
		expect(() => JSON.parse(target.output)).toThrow();
	});

	it("throws immediately when writing to an already-destroyed target", async () => {
		const target = new CollectingWritable();
		target.destroy();
		await expect(streamTaskDiagnosticsExportV3(target, createPlan())).rejects.toThrow(
			"Export stream target was closed before the write was accepted.",
		);
	});

	it("rejects (never hangs) when the target is destroyed while the writer waits for drain", async () => {
		// highWaterMark 1 forces backpressure on every write, so the writer
		// parks on the drain wait; _write swallows chunks and never drains.
		const slow = new Writable({
			highWaterMark: 1,
			write(_chunk: Buffer | string, _encoding: BufferEncoding, _callback: (error?: Error) => void) {
				// Intentionally do nothing: no callback, no drain.
			},
		});
		const streamPromise = streamTaskDiagnosticsExportV3(slow, createPlan());
		// Let the serializer reach the drain wait, then destroy the target
		// (simulating the mutation's failure path) — the writer must settle.
		await new Promise((resolve) => setTimeout(resolve, 25));
		slow.destroy();
		await expect(streamPromise).rejects.toThrow("Export stream target was closed while waiting for drain.");
	});
});
