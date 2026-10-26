// DIAG-2 (2b) — resolve a truncated tool result's full output back from the
// task's context-artifacts directory for the export bundle.
//
// Resolution chain (fixed priority):
// 1. sidecar index: `toolCallId -> fileName` entries recorded by
//    writeTaskContextArtifact (primary; deterministic).
// 2. deterministic filename lookup: artifacts are named
//    `<sanitized toolCallId>-<ts>-<rand>.txt`; the sanitization + 80-char cap can
//    collide, so more than one surviving match is an explicit "ambiguous" gap,
//    never a guess.
// 3. legacy: parse the `Full content: <path>` / `full output: <path>` reference
//    out of the persisted excerpt text for records written before the index.
//
// Every reference is untrusted: it is resolved + realpath'd and must stay
// inside this task's context-artifacts directory (a sibling task's artifact,
// an escape symlink, or a non-file is an explicit "invalid" gap). The content
// is only classified (`json-text` vs `text`) — never parsed and re-serialized:
// the classification comes from the sidecar index (recorded at archive time)
// or, for legacy artifacts, from a bounded streaming check that never holds
// the whole file or a parsed copy in memory.
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { readTaskArtifactIndex } from "../workspace/task-artifact-index";
import { getTaskContextArtifactsDir, sanitizeToolCallIdForArtifactName } from "../workspace/task-artifacts";

/** Outcome of resolving a tool result's full output for the export. */
export type TaskArtifactFullOutputStatus = "resolved" | "missing" | "ambiguous" | "invalid";

export interface TaskArtifactFullOutputEvidence {
	status: TaskArtifactFullOutputStatus;
	artifactFileName: string | null;
	artifactPath: string | null;
	/** Classification of the stored content; null until resolved. */
	contentFormat: "json-text" | "text" | null;
	/** Explicit gap explanation when the full output could not be resolved. */
	gap: string | null;
}

/**
 * Truncation marker in a persisted tool result: the character-based excerpt
 * marker (`...[truncated N chars]...` or `... [truncated N chars]`), and the
 * command line-based marker (`... [truncated N lines]` / `... [truncated N
 * lines; full output: <path>]`), plus their char-based counterparts (`...
 * [truncated N chars; full output: <path>]`). Either one means the persisted
 * result is a bounded excerpt with a full-content artifact.
 */
export const TASK_ARTIFACT_TRUNCATION_MARKER_PATTERN =
	/\.{3}\s*\[truncated \d+ (?:chars|lines)(?:; full output: [^\]]+)?\](?:\.{3})?/;

/**
 * Legacy reference patterns in persisted excerpt text, restricted to the
 * documented bounding envelopes only (both excerpt families):
 * - the standalone `Full content: <absolute path>` marker line appended by
 *   the character-based excerpt hook (`cline-tool-result-bounding-hook`), and
 * - the bracketed `... [truncated N (chars|lines); full output: <path>]`
 *   marker emitted by the command-line excerpt hook
 *   (`cline-command-output-excerpt`); the capture stops at the closing
 *   bracket, not swallowing it.
 * Quoted source, diff/fixture lines (a `+`/`-`/context prefix), and free
 * prose that merely mentions either phrase are never treated as references:
 * `Full content:` must be a standalone marker line, and `full output:` must
 * appear inside the documented bracketed truncation envelope, which always
 * carries the `... ` ellipsis prefix produced by the excerpt hook. A bare
 * `full output: <path>` line is not a documented envelope and is ignored.
 */
const LEGACY_FULL_CONTENT_MARKER = /^Full content: (\S+)$/gm;
const LEGACY_BRACKETED_FULL_OUTPUT_MARKER = /\.\.\. \[truncated \d+ (?:chars|lines); full output: ([^\s\]]+)\]/g;

function isContainedInParent(parent: string, candidate: string): boolean {
	return candidate === parent || candidate.startsWith(parent + sep);
}

/**
 * Resolves an untrusted artifact reference against this task's
 * context-artifacts directory. Relative references resolve against the
 * directory; absolute references are accepted only if they stay inside it
 * after realpath (escape symlinks rejected). Returns null for anything that
 * cannot be proven to be a regular file inside the directory.
 */
