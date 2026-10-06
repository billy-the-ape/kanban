import { GitPullRequest } from "lucide-react";
import type { MouseEvent } from "react";

import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskPullRequest } from "@/runtime/types";
import { formatPullRequestLabel, getPullRequestTooltipLines } from "@/utils/task-pull-requests";

/**
 * Inline anchor to a task's pull request. Stops mouse-event propagation so
 * board-card drag/selection and top-bar branch-history toggles never fire.
 */
export function TaskPullRequestLink({
	pullRequest,
	variant,
	className,
}: {
	pullRequest: RuntimeTaskPullRequest;
	variant: "full" | "compact";
	className?: string;
}): React.ReactElement {
	const stateTint =
		pullRequest.state === "merged"
			? "text-status-purple"
			: pullRequest.state === "closed"
				? "text-status-red"
				: "text-accent";
	const handleStopPropagation = (event: MouseEvent<HTMLAnchorElement>) => {
		event.stopPropagation();
	};

	return (
		<Tooltip
			content={getPullRequestTooltipLines(pullRequest).map((line, index) => (
				<div key={index} className="whitespace-nowrap">
					{line}
				</div>
			))}
		>
			<a
				href={pullRequest.url}
				target="_blank"
				rel="noopener noreferrer"
				onMouseDown={handleStopPropagation}
				onClick={handleStopPropagation}
				className={cn(
					"inline-flex shrink-0 items-center gap-1 font-mono text-xs hover:text-accent-hover hover:underline",
					stateTint,
					className,
				)}
			>
				{variant === "full" ? <GitPullRequest size={12} className="shrink-0" /> : null}
				<span>{formatPullRequestLabel(pullRequest, variant)}</span>
			</a>
		</Tooltip>
	);
}
