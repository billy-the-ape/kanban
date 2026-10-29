// AR-7: quality-summary section rendering — empty/partial data, many
// episodes with cap/omitted counts, clear wall-clock time labels, unknown
// provenance, and the evidence-reference fallback text. On-demand loading
// and task-switch cancellation are covered by the hook test.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskQualitySummaryResponse } from "@/runtime/types";
import { TaskQualitySummarySection } from "./task-quality-summary-section";

const fetchTaskQualitySummaryMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/task-quality-summary", () => ({
	fetchTaskQualitySummary: fetchTaskQualitySummaryMock,
}));

function createQualitySummaryResponse(
	overrides: Partial<RuntimeTaskQualitySummaryResponse> = {},
): RuntimeTaskQualitySummaryResponse {
	return {
		ok: true,
		taskId: "task-1",
		capturedAt: 1760246400000,
		reducerVersion: 3,
		coverage: { status: "complete", reasons: [], warnings: [] },
		timing: {
			firstRecordedStart: null,
			lastRecordedEnd: null,
			openSegmentCount: 0,
			invalidIntervalCount: 0,
			recordedSessionSpanMs: null,
			coveredSegmentCount: 0,
			totalSegmentCount: 0,
		},
		sessionCounts: { working: 1, review: 0, verificationRepair: 0, distinctSessions: 1 },
		ambiguities: [],
		models: { pairs: [], mixedModels: false },
		responses: { assistantResponses: 1, withReportedMetrics: 1, peakReportedInput: null },
		usage: {
			inputTokens: { total: null, coverage: 0 },
			outputTokens: { total: null, coverage: 0 },
			cacheReadTokens: { total: null, coverage: 0 },
			cacheWriteTokens: { total: null, coverage: 0 },
		},
		tools: { totalCalls: 0, byName: {}, reportedFailures: 0, unmatchedCalls: 0, truncatedResults: 0 },
		retries: { unchangedFailedRetries: 0 },
		heuristicTags: {},
		liveTailExcluded: false,
		evidence: [],
		sessionSource: null,
		terminalSummaryAvailable: false,
		sourceWarning: null,
		sessionSpans: { working: null, review: null, verificationRepair: null },
		failuresByRule: {},
		editEpisodes: { total: 0, omitted: 0, cap: 100, items: [] },
		launchProvenance: [],
		validationJobs: { total: 0, items: [] },
		measuredCompaction: null,
		error: null,
		...overrides,
	};
}

function episode(
	overrides: Partial<RuntimeTaskQualitySummaryResponse["editEpisodes"]["items"][number]> = {},
): RuntimeTaskQualitySummaryResponse["editEpisodes"]["items"][number] {
	return {
		failureReference: { sessionId: "s1", kind: "task", messageIndex: 3, partIndex: 1, toolCallId: "e1" },
		failureRule: "editor_replacement_mismatch",
		file: "/tmp/a.ts",
		attemptsBetween: 0,
		readsBetween: 2,
		nextSuccessReference: { sessionId: "s1", kind: "task", messageIndex: 9, partIndex: 0, toolCallId: "e2" },
		end: "next_successful_edit",
		startedAt: 1760246400000,
		endedAt: 1760246467200,
		elapsedMs: 67200,
		timestampWarning: false,
		ruleVersion: 3,
		...overrides,
	};
}

function jobEvent(
	overrides: Partial<RuntimeTaskQualitySummaryResponse["validationJobs"]["items"][number]> = {},
): RuntimeTaskQualitySummaryResponse["validationJobs"]["items"][number] {
	return {
		jobId: "job-1",
		toolCallId: "vj-1",
		sessionId: "s1",
		command: "npx vitest run",
		state: "exited",
		outcome: "completed",
		exitCode: 0,
		startedAt: "2026-10-11T10:00:00.000Z",
		endedAt: "2026-10-11T10:01:30.000Z",
		logReference: "/tmp/artifacts/job-1.log",
		logTruncated: false,
		...overrides,
	};
}

