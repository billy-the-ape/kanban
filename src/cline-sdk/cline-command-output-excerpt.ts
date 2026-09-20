// B-2.7 — Structured line-based excerpts for command tool results (run_commands / bash).
//
// B-2.6 bounded oversized tool results with a char-based head+tail excerpt. For
// command output and diffs, B-2.7 shapes the SDK's structured result
// ({ query, result, success, error? } per command) into a line-based format:
//
//   Command 1/1: git diff --cached
//   Exit status: success
//   Diff summary (3 files):
//     large.txt | +12000 -0
//   diff --git a/large.txt b/large.txt
//   ...
//   ... [truncated K lines; full output: /abs/context-artifacts/....txt]
//   +line-11999
//   +line-12000
//
// Invariants (B-2.7):
// - The `Command i/N:` + `Exit status` lines always stay in the message head.
//   The SDK reports a non-zero exit as `success: false` plus an error string
//   ("Command failed: " + stderr / exit code text); the first line of that
//   error is also kept in the head, so the exit status survives truncation.
// - The first N and last M lines of the output are preserved (N=M=100 by
//   default), shrunk only when the B-2.6 per-result char budget requires it,
//   and separated by a `... [truncated K lines; full output: <path>]` marker.
// - Large diff bodies get a per-file stat summary (path | +added -removed)
//   prepended to the excerpt so the model can triage without the hunks.
// - The excerpt is always within the B-2.6 per-result char budget (10% of the
//   context window, 4k floor, 50k cap), so it also stays under the SDK's own
//   50k per-result request-time cap.
// - The full output is persisted to a context artifact by the B-2.6 hook, and
//   the artifact path is embedded in the truncation marker so the agent can
//   read the omitted middle (or the tail) back from the artifact.
//
// This module is pure (no fs/SDK imports) so the excerpt algorithm is
// unit-testable; the artifact write + result rewrite stay in
// cline-tool-result-bounding-hook.ts.

/** Default number of leading output lines kept in a bounded excerpt (N). */
export const CLINE_COMMAND_OUTPUT_EXCERPT_HEAD_LINES = 100;
/** Default number of trailing output lines kept in a bounded excerpt (M). */
export const CLINE_COMMAND_OUTPUT_EXCERPT_TAIL_LINES = 100;
/** Cap for command text in the `Command i/N:` head line (the full command is also in the persisted message's Input section). */
export const CLINE_COMMAND_OUTPUT_QUERY_MAX_CHARS = 200;
/** Cap for the failure reason in the `Exit status: failed — <reason>` head line. */
export const CLINE_COMMAND_OUTPUT_REASON_MAX_CHARS = 120;
/** Max per-file lines in a diff summary (extra files collapse to "... and N more files"). */
export const CLINE_DIFF_SUMMARY_MAX_FILE_LINES = 20;
/** Cap for file paths in diff summary lines. */
export const CLINE_DIFF_SUMMARY_PATH_MAX_CHARS = 120;

/** One parsed command from the SDK's command tool result shape. */
export interface ClineCommandOutputEntry {
	/** The executed command (SDK `query` field). */
	query: string;
	/** Whether the command exited with code 0 (SDK `success` field). */
	success: boolean;
	/** The output body: stdout on success; the error string (stderr / exit code text) on failure. */
	body: string;
	/** First line of the error string on failure; null on success. */
	failureReason: string | null;
}

/** Result of building the line-based command output excerpt. */
export interface ClineCommandOutputExcerptResult {
	/** The bounded excerpt text (always ≤ budgetChars). */
	text: string;
	/** Head lines rendered across all entries. */
	headLines: number;
	/** Tail lines rendered across all entries. */
	tailLines: number;
	/** Lines omitted by the truncation markers (0 when nothing was truncated). */
	omittedLines: number;
	/** True when at least one entry body was excerpted. */
	truncated: boolean;
}

/** Options for {@link buildCommandOutputExcerpt}. */
export interface ClineCommandOutputExcerptOptions {
	/** Maximum excerpt chars (the B-2.6 per-result bound). */
	budgetChars: number;
	/** Full-output artifact path; embedded in the truncation marker when present. */
	artifactPath?: string;
	/** Leading lines to keep (default {@link CLINE_COMMAND_OUTPUT_EXCERPT_HEAD_LINES}); shrinks to fit the budget. */
	headLines?: number;
	/** Trailing lines to keep (default {@link CLINE_COMMAND_OUTPUT_EXCERPT_TAIL_LINES}); shrinks to fit the budget. */
	tailLines?: number;
	/** Max per-file lines in the diff summary (default {@link CLINE_DIFF_SUMMARY_MAX_FILE_LINES}). */
	maxDiffFileLines?: number;
}

/**
 * Parses the SDK command tool result output (an array of
 * `{ query, result, success, error? }`, or a single such object) into
 * entries. Returns null when the output does not match the shape — the
 * caller then falls back to the generic char-based excerpt.
 */
