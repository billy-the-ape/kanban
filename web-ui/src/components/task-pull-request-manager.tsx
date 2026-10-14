// PRLINK-5/6/7/9/10: manual PR link management for a task. URL input, the
// recorded list with Add/Remove/display-primary/refresh actions. The
// mutation orchestration (pending state per action/identity, task-scoped
// staleness guards, toasts) lives in useTaskPullRequestActions and is shared
// with the task-detail PRs view; this component only owns the presentation
// (the trigger, the compact rows, and the open state) so desktop (top bar)
// and mobile (detail tab bar) share one manager.

import * as RadixPopover from "@radix-ui/react-popover";
import { getOrderedTaskPullRequests } from "@runtime-pull-request-links";
import { Link, Plus, RefreshCw, Star, StarOff, X } from "lucide-react";
import { type ReactNode, useState } from "react";

import { TaskPrCommentHandlingPanel } from "@/components/task-pr-comment-handling-panel";
import { TaskPullRequestLink } from "@/components/task-pull-request-link";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { CLEAR_PRIMARY_PENDING_KEY, useTaskPullRequestActions } from "@/hooks/use-task-pull-request-actions";
import type { RuntimeTaskPullRequest } from "@/runtime/types";
import { formatPullRequestLabel, getPullRequestKey, validatePullRequestUrlShape } from "@/utils/task-pull-requests";

const MAKE_PRIMARY_TOOLTIP =
	"Make primary for display. The Automation PR is selected separately in PR tracking settings.";
const CLEAR_PRIMARY_TOOLTIP = "Use automatic display order";
const REFRESH_LINKED_TOOLTIP =
	"Refresh this pull request's state and title from the provider. Works even when the task is done or the link came from another branch.";

