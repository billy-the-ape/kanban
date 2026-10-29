// AR-7: expandable recorded evidence lists in the quality-summary section.
// Edit-recovery episodes (a confirmed failed editor call plus the next
// successful edit of the same recorded file, or an explicit unresolved end)
// and AR-3 validation-job observations. All values are recorded facts with
// wall-clock time labels — never reasoning time, savings, or a task score.
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import type { RuntimeTaskQualitySummaryResponse } from "@/runtime/types";
import { formatDiagnosticsDuration, formatDiagnosticsTimestamp } from "@/utils/task-diagnostics-summary";

type EditEpisode = RuntimeTaskQualitySummaryResponse["editEpisodes"]["items"][number];

/** Human labels that say what was observed, not what is inferred. */
const EPISODE_END_LABELS: Record<EditEpisode["end"], string> = {
	next_successful_edit: "next successful edit on this file",
	no_successful_edit_before_next_failure: "no successful edit before the next failure",
	no_successful_edit_recorded: "no successful edit recorded after the failure",
	file_path_unknown: "file path not recorded (unmatchable)",
};

function episodeReferenceText(episode: EditEpisode): string {
	const failure = episode.failureReference;
	const next = episode.nextSuccessReference;
	return `after msg ${failure.messageIndex}:${failure.partIndex} in ${failure.sessionId} (call ${failure.toolCallId || "(no id)"}${
		next ? ` · next success msg ${next.messageIndex}:${next.partIndex} in ${next.sessionId}` : ""
	})`;
}

function EpisodeItem({ episode }: { episode: EditEpisode }): React.ReactElement {
	const elapsed =
		episode.elapsedMs !== null
			? `${formatDiagnosticsDuration(episode.elapsedMs)} (wall-clock, includes intervening work and waits)`
			: "unknown (recorded timestamps missing or inconsistent)";
	return (
		<li className="space-y-0.5 py-0.5">
			<div className="text-[12px] text-text-primary">
				{episode.failureRule} · {episode.file ?? "unknown file"} · {EPISODE_END_LABELS[episode.end]}
			</div>
			<div className="text-[11px] text-text-tertiary">
				{episode.attemptsBetween} same-file edit attempt{episode.attemptsBetween === 1 ? "" : "s"} ·{" "}
				{episode.readsBetween} read{episode.readsBetween === 1 ? "" : "s"} between · {elapsed}
			</div>
			<div className="truncate font-mono text-[11px] text-text-secondary" title={episodeReferenceText(episode)}>
				{episodeReferenceText(episode)}
			</div>
			{episode.timestampWarning ? (
				<div className="text-[11px] text-status-orange">timestamp warning: interval may be unreliable</div>
			) : null}
		</li>
	);
}

export function EditEpisodeList({
	summary,
}: {
	summary: RuntimeTaskQualitySummaryResponse;
}): React.ReactElement | null {
	const [expanded, setExpanded] = useState(false);
	if (summary.editEpisodes.total === 0) {
		return null;
	}
	return (
		<div className="space-y-0.5">
			<button
				type="button"
				className="inline-flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary"
				onClick={() => setExpanded((current) => !current)}
			>
				{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				Edit-recovery episodes ({summary.editEpisodes.total}
				{summary.editEpisodes.omitted > 0 ? `, ${summary.editEpisodes.omitted} more not listed` : ""})
			</button>
			{expanded ? (
				<ul className="max-h-48 space-y-0.5 overflow-y-auto border-l border-border pl-2 m-0 list-none">
					{summary.editEpisodes.items.map((episode, index) => (
						<EpisodeItem
							key={`${episode.failureReference.sessionId}-${episode.failureReference.messageIndex}-${index}`}
							episode={episode}
						/>
					))}
				</ul>
			) : null}
		</div>
	);
}

const JOB_OUTCOME_CLASS: Record<
	RuntimeTaskQualitySummaryResponse["validationJobs"]["items"][number]["outcome"],
	string
> = {
	started: "text-status-blue",
	completed: "text-status-green",
	failed: "text-status-red",
	timeout: "text-status-orange",
	cancelled: "text-status-tertiary",
	interrupted: "text-status-tertiary",
};

export function ValidationJobList({
	summary,
}: {
	summary: RuntimeTaskQualitySummaryResponse;
}): React.ReactElement | null {
	const [expanded, setExpanded] = useState(false);
	if (summary.validationJobs.total === 0) {
		return null;
	}
	return (
		<div className="space-y-0.5">
			<button
				type="button"
				className="inline-flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary"
				onClick={() => setExpanded((current) => !current)}
			>
				{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				Validation jobs ({summary.validationJobs.total})
			</button>
			{expanded ? (
				<ul className="max-h-32 space-y-0.5 overflow-y-auto p-0 m-0 list-none">
					{summary.validationJobs.items.map((job) => (
						<li key={job.jobId} className="truncate text-[11px] text-text-secondary" title={job.command}>
							<span className={JOB_OUTCOME_CLASS[job.outcome]}>{job.outcome}</span>: {job.command}
							{job.exitCode !== null ? ` · exit ${job.exitCode}` : ""} · started{" "}
							{formatDiagnosticsTimestamp(new Date(job.startedAt).getTime())}
							{job.logReference
								? ` · log ${job.logReference}${job.logTruncated ? " (truncated)" : ""}`
								: " · no retained log"}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
