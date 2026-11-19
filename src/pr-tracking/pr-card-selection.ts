import type { RuntimeBoardCard } from "../core/api-contract";
import { parsePullRequestUrl } from "../core/pull-request-links";
import { toCanonicalPrKey } from "./pr-key-parsing";

/** The canonical PR keys the card links (unparseable links are skipped). */
export function getCardLinkedPrKeys(card: RuntimeBoardCard): string[] {
	const keys: string[] = [];
	for (const link of card.pullRequests ?? []) {
		const parsed = parsePullRequestUrl(link.url);
		if (!parsed) {
			continue;
		}
		keys.push(
			toCanonicalPrKey({
				provider: parsed.provider,
				host: parsed.host,
				repository: parsed.repository,
				number: parsed.number,
			}),
		);
	}
	return keys;
}

/**
 * The PR this card drives automation for: an explicit selection when it is
 * still linked, otherwise the sole link when there is exactly one. null =
 * nothing selectable (none, or ambiguous). A selection that is no longer
 * linked (the link was removed) reads as unselected, so a dangling
 * selection can never keep driving demand, gates, or ownership.
 */
export function resolveCardAutomationPrKey(card: RuntimeBoardCard): {
	key: string | null;
	ambiguous: boolean;
	candidates: string[];
} {
	const linked = getCardLinkedPrKeys(card);
	const selection = card.selectedAutomationPrKey;
	if (selection && linked.includes(selection)) {
		return { key: selection, ambiguous: false, candidates: linked };
	}
	if (linked.length === 1) {
		return { key: linked[0] ?? null, ambiguous: false, candidates: linked };
	}
	if (linked.length > 1) {
		return { key: null, ambiguous: true, candidates: linked };
	}
	return { key: null, ambiguous: false, candidates: [] };
}
