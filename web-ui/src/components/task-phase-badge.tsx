// B-10.1: compact reliable-completion phase chip for board cards and the
// task detail view. `idle` renders nothing (an untouched task has no phase);
// `needs_attention` renders in red with the blocked reason as a tooltip.
import { AlertTriangle } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskPhase, RuntimeTaskPhaseSummary } from "@/runtime/types";
import type { BoardColumnId } from "@/types";

const PHASE_LABELS: Record<RuntimeTaskPhase, string> = {
	idle: "idle",
	implementing: "impl",
	reviewing: "rev",
	checking: "chec",
	committing: "comm",
	integrating: "inte",
	pushing: "push",
	verifying_remote: "verif",
	done: "done",
	needs_attention: "atten",
};

const PHASE_DESCRIPTIONS: Record<RuntimeTaskPhase, string> = {
	idle: "No active phase",
	implementing: "Agent is implementing",
	reviewing: "Review is ready",
	checking: "Checking delivery",
	committing: "Committing changes",
	integrating: "Integrating changes",
	pushing: "Pushing changes",
	verifying_remote: "Verifying remote delivery",
	done: "Delivery complete",
	needs_attention: "Needs attention",
};

const PHASE_CLASSES: Record<RuntimeTaskPhase, string> = {
	idle: "bg-surface-3 text-text-secondary",
	implementing: "bg-surface-3 text-status-blue",
	reviewing: "bg-surface-3 text-status-purple",
	checking: "bg-surface-3 text-status-purple",
	committing: "bg-surface-3 text-status-orange",
	integrating: "bg-surface-3 text-status-orange",
	pushing: "bg-surface-3 text-status-orange",
	verifying_remote: "bg-surface-3 text-status-orange",
	done: "bg-surface-3 text-status-green",
	needs_attention: "bg-surface-3 text-status-red",
};

export function TaskPhaseBadge({
	summary,
	queuePosition,
	columnId,
	className,
}: {
	summary: RuntimeTaskPhaseSummary | null | undefined;
	queuePosition?: number | null;
	columnId?: BoardColumnId;
	className?: string;
}): React.ReactElement | null {
	if (!summary || (summary.phase === "idle" && !queuePosition)) {
		return null;
	}
	// A stale session or durable record can outlive the card's active phase.
	// Only show transient progress where that work can actually be happening.
	if (columnId && summary.phase === "implementing" && columnId !== "in_progress") {
		return null;
	}
	if (columnId === "done" && summary.phase !== "done" && summary.phase !== "needs_attention") {
		return null;
	}
	const needsAttention = summary.needsAttention || summary.phase === "needs_attention";
	const queued = !needsAttention && (!columnId || columnId === "in_progress") && !!queuePosition;
	const description = queued
		? `Waiting for model capacity: queue position ${queuePosition}`
		: PHASE_DESCRIPTIONS[summary.phase];
	const badge = (
		<span
			role="img"
			aria-label={
				needsAttention
					? `Needs attention: ${summary.blockedReason ?? "check diagnostics"}`
					: queued
						? description
						: summary.phase
			}
			className={cn(
				"inline-flex max-w-full items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] leading-none font-medium",
				queued ? "bg-surface-3 text-status-orange" : PHASE_CLASSES[summary.phase],
				className,
			)}
		>
			{needsAttention ? <AlertTriangle size={11} className="shrink-0" /> : null}
			<span className="truncate">{queued ? `q #${queuePosition}` : PHASE_LABELS[summary.phase]}</span>
		</span>
	);
	return (
		<Tooltip content={needsAttention && summary.blockedReason ? summary.blockedReason : description}>{badge}</Tooltip>
	);
}
