// AM-4: fenced, audited, restart-safe GitHub merge executor.
//
// The ONLY code path allowed to write a GitHub PR merge. It is triggered
// exclusively by the AM-3 eligibility handoff (delivered by the coordinator
// of the single scheduler-lock owner) — never by a browser endpoint, and
// never by local git merge/push.
//
// Write protocol, in order:
//   1. Treat the typed eligibility handoff as a CANDIDATE, never an
//      authorization.
//   2. Reserve the durable per-PR / head-ref fencing gate (`auto_merge`
//      operation kind). The registry mutex is held only for the short CAS —
//      the evidence re-reads, the merge write, and the confirm reads all run
//      without it.
//   3. Under the reservation, re-read the live card, record, policy, and
//      claimants, fetch fresh complete evidence, and re-run the AM-3 pure
//      eligibility evaluation. Any shift in head/base SHA, repository, task
//      selection, policy, or approvals invalidates the candidate.
//   4. Persist the small versioned journal entry (`state: attempting`)
//      BEFORE invoking GitHub: one attempt per immutable evidence identity
//      (canonical PR key, head SHA, base SHA, policy revision).
//   5. One non-interactive, bounded `gh api` merge PUT with the verified head
//      SHA and the policy merge method. Never force-push, never bypass
//      GitHub rules.
//   6. Regardless of the write response (success, error, or timeout), fetch
//      the PR and verify `merged` + `merge_commit_sha` for the expected PR
//      identity. Only this remote observation confirms the merge; the
//      existing merge-completion consumer (not this executor) moves the task
//      to Done.
//   7. Persist the durable outcome BEFORE releasing the reservation in
//      `finally`: precondition drift → `waiting` (ordinary polling resumes),
//      permission/policy/configuration failure → `needs_attention` (terminal,
//      operator action), ambiguous outcome → journal stays `attempting`
//      (unknown outcomes stay blocked until an explicit recovery action).
//
// Restart safety: durable `attempting` records are reconciled at startup by
// READING GitHub first — never by repeating the write. A merge GitHub
// accepted is recovered as `merged_confirmed`; a merge GitHub did not accept
// is demoted to `waiting`, so no duplicate write ever happens without a fresh
// remote read proving the PR is still open. The startup reconciliation runs
// under the SAME durable reservation as the execution and is serialized
// per-PR through the in-flight chain, so it can never drop a live
// execution's fence mid-write.
import {
	AUTO_MERGE_ATTEMPT_SCHEMA_VERSION,
	type AutoMergeAttempt,
	type AutoMergeEvidenceEnvelope,
	type AutoMergePolicy,
	type AutoMergePolicyMergeMethod,
	type RuntimeBoardCard,
	type RuntimeBoardColumnId,
} from "../core/api-contract";
import type { AutoMergeEligibilityHandoff } from "./auto-merge-eligibility";
import { countOtherEligibleClaimants, evaluateAutoMergeEligibility } from "./auto-merge-eligibility";
import type { MergeWriteOutcome } from "./github-gh-adapter";
import { type ParsedCanonicalPrKey, parseCanonicalPrKey } from "./pr-identity";
import { type PrBoardSnapshot, resolveCardAutomationPrKey } from "./pr-owner-selection";
import type { PrRecordStoreBase } from "./pr-record-store";
import { releasePrOperation, reservePrOperation } from "./pr-reservations";
import { sha256Digest } from "./pr-snapshots";
import type { OneShotMetadataRefreshResult } from "./pr-tracking-coordinator";

/**
 * AM-4: the stable attempt identity — one durable attempt per immutable
 * evidence identity (canonical PR key, head SHA, base SHA, policy revision).
 */
export function computeAutoMergeAttemptId(
	canonicalPrKey: string,
	headSha: string,
	baseSha: string,
	policyRevision: number,
): string {
	return sha256Digest(`${canonicalPrKey}|${headSha}|${baseSha}|${policyRevision}`);
}

/**
 * The slice of the coordinator the executor uses: consumer-requested fresh
 * evidence reads and the one-shot fresh metadata refresh (the post-write
 * confirm read and the startup reconciliation). The production coordinator
 * structurally satisfies this.
 */
export interface AutoMergeExecutorCoordinator {
	readAutoMergeEvidence(
		canonicalPrKey: string,
		accessScopeId: string | undefined,
		options: { policyRevision: number; declaredHeadSha?: string | null },
	): Promise<AutoMergeEvidenceEnvelope>;
	refreshPrMetadataOnce(canonicalPrKey: string): Promise<OneShotMetadataRefreshResult>;
}

