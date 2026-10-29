// DIAG-PANEL: deterministic task-quality summary reducer and response
// assembly. Small synthetic fixtures (never a user's unredacted diagnostics):
// inherited restart copies, id collisions, canonical argument equality,
// nested command result arrays, validation vs negative probes, zero/missing
// counters, missing/truncated results, mixed models, session intervals,
// review/repair lineage, live tails, unchanged failed retries, and
// complete/partial/unavailable coverage.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptyTaskEditorCallEvidence } from "../../../src/cline-sdk/cline-editor-call-evidence";
import type {
	ClineTaskExportKind,
	ClineTaskExportLaunchConfig,
	ClineTaskExportSegment,
	ClineTaskExportSnapshot,
	ClineTaskExportToolOriginEntry,
} from "../../../src/cline-sdk/cline-task-export-snapshot";
import type { ClineSdkPersistedMessage } from "../../../src/cline-sdk/sdk-runtime-boundary";
import {
	analyzeTaskQualitySummary,
	buildTaskQualitySummaryResponse,
	buildUnavailableTaskQualitySummaryResponse,
	canonicalizeJsonValue,
	type TaskQualitySummaryMessage,
	type TaskQualitySummarySession,
	type TaskQualitySummaryToolPart,
} from "../../../src/core/task-quality-summary";

const CAPTURED_AT = 1700000000000;
const TRUNCATION_MARKER = "output text ... [truncated 120 lines]";

function toolUsePart(
	overrides: Partial<TaskQualitySummaryToolPart> &
		Pick<TaskQualitySummaryToolPart, "toolCallId" | "toolName" | "arguments">,
): TaskQualitySummaryToolPart {
	const args = overrides.arguments;
	const argumentStatus: TaskQualitySummaryToolPart["argumentStatus"] =
		args === null || args === undefined
			? "unavailable"
			: Array.isArray(args)
				? args.length === 0
					? "empty"
					: "present"
				: typeof args === "object"
					? Object.keys(args).length === 0
						? "empty"
						: "present"
					: "present";
	return {
		index: 0,
		kind: "tool_use",
		argumentKey: canonicalizeJsonValue(overrides.arguments),
		argumentStatus,
		isResultError: false,
		resultText: null,
		origin: "native",
		...overrides,
	};
}

function toolResultPart(
	overrides: Partial<TaskQualitySummaryToolPart> & Pick<TaskQualitySummaryToolPart, "toolCallId" | "resultText">,
): TaskQualitySummaryToolPart {
	return {
		index: 0,
		kind: "tool_result",
		toolName: null,
		arguments: null,
		argumentKey: null,
		argumentStatus: "unavailable",
		isResultError: false,
		origin: "native",
		...overrides,
	};
}

function message(
	overrides: Partial<TaskQualitySummaryMessage> & Pick<TaskQualitySummaryMessage, "role" | "contentKey">,
): TaskQualitySummaryMessage {
	return {
		id: null,
		ts: null,
		modelProvider: null,
		modelId: null,
		metrics: null,
		toolParts: [],
		...overrides,
	};
}

function session(
	overrides: Partial<TaskQualitySummarySession> &
		Pick<TaskQualitySummarySession, "kind" | "sessionId" | "provider" | "model">,
): TaskQualitySummarySession {
	return {
		startedAt: null,
		endedAt: null,
		transcriptReadable: true,
		transcriptReason: null,
		hasLiveTail: false,
		promptFingerprint: null,
		sdkVersion: null,
		guidanceVersion: null,
		messages: [],
		...overrides,
	};
}

function run(sessions: TaskQualitySummarySession[]): ReturnType<typeof analyzeTaskQualitySummary> {
	return analyzeTaskQualitySummary({ capturedAt: CAPTURED_AT, sessions });
}

