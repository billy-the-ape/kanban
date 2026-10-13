// DIAG-2 (2b): full-tool-output recovery alongside its transcript position —
// sidecar-index resolution, filename fallback, legacy reference parsing,
// untrusted-reference rejection, and explicit per-result gaps.
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	classifyArtifactContentFormat,
	resolveTaskToolFullOutput,
} from "../../../src/core/task-diagnostics-export-artifacts";
import { readTaskArtifactIndex, TASK_ARTIFACT_INDEX_FILE_NAME } from "../../../src/workspace/task-artifact-index";
import { getTaskContextArtifactsDir, writeTaskContextArtifact } from "../../../src/workspace/task-artifacts";
import { createTempDir } from "../../utilities/temp-dir";

const workspaceStateMocks = vi.hoisted(() => ({
	getTaskWorktreesHomePath: vi.fn(),
}));

vi.mock("../../../src/state/workspace-state.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/state/workspace-state")>();
	return {
		...original,
		getTaskWorktreesHomePath: workspaceStateMocks.getTaskWorktreesHomePath,
	};
});

describe("resolveTaskToolFullOutput (DIAG-2 2b)", () => {
	let temp: { path: string; cleanup: () => void };

	beforeEach(() => {
		temp = createTempDir("kanban-diag-artifacts-");
		workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(temp.path);
	});

	afterEach(() => {
		temp.cleanup();
		workspaceStateMocks.getTaskWorktreesHomePath.mockReset();
	});

	it("resolves the full output through the sidecar index with exact content (50k+ chars, json-text)", async () => {
		const content = JSON.stringify({ rows: Array.from({ length: 3000 }, (_, i) => ({ id: i, note: "value" })) });
		expect(content.length).toBeGreaterThan(50000);
		await writeTaskContextArtifact({ taskId: "task-1", toolCallId: "call_abc", content });
		const evidence = await resolveTaskToolFullOutput({ taskId: "task-1", toolCallId: "call_abc" });
		expect(evidence.status).toBe("resolved");
		expect(evidence.artifactFileName).toMatch(/^call_abc-\d+-[0-9a-f]{8}\.txt$/);
		expect(evidence.artifactPath).toBeTypeOf("string");
		expect(evidence.contentFormat).toBe("json-text");
		expect(evidence.gap).toBeNull();
		expect(await readFile(evidence.artifactPath ?? "", "utf8")).toBe(content);
	});

	it("classifies raw non-JSON artifact content as text", async () => {
		const content = "plain output\nsecond line";
		await writeTaskContextArtifact({ taskId: "task-1", toolCallId: "call-raw", content });
		const evidence = await resolveTaskToolFullOutput({ taskId: "task-1", toolCallId: "call-raw" });
		expect(evidence.status).toBe("resolved");
		expect(evidence.contentFormat).toBe("text");
		expect(await readFile(evidence.artifactPath ?? "", "utf8")).toBe(content);
	});

	it("falls back to the deterministic filename lookup when the index is gone", async () => {
		await writeTaskContextArtifact({ taskId: "task-1", toolCallId: "call-fb", content: "output" });
		await unlink(join(getTaskContextArtifactsDir("task-1"), TASK_ARTIFACT_INDEX_FILE_NAME));
		const evidence = await resolveTaskToolFullOutput({ taskId: "task-1", toolCallId: "call-fb" });
		expect(evidence.status).toBe("resolved");
		expect(evidence.artifactFileName).toMatch(/^call-fb-\d+-[0-9a-f]{8}\.txt$/);
	});

	it("resolves all legacy reference styles from persisted excerpt text", async () => {
		const dir = getTaskContextArtifactsDir("task-1");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "legacy-1-111-abcdef01.txt"), "legacy output");
		const fullContentText = `excerpt head\n\nFull content: ${join(dir, "legacy-1-111-abcdef01.txt")}\n\ntail`;
		const fullOutputText = `excerpt head\n\nfull output: ${join(dir, "legacy-1-111-abcdef01.txt")}\n\ntail`;
		// The real command-excerpt marker is bracketed; the capture must stop
		// at the closing bracket, not swallow it.
		const fullOutputBracketedText = `excerpt head\n\n... [truncated 5 lines; full output: ${join(dir, "legacy-1-111-abcdef01.txt")}]\n\ntail`;
		for (const persistedResultText of [fullContentText, fullOutputText, fullOutputBracketedText]) {
			const evidence = await resolveTaskToolFullOutput({
				taskId: "task-1",
				toolCallId: "legacy-1",
				persistedResultText,
			});
			expect(evidence.status).toBe("resolved");
			expect(evidence.artifactFileName).toBe("legacy-1-111-abcdef01.txt");
		}
	});

	it("reports an explicit gap when no artifact survives", async () => {
		const evidence = await resolveTaskToolFullOutput({ taskId: "task-1", toolCallId: "call-missing" });
		expect(evidence.status).toBe("missing");
		expect(evidence.artifactFileName).toBeNull();
		expect(evidence.artifactPath).toBeNull();
		expect(evidence.gap).toBe("No surviving artifact records the full output for this tool call.");
	});

	it("rejects a recorded reference that escapes the task's context-artifacts directory", async () => {
		const outsideFile = join(temp.path, "outside.txt");
		await writeFile(outsideFile, "sneaky");
		const evidence = await resolveTaskToolFullOutput({
			taskId: "task-1",
			toolCallId: "call-escape",
			persistedResultText: `Full content: ${outsideFile}`,
		});
		expect(evidence.status).toBe("invalid");
		expect(evidence.gap).toContain("outside.txt");
	});

	it("rejects a sibling task's artifacts as missing, never resolves them", async () => {
		await writeTaskContextArtifact({ taskId: "task-2", toolCallId: "shared-id", content: "other task output" });
		const evidence = await resolveTaskToolFullOutput({
			taskId: "task-1",
			toolCallId: "shared-id",
			persistedResultText: `Full content: ${join(getTaskContextArtifactsDir("task-2"), "nope.txt")}`,
		});
		expect(evidence.status).toBe("invalid");
	});

	it("rejects a symlink that escapes the task's context-artifacts directory", async () => {
		const outsideFile = join(temp.path, "secret.txt");
		await writeFile(outsideFile, "secret");
		const dir = getTaskContextArtifactsDir("task-1");
		await mkdir(dir, { recursive: true });
		await symlink(outsideFile, join(dir, "escape-link.txt"));
		const evidence = await resolveTaskToolFullOutput({
			taskId: "task-1",
			toolCallId: "call-symlink",
			persistedResultText: `full output: ${join(dir, "escape-link.txt")}`,
		});
		expect(evidence.status).toBe("invalid");
	});

	it("containment-checks the filename-fallback match, not just stats it (escape symlink)", async () => {
		const outsideFile = join(temp.path, "secret-fallback.txt");
		await writeFile(outsideFile, "secret");
		const dir = getTaskContextArtifactsDir("task-1");
		await mkdir(dir, { recursive: true });
		// The symlink's own name matches the deterministic artifact prefix, so
		// the fallback lookup finds exactly one match — it must still be
		// containment-checked, not just stat'd (stat follows symlinks).
		await symlink(outsideFile, join(dir, "call-fb-123-abcdef01.txt"));
		const evidence = await resolveTaskToolFullOutput({ taskId: "task-1", toolCallId: "call-fb" });
		expect(evidence.status).toBe("missing");
		expect(evidence.artifactFileName).toBeNull();
		expect(evidence.artifactPath).toBeNull();
	});

	it("reports an ambiguous multi-match instead of guessing an authoritative artifact", async () => {
		// Two writes for the same tool call (a retry) leave two surviving artifacts.
		await writeTaskContextArtifact({ taskId: "task-1", toolCallId: "call-ambig", content: "first" });
		await writeTaskContextArtifact({ taskId: "task-1", toolCallId: "call-ambig", content: "second" });
		const evidence = await resolveTaskToolFullOutput({ taskId: "task-1", toolCallId: "call-ambig" });
		expect(evidence.status).toBe("ambiguous");
		expect(evidence.artifactFileName).toBeNull();
		expect(evidence.gap).toContain("Multiple surviving artifacts");
	});

	it("keeps both entries when two concurrent writes race on the index (no self-deadlock)", async () => {
		const [first, second] = await Promise.all([
			writeTaskContextArtifact({ taskId: "task-1", toolCallId: "call-a", content: "A" }),
			writeTaskContextArtifact({ taskId: "task-1", toolCallId: "call-b", content: "B" }),
		]);
		expect(first).not.toBe(second);
		const index = await readTaskArtifactIndex("task-1");
		expect(index["call-a"]?.map((entry) => entry.fileName)).toEqual([first.split("/").pop() ?? ""]);
		expect(index["call-b"]?.map((entry) => entry.fileName)).toEqual([second.split("/").pop() ?? ""]);
	});

	it("rebuilds a corrupt index on the next append instead of failing", async () => {
		const dir = getTaskContextArtifactsDir("task-1");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, TASK_ARTIFACT_INDEX_FILE_NAME), "{ not json");
		await writeTaskContextArtifact({ taskId: "task-1", toolCallId: "call-rebuild", content: "ok" });
		const index = await readTaskArtifactIndex("task-1");
		expect(Object.keys(index)).toEqual(["call-rebuild"]);
	});
});

describe("classifyArtifactContentFormat", () => {
	let temp: { path: string; cleanup: () => void };

	beforeEach(() => {
		temp = createTempDir("kanban-diag-artifacts-format-");
		workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(temp.path);
	});

	afterEach(() => {
		temp.cleanup();
		workspaceStateMocks.getTaskWorktreesHomePath.mockReset();
	});

	it("labels JSON-shaped content as json-text and everything else as text", async () => {
		const dir = getTaskContextArtifactsDir("task-1");
		await mkdir(dir, { recursive: true });
		const jsonPath = join(dir, "json.txt");
		const textPath = join(dir, "text.txt");
		const brokenJsonPath = join(dir, "broken.txt");
		await writeFile(jsonPath, '{"a": [1, 2, 3]}');
		await writeFile(textPath, "hello { not json");
		await writeFile(brokenJsonPath, '{"a": 1,');
		expect(await classifyArtifactContentFormat(jsonPath)).toBe("json-text");
		expect(await classifyArtifactContentFormat(textPath)).toBe("text");
		expect(await classifyArtifactContentFormat(brokenJsonPath)).toBe("text");
	});
});
