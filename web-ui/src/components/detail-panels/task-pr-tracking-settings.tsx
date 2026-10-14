// PRTRACK-1 / PRLINK-10: the single tracking settings/status section inside
// the task-detail PRs view. Reads the tracking state supplied by the PRs
// view (task-pr-tracking-panel) and mutates server-owned settings through
// the same frozen consumer API. With zero installed consumers the section
// degrades to the (disabled) checkbox pair; while tracking data is loading
// or failed with consumers installed, it renders nothing (the stored PR
// list in the PRs view is independent of these branches).

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimePrInstalledConsumer,
	RuntimeTaskPullRequest,
	RuntimeTaskTrackingStateResponse,
} from "@/runtime/types";
import type { BoardCard } from "@/types";
import { toCanonicalPrKeyForLink } from "@/utils/pr-tracking";

function prLabel(link: RuntimeTaskPullRequest): string {
	return `${link.repository}#${link.number}`;
}

function formatAsOf(timestamp: number | null): string | null {
	if (timestamp === null) {
		return null;
	}
	return new Date(timestamp).toLocaleTimeString();
}

function PrTrackingCheckbox({
	label,
	hint,
	checked,
	disabled,
	acting,
	onChange,
}: {
	label: string;
	hint: string | null;
	checked: boolean;
	disabled: boolean;
	acting: boolean;
	onChange: (next: boolean) => void;
}): React.ReactElement {
	return (
		<label
			className={cn(
				"flex items-start gap-2 text-xs text-text-secondary",
				!disabled && "cursor-pointer hover:text-text-primary",
			)}
		>
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled || acting}
				onChange={(event) => onChange(event.target.checked)}
				className="mt-0.5 h-3.5 w-3.5 accent-(--color-accent)"
				aria-label={label}
			/>
			<span className="leading-tight">
				{label}
				{hint ? <span className="block text-text-tertiary">{hint}</span> : null}
			</span>
		</label>
	);
}

/**
 * The PR tracking settings/status block: checkbox preferences (with
 * feature-unavailable / native-Cline hints), the separately labelled
 * Automation PR selector, blockers, repair-owner information, lifecycle
 * messages and the explicit Resume PR tracking action. Rendering or
 * toggling anything here never enables or resumes automation on its own —
 * the mutations hit the validated server routes.
 */
