// PCR-2: the explicit conflict-repair dispatch.
//
// One human-clicked button sends a server-rendered repair turn to the task's
// OWN agent session. Delivery follows the comment-repair contract rather than
// inventing a third sender: native Cline via the shared chat sender (`mode:
// "act"`, `source: "automated"`), Pi via the prepared-repair paste with the
// shared model-capacity gate, and every other terminal agent is an honest
// refusal — a silently dropped prompt in a terminal agent is worse than a
// refusal. The hard refusals (no force-push, no merges, no bypass) also live
// HERE, not only in the operator-editable template prose.
//
// Every guard is a visible refusal (`reason` + `error`), never silent.
import type {
	GitHubPrMetadataSnapshot,
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimePrConflictRepairRequest,
	RuntimePrConflictRepairResponse,
	RuntimeTaskChatSendResponse,
	RuntimeTaskConflictRepairRecord,
	RuntimeTaskPullRequest,
} from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { parsePullRequestUrl } from "../core/pull-request-links";
import { checkTaskLaunchRequirements } from "../core/task-launch-requirements";
import { checkoutHasGitOperationInProgress, checkoutHasUnmergedIndexEntries } from "../workspace/git-operation-state";
import { runGit } from "../workspace/git-utils";
import { parseGitRemoteRepository } from "../workspace/pr-merge-probe";
import { recordConflictRepair } from "../workspace/task-conflict-repair";
import { describeMissingConflictPromptToken, renderConflictRepairPrompt } from "./conflict-prompt";
import { toCanonicalPrKey } from "./pr-key-parsing";
import { getCardLinkedPrKeys, resolveCardAutomationPrKey } from "./pr-owner-selection";
import type { PrRecordStoreBase } from "./pr-record-store";
import { releasePrOperation, reservePrOperation } from "./pr-reservations";
import type { PrTrackingCoordinator } from "./pr-tracking-coordinator";

export interface ConflictRepairScope {
	workspaceId: string;
	workspacePath: string;
}

export interface ConflictRepairServiceDeps {
	loadWorkspaceState: (
		workspacePath: string,
	) => Promise<{ board: { columns: Array<{ id: string; cards: RuntimeBoardCard[] }> } }>;
	getCoordinator: () => PrTrackingCoordinator | null;
	getStore: () => PrRecordStoreBase;
	/** Resolves the task's own worktree (`ensure: false`); null when missing. */
	resolveWorktreePath: (input: { workspacePath: string; taskId: string; baseRef: string }) => Promise<string | null>;
	/** B-5.5-style writer liveness probe. */
	isTaskWriterActive: (workspaceId: string, taskId: string) => Promise<boolean> | boolean;
	/** Live comment-repair dispatch on this card (same session, one prompt). */
	commentRepairInFlight?: (workspaceId: string, taskId: string) => Promise<boolean> | boolean;
	/** Session agent → card override → workspace default (task-start precedence). */
	getEffectiveTaskAgentId: (scope: ConflictRepairScope, taskId: string) => Promise<RuntimeAgentId | null>;
	sendClineMessage: (
		scope: ConflictRepairScope,
		taskId: string,
		prompt: string,
	) => Promise<RuntimeTaskChatSendResponse>;
	sendPiMessage: (scope: ConflictRepairScope, taskId: string, prompt: string) => Promise<RuntimeTaskChatSendResponse>;
	/** The scoped runtime config's (possibly operator-edited) conflict template. */
	getConflictPromptTemplate: (scope: ConflictRepairScope) => Promise<string>;
	/** Board broadcast so the dispatch record surfaces without waiting for a poll. */
	broadcastWorkspaceUpdated?: (scope: ConflictRepairScope) => void | Promise<void>;
	now?: () => number;
	warn?: (message: string) => void;
}

export interface ConflictRepairService {
	resolveTaskPrConflicts(
		scope: ConflictRepairScope,
		input: RuntimePrConflictRepairRequest,
	): Promise<RuntimePrConflictRepairResponse>;
}

const UNSERVABLE_AGENT_MESSAGE =
	"Conflict repair needs a native Cline or Pi session. Open this task's terminal and keep it idle, then press Resolve conflicts.";

function formatDispatchedAt(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString();
}

/** The card link matching a canonical PR key (null when unlinked/unparseable). */
export function findLinkForPrKey(card: RuntimeBoardCard, prKey: string): RuntimeTaskPullRequest | null {
	for (const link of card.pullRequests ?? []) {
		const parsed = parsePullRequestUrl(link.url);
		if (!parsed) {
			continue;
		}
		if (
			toCanonicalPrKey({
				provider: parsed.provider,
				host: parsed.host,
				repository: parsed.repository,
				number: parsed.number,
			}) === prKey
		) {
			return link;
		}
	}
	return null;
}

