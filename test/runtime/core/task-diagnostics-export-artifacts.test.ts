// DIAG-2 (2b): full-tool-output recovery alongside its transcript position —
// sidecar-index resolution, filename fallback, legacy reference parsing,
// untrusted-reference rejection, and explicit per-result gaps.
import { appendFile, mkdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	classifyArtifactContentFormat,
	resolveTaskToolFullOutput,
} from "../../../src/core/task-diagnostics-export-artifacts";
import {
	appendTaskArtifactIndexEntry,
	readTaskArtifactIndex,
	TASK_ARTIFACT_INDEX_FILE_NAME,
} from "../../../src/workspace/task-artifact-index";
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

	it("resolves the full output through the sidecar index with exact content (2MB+, streamed json-text)", async () => {
		// Larger than the historical 64KB cap: the classifier must stream
		// (constant memory) instead of reading the whole file into memory.
		const content = JSON.stringify({ rows: Array.from({ length: 150000 }, (_, i) => ({ id: i, note: "value" })) });
		expect(content.length).toBeGreaterThan(2000000);
		await writeTaskContextArtifact({ taskId: "task-1", toolCallId: "call_abc", content });
		const evidence = await resolveTaskToolFullOutput({ taskId: "task-1", toolCallId: "call_abc" });
		expect(evidence.status).toBe("resolved");
		expect(evidence.artifactFileName).toMatch(/^call_abc-\d+-[0-9a-f]{8}\.txt$/);
		expect(evidence.artifactPath).toBeTypeOf("string");
		expect(evidence.contentFormat).toBe("json-text");
		expect(evidence.gap).toBeNull();
		expect(await readFile(evidence.artifactPath ?? "", "utf8")).toBe(content);
	});

	it("labels a multi-MB non-JSON artifact that looks like JSON as text (no full-read parse)", async () => {
		// Starts with `{` and is truncated mid-document: JSON.parse would throw
		// on the full read; the streaming validator must report text without
		// holding the whole file or a parsed copy.
		const content = `{ "rows": [1, 2, 3,${" 4".repeat(1000000)}`;
		expect(content.length).toBeGreaterThan(2000000);
		await writeTaskContextArtifact({ taskId: "task-1", toolCallId: "call-big", content });
		const evidence = await resolveTaskToolFullOutput({ taskId: "task-1", toolCallId: "call-big" });
		expect(evidence.status).toBe("resolved");
		expect(evidence.contentFormat).toBe("text");
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
	it("resolves the current bracketed marker styles (chars and lines, with reference)", async () => {
		const dir = getTaskContextArtifactsDir("task-1");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "current-1-111-abcdef01.txt"), "current output");
		const reference = join(dir, "current-1-111-abcdef01.txt");
		const styles = [
			`head ... [truncated 120 lines; full output: ${reference}] tail`,
			`head ... [truncated 4096 chars; full output: ${reference}] tail`,
		];
		for (const persistedResultText of styles) {
			const evidence = await resolveTaskToolFullOutput({
				taskId: "task-1",
				toolCallId: "current-1",
				persistedResultText,
			});
			expect(evidence.status).toBe("resolved");
			expect(evidence.artifactFileName).toBe("current-1-111-abcdef01.txt");
		}
		// A referenceless marker still resolves through the deterministic
		// filename fallback (no reference to parse).
		const evidence = await resolveTaskToolFullOutput({
			taskId: "task-1",
			toolCallId: "current-1",
			persistedResultText: "head ... [truncated 4096 chars] tail",
		});
		expect(evidence.status).toBe("resolved");
	});

	it("trusts the content format recorded in the sidecar index without re-reading the file", async () => {
		const dir = getTaskContextArtifactsDir("task-1");
		await mkdir(dir, { recursive: true });
		const fileName = "call-rec-1-abcdef01.txt";
		// Plain-text content, but the index records json-text: the recorded
		// classification must win (no re-read, no re-classification).
		await writeFile(join(dir, fileName), "plain text content");
		await appendTaskArtifactIndexEntry({
			taskId: "task-1",
			toolCallId: "call-rec",
			fileName,
			contentFormat: "json-text",
		});
		const evidence = await resolveTaskToolFullOutput({ taskId: "task-1", toolCallId: "call-rec" });
		expect(evidence.status).toBe("resolved");
		expect(evidence.artifactFileName).toBe(fileName);
		expect(evidence.contentFormat).toBe("json-text");
	});

	it("falls back to the streaming classifier for index entries written before contentFormat existed", async () => {
		const dir = getTaskContextArtifactsDir("task-1");
		await mkdir(dir, { recursive: true });
		const fileName = "call-old-1-abcdef01.txt";
		await writeFile(join(dir, fileName), '{"a": 1}');
		await appendTaskArtifactIndexEntry({ taskId: "task-1", toolCallId: "call-old", fileName });
		const evidence = await resolveTaskToolFullOutput({ taskId: "task-1", toolCallId: "call-old" });
		expect(evidence.status).toBe("resolved");
		expect(evidence.contentFormat).toBe("json-text");
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
		const arrayPath = join(dir, "array.txt");
		const scalarPath = join(dir, "scalar.txt");
		const trailingPath = join(dir, "trailing.txt");
		const escapePath = join(dir, "escape.txt");
		await writeFile(jsonPath, '{"a": [1, 2, 3]}');
		await writeFile(textPath, "hello { not json");
		await writeFile(brokenJsonPath, '{"a": 1,');
		await writeFile(arrayPath, "[1, 2, [3]]");
		await writeFile(scalarPath, "123");
		await writeFile(trailingPath, '{"a": 1} trailing');
		await writeFile(escapePath, '{"a": "\\u0041\\n"}');
		expect(await classifyArtifactContentFormat(jsonPath)).toBe("json-text");
		expect(await classifyArtifactContentFormat(textPath)).toBe("text");
		expect(await classifyArtifactContentFormat(brokenJsonPath)).toBe("text");
		// Root arrays count; a bare scalar root stays text (legacy semantics).
		expect(await classifyArtifactContentFormat(arrayPath)).toBe("json-text");
		expect(await classifyArtifactContentFormat(scalarPath)).toBe("text");
		// Trailing content after the document keeps it text (single document).
		expect(await classifyArtifactContentFormat(trailingPath)).toBe("text");
		expect(await classifyArtifactContentFormat(escapePath)).toBe("json-text");
	});

	it("classifies a multi-MB document by streaming, never holding the whole file", async () => {
		// 3MB of valid JSON built without ever materializing a second full copy:
		// the streaming validator must report json-text in constant memory.
		const dir = getTaskContextArtifactsDir("task-1");
		await mkdir(dir, { recursive: true });
		const largePath = join(dir, "large.txt");
		const row = JSON.stringify({ id: 1, note: "value" });
		const chunk = `, ${row}`;
		await writeFile(largePath, `[${row}`);
		for (let i = 0; i < 80000; i += 1) {
			await appendFile(largePath, chunk);
		}
		await appendFile(largePath, `]`);
		const info = await stat(largePath);
		expect(info.size).toBeGreaterThan(2000000);
		expect(await classifyArtifactContentFormat(largePath)).toBe("json-text");
	});
});
