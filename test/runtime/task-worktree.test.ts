import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFilePromise: vi.fn(),
}));

const lockedFileSystemMocks = vi.hoisted(() => ({
	withLock: vi.fn(),
	writeTextFileAtomic: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
	getRuntimeHomePath: vi.fn(),
	getTaskWorktreesHomePath: vi.fn(),
	loadWorkspaceContext: vi.fn(),
}));

const taskWorktreePathMocks = vi.hoisted(() => ({
	getWorkspaceFolderLabelForWorktreePath: vi.fn(),
	normalizeTaskIdForWorktreePath: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: Object.assign(childProcessMocks.execFile, {
		[promisify.custom]: childProcessMocks.execFilePromise,
	}),
}));

vi.mock("../../src/fs/locked-file-system.js", () => ({
	lockedFileSystem: {
		withLock: lockedFileSystemMocks.withLock,
		writeTextFileAtomic: lockedFileSystemMocks.writeTextFileAtomic,
	},
}));

vi.mock("../../src/state/workspace-state.js", () => ({
	getRuntimeHomePath: workspaceStateMocks.getRuntimeHomePath,
	getTaskWorktreesHomePath: workspaceStateMocks.getTaskWorktreesHomePath,
	loadWorkspaceContext: workspaceStateMocks.loadWorkspaceContext,
}));

vi.mock("../../src/workspace/task-worktree-path.js", () => ({
	getWorkspaceFolderLabelForWorktreePath: taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath,
	KANBAN_TASK_WORKTREES_DIR_NAME: "worktrees",
	normalizeTaskIdForWorktreePath: taskWorktreePathMocks.normalizeTaskIdForWorktreePath,
}));

import { ensureTaskWorktreeIfDoesntExist, removeTaskWorktreeSetupLock } from "../../src/workspace/task-worktree";

describe.sequential("task-worktree generic ensure", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
		childProcessMocks.execFilePromise.mockReset();
		lockedFileSystemMocks.withLock.mockReset();
		lockedFileSystemMocks.writeTextFileAtomic.mockReset();
		workspaceStateMocks.getRuntimeHomePath.mockReset();
		workspaceStateMocks.getTaskWorktreesHomePath.mockReset();
		workspaceStateMocks.loadWorkspaceContext.mockReset();
		taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath.mockReset();
		taskWorktreePathMocks.normalizeTaskIdForWorktreePath.mockReset();

		let lockQueue = Promise.resolve();
		lockedFileSystemMocks.withLock.mockImplementation(
			async (_request: unknown, operation: () => Promise<unknown>) => {
				const waitForTurn = lockQueue;
				let releaseLock: () => void = () => {};
				lockQueue = new Promise<void>((resolve) => {
					releaseLock = resolve;
				});
				await waitForTurn;
				try {
					return await operation();
				} finally {
					releaseLock();
				}
			},
		);
		lockedFileSystemMocks.writeTextFileAtomic.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("rejects a generic ensure for a task that has never started", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-worktree-ensure-gate-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			const runtimeHomePath = join(sandboxRoot, "runtime-home");
			const worktreesHomePath = join(sandboxRoot, "worktrees-home");
			mkdirSync(join(repoPath, ".git"), { recursive: true });
			mkdirSync(runtimeHomePath, { recursive: true });
			mkdirSync(worktreesHomePath, { recursive: true });

			workspaceStateMocks.getRuntimeHomePath.mockReturnValue(runtimeHomePath);
			workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(worktreesHomePath);
			workspaceStateMocks.loadWorkspaceContext.mockResolvedValue({
				repoPath,
			});
			taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath.mockReturnValue("repo");
			taskWorktreePathMocks.normalizeTaskIdForWorktreePath.mockImplementation((taskId: string) => taskId);

			childProcessMocks.execFilePromise.mockImplementation(async (_file: string, args: readonly string[]) => {
				const command = args.join(" ");
				if (command.includes("--git-common-dir")) {
					return {
						stdout: ".git\n",
						stderr: "",
					};
				}
				throw Object.assign(new Error(`fatal: ${command}`), { code: 1, stdout: "", stderr: `fatal: ${command}` });
			});

			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-a",
				baseRef: "HEAD",
			});

			// UPD-0: worktree creation is start-owned. A generic ensure must not
			// create (or attempt to create) a worktree for a task that has never
			// started; the start lifecycle prepares the base ref first.
			expect(ensured.ok).toBe(false);
			if (ensured.ok) {
				throw new Error("Expected the generic ensure to be rejected");
			}
			expect(ensured.category).toBe("initial_start_preparation_required");
			expect(ensured.error).toContain("created when the task starts");
			// No worktree is created (start-owned preparation is the only creator).
			expect(existsSync(join(worktreesHomePath, "repo", "task-a"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("removes the task worktree setup lock from the repository git directory", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-worktree-lock-cleanup-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			const lockPath = join(repoPath, ".git", "kanban-task-worktree-setup.lock");
			mkdirSync(lockPath, { recursive: true });

			await expect(removeTaskWorktreeSetupLock(repoPath)).resolves.toBe(true);
			expect(existsSync(lockPath)).toBe(false);
			await expect(removeTaskWorktreeSetupLock(repoPath)).resolves.toBe(false);
		} finally {
			cleanup();
		}
	});
});