export function TaskPrTrackingSettings({
	workspaceId,
	taskId,
	card,
	installedConsumers,
	tracking,
	refetch,
}: {
	workspaceId: string | null;
	taskId: string;
	card: BoardCard;
	installedConsumers: RuntimePrInstalledConsumer[];
	tracking: RuntimeTaskTrackingStateResponse | null;
	refetch: () => Promise<RuntimeTaskTrackingStateResponse | null>;
}): React.ReactElement | null {
	const client = getRuntimeTrpcClient(workspaceId);
	const commentsInstalled = installedConsumers.some((consumer) => consumer.kind === "comments");
	const mergeInstalled = installedConsumers.some((consumer) => consumer.kind === "mergeCompletion");
	const consumersInstalled = commentsInstalled || mergeInstalled;
	const [acting, setActing] = useState(false);

	const links = card.pullRequests ?? [];
	const selectionCandidates = useMemo(
		() =>
			links
				.map((link) => ({ prKey: toCanonicalPrKeyForLink(link), label: prLabel(link), url: link.url }))
				.filter((candidate) => candidate.prKey !== null),
		[links],
	);

	if (tracking === null) {
		// Zero installed consumers: no tracking state to read; show only the
		// disabled checkbox pair (card values, no polling). With consumers
		// installed, the tracking state is still loading or failed: render
		// nothing here (the stored PR list above is unaffected).
		if (!consumersInstalled) {
			return (
				<div className="border-b border-divider px-0 py-2">
					<div className="mb-1.5">
						<span className="text-xs font-medium text-text-primary" data-testid="task-pr-view-settings-title">
							PR tracking
						</span>
					</div>
					<div className="flex flex-col gap-1.5">
						<PrTrackingCheckbox
							label="Auto address PR review comments"
							hint="Feature unavailable"
							checked={card.autoAddressComments === true}
							disabled
							acting={false}
							onChange={() => undefined}
						/>
						<PrTrackingCheckbox
							label="Auto complete when the PR merges"
							hint="Feature unavailable"
							checked={card.autoFinishOnMerge === true}
							disabled
							acting={false}
							onChange={() => undefined}
						/>
					</div>
				</div>
			);
		}
		return null;
	}

	const runMutation = async (mutation: () => Promise<unknown>): Promise<void> => {
		setActing(true);
		try {
			await mutation();
			await refetch();
		} catch {
			// The mutation response carries its own error; the next poll refreshes.
		} finally {
			setActing(false);
		}
	};

	const blockers = tracking.blockers;
	const selectedKey = tracking.selectedAutomationPrKey;
	const asOf = formatAsOf(tracking.snapshot?.checkedAt ?? null);
	// MERGE-1: merge completion status line (the needs-human blocker above
	// carries the reason; this line shows the episode state itself).
	const terminalStopReason = tracking.terminalStop?.reason ?? null;
	const mergeStatusLine =
		terminalStopReason === "merged_completed"
			? "PR merged — task completed automatically."
			: terminalStopReason === "merged_reconciling"
				? "Merge completion in progress."
				: terminalStopReason === "merged_unresolved"
					? "Merge completion needs a human decision."
					: terminalStopReason === "closed_unmerged"
						? "PR closed without merging."
						: null;

	return (
		<div className="border-b border-divider px-0 py-2">
			<div className="mb-1.5 flex items-center gap-2">
				<span className="text-xs font-medium text-text-primary" data-testid="task-pr-view-settings-title">
					PR tracking
				</span>
				{asOf ? (
					<span
						className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary"
						title={new Date(tracking.snapshot?.checkedAt ?? 0).toString()}
					>
						snapshot as of {asOf}
						{tracking.snapshot?.isStale ? " (stale)" : ""}
						<button
							type="button"
							aria-label="Refresh PR tracking state"
							onClick={() => void refetch()}
							className="inline-flex cursor-pointer rounded-sm p-0.5 hover:bg-surface-3 hover:text-text-primary"
						>
							<RefreshCw size={11} />
						</button>
					</span>
				) : null}
			</div>

			<div className="flex flex-col gap-1.5">
				<PrTrackingCheckbox
					label="Auto address PR review comments"
					hint={
						!commentsInstalled
							? "Feature unavailable"
							: !tracking.commentsSupportedForTask
								? "Comment follow-up requires a native Cline task"
								: null
					}
					checked={tracking.autoAddressComments}
					disabled={!commentsInstalled || !tracking.commentsSupportedForTask}
					acting={acting}
					onChange={(next) =>
						void runMutation(() =>
							client.workspace.prTracking.setTaskPrSettings.mutate({ taskId, autoAddressComments: next }),
						)
					}
				/>
				<PrTrackingCheckbox
					label="Auto complete when the PR merges"
					hint={mergeInstalled ? null : "Feature unavailable"}
					checked={tracking.autoFinishOnMerge}
					disabled={!mergeInstalled}
					acting={acting}
					onChange={(next) =>
						void runMutation(() =>
							client.workspace.prTracking.setTaskPrSettings.mutate({ taskId, autoFinishOnMerge: next }),
						)
					}
				/>
			</div>

			{mergeStatusLine ? <div className="mt-2 text-xs text-text-secondary">{mergeStatusLine}</div> : null}

			{selectionCandidates.length > 1 ? (
				<div className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
					<span>Automation PR</span>
					<select
						value={selectedKey ?? ""}
						disabled={acting}
						onChange={(event) => {
							const prKey = event.target.value;
							if (prKey) {
								void runMutation(() =>
									client.workspace.prTracking.selectTaskAutomationPr.mutate({ taskId, prKey }),
								);
							}
						}}
						aria-label="Automation PR"
						className="max-w-[220px] rounded-md border border-bright bg-surface-2 px-2 py-1 text-xs text-text-primary"
					>
						{selectionCandidates.map((candidate) => (
							<option key={candidate.prKey ?? candidate.label} value={candidate.prKey ?? ""}>
								{candidate.label}
							</option>
						))}
					</select>
				</div>
			) : null}

			{blockers.length > 0 ? (
				<div className="mt-2 flex items-start gap-2 rounded-md border border-status-orange/40 bg-status-orange/10 px-2 py-1.5">
					<AlertTriangle size={13} className="mt-0.5 shrink-0 text-status-orange" />
					<div className="flex flex-col gap-0.5 text-xs text-status-orange">
						{blockers.map((blocker) => (
							<span key={blocker.kind}>{blocker.message}</span>
						))}
					</div>
				</div>
			) : null}

			<div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
				{tracking.ownerLabel ? <span>Repairs owned by {tracking.ownerLabel}</span> : null}
				{tracking.terminalStop ? (
					<button
						type="button"
						disabled={acting}
						onClick={() =>
							void runMutation(() => client.workspace.prTracking.resumeTaskPrTracking.mutate({ taskId }))
						}
						className="inline-flex items-center gap-1 rounded-md border border-bright bg-surface-2 px-2 py-1 text-xs text-text-primary hover:bg-surface-3 disabled:opacity-50"
					>
						<RefreshCw size={12} />
						Resume PR tracking
					</button>
				) : null}
			</div>
		</div>
	);
}
