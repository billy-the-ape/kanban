// PCR-3: conflict-repair dispatch guards. Every refusal must land BEFORE any
// side effect (the plan's ordering contract): no reservation held afterward,
// no board write, no turn started — and the admitted path renders the
// server-side prompt against provider-verified values and records the
// dispatch durably on the card.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	GitHubPrMetadataSnapshot,
	GitHubPrTaskBinding,
	GitHubPrTrackingRecord,
	RuntimeBoardCard,
	RuntimeTaskChatSendResponse,
} from "../../../src/core/api-contract";
import {
	type ConflictRepairScope,
	type ConflictRepairService,
	type ConflictRepairServiceDeps,
	createConflictRepairService,
} from "../../../src/pr-tracking/conflict-repair-dispatch";
import { InMemoryPrRecordStore } from "../../../src/pr-tracking/in-memory-pr-record-store";
import { releasePrOperation, reservePrOperation } from "../../../src/pr-tracking/pr-reservations";
import { runGit } from "../../../src/workspace/git-utils";
import { createGitTestEnv } from "../../utilities/git-env";
import { isolateTestEnvironment } from "../../utilities/test-environment";

const workspaceStateMocks = vi.hoisted(() => ({
	mutateWorkspaceState: vi.fn(),
}));
vi.mock("../../../src/state/workspace-state", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/state/workspace-state")>();
	return { ...actual, mutateWorkspaceState: workspaceStateMocks.mutateWorkspaceState };
});

const WORKSPACE_PATH = "/workspace/repo";
const TASK_ID = "task-1";
const PR_KEY = "github|github.com|octo/repo|42";
const HEAD_SHA = "abc1234def5678901234567890123456789abcd";
const BASE_SHA = "beef56789012345678901234567890abcdef1234";

const scope: ConflictRepairScope = { workspaceId: WORKSPACE_PATH, workspacePath: WORKSPACE_PATH };

async function git(cwd: string, ...args: string[]) {
	const result = await runGit(cwd, args, { env: createGitTestEnv() });
	if (!result.ok) {
		throw new Error(`git ${args.join(" ")} failed: ${result.error ?? result.stderr}`);
	}
	return result.stdout;
}

const cleanups: Array<() => void> = [];
let worktree: string;

beforeEach(async () => {
	const env = isolateTestEnvironment();
	cleanups.push(env.cleanup);
	worktree = join(env.home, "worktree");
	await mkdir(worktree, { recursive: true });
	await git(worktree, "init", "-b", "feature/two");
	await git(worktree, "config", "user.name", "Fixture");
	await git(worktree, "config", "user.email", "fixture@example.com");
	await writeFile(join(worktree, "file.ts"), "export const x = 1;\n");
	await git(worktree, "add", "-A");
	await git(worktree, "commit", "-m", "work");
	// A remote whose URL parses to the snapshot's headRepository — the two
	// lookups the dispatch guard performs against the real checkout.
	await git(worktree, "remote", "add", "origin", "https://github.com/octo/repo.git");
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	workspaceStateMocks.mutateWorkspaceState.mockReset();
});

function makeCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: TASK_ID,
		title: "Conflicting task",
		prompt: "do the thing",
		startInPlanMode: false,
		agentId: "cline",
		baseRef: "main",
		pullRequests: [
			{
				provider: "github",
				host: "github.com",
				repository: "octo/repo",
				number: 42,
				url: "https://github.com/octo/repo/pull/42",
				source: "agent_tool",
				createdAt: 100,
			},
		],
		...overrides,
	} as unknown as RuntimeBoardCard;
}

function makeSnapshot(overrides: Partial<GitHubPrMetadataSnapshot> = {}): GitHubPrMetadataSnapshot {
	return {
		accessScopeId: "scope-1",
		checkedAt: 9_500,
		state: "open",
		headRepository: "octo/repo",
		headRef: "feature/two",
		baseRepository: "octo/repo",
		baseRef: "main",
		headSha: HEAD_SHA,
		mergedAt: null,
		mergeCommitSha: null,
		additions: null,
		deletions: null,
		changedFiles: null,
		commits: null,
		comments: null,
		reviewComments: null,
		mergeableState: "dirty",
		requestedReviewers: null,
		baseSha: BASE_SHA,
		mergeable: false,
		authorLogin: null,
		autoMergePresent: false,
		...overrides,
	};
}

