import { describe, expect, it } from "vitest";
import type { ClineCommandOutputEntry } from "../../src/cline-sdk/cline-command-output-excerpt";
import {
	buildCommandOutputExcerpt,
	buildDiffFileSummary,
	parseCommandOutputEntries,
} from "../../src/cline-sdk/cline-command-output-excerpt";

describe("parseCommandOutputEntries", () => {
	it("parses a multi-command run_commands result array", () => {
		const entries = parseCommandOutputEntries([
			{ query: "echo one", result: "first body\nsecond", success: true },
			{ query: "echo two", result: "third", success: true },
		]);
		expect(entries).toHaveLength(2);
		expect(entries![0]).toEqual({
			query: "echo one",
			success: true,
			body: "first body\nsecond",
			failureReason: null,
		});
		expect(entries![1]).toEqual({ query: "echo two", success: true, body: "third", failureReason: null });
	});

	it("treats a missing success flag with a non-empty result as success", () => {
		const entries = parseCommandOutputEntries([{ query: "q", result: "out" }]);
		expect(entries).toHaveLength(1);
		expect(entries![0]).toMatchObject({ success: true, body: "out" });
	});

	it("uses the error text as the body for a failed command with an empty result (SDK shape)", () => {
		const stderr = Array.from({ length: 500 }, (_, i) => `stderr line ${i + 1}`).join("\n");
		const entries = parseCommandOutputEntries([
			{ query: "failing", result: "", success: false, error: `Command failed: ${stderr}` },
		]);
		expect(entries).toHaveLength(1);
		expect(entries![0]).toMatchObject({ query: "failing", success: false });
		expect(entries![0]!.body).toBe(`Command failed: ${stderr}`);
		expect(entries![0]!.failureReason).toBe("Command failed: stderr line 1");
	});

	it("keeps partial stdout ahead of the error text on failure", () => {
		const entries = parseCommandOutputEntries([
			{ query: "failing", result: "partial out", success: false, error: "boom" },
		]);
		expect(entries).toHaveLength(1);
		expect(entries![0]!.body).toBe("partial out\nboom");
		expect(entries![0]!.failureReason).toBe("boom");
	});

	it("returns null for strings, empty arrays, non-object items, and missing fields", () => {
		expect(parseCommandOutputEntries("plain text")).toBeNull();
		expect(parseCommandOutputEntries([])).toBeNull();
		expect(parseCommandOutputEntries(["not-an-object"])).toBeNull();
		expect(parseCommandOutputEntries([{}])).toBeNull();
		expect(parseCommandOutputEntries([{ result: "body-only" }])).toBeNull();
		expect(parseCommandOutputEntries([{ query: "only-query" }])).toBeNull();
		expect(parseCommandOutputEntries([{ query: "q", success: false }])).toBeNull();
	});

	it("parses a single record object (non-array) as one entry", () => {
		const entries = parseCommandOutputEntries({ query: "q", result: "b", success: true });
		expect(entries).toEqual([{ query: "q", success: true, body: "b", failureReason: null }]);
	});
});

