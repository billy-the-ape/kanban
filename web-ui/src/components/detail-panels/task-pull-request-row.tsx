// PRLINK-10: one linked-PR row in the task-detail PRs view. Renders the
// stored metadata immediately (no provider round-trip): identity with the
// external Open link, optional title, state (unknown when absent), state
// check age, source, first-recorded and last-observed ages. Per-row actions
// (make/clear display primary, refresh, remove) come from
// useTaskPullRequestActions; unsupported providers disable the row refresh
// with a visible explanation while the other actions stay available.

import { supportsPrMetadataRefresh } from "@runtime-pr-provider-capabilities";
import { ExternalLink, GitMerge, RefreshCw, Star, StarOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { CLEAR_PRIMARY_PENDING_KEY, type TaskPullRequestActions } from "@/hooks/use-task-pull-request-actions";
import type { RuntimePrConflictState, RuntimeTaskConflictRepairRecord, RuntimeTaskPullRequest } from "@/runtime/types";
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

/** PCR-2: the button's full consequence, including the approval/check reset. */
function resolveConflictsTooltip(headBranch: string | null): string {
	return `Fetches the latest base, merges it into ${headBranch ?? "the PR head branch"}, and pushes a normal commit to the existing PR branch. Existing approvals and check runs reset on the new head. Kanban will not merge or force-push.`;
}

function formatShortSha(sha: string | null): string {
	return sha === null ? "unknown" : sha.slice(0, 7);
}

function formatRepairTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString();
}

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
	conflict,
	conflictRepair,
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
	/**
	 * PCR-1: the conflict block, supplied only for the row whose canonical key
	 * matches `conflict.prKey` (the panel owns that scoping). Null/undefined
	 * renders nothing extra.
	 */
	conflict?: RuntimePrConflictState | null;
	/** PCR-2: the durable conflict-repair dispatch record for this task. */
	conflictRepair?: RuntimeTaskConflictRepairRecord | null;
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

	// PCR-2: the repair record is keyed by head SHA — while it still matches
	// the CURRENT head, a re-click is refused and the line explains the wait.
	const repairMatchesHead =
		conflict != null &&
		conflictRepair != null &&
		conflict.headSha != null &&
		conflictRepair.headSha === conflict.headSha;
	const repairDispatched = repairMatchesHead && conflictRepair?.status === "dispatched";
	const repairPending = actions.repairPendingKey === key;
	const recheckPending = actions.recheckPendingKey === key;
	const prOpen = pullRequest.state === undefined || pullRequest.state === "open";
	const repairDisabledReason = !prOpen
		? `The pull request is ${pullRequest.state ?? "unknown"}, not open.`
		: repairDispatched
			? `A repair was already dispatched for head ${formatShortSha(conflictRepair?.headSha ?? null)} at ${
					conflictRepair ? formatRepairTime(conflictRepair.dispatchedAt) : "earlier"
				}. Wait for it to finish, or press again after the head changes.`
			: null;

	return (
		// Detail-panel components render their own provider (App has a root one,
		// but component tests render this subtree without it).
		<TooltipProvider>
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
						<span data-testid={`task-pr-view-refresh-note-${pullRequest.number}`}>
							{UNSUPPORTED_REFRESH_NOTE}
						</span>
					) : null}
				</div>
				{conflict ? (
					<div
						className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
						data-testid={`task-pr-view-conflict-${pullRequest.number}`}
					>
						{repairMatchesHead && conflictRepair ? (
							<span
								className={conflictRepair.status === "failed" ? "text-status-red" : "text-text-secondary"}
								data-testid={`task-pr-view-repair-${pullRequest.number}`}
							>
								{conflictRepair.status === "dispatched"
									? `repair dispatched \u00b7 head ${formatShortSha(conflictRepair.headSha)} \u00b7 ${formatRepairTime(conflictRepair.dispatchedAt)}`
									: `repair failed \u00b7 ${conflictRepair.error ?? "unknown error"}`}
							</span>
						) : null}
						<span
							className={
								conflict.state === "conflicting"
									? "text-status-red"
									: conflict.state === "clean"
										? "text-status-green"
										: "text-text-secondary"
							}
							data-testid={`task-pr-view-conflict-state-${pullRequest.number}`}
						>
							{conflict.state === "clean"
								? "Merges cleanly into the base branch."
								: (conflict.note ??
									(conflict.state === "conflicting"
										? "The current head does not merge cleanly into the base branch."
										: "Mergeability is unknown."))}
						</span>
						{canManage && conflict.state === "unknown" ? (
							<button
								type="button"
								disabled={recheckPending}
								onClick={() => void actions.recheckConflict(pullRequest)}
								className="inline-flex items-center gap-1 rounded-sm border border-bright bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-primary hover:bg-surface-3 disabled:opacity-50"
								data-testid={`task-pr-view-recheck-${pullRequest.number}`}
							>
								{recheckPending ? <Spinner size={10} /> : <RefreshCw size={11} />}
								Re-check
							</button>
						) : null}
						{canManage && conflict.state === "conflicting" ? (
							<Tooltip content={repairDisabledReason ?? resolveConflictsTooltip(conflict.headRef)}>
								<span>
									<Button
										variant="primary"
										size="sm"
										icon={repairPending ? <Spinner size={10} /> : <GitMerge size={12} />}
										disabled={repairPending || repairDisabledReason !== null}
										onClick={() => void actions.resolveConflicts(pullRequest)}
										className={mobile ? "min-h-11" : undefined}
										data-testid={`task-pr-view-resolve-conflicts-${pullRequest.number}`}
									>
										Resolve conflicts
									</Button>
								</span>
							</Tooltip>
						) : null}
					</div>
				) : null}
				{actions.repairError ? (
					<p
						className="m-0 text-[11px] leading-relaxed text-status-red"
						data-testid={`task-pr-view-repair-error-${pullRequest.number}`}
					>
						{actions.repairError}
					</p>
				) : null}
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
		</TooltipProvider>
	);
}
