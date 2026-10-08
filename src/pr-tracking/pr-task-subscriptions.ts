// PRTRACK-1: live task-derived subscriptions.
//
// Subscription demand is ALWAYS derived from current task state (column,
// PR link, selection, checkboxes) intersected with the installed-consumer
// registry. An enabled checkbox against an uninstalled consumer never
// produces demand (and renders "Feature unavailable"). Reconciling on every
// real task change and at startup removes demand when tasks become
// ineligible; consumers are not sticky in-memory objects.
import type { RuntimeBoardColumnId, RuntimePrConsumerKind } from "../core/api-contract";
import type { PrInstalledConsumers } from "./pr-consumer-registry";
import { PR_OWNER_ACTIVE_COLUMNS, type PrBoardSnapshot, resolveCardAutomationPrKey } from "./pr-owner-selection";
import type { PrTrackingSubscriptionDescriptor, SubscriptionAddResult } from "./pr-tracking-coordinator";

export type { PrBoardSnapshot };

export interface PrTaskSubscriptionSource {
	/** Boards of ALL currently managed workspaces. */
	listBoards(): Promise<PrBoardSnapshot[]>;
	installedConsumers(): PrInstalledConsumers;
}

/** The coordinator surface needed to reconcile task-derived subscriptions. */
export interface PrSubscriptionController {
	addSubscription(descriptor: PrTrackingSubscriptionDescriptor): Promise<SubscriptionAddResult>;
	removeSubscription(workspaceId: string, taskId: string): Promise<void>;
	listSubscriptions(): Array<{
		workspaceId: string;
		taskId: string;
		canonicalPrKey: string;
		column: string;
		consumers: Record<RuntimePrConsumerKind, boolean>;
	}>;
}

export interface PrTaskSubscriptionDemand {
	workspaceId: string;
	taskId: string;
	canonicalPrKey: string;
	column: RuntimeBoardColumnId;
	consumers: Record<RuntimePrConsumerKind, boolean>;
}

function subscriptionKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

function sameConsumers(a: Record<RuntimePrConsumerKind, boolean>, b: Record<RuntimePrConsumerKind, boolean>): boolean {
	return a.comments === b.comments && a.mergeCompletion === b.mergeCompletion;
}

/**
 * Compute the desired subscription set: cards in in_progress/review whose
 * automation PR is resolvable (explicit selection or sole link) and whose
 * checkboxes are enabled against INSTALLED consumers.
 */
export function computeTaskSubscriptionDemand(
	boards: PrBoardSnapshot[],
	installed: PrInstalledConsumers,
): PrTaskSubscriptionDemand[] {
	const demands: PrTaskSubscriptionDemand[] = [];
	for (const { workspaceId, board } of boards) {
		for (const column of board.columns) {
			if (!PR_OWNER_ACTIVE_COLUMNS.has(column.id)) {
				continue;
			}
			for (const card of column.cards) {
				const resolved = resolveCardAutomationPrKey(card);
				if (!resolved.key) {
					continue;
				}
				const consumers: Record<RuntimePrConsumerKind, boolean> = {
					comments: card.autoAddressComments === true && installed.comments,
					mergeCompletion: card.autoFinishOnMerge === true && installed.mergeCompletion,
				};
				if (!consumers.comments && !consumers.mergeCompletion) {
					continue;
				}
				demands.push({
					workspaceId,
					taskId: card.id,
					canonicalPrKey: resolved.key,
					column: column.id,
					consumers,
				});
			}
		}
	}
	return demands;
}

/**
 * Reconcile the coordinator's subscriptions with the task-derived demand:
 * add missing, update changed (remove + add so eligibility re-evaluates),
 * and remove orphaned demand.
 */
export async function reconcileTaskSubscriptions(
	controller: PrSubscriptionController,
	source: PrTaskSubscriptionSource,
): Promise<{ added: string[]; removed: string[]; updated: string[] }> {
	const installed = source.installedConsumers();
	const boards = await source.listBoards();
	const demands = computeTaskSubscriptionDemand(boards, installed);
	const desiredByTask = new Map(demands.map((d) => [subscriptionKey(d.workspaceId, d.taskId), d]));
	const current = controller.listSubscriptions();
	const added: string[] = [];
	const removed: string[] = [];
	const updated: string[] = [];
	for (const demand of demands) {
		const key = subscriptionKey(demand.workspaceId, demand.taskId);
		const existing = current.find((s) => subscriptionKey(s.workspaceId, s.taskId) === key);
		if (
			existing &&
			existing.canonicalPrKey === demand.canonicalPrKey &&
			sameConsumers(existing.consumers, demand.consumers)
		) {
			continue;
		}
		if (existing) {
			await controller.removeSubscription(existing.workspaceId, existing.taskId);
		}
		await controller.addSubscription({
			workspaceId: demand.workspaceId,
			taskId: demand.taskId,
			canonicalPrKey: demand.canonicalPrKey,
			column: demand.column,
			consumers: demand.consumers,
		});
		if (existing) {
			updated.push(key);
		} else {
			added.push(key);
		}
	}
	for (const sub of current) {
		const key = subscriptionKey(sub.workspaceId, sub.taskId);
		if (!desiredByTask.has(key)) {
			await controller.removeSubscription(sub.workspaceId, sub.taskId);
			removed.push(key);
		}
	}
	return { added, removed, updated };
}
