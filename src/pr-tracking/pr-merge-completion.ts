// MERGE-1: the merge completion consumer.
//
// Registers exactly one consumer kind on the existing coordinator. When a
// task with "Auto complete when the PR merges" enabled observes its linked
// PR in the merged state, the consumer reconciles idempotently:
//
//   - complete only when the PR is merged on the remote, the task's base
//     branch contains the merge commit, and the worktree carries no local
//     commits ahead of that base branch (discarding uncommitted/unpushed
//     work);
//   - block (needs human) when the base branch does not contain the merge
//     commit or the worktree has clean local commits;
//   - stay pending (retry on the next read, bounded by the coordinator's
//     reconciliation read budget) while a writer session is active or the
//     merge_completion reservation is held by another task;
//   - never rearm once a completion or a block is persisted (the binding's
//     mergeCompletion + terminalStop markers survive restarts);
//   - a task that was manually reopened from Done after a merge is not sent
//     back to Done by the SAME merge commit — only a later merge (a
//     different merge commit) completes it again.
//
// The observation flow per merged PR read:
//   idempotency checks -> card eligibility -> manual-reopen guard ->
//   writer check -> reservation -> worktree checks -> persist completion ->
//   complete the task (which fires the dispatch pass for waiting children).
import type { GitHubPrMergeCompletion, RuntimeBoardCard, RuntimeBoardColumnId } from "../core/api-contract";
import { GITHUB_PR_TRACKING_RECORD_SCHEMA_VERSION } from "../core/api-contract";
import { runGit } from "../workspace/git-utils";
import { PR_CONSUMER_READ_SOURCES, type PrConsumerObservation, type PrConsumerRegistry } from "./pr-consumer-registry";
import type { PrRecordStoreBase } from "./pr-record-store";
import { releasePrOperation, reservePrOperation } from "./pr-reservations";

export type PrMergeCompletionOutcome =
	| { action: "completed" }
	| { action: "blocked"; reason: string }
	| { action: "pending"; reason: string }
	| { action: "skipped"; reason: string };

/**
 * The worktree's relationship to the task's base branch, used to decide
 * whether the merge can be completed safely.
 */
export interface PrMergeWorktreeInspection {
	/** The task worktree path to reconcile; null when no worktree exists. */
	worktreePath: string | null;
	/** The worktree HEAD commit; null when it cannot be read. */
	worktreeHead: string | null;
	/** The resolved commit of the task's base branch. */
	baseSha: string;
	/** Whether the task's base branch contains the merge commit. */
	baseContainsMerge: boolean;
	/** Whether the worktree has uncommitted changes. */
	dirty: boolean;
	/** Commits reachable from the worktree HEAD but not from the base branch. */
	aheadOfBase: number;
}