interface HarnessOptions {
	card?: RuntimeBoardCard;
	snapshot?: GitHubPrMetadataSnapshot | null;
	columnId?: string;
	agentId?: string;
	writerActive?: boolean;
	commentRepairInFlight?: boolean;
	autoMergeAttempting?: boolean;
	sendFails?: boolean;
	sendThrows?: boolean;
	template?: string;
	worktreePath?: string | null;
}

function createHarness(options: HarnessOptions = {}) {
	let board: { columns: Array<{ id: string; cards: RuntimeBoardCard[] }> } = {
		columns: [
			{ id: "backup", cards: [] },
			{ id: "in_progress", cards: [] },
			{ id: "review", cards: [options.card ?? makeCard()] },
			{ id: "worktree", cards: [] },
			{ id: "trash", cards: [] },
		],
	};
	if (options.columnId !== undefined) {
		const card = board.columns[2]?.cards[0];
		board = {
			columns: [
				{ id: "backup", cards: [] },
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: options.columnId, cards: card ? [card] : [] },
				{ id: "trash", cards: [] },
			],
		};
	}

	const store = new InMemoryPrRecordStore();
	const sends: string[] = [];
	const piSends: string[] = [];
	let broadcasts = 0;

	const deps: ConflictRepairServiceDeps = {
		loadWorkspaceState: async () => ({ board }),
		getCoordinator: () => null,
		getStore: () => store,
		resolveWorktreePath: async () => (options.worktreePath === undefined ? worktree : options.worktreePath),
		isTaskWriterActive: () => options.writerActive === true,
		commentRepairInFlight: () => options.commentRepairInFlight === true,
		getEffectiveTaskAgentId: async () => (options.agentId ?? "cline") as never,
		sendClineMessage: async (_scope, _taskId, prompt) => {
			if (options.sendThrows === true) {
				throw new Error("send exploded");
			}
			sends.push(prompt);
			return options.sendFails === true
				? ({
						ok: false,
						summary: null,
						error: "Cline is starting. Stop it before sending a message.",
					} satisfies RuntimeTaskChatSendResponse)
				: ({ ok: true, summary: null } satisfies RuntimeTaskChatSendResponse);
		},
		sendPiMessage: async (_scope, _taskId, prompt) => {
			piSends.push(prompt);
			return { ok: true, summary: null } satisfies RuntimeTaskChatSendResponse;
		},
		getConflictPromptTemplate: async () =>
			options.template ??
			"PR: {{pr_url}} Repo: {{repository}} Head: {{head_branch}} Base: {{base_branch}} Path: {{task_worktree_path}} Sha: {{head_sha}} BaseSha: {{base_sha}} CardBase: {{base_ref}}",
		broadcastWorkspaceUpdated: () => {
			broadcasts += 1;
		},
		now: () => 11_000,
	};
	workspaceStateMocks.mutateWorkspaceState.mockImplementation(
		async (
			_path: string,
			mutate: (state: { board: unknown }) => { board: unknown; value: unknown; save: boolean },
		) => {
			const result = mutate({ board });
			board = result.board as typeof board;
			return { value: result.value, saved: result.save };
		},
	);

	const service: ConflictRepairService = createConflictRepairService(deps);
	const dispatch = () => service.resolveTaskPrConflicts(scope, { taskId: TASK_ID, prKey: PR_KEY });

	async function seedRecord(): Promise<void> {
		await store.createRecord({
			canonicalPrKey: PR_KEY,
			provider: "github",
			host: "github.com",
			repository: "octo/repo",
			number: 42,
		});
		if (options.snapshot === null) {
			return;
		}
		await store.withRegistryTransaction(async (registry) => {
			const state = await registry.loadState(PR_KEY);
			if (state.kind !== "present") {
				throw new Error("record missing");
			}
			const record = state.record;
			const binding: GitHubPrTaskBinding = {
				workspaceId: WORKSPACE_PATH,
				taskId: TASK_ID,
				linkGeneration: 1,
				linkedAt: 9_000,
				terminalStop: null,
				mergeCompletion: null,
				replayCursors: {},
				autoMergeAttempt:
					options.autoMergeAttempting === true
						? {
								schemaVersion: 1 as const,
								attemptId: "attempt-1",
								canonicalPrKey: PR_KEY,
								headSha: HEAD_SHA,
								baseSha: BASE_SHA,
								policyRevision: 1,
								mergeMethod: "squash" as const,
								startedAt: 9_400,
								state: "attempting" as const,
								reason: null,
								mergeCommitSha: null,
								finishedAt: null,
							}
						: null,
			};
			const next: GitHubPrTrackingRecord = {
				...record,
				revision: record.revision + 1,
				snapshots:
					options.snapshot === undefined
						? { "scope-1": makeSnapshot() }
						: options.snapshot === null
							? {}
							: { "scope-1": makeSnapshot(options.snapshot) },
				taskBindings: [binding],
			};
			await registry.write(PR_KEY, next);
		});
	}

	function cardNow(): RuntimeBoardCard | undefined {
		for (const column of board.columns) {
			const found = column.cards.find((candidate) => candidate.id === TASK_ID);
			if (found) return found;
		}
		return undefined;
	}

	return {
		service,
		store,
		dispatch,
		seedRecord,
		cardNow,
		sends,
		piSends,
		broadcastCount: () => broadcasts,
	};
}

