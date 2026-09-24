// B-9: backend-owned sequential task dispatch ("reliable queue").
//
// When taskDispatchPolicy.enabled, the backend — not the browser — decides
// which backlog tasks are ready: every prerequisite must sit in the done
// column and carry a delivery receipt in {delivered, no_op}. The base SHA is
// resolved from the delivered prerequisite receipts, a fresh-context prompt is
// built, the card is moved to in_progress, and a fresh session is launched.
// One model worker per workspace holds a slot at a time (workerLimit).
// Dispatch records are persisted before launch so restart reconciliation can
// recover in-flight work (B-9.6), and failed launches retry with a bounded
// attempt cap (B-9.7).
import { join } from "node:path";
import { baseTaskIdForReviewSessionId } from "../cline-sdk/cline-review-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeGitDeliveryReceipt,
	RuntimeTaskDispatchPolicy,
	RuntimeTaskDispatchPrerequisite,
	RuntimeTaskDispatchReconcileResponse,
	RuntimeTaskDispatchRecord,
	RuntimeTaskDispatchRunResponse,
	RuntimeTaskDispatchStatusResponse,
	RuntimeTaskDispatchTaskView,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { getTaskColumnId, moveTaskToColumn } from "../core/task-board-mutations";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";
import { readGitHeadInfo, runGit } from "../workspace/git-utils";
import { ensureTaskWorktreeIfDoesntExist, resolveTaskCwd } from "../workspace/task-worktree";
import { readTaskDispatchRecord, writeTaskDispatchRecord } from "./dispatch-records";

/** B-9.7: automatic launch/recovery attempts per task before the queue gives up. */
export const TASK_DISPATCH_RETRY_CAP = 3;

/** B-9: the queue is opt-in; one model worker per workspace by default. */
export const TASK_DISPATCH_DEFAULT_POLICY: RuntimeTaskDispatchPolicy = { enabled: false, workerLimit: 1 };

const TASK_DISPATCH_LOCK_DIR_NAME = "dispatch";

export interface TaskDispatchSessionStartInput {
	taskId: string;
	baseRef: string;
	prompt: string;
	taskTitle: string;
}

export interface TaskDispatchSessionStartResult {
	ok: boolean;
	error?: string;
	summary?: RuntimeTaskSessionSummary | null;
}

export interface TaskDispatchWorktreePreparation {
	ok: boolean;
	worktreePath: string | null;
	/** Verified baseline commit for the worktree (its actual HEAD). */
	baseSha: string | null;
	error: string | null;
}

export interface TaskDispatchDeps {
	workspaceId: string;
	/** Main repository checkout path. */
	workspacePath: string;
	loadConfig: () => Promise<RuntimeConfigState>;
	loadBoard: () => Promise<RuntimeBoardData>;
	/** Persist a board transform atomically (revision bump handled by the state layer). */
	persistBoard: (mutate: (board: RuntimeBoardData) => RuntimeBoardData) => Promise<void>;
	listTerminalSummaries: () => Promise<RuntimeTaskSessionSummary[]>;
	listClineSummaries: () => Promise<RuntimeTaskSessionSummary[]>;
	/** B-11.2: live review/repair sessions; they hold model worker slots too. */
	listReviewSessionSummaries?: () => Promise<RuntimeTaskSessionSummary[]>;
	/** Read a task's durable delivery receipt (null when absent). */
	readReceipt: (taskId: string) => Promise<RuntimeGitDeliveryReceipt | null>;
	/** Start a fresh task session (agent/model resolution happens inside). */
	startSession: (input: TaskDispatchSessionStartInput) => Promise<TaskDispatchSessionStartResult>;
	/** Worktree creation/verification (injectable for tests). */
	prepareWorktree?: (input: {
		taskId: string;
		baseRef: string;
		requiredAncestors: string[];
	}) => Promise<TaskDispatchWorktreePreparation>;
	/** Broadcast a state update after board mutations (fire-and-forget is fine). */
	onStateUpdated?: () => void;
}

type ReadyEntry = Extract<TaskDispatchReadiness, { ready: true }>;

export type TaskDispatchReadinessCode =
	| "prerequisite_in_progress"
	| "prerequisite_delivery_missing"
	| "prerequisite_delivery_paused"
	| "prerequisite_delivery_failed"
	| "prerequisite_cycle";

