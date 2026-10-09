// PRTRACK-1: shared lifecycle gate.
//
// The single arbitration point that keeps the browser, the CLI, and
// deterministic delivery from competing with PR-driven lifecycle. With zero
// real consumers registered, the gate is always false and legacy automation
// behaves exactly as before; the gate activates only when an installed
// enabled consumer owns the task's linked PR workflow.
import type { RuntimeBoardCard } from "../core/api-contract";
import type { PrInstalledConsumers } from "./pr-consumer-registry";
import { resolveCardAutomationPrKey } from "./pr-owner-selection";

export interface PrLifecycleGateInput {
	card: RuntimeBoardCard;
	installed: PrInstalledConsumers;
}

export interface PrLifecycleGateResult {
	/**
	 * True when an installed enabled consumer owns this task's linked PR
	 * workflow: legacy clean-tree / PR-delivery completion must not run
	 * (browser auto-actions, CLI `task complete`, deterministic delivery).
	 */
	legacyCompletionGated: boolean;
	/**
	 * True when autoFinishOnMerge is persisted true AND the merge consumer is
	 * installed: delivery that pushes/creates the PR with a clean worktree
	 * leaves the task In Review — never Done.
	 */
	mergeFinishesInReview: boolean;
}

export function evaluatePrLifecycleGate(input: PrLifecycleGateInput): PrLifecycleGateResult {
	const { card, installed } = input;
	const resolved = resolveCardAutomationPrKey(card);
	const workflowOwned = resolved.key !== null;
	const commentsOwned = workflowOwned && card.autoAddressComments === true && installed.comments;
	const mergeOwned = workflowOwned && card.autoFinishOnMerge === true && installed.mergeCompletion;
	return {
		legacyCompletionGated: commentsOwned || mergeOwned,
		mergeFinishesInReview: mergeOwned,
	};
}
