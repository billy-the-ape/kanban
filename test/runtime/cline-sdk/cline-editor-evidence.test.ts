import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CLINE_EDITOR_EVIDENCE_MAX_FILE_BYTES,
	collectEditorEvidence,
	EVIDENCE_MAX_WINDOW_CHARS,
} from "../../../src/cline-sdk/cline-editor-evidence";

describe("AR-2 bounded editor failure evidence", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "editor-evidence-"));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("counts exact occurrences with SDK semantics (non-overlapping split)", async () => {
		const path = join(cwd, "file");
		await writeFile(path, "same same");
		const evidence = await collectEditorEvidence({ cwd, input: { path, old_text: "same", new_text: "x" } });
		expect(evidence.file?.state).toBe("read");
		expect(evidence.oldText?.matchCount).toBe(2);
		expect(evidence.candidates).toBeNull();
	});

	it("locates an approximate candidate for a wrong tab count and reports the tab facts", async () => {
		const path = join(cwd, "target.ts");
		await writeFile(path, "line one\n\t\tindented = true;\nline three\n");
		const evidence = await collectEditorEvidence({
			cwd,
			// The model submitted three TABs; the source line has two.
			input: { path, old_text: "\t\t\tindented = true;", new_text: "replaced" },
		});
		expect(evidence.oldText?.matchCount).toBe(0);
		expect(evidence.candidates?.approximate).toBe(true);
		expect(evidence.candidates?.windows).toHaveLength(1);
		const window = evidence.candidates?.windows[0];
		expect(window?.lines).toContain("\t\tindented = true;");
		expect(evidence.candidates?.candidateLines[0]?.leadingTabs).toBe(2);
		expect(evidence.oldText?.lines[0]?.leadingTabs).toBe(3);
		expect(evidence.candidates?.note).toContain("submitted line 1 begins with 3 TAB character(s)");
		expect(evidence.candidates?.note).toContain("candidate line 2 begins with 2 TAB character(s)");
	});

	it("distinguishes a literal backslash-t sequence from a real TAB", async () => {
		const path = join(cwd, "target.ts");
		await writeFile(path, "\t\tcode();\n");
		const evidence = await collectEditorEvidence({
			cwd,
			// The model sent the two-character sequence backslash-t instead of TABs.
			input: { path, old_text: "\\t\\tcode();", new_text: "code(); // done" },
		});
		expect(evidence.oldText?.matchCount).toBe(0);
		expect(evidence.oldText?.lines[0]?.literalBackslashTab).toBe(true);
		expect(evidence.candidates?.windows).toHaveLength(1);
		expect(evidence.candidates?.candidateLines[0]?.leadingTabs).toBe(2);
		expect(evidence.candidates?.note).toContain("literal backslash-t sequence");
	});

	it("covers a multi-line candidate span and reports per-line whitespace facts", async () => {
		const path = join(cwd, "block.ts");
		await writeFile(path, "  alpha\n\tbeta\nrest");
		const evidence = await collectEditorEvidence({
			cwd,
			input: { path, old_text: "alpha\nbeta", new_text: "alpha" },
		});
		expect(evidence.oldText?.matchCount).toBe(0);
		const window = evidence.candidates?.windows[0];
		expect(window?.startLine).toBe(1);
		expect(window?.lines).toEqual(["  alpha", "\tbeta", "rest"]);
		expect(evidence.candidates?.candidateLines.map((line) => line.line)).toEqual([1, 2]);
		expect(evidence.candidates?.note).toContain("TAB character(s)");
		expect(evidence.candidates?.note).toContain("space(s)");
	});

	it("reports no trustworthy candidate instead of inventing one", async () => {
		const path = join(cwd, "file");
		await writeFile(path, "unrelated content\n");
		const evidence = await collectEditorEvidence({ cwd, input: { path, old_text: "zzz", new_text: "x" } });
		expect(evidence.oldText?.matchCount).toBe(0);
		expect(evidence.candidates?.windows).toEqual([]);
		expect(evidence.candidates?.note).toContain("No trustworthy nearby candidate");
	});

	it("reports field presence, type, and length without echoing the replacement payload", async () => {
		const path = join(cwd, "file");
		await writeFile(path, "original");
		const payload = "SECRET-NEW-TEXT-PAYLOAD-".repeat(20);
		const evidence = await collectEditorEvidence({
			cwd,
			input: { path, old_text: "original", new_text: payload, insert_line: 3 },
		});
		expect(evidence.fields.path).toEqual({ present: true, type: "string", length: path.length });
		expect(evidence.fields.old_text).toEqual({ present: true, type: "string", length: 8 });
		expect(evidence.fields.new_text).toEqual({ present: true, type: "string", length: payload.length });
		expect(evidence.fields.insert_line).toEqual({ present: true, type: "number" });
		expect(evidence.oldText?.matchCount).toBe(1);
		expect(JSON.stringify(evidence)).not.toContain("SECRET-NEW-TEXT-PAYLOAD");
	});

	it("reports an absent old_text as absent in the parsed call", async () => {
		const path = join(cwd, "file");
		await writeFile(path, "original");
		const evidence = await collectEditorEvidence({ cwd, input: { path, new_text: "x" } });
		expect(evidence.fields.old_text).toEqual({ present: false, type: "absent" });
		expect(evidence.oldText).toBeNull();
	});

	it("marks the unchanged fields for a repeated failure", async () => {
		const path = join(cwd, "file");
		await writeFile(path, "original");
		const evidence = await collectEditorEvidence({
			cwd,
			input: { path, old_text: "missing", new_text: "x" },
			repeated: true,
		});
		expect(evidence.repeated?.unchangedFields).toEqual(["path", "old_text", "new_text"]);
	});

	it("skips external paths and symlink escapes with a reason", async () => {
		const outside = await mkdtemp(join(tmpdir(), "editor-evidence-outside-"));
		const outsideFile = join(outside, "outside.txt");
		await writeFile(outsideFile, "outside");
		try {
			const absolute = await collectEditorEvidence({
				cwd,
				input: { path: outsideFile, old_text: "outside", new_text: "x" },
			});
			expect(absolute.file?.state).toBe("skipped");
			expect(absolute.file?.reason).toContain("outside the task worktree");

			const link = join(cwd, "link.txt");
			await symlink(outsideFile, link);
			const escaped = await collectEditorEvidence({
				cwd,
				input: { path: link, old_text: "outside", new_text: "x" },
			});
			expect(escaped.file?.state).toBe("skipped");
			expect(escaped.file?.reason).toContain("outside the task worktree");

			const insideLink = join(cwd, "inside-link.txt");
			const insideFile = join(cwd, "real.txt");
			await writeFile(insideFile, "inside");
			await symlink(insideFile, insideLink);
			const inside = await collectEditorEvidence({
				cwd,
				input: { path: insideLink, old_text: "inside", new_text: "x" },
			});
			expect(inside.file?.state).toBe("read");
			expect(inside.oldText?.matchCount).toBe(1);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("skips a binary file, an oversized file, a missing file, and a directory with reasons", async () => {
		const binaryPath = join(cwd, "binary.bin");
		await writeFile(binaryPath, "abc\0def");
		const binary = await collectEditorEvidence({ cwd, input: { path: binaryPath, old_text: "abc", new_text: "x" } });
		expect(binary.file).toEqual({ state: "skipped", sizeBytes: 7, reason: "binary file" });

		const largePath = join(cwd, "large.bin");
		await writeFile(largePath, Buffer.alloc(CLINE_EDITOR_EVIDENCE_MAX_FILE_BYTES + 1));
		const large = await collectEditorEvidence({ cwd, input: { path: largePath, old_text: "x", new_text: "x" } });
		expect(large.file?.state).toBe("skipped");
		expect(large.file?.sizeBytes).toBe(CLINE_EDITOR_EVIDENCE_MAX_FILE_BYTES + 1);
		expect(large.file?.reason).toContain("over the");

		const missing = await collectEditorEvidence({
			cwd,
			input: { path: join(cwd, "nope.txt"), old_text: "x", new_text: "x" },
		});
		expect(missing.file?.state).toBe("skipped");
		expect(missing.file?.reason).toContain("missing or cannot be resolved");

		const directory = await collectEditorEvidence({ cwd, input: { path: cwd, old_text: "x", new_text: "x" } });
		expect(directory.file?.state).toBe("skipped");
		expect(directory.file?.reason).toBe("not a regular file");
	});

	it("skips an unreadable file with a reason", async () => {
		// Root ignores permission bits, so this can only be exercised unprivileged.
		if (typeof process.geteuid !== "function" || process.geteuid() === 0) return;
		const path = join(cwd, "locked");
		await writeFile(path, "secret");
		await chmod(path, 0);
		const evidence = await collectEditorEvidence({ cwd, input: { path, old_text: "secret", new_text: "x" } });
		expect(evidence.file?.state).toBe("skipped");
		expect(evidence.file?.reason).toContain("unreadable");
	});

	it("counts CRLF content and shows window lines without the carriage return", async () => {
		const path = join(cwd, "crlf.txt");
		await writeFile(path, "a\r\nb\r\nc\r\n");
		const evidence = await collectEditorEvidence({ cwd, input: { path, old_text: "b", new_text: "B" } });
		expect(evidence.file?.state).toBe("read");
		expect(evidence.file?.lineEnding).toBe("crlf");
		expect(evidence.file?.lineCount).toBe(4);
		expect(evidence.oldText?.matchCount).toBe(1);
	});

	it("counts Unicode anchors exactly", async () => {
		const path = join(cwd, "unicode.txt");
		await writeFile(path, "héllo wörld\nhéllo wörld\n");
		const evidence = await collectEditorEvidence({ cwd, input: { path, old_text: "héllo wörld", new_text: "x" } });
		expect(evidence.oldText?.matchCount).toBe(2);
	});

	it("bounds windows to two, eight surrounding lines each, and 6,000 characters total", async () => {
		const path = join(cwd, "long.txt");
		const longLine = "L".repeat(250);
		// The submitted anchor has extra leading spaces, so it matches zero times
		// exactly, but whitespace normalization locates both occurrences.
		const lines: string[] = [
			"start",
			"same",
			longLine,
			longLine,
			longLine,
			"mid",
			longLine,
			longLine,
			"same",
			longLine,
			"end",
		];
		await writeFile(path, lines.join("\n"));
		const evidence = await collectEditorEvidence({ cwd, input: { path, old_text: "  same", new_text: "x" } });
		const windows = evidence.candidates?.windows ?? [];
		expect(evidence.oldText?.matchCount).toBe(0);
		expect(windows).toHaveLength(2);
		expect(windows[0]?.lines).toContain("same");
		for (const window of windows) {
			expect(window.endLine - window.startLine + 1).toBe(window.lines.length);
			expect(window.lines.length).toBeLessThanOrEqual(17);
		}
		const total = windows.map((window) => window.lines.join("\n").length).reduce((sum, length) => sum + length, 0);
		expect(total).toBeLessThanOrEqual(6000);
	});

	it("keeps a multi-line long-line candidate span within the per-window budget", async () => {
		const path = join(cwd, "span.txt");
		const longLine = "A".repeat(199) + " ";
		const lines: string[] = ["start", ...Array.from({ length: 16 }, () => longLine), "end"];
		await writeFile(path, lines.join("\n"));
		// The submitted span differs from the file only by a trailing space per line,
		// so it matches zero times exactly but normalizes to the 16-line span.
		const oldText = Array.from({ length: 16 }, () => "A".repeat(199)).join("\n");
		const evidence = await collectEditorEvidence({ cwd, input: { path, old_text: oldText, new_text: "x" } });
		expect(evidence.oldText?.matchCount).toBe(0);
		const window = evidence.candidates?.windows[0];
		// The 16 × 200-char span alone exceeds the 3,000-char per-window budget, so the
		// window is clipped from the tail of the span — never from its head.
		const perWindow = Math.floor(EVIDENCE_MAX_WINDOW_CHARS / 2);
		expect(window?.startLine).toBe(2);
		expect(window?.lines.every((line) => line === longLine)).toBe(true);
		expect(window?.lines.length).toBeGreaterThan(1);
		expect(window?.lines.length).toBeLessThan(16);
		expect(window?.lines.join("\n").length).toBeLessThanOrEqual(perWindow);
		expect(window?.truncated).toBe(true);
		// The candidate line list still starts at the span's first line.
		expect(evidence.candidates?.candidateLines[0]?.line).toBe(2);
	});

	it("never drops candidate span lines when surrounding context is asymmetric", async () => {
		const path = join(cwd, "top.txt");
		const spanLine = "B".repeat(199) + " ";
		const fillLine = "C".repeat(199) + " ";
		// A 16-line candidate span at the top of the file, followed by more lines:
		// no leading context exists, so trimming must only remove trailing context.
		const lines: string[] = [
			...Array.from({ length: 16 }, () => spanLine),
			...Array.from({ length: 10 }, () => fillLine),
		];
		await writeFile(path, lines.join("\n"));
		const oldText = Array.from({ length: 16 }, () => "B".repeat(199)).join("\n");
		const evidence = await collectEditorEvidence({ cwd, input: { path, old_text: oldText, new_text: "x" } });
		expect(evidence.oldText?.matchCount).toBe(0);
		const window = evidence.candidates?.windows[0];
		const perWindow = Math.floor(EVIDENCE_MAX_WINDOW_CHARS / 2);
		expect(window?.startLine).toBe(1);
		expect(window?.lines[0]).toBe(spanLine);
		expect(window?.lines.every((line) => line === spanLine)).toBe(true);
		expect(window?.lines.join("\n").length).toBeLessThanOrEqual(perWindow);
		expect(window?.truncated).toBe(true);
	});

	it("handles a stale file read: evidence reflects the source at read time", async () => {
		const path = join(cwd, "stale.txt");
		await writeFile(path, "before\n");
		const before = await collectEditorEvidence({ cwd, input: { path, old_text: "before", new_text: "x" } });
		expect(before.oldText?.matchCount).toBe(1);
		await writeFile(path, "after\n");
		const after = await collectEditorEvidence({ cwd, input: { path, old_text: "before", new_text: "x" } });
		expect(after.oldText?.matchCount).toBe(0);
		expect(after.candidates?.windows).toEqual([]);
	});
});
