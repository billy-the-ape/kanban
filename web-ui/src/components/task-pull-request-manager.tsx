import * as RadixPopover from "@radix-ui/react-popover";
import { getOrderedTaskPullRequests } from "@runtime-pull-request-links";
import { Link, Plus, RefreshCw, Star, StarOff, X } from "lucide-react";
import { type ReactNode, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { TaskPullRequestLink } from "@/components/task-pull-request-link";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskPullRequest } from "@/runtime/types";
import {
	formatPullRequestLabel,
	getLinkedRefreshMessages,
	getPullRequestKey,
	getPullRequestRefreshMessage,
	validatePullRequestUrlShape,
} from "@/utils/task-pull-requests";

// Sentinel pending key for the "use automatic display order" (clear) action.
const CLEAR_PRIMARY_PENDING_KEY = "__clear-primary__";
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
	const [submitting, setSubmitting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [removingKey, setRemovingKey] = useState<string | null>(null);
	// PRLINK-6: pending display-primary actions (server response is authoritative).
	const [primaryPendingKey, setPrimaryPendingKey] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	// PRLINK-9: per-row provider metadata refresh pending keys.
	const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
	const isOpen = open ?? uncontrolledOpen;
	const validationError = url.trim() ? validatePullRequestUrlShape(url) : null;
	const canSubmit = validationError === null && !submitting;
	// PRLINK-6: display order — the primary winner first, the rest in recorded order.
	const orderedPullRequests = getOrderedTaskPullRequests(pullRequests);
	const winnerPullRequest = orderedPullRequests[0];
	const actionButtonClass = mobile ? "min-h-11 min-w-11 shrink-0 p-0" : "h-6 w-6 shrink-0 px-0";

	const handleOpenChange = (nextOpen: boolean): void => {
		if (submitting) {
			return;
		}
		if (open === undefined) {
			setUncontrolledOpen(nextOpen);
		}
		onOpenChange?.(nextOpen);
	};

	const handleAdd = async (): Promise<void> => {
		if (!canSubmit) {
			return;
		}
		setSubmitting(true);
		setFormError(null);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).workspace.addTaskPullRequest.mutate({
				taskId,
				url: url.trim(),
			});
			if (response.ok) {
				setUrl("");
				setFormError(null);
				// Close optimistically; the authoritative entry arrives via the broadcast.
				handleOpenChange(false);
				return;
			}
			const message = response.error || "Could not add the pull request.";
			setFormError(message);
			showAppToast({ intent: "danger", message });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Could not add the pull request.";
			setFormError(message);
			showAppToast({ intent: "danger", message });
		} finally {
			setSubmitting(false);
		}
	};

	const handleRemove = async (pullRequest: RuntimeTaskPullRequest): Promise<void> => {
		const key = getPullRequestKey(pullRequest);
		setRemovingKey(key);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).workspace.removeTaskPullRequest.mutate({
				taskId,
				url: pullRequest.url,
			});
			if (!response.ok) {
				showAppToast({
					intent: "danger",
					message: response.error || "Could not remove the pull request.",
				});
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: error instanceof Error ? error.message : "Could not remove the pull request.",
			});
		} finally {
			setRemovingKey(null);
		}
	};

	// PRLINK-6: make this link the display-only primary. The server response is
	// authoritative; the board refreshes via the state broadcast.
	const handleMakePrimary = async (pullRequest: RuntimeTaskPullRequest): Promise<void> => {
		const key = getPullRequestKey(pullRequest);
		setPrimaryPendingKey(key);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).workspace.setPrimaryTaskPullRequest.mutate({
				taskId,
				url: pullRequest.url,
			});
			if (!response.ok) {
				showAppToast({
					intent: "danger",
					message: response.error || "Could not update the display primary.",
				});
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: error instanceof Error ? error.message : "Could not update the display primary.",
			});
		} finally {
			setPrimaryPendingKey(null);
		}
	};

	// PRLINK-6: clear every explicit primary and fall back to the automatic order.
	const handleClearPrimary = async (): Promise<void> => {
		setPrimaryPendingKey(CLEAR_PRIMARY_PENDING_KEY);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).workspace.setPrimaryTaskPullRequest.mutate({
				taskId,
				url: null,
			});
			if (!response.ok) {
				showAppToast({
					intent: "danger",
					message: response.error || "Could not update the display primary.",
				});
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: error instanceof Error ? error.message : "Could not update the display primary.",
			});
		} finally {
			setPrimaryPendingKey(null);
		}
	};

	const handleRefresh = async (): Promise<void> => {
		if (refreshing) {
			return;
		}
		setRefreshing(true);
		try {
			const client = getRuntimeTrpcClient(workspaceId);
			const response = await client.workspace.refreshTaskPullRequests.mutate({ taskId });
			if (!response.ok) {
				showAppToast({ intent: "warning", message: response.error || "Refresh failed." });
				return;
			}
			// The lookup reason is only consumed by this explicit action; the
			// board already reflects updated/unchanged outcomes via broadcast.
			const message = getPullRequestRefreshMessage(response.reason);
			if (message) {
				showAppToast({ intent: "primary", message });
			}
			// PRLINK-9: also refresh the stored links' metadata via the
			// provider (works for Done tasks and other branches/repos).
			if (pullRequests.length > 0) {
				const linked = await client.workspace.refreshLinkedTaskPullRequests.mutate({ taskId });
				for (const linkedMessage of getLinkedRefreshMessages(linked.updated, linked.outcomes)) {
					showAppToast({ intent: "primary", message: linkedMessage });
				}
			}
		} catch (error) {
			showAppToast({
				intent: "warning",
				message: error instanceof Error ? error.message : "Refresh failed.",
			});
		} finally {
			setRefreshing(false);
		}
	};

	// PRLINK-9: refresh ONE stored link's metadata via the provider.
	const handleRefreshLinked = async (pullRequest: RuntimeTaskPullRequest): Promise<void> => {
		const key = getPullRequestKey(pullRequest);
		setRefreshingKey(key);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).workspace.refreshTaskPullRequestEntry.mutate({
				taskId,
				url: pullRequest.url,
			});
			if (!response.ok) {
				showAppToast({
					intent: "warning",
					message: response.error || "Could not refresh the pull request.",
				});
				return;
			}
			for (const message of getLinkedRefreshMessages(response.updated, response.outcomes)) {
				showAppToast({ intent: "primary", message });
			}
		} catch (error) {
			showAppToast({
				intent: "warning",
				message: error instanceof Error ? error.message : "Could not refresh the pull request.",
			});
		} finally {
			setRefreshingKey(null);
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
								setFormError(null);
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
						{formError ? (
							<p className="m-0 text-[11px] text-status-red" data-testid="task-pr-form-error">
								{formError}
							</p>
						) : null}
						<Button
							variant="primary"
							size="sm"
							type="submit"
							icon={submitting ? <Spinner size={10} /> : <Plus size={12} />}
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
								const isRemoving = removingKey === key;
								const isWinner = winnerPullRequest !== undefined && pullRequest === winnerPullRequest;
								const isExplicitPrimary = isWinner && pullRequest.isPrimary === true;
								const isPrimaryPending = primaryPendingKey === key;
								const isClearPrimaryPending = primaryPendingKey === CLEAR_PRIMARY_PENDING_KEY;
								const isRefreshingLinked = refreshingKey === key;
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
													onClick={() => void handleClearPrimary()}
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
													onClick={() => void handleMakePrimary(pullRequest)}
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
													disabled={isRefreshingLinked || refreshing}
													onClick={() => void handleRefreshLinked(pullRequest)}
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
												disabled={isRefreshingLinked || refreshing}
												onClick={() => void handleRefreshLinked(pullRequest)}
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
											onClick={() => void handleRemove(pullRequest)}
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
						icon={refreshing ? <Spinner size={12} /> : <RefreshCw size={12} />}
						disabled={refreshing}
						onClick={() => void handleRefresh()}
						className={cn(mobile && "min-h-11")}
						data-testid="task-pr-refresh-button"
					>
						{refreshing ? "Refreshing" : "Refresh"}
					</Button>
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
