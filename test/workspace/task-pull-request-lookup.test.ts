// PRLINK-5: branch lookup records gh-detected PRs with snapshots and never
// fails the surrounding flow. resolveTaskCwd is mocked; gh is injected.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeTaskPullRequest } from "../../src/core/api-contract";
import { addTaskPullRequests } from "../../src/core/task-board-mutations";
import { loadWorkspaceState, mutateWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import {
	findTasksEnteringReviewWithoutPullRequests,
	fireReviewPullRequestLookup,
	lookupTaskPullRequests,
	type TaskPullRequestGhRunner,
} from "../../src/workspace/task-pull-request-lookup";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const taskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

vi.mock("../../src/workspace/task-worktree.js", () => ({
	resolveTaskCwd: taskWorktreeMocks.resolveTaskCwd,
}));

function createGhResult(stdout: string): {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
	missingBinary: boolean;
} {
	return { ok: true, stdout, stderr: "", exitCode: 0, missingBinary: false };
}

function createGhRunner(entries: unknown[]): TaskPullRequestGhRunner {
	return vi.fn(async () => createGhResult(JSON.stringify(entries)));
}

function createBoard(task: { id: string; pullRequests?: RuntimeTaskPullRequest[] }): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: task.id,
						title: "Task",
						prompt: "Task prompt",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
						...(task.pullRequests ? { pullRequests: task.pullRequests } : {}),
					},
				],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function findCardPullRequests(board: RuntimeBoardData, taskId: string): RuntimeTaskPullRequest[] | undefined {
	return board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId)?.pullRequests;
}

