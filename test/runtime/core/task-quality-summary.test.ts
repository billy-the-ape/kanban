// DIAG-PANEL: deterministic task-quality summary reducer and response
// assembly. Small synthetic fixtures (never a user's unredacted diagnostics):
// inherited restart copies, id collisions, canonical argument equality,
// nested command result arrays, validation vs negative probes, zero/missing
// counters, missing/truncated results, mixed models, session intervals,
// review/repair lineage, live tails, unchanged failed retries, and
// complete/partial/unavailable coverage.
import { describe, expect, it } from "vitest";
import type {
	ClineTaskExportKind,
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
	return {
		index: 0,
		kind: "tool_use",
		argumentKey: canonicalizeJsonValue(overrides.arguments),
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
		// is_error wins: the structural flag is the confirmed rule.
		expect(result.reportedToolFailures).toBe(1);
		expect(result.evidence[0]).toEqual(
			expect.objectContaining({ ruleId: "tool_result_is_error", classification: "confirmed_failure" }),
		);
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
			launchConfig: null,
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
		});
		expect(response.coverage.status).toBe("unavailable");
		expect(response.coverage.reasons).toEqual(["no Cline session transcript is recorded for this task"]);
		expect(response.sessionCounts.distinctSessions).toBe(0);
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
