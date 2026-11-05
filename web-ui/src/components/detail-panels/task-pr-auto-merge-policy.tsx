// AM-5: the repository CI policy affordance for the task's selected
// Automation PR. Shows the configured required check names, merge method
// and policy revision; lets the operator configure the durable policy
// (revision-checked); and suggests the exact check names OBSERVED on the
// PR's current head from one bounded server-side evidence read.
// Suggestions only: nothing is saved until the operator confirms.

import { useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { AutoMergePolicy } from "@/runtime/types";

const MERGE_METHOD_LABELS: Record<AutoMergePolicy["mergeMethod"], string> = {
	merge: "Create a merge commit",
	squash: "Squash and merge",
	rebase: "Rebase and merge",
};

function parseNamesInput(raw: string): string[] {
	return [
		...new Set(
			raw
				.split(/\r?\n/)
				.map((name) => name.trim())
				.filter((name) => name.length > 0),
		),
	];
}

export function TaskPrAutoMergePolicyPanel({
	workspaceId,
	taskId,
	repository,
	policy,
	policyLoading,
	onSaved,
}: {
	workspaceId: string;
	taskId: string;
	repository: string;
	policy: AutoMergePolicy | null;
	/** True while the parent's policy query is still loading. */
	policyLoading: boolean;
	onSaved: () => Promise<void> | void;
}): React.ReactElement {
	const client = getRuntimeTrpcClient(workspaceId);
	const [editing, setEditing] = useState(false);
	const [namesDraft, setNamesDraft] = useState("");
	const [methodDraft, setMethodDraft] = useState<AutoMergePolicy["mergeMethod"]>(policy?.mergeMethod ?? "merge");
	const [saving, setSaving] = useState(false);
	const [suggestionsLoading, setSuggestionsLoading] = useState(false);
	const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);

	const startEditing = (): void => {
		setNamesDraft((policy?.requiredChecks ?? []).join("\n"));
		setMethodDraft(policy?.mergeMethod ?? "merge");
		setSaveError(null);
		setEditing(true);
	};

	// Suggest the exact names observed on the PR's current head. This
	// only ADDS names to the draft the operator can still edit; saving is
	// an explicit operator confirmation (no autofill).
	const suggestFromPr = async (): Promise<void> => {
		setSuggestionsLoading(true);
		setSuggestionsError(null);
		try {
			const result = await client.workspace.prTracking.listAutoMergeCheckCandidates.query({ taskId });
			if (!result.ok) {
				setSuggestionsError("Check names could not be read from the PR right now.");
				return;
			}
			if (result.candidates.length === 0) {
				setSuggestionsError("No check runs were observed on the PR's current head yet.");
				return;
			}
			const existing = new Set(parseNamesInput(namesDraft));
			const additions = result.candidates.filter((candidate) => !existing.has(candidate.name)).map((c) => c.name);
			if (additions.length === 0) {
				return;
			}
			setNamesDraft(
				(current) => (current.trim().length > 0 ? `${current.replace(/\r?\n$/, "")}\n` : "") + additions.join("\n"),
			);
		} catch {
			setSuggestionsError("Check names could not be read from the PR right now.");
		} finally {
			setSuggestionsLoading(false);
		}
	};

	const save = async (): Promise<void> => {
		const requiredChecks = parseNamesInput(namesDraft);
		setSaving(true);
		setSaveError(null);
		try {
			const result = await client.workspace.prTracking.updateAutoMergePolicy.mutate({
				repository,
				requiredChecks,
				mergeMethod: methodDraft,
				expectedRevision: policy?.revision ?? 0,
			});
			if (!result.ok) {
				setSaveError(
					result.reason === "conflict"
						? "The policy changed while you were editing; reload and review before saving."
						: "The policy could not be saved.",
				);
				return;
			}
			setEditing(false);
			await onSaved();
		} catch {
			setSaveError("The policy could not be saved.");
		} finally {
			setSaving(false);
		}
	};

	if (!editing) {
		return (
			<div className="mt-2 rounded-md border border-divider bg-surface-1 px-2 py-1.5">
				<div className="flex items-center justify-between gap-2 text-xs text-text-secondary">
					<span className="truncate" title={`CI policy for ${repository}`}>
						Repository CI policy — {repository}
					</span>
					<button
						type="button"
						onClick={startEditing}
						className="shrink-0 cursor-pointer rounded-md border border-bright bg-surface-2 px-2 py-0.5 text-xs text-text-primary hover:bg-surface-3"
					>
						Configure
					</button>
				</div>
				{policyLoading ? (
					<div className="mt-1 text-[11px] text-text-tertiary">Loading policy…</div>
				) : policy === null ? (
					<div className="mt-1 text-[11px] text-text-tertiary">No CI policy configured yet.</div>
				) : (
					<div className="mt-1 flex flex-col gap-0.5 text-[11px] text-text-tertiary">
						<span>
							Required checks: {policy.requiredChecks.length > 0 ? policy.requiredChecks.join(", ") : "none"}
						</span>
						<span>
							Merge method: {MERGE_METHOD_LABELS[policy.mergeMethod]} · revision {policy.revision}
						</span>
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="mt-2 flex flex-col gap-1.5 rounded-md border border-divider bg-surface-1 px-2 py-1.5">
			<div className="text-xs text-text-primary">Configure CI policy for {repository}</div>
			<label className="flex flex-col gap-0.5 text-[11px] text-text-secondary">
				Required check names (one per line; exact GitHub names)
				<textarea
					value={namesDraft}
					onChange={(event) => setNamesDraft(event.target.value)}
					rows={3}
					spellCheck={false}
					className="w-full resize-y rounded-md border border-bright bg-surface-2 px-2 py-1 font-mono text-xs text-text-primary focus:border-border-focus focus:outline-none"
				/>
			</label>
			<div className="flex items-center gap-2 text-xs text-text-secondary">
				<span className="shrink-0">Merge method</span>
				<select
					value={methodDraft}
					onChange={(event) => setMethodDraft(event.target.value as AutoMergePolicy["mergeMethod"])}
					aria-label="Merge method"
					className="rounded-md border border-bright bg-surface-2 px-2 py-1 text-xs text-text-primary"
				>
					{(["merge", "squash", "rebase"] as const).map((method) => (
						<option key={method} value={method}>
							{MERGE_METHOD_LABELS[method]}
						</option>
					))}
				</select>
			</div>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<button
					type="button"
					onClick={() => void suggestFromPr()}
					disabled={saving || suggestionsLoading}
					className="cursor-pointer rounded-md border border-bright bg-surface-2 px-2 py-1 text-xs text-text-primary hover:bg-surface-3 disabled:cursor-default disabled:opacity-50"
				>
					{suggestionsLoading ? "Reading PR checks…" : "Add names observed on the PR"}
				</button>
				<button
					type="button"
					onClick={() => void save()}
					disabled={saving || parseNamesInput(namesDraft).length === 0}
					className="cursor-pointer rounded-md border border-bright bg-surface-2 px-2 py-1 text-xs text-text-primary hover:bg-surface-3 disabled:cursor-default disabled:opacity-50"
				>
					{saving ? "Saving…" : "Save policy"}
				</button>
				<button
					type="button"
					onClick={() => setEditing(false)}
					disabled={saving}
					className="cursor-pointer rounded-md border border-bright bg-surface-1 px-2 py-1 text-xs text-text-secondary hover:bg-surface-3 disabled:cursor-default disabled:opacity-50"
				>
					Cancel
				</button>
			</div>
			<div
				className={
					saveError !== null || suggestionsError !== null
						? "text-[11px] text-status-red"
						: "text-[11px] text-text-tertiary"
				}
			>
				{saveError !== null
					? saveError
					: suggestionsError !== null
						? suggestionsError
						: "Suggestions are observed names only — confirm each one before saving. GitHub branch protections and rulesets may require more than this policy states."}
			</div>
		</div>
	);
}
