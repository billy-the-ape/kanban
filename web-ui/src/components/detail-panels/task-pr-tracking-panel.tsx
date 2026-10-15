// PRLINK-10: the task-detail PRs view (the "PRs (N)" segment of the
// detail toolbar). It renders the selected card's stored linked-PR list
// immediately — independent of tracking data, tracking consumers and
// workspace scope — with per-row actions and the footer actions (link by
// URL, refresh linked PRs, find PRs for branch), plus the single tracking
// settings/status section. Tracking reads run only for a visible view with
// workspace scope; CSS-hidden panels never poll.

import { getOrderedTaskPullRequests } from "@runtime-pull-request-links";
import { Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { TaskPrTrackingSettings } from "@/components/detail-panels/task-pr-tracking-settings";
import { TaskPullRequestRow } from "@/components/detail-panels/task-pull-request-row";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { useTaskPullRequestActions } from "@/hooks/use-task-pull-request-actions";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskTrackingStateResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import type { BoardCard } from "@/types";
import { toCanonicalPrKeyForLink } from "@/utils/pr-tracking";
import { getPullRequestKey, validatePullRequestUrlShape } from "@/utils/task-pull-requests";

const TRACKING_STATE_POLL_INTERVAL_MS = 5_000;

const EMPTY_STATE_TEXT =
	"No pull requests are linked to this task yet. Kanban records them automatically when an agent creates or opens a pull request, when a delivery opens one, or when a review finds one for the task's branch. You can also link one by URL below, or paste a pull request URL on its own into the native chat.";

const NO_WORKSPACE_TEXT =
	"Open the task in a workspace to link, refresh or remove pull requests. Stored links and their external links stay available.";

export function TaskPrTrackingPanel({
	workspaceId,
	taskId,
	card,
	visible,
	mobile,
}: {
	workspaceId: string | null;
	taskId: string;
	card: BoardCard;
	/**
	 * PRLINK-10: true only when this view is actually visible (desktop
	 * right panel, or the mobile Diff tab with the PRs segment active).
	 * CSS-hidden panels must not keep polling.
	 */
	visible: boolean;
	mobile: boolean;
}): React.ReactElement {
	// PRLINK-10: tracking reads only for a visible PRs view with workspace
	// scope; no second poller is created for the stored-link list (it
	// renders from board state). The queryFn is memoized so useTrpcQuery's
	// effect does not re-fire on every render.
	const trackingQueryEnabled = workspaceId !== null && visible;
	const trackingQueryFn = useCallback(
		() => getRuntimeTrpcClient(workspaceId).workspace.prTracking.getTaskTrackingState.query({ taskId }),
		[workspaceId, taskId],
	);
	const { data: tracking, refetch } = useTrpcQuery<RuntimeTaskTrackingStateResponse>({
		enabled: trackingQueryEnabled,
		queryFn: trackingQueryFn,
	});
	const pollTimerRef = useRef<number | null>(null);

	useEffect(() => {
		if (!trackingQueryEnabled) {
			return;
		}
		pollTimerRef.current = window.setInterval(() => {
			void refetch();
		}, TRACKING_STATE_POLL_INTERVAL_MS);
		return () => {
			if (pollTimerRef.current !== null) {
				window.clearInterval(pollTimerRef.current);
				pollTimerRef.current = null;
			}
		};
	}, [trackingQueryEnabled, refetch]);

	const links = card.pullRequests ?? [];
	const orderedPullRequests = getOrderedTaskPullRequests(links);
	const winnerPullRequest = orderedPullRequests[0] ?? null;
	const automationPrKey = tracking?.selectedAutomationPrKey ?? null;
	const actions = useTaskPullRequestActions({ workspaceId, taskId, pullRequests: links });
	const [url, setUrl] = useState("");
	const validationError = url.trim() ? validatePullRequestUrlShape(url) : null;
	const canLink = workspaceId !== null && validationError === null && !actions.adding;

	return (
		<div
			className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto bg-surface-0 px-3 py-2"
			data-testid="task-pr-view"
		>
			<section className="flex min-w-0 flex-col gap-1.5" aria-label="Linked pull requests">
				<div className="text-xs font-medium text-text-primary" data-testid="task-pr-view-count">
					Linked pull requests ({links.length})
				</div>
				{orderedPullRequests.length === 0 ? (
					<div
						className="rounded-md border border-divider bg-surface-1 px-2 py-2 text-xs leading-relaxed text-text-secondary"
						data-testid="task-pr-view-empty-state"
					>
						{EMPTY_STATE_TEXT}
					</div>
				) : (
					<div className="flex min-w-0 flex-col gap-1.5">
						{orderedPullRequests.map((pullRequest) => {
							const key = getPullRequestKey(pullRequest);
							const isWinner = winnerPullRequest !== null && pullRequest === winnerPullRequest;
							const isExplicitPrimary = isWinner && pullRequest.isPrimary === true;
							const isAutomationPr =
								automationPrKey !== null && toCanonicalPrKeyForLink(pullRequest) === automationPrKey;
							return (
								<TaskPullRequestRow
									key={key}
									pullRequest={pullRequest}
									isWinner={isWinner}
									isExplicitPrimary={isExplicitPrimary}
									isAutomationPr={isAutomationPr}
									canManage={workspaceId !== null}
									actions={actions}
									mobile={mobile}
								/>
							);
						})}
					</div>
				)}
			</section>

			<section
				className="flex min-w-0 flex-col gap-1.5 border-t border-divider pt-2"
				aria-label="Pull request actions"
			>
				{workspaceId !== null ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void (async () => {
								const added = await actions.addPullRequest(url.trim());
								if (added) {
									setUrl("");
								}
							})();
						}}
						className="flex min-w-0 flex-col gap-1.5"
					>
						<input
							value={url}
							onChange={(event) => {
								setUrl(event.target.value);
								actions.clearAddError();
							}}
							placeholder="https://github.com/owner/repo/pull/123"
							aria-label="Pull request URL to link"
							data-testid="task-pr-view-url-input"
							className={cn(
								"h-8 w-full rounded-md border border-border bg-surface-0 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus-visible:outline-2 focus-visible:outline-accent",
								mobile && "min-h-11",
							)}
						/>
						{validationError ? (
							<p className="m-0 text-[11px] text-status-red" data-testid="task-pr-view-url-validation-error">
								{validationError}
							</p>
						) : null}
						{actions.addError ? (
							<p className="m-0 text-[11px] text-status-red" data-testid="task-pr-view-form-error">
								{actions.addError}
							</p>
						) : null}
						<Button
							variant="primary"
							size="sm"
							type="submit"
							icon={actions.adding ? <Spinner size={10} /> : <Plus size={12} />}
							disabled={!canLink}
							className={mobile ? "min-h-11" : undefined}
							data-testid="task-pr-view-add-button"
						>
							Link PR
						</Button>
					</form>
				) : (
					<p className="m-0 text-xs leading-relaxed text-text-tertiary" data-testid="task-pr-view-no-workspace">
						{NO_WORKSPACE_TEXT}
					</p>
				)}
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						icon={actions.linkedRefreshing ? <Spinner size={12} /> : <RefreshCw size={12} />}
						disabled={workspaceId === null || links.length === 0 || actions.linkedRefreshing}
						className={mobile ? "min-h-11" : undefined}
						aria-label="Refresh linked pull requests from the provider"
						onClick={() => void actions.refreshLinked()}
						data-testid="task-pr-view-refresh-linked-button"
					>
						{actions.linkedRefreshing ? "Refreshing" : "Refresh linked PRs"}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						icon={actions.branchLookupPending ? <Spinner size={12} /> : <Search size={12} />}
						disabled={workspaceId === null || actions.branchLookupPending}
						className={mobile ? "min-h-11" : undefined}
						aria-label="Find pull requests for the task's current branch"
						onClick={() => void actions.findBranchPullRequests()}
						data-testid="task-pr-view-find-branch-button"
					>
						{actions.branchLookupPending ? "Searching" : "Find PRs for branch"}
					</Button>
				</div>
			</section>

			<TaskPrTrackingSettings
				workspaceId={workspaceId}
				taskId={taskId}
				card={card}
				tracking={tracking ?? null}
				refetch={refetch}
			/>
		</div>
	);
}
