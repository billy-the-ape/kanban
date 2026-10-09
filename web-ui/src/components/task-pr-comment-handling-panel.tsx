import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { Check, MessageSquare, Play } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useTaskPrTrackingState } from "@/hooks/use-task-pr-tracking-state";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskPullRequest } from "@/runtime/types";

interface TaskPrCommentHandlingPanelProps {
	workspaceId: string;
	taskId: string;
	pullRequests: RuntimeTaskPullRequest[];
}

/**
 * COMMENT-0: comment-handling control for the task's linked GitHub PR.
 * The opt-in toggle plus a compact, no-comment-body status view (pending
 * count/debounce countdown, dispatch status, blockers, and resume for failed
 * turns). Server state is authoritative; polling refreshes it while mounted.
 */
export function TaskPrCommentHandlingPanel({ workspaceId, taskId, pullRequests }: TaskPrCommentHandlingPanelProps) {
	const { state } = useTaskPrTrackingState(workspaceId, taskId, true);
	const [toggling, setToggling] = useState(false);
	const [resuming, setResuming] = useState(false);

	const githubPrs = pullRequests.filter((pullRequest) => pullRequest.host === "github.com");
	const hasEligiblePr = githubPrs.length === 1;
	const enabled = state?.enabled ?? false;
	const supported = state?.supported ?? true;
	const dispatch = state?.dispatch ?? null;
	const pendingCount = state?.pendingCount ?? 0;
	const pendingDeadline = state?.pendingDeadline ?? null;
	const blocker = state?.blocker ?? null;

	const handleToggle = async (checked: boolean): Promise<void> => {
		if (toggling) {
			return;
		}
		setToggling(true);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).runtime.setTaskPrAutomationSettings.mutate({
				taskId,
				autoAddressComments: checked,
			});
			if (!response.ok) {
				showAppToast({ intent: "danger", message: response.error || "Could not update comment handling." });
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: error instanceof Error ? error.message : "Could not update comment handling.",
			});
		} finally {
			setToggling(false);
		}
	};

	const handleResume = async (): Promise<void> => {
		if (resuming) {
			return;
		}
		setResuming(true);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).runtime.resumeTaskPrCommentHandling.mutate({
				taskId,
			});
			if (!response.ok || !response.dispatched) {
				showAppToast({ intent: "warning", message: response.error || "Could not resume comment handling." });
			}
		} catch (error) {
			showAppToast({
				intent: "warning",
				message: error instanceof Error ? error.message : "Could not resume comment handling.",
			});
		} finally {
			setResuming(false);
		}
	};

	let statusLine: ReactNode = null;
	if (dispatch?.status === "running") {
		statusLine = (
			<span
				className="flex items-center gap-1.5 text-[11px] text-status-blue"
				data-testid="task-pr-comment-status-running"
			>
				<Spinner size={10} />
				Addressing comments…
			</span>
		);
	} else if (dispatch?.status === "failed") {
		statusLine = (
			<span
				className="flex items-center gap-1.5 text-[11px] text-status-red"
				data-testid="task-pr-comment-status-failed"
			>
				{dispatch.error ?? "Comment handling failed."}
				{state?.resumable ? (
					<Button
						variant="ghost"
						size="sm"
						icon={resuming ? <Spinner size={10} /> : <Play size={10} />}
						disabled={resuming}
						onClick={() => void handleResume()}
						className="h-5 shrink-0 px-1.5 text-[11px]"
						data-testid="task-pr-comment-resume-button"
					>
						Resume
					</Button>
				) : null}
			</span>
		);
	} else if (pendingCount > 0 && pendingDeadline !== null) {
		const remainingSeconds = Math.max(0, Math.ceil((pendingDeadline - Date.now()) / 1000));
		statusLine = (
			<span className="text-[11px] text-text-secondary" data-testid="task-pr-comment-status-pending">
				{remainingSeconds > 0
					? `Waiting to address ${pendingCount} new ${pendingCount === 1 ? "comment" : "comments"} in ${remainingSeconds}s`
					: `Addressing ${pendingCount} new ${pendingCount === 1 ? "comment" : "comments"} shortly`}
			</span>
		);
	} else if (blocker) {
		statusLine = (
			<span className="text-[11px] text-status-orange" data-testid="task-pr-comment-status-blocked">
				{blocker}
			</span>
		);
	} else if (enabled) {
		statusLine = <span className="text-[11px] text-text-tertiary">Watching for review comments.</span>;
	}

	return (
		<div className="flex flex-col gap-1" data-testid="task-pr-comment-handling">
			<div className="flex items-center justify-between gap-2">
				<span className="flex min-w-0 items-center gap-1.5">
					<MessageSquare size={12} className="shrink-0 text-text-tertiary" />
					<span className="truncate text-xs text-text-secondary">Handle PR comments</span>
				</span>
				<RadixCheckbox.Root
					checked={enabled}
					onCheckedChange={(checked) => {
						if (typeof checked === "boolean") {
							void handleToggle(checked);
						}
					}}
					disabled={!hasEligiblePr || !supported || toggling}
					aria-label="Handle pull request comments"
					data-testid="task-pr-comment-toggle"
					className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded-sm border border-border bg-surface-0 data-[state=checked]:border-accent data-[state=checked]:bg-accent focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50"
				>
					<RadixCheckbox.Indicator>
						<Check size={10} className="text-surface-0" />
					</RadixCheckbox.Indicator>
				</RadixCheckbox.Root>
			</div>
			{statusLine ?? null}
			{!enabled && hasEligiblePr && !supported ? (
				<span className="text-[11px] text-text-tertiary" data-testid="task-pr-comment-unsupported">
					Comment handling is available for Cline tasks only.
				</span>
			) : null}
			{!hasEligiblePr ? (
				<span className="text-[11px] text-text-tertiary" data-testid="task-pr-comment-no-pr">
					{githubPrs.length > 1
						? "Exactly one linked GitHub PR is required."
						: "Link a GitHub pull request to enable comment handling."}
				</span>
			) : null}
		</div>
	);
}
