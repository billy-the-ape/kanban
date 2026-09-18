// B-2.6 — oversized tool-result artifacts live outside any repo checkout, under the task's
// worktrees home, and are written atomically (no partial reads, no leftover temp files).
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildTaskContextArtifactFileName,
	getTaskContextArtifactsDir,
	readTaskContextArtifact,
	writeTaskContextArtifact,
} from "../../src/workspace/task-artifacts";
import { createTempDir } from "../utilities/temp-dir";

const workspaceStateMocks = vi.hoisted(() => ({
	getTaskWorktreesHomePath: vi.fn(),
}));

vi.mock("../../src/state/workspace-state.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/state/workspace-state")>();
	return {
		...original,
		getTaskWorktreesHomePath: workspaceStateMocks.getTaskWorktreesHomePath,
	};
});

describe("task context artifacts", () => {
	let temp: { path: string; cleanup: () => void };
	const homePath = join("worktrees-home");

	beforeEach(() => {
		temp = createTempDir("kanban-b26-artifacts-");
		workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(join(temp.path, homePath));
	});

	afterEach(() => {
		temp.cleanup();
		workspaceStateMocks.getTaskWorktreesHomePath.mockReset();
	});

	it("writes and reads back full content under <worktrees home>/<taskId>/context-artifacts", async () => {
		const content = "full\ncontent\nwith markers";
		const path = await writeTaskContextArtifact({ taskId: "task-1", toolCallId: "call_abc", content });
		expect(path.startsWith(join(temp.path, homePath, "task-1", "context-artifacts", "call_abc-"))).toBe(true);
		expect(path.endsWith(".txt")).toBe(true);
		expect(await readTaskContextArtifact(path)).toBe(content);
	});

	it("sanitizes tool call ids and keeps same-millisecond writes distinct", () => {
		expect(buildTaskContextArtifactFileName("call:weird/chars\\x", 123, "deadbeef")).toBe(
			"call-weird-chars-x-123-deadbeef.txt",
		);
		expect(buildTaskContextArtifactFileName("///", 123, "deadbeef")).toBe("tool-call-123-deadbeef.txt");
		expect(buildTaskContextArtifactFileName("a", 1)).not.toBe(buildTaskContextArtifactFileName("a", 1));
	});

	it("caps very long tool call ids in file names", () => {
		const name = buildTaskContextArtifactFileName("a".repeat(500), 1, "abcd1234");
		expect(name).toBe(`${"a".repeat(80)}-1-abcd1234.txt`);
	});

	it("throws for task ids that are not worktree-path safe", async () => {
		expect(() => getTaskContextArtifactsDir("a/b")).toThrow();
		expect(() => getTaskContextArtifactsDir("..")).toThrow();
		await expect(
			writeTaskContextArtifact({ taskId: "../evil", toolCallId: "call-1", content: "x" }),
		).rejects.toThrow();
	});

	it("leaves no temporary files behind after an atomic write", async () => {
		const path = await writeTaskContextArtifact({
			taskId: "task-2",
			toolCallId: "call-1",
			content: "data".repeat(10_000),
		});
		const dir = getTaskContextArtifactsDir("task-2");
		const entries = await readdir(dir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toBe(path.split("/").pop());
		expect(entries[0]).not.toContain(".tmp.");
	});

	it("rejects when reading a missing artifact", async () => {
		await expect(readTaskContextArtifact(join(temp.path, "does-not-exist.txt"))).rejects.toThrow();
	});
});