describe("TaskQualitySummarySection", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		fetchTaskQualitySummaryMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderSection(workspaceId: string | null, taskId: string | null): void {
		act(() => {
			root.render(<TaskQualitySummarySection workspaceId={workspaceId} taskId={taskId} sessionActive={false} />);
		});
	}

	function clickButton(label: string): void {
		const button = [...container.querySelectorAll("button")].find((candidate) =>
			candidate.textContent?.includes(label),
		);
		if (button === undefined) {
			throw new Error(`Expected a button containing "${label}".`);
		}
		act(() => {
			button.click();
		});
	}

	it("renders nothing until the operator loads, then shows empty AR-7 fields without invented data", async () => {
		fetchTaskQualitySummaryMock.mockResolvedValue(createQualitySummaryResponse());
		renderSection("workspace-1", "task-1");
		expect(container.textContent).toContain("On-demand snapshot of recorded native sessions");
		expect(container.textContent).not.toContain("Edit-recovery episodes");
		expect(fetchTaskQualitySummaryMock).not.toHaveBeenCalled();

		await act(async () => {
			clickButton("Load recorded summary");
			await Promise.resolve();
		});
		expect(container.textContent).toContain("reducer v3");
		// Empty recorded data: no episode/job lists, no unknown provenance row.
		expect(container.textContent).not.toContain("Edit-recovery episodes");
		expect(container.textContent).not.toContain("Validation jobs");
		expect(container.textContent).not.toContain("Launch provenance");
		expect(container.textContent).not.toContain("Measured compaction");
	});

	it("keeps partial coverage visible and shows per-rule failure categories", async () => {
		fetchTaskQualitySummaryMock.mockResolvedValue(
			createQualitySummaryResponse({
				coverage: { status: "partial", reasons: ["one transcript could not be read"], warnings: [] },
				failuresByRule: { editor_replacement_mismatch: 2, run_commands_nested_failure: 1 },
			}),
		);
		renderSection("workspace-1", "task-1");
		await act(async () => {
			clickButton("Load recorded summary");
			await Promise.resolve();
		});
		expect(container.textContent).toContain("partial");
		expect(container.textContent).toContain("editor_replacement_mismatch×2");
		expect(container.textContent).toContain("run_commands_nested_failure×1");
		clickButton("Coverage reasons");
		expect(container.textContent).toContain("one transcript could not be read");
	});

	it("lists many capped episodes with clear wall-clock labels and reference fallback text", async () => {
		fetchTaskQualitySummaryMock.mockResolvedValue(
			createQualitySummaryResponse({
				editEpisodes: {
					total: 123,
					omitted: 23,
					cap: 100,
					items: [
						episode(),
						episode({
							end: "no_successful_edit_recorded",
							nextSuccessReference: null,
							endedAt: null,
							elapsedMs: null,
							timestampWarning: true,
						}),
					],
				},
			}),
		);
		renderSection("workspace-1", "task-1");
		await act(async () => {
			clickButton("Load recorded summary");
			await Promise.resolve();
		});
		clickButton("Edit-recovery episodes");
		const text = container.textContent ?? "";
		// Cap is reported; the list holds only the returned items.
		expect(text).toContain("Edit-recovery episodes (123, 23 more not listed)");
		// Clear wall-clock label, explicitly not runtime.
		expect(text).toContain("1m 7s (wall-clock, includes intervening work and waits)");
		// Observed-vs-inferred labels.
		expect(text).toContain("next successful edit on this file");
		expect(text).toContain("no successful edit recorded after the failure");
		// Copyable precise reference fallback (no invented deep link).
		expect(text).toContain("after msg 3:1 in s1 (call e1 · next success msg 9:0 in s1)");
		expect(text).toContain("unknown (recorded timestamps missing or inconsistent)");
		expect(text).toContain("timestamp warning: interval may be unreliable");
	});

	it("shows unknown launch provenance without inferring the installed SDK", async () => {
		fetchTaskQualitySummaryMock.mockResolvedValue(
			createQualitySummaryResponse({
				launchProvenance: [
					{
						sessionId: "s1",
						kind: "task",
						promptFingerprint: null,
						promptRecorded: false,
						sdkVersion: null,
						guidanceVersion: null,
					},
					{
						sessionId: "s2",
						kind: "review",
						promptFingerprint: "abc123",
						promptRecorded: true,
						sdkVersion: "0.0.38",
						guidanceVersion: "g-1",
					},
				],
				measuredCompaction: {
					at: "2026-10-11T10:30:00.000Z",
					trigger: "proactive",
					tokensBefore: 100000,
					tokensAfter: 40000,
					messagesBefore: 120,
					messagesAfter: 30,
				},
			}),
		);
		renderSection("workspace-1", "task-1");
		await act(async () => {
			clickButton("Load recorded summary");
			await Promise.resolve();
		});
		const text = container.textContent ?? "";
		// Mixed/missing values stay explicit; nothing is backfilled.
		expect(text).toContain("1/2 prompt fingerprints recorded · sdk mixed · guidance mixed");
		// Measured compaction is shown separately from estimated usage.
		expect(text).toContain("100,000 → 40,000 tokens (proactive");
	});

	it("renders validation-job observations as read-only statuses with log references", async () => {
		fetchTaskQualitySummaryMock.mockResolvedValue(
			createQualitySummaryResponse({
				validationJobs: {
					total: 2,
					items: [
						jobEvent(),
						jobEvent({
							jobId: "job-2",
							toolCallId: "vj-2",
							state: "timed_out",
							outcome: "timeout",
							exitCode: null,
							logReference: null,
						}),
					],
				},
			}),
		);
		renderSection("workspace-1", "task-1");
		await act(async () => {
			clickButton("Load recorded summary");
			await Promise.resolve();
		});
		clickButton("Validation jobs");
		const text = container.textContent ?? "";
		expect(text).toContain("Validation jobs (2)");
		expect(text).toContain("completed: npx vitest run · exit 0");
		expect(text).toContain("/tmp/artifacts/job-1.log");
		expect(text).toContain("timeout: npx vitest run");
		expect(text).toContain("no retained log");
	});

	it("drops the snapshot when the selected task changes", async () => {
		fetchTaskQualitySummaryMock.mockResolvedValue(createQualitySummaryResponse());
		renderSection("workspace-1", "task-1");
		await act(async () => {
			clickButton("Load recorded summary");
			await Promise.resolve();
		});
		expect(container.textContent).toContain("reducer v3");

		renderSection("workspace-1", "task-2");
		expect(container.textContent).not.toContain("reducer v3");
		// A pending refresh request is invalidated with the card.
		expect(fetchTaskQualitySummaryMock).toHaveBeenCalledTimes(1);
	});
});
