// MERGE-1: the merge completion consumer.
//
// Registers exactly one consumer kind on the existing coordinator. When a
// task with "Auto complete when the PR merges" enabled observes its linked
// PR in the merged state, the consumer reconciles idempotently:
//
//   - complete only when the PR is merged on the remote, the task's base
//     branch contains the merge commit, and the worktree carries no local
//     commits ahead of that base branch (discarding uncommitted/unpushed
//     work); the ahead-of-base count excludes the merged PR head so squash
//     and rebase merges do not read as "local commits";
//   - block (needs human) when the base branch does not contain the merge
//     commit or the worktree has clean local commits; states that cannot be
//     verified yet (unfetched merge commit, unfetched base) stay pending
//     and retry until the coordinator's bounded reconciliation budget
//     turns them into "needs human" — never a guessed block;
//   - stay pending (retry on the next read, bounded by the coordinator's
//     reconciliation read budget) while a writer session is active or the
//     merge_completion reservation is held by another task;
//   - never rearm once a completion or a block is persisted (the binding's
//     mergeCompletion + terminalStop markers survive restarts); a crash that
//     persisted the completion but never moved the board is recovered on the
//     next observation (the move is idempotent);
//   - a task that was manually reopened from Done after a merge (server-
//     derived manualReopenAt marker) is not sent back to Done by the SAME
//     merge commit — only a later merge (a different merge commit) completes
//     it again.
//
// The observation flow per merged PR read:
//   idempotency checks -> card eligibility -> writer check -> reservation ->
//   worktree checks -> complete the task (board move + dispatch pass) ->
//   persist completion (binding + terminal stop).
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
	/**
	 * Commits reachable from the worktree HEAD but neither from the base
	 * branch nor from the merged PR head (the merged work itself, so squash
	 * and rebase merges do not read as local commits).
	 */
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
	 * waiting children. Must be idempotent (a card already in Done is a
	 * no-op); called BEFORE the completion is persisted on the binding, so
	 * a failed move leaves the binding untouched and the bounded
	 * reconciliation reads retry from scratch.
	 */
	completeTask: (workspaceId: string, taskId: string) => Promise<void>;
	/**
	 * Inspect the task worktree's relationship to its base branch. Null when
	 * the task has no worktree (nothing to reconcile; the base-branch
	 * verification still runs). Injectable so tests avoid real git
	 * repositories.
	 */
	inspectWorktree?: (input: {
		task: { workspaceId: string; taskId: string };
		baseRef: string;
		baseRepository: string | null;
		mergeCommitSha: string;
		finalHeadSha: string | null;
	}) => Promise<PrMergeWorktreeInspection | null>;
	warn?: (message: string) => void;
	now?: () => number;
}

/**
 * Default worktree inspection: probes the git repository directly (no
 * model work). Best-effort fetches the landed merge commit, the PR head and
 * the base branch from the matching remote so a just-merged PR is
 * verifiable before the user pulls it. States that cannot be verified
 * (missing objects, unfetchable remote) throw — the caller turns that into
 * a retryable pending, never a guessed block.
 */
const WORKTREE_SYNC_TIMEOUT_MS = 15_000;

async function pickRemoteForBase(workspacePath: string, baseRepository: string | null): Promise<string | null> {
	const remotes = await runGit(workspacePath, ["remote", "-v"]);
	if (!remotes.ok || !remotes.stdout) {
		return null;
	}
	const entries: Array<{ name: string; url: string }> = [];
	for (const line of remotes.stdout.split("\n")) {
		const [name, url] = line.split("\t");
		if (name && url) {
			entries.push({ name, url });
		}
	}
	if (entries.length === 0) {
		return null;
	}
	const wanted = (baseRepository ?? "").trim().toLowerCase();
	if (wanted) {
		const match = entries.find((entry) => entry.url.toLowerCase().includes(wanted));
		if (match) {
			return match.name;
		}
	}
	const fallback = entries.find((entry) => entry.name === "origin") ?? entries[0];
	return fallback?.name ?? null;
}

