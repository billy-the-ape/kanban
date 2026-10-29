// B-6.1 + B-6.2/B-6.3 — unit tests for the review handoff helpers:
//   - extractReviewDiff: the unified diff against the trusted baseline
//     (recorded start, preserved start, or the merge base of the task's base
//     branch and HEAD), with an empty result when no baseline can be resolved.
//   - buildReviewHandoffArtifact: the fresh-context briefing, including
//     multi-commit change sets, dirty/untracked paths, and the actionable
//     failure when no trusted baseline exists.
//   - findTaskBaseRef: locating a task's base branch on the workspace board.
//
// The git helpers run against real temporary git repositories; findTaskBaseRef
// runs against a mocked workspace board (the board load is the only I/O).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import { runGit } from "../../src/workspace/git-utils";
import {
	buildReviewHandoffArtifact,
	extractReviewDiff,
	findTaskBaseRef,
} from "../../src/workspace/task-review-handoff";
import { createTempDir } from "../utilities/temp-dir";

const workspaceStateMocks = vi.hoisted(() => ({
	loadWorkspaceBoardById: vi.fn(),
	getTaskWorktreesHomePath: vi.fn(() => "/tmp/kanban-worktrees-home"),
}));

vi.mock("../../src/state/workspace-state", () => ({
	loadWorkspaceBoardById: workspaceStateMocks.loadWorkspaceBoardById,
	getTaskWorktreesHomePath: workspaceStateMocks.getTaskWorktreesHomePath,
}));

beforeEach(() => {
	workspaceStateMocks.loadWorkspaceBoardById.mockReset();
});

// --- temporary git repositories for extractReviewDiff ------------------------
const repos: Array<() => void> = [];

function createRepo(): string {
	const { path, cleanup } = createTempDir("kanban-review-diff-");
	repos.push(cleanup);
	return path;
}

afterEach(() => {
	for (const cleanup of repos.splice(0)) {
		cleanup();
	}
});

async function initRepo(dir: string): Promise<void> {
	await runGit(dir, ["init", "-b", "main"]);
	await runGit(dir, ["config", "user.email", "reviewer@example.com"]);
	await runGit(dir, ["config", "user.name", "Reviewer"]);
}

/** Writes a file and commits it, returning the new HEAD sha. */
async function commitFile(dir: string, relPath: string, content: string): Promise<string> {
	await writeFile(join(dir, relPath), content, "utf8");
	await runGit(dir, ["add", relPath]);
	await runGit(dir, ["commit", "-m", `update ${relPath}`]);
	const result = await runGit(dir, ["rev-parse", "HEAD"]);
	return result.stdout;
}

describe("extractReviewDiff", () => {
	it("returns the unified diff vs the recorded starting revision (uncommitted change)", async () => {
		const dir = createRepo();
		await initRepo(dir);
		const base = await commitFile(dir, "a.txt", "line1\n");
		await writeFile(join(dir, "a.txt"), "line1\nline2\n");

		const diff = await extractReviewDiff(dir, "task-1", base);

		expect(diff).toContain("a.txt");
		expect(diff).toContain("+line2");
	});

	it("includes committed changes made after the starting revision", async () => {
		const dir = createRepo();
		await initRepo(dir);
		const base = await commitFile(dir, "a.txt", "line1\n");
		await commitFile(dir, "a.txt", "line1\nline2\n");

		const diff = await extractReviewDiff(dir, "task-1", base);

		expect(diff).toContain("a.txt");
		expect(diff).toContain("+line2");
	});

	it("derives the merge base of the base branch when no starting revision is recorded", async () => {
		const dir = createRepo();
		await initRepo(dir);
		await commitFile(dir, "a.txt", "line1\n");
		await writeFile(join(dir, "a.txt"), "line1\nline2\n");

		// HEAD is on main, so merge-base(main, HEAD) is HEAD: only the
		// uncommitted change is part of the diff — never a guessed parent.
		const diff = await extractReviewDiff(dir, "task-1", null, "main");

		expect(diff).toContain("a.txt");
		expect(diff).toContain("+line2");
	});

	it("derives the merge base of the base branch when the recorded starting revision is unreachable", async () => {
		const dir = createRepo();
		await initRepo(dir);
		await commitFile(dir, "a.txt", "line1\n");
		await writeFile(join(dir, "a.txt"), "line1\nline2\n");

		const diff = await extractReviewDiff(dir, "task-1", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "main");

		expect(diff).toContain("a.txt");
		expect(diff).toContain("+line2");
	});

	it("returns an empty string when no trusted baseline can be resolved", async () => {
		const dir = createRepo();
		await initRepo(dir);

		// No commits (no HEAD), no recorded start, no base branch to derive from.
		const diff = await extractReviewDiff(dir, "task-1", null);

		expect(diff).toBe("");
	});
});

