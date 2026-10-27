// AR-2 — Bounded current-source evidence for failed editor calls.
//
// After an approved editor call fails, the recovery hook
// (`cline-tool-failure-recovery`) attaches this best-effort, machine-readable
// evidence to the model-facing recovery envelope so the model can correct its
// arguments without guessing tab counts or assuming the harness dropped a
// field. The evidence read:
// - happens only after the call already failed (never before approval and never
//   after an approval denial, which does not reach this path),
// - is confined to the task worktree after realpath checks (external paths and
//   symlink escapes are skipped with a reason),
// - skips non-files, binary files, files over 256 KiB, and unreadable files,
//   each with a reason,
// - uses asynchronous bounded I/O under a hard timeout, and
// - never throws, never writes, and never echoes the replacement payload.
//
// Exact occurrence counting mirrors the SDK editor executor
// (@clinebot/core 0.0.38): `content.split(old_text).length - 1` — an exact,
// non-overlapping substring count. Whitespace-normalized candidates are
// explanation-only: they locate nearby source after treating TAB characters,
// spaces, and literal backslash-t sequences the same, and are always marked
// approximate. They never assert an exact match.

import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

/** Files larger than this are skipped with a reason instead of read. */
export const CLINE_EDITOR_EVIDENCE_MAX_FILE_BYTES = 256 * 1024;
/** Hard budget for the whole asynchronous evidence read. */
const EVIDENCE_READ_TIMEOUT_MS = 5_000;
/** At most this many nearby-source windows. */
export const EVIDENCE_MAX_WINDOWS = 2;
/** Surrounding context lines shown on each side of a candidate span. */
export const EVIDENCE_SURROUNDING_LINES = 8;
/** Total character budget across all displayed source windows. */
export const EVIDENCE_MAX_WINDOW_CHARS = 6_000;
/** Each displayed source line is clipped to this many characters. */
const MAX_DISPLAY_LINE_CHARS = 200;
/** Per-line detail is limited to this many submitted old_text lines. */
const MAX_DETAIL_LINES = 12;
/** Binary detection scans this many leading characters. */
const BINARY_PROBE_CHARS = 8_192;
/** At most this many whitespace-comparison facts are reported. */
const MAX_WHITESPACE_FACTS = 3;

/** Presence, type, and (for strings) length of one editor input field. */
export interface EditorEvidenceField {
	present: boolean;
	/** `"absent"` when the field was not in the parsed call. */
	type: string;
	length?: number;
}

/** Measured leading-whitespace facts for one line, kept distinct from source text. */
export interface EditorEvidenceLineInfo {
	/** 1-based line number (within the submitted old_text, or within the file). */
	line: number;
	leadingTabs: number;
	leadingSpaces: number;
	/** True when the leading whitespace contains the two-character `\t` sequence. */
	literalBackslashTab: boolean;
	/** Raw text clipped for display; never a verified exact anchor. */
	text: string;
}

/** A bounded current-source window around an approximate candidate. */
export interface EditorEvidenceWindow {
	startLine: number;
	endLine: number;
	/** Display text (clipped), one entry per line, aligned with startLine..endLine. */
	lines: string[];
	truncated: boolean;
}

/** Whitespace-normalized nearby-source candidates, always approximate. */
export interface EditorEvidenceCandidates {
	approximate: true;
	/** Explanation of how the candidate relates to the submitted anchor. */
	note: string;
	windows: EditorEvidenceWindow[];
	candidateLines: EditorEvidenceLineInfo[];
}

/** Machine-readable evidence attached to a failed editor recovery envelope. */
export interface EditorEvidence {
	version: 1;
	/** ISO timestamp of when the current source was read. */
	readAt: string;
	requestedPath: string | null;
	resolvedPath: string | null;
	file: {
		state: "read" | "skipped";
		reason?: string;
		sizeBytes?: number;
		lineCount?: number;
		lineEnding?: "lf" | "crlf" | "mixed";
	} | null;
	fields: {
		path: EditorEvidenceField;
		old_text: EditorEvidenceField;
		new_text: EditorEvidenceField;
		insert_line: EditorEvidenceField;
	};
	oldText: {
		length: number;
		lineCount: number;
		/** Exact occurrence count (SDK semantics); null when not safely calculable. */
		matchCount: number | null;
		lines: EditorEvidenceLineInfo[];
	} | null;
	candidates: EditorEvidenceCandidates | null;
	/** Present only for an unchanged repeated failure: the relevant fields that did not change. */
	repeated: {
		unchangedFields: string[];
	} | null;
}