export type TaskDispatchReadiness =
	| {
			taskId: string;
			ready: true;
			reason: null;
			prerequisites: RuntimeTaskDispatchPrerequisite[];
	  }
	| {
			taskId: string;
			ready: false;
			code: TaskDispatchReadinessCode;
			reason: string;
			prerequisites: RuntimeTaskDispatchPrerequisite[];
	  };

export interface TaskDispatchReadinessInput {
	board: RuntimeBoardData;
	workspaceId: string;
	prereqStatus: (taskId: string) => {
		columnId: RuntimeBoardColumnId | null;
		receipt: RuntimeGitDeliveryReceipt | null;
	} | null;
}

function cardTitle(card: Pick<RuntimeBoardCard, "id" | "title"> | null): string {
	if (!card) {
		return "unknown task";
	}
	const trimmed = card.title?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : card.id;
}

function findBoardCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return card;
		}
	}
	return null;
}

function collectCardTitles(board: RuntimeBoardData): Record<string, string> {
	const titles: Record<string, string> = {};
	for (const column of board.columns) {
		for (const card of column.cards) {
			titles[card.id] = cardTitle(card);
		}
	}
	return titles;
}

function toTaskView(
	board: RuntimeBoardData,
	entry: TaskDispatchReadiness,
	blockedReason: string | null,
): RuntimeTaskDispatchTaskView {
	const card = findBoardCard(board, entry.taskId);
	return {
		taskId: entry.taskId,
		title: cardTitle(card),
		baseRef: card?.baseRef ?? "",
		blockedReason,
		prerequisites: entry.prerequisites,
	};
}

function blockedReasonOf(entry: TaskDispatchReadiness): string | null {
	return entry.ready ? null : entry.reason;
}

function extractRequiredAncestors(prerequisites: RuntimeTaskDispatchPrerequisite[]): string[] {
	return prerequisites
		.filter((prereq) => prereq.deliveryStatus === "delivered")
		.map((prereq) => prereq.integratedSha)
		.filter((sha): sha is string => Boolean(sha));
}

function getTaskDispatchLockRequest(workspaceId: string) {
	// Dedicated lock (proper-lockfile is not reentrant): dispatch holds this
	// while it may briefly take the workspace state lock inside persistBoard.
	return {
		path: join(getWorkspaceDirectoryPath(workspaceId), TASK_DISPATCH_LOCK_DIR_NAME),
		type: "directory" as const,
		lockfileName: ".lock",
	};
}

/**
 * B-9.2: which backlog tasks are ready right now. A task is ready when every
 * prerequisite sits in the done column and has a durable delivery receipt with
 * status delivered or no_op. The receipt (not the live board graph alone) is
 * the source of truth for "prerequisite satisfied"; the board edge only names
 * the prerequisite. paused/failed receipts and not-done prerequisites block.
 */
export function resolveReadyTasks(input: TaskDispatchReadinessInput): TaskDispatchReadiness[] {
	const results: TaskDispatchReadiness[] = [];
	const backlogColumn = input.board.columns.find((column) => column.id === "backlog");
	if (!backlogColumn) {
		return results;
	}
	for (const card of backlogColumn.cards) {
		results.push(resolveTaskReadiness(card, input));
	}
	return results;
}