export function parseCommandOutputEntries(output: unknown): ClineCommandOutputEntry[] | null {
	const list = Array.isArray(output) ? output : [output];
	if (list.length === 0) {
		return null;
	}
	const entries: ClineCommandOutputEntry[] = [];
	for (const item of list) {
		if (typeof item !== "object" || item === null) {
			return null;
		}
		const record = item as Record<string, unknown>;
		if (typeof record.query !== "string" || record.query.length === 0) {
			return null;
		}
		if (record.success === false) {
			// Non-zero exit: the SDK throws, so the structured result carries
			// success: false plus an error string ("Command failed: " + stderr
			// text or exit code text). The error IS the output body; any stdout
			// captured before the failure is kept ahead of it.
			if (typeof record.error !== "string" || record.error.length === 0) {
				return null;
			}
			const stdout = typeof record.result === "string" && record.result.length > 0 ? record.result : "";
			entries.push({
				query: record.query,
				success: false,
				body: stdout ? `${stdout}\n${record.error}` : record.error,
				failureReason: firstLine(record.error),
			});
			continue;
		}
		if (typeof record.result !== "string") {
			return null;
		}
		entries.push({ query: record.query, success: true, body: record.result, failureReason: null });
	}
	return entries;
}

const DIFF_FILE_HEADER_RE = /^diff --git (\S+) (\S+)$/;
const DIFF_HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Builds a per-file stat summary for a unified diff body (e.g. `git diff
 * --cached` output). Returns [] when the body is not a diff with hunks, in
 * which case the excerpt omits the summary block.
 */
export function buildDiffFileSummary(body: string, maxFileLines: number = CLINE_DIFF_SUMMARY_MAX_FILE_LINES): string[] {
	interface DiffFileStats {
		path: string;
		added: number;
		removed: number;
	}
	const files: DiffFileStats[] = [];
	let hunkCount = 0;
	let current: DiffFileStats | null = null;
	for (const line of body.split("\n")) {
		const fileMatch = line.match(DIFF_FILE_HEADER_RE);
		if (fileMatch) {
			const left = stripDiffPrefix(fileMatch[1]!);
			const right = stripDiffPrefix(fileMatch[2]!);
			current = { path: right || left || fileMatch[2]!, added: 0, removed: 0 };
			files.push(current);
			continue;
		}
		const hunkMatch = line.match(DIFF_HUNK_HEADER_RE);
		if (hunkMatch && current) {
			hunkCount += 1;
			current.removed += hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
			current.added += hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1;
		}
	}
	if (files.length === 0 || hunkCount === 0) {
		return [];
	}
	const summary: string[] = [`Diff summary (${files.length} file${files.length === 1 ? "" : "s"}):`];
	for (const file of files.slice(0, maxFileLines)) {
		summary.push(`  ${capText(file.path, CLINE_DIFF_SUMMARY_PATH_MAX_CHARS)} | +${file.added} -${file.removed}`);
	}
	if (files.length > maxFileLines) {
		summary.push(`  ... and ${files.length - maxFileLines} more files`);
	}
	return summary;
}

/**
 * Builds a line-based excerpt of the parsed command output within
 * `budgetChars`. The head always contains each command's `Command i/N:` line
 * and `Exit status` line (plus a per-file stat summary when the body is a
 * diff), followed by the first N / last M lines of each command's output and
 * a `... [truncated K lines; full output: <artifact path>]` marker.
 *
 * Returns null when even the metadata head cannot fit the budget
 * (pathological output), in which case the caller must fall back to the
 * generic char-based excerpt.
 */
export function buildCommandOutputExcerpt(
	entries: ClineCommandOutputEntry[],
	options: ClineCommandOutputExcerptOptions,
): ClineCommandOutputExcerptResult | null {
	if (entries.length === 0) {
		return null;
	}
	const headLines = options.headLines ?? CLINE_COMMAND_OUTPUT_EXCERPT_HEAD_LINES;
	const tailLines = options.tailLines ?? CLINE_COMMAND_OUTPUT_EXCERPT_TAIL_LINES;
	const maxDiffFileLines = options.maxDiffFileLines ?? CLINE_DIFF_SUMMARY_MAX_FILE_LINES;

	const metaBlocks = entries.map((entry, index) => {
		const lines: string[] = [
			`Command ${index + 1}/${entries.length}: ${capText(entry.query, CLINE_COMMAND_OUTPUT_QUERY_MAX_CHARS)}`,
			exitStatusLine(entry),
		];
		lines.push(...buildDiffFileSummary(entry.body, maxDiffFileLines));
		return lines.join("\n");
	});
	const metaLen = metaBlocks.join("\n\n").length;
	// Per-entry "\n" between metadata and body, plus "\n\n" between entries.
	const overhead = entries.length + (entries.length - 1) * 2;
	const bodyBudget = options.budgetChars - metaLen - overhead;
	if (bodyBudget < entries.length * 8) {
		// Not even a per-entry truncation marker fits: use the generic path.
		return null;
	}
	const entryBudget = Math.floor(bodyBudget / entries.length);

	let totalHeadLines = 0;
	let totalTailLines = 0;
	let totalOmittedLines = 0;
	let truncated = false;
	const blocks = metaBlocks.map((metaBlock, index) => {
		const entry = entries[index]!;
		const excerpt = boundedLineExcerpt(entry.body, entryBudget, options.artifactPath, headLines, tailLines);
		totalHeadLines += excerpt.headLines;
		totalTailLines += excerpt.tailLines;
		totalOmittedLines += excerpt.omittedLines;
		truncated = truncated || excerpt.truncated;
		return `${metaBlock}\n${excerpt.text}`;
	});

	return {
		text: blocks.join("\n\n"),
		headLines: totalHeadLines,
		tailLines: totalTailLines,
		omittedLines: totalOmittedLines,
		truncated,
	};
}

