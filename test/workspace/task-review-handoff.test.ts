// B-6.1 + B-6.2/B-6.3 — unit tests for the review handoff helpers:
//   - extractReviewDiff: the unified diff vs the recorded starting revision,
//     with HEAD fallback and an empty result when there is no usable base.
//   - findTaskBaseRef: locating a task's base branch on the workspace board.
//
// extractReviewDiff runs against real temporary git repositories; findTaskBaseRef
// runs against a mocked workspace board (the board load is the only I/O).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import { runGit } from "../../src/workspace/git-utils";
import { extractReviewDiff, findTaskBaseRef } from "../../src/workspace/task-review-handoff";
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

		const diff = await extractReviewDiff(dir, base);

		expect(diff).toContain("a.txt");
		expect(diff).toContain("+line2");
	});

	it("includes committed changes made after the starting revision", async () => {
		const dir = createRepo();
		await initRepo(dir);
		const base = await commitFile(dir, "a.txt", "line1\n");
		await commitFile(dir, "a.txt", "line1\nline2\n");

		const diff = await extractReviewDiff(dir, base);

		expect(diff).toContain("a.txt");
		expect(diff).toContain("+line2");
	});

	it("falls back to HEAD when no starting revision is recorded", async () => {
		const dir = createRepo();
		await initRepo(dir);
		await commitFile(dir, "a.txt", "line1\n");
		await writeFile(join(dir, "a.txt"), "line1\nline2\n");

		const diff = await extractReviewDiff(dir, null);

		expect(diff).toContain("a.txt");
		expect(diff).toContain("+line2");
	});

	it("falls back to HEAD when the recorded starting revision is unreachable", async () => {
		const dir = createRepo();
		await initRepo(dir);
		await commitFile(dir, "a.txt", "line1\n");
		await writeFile(join(dir, "a.txt"), "line1\nline2\n");

		const diff = await extractReviewDiff(dir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

		expect(diff).toContain("a.txt");
		expect(diff).toContain("+line2");
	});

	it("returns an empty string when there are no commits and no recorded base", async () => {
		const dir = createRepo();
		await initRepo(dir);

		const diff = await extractReviewDiff(dir, null);

		expect(diff).toBe("");
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