function resolveTaskReadiness(card: RuntimeBoardCard, input: TaskDispatchReadinessInput): TaskDispatchReadiness {
	const name = cardTitle(card);
	const dependencies = input.board.dependencies.filter((dependency) => dependency.fromTaskId === card.id);
	const prerequisites: RuntimeTaskDispatchPrerequisite[] = [];
	const columnIds = new Map<string, RuntimeBoardColumnId | null>();
	const visited = new Set<string>();
	for (const dependency of dependencies) {
		const prereqId = dependency.toTaskId;
		if (visited.has(prereqId)) {
			// Defensive: board invariants (edges always backlog → non-backlog)
			// make cycles impossible; corrupted data must never dispatch.
			return {
				taskId: card.id,
				ready: false,
				code: "prerequisite_cycle",
				reason: `Task "${name}" has a circular dependency chain; resolve the links manually.`,
				prerequisites,
			};
		}
		visited.add(prereqId);
		const status = input.prereqStatus(prereqId);
		const columnId = status?.columnId ?? null;
		const receipt = status?.receipt && status.receipt.workspaceId === input.workspaceId ? status.receipt : null;
		columnIds.set(prereqId, columnId);
		prerequisites.push({
			taskId: prereqId,
			integratedSha: receipt?.integratedSha ?? null,
			taskCommitSha: receipt?.taskCommitSha ?? null,
			deliveryStatus: receipt?.status ?? null,
		});
	}
	if (prerequisites.length === 0) {
		return { taskId: card.id, ready: true, reason: null, prerequisites };
	}
	for (const prereq of prerequisites) {
		const prereqName = cardTitle({ id: prereq.taskId, title: "" });
		const columnId = columnIds.get(prereq.taskId) ?? null;
		if (columnId !== "done") {
			return {
				taskId: card.id,
				ready: false,
				code: "prerequisite_in_progress",
				reason: `Prerequisite "${prereqName}" is not done (currently in ${columnId ?? "an unknown column"}); it must complete first.`,
				prerequisites,
			};
		}
		if (!prereq.deliveryStatus) {
			return {
				taskId: card.id,
				ready: false,
				code: "prerequisite_delivery_missing",
				reason: `Prerequisite "${prereqName}" is done but has no delivery receipt; deliver it before "${name}" can start.`,
				prerequisites,
			};
		}
		if (prereq.deliveryStatus === "paused") {
			return {
				taskId: card.id,
				ready: false,
				code: "prerequisite_delivery_paused",
				reason: `Prerequisite "${prereqName}" delivery is paused; resume and finish it before "${name}" can start.`,
				prerequisites,
			};
		}
		if (prereq.deliveryStatus === "failed") {
			return {
				taskId: card.id,
				ready: false,
				code: "prerequisite_delivery_failed",
				reason: `Prerequisite "${prereqName}" delivery failed; fix and re-deliver it before "${name}" can start.`,
				prerequisites,
			};
		}
	}
	return { taskId: card.id, ready: true, reason: null, prerequisites };
}
async function buildReadinessInput(
	deps: TaskDispatchDeps,
	board: RuntimeBoardData,
): Promise<TaskDispatchReadinessInput> {
	const prereqIds = new Set<string>();
	for (const dependency of board.dependencies) {
		prereqIds.add(dependency.toTaskId);
	}
	const receipts = new Map<string, RuntimeGitDeliveryReceipt | null>();
	await Promise.all(
		[...prereqIds].map(async (taskId) => {
			receipts.set(taskId, await deps.readReceipt(taskId).catch(() => null));
		}),
	);
	return {
		board,
		workspaceId: deps.workspaceId,
		prereqStatus: (taskId) => ({
			columnId: getTaskColumnId(board, taskId),
			receipt: receipts.get(taskId) ?? null,
		}),
	};
}

/**
 * B-9.1: the tasks currently holding model worker slots. A slot is held while
 * its model session is actively running or paused for review input. Home-agent
 * (assistant) sessions are the user's own chat and never block the queue.
 * B-11.2: review/repair sessions hold the base task's slot too, so summaries
 * are scoped to base task ids first and the result is de-duplicated.
 */
export function getActiveWorkerTaskIds(
	summaries: Array<Pick<RuntimeTaskSessionSummary, "taskId" | "state">>,
): string[] {
	const active = new Set<string>();
	for (const summary of summaries) {
		if (isHomeAgentSessionId(summary.taskId)) continue;
		if (summary.state === "running" || summary.state === "awaiting_review") {
			active.add(summary.taskId);
		}
	}
	return [...active];
}

/** B-11.2: scope review session summaries to the base task holding the worker slot. */
function scopeReviewSessionSummaries(summaries: RuntimeTaskSessionSummary[]): RuntimeTaskSessionSummary[] {
	return summaries.map((summary) => {
		const baseTaskId = baseTaskIdForReviewSessionId(summary.taskId);
		return baseTaskId === null ? summary : { ...summary, taskId: baseTaskId };
	});
}

/** B-9/B-11.2: every model session summary scoped to its worker slot (review sessions count). */
async function listWorkerSlotSummaries(deps: TaskDispatchDeps): Promise<RuntimeTaskSessionSummary[]> {
	return [
		...(await deps.listTerminalSummaries()),
		...(await deps.listClineSummaries()),
		...scopeReviewSessionSummaries(await (deps.listReviewSessionSummaries?.() ?? [])),
	];
}

// --- base SHA resolution (B-9.4) --------------------------------------------