interface TaskPullRequestManagerPopoverProps {
	trigger: ReactNode;
	workspaceId: string;
	taskId: string;
	pullRequests: RuntimeTaskPullRequest[];
	/**
	 * PRLINK-7: mobile presentation — 44px touch targets, a scrollable
	 * viewport-bounded list, and visible repository/state information in
	 * each row so nothing depends on a hover tooltip.
	 */
	mobile?: boolean;
	/** PRLINK-7: controlled open state; the popover is uncontrolled when omitted. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

/**
 * PRLINK-5/6: manual PR link management for a task. URL input, the recorded
 * list with Add/Remove/display-primary actions, and the opt-in refresh.
 * Server responses are authoritative; board state refreshes via the
 * runtime's state broadcast. The trigger and open state are configurable
 * so desktop (top bar) and mobile (detail tab bar) share one manager
 * without duplicating mutation logic.
 */
export function TaskPullRequestManagerPopover({
	trigger,
	workspaceId,
	taskId,
	pullRequests,
	mobile = false,
	open,
	onOpenChange,
}: TaskPullRequestManagerPopoverProps) {
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const [url, setUrl] = useState("");
	const actions = useTaskPullRequestActions({ workspaceId, taskId, pullRequests });
	const isOpen = open ?? uncontrolledOpen;
	const validationError = url.trim() ? validatePullRequestUrlShape(url) : null;
	const canSubmit = validationError === null && !actions.adding;
	// PRLINK-6: display order — the primary winner first, the rest in recorded order.
	const orderedPullRequests = getOrderedTaskPullRequests(pullRequests);
	const winnerPullRequest = orderedPullRequests[0];
	const actionButtonClass = mobile ? "min-h-11 min-w-11 shrink-0 p-0" : "h-6 w-6 shrink-0 px-0";

	const handleOpenChange = (nextOpen: boolean): void => {
		if (actions.adding) {
			return;
		}
		if (open === undefined) {
			setUncontrolledOpen(nextOpen);
		}
		onOpenChange?.(nextOpen);
	};

	// PRLINK-10: the add mutation is orchestrated by the shared hook; the
	// popover only owns the URL text and the open state.
	const handleAdd = async (): Promise<void> => {
		if (!canSubmit) {
			return;
		}
		const added = await actions.addPullRequest(url.trim());
		if (added) {
			setUrl("");
			// Close optimistically; the authoritative entry arrives via the broadcast.
			handleOpenChange(false);
		}
	};

	return (
		<RadixPopover.Root open={isOpen} onOpenChange={handleOpenChange}>
			<RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="start"
					sideOffset={4}
					className={cn(
						"z-50 flex w-72 flex-col gap-2 rounded-md border border-border bg-surface-2 p-2 shadow-lg outline-none",
						mobile && "max-h-[60vh]",
					)}
					style={{ animation: "kb-tooltip-show 100ms ease" }}
				>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void handleAdd();
						}}
						className="flex flex-col gap-1.5"
					>
						<input
							value={url}
							onChange={(event) => {
								setUrl(event.target.value);
								actions.clearAddError();
							}}
							placeholder="https://github.com/owner/repo/pull/123"
							aria-label="Pull request URL"
							data-testid="task-pr-url-input"
							className="h-8 w-full rounded-md border border-border bg-surface-0 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus-visible:outline-2 focus-visible:outline-accent"
						/>
						{validationError ? (
							<p className="m-0 text-[11px] text-status-red" data-testid="task-pr-url-validation-error">
								{validationError}
							</p>
						) : null}
						{actions.addError ? (
							<p className="m-0 text-[11px] text-status-red" data-testid="task-pr-form-error">
								{actions.addError}
							</p>
						) : null}
						<Button
							variant="primary"
							size="sm"
							type="submit"
							icon={actions.adding ? <Spinner size={10} /> : <Plus size={12} />}
							disabled={!canSubmit}
							data-testid="task-pr-add-button"
						>
							Add
						</Button>
					</form>
					<div className="h-px bg-border" />
					<div
						className={cn("flex min-h-0 flex-col gap-1", mobile && "overflow-y-auto")}
						data-testid="task-pr-list"
					>
						{orderedPullRequests.length === 0 ? (
							<p className="m-0 text-xs text-text-tertiary">No pull requests linked yet.</p>
						) : (
							orderedPullRequests.map((pullRequest) => {
								const key = getPullRequestKey(pullRequest);
								const isRemoving = actions.removingKey === key;
								const isWinner = winnerPullRequest !== undefined && pullRequest === winnerPullRequest;
								const isExplicitPrimary = isWinner && pullRequest.isPrimary === true;
								const isPrimaryPending = actions.primaryPendingKey === key;
								const isClearPrimaryPending = actions.primaryPendingKey === CLEAR_PRIMARY_PENDING_KEY;
								const isRefreshingLinked = actions.refreshingKey === key;
								// PRLINK-7: on mobile the repository, state, and winner label are
								// visible in the row instead of living in a hover tooltip.
								const rowMetaParts = [pullRequest.repository, pullRequest.state ?? "state unknown"];
								if (isWinner) {
									rowMetaParts.push(isExplicitPrimary ? "primary for display" : "shown by default");
								}
								return (
									<div key={key} className="flex min-w-0 items-center gap-1.5">
										<div className="min-w-0 flex-1">
											<TaskPullRequestLink
												pullRequest={pullRequest}
												variant="full"
												className="min-w-0 max-w-full"
											/>
											{mobile ? (
												<span
													className="block truncate text-[10px] text-text-tertiary"
													data-testid={`task-pr-row-meta-${pullRequest.number}`}
												>
													{rowMetaParts.join(" · ")}
												</span>
											) : null}
										</div>
										{isWinner && !mobile ? (
											<span
												className="shrink-0 text-[10px] text-text-tertiary"
												data-testid={
													isExplicitPrimary ? "task-pr-primary-label" : "task-pr-default-primary-label"
												}
											>
												{isExplicitPrimary ? "Primary for display" : "Shown by default"}
											</span>
										) : null}
										{isWinner && isExplicitPrimary ? (
											<Tooltip content={CLEAR_PRIMARY_TOOLTIP}>
												<Button
													variant="ghost"
													size="sm"
													aria-label={CLEAR_PRIMARY_TOOLTIP}
													icon={isClearPrimaryPending ? <Spinner size={10} /> : <StarOff size={12} />}
													disabled={isClearPrimaryPending}
													onClick={() => void actions.clearPrimary()}
													className={actionButtonClass}
													data-testid="task-pr-use-automatic-order"
												/>
											</Tooltip>
										) : (
											<Tooltip content={MAKE_PRIMARY_TOOLTIP}>
												<Button
													variant="ghost"
													size="sm"
													aria-label="Make primary for display"
													icon={isPrimaryPending ? <Spinner size={10} /> : <Star size={12} />}
													disabled={isPrimaryPending}
													onClick={() => void actions.makePrimary(pullRequest)}
													className={actionButtonClass}
													data-testid={`task-pr-make-primary-${pullRequest.number}`}
												/>
											</Tooltip>
										)}
										{!mobile ? (
											<Tooltip content={REFRESH_LINKED_TOOLTIP}>
												<Button
													variant="ghost"
													size="sm"
													aria-label={REFRESH_LINKED_TOOLTIP}
													icon={isRefreshingLinked ? <Spinner size={10} /> : <RefreshCw size={12} />}
													disabled={isRefreshingLinked || actions.refreshAllPending}
													onClick={() => void actions.refreshEntry(pullRequest)}
													className={actionButtonClass}
													data-testid={`task-pr-refresh-linked-${pullRequest.number}`}
												/>
											</Tooltip>
										) : (
											<Button
												variant="ghost"
												size="sm"
												aria-label={`Refresh ${formatPullRequestLabel(pullRequest, "full")}`}
												icon={isRefreshingLinked ? <Spinner size={10} /> : <RefreshCw size={12} />}
												disabled={isRefreshingLinked || actions.refreshAllPending}
												onClick={() => void actions.refreshEntry(pullRequest)}
												className={actionButtonClass}
												data-testid={`task-pr-refresh-linked-${pullRequest.number}`}
											/>
										)}
										<Button
											variant="ghost"
											size="sm"
											aria-label={`Remove ${formatPullRequestLabel(pullRequest, "full")}`}
											icon={isRemoving ? <Spinner size={10} /> : <X size={12} />}
											disabled={isRemoving}
											onClick={() => void actions.removePullRequest(pullRequest)}
											className={actionButtonClass}
											data-testid={`task-pr-remove-${pullRequest.number}`}
										/>
									</div>
								);
							})
						)}
					</div>
					<div className="h-px bg-border" />
					<Button
						variant="ghost"
						size="sm"
						icon={actions.refreshAllPending ? <Spinner size={12} /> : <RefreshCw size={12} />}
						disabled={actions.refreshAllPending}
						onClick={() => void actions.refreshAll()}
						className={cn(mobile && "min-h-11")}
						data-testid="task-pr-refresh-button"
					>
						{actions.refreshAllPending ? "Refreshing" : "Refresh"}
					</Button>
					<div className="h-px bg-border" />
					<TaskPrCommentHandlingPanel workspaceId={workspaceId} taskId={taskId} pullRequests={pullRequests} />
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}

interface TaskPullRequestManagerProps {
	workspaceId: string;
	taskId: string;
	pullRequests: RuntimeTaskPullRequest[];
}

/**
 * PRLINK-5: desktop top-bar affordance. The "+"/"Link PR" trigger plus the
 * shared manager popover (uncontrolled open state).
 */
export function TaskPullRequestManager({ workspaceId, taskId, pullRequests }: TaskPullRequestManagerProps) {
	return (
		<TaskPullRequestManagerPopover
			workspaceId={workspaceId}
			taskId={taskId}
			pullRequests={pullRequests}
			trigger={
				pullRequests.length === 0 ? (
					<Button variant="ghost" size="sm" icon={<Link size={12} />} data-testid="task-pr-link-pr-button">
						Link PR
					</Button>
				) : (
					<Button
						variant="ghost"
						size="sm"
						icon={<Plus size={14} />}
						aria-label="Manage pull requests"
						data-testid="task-pr-manage-button"
						title="Manage pull requests"
					/>
				)
			}
		/>
	);
}
