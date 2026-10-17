// PRLINK-10: one linked-PR row in the task-detail PRs view. Renders the
// stored metadata immediately (no provider round-trip): identity with the
// external Open link, optional title, state (unknown when absent), state
// check age, source, first-recorded and last-observed ages. Per-row actions
// (make/clear display primary, refresh, remove) come from
// useTaskPullRequestActions; unsupported providers disable the row refresh
// with a visible explanation while the other actions stay available.

import { supportsPrMetadataRefresh } from "@runtime-pr-provider-capabilities";
import { ExternalLink, RefreshCw, Star, StarOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { CLEAR_PRIMARY_PENDING_KEY, type TaskPullRequestActions } from "@/hooks/use-task-pull-request-actions";
import type { RuntimeTaskPullRequest } from "@/runtime/types";
import {
	formatApproximateAge,
	formatPullRequestIdentity,
	formatPullRequestLabel,
	formatPullRequestSource,
	getPullRequestDetailParts,
	getPullRequestKey,
} from "@/utils/task-pull-requests";

const MAKE_PRIMARY_TOOLTIP =
	"Make primary for display. The Automation PR is selected separately in PR tracking settings.";
const CLEAR_PRIMARY_TOOLTIP = "Use automatic display order";
const REFRESH_LINKED_TOOLTIP =
	"Refresh this pull request's state and title from the provider. Works even when the task is done or the link came from another branch.";
const UNSUPPORTED_REFRESH_NOTE = "Refresh unavailable: provider metadata reads are github.com only";

function RowBadge({ label, testId, className }: { label: string; testId: string; className?: string }) {
	return (
		<span className={className ?? "shrink-0 text-[10px] text-text-tertiary"} data-testid={testId}>
			{label}
		</span>
	);
}

export function TaskPullRequestRow({
	pullRequest,
	isWinner,
	isExplicitPrimary,
	isAutomationPr,
	canManage,
	actions,
	mobile,
}: {
	pullRequest: RuntimeTaskPullRequest;
	/** Display winner (primary winner first, then recorded order). */
	isWinner: boolean;
	/** Winner with an explicit `isPrimary` flag. */
	isExplicitPrimary: boolean;
	/** The tracked Automation PR (separate from the display primary). */
	isAutomationPr: boolean;
	/** False without a workspace scope: stored information and anchors only. */
	canManage: boolean;
	actions: TaskPullRequestActions;
	mobile: boolean;
}): React.ReactElement {
	const key = getPullRequestKey(pullRequest);
	const isPrimaryPending = actions.primaryPendingKey === key;
	const isClearPrimaryPending = actions.primaryPendingKey === CLEAR_PRIMARY_PENDING_KEY;
	const isRemoving = actions.removingKey === key;
	const isRefreshing = actions.refreshingKey === key;
	const refreshSupported = supportsPrMetadataRefresh(pullRequest);
	const actionButtonClass = mobile ? "min-h-11 min-w-11 shrink-0 p-0" : "h-6 w-6 shrink-0 px-0";

	const metaParts: string[] = [`State: ${pullRequest.state ?? "unknown"}`];
	if (pullRequest.stateCheckedAt !== undefined) {
		metaParts.push(`State checked ${formatApproximateAge(pullRequest.stateCheckedAt)}`);
	}
	metaParts.push(`Source: ${formatPullRequestSource(pullRequest.source)}`);
	metaParts.push(`First recorded ${formatApproximateAge(pullRequest.createdAt)}`);
	metaParts.push(`Last observed ${formatApproximateAge(pullRequest.lastSeenAt ?? pullRequest.createdAt)}`);
	const detailParts = getPullRequestDetailParts(pullRequest);

	return (
		<div
			className="flex flex-col gap-1 rounded-md border border-divider bg-surface-1 px-2 py-1.5"
			data-testid={`task-pr-view-row-${pullRequest.number}`}
		>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				<a
					href={pullRequest.url}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={`Open ${formatPullRequestLabel(pullRequest, "full")} in ${pullRequest.repository}`}
					data-testid={`task-pr-view-open-${pullRequest.number}`}
					className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-accent hover:text-accent-hover hover:underline"
				>
					<ExternalLink size={12} className="shrink-0" />
					<span className="truncate">{formatPullRequestIdentity(pullRequest)}</span>
				</a>
				{isWinner ? (
					<RowBadge
						label={isExplicitPrimary ? "Primary for display" : "Shown by default"}
						testId={isExplicitPrimary ? "task-pr-view-primary-label" : "task-pr-view-default-primary-label"}
						className="shrink-0 rounded-sm bg-surface-3 px-1 py-0.5 text-[10px] text-text-secondary"
					/>
				) : null}
				{isAutomationPr ? (
					<RowBadge
						label="Automation PR"
						testId="task-pr-view-automation-label"
						className="shrink-0 rounded-sm bg-surface-3 px-1 py-0.5 text-[10px] text-text-secondary"
					/>
				) : null}
			</div>
			{pullRequest.title ? (
				<div
					className="min-w-0 truncate text-xs text-text-secondary"
					data-testid={`task-pr-view-title-${pullRequest.number}`}
					title={pullRequest.title}
				>
					{pullRequest.title}
				</div>
			) : null}
			{detailParts.length > 0 ? (
				<div
					className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-text-secondary"
					data-testid={`task-pr-view-details-${pullRequest.number}`}
				>
					{detailParts.map((part) => (
						<span key={part} className="min-w-0 break-words">
							{part}
						</span>
					))}
				</div>
			) : null}

			<div
				className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-text-tertiary"
				data-testid={`task-pr-view-meta-${pullRequest.number}`}
			>
				{metaParts.map((part) => (
					<span key={part} className="min-w-0 break-words">
						{part}
					</span>
				))}
				{!refreshSupported ? (
					<span data-testid={`task-pr-view-refresh-note-${pullRequest.number}`}>{UNSUPPORTED_REFRESH_NOTE}</span>
				) : null}
			</div>
			{canManage ? (
				<div className="flex items-center gap-1">
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
								data-testid={`task-pr-view-clear-primary-${pullRequest.number}`}
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
								data-testid={`task-pr-view-make-primary-${pullRequest.number}`}
							/>
						</Tooltip>
					)}
					<Tooltip content={REFRESH_LINKED_TOOLTIP}>
						<Button
							variant="ghost"
							size="sm"
							aria-label={refreshSupported ? REFRESH_LINKED_TOOLTIP : UNSUPPORTED_REFRESH_NOTE}
							icon={isRefreshing ? <Spinner size={10} /> : <RefreshCw size={12} />}
							disabled={isRefreshing || !refreshSupported}
							onClick={() => void actions.refreshEntry(pullRequest)}
							className={actionButtonClass}
							data-testid={`task-pr-view-refresh-${pullRequest.number}`}
						/>
					</Tooltip>
					<Button
						variant="ghost"
						size="sm"
						aria-label={`Remove ${formatPullRequestLabel(pullRequest, "full")}`}
						icon={isRemoving ? <Spinner size={10} /> : <X size={12} />}
						disabled={isRemoving}
						onClick={() => void actions.removePullRequest(pullRequest)}
						className={actionButtonClass}
						data-testid={`task-pr-view-remove-${pullRequest.number}`}
					/>
				</div>
			) : null}
		</div>
	);
}