describe("buildReviewHandoffArtifact", () => {
	it("records every tracked change made after the starting revision (multiple task commits)", async () => {
		const dir = createRepo();
		await initRepo(dir);
		const base = await commitFile(dir, "a.txt", "line1\n");
		await commitFile(dir, "a.txt", "line1\nline2\n");
		await commitFile(dir, "b.txt", "b1\n");

		const artifact = await buildReviewHandoffArtifact({
			taskId: "task-multi",
			worktreePath: dir,
			repoPath: dir,
			description: "Implement the change",
			startingCommit: base,
			baseRef: "main",
		});

		expect(artifact.startingCommit).toBe(base);
		expect(artifact.changedPaths).toEqual(["a.txt", "b.txt"]);
		expect(artifact.untrackedPaths).toEqual([]);
	});

	it("lists dirty tracked changes and untracked files separately", async () => {
		const dir = createRepo();
		await initRepo(dir);
		const base = await commitFile(dir, "a.txt", "line1\n");
		await writeFile(join(dir, "a.txt"), "line1\nline2\n");
		await writeFile(join(dir, "new.txt"), "fresh\n");

		const artifact = await buildReviewHandoffArtifact({
			taskId: "task-dirty",
			worktreePath: dir,
			repoPath: dir,
			description: "Implement the change",
			startingCommit: base,
			baseRef: "main",
		});

		expect(artifact.changedPaths).toEqual(["a.txt"]);
		expect(artifact.untrackedPaths).toEqual(["new.txt"]);
	});

	it("excludes merged base-branch changes from the derived change set", async () => {
		const dir = createRepo();
		await initRepo(dir);
		await commitFile(dir, "a.txt", "a\n");
		await runGit(dir, ["checkout", "-b", "task"]);
		await commitFile(dir, "b.txt", "b\n");
		await runGit(dir, ["checkout", "main"]);
		await commitFile(dir, "c.txt", "c\n");
		await runGit(dir, ["checkout", "task"]);
		await runGit(dir, ["merge", "main", "-m", "merge main"]);

		// No recorded start: the baseline derives from merge-base(main, HEAD),
		// so main's own new file (c.txt) is not part of the task's change set.
		const artifact = await buildReviewHandoffArtifact({
			taskId: "task-merge",
			worktreePath: dir,
			repoPath: dir,
			description: "Implement the change",
			baseRef: "main",
		});

		expect(artifact.changedPaths).toEqual(["b.txt"]);
	});

	it("keeps a proven empty change set valid", async () => {
		const dir = createRepo();
		await initRepo(dir);
		const head = await commitFile(dir, "a.txt", "line1\n");

		const artifact = await buildReviewHandoffArtifact({
			taskId: "task-empty",
			worktreePath: dir,
			repoPath: dir,
			description: "Implement the change",
			startingCommit: head,
			baseRef: "main",
		});

		expect(artifact.changedPaths).toEqual([]);
		expect(artifact.untrackedPaths).toEqual([]);
	});

	it("fails with an actionable message when no trusted baseline exists", async () => {
		const dir = createRepo();
		await initRepo(dir);
		await commitFile(dir, "a.txt", "line1\n");

		await expect(
			buildReviewHandoffArtifact({
				taskId: "task-nobase",
				worktreePath: dir,
				repoPath: dir,
				description: "Implement the change",
				startingCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
				baseRef: "no-such-branch",
			}),
		).rejects.toThrow(/No trusted starting revision/);
	});
});

describe("findTaskBaseRef", () => {
	it("returns the baseRef of the matching card (multi-column board)", async () => {
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(
			makeBoard([
				{ id: "todo", cards: [{ id: "task-1", baseRef: "main" }] },
				{ id: "in-progress", cards: [{ id: "task-2", baseRef: "feature/x" }] },
			]),
		);

		await expect(findTaskBaseRef("ws-1", "task-2")).resolves.toBe("feature/x");
		expect(workspaceStateMocks.loadWorkspaceBoardById).toHaveBeenCalledWith("ws-1");
	});

	it("returns null when the task is not on the board", async () => {
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(
			makeBoard([{ id: "todo", cards: [{ id: "task-1", baseRef: "main" }] }]),
		);

		await expect(findTaskBaseRef("ws-1", "missing")).resolves.toBeNull();
	});

	it("returns null when the board has no cards", async () => {
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(
			makeBoard([
				{ id: "todo", cards: [] },
				{ id: "in-progress", cards: [] },
			]),
		);

		await expect(findTaskBaseRef("ws-1", "task-1")).resolves.toBeNull();
	});
});

/** Builds a minimal board shape sufficient for findTaskBaseRef's card search. */
function makeBoard(columns: Array<{ id: string; cards: Array<{ id: string; baseRef: string }> }>): RuntimeBoardData {
	return {
		columns: columns.map((column) => ({
			id: column.id,
			title: column.id,
			cards: column.cards.map((card) => ({ id: card.id, baseRef: card.baseRef })),
		})),
	} as unknown as RuntimeBoardData;
}
