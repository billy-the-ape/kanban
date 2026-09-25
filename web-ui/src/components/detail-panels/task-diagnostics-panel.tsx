// B-10.2/3/4: task diagnostics panel for the detail view. A collapsed strip
// shows the live phase (and blocked reason when attention is needed);
// expanded it shows git/workspace/preserved-work/context-usage detail and the
// operator actions. All data comes from the aggregated runtime query — the
// panel is pure presentation plus action dispatch.
import * as RadixCollapsible from "@radix-ui/react-collapsible";
import { AlertTriangle, ChevronDown, Copy, FolderOpen, RefreshCw, Save } from "lucide-react";
import { useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { TaskPhaseBadge } from "@/components/task-phase-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { useTaskDiagnostics } from "@/hooks/use-task-diagnostics";
import { openFileOnHost } from "@/runtime/runtime-config-query";
import type { RuntimeTaskDiagnosticsActionName, RuntimeTaskDiagnosticsResponse } from "@/runtime/types";

function DiagnosticsValue({ label, value }: { label: string; value: string | null | undefined }) {
	const text = value?.trim();
	return (
		<div className="flex items-baseline gap-2">
			<span className="w-28 shrink-0 text-text-secondary">{label}</span>
			<span
				className={cn("min-w-0 flex-1 truncate font-mono", text ? "text-text-primary" : "text-text-tertiary")}
				title={text ?? undefined}
			>
				{text ?? "—"}
			</span>
		</div>
	);
}

function CopyButton({ value, label }: { value: string; label: string }): React.ReactElement {
	return (
		<Tooltip content={`Copy ${label}`}>
			<button
				type="button"
				aria-label={`Copy ${label}`}
				className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
				onClick={() =>
					void navigator.clipboard?.writeText(value).catch(() => {
						showAppToast({ intent: "warning", message: "Could not copy to clipboard." });
					})
				}
			>
				<Copy size={12} />
			</button>
		</Tooltip>
	);
}

function DiagnosticsSection({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="border-b border-divider px-3 py-2 last:border-b-0">
			<h4 className="mb-1.5 text-[11px] font-semibold tracking-wider text-text-secondary uppercase m-0">{title}</h4>
			<div className="space-y-1">{children}</div>
		</div>
	);
}

function PhaseSection({ response }: { response: RuntimeTaskDiagnosticsResponse }): React.ReactElement {
	return (
		<DiagnosticsSection title="Phase">
			<div className="flex items-center gap-2">
				<TaskPhaseBadge
					summary={{
						phase: response.phase,
						needsAttention: response.needsAttention,
						blockedReason: response.blockedReason,
					}}
				/>
				<span className="text-[12px] text-text-secondary">
					{response.lastSuccessfulPhase
						? `last completed: ${response.lastSuccessfulPhase}`
						: "no phase has completed yet"}
				</span>
			</div>
			{response.blockedReason ? (
				<div className="flex items-start gap-1.5 rounded-md border border-status-red/40 bg-status-red/10 px-2 py-1.5">
					<AlertTriangle size={13} className="mt-0.5 shrink-0 text-status-red" />
					<span className="min-w-0 text-[12px] break-words text-text-primary">{response.blockedReason}</span>
				</div>
			) : null}
		</DiagnosticsSection>
	);
}

function GitSection({
	response,
	onOpenPath,
}: {
	response: RuntimeTaskDiagnosticsResponse;
	onOpenPath: (path: string) => void;
}): React.ReactElement {
	const worktreePath = response.workspace.worktreePath;
	return (
		<DiagnosticsSection title="Git & workspace">
			<div className="flex items-center gap-1">
				<DiagnosticsValue label="Branch" value={response.branch} />
				{response.branch ? <CopyButton value={response.branch} label="branch" /> : null}
			</div>
			<div className="flex items-center gap-1">
				<DiagnosticsValue label="Commit" value={response.commit} />
				{response.commit ? <CopyButton value={response.commit} label="commit" /> : null}
			</div>
			<DiagnosticsValue label="Base ref" value={response.baseRef} />
			<DiagnosticsValue label="Base SHA" value={response.baseSha} />
			<div className="flex items-center gap-1">
				<DiagnosticsValue label="Worktree" value={worktreePath} />
				{worktreePath && response.workspace.exists ? (
					<Tooltip content="Open worktree on host">
						<button
							type="button"
							aria-label="Open worktree on host"
							className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
							onClick={() => onOpenPath(worktreePath)}
						>
							<FolderOpen size={12} />
						</button>
					</Tooltip>
				) : null}
			</div>
			{!response.workspace.exists ? (
				<p className="m-0 text-[12px] text-status-orange">
					Task worktree is not present on disk
					{response.preservedWork.status !== "none" ? " (preserved work is available)" : ""}.
				</p>
			) : null}
		</DiagnosticsSection>
	);
}

function PreservedWorkSection({ response }: { response: RuntimeTaskDiagnosticsResponse }): React.ReactElement {
	const preserved = response.preservedWork;
	return (
		<DiagnosticsSection title="Preserved work">
			{preserved.status === "none" ? (
				<span className="text-[12px] text-text-tertiary">No preservation record.</span>
			) : (
				<>
					<div className="flex items-center gap-2">
						<span
							className={cn(
								"rounded-sm bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium",
								preserved.status === "blocked"
									? "text-status-red"
									: preserved.status === "active"
										? "text-status-green"
										: "text-status-blue",
							)}
						>
							{preserved.status}
						</span>
						{preserved.preservedAt ? (
							<span className="text-[11px] text-text-tertiary">
								{new Date(preserved.preservedAt).toLocaleString()}
							</span>
						) : null}
					</div>
					<DiagnosticsValue label="Ref" value={preserved.refName} />
					<DiagnosticsValue label="Latest commit" value={preserved.latestCommit} />
					{preserved.blockedReasons.length > 0 ? (
						<ul className="m-0 pl-4 text-[12px] text-status-red">
							{preserved.blockedReasons.map((reason) => (
								<li key={reason}>{reason}</li>
							))}
						</ul>
					) : null}
				</>
			)}
		</DiagnosticsSection>
	);
}

function ContextUsageSection({ response }: { response: RuntimeTaskDiagnosticsResponse }): React.ReactElement {
	const context = response.context;
	const percent = context.utilizationRatio !== null ? Math.min(1, context.utilizationRatio) : null;
	return (
		<DiagnosticsSection title="Context usage (estimated)">
			{context.source === "unavailable" ? (
				<span className="text-[12px] text-text-tertiary">
					No transcript available{context.error ? `: ${context.error}` : ""}.
				</span>
			) : (
				<>
					{percent !== null ? (
						<div className="flex items-center gap-2">
							<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
								<div
									className={cn(
										"h-full rounded-full",
										percent >= 0.8 ? "bg-status-red" : percent >= 0.6 ? "bg-status-orange" : "bg-status-blue",
									)}
									style={{ width: `${Math.round(percent * 100)}%` }}
								/>
							</div>
							<span className="shrink-0 font-mono text-[11px] text-text-secondary">
								{context.estimatedMessageTokens?.toLocaleString()} /{" "}
								{context.effectiveCapacityTokens?.toLocaleString() ?? "?"}
							</span>
						</div>
					) : null}
					<DiagnosticsValue
						label="Messages"
						value={context.messageCount !== null ? String(context.messageCount) : null}
					/>
					<DiagnosticsValue
						label="Compaction at"
						value={context.triggerTokens !== null ? `${context.triggerTokens.toLocaleString()} msg tokens` : null}
					/>
					{context.lastCompaction ? (
						<p className="m-0 text-[12px] text-text-secondary">
							Last compaction ({context.lastCompaction.trigger}){" "}
							{new Date(context.lastCompaction.at).toLocaleString()}:{" "}
							{context.lastCompaction.tokensBefore.toLocaleString()} →{" "}
							{context.lastCompaction.tokensAfter.toLocaleString()} tokens
						</p>
					) : null}
					{context.historyOmitted && context.omittedHistoryNotice ? (
						<div className="rounded-md border border-status-orange/40 bg-status-orange/10 px-2 py-1.5">
							<span className="text-[12px] text-text-primary">{context.omittedHistoryNotice}</span>
						</div>
					) : null}
				</>
			)}
		</DiagnosticsSection>
	);
}
const ACTION_LABELS: Record<RuntimeTaskDiagnosticsActionName, string> = {
	retry_phase: "Retry phase",
	resume_repair: "Resume repair",
	cancel: "Cancel",
	recover_workspace: "Recover workspace",
};

function ActionsSection({
	response,
	pendingAction,
	onRunAction,
	onExport,
	exporting,
}: {
	response: RuntimeTaskDiagnosticsResponse;
	pendingAction: RuntimeTaskDiagnosticsActionName | null;
	onRunAction: (action: RuntimeTaskDiagnosticsActionName) => void;
	onExport: () => void;
	exporting: boolean;
}): React.ReactElement {
	const actions = response.actions;
	return (
		<DiagnosticsSection title="Actions">
			<div className="flex flex-wrap gap-1.5">
				{(Object.keys(ACTION_LABELS) as RuntimeTaskDiagnosticsActionName[]).map((name) => {
					const availability = actions[name];
					const busy = pendingAction === name;
					const button = (
						<Button
							key={name}
							variant={name === "cancel" ? "danger" : "default"}
							size="sm"
							disabled={!availability.enabled || pendingAction !== null}
							onClick={() => onRunAction(name)}
						>
							{busy ? "Working…" : ACTION_LABELS[name]}
						</Button>
					);
					if (availability.enabled) {
						return button;
					}
					return (
						<Tooltip key={name} content={availability.reason ?? "Unavailable in the current state."}>
							<span>{button}</span>
						</Tooltip>
					);
				})}
				<Button variant="ghost" size="sm" disabled={exporting} icon={<Save size={14} />} onClick={onExport}>
					{exporting ? "Exporting…" : "Export diagnostics"}
				</Button>
			</div>
		</DiagnosticsSection>
	);
}

export function TaskDiagnosticsPanel({
	workspaceId,
	taskId,
}: {
	workspaceId: string | null;
	taskId: string | null;
}): React.ReactElement | null {
	const { diagnostics, isLoading, isRefreshing, refetch, runAction, pendingAction, exportBundle, exporting } =
		useTaskDiagnostics(workspaceId, taskId);
	const [open, setOpen] = useState(false);

	if (taskId === null) {
		return null;
	}

	const handleOpenPath = (path: string) => {
		void openFileOnHost(workspaceId, path).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({ intent: "danger", message: `Could not open path: ${message}` });
		});
	};

	const needsAttention = diagnostics?.needsAttention ?? false;

	return (
		<div className="shrink-0 border-b border-divider bg-surface-1">
			<RadixCollapsible.Root open={open} onOpenChange={setOpen}>
				<div
					className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 select-none"
					role="button"
					aria-expanded={open}
					onClick={(event) => {
						// Interactive children (refresh, phase tooltip) don't toggle the panel.
						if ((event.target as HTMLElement).closest("button")) {
							return;
						}
						setOpen((current) => !current);
					}}
				>
					<ChevronDown
						size={14}
						className={cn("shrink-0 text-text-secondary transition-transform", !open && "-rotate-90")}
					/>
					<span className="text-[12px] font-semibold text-text-secondary">Diagnostics</span>
					{diagnostics ? (
						<TaskPhaseBadge
							summary={{
								phase: diagnostics.phase,
								needsAttention: diagnostics.needsAttention,
								blockedReason: diagnostics.blockedReason,
							}}
						/>
					) : (
						<span className="text-[12px] text-text-tertiary">{isLoading ? "Loading…" : "Unavailable"}</span>
					)}
					{needsAttention && diagnostics?.blockedReason ? (
						<span
							className="min-w-0 flex-1 truncate text-[12px] text-status-red"
							title={diagnostics.blockedReason}
						>
							{diagnostics.blockedReason}
						</span>
					) : (
						<span className="flex-1" />
					)}
					<Button
						variant="ghost"
						size="sm"
						icon={<RefreshCw size={13} className={isRefreshing ? "animate-spin" : undefined} />}
						onClick={() => void refetch()}
						aria-label="Refresh diagnostics"
					/>
				</div>
				<RadixCollapsible.Content>
					{diagnostics ? (
						<div className="max-h-72 overflow-y-auto border-t border-divider">
							<PhaseSection response={diagnostics} />
							<GitSection response={diagnostics} onOpenPath={handleOpenPath} />
							<PreservedWorkSection response={diagnostics} />
							<ContextUsageSection response={diagnostics} />
							<ActionsSection
								response={diagnostics}
								pendingAction={pendingAction}
								onRunAction={(action) => void runAction(action)}
								onExport={() => void exportBundle()}
								exporting={exporting}
							/>
						</div>
					) : (
						<div className="border-t border-divider px-3 py-3 text-[12px] text-text-tertiary">
							{isLoading ? "Loading diagnostics…" : "Diagnostics are unavailable for this task."}
						</div>
					)}
				</RadixCollapsible.Content>
			</RadixCollapsible.Root>
		</div>
	);
}
