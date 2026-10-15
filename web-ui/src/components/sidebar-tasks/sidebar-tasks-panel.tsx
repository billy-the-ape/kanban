import type { RuntimeTaskDisplayState } from "@runtime-task-display-state";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useSidebarTasksFilter } from "@/hooks/use-sidebar-tasks-filter";
import type { RuntimeProjectTaskListItem } from "@/runtime/types";
import { useInterval } from "@/utils/react-use";
import { SidebarTaskFilterChips } from "./sidebar-task-filter-chips";
import { SidebarTaskListItem } from "./sidebar-task-list-item";

const PARTIAL_FAILURE_MESSAGE = "Some projects couldn't be loaded.";
const NO_FILTER_SELECTED_MESSAGE = "Select a state to show tasks.";
const NO_MATCHING_TASKS_MESSAGE = "No matching tasks.";
const FIRST_LOAD_SKELETON_ROW_COUNT = 3;
const AGE_TICKER_INTERVAL_MS = 60_000;

interface SidebarTasksPanelProps {
	tasks: RuntimeProjectTaskListItem[] | null;
	isLoading: boolean;
	error: string | null;
	unavailableProjectIds: string[];
	/** Whether the panel is visible; the age ticker stops while hidden. */
	isVisible: boolean;
	onRetry: () => void;
	onSelectTask: (item: RuntimeProjectTaskListItem) => void;
}

function FirstLoadSkeleton() {
	return (
		<div className="flex flex-col gap-1 px-3 py-1">
			{Array.from({ length: FIRST_LOAD_SKELETON_ROW_COUNT }, (_, index) => (
				<div key={index} className="rounded-md px-2 py-1.5">
					<div className="kb-skeleton mb-1.5" style={{ width: "70%", height: 14 }} />
					<div className="flex items-center gap-1.5">
						<div className="kb-skeleton" style={{ width: 28, height: 14, borderRadius: 999 }} />
						<div className="kb-skeleton" style={{ width: "40%", height: 12 }} />
						<div className="kb-skeleton" style={{ width: 44, height: 12 }} />
					</div>
				</div>
			))}
		</div>
	);
}

function PanelMessage({ text }: { text: string }) {
	return <div className="px-2 py-3 text-xs text-text-secondary">{text}</div>;
}

function RetryRow({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="flex items-center gap-2 px-3 py-2">
			<Button variant="ghost" size="sm" onClick={onRetry}>
				Retry
			</Button>
		</div>
	);
}

/**
 * Cross-project task list for the sidebar Tasks tab: state filter chips on
 * top, then the fully-ordered rows (server data plus the open project's live
 * local rows).
 */
export function SidebarTasksPanel({
	tasks,
	isLoading,
	error,
	unavailableProjectIds,
	isVisible,
	onRetry,
	onSelectTask,
}: SidebarTasksPanelProps) {
	const { selectedStates, toggleState } = useSidebarTasksFilter();
	const [now, setNow] = useState(() => Date.now());
	useInterval(() => setNow(Date.now()), isVisible ? AGE_TICKER_INTERVAL_MS : null);

	const counts = useMemo(() => {
		const base: Record<RuntimeTaskDisplayState, number> = {
			backlog: 0,
			in_progress: 0,
			paused: 0,
			review: 0,
			done: 0,
			trash: 0,
		};
		for (const task of tasks ?? []) {
			base[task.displayState] += 1;
		}
		return base;
	}, [tasks]);

	const visibleTasks = useMemo(
		() => (tasks ?? []).filter((task) => selectedStates.has(task.displayState)),
		[selectedStates, tasks],
	);

	if (tasks === null && !error) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="shrink-0 px-3 pb-2 pt-1">
					<SidebarTaskFilterChips counts={counts} selectedStates={selectedStates} onToggle={toggleState} />
				</div>
				{isLoading ? <FirstLoadSkeleton /> : null}
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 px-3 pb-2 pt-1">
				<SidebarTaskFilterChips counts={counts} selectedStates={selectedStates} onToggle={toggleState} />
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-3 py-1">
				{error ? (
					<>
						<PanelMessage text={error} />
						<RetryRow onRetry={onRetry} />
					</>
				) : null}
				{!error && unavailableProjectIds.length > 0 ? (
					<>
						<PanelMessage text={PARTIAL_FAILURE_MESSAGE} />
						<RetryRow onRetry={onRetry} />
					</>
				) : null}
				{!error && tasks !== null && selectedStates.size === 0 ? (
					<PanelMessage text={NO_FILTER_SELECTED_MESSAGE} />
				) : null}
				{!error && tasks !== null && selectedStates.size > 0 && visibleTasks.length === 0 ? (
					<PanelMessage text={NO_MATCHING_TASKS_MESSAGE} />
				) : null}
				{visibleTasks.map((task) => (
					<SidebarTaskListItem
						key={`${task.projectId}:${task.taskId}`}
						item={task}
						now={now}
						onSelect={onSelectTask}
					/>
				))}
			</div>
		</div>
	);
}