describe("analyzeTaskQualitySummary", () => {
	it("returns explicit zeros and nulls for an empty capture", () => {
		const result = analyzeTaskQualitySummary({ capturedAt: CAPTURED_AT, sessions: [] });
		expect(result.capturedAt).toBe(CAPTURED_AT);
		expect(result.firstRecordedStart).toBeNull();
		expect(result.lastRecordedEnd).toBeNull();
		expect(result.recordedSessionSpanMs).toBeNull();
		expect(result.sessionCounts).toEqual({ working: 0, review: 0, verificationRepair: 0, distinctSessions: 0 });
		expect(result.models.pairs).toEqual([]);
		expect(result.responses.assistantResponses).toBe(0);
		expect(result.usage.inputTokens).toEqual({ total: null, coverage: 0 });
		expect(result.toolCalls.total).toBe(0);
		expect(result.reportedToolFailures).toBe(0);
		expect(result.unmatchedToolCalls).toBe(0);
		expect(result.liveTailExcluded).toBe(false);
		expect(result.evidence).toEqual([]);
	});

	it("counts inherited restart copies exactly once (messages and tool calls)", () => {
		const assistant = (ts: number) =>
			message({
				role: "assistant",
				contentKey: "assistant-turn-1",
				ts,
				metrics: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
				toolParts: [
					toolUsePart({
						toolCallId: "call-1",
						toolName: "editor",
						arguments: { path: "/tmp/a.ts", new_text: "x" },
					}),
				],
			});
		const resultUser = (ts: number) =>
			message({
				role: "user",
				contentKey: "tool-result-call-1",
				ts,
				toolParts: [toolResultPart({ toolCallId: "call-1", resultText: "done" })],
			});
		// Two restart segments (task lineage) carrying the same durable history.
		const seg1 = session({
			kind: "task",
			sessionId: "seg-1",
			provider: "anthropic",
			model: "claude",
			startedAt: "2026-10-15T10:00:00Z",
			endedAt: "2026-10-15T10:30:00Z",
			messages: [assistant(1), resultUser(2)],
		});
		const seg2 = session({
			kind: "task",
			sessionId: "seg-2",
			provider: "anthropic",
			model: "claude",
			startedAt: "2026-10-15T11:00:00Z",
			endedAt: "2026-10-15T11:30:00Z",
			messages: [assistant(1), resultUser(2)],
		});
		const result = run([seg1, seg2]);
		expect(result.sessionCounts.working).toBe(2);
		expect(result.responses.assistantResponses).toBe(1);
		expect(result.toolCalls.total).toBe(1);
		expect(result.usage.inputTokens).toEqual({ total: 100, coverage: 1 });
		expect(result.ambiguities).toEqual([]);
	});

	it("deduplicates a repeated (kind, sessionId) session and records the ambiguity", () => {
		const seg = session({
			kind: "task",
			sessionId: "same",
			provider: "p",
			model: "m",
			messages: [message({ role: "user", contentKey: "c" })],
		});
		const result = run([seg, { ...seg }]);
		expect(result.sessionCounts.distinctSessions).toBe(1);
		expect(result.totalSegmentCount).toBe(1);
		expect(result.ambiguities).toEqual([
			expect.objectContaining({ ruleId: "duplicate_session", detail: expect.stringContaining("counted once") }),
		]);
	});

	it("keeps message id reuse conflicts separate instead of merging", () => {
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				message({ id: "m1", role: "assistant", contentKey: "first" }),
				message({ id: "m1", role: "assistant", contentKey: "second" }),
			],
		});
		const result = run([seg]);
		expect(result.responses.assistantResponses).toBe(2);
		expect(result.ambiguities).toEqual([
			expect.objectContaining({ ruleId: "message_id_reuse_conflict", detail: expect.stringContaining("m1") }),
		]);
	});

	it("counts canonical-argument copies of the same tool id once; conflicting ids stay separate", () => {
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				message({
					role: "assistant",
					contentKey: "a",
					toolParts: [
						// Same id, same arguments in different key order: one call.
						toolUsePart({ toolCallId: "t1", toolName: "editor", arguments: { a: 1, b: 2 } }),
						toolUsePart({ index: 1, toolCallId: "t1", toolName: "editor", arguments: { b: 2, a: 1 } }),
						// Same id, different arguments: identity reuse, two calls.
						toolUsePart({ index: 2, toolCallId: "t1", toolName: "editor", arguments: { a: 9 } }),
						// Different id, identical arguments: separate call (possible retry).
						toolUsePart({ index: 3, toolCallId: "t2", toolName: "editor", arguments: { a: 1, b: 2 } }),
					],
				}),
			],
		});
		const result = run([seg]);
		expect(result.toolCalls.total).toBe(3);
		expect(result.ambiguities).toEqual([
			expect.objectContaining({ ruleId: "tool_id_reuse_conflict", detail: expect.stringContaining("t1") }),
		]);
	});

	it("confirms a nested run_commands failure once per call, even when several commands fail", () => {
		const resultText = JSON.stringify({
			success: true,
			output: [
				{ command: "ls", success: true },
				{ command: "false", success: false, stderr: "boom" },
			],
		});
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				message({
					role: "assistant",
					contentKey: "a",
					toolParts: [
						toolUsePart({ toolCallId: "c1", toolName: "run_commands", arguments: { commands: ["ls", "false"] } }),
					],
				}),
				message({ role: "user", contentKey: "r", toolParts: [toolResultPart({ toolCallId: "c1", resultText })] }),
			],
		});
		const result = run([seg]);
		expect(result.reportedToolFailures).toBe(1);
		expect(result.evidence).toEqual([
			expect.objectContaining({
				ruleId: "run_commands_nested_failure",
				classification: "confirmed_failure",
				toolCallId: "c1",
				sessionId: "s",
			}),
		]);
	});

	it("treats a nonzero exit status without a success flag as a heuristic tag, not a confirmed failure", () => {
		const resultText = JSON.stringify({ success: true, output: [{ command: "make", exitCode: 2 }] });
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				message({
					role: "assistant",
					contentKey: "a",
					toolParts: [
						toolUsePart({ toolCallId: "c1", toolName: "run_commands", arguments: { commands: ["make"] } }),
					],
				}),
				message({ role: "user", contentKey: "r", toolParts: [toolResultPart({ toolCallId: "c1", resultText })] }),
			],
		});
		const result = run([seg]);
		expect(result.reportedToolFailures).toBe(0);
		expect(result.heuristicTags).toEqual({ nonzero_exit_status: 1 });
		expect(result.evidence).toEqual([
			expect.objectContaining({ ruleId: "nonzero_exit_status", classification: "heuristic_tag" }),
		]);
	});

	it("tags masked pipelines and expected negative probes separately from failures", () => {
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				// A grep probe with no matches: intentional, heuristic only.
				message({
					role: "assistant",
					contentKey: "probe",
					toolParts: [
						toolUsePart({
							toolCallId: "g1",
							toolName: "run_commands",
							arguments: { commands: ["grep foo src"] },
						}),
					],
				}),
				message({
					role: "user",
					contentKey: "probe-result",
					toolParts: [
						toolResultPart({
							toolCallId: "g1",
							resultText: JSON.stringify({ success: true, output: [{ command: "grep foo src", result: "" }] }),
						}),
					],
				}),
				// A pipeline that masks exit status, even though it succeeded.
				message({
					role: "assistant",
					contentKey: "masked",
					toolParts: [
						toolUsePart({
							toolCallId: "g2",
							toolName: "run_commands",
							arguments: { commands: ["make all | tail -n 20"] },
						}),
					],
				}),
				message({
					role: "user",
					contentKey: "masked-result",
					toolParts: [
						toolResultPart({
							toolCallId: "g2",
							resultText: JSON.stringify({
								success: true,
								output: [{ command: "make all | tail -n 20", result: "ok" }],
							}),
						}),
					],
				}),
			],
		});
		const result = run([seg]);
		expect(result.reportedToolFailures).toBe(0);
		expect(result.heuristicTags).toEqual({ expected_negative_probe: 1, suspected_masked_command_failure: 1 });
	});

	it("confirms editor failures by their documented feedback, with editor categories", () => {
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				message({
					role: "assistant",
					contentKey: "a",
					toolParts: [toolUsePart({ toolCallId: "e1", toolName: "editor", arguments: { path: "/tmp/a" } })],
				}),
				message({
					role: "user",
					contentKey: "r",
					toolParts: [
						toolResultPart({
							toolCallId: "e1",
							isResultError: true,
							resultText: JSON.stringify({ success: false, error: "No replacement performed: text not found" }),
						}),
					],
				}),
			],
		});
		const result = run([seg]);
		// V2: the structural is_error stays visible (resultIsError), but a
		// documented editor category is never erased by it.
		expect(result.reportedToolFailures).toBe(1);
		expect(result.evidence[0]).toEqual(
			expect.objectContaining({
				ruleId: "editor_replacement_mismatch",
				classification: "confirmed_failure",
				resultIsError: true,
			}),
		);
	});

	it("keeps tool_result_is_error for non-editor is_error results and editor_other for undocumented editor errors", () => {
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				message({
					role: "assistant",
					contentKey: "a",
					toolParts: [
						toolUsePart({ toolCallId: "r1", toolName: "read_files", arguments: { path: "/tmp/a" } }),
						toolUsePart({ index: 1, toolCallId: "e1", toolName: "editor", arguments: { path: "/tmp/a" } }),
					],
				}),
				message({
					role: "user",
					contentKey: "r",
					toolParts: [
						toolResultPart({ toolCallId: "r1", isResultError: true, resultText: "read failed" }),
						toolResultPart({
							index: 1,
							toolCallId: "e1",
							isResultError: true,
							resultText: "Editor operation failed: something odd",
						}),
					],
				}),
			],
		});
		const result = run([seg]);
		expect(result.reportedToolFailures).toBe(2);
		expect(result.evidence).toEqual([
			expect.objectContaining({ ruleId: "tool_result_is_error", toolCallId: "r1", resultIsError: true }),
			expect.objectContaining({ ruleId: "editor_other", toolCallId: "e1", resultIsError: true }),
		]);
	});

	it("classifies command timeouts distinctly and does not recurse into nested output text", () => {
		const timeoutEntry = { command: "make build", success: false, error: "Command timed out after 300000ms" };
		const mixedEntries = [
			{ command: "make test", success: false, error: "Command timed out after 300000ms" },
			{ command: "make lint", success: false, error: "exit 1" },
		];
		// A log-inspection command that prints an earlier failed run's JSON:
		// the entry itself succeeded, and its result text is never scanned.
		const logInspection = {
			success: true,
			output: [{ command: "cat run.log", result: '{"success": false, "error": "boom"}' }],
		};
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				message({
					role: "assistant",
					contentKey: "a",
					toolParts: [
						toolUsePart({ toolCallId: "c1", toolName: "run_commands", arguments: { commands: ["make build"] } }),
						toolUsePart({
							index: 1,
							toolCallId: "c2",
							toolName: "run_commands",
							arguments: { commands: ["make test", "make lint"] },
						}),
						toolUsePart({
							index: 2,
							toolCallId: "c3",
							toolName: "run_commands",
							arguments: { commands: ["cat run.log"] },
						}),
					],
				}),
				message({
					role: "user",
					contentKey: "r",
					toolParts: [
						toolResultPart({ toolCallId: "c1", resultText: JSON.stringify([timeoutEntry]) }),
						toolResultPart({ index: 1, toolCallId: "c2", resultText: JSON.stringify(mixedEntries) }),
						toolResultPart({ index: 2, toolCallId: "c3", resultText: JSON.stringify(logInspection) }),
					],
				}),
			],
		});
		const result = run([seg]);
		expect(result.reportedToolFailures).toBe(2);
		expect(result.evidence).toEqual([
			expect.objectContaining({ ruleId: "command_timeout", toolCallId: "c1", classification: "confirmed_failure" }),
			expect.objectContaining({
				ruleId: "run_commands_nested_failure",
				toolCallId: "c2",
				classification: "confirmed_failure",
			}),
		]);
	});

	it("never treats quoted source, fixture JSON, or prose failure text as failures", () => {
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				message({
					role: "assistant",
					contentKey: "a",
					toolParts: [
						toolUsePart({ toolCallId: "e1", toolName: "editor", arguments: { path: "/tmp/a.ts" } }),
						toolUsePart({
							index: 1,
							toolCallId: "r1",
							toolName: "read_files",
							arguments: { path: "/tmp/f.json" },
						}),
					],
				}),
				message({
					role: "user",
					contentKey: "r",
					toolParts: [
						// A success result whose text embeds a fixture failure
						// line and a quoted `Full content:` marker: no failure,
						// no artifact reference.
						toolResultPart({
							toolCallId: "e1",
							resultText:
								'File written (+3 lines). Fixture diff:\n+    {"success": false, "error": "boom"}\nFull content: /tmp/not-an-artifact.txt',
						}),
						// A successful read of a file that happens to hold a
						// failed run's JSON array: not a command entry, not a
						// failure (read_files is not run_commands).
						toolResultPart({
							index: 1,
							toolCallId: "r1",
							resultText: JSON.stringify([{ command: "old run", success: false, error: "boom" }]),
						}),
					],
				}),
			],
		});
		const result = run([seg]);
		expect(result.reportedToolFailures).toBe(0);
		expect(result.evidence).toEqual([]);
	});

	it("confirms Kanban's { recovery, output } envelope as a structural failure", () => {
		const envelope = JSON.stringify({ recovery: "Retry with a corrected reference.", output: "grep: no such file" });
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				message({
					role: "assistant",
					contentKey: "a",
					toolParts: [
						toolUsePart({ toolCallId: "c1", toolName: "run_commands", arguments: { commands: ["cat missing"] } }),
					],
				}),
				message({
					role: "user",
					contentKey: "r",
					toolParts: [toolResultPart({ toolCallId: "c1", resultText: envelope })],
				}),
			],
		});
		const result = run([seg]);
		expect(result.reportedToolFailures).toBe(1);
		expect(result.evidence[0]).toEqual(
			expect.objectContaining({
				ruleId: "recovery_envelope_failure",
				classification: "confirmed_failure",
				resultIsError: false,
			}),
		);
	});

	it("excludes empty and unavailable editor arguments from unchanged-retry identity", () => {
		// Two malformed editor calls recorded with empty `{}` arguments
		// (different ids) both fail: `{}` can never prove identity.
		const emptySeg = session({
			kind: "task",
			sessionId: "empty",
			provider: "p",
			model: "m",
			messages: [
				message({
					role: "assistant",
					contentKey: "a1",
					toolParts: [toolUsePart({ toolCallId: "e1", toolName: "editor", arguments: {} })],
				}),
				message({
					role: "user",
					contentKey: "r1",
					toolParts: [
						toolResultPart({
							toolCallId: "e1",
							isResultError: true,
							resultText: "Parameter `old_text` is required",
						}),
					],
				}),
				message({
					role: "assistant",
					contentKey: "a2",
					toolParts: [toolUsePart({ toolCallId: "e2", toolName: "editor", arguments: {} })],
				}),
				message({
					role: "user",
					contentKey: "r2",
					toolParts: [
						toolResultPart({
							toolCallId: "e2",
							isResultError: true,
							resultText: "Parameter `old_text` is required",
						}),
					],
				}),
			],
		});
		const emptyResult = run([emptySeg]);
		expect(emptyResult.reportedToolFailures).toBe(2);
		expect(emptyResult.unchangedFailedRetries).toBe(0);
		expect(emptyResult.evidence.filter((entry) => entry.ruleId === "unchanged_failed_retry")).toHaveLength(0);

		// Unavailable provenance (no recorded input) is labelled unknown.
		const unknownSeg = session({
			kind: "task",
			sessionId: "unknown",
			provider: "p",
			model: "m",
			messages: [
				message({
					role: "assistant",
					contentKey: "a1",
					toolParts: [toolUsePart({ toolCallId: "u1", toolName: "editor", arguments: null })],
				}),
				message({
					role: "user",
					contentKey: "r1",
					toolParts: [toolResultPart({ toolCallId: "u1", isResultError: true, resultText: "failed" })],
				}),
				message({
					role: "assistant",
					contentKey: "a2",
					toolParts: [toolUsePart({ toolCallId: "u2", toolName: "editor", arguments: null })],
				}),
				message({
					role: "user",
					contentKey: "r2",
					toolParts: [toolResultPart({ toolCallId: "u2", isResultError: true, resultText: "failed" })],
				}),
			],
		});
		const unknownResult = run([unknownSeg]);
		expect(unknownResult.unchangedFailedRetries).toBe(0);
		expect(unknownResult.ambiguities).toEqual([
			expect.objectContaining({ ruleId: "argument_provenance_unknown", detail: expect.stringContaining("u1") }),
			expect.objectContaining({ ruleId: "argument_provenance_unknown", detail: expect.stringContaining("u2") }),
		]);
	});

	it("keeps zero counters at zero and missing counters unknown, with coverage", () => {
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				// Reports input=0 (a real zero) but no output metric.
				message({
					role: "assistant",
					contentKey: "a1",
					metrics: { inputTokens: 0, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
				}),
				// Reports output only.
				message({
					role: "assistant",
					contentKey: "a2",
					metrics: { inputTokens: null, outputTokens: 42, cacheReadTokens: null, cacheWriteTokens: null },
				}),
				// No metrics at all.
				message({ role: "assistant", contentKey: "a3" }),
			],
		});
		const result = run([seg]);
		expect(result.responses.assistantResponses).toBe(3);
		expect(result.responses.withReportedMetrics).toBe(2);
		expect(result.usage.inputTokens).toEqual({ total: 0, coverage: 1 / 3 });
		expect(result.usage.outputTokens).toEqual({ total: 42, coverage: 1 / 3 });
		expect(result.responses.peakReportedInput).toBe(0);
	});

	it("separates unmatched calls from confirmed failures and flags truncated results", () => {
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				message({
					role: "assistant",
					contentKey: "a",
					toolParts: [toolUsePart({ toolCallId: "c1", toolName: "read_files", arguments: { path: "/tmp/a" } })],
				}),
				message({
					role: "user",
					contentKey: "r",
					toolParts: [toolResultPart({ toolCallId: "c1", resultText: TRUNCATION_MARKER })],
				}),
				// A call whose result was never recorded.
				message({
					role: "assistant",
					contentKey: "b",
					toolParts: [toolUsePart({ toolCallId: "c2", toolName: "read_files", arguments: { path: "/tmp/b" } })],
				}),
			],
		});
		const result = run([seg]);
		expect(result.unmatchedToolCalls).toBe(1);
		expect(result.reportedToolFailures).toBe(0);
		expect(result.truncatedToolResults).toBe(1);
		expect(result.evidence).toEqual([
			expect.objectContaining({ ruleId: "unmatched_tool_call", classification: "unmatched_call", toolCallId: "c2" }),
		]);
	});

	it("never matches an empty-id call to an empty-id result", () => {
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				message({
					role: "assistant",
					contentKey: "a",
					toolParts: [toolUsePart({ toolCallId: "", toolName: "read_files", arguments: { path: "/tmp/a" } })],
				}),
				message({
					role: "user",
					contentKey: "r",
					toolParts: [toolResultPart({ toolCallId: "", resultText: "ok" })],
				}),
			],
		});
		const result = run([seg]);
		expect(result.unmatchedToolCalls).toBe(1);
		expect(result.reportedToolFailures).toBe(0);
		expect(result.evidence).toEqual([
			expect.objectContaining({ ruleId: "unmatched_tool_call", classification: "unmatched_call", toolCallId: "" }),
		]);
	});

	it("flags mixed models from headers and assistant metadata without inference", () => {
		const segA = session({
			kind: "task",
			sessionId: "a",
			provider: "anthropic",
			model: "claude-x",
			messages: [message({ role: "assistant", contentKey: "a", modelProvider: "anthropic", modelId: "claude-y" })],
		});
		const segB = session({ kind: "task", sessionId: "b", provider: "openai", model: "gpt-z", messages: [] });
		const result = run([segA, segB]);
		expect(result.models.mixedModels).toBe(true);
		expect(result.models.pairs).toEqual([
			{ provider: "anthropic", model: "claude-x" },
			{ provider: "openai", model: "gpt-z" },
			{ provider: "anthropic", model: "claude-y" },
		]);
	});

	it("unions valid closed intervals; open, invalid, and missing intervals stay explicit", () => {
		const validA = session({
			kind: "task",
			sessionId: "a",
			provider: "p",
			model: "m",
			startedAt: "2026-10-15T10:00:00Z",
			endedAt: "2026-10-15T11:00:00Z",
		});
		const overlappingB = session({
			kind: "task",
			sessionId: "b",
			provider: "p",
			model: "m",
			startedAt: "2026-10-15T10:30:00Z",
			endedAt: "2026-10-15T12:00:00Z",
		});
		const openC = session({
			kind: "review",
			sessionId: "c",
			provider: "p",
			model: "m",
			startedAt: "2026-10-15T13:00:00Z",
			endedAt: null,
		});
		const invalidD = session({
			kind: "review",
			sessionId: "d",
			provider: "p",
			model: "m",
			startedAt: "2026-10-15T15:00:00Z",
			endedAt: "2026-10-15T14:00:00Z",
		});
		const missingE = session({
			kind: "verification-repair",
			sessionId: "e",
			provider: "p",
			model: "m",
			startedAt: null,
			endedAt: null,
		});
		const result = run([validA, overlappingB, openC, invalidD, missingE]);
		expect(result.firstRecordedStart).toBe(Date.parse("2026-10-15T10:00:00Z"));
		expect(result.lastRecordedEnd).toBe(Date.parse("2026-10-15T12:00:00Z"));
		expect(result.openSegmentCount).toBe(2); // openC, missingE
		expect(result.invalidIntervalCount).toBe(1); // invalidD
		expect(result.coveredSegmentCount).toBe(2);
		expect(result.totalSegmentCount).toBe(5);
		// Union of 10:00-11:00 and 10:30-12:00 is 10:00-12:00 = 2h.
		expect(result.recordedSessionSpanMs).toBe(2 * 3600 * 1000);
		expect(result.sessionCounts).toEqual({ working: 2, review: 2, verificationRepair: 1, distinctSessions: 5 });
	});

	it("flags live tails without counting them", () => {
		const withTail = session({
			kind: "task",
			sessionId: "live",
			provider: "p",
			model: "m",
			hasLiveTail: true,
			messages: [message({ role: "assistant", contentKey: "a" })],
		});
		const result = run([withTail]);
		expect(result.liveTailExcluded).toBe(true);
		expect(result.responses.assistantResponses).toBe(1);
	});

	it("counts unchanged failed retries with both evidence references", () => {
		const edit = (partIndex: number, id: string) =>
			message({
				role: "assistant",
				contentKey: `edit-${id}`,
				toolParts: [
					toolUsePart({
						index: partIndex,
						toolCallId: id,
						toolName: "editor",
						arguments: { path: "/tmp/a", old_text: "x", new_text: "y" },
					}),
				],
			});
		const failedResult = (index: number, id: string) =>
			message({
				role: "user",
				contentKey: `result-${id}`,
				toolParts: [
					toolResultPart({ index, toolCallId: id, isResultError: true, resultText: "No replacement performed" }),
				],
			});
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				edit(0, "e1"),
				failedResult(0, "e1"),
				edit(1, "e2"),
				failedResult(1, "e2"),
				edit(2, "e3"),
				failedResult(2, "e3"),
			],
		});
		const result = run([seg]);
		expect(result.reportedToolFailures).toBe(3);
		expect(result.unchangedFailedRetries).toBe(2);
		const retryEvidence = result.evidence.filter((entry) => entry.ruleId === "unchanged_failed_retry");
		expect(retryEvidence).toHaveLength(2);
		expect(retryEvidence[0]).toEqual(
			expect.objectContaining({
				toolCallId: "e2",
				classification: "unchanged_retry",
				priorReference: expect.objectContaining({ toolCallId: "e1", sessionId: "s" }),
			}),
		);
		expect(retryEvidence[1]).toEqual(
			expect.objectContaining({ toolCallId: "e3", priorReference: expect.objectContaining({ toolCallId: "e2" }) }),
		);
	});

	it("does not count a later identical call as a failed retry when the prior call was unmatched", () => {
		const seg = session({
			kind: "task",
			sessionId: "s",
			provider: "p",
			model: "m",
			messages: [
				// No tool_result recorded for a1 (e.g. the session was cut off).
				message({
					role: "assistant",
					contentKey: "a1",
					toolParts: [
						toolUsePart({
							index: 0,
							toolCallId: "a1",
							toolName: "run_commands",
							arguments: { commands: ["make"] },
						}),
					],
				}),
				// Identical call with a later id succeeds.
				message({
					role: "assistant",
					contentKey: "a2",
					toolParts: [
						toolUsePart({
							index: 1,
							toolCallId: "a2",
							toolName: "run_commands",
							arguments: { commands: ["make"] },
						}),
					],
				}),
				message({
					role: "user",
					contentKey: "r2",
					toolParts: [toolResultPart({ index: 1, toolCallId: "a2", resultText: "build ok" })],
				}),
			],
		});
		const result = run([seg]);
		expect(result.reportedToolFailures).toBe(0);
		expect(result.unmatchedToolCalls).toBe(1);
		// An unmatched prior call is not a reported failure: no retry evidence.
		expect(result.unchangedFailedRetries).toBe(0);
		expect(result.evidence.filter((entry) => entry.ruleId === "unchanged_failed_retry")).toHaveLength(0);
	});

	it("counts confirmed failures per rule, deduplicating inherited restart copies", () => {
		const editorUse = toolUsePart({
			toolCallId: "e1",
			toolName: "editor",
			arguments: { path: "/tmp/a.ts", old_text: "x", new_text: "y" },
		});
		const editorFail = toolResultPart({
			toolCallId: "e1",
			resultText: "Editor operation failed: No replacement performed: text not found.",
			isResultError: true,
		});
		const commandUse = toolUsePart({
			toolCallId: "c1",
			toolName: "run_commands",
			arguments: { commands: ["make build"] },
		});
		const commandFail = toolResultPart({
			toolCallId: "c1",
			resultText: JSON.stringify({ output: [{ command: "make build", success: false, error: "exit 2" }] }),
		});
		const segment = (sessionId: string): TaskQualitySummarySession =>
			session({
				kind: "task",
				sessionId,
				provider: "p",
				model: "m",
				messages: [
					message({ role: "assistant", contentKey: "turn", ts: 1000, toolParts: [editorUse, commandUse] }),
					message({ role: "user", contentKey: "results", ts: 2000, toolParts: [editorFail, commandFail] }),
				],
			});
		const result = run([segment("s1"), segment("s2")]);
		// The seeded copy in s2 is the same recorded calls: one failure each.
		expect(result.failuresByRule).toEqual({
			editor_replacement_mismatch: 1,
			run_commands_nested_failure: 1,
		});
	});

	it("reports recorded spans per session class, excluding gaps between sessions", () => {
		const task = session({
			kind: "task",
			sessionId: "t",
			provider: "p",
			model: "m",
			startedAt: "2026-10-15T10:00:00Z",
			endedAt: "2026-10-15T10:30:00Z",
		});
		const review = session({
			kind: "review",
			sessionId: "r",
			provider: "p",
			model: "m",
			startedAt: "2026-10-15T11:00:00Z",
			endedAt: "2026-10-15T11:15:00Z",
		});
		const result = run([task, review]);
		expect(result.sessionSpans).toEqual({ working: 1_800_000, review: 900_000, verificationRepair: null });
		// 45 recorded minutes total; the 30-minute gap between sessions is excluded.
		expect(result.recordedSessionSpanMs).toBe(2_700_000);
	});

	it("closes an edit-recovery episode at the next successful edit to the same file", () => {
		const failUse = toolUsePart({
			toolCallId: "e1",
			toolName: "editor",
			arguments: { path: "/tmp/a.ts", old_text: "x", new_text: "y" },
		});
		const failResult = toolResultPart({
			toolCallId: "e1",
			resultText: "Editor operation failed: No replacement performed: text not found.",
			isResultError: true,
		});
		const readUse = toolUsePart({
			toolCallId: "r1",
			toolName: "read_files",
			arguments: { files: [{ path: "/tmp/a.ts" }] },
		});
		const readResult = toolResultPart({ toolCallId: "r1", resultText: "line 1" });
		const okUse = toolUsePart({
			toolCallId: "e2",
			toolName: "editor",
			arguments: { path: "/tmp/a.ts", old_text: "x2", new_text: "y2" },
		});
		const okResult = toolResultPart({ toolCallId: "e2", resultText: "Edited /tmp/a.ts" });
		const seg = session({
			kind: "task",
			sessionId: "s1",
			provider: "p",
			model: "m",
			messages: [
				message({ role: "assistant", contentKey: "a1", ts: 1000, toolParts: [failUse] }),
				message({ role: "user", contentKey: "u1", ts: 2000, toolParts: [failResult] }),
				message({ role: "assistant", contentKey: "a2", ts: 3000, toolParts: [readUse] }),
				message({ role: "user", contentKey: "u2", ts: 4000, toolParts: [readResult] }),
				message({ role: "assistant", contentKey: "a3", ts: 5000, toolParts: [okUse] }),
				message({ role: "user", contentKey: "u3", ts: 6000, toolParts: [okResult] }),
			],
		});
		const result = run([seg]);
		expect(result.failuresByRule).toEqual({ editor_replacement_mismatch: 1 });
		expect(result.editEpisodes.total).toBe(1);
		expect(result.editEpisodes.omitted).toBe(0);
		const episode = result.editEpisodes.items[0];
		expect(episode.failureRule).toBe("editor_replacement_mismatch");
		expect(episode.file).toBe("/tmp/a.ts");
		expect(episode.end).toBe("next_successful_edit");
		expect(episode.attemptsBetween).toBe(0);
		expect(episode.readsBetween).toBe(1);
		expect(episode.startedAt).toBe(1000);
		expect(episode.endedAt).toBe(5000);
		expect(episode.elapsedMs).toBe(4000);
		expect(episode.timestampWarning).toBe(false);
		expect(episode.failureReference).toEqual({
			sessionId: "s1",
			kind: "task",
			messageIndex: 0,
			partIndex: 0,
			toolCallId: "e1",
		});
		expect(episode.nextSuccessReference).toEqual({
			sessionId: "s1",
			kind: "task",
			messageIndex: 4,
			partIndex: 0,
			toolCallId: "e2",
		});
	});

	it("leaves an episode open at the end of the lineage when no successful edit is recorded", () => {
		const failUse = toolUsePart({
			toolCallId: "e1",
			toolName: "editor",
			arguments: { path: "/tmp/a.ts", old_text: "x", new_text: "y" },
		});
		const failResult = toolResultPart({
			toolCallId: "e1",
			resultText: "Editor operation failed: No replacement performed: text not found.",
			isResultError: true,
		});
		const seg = session({
			kind: "task",
			sessionId: "s1",
			provider: "p",
			model: "m",
			messages: [
				message({ role: "assistant", contentKey: "a1", ts: 1000, toolParts: [failUse] }),
				message({ role: "user", contentKey: "u1", ts: 2000, toolParts: [failResult] }),
			],
		});
		const result = run([seg]);
		expect(result.editEpisodes.total).toBe(1);
		const episode = result.editEpisodes.items[0];
		expect(episode.end).toBe("no_successful_edit_recorded");
		expect(episode.nextSuccessReference).toBeNull();
		expect(episode.elapsedMs).toBeNull();
	});

	it("closes an episode as superseded when the next same-file edit also fails", () => {
		const firstFailUse = toolUsePart({
			toolCallId: "e1",
			toolName: "editor",
			arguments: { path: "/tmp/a.ts", old_text: "x", new_text: "y" },
		});
		const firstFailResult = toolResultPart({
			toolCallId: "e1",
			resultText: "Editor operation failed: No replacement performed: text not found.",
			isResultError: true,
		});
		const readUse = toolUsePart({
			toolCallId: "r1",
			toolName: "read_files",
			arguments: { files: [{ path: "/tmp/a.ts" }] },
		});
		const readResult = toolResultPart({ toolCallId: "r1", resultText: "line 1" });
		const otherOkUse = toolUsePart({
			toolCallId: "e2",
			toolName: "editor",
			arguments: { path: "/tmp/b.ts", old_text: "x", new_text: "y" },
		});
		const otherOkResult = toolResultPart({ toolCallId: "e2", resultText: "Edited /tmp/b.ts" });
		const secondFailUse = toolUsePart({
			toolCallId: "e3",
			toolName: "editor",
			arguments: { path: "/tmp/a.ts", old_text: "z", new_text: "w" },
		});
		const secondFailResult = toolResultPart({
			toolCallId: "e3",
			resultText: "Editor operation failed: No replacement performed: text not found.",
			isResultError: true,
		});
		const seg = session({
			kind: "task",
			sessionId: "s1",
			provider: "p",
			model: "m",
			messages: [
				message({ role: "assistant", contentKey: "a1", ts: 1000, toolParts: [firstFailUse] }),
				message({ role: "user", contentKey: "u1", ts: 2000, toolParts: [firstFailResult] }),
				message({ role: "assistant", contentKey: "a2", ts: 3000, toolParts: [readUse] }),
				message({ role: "user", contentKey: "u2", ts: 4000, toolParts: [readResult] }),
				message({ role: "assistant", contentKey: "a3", ts: 5000, toolParts: [otherOkUse] }),
				message({ role: "user", contentKey: "u3", ts: 6000, toolParts: [otherOkResult] }),
				message({ role: "assistant", contentKey: "a4", ts: 7000, toolParts: [secondFailUse] }),
				message({ role: "user", contentKey: "u4", ts: 8000, toolParts: [secondFailResult] }),
			],
		});
		const result = run([seg]);
		expect(result.editEpisodes.total).toBe(2);
		const [first, second] = result.editEpisodes.items;
		expect(first.end).toBe("no_successful_edit_before_next_failure");
		// The /tmp/b.ts success is a different file: it is neither an attempt
		// nor a close for the /tmp/a.ts episode; the read of /tmp/a.ts is.
		expect(first.attemptsBetween).toBe(0);
		expect(first.readsBetween).toBe(1);
		expect(second.end).toBe("no_successful_edit_recorded");
	});

	it("lets a seeded successful edit in a later session close the episode, counting copies once", () => {
		const failUse = toolUsePart({
			toolCallId: "e1",
			toolName: "editor",
			arguments: { path: "/tmp/a.ts", old_text: "x", new_text: "y" },
		});
		const failResult = toolResultPart({
			toolCallId: "e1",
			resultText: "Editor operation failed: No replacement performed: text not found.",
			isResultError: true,
		});
		const okUse = toolUsePart({
			toolCallId: "e2",
			toolName: "editor",
			arguments: { path: "/tmp/a.ts", old_text: "x2", new_text: "y2" },
		});
		const okResult = toolResultPart({ toolCallId: "e2", resultText: "Edited /tmp/a.ts" });
		const task = session({
			kind: "task",
			sessionId: "s1",
			provider: "p",
			model: "m",
			messages: [
				message({ role: "assistant", contentKey: "a1", ts: 1000, toolParts: [failUse] }),
				message({ role: "user", contentKey: "u1", ts: 2000, toolParts: [failResult] }),
			],
		});
		// The review session seeds the same failed call (same id and args, so it
		// is the same recorded call) and later edits the file successfully.
		const review = session({
			kind: "review",
			sessionId: "s2",
			provider: "p",
			model: "m",
			messages: [
				message({ role: "assistant", contentKey: "a1-copy", ts: 7000, toolParts: [failUse] }),
				message({ role: "user", contentKey: "u1-copy", ts: 7100, toolParts: [failResult] }),
				message({ role: "assistant", contentKey: "a2", ts: 8000, toolParts: [okUse] }),
				message({ role: "user", contentKey: "u2", ts: 8100, toolParts: [okResult] }),
			],
		});
		const result = run([task, review]);
		expect(result.failuresByRule).toEqual({ editor_replacement_mismatch: 1 });
		expect(result.editEpisodes.total).toBe(1);
		const episode = result.editEpisodes.items[0];
		expect(episode.end).toBe("next_successful_edit");
		expect(episode.attemptsBetween).toBe(0); // the seeded copy is not an attempt
		expect(episode.elapsedMs).toBe(7000); // 1000 (recorded failure) -> 8000 (recorded success)
		expect(episode.nextSuccessReference).toEqual({
			sessionId: "s2",
			kind: "review",
			messageIndex: 2,
			partIndex: 0,
			toolCallId: "e2",
		});
	});

	it("records file_path_unknown when the failed editor call has no recorded file path", () => {
		const failUse = toolUsePart({ toolCallId: "e1", toolName: "editor", arguments: { path: "", new_text: "y" } });
		const failResult = toolResultPart({
			toolCallId: "e1",
			resultText: "Editor operation failed: No replacement performed: text not found.",
			isResultError: true,
		});
		const seg = session({
			kind: "task",
			sessionId: "s1",
			provider: "p",
			model: "m",
			messages: [
				message({ role: "assistant", contentKey: "a1", ts: 1000, toolParts: [failUse] }),
				message({ role: "user", contentKey: "u1", ts: 2000, toolParts: [failResult] }),
			],
		});
		const result = run([seg]);
		expect(result.editEpisodes.total).toBe(1);
		const episode = result.editEpisodes.items[0];
		expect(episode.file).toBeNull();
		expect(episode.end).toBe("file_path_unknown");
	});

	it("returns empty AR-7 fields for an empty capture", () => {
		const result = analyzeTaskQualitySummary({ capturedAt: CAPTURED_AT, sessions: [] });
		expect(result.failuresByRule).toEqual({});
		expect(result.sessionSpans).toEqual({ working: null, review: null, verificationRepair: null });
		expect(result.editEpisodes).toEqual({ total: 0, omitted: 0, cap: 100, items: [] });
		expect(result.launchProvenance).toEqual([]);
	});
});