function createWorkspaceFixture(prefix: string): {
	workspacePath: string;
	cleanup: () => void;
	previousHome?: string;
	previousUserProfile?: string;
} {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const tempHome = createTempDir(`${prefix}home-`);
	process.env.HOME = tempHome.path;
	process.env.USERPROFILE = tempHome.path;
	const sandboxRoot = createTempDir(`${prefix}ws-`);
	const workspacePath = join(sandboxRoot.path, "project-a");
	mkdirSync(workspacePath, { recursive: true });
	const init = spawnSync("git", ["init"], { cwd: workspacePath, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${workspacePath}`);
	}
	return {
		workspacePath,
		previousHome,
		previousUserProfile,
		cleanup: () => {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousUserProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = previousUserProfile;
			}
			tempHome.cleanup();
			sandboxRoot.cleanup();
		},
	};
}

async function flushFireAndForget(): Promise<void> {
	// fireReviewPullRequestLookup does a pre-check board read before the lookup.
	await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("lookupTaskPullRequests", () => {
	let fixture: ReturnType<typeof createWorkspaceFixture>;
	let workspacePath: string;

	beforeEach(async () => {
		fixture = createWorkspaceFixture("kanban-lookup-");
		workspacePath = fixture.workspacePath;
		const initial = await loadWorkspaceState(workspacePath);
		await saveWorkspaceState(workspacePath, {
			board: createBoard({ id: "task-1" }),
			sessions: {},
			expectedRevision: initial.revision,
		});
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue(join(workspacePath, "worktree"));
	});

	afterEach(() => {
		fixture.cleanup();
	});

	it("records new PRs with snapshot, source branch_lookup, and dedupes by identity", async () => {
		const gh = createGhRunner([
			{ url: "https://github.com/owner/repo/pull/12", title: "Add feature", state: "OPEN" },
			{ url: "https://github.com/owner/repo/pull/12", title: "Add feature", state: "OPEN" },
			{ url: "https://github.com/owner/repo/pull/13", title: "Fix bug", state: "MERGED" },
			{ url: "not a url", state: "OPEN" },
			{ url: "https://github.com/owner/repo/pull/14", title: "Draft", state: "DRAFT" },
		]);

		const result = await lookupTaskPullRequests({
			workspacePath,
			taskId: "task-1",
			branch: "task/branch-1",
			gh,
		});

		expect(result.recorded).toBe(2);
		expect(gh).toHaveBeenCalledWith(
			[
				"pr",
				"list",
				"--head",
				"task/branch-1",
				"--state",
				"all",
				"--json",
				"number,url,title,state",
				"--limit",
				"5",
			],
			join(workspacePath, "worktree"),
		);
		const recorded = findCardPullRequests((await loadWorkspaceState(workspacePath)).board, "task-1");
		expect(recorded).toHaveLength(2);
		expect(recorded?.[0]).toMatchObject({
			provider: "github",
			host: "github.com",
			repository: "owner/repo",
			number: 12,
			url: "https://github.com/owner/repo/pull/12",
			title: "Add feature",
			state: "open",
			source: "branch_lookup",
		});
		expect(typeof recorded?.[0]?.stateCheckedAt).toBe("number");
		expect(recorded?.[1]).toMatchObject({ number: 13, state: "merged", title: "Fix bug" });
	});

	it("refreshes stale snapshots but no-ops (no revision churn) when unchanged", async () => {
		const first = await lookupTaskPullRequests({
			workspacePath,
			taskId: "task-1",
			branch: "task/branch-1",
			gh: createGhRunner([{ url: "https://github.com/owner/repo/pull/12", title: "Old title", state: "OPEN" }]),
		});
		expect(first.recorded).toBe(1);

		const second = await lookupTaskPullRequests({
			workspacePath,
			taskId: "task-1",
			branch: "task/branch-1",
			gh: createGhRunner([{ url: "https://github.com/owner/repo/pull/12", title: "New title", state: "MERGED" }]),
		});
		expect(second.recorded).toBe(1);

		const afterRefresh = await loadWorkspaceState(workspacePath);
		const entry = findCardPullRequests(afterRefresh.board, "task-1")?.[0];
		expect(entry).toMatchObject({ title: "New title", state: "merged" });
		expect(entry?.stateCheckedAt).toBeGreaterThanOrEqual(entry?.createdAt ?? 0);

		const third = await lookupTaskPullRequests({
			workspacePath,
			taskId: "task-1",
			branch: "task/branch-1",
			gh: createGhRunner([{ url: "https://github.com/owner/repo/pull/12", title: "New title", state: "MERGED" }]),
		});
		expect(third.recorded).toBe(0);
		expect((await loadWorkspaceState(workspacePath)).revision).toBe(afterRefresh.revision);
	});

	it("no-ops when gh is missing or fails, leaving state untouched", async () => {
		const revisionBefore = (await loadWorkspaceState(workspacePath)).revision;

		const missing = await lookupTaskPullRequests({
			workspacePath,
			taskId: "task-1",
			branch: "task/branch-1",
			gh: vi.fn(async () => ({ ok: false, stdout: "", stderr: "", exitCode: 127, missingBinary: true })),
		});
		expect(missing.recorded).toBe(0);

		const failed = await lookupTaskPullRequests({
			workspacePath,
			taskId: "task-1",
			branch: "task/branch-1",
			gh: vi.fn(async () => ({ ok: false, stdout: "", stderr: "not logged in", exitCode: 1, missingBinary: false })),
		});
		expect(failed.recorded).toBe(0);

		const state = await loadWorkspaceState(workspacePath);
		expect(state.revision).toBe(revisionBefore);
		expect(findCardPullRequests(state.board, "task-1")).toBeUndefined();
	});

	it("no-ops when the task is missing or the worktree cannot be resolved", async () => {
		const missingTask = await lookupTaskPullRequests({
			workspacePath,
			taskId: "nope",
			branch: "task/branch-1",
			gh: createGhRunner([{ url: "https://github.com/owner/repo/pull/12", state: "OPEN" }]),
		});
		expect(missingTask.recorded).toBe(0);

		taskWorktreeMocks.resolveTaskCwd.mockRejectedValueOnce(new Error('Task worktree not found for task "task-1".'));
		const noWorktree = await lookupTaskPullRequests({
			workspacePath,
			taskId: "task-1",
			branch: "task/branch-1",
			gh: createGhRunner([{ url: "https://github.com/owner/repo/pull/12", state: "OPEN" }]),
		});
		expect(noWorktree.recorded).toBe(0);
	});
});

describe("findTasksEnteringReviewWithoutPullRequests", () => {
	function createReviewCard(id: string, pullRequests?: RuntimeTaskPullRequest[]) {
		return {
			id,
			title: "Task",
			prompt: "p",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
			...(pullRequests ? { pullRequests } : {}),
		};
	}

	it("returns only tasks that newly entered review without recorded PRs", () => {
		const previous: RuntimeBoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [createReviewCard("task-1")] },
				{ id: "review", title: "Review", cards: [createReviewCard("task-2")] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};
		const next: RuntimeBoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{
					id: "review",
					title: "Review",
					cards: [
						createReviewCard("task-1"),
						createReviewCard("task-2"),
						createReviewCard("task-3", [
							{
								provider: "github",
								host: "github.com",
								repository: "owner/repo",
								number: 5,
								url: "https://github.com/owner/repo/pull/5",
								source: "manual",
								createdAt: 1,
							},
						]),
					],
				},
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};

		expect(findTasksEnteringReviewWithoutPullRequests(previous, next)).toEqual(["task-1"]);
	});
});

describe("fireReviewPullRequestLookup", () => {
	it("skips when the card already has recorded PRs (no revision change)", async () => {
		const fixture = createWorkspaceFixture("kanban-lookup-fire-");
		try {
			const workspacePath = fixture.workspacePath;
			const initial = await loadWorkspaceState(workspacePath);
			await saveWorkspaceState(workspacePath, {
				board: createBoard({ id: "task-1" }),
				sessions: {},
				expectedRevision: initial.revision,
			});
			const existing: RuntimeTaskPullRequest = {
				provider: "github",
				host: "github.com",
				repository: "owner/repo",
				number: 9,
				url: "https://github.com/owner/repo/pull/9",
				source: "manual",
				createdAt: 1,
			};
			// saveWorkspaceState restores persisted PRs over client input, so seed
			// through the board mutation path.
			await mutateWorkspaceState(workspacePath, (state) => {
				const result = addTaskPullRequests(state.board, "task-1", [existing], Date.now());
				return { board: result.board, value: result.added, save: result.added };
			});
			const revisionBeforeFire = (await loadWorkspaceState(workspacePath)).revision;

			fireReviewPullRequestLookup({ workspacePath, taskId: "task-1" });
			await flushFireAndForget();

			const state = await loadWorkspaceState(workspacePath);
			expect(state.revision).toBe(revisionBeforeFire);
			expect(findCardPullRequests(state.board, "task-1")).toHaveLength(1);
		} finally {
			fixture.cleanup();
		}
	});

	it("skips silently when the task is not on the board or the workspace is unreadable", async () => {
		const fixture = createWorkspaceFixture("kanban-lookup-fire2-");
		try {
			const workspacePath = fixture.workspacePath;
			const initial = await loadWorkspaceState(workspacePath);
			await saveWorkspaceState(workspacePath, {
				board: createBoard({ id: "task-1" }),
				sessions: {},
				expectedRevision: initial.revision,
			});

			fireReviewPullRequestLookup({ workspacePath, taskId: "missing-task" });
			fireReviewPullRequestLookup({ workspacePath: join(workspacePath, "does-not-exist"), taskId: "task-1" });
			await flushFireAndForget();

			// Must not throw and must not touch state.
			const state = await loadWorkspaceState(workspacePath);
			expect(state.revision).toBe(initial.revision + 1);
			expect(findCardPullRequests(state.board, "task-1")).toBeUndefined();
		} finally {
			fixture.cleanup();
		}
	});
});
