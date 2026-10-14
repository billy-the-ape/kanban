// Shared per-state task count badge definitions used in project navigation.

import type { RuntimeTaskDisplayState } from "@runtime-task-display-state";
import type { RuntimeProjectTaskCounts } from "@/runtime/types";

export const TASK_DISPLAY_STATE_ORDER: readonly RuntimeTaskDisplayState[] = [
	"backlog",
	"in_progress",
	"paused",
	"review",
	"done",
	"trash",
];

export const TASK_DISPLAY_STATE_BADGE_META: Record<
	RuntimeTaskDisplayState,
	{ title: string; shortLabel: string; toneClassName: string }
> = {
	backlog: { title: "Backlog", shortLabel: "B", toneClassName: "bg-text-primary/15 text-text-primary" },
	in_progress: { title: "In Progress", shortLabel: "IP", toneClassName: "bg-accent/20 text-accent" },
	paused: { title: "Paused", shortLabel: "P", toneClassName: "bg-status-gold/20 text-status-gold" },
	review: { title: "Review", shortLabel: "R", toneClassName: "bg-accent-2/20 text-accent-2" },
	done: { title: "Done", shortLabel: "D", toneClassName: "bg-status-green/20 text-status-green" },
	trash: { title: "Trash", shortLabel: "T", toneClassName: "bg-status-red/20 text-status-red" },
};

export interface TaskCountBadge {
	id: string;
	title: string;
	shortLabel: string;
	toneClassName: string;
	count: number;
}

export function buildProjectTaskCountBadges(counts: RuntimeProjectTaskCounts): TaskCountBadge[] {
	return TASK_DISPLAY_STATE_ORDER.map((state) => ({
		id: state,
		title: TASK_DISPLAY_STATE_BADGE_META[state].title,
		shortLabel: TASK_DISPLAY_STATE_BADGE_META[state].shortLabel,
		toneClassName: TASK_DISPLAY_STATE_BADGE_META[state].toneClassName,
		count: counts[state],
	})).filter((badge) => badge.count > 0);
}
