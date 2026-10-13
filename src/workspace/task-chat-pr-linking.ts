// PRLINK-8: PR linking derived from a native task chat send.
//
// Only the native `sendTaskChatMessage` route feeds this; terminal input,
// assistant messages, tool output, initial task prompts, history replay and
// home-agent sessions never do. The classification itself is pure (see
// `classifyTaskChatMessageForPrLink`); this module applies the result only
// after the actual send succeeded and re-reads the authoritative card so a
// false `changed` flag is never reported as success.
//
// Best-effort by contract: any failure here is reported as a sanitized
// `failed` status while the chat send itself stays ok. It must never throw
// or resend the user's message.
import type { RuntimeTaskChatPrLinking, RuntimeTaskChatPrLinkingLink } from "../core/api-contract";
import type { ParsedPullRequestLink } from "../core/pull-request-links";
import { classifyTaskChatMessageForPrLink, getPullRequestIdentityKey } from "../core/pull-request-links";
import { findTaskLocation } from "../core/task-board-mutations";
import { loadWorkspaceContext, loadWorkspaceState } from "../state/workspace-state";
import { recordTaskPullRequests } from "./task-pull-requests";

export interface ResolveTaskChatPrLinkingInput {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	/** Raw user text exactly as sent (server-side classification input). */
	text: string;
	/** Whether the send carried attached images (blocks the bare-URL shortcut). */
	hasImages: boolean;
	broadcast?: (workspaceId: string, workspacePath: string) => void | Promise<void>;
	now?: number;
}

function toChatPrLinkingLink(link: ParsedPullRequestLink, alreadyLinked: boolean): RuntimeTaskChatPrLinkingLink {
	return {
		provider: link.provider,
		host: link.host,
		repository: link.repository,
		number: link.number,
		url: link.url,
		alreadyLinked,
	};
}

/**
 * Resolves the PR-linking outcome for a completed native chat send. Returns
 * undefined when the message carries no candidates (the caller leaves the
 * response field absent). Never throws.
 */
export async function resolveTaskChatPrLinking(
	input: ResolveTaskChatPrLinkingInput,
): Promise<RuntimeTaskChatPrLinking | undefined> {
	const candidate = classifyTaskChatMessageForPrLink(input.text, input.hasImages);
	if (candidate.kind === "none") {
		return undefined;
	}
	if (candidate.kind === "auto_link") {
		return await applyAutoLink(input, candidate.link);
	}
	return await buildSuggestions(input, candidate.links);
}

async function applyAutoLink(
	input: ResolveTaskChatPrLinkingInput,
	link: ParsedPullRequestLink,
): Promise<RuntimeTaskChatPrLinking> {
	const linkPayload = toChatPrLinkingLink(link, false);
	const result = await recordTaskPullRequests({
		workspacePath: input.workspacePath,
		taskId: input.taskId,
		links: [link],
		source: "manual",
		now: input.now,
	});
	if (result.outcome === "recorded" || result.outcome === "duplicate") {
		// Broadcast only on an actual board write: a new link, or a
		// throttled duplicate observation that advanced lastSeenAt.
		if (result.changed) {
			void input.broadcast?.(input.workspaceId, input.workspacePath);
		}
		return result.outcome === "recorded"
			? { status: "linked", links: [linkPayload] }
			: { status: "already_linked", links: [toChatPrLinkingLink(link, true)] };
	}
	// no_task (card deleted race) and write failures keep the send ok and
	// surface a sanitized message; details are already logged by the recorder.
	return {
		status: "failed",
		links: [linkPayload],
		error: result.outcome === "no_task" ? "Task no longer exists." : "Could not save the PR link.",
	};
}

async function buildSuggestions(
	input: ResolveTaskChatPrLinkingInput,
	links: ParsedPullRequestLink[],
): Promise<RuntimeTaskChatPrLinking> {
	const linkedKeys = await getLinkedIdentityKeys(input.workspacePath, input.taskId);
	return {
		status: "suggestions",
		links: links.map((link) => toChatPrLinkingLink(link, linkedKeys.has(getPullRequestIdentityKey(link)))),
	};
}

/**
 * Identity keys already linked on the durable card. Read-only: suggestions
 * never write. Missing workspace/task (deleted race) means no linked keys.
 */
async function getLinkedIdentityKeys(workspacePath: string, taskId: string): Promise<Set<string>> {
	try {
		// The chat scope is an existing workspace; never auto-create one here.
		await loadWorkspaceContext(workspacePath, { autoCreateIfMissing: false });
		const state = await loadWorkspaceState(workspacePath);
		const found = findTaskLocation(state.board, taskId.trim());
		if (!found) {
			return new Set();
		}
		return new Set((found.task.pullRequests ?? []).map((entry) => getPullRequestIdentityKey(entry)));
	} catch {
		return new Set();
	}
}
