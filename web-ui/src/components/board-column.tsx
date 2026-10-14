import { Droppable } from "@hello-pangea/dnd";
import { FoldHorizontal, Play, Plus, Trash2, UnfoldHorizontal } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useLocalStorage } from "react-use";
import { BoardCard } from "@/components/board-card";
import { Button } from "@/components/ui/button";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { RuntimeTaskInitialStartStage, RuntimeTaskPhaseSummary, RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	canReturnQueuedTaskToBacklog,
	isCardDropDisabled,
	isTaskSessionRunning,
	type ProgrammaticCardMoveInFlight,
} from "@/state/drag-rules";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardCard as BoardCardModel, BoardColumnId, BoardColumn as BoardColumnModel } from "@/types";
import { cn } from "./ui/cn";
import { Tooltip } from "./ui/tooltip";

export function BoardColumn({
	column,
	taskSessions,
	onCreateTask,
	onStartTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	onSaveTitle,
	onCommitTask,
	onOpenPrTask,
	onCancelAutomaticTaskAction,
	onMoveToTrashTask,
	onCompleteTask,
	onRestoreFromTrashTask,
	commitTaskLoadingById,
	openPrTaskLoadingById,
	moveToTrashLoadingById,
	completeTaskLoadingById,
	cleanupBlockedReasonByTaskId,
	onCardClick,
	activeDragTaskId,
	activeDragSourceColumnId,
	programmaticCardMoveInFlight,
	onDependencyPointerDown,
	onDependencyPointerEnter,
	dependencySourceTaskId,
	dependencyTargetTaskId,
	isDependencyLinking,
	workspacePath,
	defaultClineModelId,
	taskPhases,
	initialStartStageByTaskId,
}: {
	column: BoardColumnModel;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCreateTask?: () => void;
	onStartTask?: (taskId: string) => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCardModel) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onCompleteTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	completeTaskLoadingById?: Record<string, boolean>;
	cleanupBlockedReasonByTaskId?: Record<string, string>;
	onCardClick?: (card: BoardCardModel) => void;
	activeDragTaskId?: string | null;
	activeDragSourceColumnId?: BoardColumnId | null;
	programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
	onDependencyPointerDown?: (taskId: string, event: ReactMouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	dependencySourceTaskId?: string | null;
	dependencyTargetTaskId?: string | null;
	isDependencyLinking?: boolean;
	workspacePath?: string | null;
	defaultClineModelId?: string | null;
	/** B-10.1: reliable-completion phase summaries for the board chips. */
	taskPhases?: Record<string, RuntimeTaskPhaseSummary>;
	/** UPD-1.3: live initial-start preparation stages per task while a start is in flight. */
	initialStartStageByTaskId?: Record<string, RuntimeTaskInitialStartStage>;
}): React.ReactElement {
	const isMobile = useIsMobile();
	const canCreate = column.id === "backlog" && onCreateTask;
	const canStartAllTasks = column.id === "backlog" && onStartAllTasks;
	const canClearTrash = column.id === "trash" && onClearTrash;
	const cardDropType = "CARD";
	const isDropDisabled = isCardDropDisabled(column.id, activeDragSourceColumnId ?? null, {
		activeDragTaskId,
		canReturnActiveDragTaskToBacklog: activeDragTaskId
			? canReturnQueuedTaskToBacklog(taskSessions[activeDragTaskId])
			: false,
		programmaticCardMoveInFlight,
		isActiveDragTaskSessionRunning: activeDragTaskId
			? isTaskSessionRunning(taskSessions[activeDragTaskId])
			: undefined,
	});
	const createTaskButtonText = (
		<span className="inline-flex items-center gap-1.5">
			<span>Create task</span>
			<span aria-hidden className="text-text-secondary">
				(c)
			</span>
		</span>
	);

	const [isCollapsed, setIsCollapsed] = useLocalStorage(
		LocalStorageKey.BoardColumnCollapsed.replace("{project}", workspacePath || "unknown").replace(
			"{columnid}",
			column.id,
		),
		false,
		{
			raw: false,
			serializer(val) {
				return String(val);
			},
			deserializer(val) {
				return val === "true";
			},
		},
	);

	return (
		<section
			data-column-id={column.id}
			className={cn(
				"flex flex-col min-w-0 min-h-0 bg-surface-1 rounded-lg overflow-hidden border border-border",
				isCollapsed && "max-w-10",
			)}
			style={{
				flex: "1 1 0",
			}}
		>
			<div className="flex flex-col min-h-0" style={{ flex: "1 1 0" }}>
				<Tooltip content={isCollapsed ? `${column.title} - ${column.cards.length} cards` : null}>
					<div
						className={cn(
							"flex items-center justify-between gap-2",
							isCollapsed ? "flex-col-reverse pt-3.5" : "h-10 px-3",
						)}
					>
						<div className={cn("flex items-center gap-2", isCollapsed && "flex-col")}>
							<ColumnIndicator columnId={column.id} />
							{!isCollapsed && <span className="font-semibold text-sm">{column.title}</span>}
							<span className="text-text-secondary text-xs">{column.cards.length}</span>
						</div>
						<div className="flex">
							{canStartAllTasks && !isCollapsed ? (
								<Button
									icon={<Play size={14} />}
									variant="ghost"
									size="sm"
									onClick={onStartAllTasks}
									disabled={column.cards.length === 0}
									aria-label="Start all backlog tasks"
									title={column.cards.length > 0 ? "Start all backlog tasks" : "Backlog is empty"}
								/>
							) : null}
							{canClearTrash && !isCollapsed ? (
								<Button
									icon={<Trash2 size={14} />}
									variant="ghost"
									size="sm"
									className="text-status-red hover:text-status-red"
									onClick={onClearTrash}
									disabled={column.cards.length === 0}
									aria-label="Clear trash"
									title={column.cards.length > 0 ? "Clear trash items permanently" : "Trash is empty"}
								/>
							) : null}

							{!isMobile && (
								<Tooltip content={isCollapsed ? null : `Collapse ${column.title}`}>
									<button
										type="button"
										className="cursor-pointer"
										onClick={() => setIsCollapsed(!isCollapsed)}
									>
										{!isCollapsed ? <FoldHorizontal size={12} /> : <UnfoldHorizontal size={12} />}
									</button>
								</Tooltip>
							)}
						</div>
					</div>
				</Tooltip>
				{!isCollapsed && (
					<Droppable droppableId={column.id} type={cardDropType} isDropDisabled={isDropDisabled}>
						{(cardProvided) => (
							<div ref={cardProvided.innerRef} {...cardProvided.droppableProps} className="kb-column-cards">
								{canCreate ? (
									<Button
										icon={<Plus size={14} />}
										aria-label="Create task"
										fill
										onClick={onCreateTask}
										style={{ marginBottom: 6, flexShrink: 0 }}
									>
										{createTaskButtonText}
									</Button>
								) : null}

								{(() => {
									const items: ReactNode[] = [];
									let draggableIndex = 0;
									for (const card of column.cards) {
										if (column.id === "backlog" && editingTaskId === card.id) {
											items.push(
												<div
													key={card.id}
													data-task-id={card.id}
													data-column-id={column.id}
													style={{ marginBottom: 6 }}
												>
													{inlineTaskEditor}
												</div>,
											);
											continue;
										}
										items.push(
											<BoardCard
												key={card.id}
												card={card}
												index={draggableIndex}
												columnId={column.id}
												sessionSummary={taskSessions[card.id]}
												phaseSummary={taskPhases?.[card.id]}
												initialStartStage={initialStartStageByTaskId?.[card.id]}
												onStart={onStartTask}
												onMoveToTrash={onMoveToTrashTask}
												onComplete={onCompleteTask}
												onRestoreFromTrash={onRestoreFromTrashTask}
												onCommit={onCommitTask}
												onOpenPr={onOpenPrTask}
												onCancelAutomaticAction={onCancelAutomaticTaskAction}
												isCommitLoading={commitTaskLoadingById?.[card.id] ?? false}
												isOpenPrLoading={openPrTaskLoadingById?.[card.id] ?? false}
												isMoveToTrashLoading={moveToTrashLoadingById?.[card.id] ?? false}
												isCompleteLoading={completeTaskLoadingById?.[card.id] ?? false}
												cleanupBlockedReason={cleanupBlockedReasonByTaskId?.[card.id] ?? null}
												onDependencyPointerDown={onDependencyPointerDown}
												onDependencyPointerEnter={onDependencyPointerEnter}
												isDependencySource={dependencySourceTaskId === card.id}
												isDependencyTarget={dependencyTargetTaskId === card.id}
												isDependencyLinking={isDependencyLinking}
												workspacePath={workspacePath}
												defaultClineModelId={defaultClineModelId}
												onSaveTitle={onSaveTitle}
												onClick={() => {
													if (column.id === "backlog") {
														onEditTask?.(card);
														return;
													}
													onCardClick?.(card);
												}}
											/>,
										);
										draggableIndex += 1;
									}
									return items;
								})()}
								{cardProvided.placeholder}
							</div>
						)}
					</Droppable>
				)}
			</div>
		</section>
	);
}