export async function defaultInspectWorktree(input: {
	workspacePath: string;
	/** The task worktree to reconcile; null when the task has no worktree. */
	worktreePath: string | null;
	baseRef: string;
	baseRepository: string | null;
	mergeCommitSha: string;
	/** The merged PR head commit (used to exclude the merged work from the ahead-of-base count). */
	finalHeadSha: string | null;
}): Promise<PrMergeWorktreeInspection> {
	const { workspacePath, worktreePath, baseRef, mergeCommitSha, finalHeadSha } = input;
	const localBase = await runGit(workspacePath, ["rev-parse", `${baseRef}^{commit}`]);
	if (!localBase.ok || !localBase.stdout) {
		throw new Error(`Cannot resolve base branch "${baseRef}": ${localBase.error ?? "unknown git error"}`);
	}
	// Best-effort sync before verifying: fetch the landed merge commit and
	// the PR head (objects only), then the base branch (updates the
	// remote-tracking ref). A missing remote or a failed fetch falls back to
	// whatever is local; the availability checks below decide whether the
	// result is verifiable or a retryable pending.
	let baseSha = localBase.stdout;
	const remote = await pickRemoteForBase(workspacePath, input.baseRepository);
	if (remote) {
		const wantedObjects: string[] = [mergeCommitSha];
		if (finalHeadSha && finalHeadSha !== mergeCommitSha) {
			wantedObjects.push(finalHeadSha);
		}
		const objectFetch = await runGit(workspacePath, ["fetch", remote, ...wantedObjects], {
			timeoutMs: WORKTREE_SYNC_TIMEOUT_MS,
		});
		const baseFetch = await runGit(workspacePath, ["fetch", remote, baseRef], {
			timeoutMs: WORKTREE_SYNC_TIMEOUT_MS,
		});
		if (objectFetch.ok || baseFetch.ok) {
			const remoteTracking = await runGit(workspacePath, [
				"rev-parse",
				"--verify",
				`refs/remotes/${remote}/${baseRef}^{commit}`,
			]);
			if (remoteTracking.ok && remoteTracking.stdout) {
				baseSha = remoteTracking.stdout;
			}
		}
	}
	// Object-existence probes use `cat-file -e`: `rev-parse --verify` accepts a
	// well-formed 40-hex string even when the object does not exist locally.
	const mergeCommitLocal = await runGit(workspacePath, ["cat-file", "-e", mergeCommitSha]);
	if (!mergeCommitLocal.ok) {
		throw new Error(
			`Merge commit ${mergeCommitSha} is not available locally; retry once it has been fetched or pulled.`,
		);
	}
	const ancestorResult = await runGit(workspacePath, ["merge-base", "--is-ancestor", mergeCommitSha, baseSha]);
	const baseContainsMerge = ancestorResult.ok;
	let worktreeHead: string | null = null;
	let dirty = false;
	let aheadOfBase = 0;
	if (worktreePath) {
		const [statusResult, headResult] = await Promise.all([
			runGit(worktreePath, ["status", "--porcelain"]),
			runGit(worktreePath, ["rev-parse", "HEAD"]),
		]);
		worktreeHead = headResult.ok ? headResult.stdout || null : null;
		dirty = statusResult.ok ? statusResult.stdout.length > 0 : false;
		// Exclude the merged PR head: after a squash or rebase merge the
		// task's own commits are NOT ancestors of the landed commit, so a
		// plain base..HEAD count would flag every squash/rebase merge as
		// local work. The exclusion needs the head commit locally; without
		// it the count is unverifiable (retryable pending), not a guess.
		if (!finalHeadSha) {
			throw new Error("The merged PR head commit is unavailable; the local-ahead count cannot be verified.");
		}
		const headLocal = await runGit(workspacePath, ["cat-file", "-e", finalHeadSha]);
		if (!headLocal.ok) {
			throw new Error(`PR head ${finalHeadSha} is not available locally; retry once it has been fetched or pulled.`);
		}
		const aheadResult = await runGit(worktreePath, [
			"rev-list",
			"--count",
			`${baseSha}..HEAD`,
			"--not",
			finalHeadSha,
		]);
		if (!aheadResult.ok || !aheadResult.stdout) {
			throw new Error(`Cannot count worktree commits ahead of base: ${aheadResult.error ?? "unknown git error"}`);
		}
		aheadOfBase = Number(aheadResult.stdout) || 0;
	}
	return {
		worktreePath,
		worktreeHead,
		baseSha,
		baseContainsMerge,
		dirty,
		aheadOfBase,
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
	// Idempotency + manual-reopen guard, with crash recovery. The SAME merge
	// commit was already consumed for this binding and the card is in an
	// active column (Done/Trash skip above). The server-derived manualReopenAt
	// marker means a human reopened it from Done — do not send it back.
	// Without the marker the board move never landed (crash after the
	// completion persisted): fall through and re-run the idempotent
	// completion so the straggler reaches Done.
	const prior = binding.mergeCompletion;
	if (
		prior !== null &&
		prior.status === "completed" &&
		prior.mergeCommitSha !== null &&
		prior.mergeCommitSha === mergeCommitSha &&
		card.manualReopenAt !== undefined
	) {
		return { action: "skipped", reason: "merge_already_consumed" };
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
		// Worktree checks (a missing worktree still verifies the base branch).
		let inspection: PrMergeWorktreeInspection | null = null;
		try {
			inspection =
				(await deps.inspectWorktree?.({
					task,
					baseRef: card.baseRef,
					baseRepository: metadata.baseRepository ?? null,
					mergeCommitSha,
					finalHeadSha: metadata.headSha ?? null,
				})) ?? null;
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
		// Board move FIRST, then persist: the move is idempotent (a Done card
		// is a no-op), so a failed move leaves the binding untouched and the
		// coordinator's bounded reconciliation reads retry from scratch — no
		// stranded card. A crash after the persist is recovered by the
		// manual-reopen guard (active column without manualReopenAt re-runs
		// this idempotent completion).
		try {
			await deps.completeTask(task.workspaceId, task.taskId);
		} catch (error) {
			warn(`PR merge completion move failed for ${task.taskId}: ${String(error)}`);
			return { action: "pending", reason: "complete_move_failed" };
		}
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