describe("conflict-repair dispatch", () => {
	it("refuses when the task is not on the board", async () => {
		const harness = createHarness();
		const result = await harness.service.resolveTaskPrConflicts(scope, { taskId: "missing", prKey: PR_KEY });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("no_task");
		expect(harness.sends).toHaveLength(0);
	});

	it("refuses for Done cards — repair only runs for active tasks", async () => {
		const harness = createHarness({ columnId: "worktree" });
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("inactive_task");
		expect(harness.sends).toHaveLength(0);
	});

	it("refuses when the requested PR is not the task's Automation PR", async () => {
		const harness = createHarness();
		await harness.seedRecord();
		const result = await harness.service.resolveTaskPrConflicts(scope, {
			taskId: TASK_ID,
			prKey: "github|github.com|octo/repo|77",
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("pr_mismatch");
	});

	it("refuses ambiguous multi-PR cards until the Automation PR is selected", async () => {
		const second = {
			provider: "github" as const,
			host: "github.com",
			repository: "octo/repo",
			number: 43,
			url: "https://github.com/octo/repo/pull/43",
			source: "agent_tool" as const,
			createdAt: 100,
		};
		const harness = createHarness({ card: makeCard({ pullRequests: [...(makeCard().pullRequests ?? []), second] }) });
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("no_automation_pr");
		if (result.ok) return;
		expect(result.error).toContain("select the Automation PR");
	});

	it("refuses agents without a scriptable repair lane instead of dropping the prompt", async () => {
		const harness = createHarness({ agentId: "codex" });
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("agent_unsupported");
	});

	it("refuses when the task checkout no longer exists", async () => {
		const harness = createHarness({ worktreePath: null });
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("worktree_missing");
	});

	it("refuses while a Git operation is in progress in the task checkout", async () => {
		const harness = createHarness();
		await harness.seedRecord();
		const gitDir = (await git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD")).trim();
		await writeFile(gitDir, `${HEAD_SHA}\n`);
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("git_operation_in_progress");
	});

	it("refuses unmerged index entries even without an operation marker", async () => {
		const harness = createHarness();
		await harness.seedRecord();
		// Produce a real conflicted index: two branches editing the same line,
		// merged for the conflict, then the MERGE_HEAD marker removed so ONLY
		// the unmerged-index guard can fire.
		const base = await git(worktree, "rev-parse", "HEAD");
		await writeFile(join(worktree, "file.ts"), "export const x = 'left';\n");
		await git(worktree, "add", "-A");
		await git(worktree, "commit", "-m", "ours");
		await git(worktree, "checkout", "-b", "theirs", base);
		await writeFile(join(worktree, "file.ts"), "export const x = 'right';\n");
		await git(worktree, "add", "-A");
		await git(worktree, "commit", "-m", "theirs");
		const merge = await runGit(worktree, ["merge", "--no-edit", "feature/two"], { env: createGitTestEnv() });
		expect(merge.ok).toBe(false);
		const mergeHead = (await git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD")).trim();
		await rm(mergeHead, { force: true });
		const unmerged = await git(worktree, "diff", "--name-only", "--diff-filter=U");
		expect(unmerged.trim()).not.toBe("");
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("unmerged_index");
	});

	it("refuses while the task's own agent still holds the writer", async () => {
		const harness = createHarness({ writerActive: true });
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("writer_active");
	});

	it("refuses when a comment-repair turn is in flight for the same session", async () => {
		const harness = createHarness({ commentRepairInFlight: true });
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("comment_repair_pending");
	});

	it("refuses while the auto-merge executor is fenced on this PR", async () => {
		const harness = createHarness({ autoMergeAttempting: true });
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("auto_merge_attempting");
	});

	it("refuses without provider metadata instead of guessing", async () => {
		const harness = createHarness({ snapshot: null });
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("no_snapshot");
		expect(harness.sends).toHaveLength(0);
	});

	it("refuses a closed PR, a natively auto-merging PR, and a now-clean PR", async () => {
		const closed = createHarness({ snapshot: makeSnapshot({ state: "closed" }) });
		await closed.seedRecord();
		expect((await closed.dispatch()).reason).toBe("pr_not_open");

		const native = createHarness({ snapshot: makeSnapshot({ autoMergePresent: true }) });
		await native.seedRecord();
		expect((await native.dispatch()).reason).toBe("native_auto_merge");

		const clean = createHarness({ snapshot: makeSnapshot({ mergeable: true, mergeableState: "clean" }) });
		await clean.seedRecord();
		expect((await clean.dispatch()).reason).toBe("clean_merge");
	});

	it("refuses when the head branch or repository cannot be verified", async () => {
		const gone = createHarness({ snapshot: makeSnapshot({ headRef: null }) });
		await gone.seedRecord();
		expect((await gone.dispatch()).reason).toBe("head_unknown");

		const fork = createHarness({ snapshot: makeSnapshot({ headRepository: "contributor/fork" }) });
		await fork.seedRecord();
		const result = await fork.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("no_head_remote");
		if (result.ok) return;
		expect(result.error).toContain("contributor/fork");
	});

	it("refuses branch names that could break out of the agent's shell commands", async () => {
		// git check-ref-format ACCEPTS shell metacharacters (`;`, `&`, `|`,
		// backtick — verified against the installed git), and the prompt tells
		// the agent to push by branch name. The dispatch allow-list must refuse
		// before the prompt ever names such a branch.
		for (const headRef of ["x;touch pwned", "b`id`", "a&&curl", "f$(x)", "r|s"]) {
			const harness = createHarness({ snapshot: makeSnapshot({ headRef }) });
			await harness.seedRecord();
			const result = await harness.dispatch();
			expect(result.ok).toBe(false);
			expect(result.reason).toBe("invalid_ref");
			expect(harness.sends).toHaveLength(0);
			expect(harness.cardNow()?.conflictRepair ?? null).toBeNull();
		}
		// The conservative set still admits real-world branch names.
		const okBranch = createHarness({ snapshot: makeSnapshot({ headRef: "feature/two@v1.2+fix_3" }) });
		await okBranch.seedRecord();
		expect((await okBranch.dispatch()).ok).toBe(true);
	});

	it("holds the PR reservation against other operations for the dispatch window", async () => {
		const harness = createHarness();
		await harness.seedRecord();
		const held = await reservePrOperation(
			harness.store,
			PR_KEY,
			"comment_followup",
			{
				workspaceId: WORKSPACE_PATH,
				taskId: "other-task",
			},
			{ requireOwner: false },
		);
		expect(held.status).toBe("reserved");
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("pr_reserved");
		expect(harness.sends).toHaveLength(0);
		await releasePrOperation(harness.store, PR_KEY, "comment_followup", {
			workspaceId: WORKSPACE_PATH,
			taskId: "other-task",
		});
		expect((await harness.dispatch()).ok).toBe(true);
	});

	it("sends the rendered prompt to the task's Cline session and records the dispatch", async () => {
		const harness = createHarness();
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(true);
		expect(result.headSha).toBe(HEAD_SHA);
		expect(result.dispatchedAt).toBe(11_000);
		expect(harness.sends).toHaveLength(1);
		const prompt = harness.sends[0] ?? "";
		expect(prompt).toContain("https://github.com/octo/repo/pull/42");
		expect(prompt).toContain("octo/repo");
		expect(prompt).toContain("feature/two");
		expect(prompt).toContain("main");
		expect(prompt).toContain(worktree);
		expect(prompt).toContain(HEAD_SHA);
		expect(prompt).toContain(BASE_SHA);
		expect(prompt).not.toContain("{{");
		expect(harness.cardNow()?.conflictRepair).toMatchObject({
			prKey: PR_KEY,
			headSha: HEAD_SHA,
			dispatchedAt: 11_000,
			status: "dispatched",
		});
		expect(harness.broadcastCount()).toBe(1);
		// The reservation is released on the accepted path too.
		const stored = await harness.store.loadRecord(PR_KEY);
		expect(stored.ok ? stored.record?.reservation.state : "reserved").not.toBe("reserved");
	});

	it("routes Pi repairs through the Pi send lane", async () => {
		const harness = createHarness({ agentId: "pi" });
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(true);
		expect(harness.piSends).toHaveLength(1);
		expect(harness.sends).toHaveLength(0);
	});

	it("refuses a second dispatch against the same head (one receipt, one turn)", async () => {
		const harness = createHarness();
		await harness.seedRecord();
		expect((await harness.dispatch()).ok).toBe(true);
		const second = await harness.dispatch();
		expect(second.ok).toBe(false);
		expect(second.reason).toBe("already_dispatched");
		if (second.ok) return;
		expect(second.error).toContain("already dispatched");
		expect(second.dispatchedAt).toBe(11_000);
	});

	it("allows a fresh dispatch once the head changed", async () => {
		const harness = createHarness();
		await harness.seedRecord();
		expect((await harness.dispatch()).ok).toBe(true);
		// Simulate the provider seeing a new head: rewrite the snapshot.
		await harness.store.withRegistryTransaction(async (registry) => {
			const state = await registry.loadState(PR_KEY);
			if (state.kind !== "present") throw new Error("record missing");
			const record = state.record;
			await registry.write(PR_KEY, {
				...record,
				revision: record.revision + 1,
				snapshots: {
					"scope-1": makeSnapshot({ checkedAt: 12_000, headSha: "ffff012345678901234567890123456789012abc" }),
				},
			});
		});
		const retried = await harness.dispatch();
		expect(retried.ok).toBe(true);
	});

	it("records a failed send and keeps the retry lane open", async () => {
		const harness = createHarness({ sendFails: true });
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("send_failed");
		if (result.ok) return;
		expect(result.error).toContain("Cline is starting");
		expect(harness.cardNow()?.conflictRepair).toMatchObject({ status: "failed" });
		// A failed dispatch does not wedge the card: the retry sees the failure.
		const stored = await harness.store.loadRecord(PR_KEY);
		expect(stored.ok ? stored.record?.reservation.state : "reserved").not.toBe("reserved");
	});

	it("refuses when the template renders empty (operator error is visible, not silent)", async () => {
		const harness = createHarness({ template: "   " });
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("prompt_invalid");
		expect(harness.sends).toHaveLength(0);
	});

	it("sends exactly one turn for two concurrent clicks on the same head", async () => {
		// The fast-path dedupe is a check-then-act and the PR reservation is
		// idempotent per task + operation; the compare-and-set claim under the
		// workspace lock is what makes two simultaneous tabs safe.
		const harness = createHarness();
		await harness.seedRecord();
		const [first, second] = await Promise.all([harness.dispatch(), harness.dispatch()]);
		const results = [first, second];
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		const loser = results.find((result) => !result.ok);
		expect(loser?.reason).toBe("already_dispatched");
		expect(harness.sends).toHaveLength(1);
		expect(harness.cardNow()?.conflictRepair).toMatchObject({ status: "dispatched" });
	});

	it("a thrown send settles the record as failed and the retry lane stays open", async () => {
		const harness = createHarness({ sendThrows: true });
		await harness.seedRecord();
		const result = await harness.dispatch();
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("send_failed");
		if (result.ok) return;
		expect(result.error).toContain("send exploded");
		expect(harness.cardNow()?.conflictRepair).toMatchObject({ status: "failed" });
		// The stuck-on-`dispatched` wedge the failure record prevents: a fresh
		// click still reaches the send lane instead of `already_dispatched`.
		const retried = await harness.dispatch();
		expect(retried.reason).toBe("send_failed");
		expect(harness.sends).toHaveLength(0);
		expect(harness.cardNow()?.conflictRepair).toMatchObject({ status: "failed" });
	});
});