export interface PrMergeCompletionDeps {
	store: PrRecordStoreBase;
	/** The card + its column for a task; null when the task is not on the board. */
	getTaskCard: (
		workspaceId: string,
		taskId: string,
	) => Promise<{ card: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null>;
	/** True when a live writer (terminal process, Cline task session, or review session) exists for the task. */
	isTaskWriterActive: (workspaceId: string, taskId: string) => Promise<boolean>;
	/**
	 * Persistently move the task to Done and fire the dispatch pass for
	 * waiting children. Must be idempotent; called AFTER the completion is
	 * persisted on the binding.
	 */
	completeTask: (workspaceId: string, taskId: string) => Promise<void>;
	/**
	 * Inspect the task worktree's relationship to its base branch. Null when
	 * the task has no worktree (nothing to reconcile). Injectable so tests
	 * avoid real git repositories.
	 */
	inspectWorktree?: (input: {
		task: { workspaceId: string; taskId: string };
		baseRef: string;
		mergeCommitSha: string;
	}) => Promise<PrMergeWorktreeInspection | null>;
	warn?: (message: string) => void;
	now?: () => number;
}

/**
 * Default worktree inspection: resolves the worktree and probes the git
 * repository directly (no remote, no model work).
 */
export async function defaultInspectWorktree(input: {
	workspacePath: string;
	worktreePath: string;
	baseRef: string;
	mergeCommitSha: string;
}): Promise<PrMergeWorktreeInspection> {
	const baseRefSpec = `${input.baseRef}^{commit}`;
	const [baseResult, ancestorResult, statusResult, headResult] = await Promise.all([
		runGit(input.workspacePath, ["rev-parse", baseRefSpec]),
		runGit(input.workspacePath, ["merge-base", "--is-ancestor", input.mergeCommitSha, baseRefSpec]),
		runGit(input.worktreePath, ["status", "--porcelain"]),
		runGit(input.worktreePath, ["rev-parse", "HEAD"]),
	]);
	if (!baseResult.ok || !baseResult.stdout) {
		throw new Error(`Cannot resolve base branch "${input.baseRef}": ${baseResult.error ?? "unknown git error"}`);
	}
	const baseSha = baseResult.stdout;
	const aheadResult = await runGit(input.worktreePath, ["rev-list", "--count", `${baseSha}..HEAD`]);
	if (!aheadResult.ok || !aheadResult.stdout) {
		throw new Error(`Cannot count worktree commits ahead of base: ${aheadResult.error ?? "unknown git error"}`);
	}
	return {
		worktreePath: input.worktreePath,
		worktreeHead: headResult.ok ? headResult.stdout || null : null,
		baseSha,
		// A missing/unknown merge commit reports exit 1 exactly like
		// "not an ancestor"; both mean the base does not contain it.
		baseContainsMerge: ancestorResult.ok,
		dirty: statusResult.ok ? statusResult.stdout.length > 0 : false,
		aheadOfBase: Number(aheadResult.stdout) || 0,
	};
}

function buildMergeCompletion(input: {
	binding: { linkGeneration: number };
	task: { workspaceId: string; taskId: string };
	prKey: string;
	status: GitHubPrMergeCompletion["status"];
	observedAt: number;
	completedAt: number | null;
	finalHeadSha: string | null;
	baseRepository: string | null;
	baseRef: string | null;
	mergeCommitSha: string | null;
	mergedAt: number | null;
	error: string | null;
}): GitHubPrMergeCompletion {
	return {
		schemaVersion: GITHUB_PR_TRACKING_RECORD_SCHEMA_VERSION,
		workspaceId: input.task.workspaceId,
		taskId: input.task.taskId,
		linkGeneration: input.binding.linkGeneration,
		prKey: input.prKey,
		finalHeadSha: input.finalHeadSha,
		baseRepository: input.baseRepository,
		baseRef: input.baseRef,
		mergeCommitSha: input.mergeCommitSha,
		mergedAt: input.mergedAt,
		observedAt: input.observedAt,
		status: input.status,
		completedAt: input.completedAt,
		error: input.error,
	};
}

/**
 * Reconcile one merged-PR observation for a task. Idempotent: every durable
 * effect is checked against the persisted binding before it is written, so
 * a redelivered observation (e.g. after a restart) never double-completes.
 */
export async function reconcileMergeCompletion(
	observation: PrConsumerObservation,
	deps: PrMergeCompletionDeps,
): Promise<PrMergeCompletionOutcome> {
	const now = (deps.now ?? Date.now)();
	const warn = deps.warn ?? (() => {});
	const task = observation.task;
	const prKey = observation.snapshot.canonicalPrKey;
	const metadata = observation.snapshot.metadata;
	const binding =
		observation.record.taskBindings.find(
			(item) => item.workspaceId === task.workspaceId && item.taskId === task.taskId,
		) ?? null;
	if (!binding) {
		return { action: "skipped", reason: "no_task_binding" };
	}
	if (metadata.state !== "merged") {
		return { action: "skipped", reason: "not_merged" };
	}
	const mergeCommitSha = metadata.mergeCommitSha;
	// Idempotency + manual-reopen guard: the SAME merge commit was already
	// consumed for this binding. A task manually reopened from Done is not
	// sent back to Done by the same merged PR; a later merge (a different
	// merge commit) completes it again.
	const prior = binding.mergeCompletion;
	if (
		prior !== null &&
		prior.status === "completed" &&
		mergeCommitSha !== null &&
		prior.mergeCommitSha === mergeCommitSha
	) {
		return { action: "skipped", reason: "merge_already_consumed" };
	}
	const found = await deps.getTaskCard(task.workspaceId, task.taskId);
	if (!found) {
		return { action: "skipped", reason: "task_missing" };
	}
	const card = found.card;
	if (card.autoFinishOnMerge !== true) {
		return { action: "skipped", reason: "preference_off" };
	}
	if (found.columnId !== "in_progress" && found.columnId !== "review") {
		return { action: "skipped", reason: "inactive_column" };
	}
	if (mergeCommitSha === null) {
		// Without the merge commit identity the base-branch check is
		// impossible; stay pending (the coordinator's bounded read budget
		// turns a persistent gap into "needs human").
		return { action: "pending", reason: "merge_commit_unavailable" };
	}
	const writerActive = await deps.isTaskWriterActive(task.workspaceId, task.taskId).catch(() => true);
	if (writerActive) {
		return { action: "pending", reason: "writer_active" };
	}
	const reservation = await reservePrOperation(deps.store, prKey, "merge_completion", task, {
		requireOwner: false,
		headRepository: metadata.headRepository ?? null,
		headRef: metadata.headRef ?? null,
		now: deps.now,
	});
	if (reservation.status !== "reserved") {
		return { action: "pending", reason: `reservation_${reservation.status}` };
	}
	const releaseHeld = true;
	try {
		// Worktree checks (a missing worktree means nothing to reconcile).
		let inspection: PrMergeWorktreeInspection | null = null;
		try {
			inspection = (await deps.inspectWorktree?.({ task, baseRef: card.baseRef, mergeCommitSha })) ?? null;
		} catch (error) {
			warn(`PR merge completion worktree inspection failed for ${task.taskId}: ${String(error)}`);
			return { action: "pending", reason: "worktree_inspection_failed" };
		}
		const completionIdentity = {
			binding: { linkGeneration: binding.linkGeneration },
			task,
			prKey,
			finalHeadSha: metadata.headSha ?? null,
			baseRepository: metadata.baseRepository ?? null,
			baseRef: metadata.baseRef ?? null,
			mergeCommitSha,
			mergedAt: metadata.mergedAt ?? null,
			observedAt: now,
		};
		const blockReason = inspection
			? !inspection.baseContainsMerge
				? "The task's base branch does not contain the PR merge commit."
				: inspection.aheadOfBase > 0
					? `The task worktree has ${inspection.aheadOfBase} local commit(s) not in the base branch.`
					: null
			: null;
		if (blockReason !== null) {
			const write = await deps.store.updateTaskBinding(prKey, task, undefined, (item) => ({
				...item,
				mergeCompletion: buildMergeCompletion({
					...completionIdentity,
					status: "blocked",
					completedAt: null,
					error: blockReason,
				}),
			}));
			if (!write.ok) {
				warn(`PR merge completion block write failed (${write.reason}); will retry`);
				return { action: "pending", reason: "block_write_failed" };
			}
			await deps.store.setTaskTerminalStop(prKey, task, {
				reason: "merged_unresolved",
				observedAt: now,
				reconciliationReads: binding.terminalStop?.reconciliationReads ?? 0,
			});
			warn(`PR merge completion blocked for ${task.taskId}: ${blockReason}`);
			return { action: "blocked", reason: blockReason };
		}
		// Discard local unpushed work so the worktree reconciles to the base
		// branch (the merged work already lives in the base).
		if (inspection?.worktreePath) {
			const needsReset = inspection.dirty || inspection.worktreeHead !== inspection.baseSha;
			if (needsReset) {
				const reset = await runGit(inspection.worktreePath, ["reset", "--hard", inspection.baseSha]);
				if (!reset.ok) {
					warn(
						`PR merge completion worktree reset failed for ${task.taskId}: ${reset.error ?? "unknown git error"}`,
					);
					return { action: "pending", reason: "worktree_reset_failed" };
				}
			}
		}
		// Persist the completion BEFORE completing the task: a crash in
		// between the two still never double-completes (the binding is the
		// idempotency source of truth).
		const write = await deps.store.updateTaskBinding(prKey, task, undefined, (item) => ({
			...item,
			mergeCompletion: buildMergeCompletion({
				...completionIdentity,
				status: "completed",
				completedAt: now,
				error: null,
			}),
		}));
		if (!write.ok) {
			warn(`PR merge completion write failed (${write.reason}); will retry`);
			return { action: "pending", reason: "completion_write_failed" };
		}
		await deps.store.setTaskTerminalStop(prKey, task, {
			reason: "merged_completed",
			observedAt: now,
			reconciliationReads: binding.terminalStop?.reconciliationReads ?? 0,
		});
		await deps.completeTask(task.workspaceId, task.taskId);
		return { action: "completed" };
	} finally {
		if (releaseHeld) {
			// The reservation always releases when the episode ends (success,
			// block, or a pending retry) so the next task can claim it.
			await releasePrOperation(deps.store, prKey, "merge_completion", task, deps.now).catch((error) => {
				warn(`PR merge completion reservation release failed: ${String(error)}`);
			});
		}
	}
}

/**
 * Register the merge completion consumer on the installed-consumer
 * registry. Production registers exactly this one consumer; the comment
 * consumer lands with COMMENT-0.
 */
export function registerMergeCompletionConsumer(registry: PrConsumerRegistry, deps: PrMergeCompletionDeps): void {
	registry.register({
		kind: "mergeCompletion",
		requiredReadSources: PR_CONSUMER_READ_SOURCES.mergeCompletion,
		onObservation: (observation) => reconcileMergeCompletion(observation, deps),
	});
}