describe("buildCommandOutputExcerpt", () => {
	const artifactPath = "/tmp/artifact.txt";
	const entry = (overrides: Partial<ClineCommandOutputEntry> & { query: string }): ClineCommandOutputEntry => ({
		success: true,
		body: "",
		failureReason: null,
		...overrides,
	});

	it("returns null for an empty entry list or a budget that cannot fit the metadata", () => {
		expect(buildCommandOutputExcerpt([], { budgetChars: 4_000, artifactPath })).toBeNull();
		expect(
			buildCommandOutputExcerpt([entry({ query: "q", body: "b" })], { budgetChars: 10, artifactPath }),
		).toBeNull();
	});

	it("keeps the whole body when it fits the budget", () => {
		const result = buildCommandOutputExcerpt([entry({ query: "q", body: "one\ntwo" })], {
			budgetChars: 4_000,
			artifactPath,
		});
		expect(result).not.toBeNull();
		expect(result!.text).toBe("Command 1/1: q\nExit status: success\none\ntwo");
		expect(result).toMatchObject({ headLines: 2, tailLines: 0, omittedLines: 0, truncated: false });
	});

	it("emits head lines, an exact omitted-lines marker, and tail lines", () => {
		const body = Array.from({ length: 1_000 }, (_, i) => `line-${i + 1}`).join("\n");
		const result = buildCommandOutputExcerpt([entry({ query: "seq 1 1000", body })], {
			budgetChars: 4_000,
			artifactPath,
		})!;
		const expectedLines = result.text.split("\n");
		// 2 metadata lines + head 100 + marker + tail 100.
		expect(expectedLines).toHaveLength(203);
		expect(expectedLines[0]).toBe("Command 1/1: seq 1 1000");
		expect(expectedLines[1]).toBe("Exit status: success");
		expect(expectedLines[2]).toBe("line-1");
		expect(expectedLines[101]).toBe("line-100");
		expect(expectedLines[102]).toBe(`... [truncated 800 lines; full output: ${artifactPath}]`);
		expect(expectedLines[103]).toBe("line-901");
		expect(expectedLines[202]).toBe("line-1000");
		expect(result.text).not.toContain("line-500");
		expect(result.text.length).toBeLessThanOrEqual(4_000);
		expect(result).toMatchObject({ headLines: 100, tailLines: 100, omittedLines: 800, truncated: true });
	});

	it("honors custom head/tail counts and omits the artifact suffix when no path is given", () => {
		// Long lines so the body exceeds the budget and line truncation kicks in.
		const body = Array.from({ length: 120 }, (_, i) => `l${i + 1}` + "p".repeat(55)).join("\n");
		const result = buildCommandOutputExcerpt([entry({ query: "q", body })], {
			budgetChars: 4_000,
			headLines: 10,
			tailLines: 15,
		})!;
		const expectedLines = result.text.split("\n");
		const pad = "p".repeat(55);
		expect(expectedLines).toHaveLength(28);
		expect(expectedLines[0]).toBe("Command 1/1: q");
		expect(expectedLines[2]).toBe(`l1${pad}`);
		expect(expectedLines[11]).toBe(`l10${pad}`);
		expect(expectedLines[12]).toBe("... [truncated 95 lines]");
		expect(expectedLines[13]).toBe(`l106${pad}`);
		expect(expectedLines[27]).toBe(`l120${pad}`);
		expect(result.omittedLines).toBe(95);
	});

	it("shrinks head and tail together until the budget fits", () => {
		const body = Array.from({ length: 20_000 }, (_, i) => `long line ${i + 1} with more payload`).join("\n");
		const result = buildCommandOutputExcerpt([entry({ query: "q", body })], { budgetChars: 800, artifactPath })!;
		expect(result.text.length).toBeLessThanOrEqual(800);
		expect(result.text).toContain("long line 1 with more payload\n");
		expect(result.text.endsWith("long line 20000 with more payload")).toBe(true);
		expect(result.text).toMatch(/\.\.\. \[truncated \d+ lines; full output: \/tmp\/artifact\.txt\]/);
		expect(result.truncated).toBe(true);
		expect(result.headLines + result.tailLines).toBeLessThan(200);
	});

	it("falls back to a char cut when no line share fits the budget", () => {
		const result = buildCommandOutputExcerpt(
			[entry({ query: "q", body: "a".repeat(5_000) + "\n" + "b".repeat(5_000) })],
			{ budgetChars: 400, artifactPath },
		)!;
		expect(result.text.length).toBeLessThanOrEqual(400);
		expect(result.text.startsWith(`Command 1/1: q\nExit status: success\n${"a".repeat(150)}`)).toBe(true);
		expect(result.text.endsWith("b".repeat(150))).toBe(true);
		expect(result.text).toMatch(/\.\.\. \[truncated \d+ chars; full output: \/tmp\/artifact\.txt\]/);
		expect(result.truncated).toBe(true);
	});

	it("keeps each command's status lines and bounds the other commands' bodies", () => {
		const entries: ClineCommandOutputEntry[] = [
			entry({ query: "one", body: "ok" }),
			entry({
				query: "two",
				body: Array.from({ length: 300 }, (_, i) => `x${i + 1}`).join("\n"),
			}),
			entry({ query: "three", body: "boom", success: false, failureReason: "Command failed: boom" }),
		];
		const result = buildCommandOutputExcerpt(entries, { budgetChars: 500, artifactPath })!;
		const lines = result.text.split("\n");
		expect(result.text.length).toBeLessThanOrEqual(500);
		expect(lines[0]).toBe("Command 1/3: one");
		expect(lines[1]).toBe("Exit status: success");
		expect(lines[2]).toBe("ok");
		const thirdIndex = lines.findIndex((line) => line === "Command 3/3: three");
		expect(thirdIndex).toBeGreaterThan(-1);
		expect(lines[thirdIndex + 1]).toBe("Exit status: failed — Command failed: boom");
		expect(result.truncated).toBe(true);
	});

	it("caps long queries and failure reasons", () => {
		const result = buildCommandOutputExcerpt(
			[
				entry({
					query: "npm run " + "t".repeat(500),
					body: "x",
					success: false,
					failureReason: "Command failed: " + "e".repeat(200),
				}),
			],
			{ budgetChars: 4_000, artifactPath },
		)!;
		const lines = result.text.split("\n");
		expect(lines[0]).toBe(`Command 1/1: ${"npm run " + "t".repeat(192)}...`);
		expect(lines[1]).toBe(`Exit status: failed — ${"Command failed: " + "e".repeat(104)}...`);
	});

	it("emits a bare Exit status: failed when the entry has no failure reason", () => {
		const result = buildCommandOutputExcerpt(
			[entry({ query: "q", body: "boom\nmore", success: false, failureReason: null })],
			{ budgetChars: 4_000, artifactPath },
		)!;
		expect(result.text).toBe("Command 1/1: q\nExit status: failed\nboom\nmore");
	});

	it("prepends a per-file diff summary to the metadata head", () => {
		const diffBody = [
			"diff --git a/big.txt b/big.txt",
			"--- a/big.txt",
			"+++ b/big.txt",
			"@@ -1,10 +1,50 @@",
			...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`),
		].join("\n");
		const result = buildCommandOutputExcerpt([entry({ query: "git diff", body: diffBody })], {
			budgetChars: 4_000,
			artifactPath,
		})!;
		const lines = result.text.split("\n");
		expect(lines[0]).toBe("Command 1/1: git diff");
		expect(lines[1]).toBe("Exit status: success");
		expect(lines[2]).toBe("Diff summary (1 file):");
		expect(lines[3]).toBe("  big.txt | +50 -10");
		expect(lines[4]).toBe("diff --git a/big.txt b/big.txt");
	});
});

describe("buildDiffFileSummary", () => {
	const diff = [
		"diff --git a/src/large.ts b/src/large.ts",
		"--- a/src/large.ts",
		"+++ b/src/large.ts",
		"@@ -1,10 +1,50 @@",
		"-removed",
		"+added",
		"diff --git a/src/small.ts b/src/small.ts",
		"--- a/src/small.ts",
		"+++ b/src/small.ts",
		"@@ -1,1 +1,2 @@",
		"+only-add",
	].join("\n");

	it("sums added/removed line counts per file from hunk headers", () => {
		expect(buildDiffFileSummary(diff)).toEqual([
			"Diff summary (2 files):",
			"  src/large.ts | +50 -10",
			"  src/small.ts | +2 -1",
		]);
	});

	it("collapses files beyond maxFileLines", () => {
		const many = Array.from({ length: 30 }, (_, i) =>
			[`diff --git a/f${i}.ts b/f${i}.ts`, "--- a/f", "+++ b/f", `@@ -1,1 +1,${i + 2} @@`, "+x"].join("\n"),
		).join("\n");
		const lines = buildDiffFileSummary(many, 20);
		expect(lines).toHaveLength(22);
		expect(lines[0]).toBe("Diff summary (30 files):");
		expect(lines[1]).toBe("  f0.ts | +2 -1");
		expect(lines[21]).toBe("  ... and 10 more files");
	});

	it("uses the destination path for renames", () => {
		const renamed = [
			"diff --git a/old.ts b/new.ts",
			"rename from old.ts",
			"rename to new.ts",
			"@@ -1,1 +1,1 @@",
			"same",
		].join("\n");
		expect(buildDiffFileSummary(renamed)).toEqual(["Diff summary (1 file):", "  new.ts | +1 -1"]);
	});

	it("returns an empty summary for non-diff output", () => {
		expect(buildDiffFileSummary("not a diff at all")).toEqual([]);
		expect(buildDiffFileSummary("")).toEqual([]);
		expect(buildDiffFileSummary("diff --git a/x b/x\n--- a/x\n+++ b/x\nno hunks here")).toEqual([]);
	});
});
