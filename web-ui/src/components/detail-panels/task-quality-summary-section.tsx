// DIAG-PANEL: recorded quality summary section in the diagnostics panel.
// On-demand, operator-triggered: loads a point-in-time snapshot of the
// task's recorded native sessions (working + review + verification-repair)
// with session spans, reported usage (with per-counter coverage), distinct
// tool-call counts, confirmed failures, unmatched calls, unchanged failed
// retries, and heuristic tags. Historical results on a running task are
// labeled as snapshots. All gaps (partial/unavailable coverage, live tail,
// truncated results) are shown explicitly — never a silent zero.
import { AlertTriangle, ChevronDown, ChevronRight, ListTree } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useTaskQualitySummary } from "@/hooks/use-task-quality-summary";
import type { RuntimeTaskQualitySummaryResponse } from "@/runtime/types";
import { formatDiagnosticsDuration, formatDiagnosticsTimestamp } from "@/utils/task-diagnostics-summary";
import { DiagnosticsSection, DiagnosticsValue } from "./task-diagnostics-primitives";

type QualitySummaryCoverageStatus = RuntimeTaskQualitySummaryResponse["coverage"]["status"];

function CoverageBadge({ status }: { status: QualitySummaryCoverageStatus }): React.ReactElement {
	return (
		<span
			className={cn(
				"shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium",
				status === "complete" && "bg-status-green/15 text-status-green",
				status === "partial" && "bg-status-orange/15 text-status-orange",
				status === "unavailable" && "bg-status-red/15 text-status-red",
			)}
		>
			{status}
		</span>
	);
}

function ModelPairs({ summary }: { summary: RuntimeTaskQualitySummaryResponse }): React.ReactElement | null {
	if (summary.models.pairs.length === 0) {
		return null;
	}
	const label = summary.models.pairs.map((pair) => `${pair.provider}/${pair.model}`).join(", ");
	return (
		<>
			<DiagnosticsValue label="Models" value={label} />
			{summary.models.mixedModels ? (
				<div className="flex items-start gap-1.5 text-[12px] text-text-tertiary">
					<AlertTriangle size={12} className="mt-0.5 shrink-0" />
					<span>mixed provider/model pairs recorded; totals span models and are not comparable across them</span>
				</div>
			) : null}
		</>
	);
}

function UsageCounterRow({
	label,
	total,
	coverage,
	responses,
}: {
	label: string;
	total: number | null;
	coverage: number;
	responses: number;
}): React.ReactElement {
	const reported = Math.round(coverage * responses);
	return (
		<DiagnosticsValue
			label={label}
			value={
				responses === 0
					? "no reported metrics"
					: `${total === null ? "unknown" : total.toLocaleString()} (reported by ${reported}/${responses})`
			}
		/>
	);
}