export interface TaskDispatchBaseShaResult {
	baseSha: string | null;
	error: string | null;
	missingAncestry: string[];
}

/**
 * Resolve a candidate base commit from the card's base ref and verify that it
 * contains every delivered prerequisite's integrated commit. A missing
 * ancestor means the destination branch has not caught up (stale base) — the
 * dependent task must stay blocked until the branch is integrated again.
 */
export async function resolveDispatchBaseSha(options: {
	repoPath: string;
	baseRef: string;
	requiredAncestors: string[];
}): Promise<TaskDispatchBaseShaResult> {
	const normalizedBaseRef = options.baseRef.trim();
	const resolved = await runGit(options.repoPath, ["rev-parse", "--verify", `${normalizedBaseRef}^{commit}`]);
	if (!resolved.ok) {
		return {
			baseSha: null,
			error: `Cannot resolve base ref "${normalizedBaseRef}": ${resolved.stderr || resolved.error || "unknown error"}`,
			missingAncestry: [],
		};
	}
	const baseSha = resolved.stdout.trim();
	const missingAncestry: string[] = [];
	for (const ancestorSha of options.requiredAncestors) {
		const check = await runGit(options.repoPath, ["merge-base", "--is-ancestor", ancestorSha, baseSha]);
		if (check.ok) {
			continue;
		}
		// git exit code 1 = "not an ancestor" (a deliberate answer, not an error).
		if (check.exitCode === 1) {
			missingAncestry.push(ancestorSha);
			continue;
		}
		return {
			baseSha: null,
			error: `Ancestry check failed for ${ancestorSha}: ${check.stderr || check.error || "unknown error"}`,
			missingAncestry,
		};
	}
	if (missingAncestry.length > 0) {
		return {
			baseSha: null,
			error: `Base ref "${normalizedBaseRef}" does not contain delivered prerequisite work: ${missingAncestry.join(", ")}`,
			missingAncestry,
		};
	}
	return { baseSha, error: null, missingAncestry: [] };
}
/** git exit code 1 = "not an ancestor"; any other failure returns an error string. */
async function collectMissingAncestors(repoPath: string, ancestors: string[], headSha: string): Promise<string | null> {
	const missing: string[] = [];
	for (const ancestorSha of ancestors) {
		const check = await runGit(repoPath, ["merge-base", "--is-ancestor", ancestorSha, headSha]);
		if (check.ok) {
			continue;
		}
		if (check.exitCode === 1) {
			missing.push(ancestorSha);
			continue;
		}
		return `Ancestry check failed for ${ancestorSha}: ${check.stderr || check.error || "unknown error"}`;
	}
	if (missing.length > 0) {
		return `Worktree does not contain delivered prerequisite work: ${missing.join(", ")}`;
	}
	return null;
}

/**
 * Resolve the task worktree and verify the delivered prerequisite work is in
 * its HEAD. Existing worktrees are authoritative (B-5): the task's own
 * in-progress commits on top of the base are expected, so only prerequisite
 * ancestry is verified. A missing worktree is created at the resolved base
 * ref (B-5 preservation restore honored); if the restored work predates a
 * delivered prerequisite, the result is a block, not a silent reset.
 */
export async function prepareTaskWorktreeBaseline(options: {
	workspacePath: string;
	taskId: string;
	baseRef: string;
	requiredAncestors: string[];
}): Promise<TaskDispatchWorktreePreparation> {
	const existingPath = await resolveTaskCwd({
		cwd: options.workspacePath,
		taskId: options.taskId,
		baseRef: options.baseRef,
		ensure: false,
	}).catch(() => null);
	if (existingPath) {
		const head = await readGitHeadInfo(existingPath).catch(() => null);
		const headSha = head?.headCommit ?? null;
		if (!headSha) {
			return {
				ok: false,
				worktreePath: existingPath,
				baseSha: null,
				error: `Task worktree at ${existingPath} has no readable HEAD; recover or delete the worktree manually.`,
			};
		}
		const missing = await collectMissingAncestors(existingPath, options.requiredAncestors, headSha);
		if (missing) {
			return { ok: false, worktreePath: existingPath, baseSha: headSha, error: missing };
		}
		return { ok: true, worktreePath: existingPath, baseSha: headSha, error: null };
	}

	const resolved = await resolveDispatchBaseSha({
		repoPath: options.workspacePath,
		baseRef: options.baseRef,
		requiredAncestors: options.requiredAncestors,
	});
	if (!resolved.baseSha) {
		return { ok: false, worktreePath: null, baseSha: null, error: resolved.error };
	}
	const ensured = await ensureTaskWorktreeIfDoesntExist({
		cwd: options.workspacePath,
		taskId: options.taskId,
		baseRef: resolved.baseSha,
	});
	if (!ensured.ok) {
		return { ok: false, worktreePath: null, baseSha: null, error: ensured.error ?? "Worktree creation failed." };
	}
	// B-5: when preserved work is restored or a stored patch is applied, the
	// baseline is the recorded commit, not the requested base ref.
	const baseSha = ensured.baseCommit ?? resolved.baseSha;
	const missing = await collectMissingAncestors(ensured.path, options.requiredAncestors, baseSha);
	if (missing) {
		return { ok: false, worktreePath: ensured.path, baseSha, error: missing };
	}
	return { ok: true, worktreePath: ensured.path, baseSha, error: null };
}
// --- fresh-context prompt (B-9.5) -------------------------------------------

