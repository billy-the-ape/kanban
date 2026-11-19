// Auto-merge preference and execution status are separate: setup blockers
// never prevent saving the preference. The server binds ready tasks to CI policy.

import { useCallback, useState } from "react";
import { cn } from "@/components/ui/cn";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { AutoMergePolicy, RuntimeTaskTrackingStateResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { type AutoMergeUiStatus, deriveAutoMergeStatus, shortSha } from "@/utils/auto-merge-status";
import { TaskPrAutoMergePolicyPanel } from "./task-pr-auto-merge-policy";

/** The repository (owner/repo) encoded in a canonical PR key, or null. */
function repositoryFromCanonicalPrKey(prKey: string | null | undefined): string | null {
	if (prKey === null || prKey === undefined) {
		return null;
	}
	const parts = prKey.split("|");
	const repository = parts[2];
	return repository !== undefined && repository.length > 0 ? repository : null;
}

const TONE_CLASSES: Record<AutoMergeUiStatus["tone"], string> = {
	neutral: "text-text-secondary",
	info: "text-status-blue",
	success: "text-status-green",
	warning: "text-status-orange",
	danger: "text-status-red",
};

function formatVerifiedAt(timestamp: number | null): string | null {
	return timestamp === null ? null : new Date(timestamp).toLocaleTimeString();
}

/** The operator-facing help text for the auto-merge opt-in. */
const AUTO_MERGE_HINT =
	"Merges the linked PR after the configured CI checks pass and a non-author approves the current commit. GitHub branch protections and rulesets still apply.";

export function TaskPrAutoMergeSettings({
	workspaceId,
	taskId,
	tracking,
	refetch,
}: {
	workspaceId: string | null;
	taskId: string;
	tracking: RuntimeTaskTrackingStateResponse;
	refetch: () => Promise<RuntimeTaskTrackingStateResponse | null>;
}): React.ReactElement {
	const client = getRuntimeTrpcClient(workspaceId);
	const [acting, setActing] = useState(false);
	const [armingError, setArmingError] = useState<string | null>(null);

	const selectedKey = tracking.selectedAutomationPrKey;
	const repository = repositoryFromCanonicalPrKey(selectedKey);
	const ambiguous = tracking.blockers.some((blocker) => blocker.kind === "ambiguous_selection");

	// The current repository policy for the selected PR's repository
	// (server-owned, read-only here; no extra polling).
	const policyQueryFn = useCallback(
		async () => (await client.workspace.prTracking.getAutoMergePolicy.query({ repository: repository ?? "" })).policy,
		[client, repository],
	);
	const policyQuery = useTrpcQuery<AutoMergePolicy | null>({
		enabled: workspaceId !== null && repository !== null,
		queryFn: policyQueryFn,
	});
	const policy = policyQuery.data ?? null;

	const armedRevision = tracking.armedAutoMergePolicyRevision ?? null;
	const policyKnown = workspaceId !== null && repository !== null && !policyQuery.isLoading;
	const mismatch = policyKnown && policy !== null && armedRevision !== null && armedRevision !== policy.revision;
	const setupReason = ambiguous
		? "Waiting: select which linked PR should auto-merge."
		: selectedKey === null
			? "Waiting: link a PR. A sole linked PR is selected automatically."
			: !policyKnown
				? "Loading repository CI policy…"
				: policy === null
					? "Waiting: configure the required CI checks below. Auto-merge will start after setup."
					: mismatch
						? "The CI policy changed. Turn auto-merge off and on to accept the updated policy."
						: armedRevision === null
							? "Waiting for the server to activate auto-merge."
							: null;

	const applyAutoMergeSetting = async (next: boolean): Promise<void> => {
		setActing(true);
		setArmingError(null);
		try {
			const response = await client.workspace.prTracking.setTaskPrSettings.mutate({
				taskId,
				autoMergeWhenApproved: next,
			});
			if (!response.ok) {
				setArmingError(
					response.reason === "no_selected_pr"
						? "Select an Automation PR before enabling auto-merge."
						: response.reason === "no_policy"
							? "Configure the repository CI policy below first."
							: "The setting could not be saved.",
				);
			} else {
				await refetch();
			}
		} catch {
			setArmingError("The setting could not be saved.");
		} finally {
			setActing(false);
		}
	};

	const status = deriveAutoMergeStatus(tracking);
	const verifiedAt = formatVerifiedAt(status?.verifiedAt ?? null);
	const headShort = shortSha(status?.headSha ?? null);

	return (
		<div className="flex flex-col gap-1.5">
			<label
				className={cn(
					"flex items-start gap-2 text-xs text-text-secondary",
					!acting && "cursor-pointer hover:text-text-primary",
				)}
			>
				<input
					type="checkbox"
					checked={tracking.autoMergeWhenApproved}
					disabled={acting || workspaceId === null}
					onChange={(event) => void applyAutoMergeSetting(event.target.checked)}
					className="mt-0.5 h-3.5 w-3.5 accent-(--color-accent)"
					aria-label="Auto-merge when CI passes and at least one review approves"
				/>
				<span className="leading-tight">
					Auto-merge when CI passes and at least one review approves
					<span className="block text-text-tertiary">{AUTO_MERGE_HINT}</span>
					{tracking.autoMergeWhenApproved && setupReason !== null ? (
						<span className="block text-status-orange">{setupReason}</span>
					) : null}
					{tracking.autoMergeWhenApproved && armedRevision !== null ? (
						<span className="block text-text-tertiary">
							Armed against repository policy revision {armedRevision}
						</span>
					) : null}
					{armingError !== null ? <span className="block text-status-red">{armingError}</span> : null}
				</span>
			</label>

			{status !== null && setupReason === null ? (
				<div
					className={cn("ml-5 text-[11px] leading-tight", TONE_CLASSES[status.tone])}
					data-testid="task-pr-auto-merge-status"
				>
					<span className="font-medium">{status.label}</span>
					{status.detail ? <span> — {status.detail}</span> : null}
					{verifiedAt !== null || headShort !== null ? (
						<span className="text-text-tertiary">
							{verifiedAt !== null ? ` · verified ${verifiedAt}` : ""}
							{headShort !== null ? ` · head ${headShort}` : ""}
						</span>
					) : null}
				</div>
			) : null}

			{tracking.autoMergeWhenApproved && !tracking.autoFinishOnMerge ? (
				<div className="ml-5 text-[11px] text-text-tertiary">
					The PR can auto-merge while this card stays in In Review; enable “Auto complete when the PR merges” to
					move it to Done automatically.
				</div>
			) : null}

			{workspaceId !== null && repository !== null ? (
				<TaskPrAutoMergePolicyPanel
					workspaceId={workspaceId}
					taskId={taskId}
					repository={repository}
					policy={policy}
					policyLoading={policyQuery.isLoading}
					onSaved={async () => {
						await refetch();
						await policyQuery.refetch();
					}}
				/>
			) : null}
		</div>
	);
}