async function resolveContainedArtifactPath(
	taskId: string,
	reference: string,
): Promise<{ path: string; fileName: string } | null> {
	const dir = getTaskContextArtifactsDir(taskId);
	const candidate = resolve(dir, reference);
	let realPath: string;
	try {
		realPath = await realpath(candidate);
	} catch {
		return null;
	}
	let realDir: string;
	try {
		realDir = await realpath(dir);
	} catch {
		return null;
	}
	if (!isContainedInParent(realDir, realPath)) {
		return null;
	}
	const info = await stat(realPath).catch(() => null);
	if (!info || !info.isFile()) {
		return null;
	}
	return { path: realPath, fileName: basename(realPath) };
}

/**
 * Classifies stored content without ever embedding a parsed copy and without
 * holding the whole file in memory (Decision 8: the bundle must not cause an
 * unbounded allocation or a synchronous JSON.parse pause before the download
 * headers are sent). The file is streamed through a constant-memory JSON
 * syntax validator. Matches the historical full-read semantics: only a
 * document whose first non-whitespace character is `{` or `[` and that parses
 * as exactly one complete JSON document is `json-text`.
 */
export async function classifyArtifactContentFormat(artifactPath: string): Promise<"json-text" | "text"> {
	const readStream = createReadStream(artifactPath);
	try {
		const decoder = new StringDecoder("utf8");
		const chunks = readStream[Symbol.asyncIterator]();
		let pendingText: string | null = null;
		const readChunk = async (): Promise<string | null> => {
			for (;;) {
				if (pendingText !== null) {
					const text = pendingText;
					pendingText = null;
					return text;
				}
				const next = await chunks.next();
				if (next.done) {
					const tail = decoder.end();
					return tail.length > 0 ? tail : null;
				}
				const value = next.value;
				pendingText = decoder.write(typeof value === "string" ? Buffer.from(value) : value);
			}
		};
		return (await validateStreamedJsonArtifact(readChunk)) ? "json-text" : "text";
	} catch {
		return "text";
	} finally {
		readStream.destroy();
	}
}

/**
 * Streaming single-document JSON syntax validator (constant memory): pulls
 * characters from `readChunk` (null ends the stream) and validates strict JSON
 * syntax without building a value graph. Throws on invalid input.
 */
