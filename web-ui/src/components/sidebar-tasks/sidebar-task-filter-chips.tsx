import type { RuntimeTaskDisplayState } from "@runtime-task-display-state";
import { TASK_DISPLAY_STATE_BADGE_META, TASK_DISPLAY_STATE_ORDER } from "@/components/project-task-count-badges";
import { cn } from "@/components/ui/cn";

interface SidebarTaskFilterChipsProps {
	/** Counts for every display state, computed from the rows currently available. */
	counts: Record<RuntimeTaskDisplayState, number>;
	selectedStates: ReadonlySet<RuntimeTaskDisplayState>;
	onToggle: (state: RuntimeTaskDisplayState) => void;
}

/** Six always-visible state filter chips ("Label · count") for the task list. */
export function SidebarTaskFilterChips({ counts, selectedStates, onToggle }: SidebarTaskFilterChipsProps) {
	return (
		<div className="flex flex-wrap gap-1">
			{TASK_DISPLAY_STATE_ORDER.map((state) => {
				const meta = TASK_DISPLAY_STATE_BADGE_META[state];
				const selected = selectedStates.has(state);
				return (
					<button
						key={state}
						type="button"
						aria-pressed={selected}
						onClick={() => onToggle(state)}
						className={cn(
							"cursor-pointer rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
							selected
								? meta.toneClassName
								: "border border-border text-text-tertiary hover:text-text-secondary",
						)}
					>
						{meta.title} · {counts[state]}
					</button>
				);
			})}
		</div>
	);
}
