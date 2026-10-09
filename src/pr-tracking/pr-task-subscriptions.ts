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
	/**
	 * Optional single-workspace board read for the poll-time backstop, so a
	 * per-PR revalidation never enumerates every workspace.
	 */
	listBoard?: (workspaceId: string) => Promise<PrBoardSnapshot | null>;
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
 *
 * Zero-consumer short-circuit: when no consumer is installed there can be no
 * demand, so the pass never reads any board from disk — it only drains the
 * in-memory subscription set (e.g. after a consumer unregisters).
 */
export interface PrTaskReconcileOptions {
	/**
	 * Poll-time backstop: revalidate ONLY the subscriptions already held for
	 * this canonical PR, reading each task's own board (no full workspace
	 * enumeration). New demand for the PR is picked up by the full pass.
	 */
	onlyPr?: string;
}

export async function reconcileTaskSubscriptions(
	controller: PrSubscriptionController,
	source: PrTaskSubscriptionSource,
	options: PrTaskReconcileOptions = {},
): Promise<{ added: string[]; removed: string[]; updated: string[] }> {
	const installed = source.installedConsumers();
	if (options.onlyPr) {
		const added: string[] = [];
		const removed: string[] = [];
		const updated: string[] = [];
		const subs = controller.listSubscriptions().filter((sub) => sub.canonicalPrKey === options.onlyPr);
		for (const sub of subs) {
			const snapshot = source.listBoard ? await source.listBoard(sub.workspaceId) : null;
			const demand = snapshot
				? computeTaskSubscriptionDemand([snapshot], installed).find((d) => d.taskId === sub.taskId)
				: undefined;
			if (!demand || demand.canonicalPrKey !== sub.canonicalPrKey) {
				await controller.removeSubscription(sub.workspaceId, sub.taskId);
				removed.push(subscriptionKey(sub.workspaceId, sub.taskId));
			} else if (demand.column !== sub.column || !sameConsumers(demand.consumers, sub.consumers)) {
				await controller.removeSubscription(sub.workspaceId, sub.taskId);
				await controller.addSubscription({
					workspaceId: demand.workspaceId,
					taskId: demand.taskId,
					canonicalPrKey: demand.canonicalPrKey,
					column: demand.column,
					consumers: demand.consumers,
				});
				updated.push(subscriptionKey(sub.workspaceId, sub.taskId));
			}
		}
		return { added, removed, updated };
	}
	let demands: PrTaskSubscriptionDemand[];
	if (!installed.comments && !installed.mergeCompletion) {
		demands = [];
	} else {
		const boards = await source.listBoards();
		demands = computeTaskSubscriptionDemand(boards, installed);
	}
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

/**
 * A single-flight reconcile pass: concurrent triggers (startup, board save,
 * PR link add/remove, poll-time backstop, consumer registration) queue on
 * ONE chain, so listBoards/add/remove sequences never interleave. Returns a
 * pass function; the chain always ends resolved (failures are reported to
 * `onError`, never propagated to the trigger).
 */
export function createReconcilePass(
	controller: PrSubscriptionController,
	source: PrTaskSubscriptionSource,
	onError?: (error: unknown) => void,
): (options?: PrTaskReconcileOptions) => Promise<void> {
	let chain: Promise<void> = Promise.resolve();
	return (options) => {
		// Every trigger queues a pass after the in-flight one: the
		// queued pass re-reads demand fresh, so a coalesced trigger never
		// runs on a board view older than the trigger that queued it.
		chain = chain
			.then(async () => {
				await reconcileTaskSubscriptions(controller, source, options);
			})
			.catch((error: unknown) => {
				onError?.(error);
			});
		return chain;
	};
}