/**
 * B-9.5: every dispatched session starts with a fresh conversation plus
 * durable references to its requirements and prerequisite results — no
 * inherited history from earlier tasks.
 */
export function buildFreshDispatchPrompt(options: {
	task: RuntimeBoardCard;
	baseRef: string;
	baseSha: string;
	prerequisites: RuntimeTaskDispatchPrerequisite[];
	titleByTaskId?: Record<string, string>;
}): string {
	const title = options.titleByTaskId?.[options.task.id] ?? cardTitle(options.task);
	const taskPrompt = options.task.prompt?.trim();
	const prereqLines = options.prerequisites.map((prereq) => {
		const prereqTitle = options.titleByTaskId?.[prereq.taskId] ?? prereq.taskId;
		if (prereq.deliveryStatus === "delivered" && prereq.integratedSha) {
			const commit = prereq.taskCommitSha ? ` (task commit ${prereq.taskCommitSha.slice(0, 12)})` : "";
			return `- "${prereqTitle}": delivered and integrated at ${prereq.integratedSha}${commit}.`;
		}
		if (prereq.deliveryStatus === "no_op") {
			return `- "${prereqTitle}": completed with no changes (no-op delivery).`;
		}
		return `- "${prereqTitle}": delivered (${prereq.deliveryStatus ?? "unknown"}).`;
	});
	const prereqSection = prereqLines.length > 0 ? prereqLines.join("\n") : "- None — this task has no prerequisites.";
	const promptBody =
		taskPrompt && taskPrompt.length > 0
			? taskPrompt
			: "(No task prompt was provided. Inspect the repository and determine the work from the task title and repository conventions.)";
	return [
		"Fresh Kanban task session.",
		"",
		"## Task",
		title,
		"",
		promptBody,
		"",
		"## Ground rules",
		"- First read the repository rules (AGENTS.md or CLAUDE.md at the repository root, if present) and follow them.",
		`- Your worktree is checked out at commit ${options.baseSha} (base ref: ${options.baseRef}). All delivered prerequisite work listed below is already included in this commit.`,
		"- Do not switch branches, rebase, pull from remotes, or create new worktrees.",
		"",
		"## Delivered prerequisite work",
		prereqSection,
		"",
		"Build directly on the code as it exists in your worktree: read the relevant files before changing them.",
		"",
		"## Definition of done",
		"When the implementation is complete and you have verified it, stop and summarize exactly what you changed. The Kanban backend reviews and delivers the work deterministically after you finish.",
		"",
	].join("\n");
}
// --- dispatch orchestration (B-9.1–B-9.4) -----------------------------------

interface DispatchSingleTaskOutcome {
	dispatched: boolean;
	/** Set when the task could not be dispatched right now (surfaced in the response). */
	surfaceReason: string | null;
}

function moveTaskPreservingBoard(
	board: RuntimeBoardData,
	taskId: string,
	toColumnId: "in_progress" | "backlog",
): RuntimeBoardData {
	const moved = moveTaskToColumn(board, taskId, toColumnId);
	return moved.moved ? moved.board : board;
}

/**
 * Dispatch one ready backlog task: verify/create the worktree at a verified
 * base, persist the dispatch record, move the card to in_progress (ownership
 * before launch), start the fresh session, and finalize the record. On
 * launch failure the card returns to backlog and the attempt counter bounds
 * automatic retries (B-9.7).
 */
