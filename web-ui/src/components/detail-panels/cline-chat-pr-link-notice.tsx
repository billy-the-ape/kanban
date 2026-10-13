// PRLINK-8: lightweight PR-linking notice for the latest completed native
// chat send. Rendered under the composer; local UI state only (may disappear
// on reload, never persisted or sent to the model). Link/Remove actions call
// the existing workspace PR-link mutations with pending/error states and
// guard late callbacks against the captured task/workspace scope.
import { getPullRequestIdentityKey } from "@runtime-pull-request-links";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskChatPrLinking, RuntimeTaskChatPrLinkingLink } from "@/runtime/types";

interface LinkActionState {
	pending: boolean;
	error: string | null;
	/** "linked" when an add succeeded; "removed" when a remove succeeded. */
	done: "linked" | "removed" | null;
}

const IDLE_ACTION_STATE: LinkActionState = { pending: false, error: null, done: null };

function formatPrLabel(link: RuntimeTaskChatPrLinkingLink): string {
	return `${link.repository}#${link.number}`;
}

export interface ClineChatPrLinkNoticeProps {
	taskId: string;
	linking: RuntimeTaskChatPrLinking;
	workspaceId: string | null;
	/** Clears the whole notice (used after a successful remove). */
	onDismiss: () => void;
}

function useLinkActions(taskId: string, workspaceId: string | null, onDismiss: () => void) {
	const [actionByLink, setActionByLink] = useState<Record<string, LinkActionState>>({});
	const scopeRef = useRef({ taskId, workspaceId, dismissed: false });
	scopeRef.current = { taskId, workspaceId, dismissed: false };

	useEffect(() => {
		setActionByLink({});
	}, [workspaceId]);

	const runAction = useCallback(
		async (key: string, action: "add" | "remove", url: string): Promise<void> => {
			const capturedWorkspaceId = workspaceId;
			if (!capturedWorkspaceId || scopeRef.current.dismissed) {
				return;
			}
			setActionByLink((current) => ({
				...current,
				[key]: { pending: true, error: null, done: current[key]?.done ?? null },
			}));
			let response: { ok: boolean; error?: string };
			try {
				const client = getRuntimeTrpcClient(capturedWorkspaceId);
				response =
					action === "add"
						? await client.workspace.addTaskPullRequest.mutate({ taskId: scopeRef.current.taskId, url })
						: await client.workspace.removeTaskPullRequest.mutate({ taskId: scopeRef.current.taskId, url });
			} catch (error) {
				response = { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
			// Late-callback guard: a task/workspace switch unmounts or retargets
			// this notice; never apply a stale result to the new scope.
			if (scopeRef.current.workspaceId !== capturedWorkspaceId || scopeRef.current.dismissed) {
				return;
			}
			if (!response.ok) {
				setActionByLink((current) => ({
					...current,
					[key]: {
						pending: false,
						error:
							response.error ??
							(action === "add" ? "Could not link the pull request." : "Could not remove the pull request."),
						done: null,
					},
				}));
				return;
			}
			if (action === "remove") {
				scopeRef.current.dismissed = true;
				onDismiss();
				return;
			}
			setActionByLink((current) => ({
				...current,
				[key]: { pending: false, error: null, done: "linked" },
			}));
		},
		[onDismiss, workspaceId],
	);

	return { actionByLink, runAction };
}

export function ClineChatPrLinkNotice({
	taskId,
	linking,
	workspaceId,
	onDismiss,
}: ClineChatPrLinkNoticeProps): ReactElement {
	const { actionByLink, runAction } = useLinkActions(taskId, workspaceId, onDismiss);

	const renderLinkRow = (
		link: RuntimeTaskChatPrLinkingLink,
		allowAdd: boolean,
		allowRemove: boolean,
	): ReactElement => {
		const key = getPullRequestIdentityKey(link);
		const action = actionByLink[key] ?? IDLE_ACTION_STATE;
		const label = formatPrLabel(link);
		return (
			<div key={key} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				{action.done === "removed" ? (
					<span className="text-text-tertiary">Removed {label}</span>
				) : action.done === "linked" || linking.status === "already_linked" ? (
					<span className="text-status-green">
						{linking.status === "already_linked" ? "Already linked" : "Linked"} {label}
					</span>
				) : linking.status === "linked" ? (
					<span className="text-status-green">Linked {label}</span>
				) : link.alreadyLinked ? (
					<span className="text-text-tertiary">Already linked {label}</span>
				) : (
					<span className="text-text-secondary">{label}</span>
				)}
				{allowAdd && action.done !== "linked" && linking.status !== "already_linked" ? (
					<Button
						variant="default"
						size="sm"
						disabled={action.pending || workspaceId === null}
						onClick={() => void runAction(key, "add", link.url)}
					>
						{action.pending ? (
							<>
								<Spinner size={12} /> Linking…
							</>
						) : (
							`Link ${label} to this task`
						)}
					</Button>
				) : null}
				{allowRemove && linking.status === "linked" && action.done !== "removed" ? (
					<Button
						variant="ghost"
						size="sm"
						disabled={action.pending || workspaceId === null}
						onClick={() => void runAction(key, "remove", link.url)}
					>
						{action.pending ? (
							<>
								<Spinner size={12} /> Removing…
							</>
						) : (
							"Remove link"
						)}
					</Button>
				) : null}
				{action.error ? <span className="text-status-red">{action.error}</span> : null}
			</div>
		);
	};

	return (
		<div className="flex flex-col gap-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
			{linking.status === "failed" ? (
				<p className="m-0 text-status-orange">Message sent; PR link could not be saved.</p>
			) : null}
			{linking.error ? <p className="m-0 text-text-tertiary">{linking.error}</p> : null}
			{linking.links.map((link) =>
				renderLinkRow(link, allowAddFor(linking.status, link), linking.status === "linked"),
			)}
		</div>
	);
}

// Add is offered for suggestions and for a failed auto-link (the normal Add
// action); already-linked identities never get a duplicate button.
function allowAddFor(status: RuntimeTaskChatPrLinking["status"], link: RuntimeTaskChatPrLinkingLink): boolean {
	return (status === "suggestions" || status === "failed") && !link.alreadyLinked;
}