async function validateStreamedJsonArtifact(readChunk: () => Promise<string | null>): Promise<boolean> {
	const fail = (): never => {
		throw new SyntaxError("invalid JSON");
	};

	let buffer = "";
	let offset = 0;
	let streamEnded = false;
	// Compact the buffer once it grows past 1 MiB so a multi-MB artifact never
	// holds more than a bounded tail in memory.
	const compact = (): void => {
		if (offset > 0 && buffer.length > 1_048_576) {
			buffer = buffer.slice(offset);
			offset = 0;
		}
	};

	const peek = async (): Promise<string | null> => {
		while (offset >= buffer.length) {
			if (streamEnded) {
				return null;
			}
			const chunk = await readChunk();
			if (chunk === null) {
				streamEnded = true;
				if (offset >= buffer.length) {
					return null;
				}
			} else if (chunk.length > 0) {
				buffer = offset >= buffer.length ? chunk : buffer.slice(offset) + chunk;
				offset = 0;
			}
		}
		compact();
		return buffer.charAt(offset);
	};

	const take = async (): Promise<string | null> => {
		const ch = await peek();
		if (ch === null) {
			return null;
		}
		offset += 1;
		return ch;
	};

	const skipWhitespace = async (): Promise<void> => {
		for (;;) {
			const ch = await peek();
			if (ch === null || !isJsonWhitespace(ch)) {
				return;
			}
			offset += 1;
		}
	};

	const takeDigits = async (requireAtLeastOne: boolean): Promise<void> => {
		let count = 0;
		for (;;) {
			const ch = await peek();
			if (ch !== null && isDigitChar(ch)) {
				offset += 1;
				count += 1;
				continue;
			}
			break;
		}
		if (requireAtLeastOne && count === 0) {
			fail();
		}
	};

	const parseString = async (): Promise<void> => {
		// Opening quote already consumed.
		for (;;) {
			const ch = (await take()) ?? fail();
			if (ch === "\\") {
				const escaped = (await take()) ?? fail();
				if (escaped === "u") {
					for (let i = 0; i < 4; i += 1) {
						const hex = (await take()) ?? fail();
						if (!/[0-9a-fA-F]/.test(hex)) {
							fail();
						}
					}
					continue;
				}
				if (!'"\\/bfnrt'.includes(escaped)) {
					fail();
				}
				continue;
			}
			if (ch === '"') {
				return;
			}
		}
	};

	const parseLiteral = async (rest: string): Promise<void> => {
		for (const expected of rest) {
			const ch = await take();
			if (ch !== expected) {
				fail();
			}
		}
	};

	const parseNumber = async (firstDigit: string): Promise<void> => {
		// `firstDigit` already consumed. Leading zeros are not allowed beyond
		// the single zero itself.
		if (firstDigit !== "0") {
			await takeDigits(false);
		}
		const next = await peek();
		if (next === ".") {
			offset += 1;
			await takeDigits(true);
		}
		const exponent = await peek();
		if (exponent === "e" || exponent === "E") {
			offset += 1;
			const sign = await peek();
			if (sign === "+" || sign === "-") {
				offset += 1;
			}
			await takeDigits(true);
		}
	};

	const parseValue = async (): Promise<void> => {
		await skipWhitespace();
		const ch = (await take()) ?? fail();
		if (ch === "{") {
			await parseObject();
			return;
		}
		if (ch === "[") {
			await parseArray();
			return;
		}
		if (ch === '"') {
			await parseString();
			return;
		}
		if (ch === "t") {
			await parseLiteral("rue");
			return;
		}
		if (ch === "f") {
			await parseLiteral("alse");
			return;
		}
		if (ch === "n") {
			await parseLiteral("ull");
			return;
		}
		if (ch === "-") {
			const digit = (await take()) ?? fail();
			if (!isDigitChar(digit)) {
				fail();
			}
			await parseNumber(digit);
			return;
		}
		if (isDigitChar(ch)) {
			await parseNumber(ch);
			return;
		}
		fail();
	};

	const parseObject = async (): Promise<void> => {
		// Opening brace already consumed.
		await skipWhitespace();
		if ((await peek()) === "}") {
			offset += 1;
			return;
		}
		for (;;) {
			await skipWhitespace();
			const key = await take();
			if (key !== '"') {
				fail();
			}
			await parseString();
			await skipWhitespace();
			const colon = await take();
			if (colon !== ":") {
				fail();
			}
			await parseValue();
			await skipWhitespace();
			const separator = await take();
			if (separator === ",") {
				continue;
			}
			if (separator === "}") {
				return;
			}
			fail();
		}
	};

	const parseArray = async (): Promise<void> => {
		// Opening bracket already consumed.
		await skipWhitespace();
		if ((await peek()) === "]") {
			offset += 1;
			return;
		}
		for (;;) {
			await parseValue();
			await skipWhitespace();
			const separator = await take();
			if (separator === ",") {
				continue;
			}
			if (separator === "]") {
				return;
			}
			fail();
		}
	};

	// Historical classifier semantics: only a root object or array counts as
	// json-text (a document rooted at a number/string/literal stays `text`).
	await skipWhitespace();
	const first = await take();
	if (first !== "{" && first !== "[") {
		return false;
	}
	if (first === "{") {
		await parseObject();
	} else {
		await parseArray();
	}
	await skipWhitespace();
	return (await peek()) === null;
}

function isJsonWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isDigitChar(ch: string): boolean {
	return ch >= "0" && ch <= "9";
}

/**
 * Resolves the full output for one tool result. `persistedResultText` is the
 * text stored in the transcript's tool_result part (needed for the legacy
 * reference step); it may be omitted for tool results that were never
 * excerpted.
 */