export function TaskQualitySummarySection({
	workspaceId,
	taskId,
	sessionActive,
}: {
	workspaceId: string | null;
	taskId: string | null;
	/** True when the task has a live session; a loaded snapshot is then historical. */
	sessionActive: boolean;
}): React.ReactElement {
	const { summary, isLoading, isRefreshing, error, load } = useTaskQualitySummary(workspaceId, taskId);
	const [showGaps, setShowGaps] = useState(false);
	const [showEvidence, setShowEvidence] = useState(false);

	const gapCount = summary ? summary.coverage.reasons.length + summary.coverage.warnings.length : 0;

	return (
		<DiagnosticsSection title="Recorded summary">
			<div className="flex items-center gap-2">
				<Button
					variant="ghost"
					size="sm"
					disabled={isLoading}
					icon={<ListTree size={13} />}
					onClick={() => load()}
					aria-label={summary ? "Refresh recorded summary" : "Load recorded summary"}
				>
					{summary ? (isRefreshing ? "Refreshing…" : "Refresh snapshot") : "Load recorded summary"}
				</Button>
				{summary ? <CoverageBadge status={summary.coverage.status} /> : null}
				<span className="min-w-0 flex-1 truncate text-[12px] text-text-tertiary">
					{summary
						? `captured ${formatDiagnosticsTimestamp(summary.capturedAt)} · reducer v${summary.reducerVersion}`
						: isLoading
							? "Analyzing recorded sessions…"
							: "On-demand snapshot of recorded native sessions"}
				</span>
			</div>
			{error ? (
				<div className="flex items-start gap-1.5 rounded-md border border-status-red/40 bg-status-red/10 px-2 py-1.5">
					<AlertTriangle size={13} className="mt-0.5 shrink-0 text-status-red" />
					<span className="min-w-0 text-[12px] break-words text-text-primary">{error}</span>
				</div>
			) : null}
			{summary ? (
				<>
					{sessionActive ? (
						<p className="m-0 text-[11px] leading-snug text-text-tertiary">
							Historical snapshot as of {formatDiagnosticsTimestamp(summary.capturedAt)} — the task has a live
							session, and activity after capture is not included.
						</p>
					) : null}
					{summary.sourceWarning ? (
						<div className="flex items-start gap-1.5 rounded-md border border-status-orange/40 bg-status-orange/10 px-2 py-1.5">
							<AlertTriangle size={13} className="mt-0.5 shrink-0 text-status-orange" />
							<span className="min-w-0 text-[12px] break-words text-text-primary">{summary.sourceWarning}</span>
						</div>
					) : null}
					<DiagnosticsValue
						label="First recorded start"
						value={
							summary.timing.firstRecordedStart === null
								? null
								: formatDiagnosticsTimestamp(summary.timing.firstRecordedStart)
						}
					/>
					<DiagnosticsValue
						label="Last recorded end"
						value={
							summary.timing.lastRecordedEnd === null
								? null
								: formatDiagnosticsTimestamp(summary.timing.lastRecordedEnd)
						}
					/>
					<DiagnosticsValue
						label="Recorded session span"
						value={
							summary.timing.recordedSessionSpanMs === null
								? "unknown"
								: `${formatDiagnosticsDuration(summary.timing.recordedSessionSpanMs)} (recorded, not runtime)`
						}
					/>
					{summary.timing.coveredSegmentCount < summary.timing.totalSegmentCount ? (
						<DiagnosticsValue
							label="Session intervals"
							value={`${summary.timing.coveredSegmentCount}/${summary.timing.totalSegmentCount} closed (open: ${summary.timing.openSegmentCount}, invalid: ${summary.timing.invalidIntervalCount})`}
						/>
					) : null}
					<DiagnosticsValue
						label="Sessions"
						value={`${summary.sessionCounts.working} working · ${summary.sessionCounts.review} review · ${summary.sessionCounts.verificationRepair} repair`}
					/>
					<ModelPairs summary={summary} />
					<DiagnosticsValue
						label="Assistant responses"
						value={`${summary.responses.assistantResponses} (${summary.responses.withReportedMetrics} with reported metrics)`}
					/>
					{summary.responses.peakReportedInput !== null ? (
						<DiagnosticsValue
							label="Peak reported input"
							value={`${summary.responses.peakReportedInput.toLocaleString()} (per response, not a context estimate)`}
						/>
					) : null}
					<UsageCounterRow
						label="Input tokens"
						total={summary.usage.inputTokens.total}
						coverage={summary.usage.inputTokens.coverage}
						responses={summary.responses.assistantResponses}
					/>
					<UsageCounterRow
						label="Output tokens"
						total={summary.usage.outputTokens.total}
						coverage={summary.usage.outputTokens.coverage}
						responses={summary.responses.assistantResponses}
					/>
					<UsageCounterRow
						label="Cache read tokens"
						total={summary.usage.cacheReadTokens.total}
						coverage={summary.usage.cacheReadTokens.coverage}
						responses={summary.responses.assistantResponses}
					/>
					<UsageCounterRow
						label="Cache write tokens"
						total={summary.usage.cacheWriteTokens.total}
						coverage={summary.usage.cacheWriteTokens.coverage}
						responses={summary.responses.assistantResponses}
					/>
					{summary.tools.totalCalls > 0 ? (
						<DiagnosticsValue
							label="Tool calls"
							value={`${summary.tools.totalCalls} (${Object.entries(summary.tools.byName)
								.map(([name, count]) => `${name}×${count}`)
								.join(", ")})`}
						/>
					) : null}
					{summary.tools.reportedFailures > 0 ? (
						<DiagnosticsValue
							label="Reported failures"
							value={`${summary.tools.reportedFailures} (confirmed structural, once per call)`}
						/>
					) : null}
					{summary.tools.unmatchedCalls > 0 ? (
						<DiagnosticsValue
							label="Unmatched calls"
							value={`${summary.tools.unmatchedCalls} (no recorded result)`}
						/>
					) : null}
					{summary.tools.truncatedResults > 0 ? (
						<DiagnosticsValue
							label="Truncated results"
							value={`${summary.tools.truncatedResults} (full output not loaded)`}
						/>
					) : null}
					<DiagnosticsValue
						label="Failed retries"
						value={`${summary.retries.unchangedFailedRetries} unchanged (after prior identical failure)`}
					/>
					{Object.keys(summary.heuristicTags).length > 0 ? (
						<DiagnosticsValue
							label="Heuristic tags"
							value={Object.entries(summary.heuristicTags)
								.map(([rule, count]) => `${rule}×${count}`)
								.join(", ")}
						/>
					) : null}
					{summary.liveTailExcluded ? (
						<div className="flex items-start gap-1.5 text-[12px] text-text-tertiary">
							<AlertTriangle size={12} className="mt-0.5 shrink-0" />
							<span>
								live tail display messages excluded from totals (possible overlap with the durable transcript)
							</span>
						</div>
					) : null}
					{gapCount > 0 ? (
						<div className="space-y-0.5">
							<button
								type="button"
								className="inline-flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary"
								onClick={() => setShowGaps((current) => !current)}
							>
								{showGaps ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
								Coverage reasons ({gapCount})
							</button>
							{showGaps ? (
								<div className="space-y-0.5">
									{[...summary.coverage.reasons, ...summary.coverage.warnings].map((reason, index) => (
										<div key={index} className="flex items-start gap-1.5 text-[12px] text-text-tertiary">
											<AlertTriangle size={12} className="mt-0.5 shrink-0" />
											<span className="min-w-0 break-words">{reason}</span>
										</div>
									))}
								</div>
							) : null}
						</div>
					) : null}
					{summary.evidence.length > 0 ? (
						<div className="space-y-0.5">
							<button
								type="button"
								className="inline-flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary"
								onClick={() => setShowEvidence((current) => !current)}
							>
								{showEvidence ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
								Evidence references ({summary.evidence.length})
							</button>
							{showEvidence ? (
								<ul className="max-h-32 space-y-0.5 overflow-y-auto p-0 m-0 list-none">
									{summary.evidence.map((record, index) => (
										<li key={index} className="truncate font-mono text-[11px] text-text-secondary">
											{record.classification}: {record.toolCallId || "(no id)"} · {record.ruleId}
											{record.resultIsError ? " · is_error" : ""} · msg {record.messageIndex}:
											{record.partIndex} ({record.sessionId})
											{record.priorReference
												? ` · after msg ${record.priorReference.messageIndex}:${record.priorReference.partIndex} in ${record.priorReference.sessionId}`
												: ""}
										</li>
									))}
								</ul>
							) : null}
						</div>
					) : null}
				</>
			) : null}
		</DiagnosticsSection>
	);
}
