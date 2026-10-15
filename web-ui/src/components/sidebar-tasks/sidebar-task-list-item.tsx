import { TASK_DISPLAY_STATE_BADGE_META } from "@/components/project-task-count-badges";
import { cn } from "@/components/ui/cn";
import type { RuntimeProjectTaskListItem } from "@/runtime/types";
import { formatApproximateAge } from "@/utils/format-approximate-age";

interface SidebarTaskListItemProps {
	item: RuntimeProjectTaskListItem;
	now: number;
	onSelect: (item: RuntimeProjectTaskListItem) => void;
}

/** One row in the sidebar task list: title, state pill, project name, last activity. */
export function SidebarTaskListItem({ item, now, onSelect }: SidebarTaskListItemProps) {
	const meta = TASK_DISPLAY_STATE_BADGE_META[item.displayState];
	return (
		<button
			type="button"
			onClick={() => onSelect(item)}
			className="w-full cursor-pointer rounded-md px-2 py-1.5 text-left"
		>
			<span className="kb-line-clamp-2 block text-sm font-medium text-text-primary">{item.title}</span>
			<span className="mt-1 flex items-center gap-1.5">
				<span
					className={cn(
						"shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium leading-4",
						meta.toneClassName,
					)}
					title={meta.title}
				>
					{meta.shortLabel}
				</span>
				<span className="min-w-0 flex-1 truncate text-[11px] text-text-secondary">{item.projectName}</span>
				<span className="shrink-0 text-[11px] text-text-tertiary">
					{formatApproximateAge(item.lastActivityAt, now)}
				</span>
			</span>
		</button>
	);
}
