// AM-5: the auto-merge opt-in surface. The checkbox arms/disarms the
// server-owned opt-in (arming requires a selected Automation PR, a stored
// repository policy and no policy revision drift); enabling asks for an
// explicit confirmation of the merge consequence. The status line mirrors
// the server-persisted facts only (AM-3 eligibility summary + AM-4 attempt
// journal) and never renders stale evidence as green. The repository CI
// policy affordance lives in TaskPrAutoMergePolicyPanel.

import { useCallback, useState } from "react";
import { cn } from "@/components/ui/cn";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
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
	"Enables merging when all repository required checks pass, at least one non-author review approves, and the PR is mergeable — using the repository CI policy. GitHub branch protections and rulesets may still require additional approvals or deployment checks.";

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
	const [confirmOpen, setConfirmOpen] = useState(false);
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
	// Arming is disabled (with a reason) until the server-side preconditions
	// hold: a selected Automation PR, a stored policy for its repository,
	// and no armed-vs-current revision drift (a changed policy requires an
	// explicit re-arm).
	const policyKnown = workspaceId !== null && repository !== null && !policyQuery.isLoading;
	const mismatch = policyKnown && policy !== null && armedRevision !== null && armedRevision !== policy.revision;
	const canArm = selectedKey !== null && !ambiguous && policyKnown && policy !== null && !mismatch;
	const armingDisabledReason = ambiguous
		? "Select the Automation PR before enabling auto-merge."
		: selectedKey === null
			? "Record and select an Automation PR before enabling auto-merge."
			: !policyKnown
				? null
				: policy === null
					? "Configure the repository CI policy below first."
					: mismatch
						? `The repository policy changed after arming (armed revision ${armedRevision}, current ${policy.revision}); toggle the checkbox off and on to re-arm.`
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
					canArm && !acting && "cursor-pointer hover:text-text-primary",
				)}
			>
				<input
					type="checkbox"
					checked={tracking.autoMergeWhenApproved}
					// Arming preconditions gate turning the setting ON only; a checked
					// box is always clickable so the operator can disarm and re-arm
					// even while preconditions (or the armed policy revision) drift.
					disabled={acting || (!canArm && !tracking.autoMergeWhenApproved)}
					onChange={(event) => {
						const next = event.target.checked;
						if (next) {
							// Enabling is a real-merge commitment: confirm first.
							setConfirmOpen(true);
						} else {
							void applyAutoMergeSetting(false);
						}
					}}
					className="mt-0.5 h-3.5 w-3.5 accent-(--color-accent)"
					aria-label="Auto-merge when CI passes and at least one review approves"
				/>
				<span className="leading-tight">
					Auto-merge when CI passes and at least one review approves
					<span className="block text-text-tertiary">{AUTO_MERGE_HINT}</span>
					{armingDisabledReason !== null ? (
						<span className="block text-status-orange">{armingDisabledReason}</span>
					) : null}
					{tracking.autoMergeWhenApproved && armedRevision !== null ? (
						<span className="block text-text-tertiary">
							Armed against repository policy revision {armedRevision}
						</span>
					) : null}
					{armingError !== null ? <span className="block text-status-red">{armingError}</span> : null}
				</span>
			</label>

			{status !== null ? (
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

			<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<AlertDialogHeader>
					<AlertDialogTitle>Enable auto-merge?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						This actually merges the Automation PR into its target base with the repository CI policy's merge
						method once all required checks pass and at least one non-author review approves — it does not only
						mark the card Done.
						{tracking.autoFinishOnMerge
							? " The card moves to Done when GitHub confirms the merge."
							: " “Auto complete when the PR merges” is off, so the card stays in In Review even after the PR merges."}{" "}
						GitHub branch protections and rulesets may still require additional approvals or deployment checks
						that Kanban does not override.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={acting}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						disabled={acting}
						onClick={() => {
							setConfirmOpen(false);
							void applyAutoMergeSetting(true);
						}}
					>
						Enable auto-merge
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