describe("buildTaskQualitySummaryResponse", () => {
	function persistedMessage(
		overrides: Partial<ClineSdkPersistedMessage> & Pick<ClineSdkPersistedMessage, "role">,
	): ClineSdkPersistedMessage {
		return {
			content: [],
			...overrides,
		};
	}

	function segment(overrides: {
		sessionId: string;
		kind: ClineTaskExportKind;
		messages?: ClineSdkPersistedMessage[];
		startedAt?: string | null;
		endedAt?: string | null;
		readError?: string | null;
		liveTail?: boolean;
		toolOrigins?: ClineTaskExportToolOriginEntry[];
		launchConfig?: ClineTaskExportLaunchConfig | null;
	}): ClineTaskExportSegment {
		return {
			header: {
				sessionId: overrides.sessionId,
				kind: overrides.kind,
				source: "core",
				status: "completed",
				startedAt: overrides.startedAt ?? null,
				endedAt: overrides.endedAt ?? null,
				updatedAt: null,
				provider: "anthropic",
				model: "claude",
				cwd: "/tmp/wt",
				workspaceRoot: "/tmp/wt",
				exitCode: null,
			},
			artifactTaskId: "task-1",
			launchConfig: overrides.launchConfig ?? null,
			transcript: {
				status: overrides.readError === null ? "complete" : "unavailable",
				reason: overrides.readError ?? null,
			},
			messages: overrides.messages ?? [],
			liveTail: overrides.liveTail
				? { messages: [], representation: "kanban-display", possibleOverlap: true }
				: null,
			readError: overrides.readError ?? null,
			toolOrigins: overrides.toolOrigins ?? [],
			editorCallEvidence: emptyTaskEditorCallEvidence(),
		};
	}

	function snapshot(overrides: {
		kind: ClineTaskExportKind;
		segments?: ClineTaskExportSegment[];
		listingTruncated?: boolean;
		enumerationErrors?: string[];
	}): ClineTaskExportSnapshot {
		return {
			kind: overrides.kind,
			taskId: "task-1",
			capturedAt: CAPTURED_AT,
			listingTruncated: overrides.listingTruncated ?? false,
			enumerationErrors: overrides.enumerationErrors ?? [],
			segments: overrides.segments ?? [],
		};
	}

	it("preserves direct structured command arrays and recovery envelopes from persisted native results", () => {
		// The SDK persists some tool results as the object array itself; the
		// typed persisted-message shape cannot express that, so the fixture
		// models the raw persisted JSON through one explicit cast. The native
		// adapter must not drop these (the V1 text-block-only adapter produced
		// an empty result and missed these failures).
		const structuredFailureMessage = (ts: number) =>
			({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "c1",
						content: [{ command: "make build", success: false, error: "exit 2" }],
					},
				],
				ts,
			}) as unknown as ClineSdkPersistedMessage;
		const useMessage = persistedMessage({
			role: "assistant",
			content: [{ type: "tool_use", id: "c1", name: "run_commands", input: { commands: ["make build"] } }],
			ts: 1700000000101,
		});
		const segmentMessages = [useMessage, structuredFailureMessage(1700000000102)];
		// Two inherited restart segments carry the same durable history: the
		// failure is counted exactly once.
		const response = buildTaskQualitySummaryResponse({
			taskId: "task-1",
			capturedAt: CAPTURED_AT,
			taskSnapshot: snapshot({
				kind: "task",
				segments: [
					segment({
						sessionId: "s1",
						kind: "task",
						startedAt: "2026-10-15T10:00:00Z",
						endedAt: "2026-10-15T10:30:00Z",
						messages: segmentMessages,
					}),
					segment({
						sessionId: "s2",
						kind: "task",
						startedAt: "2026-10-15T10:40:00Z",
						endedAt: "2026-10-15T11:00:00Z",
						messages: segmentMessages,
					}),
				],
			}),
			taskSnapshotError: null,
			reviewSnapshot: null,
			reviewSnapshotError: null,
			sessionSource: null,
			terminalSummaryAvailable: false,
			jobEvents: [],
			measuredCompaction: null,
		});
		expect(response.ok).toBe(true);
		expect(response.tools.totalCalls).toBe(1);
		expect(response.tools.reportedFailures).toBe(1);
		expect(response.evidence).toEqual([
			expect.objectContaining({
				ruleId: "run_commands_nested_failure",
				classification: "confirmed_failure",
				resultIsError: false,
			}),
		]);

		// A recovery envelope persisted as a JSON text block (array-valued
		// output) is a structural failure.
		const envelopeResponse = buildTaskQualitySummaryResponse({
			taskId: "task-1",
			capturedAt: CAPTURED_AT,
			taskSnapshot: snapshot({
				kind: "task",
				segments: [
					segment({
						sessionId: "s1",
						kind: "task",
						messages: [
							persistedMessage({
								role: "assistant",
								content: [{ type: "tool_use", id: "c2", name: "run_commands", input: { commands: ["make"] } }],
								ts: 1700000000201,
							}),
							persistedMessage({
								role: "user",
								content: [
									{
										type: "tool_result",
										tool_use_id: "c2",
										is_error: true,
										content: [
											{
												type: "text",
												text: JSON.stringify({
													recovery: "Run the command with an explicit timeout.",
													output: [{ command: "make", success: false, error: "boom" }],
												}),
											},
										],
									},
								],
								ts: 1700000000202,
							}),
						],
					}),
				],
			}),
			taskSnapshotError: null,
			reviewSnapshot: null,
			reviewSnapshotError: null,
			sessionSource: null,
			terminalSummaryAvailable: false,
			jobEvents: [],
			measuredCompaction: null,
		});
		expect(envelopeResponse.tools.reportedFailures).toBe(1);
		expect(envelopeResponse.evidence).toEqual([
			expect.objectContaining({
				ruleId: "run_commands_nested_failure",
				classification: "confirmed_failure",
				resultIsError: true,
			}),
		]);
	});

	it("keeps text blocks when persisted tool results mix text with image/file blocks", () => {
		// Regression: v2 must not drop the text of mixed display arrays
		// (image/file blocks carry no documented text; the text blocks are
		// the documented result).
		const mixedResultMessage = (text: string) =>
			({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "c1",
						content: [
							{ type: "image", data: "not-a-documented-text" },
							{ type: "text", text },
						],
					},
				],
				ts: 1700000000302,
			}) as unknown as ClineSdkPersistedMessage;
		const useMessage = persistedMessage({
			role: "assistant",
			content: [{ type: "tool_use", id: "c1", name: "run_commands", input: { commands: ["make"] } }],
			ts: 1700000000301,
		});
		const response = buildTaskQualitySummaryResponse({
			taskId: "task-1",
			capturedAt: CAPTURED_AT,
			taskSnapshot: snapshot({
				kind: "task",
				segments: [
					segment({
						sessionId: "s1",
						kind: "task",
						messages: [
							useMessage,
							mixedResultMessage(
								JSON.stringify({ success: true, output: [{ command: "make", success: false, error: "boom" }] }),
							),
						],
					}),
				],
			}),
			taskSnapshotError: null,
			reviewSnapshot: null,
			reviewSnapshotError: null,
			sessionSource: null,
			terminalSummaryAvailable: false,
			jobEvents: [],
			measuredCompaction: null,
		});
		expect(response.tools.totalCalls).toBe(1);
		expect(response.tools.reportedFailures).toBe(1);
		expect(response.evidence).toEqual([
			expect.objectContaining({ ruleId: "run_commands_nested_failure", classification: "confirmed_failure" }),
		]);

		// Image/file-only content carries no documented text: no evidence.
		const imageOnlyResponse = buildTaskQualitySummaryResponse({
			taskId: "task-1",
			capturedAt: CAPTURED_AT,
			taskSnapshot: snapshot({
				kind: "task",
				segments: [
					segment({
						sessionId: "s1",
						kind: "task",
						messages: [useMessage, mixedResultMessage("")],
					}),
				],
			}),
			taskSnapshotError: null,
			reviewSnapshot: null,
			reviewSnapshotError: null,
			sessionSource: null,
			terminalSummaryAvailable: false,
			jobEvents: [],
			measuredCompaction: null,
		});
		expect(imageOnlyResponse.tools.reportedFailures).toBe(0);
		expect(imageOnlyResponse.evidence).toEqual([]);
	});

	it("assembles a complete summary for recorded native sessions", () => {
		const response = buildTaskQualitySummaryResponse({
			taskId: "task-1",
			capturedAt: CAPTURED_AT,
			taskSnapshot: snapshot({
				kind: "task",
				segments: [
					segment({
						sessionId: "s1",
						kind: "task",
						startedAt: "2026-10-15T10:00:00Z",
						endedAt: "2026-10-15T11:00:00Z",
						messages: [
							persistedMessage({
								role: "assistant",
								content: [{ type: "tool_use", id: "c1", name: "editor", input: { path: "/tmp/a" } }],
								ts: 1700000000001,
								metrics: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
							}),
							persistedMessage({
								role: "user",
								content: [
									{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "done" }] },
								],
								ts: 1700000000002,
							}),
						],
					}),
				],
			}),
			taskSnapshotError: null,
			reviewSnapshot: snapshot({ kind: "review" }),
			reviewSnapshotError: null,
			sessionSource: "cline",
			terminalSummaryAvailable: true,
			jobEvents: [],
			measuredCompaction: null,
		});
		expect(response.ok).toBe(true);
		expect(response.coverage.status).toBe("complete");
		expect(response.coverage.reasons).toEqual([]);
		expect(response.sessionCounts).toEqual({ working: 1, review: 0, verificationRepair: 0, distinctSessions: 1 });
		expect(response.tools.totalCalls).toBe(1);
		expect(response.tools.byName).toEqual({ editor: 1 });
		expect(response.usage.outputTokens).toEqual({ total: 5, coverage: 1 });
		expect(response.sourceWarning).toBeNull();
		expect(response.terminalSummaryAvailable).toBe(true);
	});

	it("marks partial coverage when a transcript could not be read, keeping recorded totals", () => {
		const response = buildTaskQualitySummaryResponse({
			taskId: "task-1",
			capturedAt: CAPTURED_AT,
			taskSnapshot: snapshot({
				kind: "task",
				segments: [
					segment({
						sessionId: "ok",
						kind: "task",
						startedAt: "2026-10-15T10:00:00Z",
						endedAt: "2026-10-15T11:00:00Z",
						messages: [persistedMessage({ role: "assistant", content: "hello" })],
					}),
					segment({
						sessionId: "broken",
						kind: "task",
						startedAt: "2026-10-15T11:00:00Z",
						endedAt: "2026-10-15T12:00:00Z",
						readError: "ENOENT: transcript missing",
					}),
				],
			}),
			taskSnapshotError: null,
			reviewSnapshot: null,
			reviewSnapshotError: null,
			sessionSource: null,
			terminalSummaryAvailable: false,
			jobEvents: [],
			measuredCompaction: null,
		});
		expect(response.coverage.status).toBe("partial");
		expect(response.coverage.reasons).toEqual([expect.stringContaining("broken")]);
		// The readable segment's totals are retained, not discarded.
		expect(response.responses.assistantResponses).toBe(1);
	});

	it("carries class snapshot failures as explicit reasons", () => {
		const response = buildTaskQualitySummaryResponse({
			taskId: "task-1",
			capturedAt: CAPTURED_AT,
			taskSnapshot: null,
			taskSnapshotError: "service unavailable",
			reviewSnapshot: snapshot({ kind: "review", enumerationErrors: ["lineage read failed"] }),
			reviewSnapshotError: null,
			sessionSource: null,
			terminalSummaryAvailable: false,
			jobEvents: [],
			measuredCompaction: null,
		});
		expect(response.coverage.status).toBe("unavailable");
		expect(response.coverage.reasons).toEqual([
			"session class task snapshot failed: service unavailable",
			"session class review snapshot read failed: lineage read failed",
			"no Cline session transcript is recorded for this task",
		]);
	});

	it("keeps terminal summary availability separate from native transcript coverage", () => {
		const response = buildTaskQualitySummaryResponse({
			taskId: "task-1",
			capturedAt: CAPTURED_AT,
			taskSnapshot: snapshot({
				kind: "task",
				segments: [
					segment({
						sessionId: "s1",
						kind: "task",
						messages: [persistedMessage({ role: "assistant", content: "hi" })],
					}),
				],
			}),
			taskSnapshotError: null,
			reviewSnapshot: null,
			reviewSnapshotError: null,
			sessionSource: "terminal",
			terminalSummaryAvailable: true,
			jobEvents: [],
			measuredCompaction: null,
		});
		expect(response.coverage.status).toBe("partial");
		expect(response.sourceWarning).toBeTypeOf("string");
		expect(response.sourceWarning).toContain("terminal agent session");
		// The native total survives alongside the terminal warning.
		expect(response.responses.assistantResponses).toBe(1);
	});

	it("reports unavailable with an explicit reason when nothing is recorded", () => {
		const response = buildTaskQualitySummaryResponse({
			taskId: "task-1",
			capturedAt: CAPTURED_AT,
			taskSnapshot: snapshot({ kind: "task" }),
			taskSnapshotError: null,
			reviewSnapshot: snapshot({ kind: "review" }),
			reviewSnapshotError: null,
			sessionSource: null,
			terminalSummaryAvailable: false,
			jobEvents: [],
			measuredCompaction: null,
		});
		expect(response.coverage.status).toBe("unavailable");
		expect(response.coverage.reasons).toEqual(["no Cline session transcript is recorded for this task"]);
		expect(response.sessionCounts.distinctSessions).toBe(0);
	});

	it("carries observed validation jobs and the measured compaction record", () => {
		const jobEvent = {
			jobId: "job-1",
			toolCallId: "vj-1",
			sessionId: "s1",
			command: "npx vitest run",
			state: "exited" as const,
			outcome: "completed" as const,
			exitCode: 0,
			startedAt: "2026-10-15T10:00:00Z",
			endedAt: "2026-10-15T10:02:00Z",
			logReference: "/tmp/artifacts/job-1.log",
			logTruncated: false,
		};
		const measured = {
			at: "2026-10-15T10:01:00Z",
			trigger: "proactive" as const,
			tokensBefore: 100000,
			tokensAfter: 40000,
			messagesBefore: 120,
			messagesAfter: 30,
		};
		const response = buildTaskQualitySummaryResponse({
			taskId: "task-1",
			capturedAt: CAPTURED_AT,
			taskSnapshot: snapshot({ kind: "task" }),
			taskSnapshotError: null,
			reviewSnapshot: null,
			reviewSnapshotError: null,
			sessionSource: null,
			terminalSummaryAvailable: false,
			jobEvents: [jobEvent],
			measuredCompaction: measured,
		});
		expect(response.validationJobs).toEqual({ total: 1, items: [jobEvent] });
		expect(response.measuredCompaction).toEqual(measured);
	});

	it("records launch provenance from the persisted launch config (no inference)", () => {
		const prompt = "Build the ACME export.";
		const fingerprint = createHash("sha256").update(prompt, "utf8").digest("hex");
		const response = buildTaskQualitySummaryResponse({
			taskId: "task-1",
			capturedAt: CAPTURED_AT,
			taskSnapshot: snapshot({
				kind: "task",
				segments: [
					segment({
						sessionId: "s1",
						kind: "task",
						messages: [persistedMessage({ role: "assistant", content: "Done.", ts: 1700000000101 })],
						launchConfig: {
							mode: "act",
							systemPrompt: prompt,
							reasoningEffort: null,
							sdkVersion: "0.0.38",
							guidanceVersion: "g-1",
						},
					}),
				],
			}),
			taskSnapshotError: null,
			reviewSnapshot: snapshot({
				kind: "review",
				segments: [
					segment({
						sessionId: "s2",
						kind: "review",
						messages: [persistedMessage({ role: "user", content: "Review", ts: 1700000000102 })],
					}),
				],
			}),
			reviewSnapshotError: null,
			sessionSource: null,
			terminalSummaryAvailable: false,
			jobEvents: [],
			measuredCompaction: null,
		});
		expect(response.launchProvenance).toEqual([
			{
				sessionId: "s1",
				kind: "task",
				promptFingerprint: fingerprint,
				promptRecorded: true,
				sdkVersion: "0.0.38",
				guidanceVersion: "g-1",
			},
			{
				// Older session without a recorded launch config: unknown, never inferred.
				sessionId: "s2",
				kind: "review",
				promptFingerprint: null,
				promptRecorded: false,
				sdkVersion: null,
				guidanceVersion: null,
			},
		]);
	});
});

describe("buildUnavailableTaskQualitySummaryResponse", () => {
	it("returns an explicit hard-failure response without invented data", () => {
		const response = buildUnavailableTaskQualitySummaryResponse("task-1", "snapshot host error");
		expect(response.ok).toBe(false);
		expect(response.taskId).toBe("task-1");
		expect(response.error).toBe("snapshot host error");
		expect(response.coverage.status).toBe("unavailable");
		expect(response.tools.totalCalls).toBe(0);
	});
});
