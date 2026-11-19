import type { AutoMergePolicy, RuntimeBoardData } from "../core/api-contract";
import { updateTaskPrSettings } from "../core/task-board-mutations";
import { isTrackingSupportedPr, parseCanonicalPrKey } from "./pr-key-parsing";
import { PR_OWNER_ACTIVE_COLUMNS, resolveCardAutomationPrKey } from "./pr-owner-selection";

/** Resolve policies outside the board lock; revalidate cards inside it. */
export async function prepareAutoMergeArming(
	board: RuntimeBoardData,
	loadPolicy: (repository: string) => Promise<AutoMergePolicy | null>,
): Promise<((current: RuntimeBoardData) => RuntimeBoardData) | null> {
	const candidates = board.columns
		.filter((column) => PR_OWNER_ACTIVE_COLUMNS.has(column.id))
		.flatMap((column) =>
			column.cards.filter(
				(card) => card.autoMergeWhenApproved !== false && card.armedAutoMergePolicyRevision === undefined,
			),
		);
	const policies = new Map<string, AutoMergePolicy | null>();
	for (const card of candidates) {
		const key = resolveCardAutomationPrKey(card).key;
		const parsed = key ? parseCanonicalPrKey(key) : null;
		if (key && parsed && isTrackingSupportedPr(key) && !policies.has(parsed.repository)) {
			policies.set(parsed.repository, await loadPolicy(parsed.repository));
		}
	}
	if (![...policies.values()].some((policy) => policy !== null)) return null;
	return (current) => {
		let next = current;
		for (const column of current.columns) {
			if (!PR_OWNER_ACTIVE_COLUMNS.has(column.id)) continue;
			for (const card of column.cards) {
				if (card.autoMergeWhenApproved === false || card.armedAutoMergePolicyRevision !== undefined) continue;
				const candidate = candidates.find((item) => item.id === card.id);
				if (!candidate || (candidate.settingsRevision ?? 0) !== (card.settingsRevision ?? 0)) continue;
				const key = resolveCardAutomationPrKey(card).key;
				if (!key || key !== resolveCardAutomationPrKey(candidate).key) continue;
				const parsed = parseCanonicalPrKey(key);
				const policy = parsed ? policies.get(parsed.repository) : null;
				if (!policy) continue;
				// Never re-arm policy drift automatically. Explicit false always
				// wins, including a disable racing the policy read above.
				next = updateTaskPrSettings(
					next,
					card.id,
					{
						autoMergeWhenApproved: true,
						expectedSettingsRevision: card.settingsRevision ?? 0,
					},
					Date.now(),
					{ autoMergePolicy: policy },
				).board;
			}
		}
		return next;
	};
}