interface LineExcerpt {
	text: string;
	headLines: number;
	tailLines: number;
	omittedLines: number;
	truncated: boolean;
}

/**
 * Excerpts one command body within `budgetChars`: first N lines + last M
 * lines + a trailing truncation marker, or a char cut when the body is a
 * single line or no line share fits the budget. The returned text is always
 * ≤ budgetChars.
 */
function boundedLineExcerpt(
	body: string,
	budgetChars: number,
	artifactPath: string | undefined,
	headLines: number,
	tailLines: number,
): LineExcerpt {
	if (body.length === 0) {
		return { text: "", headLines: 0, tailLines: 0, omittedLines: 0, truncated: false };
	}
	if (body.length <= budgetChars) {
		return {
			text: body,
			headLines: splitLines(body).length,
			tailLines: 0,
			omittedLines: 0,
			truncated: false,
		};
	}

	const lines = splitLines(body);
	const lineCount = lines.length;
	const prefixLengths: number[] = [0];
	for (let i = 0; i < lineCount; i++) {
		prefixLengths.push(prefixLengths[i]! + lines[i]!.length + 1);
	}
	const headChars = (count: number): number => (count <= 0 ? 0 : prefixLengths[count]! - 1);
	const tailChars = (count: number): number =>
		count <= 0 ? 0 : prefixLengths[lineCount]! - prefixLengths[lineCount - count]! - 1;
	const linesMarker = (omitted: number): string =>
		`... [truncated ${omitted} lines${artifactPath ? `; full output: ${artifactPath}` : ""}]`;

	let head = Math.min(headLines, lineCount);
	let tail = Math.min(tailLines, lineCount);
	if (head + tail < lineCount) {
		for (;;) {
			const omitted = lineCount - head - tail;
			const marker = linesMarker(omitted);
			if (headChars(head) + 1 + marker.length + 1 + tailChars(tail) <= budgetChars) {
				const headText = lines.slice(0, head).join("\n");
				const tailText = lines.slice(lineCount - tail).join("\n");
				return {
					text: [headText, marker, tailText].filter(Boolean).join("\n"),
					headLines: head,
					tailLines: tail,
					omittedLines: omitted,
					truncated: true,
				};
			}
			if (head <= 1 && tail <= 1) {
				break; // A single line's share does not fit: char cut below.
			}
			if (tail >= 1 && (tail > head || head <= 1)) {
				tail -= 1;
			} else {
				head -= 1;
			}
		}
	}

	// Char cut: the body is a single line, or its lines are too long for any
	// line-based share of the budget. Cut chars from both ends; the marker
	// reports omitted chars (not lines) in this mode.
	let cut = 0;
	for (let pass = 0; pass < 6; pass++) {
		const shown = Math.min(body.length, cut * 2);
		const marker = charsMarker(body.length - shown, artifactPath);
		cut = Math.max(0, Math.floor((budgetChars - 2 - marker.length) / 2));
	}
	if (cut === 0) {
		// Pathological: even the marker alone does not fit.
		const marker = charsMarker(body.length, artifactPath);
		return { text: marker.slice(0, budgetChars), headLines: 0, tailLines: 0, omittedLines: 0, truncated: true };
	}
	const headText = body.slice(0, cut);
	const tailText = cut * 2 < body.length ? body.slice(body.length - cut) : "";
	const omitted = body.length - headText.length - tailText.length;
	const marker = charsMarker(omitted, artifactPath);
	const text = tailText ? `${headText}\n${marker}\n${tailText}` : `${headText}\n${marker}`;
	return { text, headLines: 1, tailLines: tailText ? 1 : 0, omittedLines: 0, truncated: true };
}

function charsMarker(omitted: number, artifactPath: string | undefined): string {
	return `... [truncated ${omitted} chars${artifactPath ? `; full output: ${artifactPath}` : ""}]`;
}

function exitStatusLine(entry: ClineCommandOutputEntry): string {
	if (entry.success) {
		return "Exit status: success";
	}
	const reason = entry.failureReason ? capText(entry.failureReason, CLINE_COMMAND_OUTPUT_REASON_MAX_CHARS) : "";
	return reason ? `Exit status: failed — ${reason}` : "Exit status: failed";
}

function firstLine(value: string): string {
	const index = value.indexOf("\n");
	return index === -1 ? value : value.slice(0, index);
}

function stripDiffPrefix(path: string): string {
	if (path === "/dev/null") {
		return "";
	}
	return path.replace(/^a\//, "").replace(/^b\//, "");
}

function capText(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function splitLines(body: string): string[] {
	const lines = body.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}