/**
 * The single fenced merge writer (the runtime's shared gh adapter in
 * production; scripted fakes in tests).
 */
export interface AutoMergeMergeWriter {
	mergePullRequest(
		parsed: ParsedCanonicalPrKey,
		options: { expectedHeadSha: string; mergeMethod: AutoMergePolicyMergeMethod },
	): Promise<MergeWriteOutcome>;
}

export interface AutoMergeExecutorDeps {
	store: PrRecordStoreBase;
	/** Lazy coordinator accessor (evidence re-read + confirm read). */
	getCoordinator: () => AutoMergeExecutorCoordinator | null;
	/** Single-task live board read (fresh card state, never cached). */
	getTaskCard: (
		workspaceId: string,
		taskId: string,
	) => Promise<{ card: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null>;
	/** All managed boards (other-claimant count for this PR). */
	listBoards: () => Promise<PrBoardSnapshot[]>;
	loadPolicy: (repository: string) => Promise<AutoMergePolicy | null>;
	/** Live writer liveness for the task (defaults to inactive). */
	isTaskWriterActive?: (workspaceId: string, taskId: string) => Promise<boolean> | boolean;
	/** The fenced merge writer (the runtime's shared gh adapter). */
	adapter: AutoMergeMergeWriter;
	/** Bounded budget for post-write / reconciliation remote reads. */
	confirmReadBudget?: number;
	warn?: (message: string) => void;
	now?: () => number;
}

export type AutoMergeExecutionOutcome =
	| { action: "merged_confirmed"; mergeCommitSha: string }
	| { action: "waiting"; reason: string }
	| { action: "needs_attention"; reason: string }
	| { action: "skipped"; reason: string };

export interface AutoMergeExecutor {
	/**
	 * Handle one eligibility handoff: fence, re-validate, journal, one merge
	 * write, remote confirmation, durable outcome, reservation release.
	 * Duplicate handoffs for the same PR in this runtime coalesce onto the
	 * in-flight execution (the single scheduler owner performs writes).
	 */
	execute(handoff: AutoMergeEligibilityHandoff): Promise<AutoMergeExecutionOutcome>;
	/**
	 * Startup crash recovery: reconcile every durable `attempting` attempt by
	 * reading GitHub first — never by repeating the write.
	 */
	reconcilePending(): Promise<void>;
}

/**
 * Eligibility blocker codes that are permission/policy/configuration
 * problems: they persist as terminal `needs_attention` (operator action
 * required). Every other non-eligible re-evaluation is precondition drift
 * and returns to ordinary waiting (the AM-3 consumer resumes its own
 * evaluation and re-arms the handoff when eligible).
 */
const NEEDS_ATTENTION_ELIGIBILITY_CODES = new Set<string>([
	"no_policy",
	"policy_mismatch",
	"no_required_checks",
	"auth",
	"access",
	"unsupported_host",
	"malformed_key",
]);

function classifyWriteOutcome(write: MergeWriteOutcome): { state: "waiting" | "needs_attention"; reason: string } {
	if (write.kind === "merged") {
		// The write reported success but the remote read did not confirm it
		// (caught as unresolved above; defensive).
		return { state: "needs_attention", reason: "unverified: merge reported success but remote is not merged" };
	}
	if (write.kind === "rejected") {
		switch (write.status) {
			case 409:
				// HEAD moved since the write: ordinary re-evaluation resumes.
				return { state: "waiting", reason: "head_moved:github_409" };
			case 405:
				// Merge conflicts: re-evaluation blocks until the tree is clean.
				return { state: "waiting", reason: "merge_conflicts:github_405" };
			case 403:
			case 451:
				// Permission / branch protection / ruleset denial: an
				// actionable blocker, never retried without changed evidence.
				return { state: "needs_attention", reason: `github_denied:http_${write.status}` };
			case 422:
				// Validation failure (e.g. disallowed merge method).
				return { state: "needs_attention", reason: "validation_rejected:github_422" };
			default:
				return { state: "needs_attention", reason: `github_rejected:${write.status ?? "unknown"}` };
		}
	}
	if (write.failure.category === "auth" || write.failure.category === "access") {
		// Permission problem: terminal until the operator acts.
		return { state: "needs_attention", reason: `merge_call_failed:${write.failure.category}` };
	}
	// Timeout / network / rate-limit: transient — ordinary re-evaluation
	// resumes (and re-reads the remote first via the journal gate).
	return { state: "waiting", reason: `merge_call_failed:${write.failure.category}` };
}

export function createAutoMergeExecutor(deps: AutoMergeExecutorDeps): AutoMergeExecutor {
	const now = deps.now ?? Date.now;
	const confirmReadBudget = deps.confirmReadBudget ?? 3;
	/**
	 * Per-PR job chain: `execute` handoffs and the startup reconciliation
	 * serialize per canonical PR, so at most ONE job of this runtime holds
	 * (or releases) the durable `auto_merge` reservation for a PR at a time.
	 * A queued job starts only after the current job has fully finished,
	 * fence released.
	 */
	const inFlight = new Map<string, Promise<unknown>>();
	/** The in-flight (or queued) execution per PR: duplicates coalesce onto it. */
	const executing = new Map<string, Promise<AutoMergeExecutionOutcome>>();

	function enqueuePrJob<T>(prKey: string, fn: () => Promise<T>): Promise<T> {
		const prev = inFlight.get(prKey);
		const job: Promise<T> = (async () => {
			if (prev !== undefined) {
				await prev;
			}
			return await fn();
		})();
		inFlight.set(prKey, job);
		void job.finally(() => {
			if (inFlight.get(prKey) === job) {
				inFlight.delete(prKey);
			}
		});
		return job;
	}

	/** Bounded fresh remote metadata read (never more than confirmReadBudget). */
	async function readRemotePr(prKey: string): Promise<{
		merged: boolean;
		mergeCommitSha: string | null;
		unresolved: boolean;
	}> {
		for (let attempt = 0; attempt < confirmReadBudget; attempt += 1) {
			const coordinator = deps.getCoordinator();
			if (!coordinator) {
				return { merged: false, mergeCommitSha: null, unresolved: true };
			}
			let result: OneShotMetadataRefreshResult;
			try {
				result = await coordinator.refreshPrMetadataOnce(prKey);
			} catch (error) {
				result = { outcome: "failed", checkedAt: null, metadata: null, error: String(error) };
			}
			if (result.outcome === "refreshed" && result.metadata !== null) {
				if (result.metadata.state === "merged") {
					return { merged: true, mergeCommitSha: result.metadata.mergeCommitSha, unresolved: false };
				}
				return { merged: false, mergeCommitSha: null, unresolved: false };
			}
		}
		return { merged: false, mergeCommitSha: null, unresolved: true };
	}

	async function releaseAndWarn(prKey: string, task: { workspaceId: string; taskId: string }): Promise<void> {
		const released = await releasePrOperation(deps.store, prKey, "auto_merge", task, now);
		if (released.status !== "reserved") {
			deps.warn?.(`Auto-merge reservation release ${released.status} for ${prKey}: ${released.detail ?? "unknown"}`);
		}
	}

	async function runExecution(handoff: AutoMergeEligibilityHandoff): Promise<AutoMergeExecutionOutcome> {
		const task = { workspaceId: handoff.workspaceId, taskId: handoff.taskId };
		const prKey = handoff.canonicalPrKey;
		const loaded = await deps.store.loadRecord(prKey);
		if (!loaded.ok) {
			return { action: "skipped", reason: loaded.reason === "malformed" ? "malformed_record" : "no_record" };
		}
		const binding = loaded.record.taskBindings.find(
			(item) => item.workspaceId === task.workspaceId && item.taskId === task.taskId,
		);
		if (!binding) {
			return { action: "skipped", reason: "no_binding" };
		}
		const attemptId = computeAutoMergeAttemptId(prKey, handoff.headSha, handoff.baseSha, handoff.policy.revision);
		const existing = binding.autoMergeAttempt ?? null;
		// Terminal journal states: no rewrite without changed evidence or an
		// explicit operator action.
		if (existing) {
			if (existing.state === "merged_confirmed") {
				return { action: "skipped", reason: "already_merged" };
			}
			if (existing.state === "needs_attention" && existing.attemptId === attemptId) {
				return { action: "skipped", reason: "needs_attention" };
			}
		}
		// Fence: durable per-PR / head-ref reservation. A short CAS — the
		// registry mutex is released before any network work begins.
		const reservation = await reservePrOperation(deps.store, prKey, "auto_merge", task, {
			requireOwner: false,
		});
		if (reservation.status !== "reserved") {
			// busy (another operation in flight) / blocked (no verified head
			// mapping yet) / stale (fencing) → ordinary waiting.
			return {
				action: "waiting",
				reason: reservation.status === "stale" ? "stale_reservation" : `reservation_${reservation.status}`,
			};
		}
		try {
			// A durable `attempting` journal (possibly from a crashed run)
			// means an unverified write: reconcile the remote FIRST — never
			// repeat the write without a fresh remote read.
			if (existing?.state === "attempting") {
				const reconciled = await readRemotePr(prKey);
				if (reconciled.merged && reconciled.mergeCommitSha !== null) {
					const write = await deps.store.setAutoMergeAttempt(prKey, task, {
						...existing,
						state: "merged_confirmed",
						reason: `reconciled: merged (merge commit ${reconciled.mergeCommitSha})`,
						mergeCommitSha: reconciled.mergeCommitSha,
						finishedAt: now(),
					});
					if (!write.ok) {
						deps.warn?.(`Auto-merge merged_confirmed persist failed for ${prKey}: ${write.reason}`);
					}
					return { action: "merged_confirmed", mergeCommitSha: reconciled.mergeCommitSha };
				}
				if (reconciled.unresolved) {
					// Unknown outcome stays blocked: the journal remains
					// `attempting`; the next poll reconciles again.
					return { action: "waiting", reason: "reconcile_unresolved" };
				}
				// Confirmed still open: the prior write was not accepted.
				// Continue to a fresh, fully re-validated attempt.
			}
			return await attemptMerge(handoff, task, prKey, attemptId, existing);
		} finally {
			// Release only after the durable outcome has been persisted.
			await releaseAndWarn(prKey, task);
		}
	}

	async function attemptMerge(
		handoff: AutoMergeEligibilityHandoff,
		task: { workspaceId: string; taskId: string },
		prKey: string,
		attemptId: string,
		existing: AutoMergeAttempt | null,
	): Promise<AutoMergeExecutionOutcome> {
		// Re-validate under the reservation: fresh card, record, policy,
		// claimants, writer liveness, and complete evidence. Any drift
		// invalidates the candidate before a write.
		const found = await deps.getTaskCard(task.workspaceId, task.taskId);
		if (!found) {
			return { action: "waiting", reason: "no_task" };
		}
		const card = found.card;
		const resolved = resolveCardAutomationPrKey(card);
		if (resolved.key !== prKey) {
			return { action: "waiting", reason: "pr_selection_changed" };
		}
		if (card.autoMergeWhenApproved !== true || card.armedAutoMergePolicyRevision === undefined) {
			return { action: "waiting", reason: "disabled" };
		}
		const armedRevision = card.armedAutoMergePolicyRevision;
		const coordinator = deps.getCoordinator();
		if (!coordinator) {
			return { action: "waiting", reason: "no_coordinator" };
		}
		const freshRecord = await deps.store.loadRecord(prKey);
		if (!freshRecord.ok) {
			return {
				action: "waiting",
				reason: freshRecord.reason === "malformed" ? "malformed_record" : "no_record",
			};
		}
		const [policy, otherClaimantCount, writerRaw] = await Promise.all([
			deps.loadPolicy(freshRecord.record.repository),
			countOtherEligibleClaimants(prKey, task, deps.listBoards),
			Promise.resolve(deps.isTaskWriterActive?.(task.workspaceId, task.taskId)),
		]);
		const envelope = await coordinator.readAutoMergeEvidence(prKey, handoff.accessScopeId, {
			policyRevision: handoff.policy.revision,
			declaredHeadSha: handoff.headSha,
		});
		const result = evaluateAutoMergeEligibility({
			task: {
				workspaceId: task.workspaceId,
				taskId: task.taskId,
				column: found.columnId,
				optIn: card.autoMergeWhenApproved === true,
				armedPolicyRevision: armedRevision,
				expectedRepository: freshRecord.record.repository,
				expectedBaseRef: card.baseRef ?? null,
			},
			policy,
			envelope,
			otherClaimantCount,
			record: freshRecord.record,
			writerActive: writerRaw === true,
			accessScopeId: handoff.accessScopeId,
			now: now(),
		});
		if (result.kind !== "eligible") {
			const codes = result.blockers.map((blocker) => blocker.code);
			const needsAttention = codes.some((code) => NEEDS_ATTENTION_ELIGIBILITY_CODES.has(code));
			return needsAttention
				? { action: "needs_attention", reason: codes.join(",") }
				: { action: "waiting", reason: codes.join(",") };
		}
		if (policy === null) {
			// Defensive: the evaluator never reports eligible without a policy.
			return { action: "waiting", reason: "no_policy" };
		}
		// Reject any shift since the candidate evaluation — even when the
		// fresh evaluation is itself green at the NEW identity.
		if (
			result.headSha !== handoff.headSha ||
			result.baseSha !== handoff.baseSha ||
			result.policyRevision !== handoff.policy.revision
		) {
			return { action: "waiting", reason: "evidence_identity_shifted" };
		}
		// Journal BEFORE the GitHub call: one durable attempt per immutable
		// evidence identity; the first `startedAt` is preserved across
		// crashed retries of the same identity.
		const firstAttempt = existing?.attemptId === attemptId ? existing : null;
		const attempt: AutoMergeAttempt = {
			schemaVersion: AUTO_MERGE_ATTEMPT_SCHEMA_VERSION,
			attemptId,
			canonicalPrKey: prKey,
			headSha: handoff.headSha,
			baseSha: handoff.baseSha,
			policyRevision: handoff.policy.revision,
			mergeMethod: policy.mergeMethod,
			startedAt: firstAttempt ? firstAttempt.startedAt : now(),
			state: "attempting",
			reason: null,
			mergeCommitSha: null,
			finishedAt: null,
		};
		const journal = await deps.store.setAutoMergeAttempt(prKey, task, attempt);
		if (!journal.ok) {
			// Fail closed: no write without the durable journal.
			return { action: "needs_attention", reason: `journal_write_failed:${journal.reason}` };
		}
		const parsed = parseCanonicalPrKey(prKey);
		if (!parsed) {
			return { action: "needs_attention", reason: "malformed_key" };
		}
		// One non-interactive, bounded merge write. Never force-push, never
		// bypass rules; GitHub's `sha` parameter pins the verified head.
		const write = await deps.adapter.mergePullRequest(parsed, {
			expectedHeadSha: handoff.headSha,
			mergeMethod: policy.mergeMethod,
		});
		// Regardless of the write response, fetch the PR and verify the
		// merged state + merge commit. The confirm read targets the exact
		// canonical key, so the expected PR identity is the read target.
		const confirmed = await readRemotePr(prKey);
		if (confirmed.merged && confirmed.mergeCommitSha !== null) {
			const persist = await deps.store.setAutoMergeAttempt(prKey, task, {
				...attempt,
				state: "merged_confirmed",
				reason: `confirmed merged (merge commit ${confirmed.mergeCommitSha})`,
				mergeCommitSha: confirmed.mergeCommitSha,
				finishedAt: now(),
			});
			if (!persist.ok) {
				deps.warn?.(`Auto-merge merged_confirmed persist failed for ${prKey}: ${persist.reason}`);
			}
			return { action: "merged_confirmed", mergeCommitSha: confirmed.mergeCommitSha };
		}
		if (confirmed.unresolved) {
			// Ambiguous: the journal stays `attempting`; the remote state must
			// be reconciled before any further attempt (never a blind retry).
			await deps.store.setAutoMergeAttempt(prKey, task, {
				...attempt,
				reason: "unverified: remote read unresolved after merge attempt",
			});
			return { action: "waiting", reason: "confirmation_unresolved" };
		}
		// The PR is confirmed still open: classify the write response.
		const classified = classifyWriteOutcome(write);
		const persist = await deps.store.setAutoMergeAttempt(prKey, task, {
			...attempt,
			state: classified.state,
			reason: classified.reason,
			finishedAt: now(),
		});
		if (!persist.ok) {
			deps.warn?.(`Auto-merge outcome persist failed for ${prKey}: ${persist.reason}`);
		}
		return { action: classified.state, reason: classified.reason };
	}

	/**
	 * Reconcile one durable `attempting` attempt (startup crash recovery).
	 * Runs serialized per-PR through the in-flight chain and under the SAME
	 * durable `auto_merge` reservation the execution holds, so it can never
	 * drop a live execution's fence mid-write.
	 */
	async function reconcileOne(
		prKey: string,
		task: { workspaceId: string; taskId: string },
		seenAttemptId: string,
	): Promise<void> {
		const coordinator = deps.getCoordinator();
		if (!coordinator) {
			deps.warn?.("Auto-merge startup reconciliation skipped: coordinator unavailable");
			return;
		}
		const loaded = await deps.store.loadRecord(prKey);
		if (!loaded.ok) {
			return;
		}
		const binding = loaded.record.taskBindings.find(
			(item) => item.workspaceId === task.workspaceId && item.taskId === task.taskId,
		);
		const attempt = binding?.autoMergeAttempt ?? null;
		// Only the exact journal entry observed at scan time: a serialized
		// execution may have resolved (or re-journaled a new identity) since.
		if (!attempt || attempt.state !== "attempting" || attempt.attemptId !== seenAttemptId) {
			return;
		}
		// Fence: the SAME durable reservation the execution holds. This job
		// is serialized per-PR through the in-flight chain, so no execution
		// of this runtime can hold this PR's reservation while we run. A
		// non-reserved result means another operation (or another runtime)
		// holds the gate: skip; a later poll/startup retries.
		const reservation = await reservePrOperation(deps.store, prKey, "auto_merge", task, {
			requireOwner: false,
		});
		if (reservation.status !== "reserved") {
			deps.warn?.(`Auto-merge startup reconciliation skipped (${reservation.status}) for ${prKey}`);
			return;
		}
		try {
			// Read GitHub FIRST: never repeat a write from a stale attempt.
			let result: OneShotMetadataRefreshResult;
			try {
				result = await coordinator.refreshPrMetadataOnce(prKey);
			} catch (error) {
				result = { outcome: "failed", checkedAt: null, metadata: null, error: String(error) };
			}
			let next: AutoMergeAttempt | null = null;
			if (result.outcome === "refreshed" && result.metadata !== null) {
				if (result.metadata.state === "merged" && result.metadata.mergeCommitSha !== null) {
					next = {
						...attempt,
						state: "merged_confirmed",
						reason: `reconciled on startup: merged (merge commit ${result.metadata.mergeCommitSha})`,
						mergeCommitSha: result.metadata.mergeCommitSha,
						finishedAt: now(),
					};
				} else if (result.metadata.state !== "merged") {
					next = {
						...attempt,
						state: "waiting",
						reason: "reconciled on startup: PR still open; prior attempt was not accepted",
						finishedAt: now(),
					};
				}
				// Merged but merge commit unknown: keep `attempting`
				// (unresolved).
			}
			if (next === null) {
				// Unknown outcome stays blocked until a later reconciliation.
				deps.warn?.(
					`Auto-merge startup reconciliation unresolved for ${prKey} (${result.error ?? "unknown"}); attempt stays blocked`,
				);
				return;
			}
			// Conditional write: apply only if the journal is still the
			// entry reconciled above — never clobber a newer journal entry.
			// A "invalid" result means the entry was replaced after the
			// re-read (expected): nothing was written.
			const write = await deps.store.updateTaskBinding(prKey, task, undefined, (item) => {
				if (
					!item.autoMergeAttempt ||
					item.autoMergeAttempt.attemptId !== attempt.attemptId ||
					item.autoMergeAttempt.state !== "attempting"
				) {
					return null;
				}
				return { ...item, autoMergeAttempt: next };
			});
			if (!write.ok && write.reason !== "invalid") {
				deps.warn?.(`Auto-merge startup reconciliation persist failed for ${prKey}: ${write.reason}`);
			}
		} finally {
			// Release only after the durable outcome (or skip) has landed.
			await releaseAndWarn(prKey, task);
		}
	}

	return {
		async execute(handoff) {
			// Duplicates coalesce onto the in-flight (or queued) execution.
			const pendingExecute = executing.get(handoff.canonicalPrKey);
			if (pendingExecute !== undefined) {
				return pendingExecute;
			}
			// Serialized per-PR: runs only after any queued reconcile/execute
			// for this PR has finished (and released its fence).
			const result = enqueuePrJob(handoff.canonicalPrKey, () => runExecution(handoff));
			executing.set(handoff.canonicalPrKey, result);
			void result.finally(() => {
				if (executing.get(handoff.canonicalPrKey) === result) {
					executing.delete(handoff.canonicalPrKey);
				}
			});
			return result;
		},
		async reconcilePending() {
			const { records } = await deps.store.listRecords();
			for (const record of records) {
				for (const binding of record.taskBindings) {
					const attempt = binding.autoMergeAttempt ?? null;
					if (!attempt || attempt.state !== "attempting") {
						continue;
					}
					const task = { workspaceId: binding.workspaceId, taskId: binding.taskId };
					// Serialized per-PR through the SAME in-flight chain as
					// execute: a live execution for this PR finishes (fence
					// released) before this reconciliation runs, and any
					// execution arriving during the reconcile queues behind
					// it.
					await enqueuePrJob(record.canonicalPrKey, () =>
						reconcileOne(record.canonicalPrKey, task, attempt.attemptId),
					);
				}
			}
		},
	};
}