async function dispatchSingleTask(
	deps: TaskDispatchDeps,
	card: RuntimeBoardCard,
	entry: ReadyEntry,
	titleByTaskId: Record<string, string>,
): Promise<DispatchSingleTaskOutcome> {
	const taskId = entry.taskId;
	const previousRecord = await readTaskDispatchRecord(taskId).catch(() => null);
	const attempt = (previousRecord?.attempt ?? 0) + 1;
	const requiredAncestors = extractRequiredAncestors(entry.prerequisites);
	const prepare =
		deps.prepareWorktree ??
		((input: { taskId: string; baseRef: string; requiredAncestors: string[] }) =>
			prepareTaskWorktreeBaseline({ workspacePath: deps.workspacePath, ...input }));
	const preparation = await prepare({
		taskId,
		baseRef: card.baseRef,
		requiredAncestors,
	});
	if (!preparation.ok || !preparation.worktreePath || !preparation.baseSha) {
		await writeTaskDispatchRecord({
			taskId,
			workspaceId: deps.workspaceId,
			baseRef: card.baseRef,
			baseSha: preparation.baseSha,
			attempt: previousRecord?.attempt ?? 1,
			status: "blocked",
			error: preparation.error ?? "Worktree baseline verification failed.",
			prerequisites: entry.prerequisites,
			prompt: null,
			agentId: null,
			dispatchedAt: previousRecord?.dispatchedAt ?? Date.now(),
			updatedAt: Date.now(),
		}).catch(() => null);
		return { dispatched: false, surfaceReason: preparation.error ?? "Worktree baseline verification failed." };
	}

	const prompt = buildFreshDispatchPrompt({
		task: card,
		baseRef: card.baseRef,
		baseSha: preparation.baseSha,
		prerequisites: entry.prerequisites,
		titleByTaskId,
	});
	const record: RuntimeTaskDispatchRecord = {
		taskId,
		workspaceId: deps.workspaceId,
		baseRef: card.baseRef,
		baseSha: preparation.baseSha,
		attempt,
		status: "dispatching",
		error: null,
		prerequisites: entry.prerequisites,
		prompt,
		agentId: null,
		dispatchedAt: previousRecord?.dispatchedAt ?? Date.now(),
		updatedAt: Date.now(),
	};
	await writeTaskDispatchRecord(record);
	// B-9.3: persist readiness and ownership before the session is started.
	await deps.persistBoard((currentBoard) => moveTaskPreservingBoard(currentBoard, taskId, "in_progress"));
	const started = await deps.startSession({
		taskId,
		baseRef: card.baseRef,
		prompt,
		taskTitle: titleByTaskId[taskId] ?? cardTitle(card),
	});
	if (!started.ok) {
		const exhausted = attempt >= TASK_DISPATCH_RETRY_CAP;
		const error = started.error ?? "Task session start failed.";
		await writeTaskDispatchRecord({
			...record,
			status: exhausted ? "exhausted" : "failed",
			error,
			updatedAt: Date.now(),
		}).catch(() => null);
		// Return the card to backlog so a later trigger can retry (bounded by the cap).
		await deps.persistBoard((currentBoard) => moveTaskPreservingBoard(currentBoard, taskId, "backlog"));
		return { dispatched: false, surfaceReason: error };
	}
	await writeTaskDispatchRecord({
		...record,
		status: "dispatched",
		agentId: started.summary?.agentId ?? null,
		updatedAt: Date.now(),
	}).catch(() => null);
	return { dispatched: true, surfaceReason: null };
}
/**
 * B-9.1/B-9.3: run one queue pass. Serialized per workspace by a dedicated
 * lock so concurrent triggers (board save, delivery, session stop) cannot
 * double-dispatch. Dispatches up to the free worker slots, in backlog order.
 */