export async function resolveTaskToolFullOutput(input: {
	taskId: string;
	toolCallId: string;
	persistedResultText?: string | null;
}): Promise<TaskArtifactFullOutputEvidence> {
	const missing: TaskArtifactFullOutputEvidence = {
		status: "missing",
		artifactFileName: null,
		artifactPath: null,
		contentFormat: null,
		gap: "No surviving artifact records the full output for this tool call.",
	};
	const invalid = (reference: string): TaskArtifactFullOutputEvidence => ({
		status: "invalid",
		artifactFileName: null,
		artifactPath: null,
		contentFormat: null,
		gap: `Recorded artifact reference "${reference}" could not be resolved as a regular file inside this task's context-artifacts directory.`,
	});

	// 1. Primary: sidecar index.
	const index = await readTaskArtifactIndex(input.taskId).catch(() => null);
	const indexedEntries = index ? (index[input.toolCallId] ?? []) : [];
	if (indexedEntries.length > 0) {
		const resolved = (
			await Promise.all(indexedEntries.map((entry) => resolveContainedArtifactPath(input.taskId, entry.fileName)))
		).filter((candidate): candidate is { path: string; fileName: string } => candidate !== null);
		if (resolved.length === 1) {
			const only = resolved[0];
			if (only) {
				// Prefer the classification recorded at archive time; fall back
				// to the bounded streaming check for index entries written
				// before that field existed.
				const recordedFormat = indexedEntries.find((entry) => entry.fileName === only.fileName)?.contentFormat;
				return {
					status: "resolved",
					artifactFileName: only.fileName,
					artifactPath: only.path,
					contentFormat:
						recordedFormat ?? (await classifyArtifactContentFormat(only.path).catch(() => "text" as const)),
					gap: null,
				};
			}
		}
		if (resolved.length > 1) {
			return {
				status: "ambiguous",
				artifactFileName: null,
				artifactPath: null,
				contentFormat: null,
				gap: "Multiple surviving artifacts match this tool call; refusing to guess which one is authoritative.",
			};
		}
		// Indexed file no longer survives (e.g. partially deleted): fall through
		// to the filename lookup before declaring an invalid reference.
	}

	// 2. Fallback: deterministic filename lookup.
	const prefix = `${sanitizeToolCallIdForArtifactName(input.toolCallId)}-`;
	const entries = await readdir(getTaskContextArtifactsDir(input.taskId)).catch(() => []);
	const matches = entries.filter((name) => name.startsWith(prefix) && name.endsWith(".txt"));
	if (matches.length === 1) {
		const candidate = matches[0];
		// Run the single match through the same containment check as every
		// other reference (a bare stat follows symlinks and would accept an
		// escape symlink).
		if (candidate) {
			const resolved = await resolveContainedArtifactPath(input.taskId, candidate);
			if (resolved) {
				return {
					status: "resolved",
					artifactFileName: resolved.fileName,
					artifactPath: resolved.path,
					contentFormat: await classifyArtifactContentFormat(resolved.path).catch(() => "text" as const),
					gap: null,
				};
			}
		}
	} else if (matches.length > 1) {
		return {
			status: "ambiguous",
			artifactFileName: null,
			artifactPath: null,
			contentFormat: null,
			gap: "Multiple surviving artifacts share this tool call's sanitized file-name prefix; refusing to guess which one is authoritative.",
		};
	}

	// 3. Legacy: references parsed out of the persisted excerpt text,
	// restricted to the documented marker line and bracketed envelope. All
	// references are collected: exactly one distinct reference resolves;
	// several distinct references are ambiguous (explicit, never guessed).
	const text = input.persistedResultText ?? "";
	const references: string[] = [];
	for (const match of text.matchAll(LEGACY_FULL_CONTENT_MARKER)) {
		if (typeof match[1] === "string" && match[1].length > 0) {
			references.push(match[1]);
		}
	}
	for (const match of text.matchAll(LEGACY_BRACKETED_FULL_OUTPUT_MARKER)) {
		if (typeof match[1] === "string" && match[1].length > 0) {
			references.push(match[1]);
		}
	}
	const distinctReferences = [...new Set(references)];
	if (distinctReferences.length > 1) {
		return {
			status: "ambiguous",
			artifactFileName: null,
			artifactPath: null,
			contentFormat: null,
			gap: "The persisted excerpt records multiple distinct artifact references; refusing to guess which one is authoritative.",
		};
	}
	const reference = distinctReferences[0];
	if (typeof reference === "string" && reference.length > 0) {
		const resolved = await resolveContainedArtifactPath(input.taskId, reference);
		if (!resolved) {
			return invalid(reference);
		}
		return {
			status: "resolved",
			artifactFileName: resolved.fileName,
			artifactPath: resolved.path,
			contentFormat: await classifyArtifactContentFormat(resolved.path).catch(() => "text" as const),
			gap: null,
		};
	}

	return missing;
}