export interface CollectEditorEvidenceOptions {
	/** The task worktree the evidence read is confined to. */
	cwd: string;
	/** The parsed editor tool input. */
	input: unknown;
	/** Set when this exact call already failed earlier in the run. */
	repeated?: boolean;
}

function field(input: Record<string, unknown> | null, name: string): EditorEvidenceField {
	const value = input ? input[name] : undefined;
	if (value === undefined || value === null) return { present: false, type: "absent" };
	if (typeof value === "string") return { present: true, type: "string", length: value.length };
	return { present: true, type: typeof value };
}

function relevantEditorFields(input: Record<string, unknown> | null): string[] {
	return ["path", "old_text", "new_text", "insert_line"].filter(
		(name) => input && input[name] !== undefined && input[name] !== null,
	);
}

function lineInfo(line: string, number: number): EditorEvidenceLineInfo {
	let leadingTabs = 0;
	let leadingSpaces = 0;
	let literalBackslashTab = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (char === "\t") {
			leadingTabs += 1;
		} else if (char === " ") {
			leadingSpaces += 1;
		} else if (char === "\\" && line[index + 1] === "t") {
			literalBackslashTab = true;
			index += 1;
		} else {
			break;
		}
	}
	return {
		line: number,
		leadingTabs,
		leadingSpaces,
		literalBackslashTab,
		text: line.slice(0, MAX_DISPLAY_LINE_CHARS),
	};
}

/**
 * Normalizes a line for candidate location only: TAB characters, spaces, CR, and
 * the literal two-character backslash-t sequence all become one space. This
 * deliberately makes those differences invisible — the report back distinguishes
 * them via `EditorEvidenceLineInfo`, and the result is never claimed as exact.
 */