export async function dispatchReadyTasks(deps: TaskDispatchDeps): Promise<RuntimeTaskDispatchRunResponse> {
	const config = await deps.loadConfig();
	const policy = config.taskDispatchPolicy ?? TASK_DISPATCH_DEFAULT_POLICY;
	// A disabled policy is a true no-op: no lock, no state directories, no
	// readiness work — the browser keeps its legacy local auto-start behavior.
	if (!policy.enabled) {
		return {
			dispatchedTaskId: null,
			skippedReason: "disabled",
			readyTasks: [],
			blockedTasks: [],
		};
	}
	return await lockedFileSystem.withLock(getTaskDispatchLockRequest(deps.workspaceId), async () => {
		const board = await deps.loadBoard();
		const readinessInput = await buildReadinessInput(deps, board);
		const readiness = resolveReadyTasks(readinessInput);
		const readyEntries = readiness.filter((entry): entry is ReadyEntry => entry.ready);
		const blockedViews: RuntimeTaskDispatchTaskView[] = readiness
			.filter((entry) => !entry.ready)
			.map((entry) => toTaskView(board, entry, blockedReasonOf(entry)));

		const summaries = await listWorkerSlotSummaries(deps);
		const activeWorkers = getActiveWorkerTaskIds(summaries);
		const slotsToFill = policy.workerLimit - activeWorkers.length;
		const titleByTaskId = collectCardTitles(board);
		let dispatchedCount = 0;
		const dispatchedTaskIds: string[] = [];
		if (slotsToFill > 0) {
			for (const entry of readyEntries) {
				if (dispatchedCount >= slotsToFill) {
					break;
				}
				const card = findBoardCard(board, entry.taskId);
				if (!card) {
					continue;
				}
				const previousRecord = await readTaskDispatchRecord(entry.taskId).catch(() => null);
				if (previousRecord?.status === "exhausted") {
					blockedViews.push(
						toTaskView(
							board,
							entry,
							`Dispatch retry cap (${TASK_DISPATCH_RETRY_CAP}) exhausted: ${previousRecord.error ?? "session start kept failing."} Clear the dispatch record or start the task manually.`,
						),
					);
					continue;
				}
				const outcome = await dispatchSingleTask(deps, card, entry, titleByTaskId);
				if (outcome.dispatched) {
					dispatchedCount += 1;
					dispatchedTaskIds.push(entry.taskId);
				} else if (outcome.surfaceReason) {
					blockedViews.push(toTaskView(board, entry, outcome.surfaceReason));
				}
			}
		}
		if (dispatchedCount > 0) {
			deps.onStateUpdated?.();
		}
		const readyViews = readyEntries
			.filter((entry) => !dispatchedTaskIds.includes(entry.taskId))
			.map((entry) => toTaskView(board, entry, null));
		return {
			dispatchedTaskId: dispatchedTaskIds[0] ?? null,
			skippedReason:
				dispatchedCount > 0
					? null
					: !policy.enabled
						? "disabled"
						: slotsToFill <= 0
							? "worker_busy"
							: "no_ready_tasks",
			readyTasks: readyViews,
			blockedTasks: blockedViews,
		};
	});
}
// --- restart reconciliation (B-9.6) -----------------------------------------

/**
 * B-9.6: after a runtime restart, in_progress tasks that carry a dispatch
 * record but no live session and no delivery receipt are relaunched from
 * their recorded base (fresh session, same verified baseline), with the
 * attempt counter continuing to bound automatic retries. Tasks without a
 * dispatch record were started manually and are left alone.
 */
