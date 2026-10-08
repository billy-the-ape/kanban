// PRTRACK-1: PR tracking settings + state for the task detail view.
// Self-contained: reads the frozen consumer API (getTaskTrackingState) and
// mutates server-owned settings through the same surface. With zero installed
// consumers the panel renders only the (disabled) checkboxes and no state.

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimePrInstalledConsumer,
	RuntimeTaskPullRequest,
	RuntimeTaskTrackingStateResponse,
} from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import type { BoardCard } from "@/types";
import { toCanonicalPrKeyForLink } from "@/utils/pr-tracking";

const TRACKING_STATE_POLL_INTERVAL_MS = 5_000;

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

export function TaskPrTrackingPanel({
	workspaceId,
	taskId,
	card,
	installedConsumers,
}: {
	workspaceId: string | null;
	taskId: string;
	card: BoardCard;
	installedConsumers: RuntimePrInstalledConsumer[];
}): React.ReactElement | null {
	const client = getRuntimeTrpcClient(workspaceId);
	const commentsInstalled = installedConsumers.some((consumer) => consumer.kind === "comments");
	const mergeInstalled = installedConsumers.some((consumer) => consumer.kind === "mergeCompletion");
	const consumersInstalled = commentsInstalled || mergeInstalled;
	// With zero installed consumers there is no tracking state to read or
	// poll: the panel degrades to the (disabled) checkbox pair.
	const { data: tracking, refetch } = useTrpcQuery<RuntimeTaskTrackingStateResponse>({
		enabled: workspaceId !== null && consumersInstalled,
		queryFn: () => client.workspace.prTracking.getTaskTrackingState.query({ taskId }),
	});
	const [acting, setActing] = useState(false);
	const pollTimerRef = useRef<number | null>(null);

	useEffect(() => {
		if (workspaceId === null || !consumersInstalled) {
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
	}, [workspaceId, refetch, consumersInstalled]);

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
		// disabled checkbox pair (card values, no polling).
		if (!consumersInstalled) {
			return (
				<div className="border-b border-divider px-3 py-2">
					<div className="mb-1.5">
						<span className="text-xs font-medium text-text-primary">PR tracking</span>
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

	return (
		<div className="border-b border-divider px-3 py-2">
			<div className="mb-1.5 flex items-center gap-2">
				<span className="text-xs font-medium text-text-primary">PR tracking</span>
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