async function runGitStep(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
	const result = await runGit(cwd, args, {
		timeoutMs: 15_000,
		env: createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
	});
	return { ok: result.ok, stdout: result.stdout };
}

/**
 * True when some configured remote's URL carries the PR head repository —
 * otherwise "push the branch" is a lie (a fork head with no local remote
 * would create a new branch upstream and leave the PR untouched).
 */
async function hasRemoteForRepository(cwd: string, headRepository: string): Promise<boolean> {
	const remotes = await runGitStep(cwd, ["remote"]);
	if (!remotes.ok) {
		return false;
	}
	for (const name of remotes.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)) {
		const url = await runGitStep(cwd, ["remote", "get-url", name]);
		if (!url.ok) {
			continue;
		}
		const parsed = parseGitRemoteRepository(url.stdout);
		if (parsed !== null && parsed.repository.toLowerCase() === headRepository.toLowerCase()) {
			return true;
		}
	}
	return false;
}

export function createConflictRepairService(deps: ConflictRepairServiceDeps): ConflictRepairService {
	const now = deps.now ?? Date.now;

	const resolveTaskPrConflicts = async (
		scope: ConflictRepairScope,
		input: RuntimePrConflictRepairRequest,
	): Promise<RuntimePrConflictRepairResponse> => {
		const fail = (
			reason: NonNullable<RuntimePrConflictRepairResponse["reason"]>,
			error: string,
			extras: Partial<RuntimePrConflictRepairResponse> = {},
		): RuntimePrConflictRepairResponse => ({
			ok: false,
			taskId: input.taskId,
			prKey: input.prKey,
			headSha: null,
			dispatchedAt: null,
			reason,
			error,
			...extras,
		});
		let reservationHeld = false;
		let reservationReleased = false;
		const releaseReservation = async (): Promise<void> => {
			if (!reservationHeld || reservationReleased) {
				return;
			}
			reservationReleased = true;
			try {
				await releasePrOperation(deps.getStore(), input.prKey, "conflict_repair", {
					workspaceId: scope.workspaceId,
					taskId: input.taskId,
				});
			} catch (error) {
				deps.warn?.(
					`[pr-conflict] reservation release failed pr=${input.prKey} error=${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		};
		try {
			const state = await deps.loadWorkspaceState(scope.workspacePath);
			let card: RuntimeBoardCard | null = null;
			let columnId: string | null = null;
			for (const column of state.board.columns) {
				const found = column.cards.find((candidate) => candidate.id === input.taskId);
				if (found) {
					card = found;
					columnId = column.id;
					break;
				}
			}
			if (card === null) {
				return fail("no_task", "The task was not found in this workspace.");
			}
			if (columnId !== "in_progress" && columnId !== "review") {
				return fail("inactive_task", "Conflict repair only runs for an In Progress or In Review task.");
			}
			const linked = getCardLinkedPrKeys(card);
			if (!linked.includes(input.prKey)) {
				return fail("pr_mismatch", "This PR is not linked to the task, so the repair cannot be scoped to it.");
			}
			const resolved = resolveCardAutomationPrKey(card);
			if (resolved.key === null) {
				return fail(
					"no_automation_pr",
					resolved.ambiguous
						? "Multiple PR links are recorded; select the Automation PR in the PRs tab first."
						: "No Automation PR is resolvable for this task.",
				);
			}
			if (resolved.key !== input.prKey) {
				return fail(
					"pr_mismatch",
					"This PR is not the task's Automation PR; repair the tracked PR (or select this one first).",
				);
			}
			const link = findLinkForPrKey(card, input.prKey);
			if (link === null) {
				return fail("pr_mismatch", "The PR link could not be parsed for repair.");
			}
			// Delivery feasibility is checked before ANY side effect — an
			// unsupported request is a refusal, never a downgrade.
			const effectiveAgentId = await deps.getEffectiveTaskAgentId(scope, input.taskId);
			if (effectiveAgentId !== "cline" && effectiveAgentId !== "pi") {
				return fail("agent_unsupported", UNSERVABLE_AGENT_MESSAGE);
			}
			const launch = checkTaskLaunchRequirements(effectiveAgentId, {
				// The repair is always an Act-mode turn: a plan-mode repair is a
				// read-only "resolve it" that can only talk about the conflict.
				startInPlanMode: false,
				imagesRequested: false,
				autonomousModeRequested: false,
			});
			if (!launch.ok) {
				return fail("launch_unsupported", launch.error ?? "The effective agent cannot run this launch.");
			}
			const worktreePath = await deps.resolveWorktreePath({
				workspacePath: scope.workspacePath,
				taskId: input.taskId,
				baseRef: card.baseRef,
			});
			if (worktreePath === null) {
				return fail(
					"worktree_missing",
					"The task checkout no longer exists, so there is nothing to merge in. Restart the task to recreate it; Kanban will not repair in a substitute checkout.",
				);
			}
			if (await checkoutHasGitOperationInProgress(worktreePath)) {
				return fail(
					"git_operation_in_progress",
					"A Git operation is already in progress in the task checkout. Finish or abort it before resolving conflicts.",
				);
			}
			if (await checkoutHasUnmergedIndexEntries(worktreePath)) {
				return fail(
					"unmerged_index",
					"The task checkout has unmerged index entries. Resolve or abort them before resolving conflicts.",
				);
			}
			if (await deps.isTaskWriterActive(scope.workspaceId, input.taskId)) {
				return fail("writer_active", "The task's agent is still working. Wait for it to settle, then try again.");
			}
			const recordResult = await deps.getStore().loadRecord(input.prKey);
			const record = recordResult.ok ? recordResult.record : null;
			const binding =
				record?.taskBindings.find(
					(item) => item.workspaceId === scope.workspaceId && item.taskId === input.taskId,
				) ?? null;
			if (
				record?.commentAutomation.dispatch?.status === "queued" ||
				record?.commentAutomation.dispatch?.status === "running"
			) {
				return fail(
					"comment_repair_pending",
					"A comment-repair turn is still in flight for this PR. Two prompts cannot share one session.",
				);
			}
			if (deps.commentRepairInFlight && (await deps.commentRepairInFlight(scope.workspaceId, input.taskId))) {
				return fail("comment_repair_pending", "A comment-repair turn is still running for this task.");
			}
			if (binding?.autoMergeAttempt?.state === "attempting") {
				return fail(
					"auto_merge_attempting",
					"The auto-merge executor is writing to this PR right now. Repair cannot push under a fenced merge.",
				);
			}
			// Re-read the head immediately before dispatch: the user may have
			// pushed meanwhile, and the prompt must embed the expected SHA.
			const coordinator = deps.getCoordinator();
			let refreshed = false;
			if (coordinator !== null) {
				try {
					const refresh = await coordinator.refreshPrMetadataOnce(input.prKey);
					refreshed = refresh.outcome === "refreshed";
				} catch (error) {
					deps.warn?.(
						`[pr-conflict] pre-dispatch head re-read failed pr=${input.prKey} error=${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
			const storedSnapshot = record ? latestSnapshot(record.snapshots) : null;
			const snapshot: GitHubPrMetadataSnapshot | null = refreshed
				? ((await latestFromStore()) ?? storedSnapshot)
				: storedSnapshot;
			async function latestFromStore(): Promise<GitHubPrMetadataSnapshot | null> {
				if (coordinator === null) {
					return null;
				}
				const after = await deps.getStore().loadRecord(input.prKey);
				return after.ok ? latestSnapshot(after.record.snapshots) : null;
			}
			if (snapshot === null) {
				return fail(
					"no_snapshot",
					"Kanban has no provider metadata for this PR yet. Open the PRs tab and use Refresh linked PRs, then press Resolve conflicts again.",
				);
			}
			if (snapshot.state !== "open") {
				return fail("pr_not_open", `The pull request is ${snapshot.state}, not open; repair cannot proceed.`);
			}
			if (snapshot.autoMergePresent === true) {
				return fail(
					"native_auto_merge",
					"GitHub native auto-merge is enabled on this PR; disable it before resolving conflicts manually.",
				);
			}
			if (snapshot.mergeable === true) {
				return fail("clean_merge", "The PR now reports a clean merge — the conflict is already resolved.");
			}
			if (snapshot.headRef === null || snapshot.headSha === null) {
				return fail(
					"head_unknown",
					"The PR head branch or SHA could not be verified (a deleted branch cannot be repaired). Refresh linked PRs and try again.",
				);
			}
			const headRef = snapshot.headRef;
			const baseRef = snapshot.baseRef;
			if (baseRef === null) {
				return fail("invalid_ref", "The PR base branch could not be verified. Refresh linked PRs and try again.");
			}
			const headRepository = snapshot.headRepository;
			if (headRepository === null || !/^[^\s/]+\/[^\s/]+$/.test(headRepository)) {
				return fail("invalid_ref", "The PR head repository could not be verified from the provider metadata.");
			}
			for (const ref of [headRef, baseRef]) {
				const valid = await runGitStep(worktreePath, ["check-ref-format", `refs/heads/${ref}`]);
				if (!valid.ok) {
					return fail("invalid_ref", `The branch name ${ref} is not a valid Git ref on this checkout.`);
				}
			}
			if (!(await hasRemoteForRepository(worktreePath, headRepository))) {
				return fail(
					"no_head_remote",
					`No configured Git remote carries ${headRepository}, so a normal push could not reach the PR head. Add the remote (fork heads need their own remote) and try again.`,
				);
			}
			// Duplicate-click dedupe keyed by head SHA: a second click while a
			// dispatch for THIS head is outstanding is refused with its time.
			const prior = card.conflictRepair;
			if (prior?.status === "dispatched" && prior.prKey === input.prKey && prior.headSha === snapshot.headSha) {
				return fail(
					"already_dispatched",
					`A conflict-repair turn was already dispatched for this head at ${formatDispatchedAt(prior.dispatchedAt)}. Wait for it to finish, or press again after the head changes.`,
					{ headSha: snapshot.headSha, dispatchedAt: prior.dispatchedAt },
				);
			}
			// PR reservation: the browser, the CLI, and deterministic delivery
			// must never race the PR while a dispatch is being accepted. Held
			// only for the dispatch window (the repair turn itself re-checks the
			// remote before pushing); released below in all outcomes.
			const reservation = await reservePrOperation(
				deps.getStore(),
				input.prKey,
				"conflict_repair",
				{
					workspaceId: scope.workspaceId,
					taskId: input.taskId,
				},
				{
					requireOwner: false,
					headRepository,
					headRef,
				},
			);
			if (reservation.status !== "reserved") {
				return fail(
					"pr_reserved",
					reservation.detail ?? "Another operation holds this PR right now. Try again once it releases.",
				);
			}
			reservationHeld = true;
			const template = await deps.getConflictPromptTemplate(scope);
			const rendered = renderConflictRepairPrompt(template, {
				prUrl: link.url,
				repository: link.repository,
				headBranch: snapshot.headRef,
				baseBranch: snapshot.baseRef,
				headSha: snapshot.headSha,
				baseSha: snapshot.baseSha ?? null,
				cardBaseRef: card.baseRef,
				taskWorktreePath: worktreePath,
			});
			if (!rendered.ok) {
				const detail =
					rendered.missing.length > 0
						? rendered.missing.map((token) => describeMissingConflictPromptToken(token)).join(" ")
						: "The conflict prompt template rendered empty. Restore the default template in settings.";
				await releaseReservation();
				return fail("prompt_invalid", detail);
			}
			const dispatchedAt = now();
			const dispatchRecord: RuntimeTaskConflictRepairRecord = {
				prKey: input.prKey,
				headSha: snapshot.headSha,
				dispatchedAt,
				status: "dispatched",
			};
			// The record is set BEFORE the send so a concurrent second click in
			// any tab sees it.
			await recordConflictRepair({
				workspacePath: scope.workspacePath,
				taskId: input.taskId,
				record: dispatchRecord,
			});
			const send = effectiveAgentId === "pi" ? deps.sendPiMessage : deps.sendClineMessage;
			const response = await send(scope, input.taskId, rendered.prompt);
			if (!response.ok) {
				const error = response.error ?? "The repair turn could not be delivered.";
				await recordConflictRepair({
					workspacePath: scope.workspacePath,
					taskId: input.taskId,
					record: { ...dispatchRecord, status: "failed", error },
				});
				await releaseReservation();
				await deps.broadcastWorkspaceUpdated?.(scope);
				return fail("send_failed", error);
			}
			await releaseReservation();
			await deps.broadcastWorkspaceUpdated?.(scope);
			return {
				ok: true,
				taskId: input.taskId,
				prKey: input.prKey,
				headSha: snapshot.headSha,
				dispatchedAt,
				reason: null,
				error: null,
			};
		} catch (error) {
			await releaseReservation();
			const message = error instanceof Error ? error.message : String(error);
			deps.warn?.(`[pr-conflict] dispatch failed task=${input.taskId} error=${message}`);
			return fail("send_failed", `Conflict repair dispatch failed: ${message}`);
		}
	};

	return { resolveTaskPrConflicts };
}

/** The newest access-scoped snapshot of a record (any scope). */
function latestSnapshot(snapshots: Record<string, GitHubPrMetadataSnapshot>): GitHubPrMetadataSnapshot | null {
	let latest: GitHubPrMetadataSnapshot | null = null;
	for (const snapshot of Object.values(snapshots)) {
		if (latest === null || snapshot.checkedAt > latest.checkedAt) {
			latest = snapshot;
		}
	}
	return latest;
}