export async function reconcileTaskDispatch(deps: TaskDispatchDeps): Promise<RuntimeTaskDispatchReconcileResponse> {
	const config = await deps.loadConfig();
	const policy = config.taskDispatchPolicy ?? TASK_DISPATCH_DEFAULT_POLICY;
	if (!policy.enabled) {
		return { relaunchedTaskIds: [], skippedTaskIds: [] };
	}
	return await lockedFileSystem.withLock(getTaskDispatchLockRequest(deps.workspaceId), async () => {
		const board = await deps.loadBoard();
		const inProgressColumn = board.columns.find((column) => column.id === "in_progress");
		const summaries = await listWorkerSlotSummaries(deps);
		const liveTaskIds = new Set(summaries.map((summary) => summary.taskId));
		const titleByTaskId = collectCardTitles(board);
		const prepare =
			deps.prepareWorktree ??
			((input: { taskId: string; baseRef: string; requiredAncestors: string[] }) =>
				prepareTaskWorktreeBaseline({ workspacePath: deps.workspacePath, ...input }));
		const relaunchedTaskIds: string[] = [];
		const skippedTaskIds: string[] = [];
		for (const card of inProgressColumn?.cards ?? []) {
			if (liveTaskIds.has(card.id)) {
				continue;
			}
			const record = await readTaskDispatchRecord(card.id).catch(() => null);
			if (!record) {
				continue;
			}
			const receipt = await deps.readReceipt(card.id).catch(() => null);
			if (receipt && (receipt.status === "delivered" || receipt.status === "no_op")) {
				continue;
			}
			const attempt = record.attempt + 1;
			if (attempt > TASK_DISPATCH_RETRY_CAP) {
				await writeTaskDispatchRecord({
					...record,
					status: "exhausted",
					error: "Restart reconciliation: retry cap exhausted.",
					updatedAt: Date.now(),
				}).catch(() => null);
				await deps.persistBoard((currentBoard) => moveTaskPreservingBoard(currentBoard, card.id, "backlog"));
				skippedTaskIds.push(card.id);
				continue;
			}
			const preparation = await prepare({
				taskId: card.id,
				baseRef: record.baseRef,
				requiredAncestors: extractRequiredAncestors(record.prerequisites),
			});
			if (!preparation.ok || !preparation.baseSha) {
				await writeTaskDispatchRecord({
					...record,
					status: "blocked",
					error: preparation.error ?? "Worktree baseline verification failed.",
					updatedAt: Date.now(),
				}).catch(() => null);
				skippedTaskIds.push(card.id);
				continue;
			}
			const prompt =
				record.prompt && record.prompt.trim().length > 0
					? record.prompt
					: buildFreshDispatchPrompt({
							task: card,
							baseRef: record.baseRef,
							baseSha: preparation.baseSha,
							prerequisites: record.prerequisites,
							titleByTaskId,
						});
			const started = await deps.startSession({
				taskId: card.id,
				baseRef: record.baseRef,
				prompt,
				taskTitle: titleByTaskId[card.id] ?? cardTitle(card),
			});
			if (!started.ok) {
				const exhausted = attempt >= TASK_DISPATCH_RETRY_CAP;
				const error = started.error ?? "Recovery session start failed.";
				await writeTaskDispatchRecord({
					...record,
					attempt,
					status: exhausted ? "exhausted" : "failed",
					error,
					updatedAt: Date.now(),
				}).catch(() => null);
				if (exhausted) {
					await deps.persistBoard((currentBoard) => moveTaskPreservingBoard(currentBoard, card.id, "backlog"));
				}
				skippedTaskIds.push(card.id);
				continue;
			}
			await writeTaskDispatchRecord({
				...record,
				attempt,
				status: "dispatched",
				baseSha: preparation.baseSha,
				prompt,
				agentId: started.summary?.agentId ?? null,
				updatedAt: Date.now(),
			}).catch(() => null);
			relaunchedTaskIds.push(card.id);
		}
		if (relaunchedTaskIds.length > 0 || skippedTaskIds.length > 0) {
			deps.onStateUpdated?.();
		}
		return { relaunchedTaskIds, skippedTaskIds };
	});
}
// --- diagnostics (B-9.5 / B-10) ----------------------------------------------

/** Read-only queue status for the UI and diagnostics (no dispatch side effects). */
export async function getTaskDispatchStatus(deps: TaskDispatchDeps): Promise<RuntimeTaskDispatchStatusResponse> {
	const config = await deps.loadConfig();
	const policy = config.taskDispatchPolicy ?? TASK_DISPATCH_DEFAULT_POLICY;
	const board = await deps.loadBoard();
	const readinessInput = await buildReadinessInput(deps, board);
	const readiness = resolveReadyTasks(readinessInput);
	const summaries = await listWorkerSlotSummaries(deps);
	const activeWorkers = getActiveWorkerTaskIds(summaries);
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	const loadedRecords = await Promise.all(
		[...taskIds].map((taskId) => readTaskDispatchRecord(taskId).catch(() => null)),
	);
	return {
		enabled: policy.enabled,
		workerLimit: policy.workerLimit,
		activeWorkerTaskId: activeWorkers[0] ?? null,
		activeWorkerTaskIds: activeWorkers,
		readyTasks: readiness.filter((entry) => entry.ready).map((entry) => toTaskView(board, entry, null)),
		blockedTasks: readiness
			.filter((entry) => !entry.ready)
			.map((entry) => toTaskView(board, entry, blockedReasonOf(entry))),
		records: loadedRecords.filter((record): record is RuntimeTaskDispatchRecord => record !== null),
	};
}
