// PRTRACK-1: client-side mirrors of the server's PR automation resolution.
// The server (getTaskTrackingState) remains the authoritative source; these
// helpers only decide the lifecycle gate and simple local states.

import type { RuntimeTaskPullRequest } from "@/runtime/types";
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

export interface PrInstalledConsumerFlags {
	comments: boolean;
	mergeCompletion: boolean;
}

/**
 * True when an installed enabled consumer owns this card's linked PR
 * workflow: legacy automatic completion (browser auto-actions, CLI,
 * deterministic delivery) must not move the card to Done.
 */
export function isPrLifecycleGated(card: BoardCard, installed: PrInstalledConsumerFlags): boolean {
	if (!cardHasResolvableAutomationPr(card)) {
		return false;
	}
	return (
		(card.autoAddressComments === true && installed.comments) ||
		(card.autoFinishOnMerge === true && installed.mergeCompletion)
	);
}

/** The task ids whose legacy completion is gated by installed PR consumers. */
export function computePrLifecycleGatedTaskIds(
	board: BoardData,
	installed: PrInstalledConsumerFlags,
): ReadonlySet<string> {
	const ids = new Set<string>();
	if (!installed.comments && !installed.mergeCompletion) {
		return ids;
	}
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (isPrLifecycleGated(card, installed)) {
				ids.add(card.id);
			}
		}
	}
	return ids;
}