function normalizeLineForCandidate(line: string): string {
	return line
		.replace(/\\t/g, " ")
		.replace(/[\t\r]/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

function countNewlinesBefore(text: string, index: number): number {
	let count = 0;
	for (let i = 0; i < index; i += 1) {
		if (text[i] === "\n") count += 1;
	}
	return count;
}

interface CandidateRange {
	/** 0-based line of the candidate span start. */
	line: number;
	/** Number of file lines the candidate spans. */
	spanLines: number;
	/** 0-based index of the submitted old_text line the span starts at. */
	submittedLine: number;
}

/**
 * Locates at most EVIDENCE_MAX_WINDOWS approximate candidate spans for old_text.
 * File lines are normalized once; the single-line fallback consults a
 * precomputed first-occurrence map and scans at most MAX_DETAIL_LINES submitted
 * lines, so the work is O(file lines + submitted lines) and bounded even for a
 * 32,000-char old_text against a file near the size limit.
 */
function findCandidateRanges(fileLines: string[], oldText: string): CandidateRange[] {
	const normalizedFileLines = fileLines.map(normalizeLineForCandidate);
	const normalizedFile = normalizedFileLines.join("\n");
	const oldLines = oldText.split(/\r?\n/);
	const normalizedOldLines = oldLines.map(normalizeLineForCandidate);
	const normalizedOld = normalizedOldLines.join("\n");
	const ranges: CandidateRange[] = [];
	if (normalizedOld.length > 0) {
		let from = 0;
		while (ranges.length < EVIDENCE_MAX_WINDOWS) {
			const at = normalizedFile.indexOf(normalizedOld, from);
			if (at === -1) break;
			// A whole-block match starts at submitted line 1.
			ranges.push({ line: countNewlinesBefore(normalizedFile, at), spanLines: oldLines.length, submittedLine: 0 });
			from = at + Math.max(1, normalizedOld.length);
		}
	}
	if (ranges.length === 0) {
		const firstIndex = new Map<string, number>();
		normalizedFileLines.forEach((line, index) => {
			if (line.length > 0 && !firstIndex.has(line)) {
				firstIndex.set(line, index);
			}
		});
		const scanned = Math.min(oldLines.length, MAX_DETAIL_LINES);
		for (let i = 0; i < scanned; i += 1) {
			if (ranges.length >= EVIDENCE_MAX_WINDOWS) break;
			const normalized = normalizedOldLines[i];
			if (!normalized || normalized.length === 0) continue;
			const index = firstIndex.get(normalized);
			if (index === undefined) continue;
			if (ranges.some((range) => index >= range.line && index < range.line + range.spanLines)) {
				continue;
			}
			// The range came from submitted line i, so the span starts there.
			ranges.push({ line: index, spanLines: 1, submittedLine: i });
		}
	}
	return ranges;
}

/**
 * Builds one bounded window around a candidate span. Each window gets half of
 * EVIDENCE_MAX_WINDOW_CHARS, so at most EVIDENCE_MAX_WINDOWS windows always stay
 * within the total budget. Surrounding context is trimmed before any candidate
 * span line is removed, and if the span alone still exceeds the budget it is
 * clipped from its tail (the head, where the submitted anchor starts, is kept).
 */
function buildWindow(fileLines: string[], range: CandidateRange): EditorEvidenceWindow {
	const spanStart = range.line;
	const spanEnd = Math.min(range.line + range.spanLines, fileLines.length); // exclusive
	const budget = Math.floor(EVIDENCE_MAX_WINDOW_CHARS / EVIDENCE_MAX_WINDOWS);
	const first = Math.max(0, spanStart - EVIDENCE_SURROUNDING_LINES);
	const last = Math.min(fileLines.length, spanEnd + EVIDENCE_SURROUNDING_LINES); // exclusive
	const all: string[] = [];
	let truncated = false;
	for (let i = first; i < last; i += 1) {
		const text = (fileLines[i] ?? "").replace(/\r$/, "");
		if (text.length > MAX_DISPLAY_LINE_CHARS) {
			truncated = true;
			all.push(text.slice(0, MAX_DISPLAY_LINE_CHARS));
		} else {
			all.push(text);
		}
	}
	// Prefix sums of displayed line lengths (+1 separator each) for O(1) window totals.
	const prefix: number[] = [0];
	for (let i = 0; i < all.length; i += 1) {
		prefix.push(prefix[i] + all[i].length + 1);
	}
	const spanLength = (lo: number, hi: number): number => (hi <= lo ? 0 : prefix[hi] - prefix[lo] - 1);
	const spanOffset = spanStart - first;
	const spanCount = spanEnd - spanStart;
	let lo = 0;
	let hi = all.length; // exclusive
	// 1) Trim surrounding context only — candidate span lines are never dropped here.
	while (spanLength(lo, hi) > budget && (lo < spanOffset || hi > spanOffset + spanCount)) {
		if (lo < spanOffset && hi > spanOffset + spanCount) {
			lo += 1;
			hi -= 1;
		} else if (lo < spanOffset) {
			lo += 1;
		} else {
			hi -= 1;
		}
		truncated = true;
	}
	// 2) If the span alone is still over budget, keep as many leading span lines as fit.
	let lines: string[];
	if (spanLength(lo, hi) > budget && hi - lo > 1) {
		const kept: string[] = [all[lo]];
		let length = all[lo].length;
		for (let i = lo + 1; i < hi; i += 1) {
			if (length + all[i].length + 1 > budget) break;
			kept.push(all[i]);
			length += all[i].length + 1;
		}
		lines = kept;
		hi = lo + kept.length;
		truncated = true;
	} else {
		lines = all.slice(lo, hi);
	}
	return {
		startLine: first + lo + 1,
		endLine: first + hi,
		lines,
		truncated,
	};
}

/**
 * Builds one whitespace-comparison fact for a pair of corresponding lines
 * (a submitted old_text line and the candidate file line it maps to). Only
 * measured values are reported: leading TAB/space counts and the presence of a
 * literal backslash-t sequence in the submitted line.
 */
function whitespaceFactForPair(
	submittedLine: EditorEvidenceLineInfo,
	candidateLine: EditorEvidenceLineInfo,
): string | null {
	if (submittedLine.literalBackslashTab && !candidateLine.literalBackslashTab) {
		return `submitted line ${submittedLine.line} contains a literal backslash-t sequence; candidate line ${candidateLine.line} begins with ${candidateLine.leadingTabs} TAB character(s) and ${candidateLine.leadingSpaces} space(s)`;
	}
	if (submittedLine.leadingTabs !== candidateLine.leadingTabs) {
		return `submitted line ${submittedLine.line} begins with ${submittedLine.leadingTabs} TAB character(s); candidate line ${candidateLine.line} begins with ${candidateLine.leadingTabs} TAB character(s)`;
	}
	if (submittedLine.leadingSpaces !== candidateLine.leadingSpaces) {
		return `submitted line ${submittedLine.line} begins with ${submittedLine.leadingSpaces} space(s); candidate line ${candidateLine.line} begins with ${candidateLine.leadingSpaces} space(s)`;
	}
	return null;
}

function detectLineEnding(content: string): "lf" | "crlf" | "mixed" {
	const hasCrlf = content.includes("\r\n");
	const hasLf = content.replace(/\r\n/g, "").includes("\n");
	if (hasCrlf && hasLf) return "mixed";
	if (hasCrlf) return "crlf";
	return "lf";
}

/**
 * Collects bounded current-source evidence for a failed editor call. Never
 * throws: every read problem is reported as a skip reason on `file`.
 */
export async function collectEditorEvidence(options: CollectEditorEvidenceOptions): Promise<EditorEvidence> {
	const evidence: EditorEvidence = {
		version: 1,
		readAt: new Date().toISOString(),
		requestedPath: null,
		resolvedPath: null,
		file: null,
		fields: {
			path: field(null, "path"),
			old_text: field(null, "old_text"),
			new_text: field(null, "new_text"),
			insert_line: field(null, "insert_line"),
		},
		oldText: null,
		candidates: null,
		repeated: null,
	};
	try {
		const input =
			options.input !== null && typeof options.input === "object" && !Array.isArray(options.input)
				? (options.input as Record<string, unknown>)
				: null;
		evidence.fields = {
			path: field(input, "path"),
			old_text: field(input, "old_text"),
			new_text: field(input, "new_text"),
			insert_line: field(input, "insert_line"),
		};
		if (options.repeated) {
			evidence.repeated = { unchangedFields: relevantEditorFields(input) };
		}
		const oldText = typeof input?.old_text === "string" ? input.old_text : null;
		if (oldText !== null) {
			const oldLines = oldText.split(/\r?\n/);
			evidence.oldText = {
				length: oldText.length,
				lineCount: oldLines.length,
				matchCount: null,
				lines: oldLines.slice(0, MAX_DETAIL_LINES).map((line, index) => lineInfo(line, index + 1)),
			};
		}
		const requestedPath = typeof input?.path === "string" && input.path.length > 0 ? input.path : null;
		if (requestedPath === null) {
			return evidence;
		}
		evidence.requestedPath = requestedPath;
		const resolvedPath = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(options.cwd, requestedPath);
		evidence.resolvedPath = resolvedPath;

		let fileReal: string;
		try {
			fileReal = await realpath(resolvedPath);
		} catch {
			evidence.file = { state: "skipped", reason: "file is missing or cannot be resolved" };
			return evidence;
		}
		const rootReal = await realpath(options.cwd).catch(() => resolve(options.cwd));
		if (fileReal !== rootReal && !fileReal.startsWith(rootReal + sep)) {
			evidence.file = {
				state: "skipped",
				reason: "path resolves outside the task worktree (external path or symlink escape)",
			};
			return evidence;
		}
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(fileReal);
		} catch {
			evidence.file = { state: "skipped", reason: "file is unreadable" };
			return evidence;
		}
		if (!info.isFile()) {
			evidence.file = { state: "skipped", reason: "not a regular file" };
			return evidence;
		}
		if (info.size > CLINE_EDITOR_EVIDENCE_MAX_FILE_BYTES) {
			evidence.file = {
				state: "skipped",
				sizeBytes: info.size,
				reason: `file is ${info.size} bytes, over the ${CLINE_EDITOR_EVIDENCE_MAX_FILE_BYTES} byte evidence limit; read a targeted section instead`,
			};
			return evidence;
		}

		let content: string;
		try {
			content = await withTimeout(readFile(fileReal, "utf8"), EVIDENCE_READ_TIMEOUT_MS);
		} catch (error) {
			evidence.file = {
				state: "skipped",
				sizeBytes: info.size,
				reason: `file is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			};
			return evidence;
		}
		if (content.slice(0, BINARY_PROBE_CHARS).includes("\0")) {
			evidence.file = { state: "skipped", sizeBytes: info.size, reason: "binary file" };
			return evidence;
		}

		const fileLines = content.split("\n");
		evidence.file = {
			state: "read",
			sizeBytes: info.size,
			lineCount: fileLines.length,
			lineEnding: detectLineEnding(content),
		};
		if (evidence.oldText && evidence.oldText.matchCount === null) {
			evidence.oldText.matchCount = oldText && oldText.length > 0 ? content.split(oldText).length - 1 : 0;
		}
		if (evidence.oldText && evidence.oldText.matchCount === 0 && oldText && oldText.length > 0) {
			evidence.candidates = buildCandidates(fileLines, oldText, evidence.oldText.lines);
		}
		return evidence;
	} catch {
		// Best effort: any unexpected failure preserves the original error; the
		// session must never fail because of evidence collection.
		evidence.file = evidence.file ?? { state: "skipped", reason: "evidence read failed" };
		return evidence;
	}
}

function buildCandidates(
	fileLines: string[],
	oldText: string,
	submittedLines: EditorEvidenceLineInfo[],
): EditorEvidenceCandidates {
	const ranges = findCandidateRanges(fileLines, oldText);
	if (ranges.length === 0) {
		return {
			approximate: true,
			note: "No trustworthy nearby candidate could be located after whitespace normalization.",
			windows: [],
			candidateLines: [],
		};
	}
	const windows = ranges.map((range) => buildWindow(fileLines, range));
	const candidateLineNumbers = ranges.flatMap((range) =>
		Array.from({ length: range.spanLines }, (_, i) => range.line + i + 1),
	);
	const candidateLines = candidateLineNumbers
		.filter((lineNumber) => lineNumber <= fileLines.length)
		.slice(0, MAX_DETAIL_LINES)
		.map((lineNumber) => lineInfo(fileLines[lineNumber - 1]?.replace(/\r$/, "") ?? "", lineNumber));
	// Pair each candidate span line with the submitted line it corresponds to
	// (the span starts at range.submittedLine), so fallback candidates are
	// compared against the line that actually matched, never by position.
	const facts: string[] = [];
	for (const range of ranges) {
		for (let offset = 0; offset < range.spanLines && facts.length < MAX_WHITESPACE_FACTS; offset += 1) {
			const submittedLine = submittedLines[range.submittedLine + offset];
			const fileLineIndex = range.line + offset;
			if (!submittedLine || fileLineIndex >= fileLines.length) continue;
			const candidateLine = lineInfo(fileLines[fileLineIndex]?.replace(/\r$/, "") ?? "", fileLineIndex + 1);
			const fact = whitespaceFactForPair(submittedLine, candidateLine);
			if (fact) facts.push(fact);
		}
	}
	const note =
		facts.length > 0
			? `Candidate lines for reference: ${facts.join("; ")}.`
			: "Candidates match only after whitespace normalization.";
	return { approximate: true, note, windows, candidateLines };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`evidence read timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
