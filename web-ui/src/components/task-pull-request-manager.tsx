import * as RadixPopover from "@radix-ui/react-popover";
import { Link, Plus, RefreshCw, X } from "lucide-react";
import { useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { TaskPullRequestLink } from "@/components/task-pull-request-link";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskPullRequest } from "@/runtime/types";
import {
	formatPullRequestLabel,
	getPullRequestKey,
	getPullRequestRefreshMessage,
	validatePullRequestUrlShape,
} from "@/utils/task-pull-requests";

interface TaskPullRequestManagerProps {
	workspaceId: string;
	taskId: string;
	pullRequests: RuntimeTaskPullRequest[];
}

/**
 * PRLINK-5: manual PR link management for the selected task.
 * Renders the "+"/"Link PR" affordance next to the PR links in the top-bar
 * branch control plus a popover with URL input, the recorded list, and the
 * opt-in refresh action. Server responses are authoritative; board state
 * refreshes via the runtime's state broadcast.
 */
export function TaskPullRequestManager({ workspaceId, taskId, pullRequests }: TaskPullRequestManagerProps) {
	const [open, setOpen] = useState(false);
	const [url, setUrl] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [removingKey, setRemovingKey] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const validationError = url.trim() ? validatePullRequestUrlShape(url) : null;
	const canSubmit = validationError === null && !submitting;

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
				setOpen(false);
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

	const handleRefresh = async (): Promise<void> => {
		if (refreshing) {
			return;
		}
		setRefreshing(true);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).workspace.refreshTaskPullRequests.mutate({ taskId });
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
		} catch (error) {
			showAppToast({
				intent: "warning",
				message: error instanceof Error ? error.message : "Refresh failed.",
			});
		} finally {
			setRefreshing(false);
		}
	};

	return (
		<RadixPopover.Root
			open={open}
			onOpenChange={(next) => {
				if (!submitting) {
					setOpen(next);
				}
			}}
		>
			<RadixPopover.Trigger asChild>
				{pullRequests.length === 0 ? (
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
				)}
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="start"
					sideOffset={4}
					className="z-50 flex w-72 flex-col gap-2 rounded-md border border-border bg-surface-2 p-2 shadow-lg outline-none"
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
					<div className="flex min-h-0 flex-col gap-1" data-testid="task-pr-list">
						{pullRequests.length === 0 ? (
							<p className="m-0 text-xs text-text-tertiary">No pull requests linked yet.</p>
						) : (
							pullRequests.map((pullRequest) => {
								const key = getPullRequestKey(pullRequest);
								const isRemoving = removingKey === key;
								return (
									<div key={key} className="flex items-center gap-1.5">
										<TaskPullRequestLink
											pullRequest={pullRequest}
											variant="full"
											className="min-w-0 flex-1 truncate"
										/>
										<Button
											variant="ghost"
											size="sm"
											aria-label={`Remove ${formatPullRequestLabel(pullRequest, "full")}`}
											icon={isRemoving ? <Spinner size={10} /> : <X size={12} />}
											disabled={isRemoving}
											onClick={() => void handleRemove(pullRequest)}
											className="h-6 w-6 shrink-0 px-0"
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
						data-testid="task-pr-refresh-button"
					>
						{refreshing ? "Refreshing" : "Refresh"}
					</Button>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
