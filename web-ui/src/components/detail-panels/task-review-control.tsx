import { ShieldCheck } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { type TaskReviewVerdict, useTaskReview } from "@/hooks/use-task-review";

const VERDICT_STYLES: Record<Exclude<TaskReviewVerdict, null>, { label: string; className: string }> = {
	ready: { label: "Review ready", className: "bg-status-green/15 text-status-green" },
	blocked: { label: "Review blocked", className: "bg-status-orange/15 text-status-orange" },
	failed: { label: "Review failed", className: "bg-status-red/15 text-status-red" },
	stale: { label: "Review stale", className: "bg-surface-3 text-text-secondary" },
};

/** B-6: runs the bounded review for a Review-column task and shows its verdict. */
export function TaskReviewControl({
	workspaceId,
	taskId,
	description,
	taskTitle,
}: {
	workspaceId: string | null;
	taskId: string;
	description: string;
	taskTitle: string | null;
}): ReactElement {
	const { verdict, detail, isRunning, startReview } = useTaskReview({ workspaceId, taskId, description, taskTitle });
	const verdictStyle = verdict ? VERDICT_STYLES[verdict] : null;
	return (
		<div className="flex items-center gap-1">
			{verdictStyle ? (
				<Tooltip content={detail ?? verdictStyle.label}>
					<span className={cn("rounded-sm px-1.5 py-0.5 text-xs", verdictStyle.className)}>
						{verdictStyle.label}
					</span>
				</Tooltip>
			) : null}
			<Button
				variant="ghost"
				size="sm"
				className="h-5"
				icon={isRunning ? <Spinner size={12} /> : <ShieldCheck size={14} />}
				disabled={isRunning || workspaceId === null}
				onClick={startReview}
				aria-label="Run review"
			>
				{isRunning ? "Reviewing…" : "Review"}
			</Button>
		</div>
	);
}
