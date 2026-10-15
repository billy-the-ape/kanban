// PRTRACK-1: client-side mirrors of the server's PR automation resolution.
// The server (getTaskTrackingState) remains the authoritative source; these
// helpers only decide the lifecycle gate and simple local states.

import type { RuntimeAgentId, RuntimeTaskPullRequest } from "@/runtime/types";
import type { BoardCard, BoardData } from "@/types";

/**
 * Canonical PR key for a card link, mirroring the server's identity key
 * (provider|host|repository|number, host/repository lowercased).
 */
export function toCanonicalPrKeyForLink(link: RuntimeTaskPullRequest): string | null {
	const provider = typeof link.provider === "string" ? link.provider : "";
	const host = typeof link.host === "string" ? link.host.toLowerCase() : "";
	const repository = typeof link.repository === "string" ? link.repository.toLowerCase() : "";
	if (!provider || !host || !repository || !Number.isSafeInteger(link.number) || link.number <= 0) {
		return null;
	}
	return `${provider}|${host}|${repository}|${link.number}`;
}

/**
 * Whether a card has a resolvable Automation PR: an explicit selection, or
 * exactly one linked PR (the server auto-selects a single matching link).
 */
export function cardHasResolvableAutomationPr(card: BoardCard): boolean {
	if (typeof card.selectedAutomationPrKey === "string" && card.selectedAutomationPrKey.length > 0) {
		return true;
	}
	const links = card.pullRequests ?? [];
	return links.length === 1;
}

/**
 * True when an installed enabled consumer owns this card's linked PR
 * workflow: legacy automatic completion (browser auto-actions, CLI,
 * deterministic delivery) must not move the card to Done. Both consumers
 * (comment follow-up and merge completion) are always installed, so the
 * gate keys off the card's own automation checkboxes — except the comments
 * half, which only owns tasks the comment automation can serve (native
 * Cline; an unset card agentId falls back to the workspace's selected
 * agent).
 */
export function isPrLifecycleGated(card: BoardCard, workspaceAgentId: RuntimeAgentId | null): boolean {
	if (!cardHasResolvableAutomationPr(card)) {
		return false;
	}
	if (card.autoFinishOnMerge === true) {
		return true;
	}
	const effectiveAgentId = card.agentId ?? workspaceAgentId;
	return card.autoAddressComments === true && effectiveAgentId === "cline";
}

/** The task ids whose legacy completion is gated by the installed PR consumers. */
export function computePrLifecycleGatedTaskIds(
	board: BoardData,
	workspaceAgentId: RuntimeAgentId | null,
): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (isPrLifecycleGated(card, workspaceAgentId)) {
				ids.add(card.id);
			}
		}
	}
	return ids;
}
