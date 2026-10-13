// DIAG-2 (2c) — streaming JSON serializer for the schemaVersion 3 export.
//
// The bundle is emitted incrementally to a writable stream (honoring backpressure
// via drain), never assembled as one host-side JSON string. Durable messages and
// live tails stream from the typed plan; artifact full outputs stream straight
// from their files (one artifact at a time, in 8KB chunks through a StringDecoder,
// JSON-escaped with split-surrogate safety) so the largest item in the bundle is
// never held as a second in-memory JSON string.
//
// A successful stream always produces a complete, parseable JSON document; an
// abort (client disconnect) stops the stream and rejects, so a truncated response
// can never be delivered as a success. The stream never creates host exports or
// temporary files — it only writes to the provided target.

import { once } from "node:events";
import { createReadStream } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import type { TaskDiagnosticsExportToolEvidence, TaskDiagnosticsExportV3Plan } from "./task-diagnostics-export-v3";

const STRING_STREAM_CHUNK_CHARS = 16 * 1024;

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/**
 * Incremental JSON writer over a Writable. `write` honors backpressure: when the
 * underlying stream signals it cannot accept more data, the writer awaits its
 * next `drain` event before continuing.
 */
class JsonStreamWriter {
	private aborted = false;

	constructor(
		private readonly target: Writable,
		private readonly signal: AbortSignal | undefined,
	) {}

	async write(chunk: string): Promise<void> {
		if (this.aborted || isAborted(this.signal)) {
			this.aborted = true;
			throw new Error("Export stream aborted.");
		}
		if (!this.target.write(chunk)) {
			await once(this.target, "drain");
			if (isAborted(this.signal)) {
				this.aborted = true;
				throw new Error("Export stream aborted.");
			}
		}
	}

	async writeString(value: string): Promise<void> {
		await this.write('"');
		const encoder = createJsonStringEncoder();
		for (let offset = 0; offset < value.length; offset += STRING_STREAM_CHUNK_CHARS) {
			const encoded = encoder.append(value.slice(offset, offset + STRING_STREAM_CHUNK_CHARS));
			if (encoded.length > 0) {
				await this.write(encoded);
			}
		}
		const tail = encoder.finish();
		if (tail.length > 0) {
			await this.write(tail);
		}
		await this.write('"');
	}

	async writeKey(key: string): Promise<void> {
		// Keys are plain ASCII identifiers in the export; escape defensively.
		await this.writeString(key);
	}

	/** Streams an arbitrary JSON-serializable value (JSON.stringify semantics). */
	async writeValue(value: unknown, seen: WeakSet<object>): Promise<void> {
		if (value === null) {
			await this.write("null");
			return;
		}
		switch (typeof value) {
			case "string": {
				await this.writeString(value);
				return;
			}
			case "number":
			case "boolean": {
				await this.write(JSON.stringify(value));
				return;
			}
			case "bigint": {
				throw new TypeError("Do not know how to serialize a BigInt");
			}
			case "undefined":
			case "symbol":
			case "function": {
				// JSON.stringify emits null for these in array positions; object
				// properties are dropped by the caller.
				await this.write("null");
				return;
			}
			case "object": {
				if (seen.has(value)) {
					throw new TypeError("Converting circular structure to JSON");
				}
				seen.add(value);
				try {
					if (value instanceof Date) {
						await this.writeString(value.toISOString());
						return;
					}
					if (Array.isArray(value)) {
						await this.write("[");
						for (let index = 0; index < value.length; index += 1) {
							if (index > 0) {
								await this.write(",");
							}
							await this.writeValue(value[index], seen);
						}
						await this.write("]");
						return;
					}
					await this.write("{");
					let first = true;
					for (const [key, entry] of Object.entries(value)) {
						if (entry === undefined) {
							continue;
						}
						if (!first) {
							await this.write(",");
						}
						first = false;
						await this.writeKey(key);
						await this.write(":");
						await this.writeValue(entry, seen);
					}
					await this.write("}");
				} finally {
					seen.delete(value);
				}
				return;
			}
			default: {
				throw new TypeError(`Do not know how to serialize value of type ${typeof value}`);
			}
		}
	}
}

/**
 * JSON string escaper safe across chunk boundaries. A lone high surrogate at the
 * end of a chunk is held back until the next chunk decides whether it is the
 * start of a valid pair; lone surrogates are emitted as `\uXXXX` escapes.
 */
function createJsonStringEncoder(): { append: (text: string) => string; finish: () => string } {
	let pendingHighSurrogate: string | null = null;
	return {
		append(text: string): string {
			let input = pendingHighSurrogate ? `${pendingHighSurrogate}${text}` : text;
			pendingHighSurrogate = null;
			if (input.length > 0) {
				const lastCode = input.charCodeAt(input.length - 1);
				if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
					pendingHighSurrogate = input[input.length - 1];
					input = input.slice(0, -1);
				}
			}
			return escapeJsonChunk(input);
		},
		finish(): string {
			const pending = pendingHighSurrogate;
			pendingHighSurrogate = null;
			return pending ? `\\u${pending.charCodeAt(0).toString(16).padStart(4, "0")}` : "";
		},
	};
}

function escapeJsonChunk(text: string): string {
	let out = "";
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		switch (code) {
			case 0x22:
				out += '\\"';
				break;
			case 0x5c:
				out += "\\\\";
				break;
			case 0x08:
				out += "\\b";
				break;
			case 0x09:
				out += "\\t";
				break;
			case 0x0a:
				out += "\\n";
				break;
			case 0x0c:
				out += "\\f";
				break;
			case 0x0d:
				out += "\\r";
				break;
			default: {
				if (code < 0x20) {
					out += `\\u${code.toString(16).padStart(4, "0")}`;
				} else if (code >= 0xd800 && code <= 0xdbff) {
					const nextCode = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
					if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
						out += text[index] + text[index + 1];
						index += 1;
					} else {
						out += `\\u${code.toString(16).padStart(4, "0")}`;
					}
				} else if (code >= 0xdc00 && code <= 0xdfff) {
					out += `\\u${code.toString(16).padStart(4, "0")}`;
				} else {
					out += text[index];
				}
				break;
			}
		}
	}
	return out;
}

/**
 * Streams one artifact file as a JSON string (quotes included), one chunk at a
 * time. Chunks are decoded through a StringDecoder so multi-byte characters
 * split across reads reassemble correctly.
 */
async function streamArtifactText(
	writer: JsonStreamWriter,
	artifactPath: string,
	readArtifact: (path: string) => Readable,
): Promise<void> {
	await writer.write('"');
	const readStream = readArtifact(artifactPath);
	const decoder = new StringDecoder("utf8");
	const encoder = createJsonStringEncoder();
	for await (const chunk of readStream) {
		const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		const encoded = encoder.append(text);
		if (encoded.length > 0) {
			await writer.write(encoded);
		}
	}
	const tail = decoder.end();
	const tailEncoded = encoder.append(tail);
	if (tailEncoded.length > 0) {
		await writer.write(tailEncoded);
	}
	const pending = encoder.finish();
	if (pending.length > 0) {
		await writer.write(pending);
	}
	await writer.write('"');
}

/**
 * Streams the full schemaVersion 3 plan to `target`. Resolves only after the
 * complete document has been written; rejects with `Export stream aborted.` when
 * the signal fires (the document then stops mid-stream and must not be treated
 * as a successful export).
 */
export async function streamTaskDiagnosticsExportV3(
	target: Writable,
	plan: TaskDiagnosticsExportV3Plan,
	options: {
		signal?: AbortSignal;
		/** Artifact reader override (tests). */
		readArtifact?: (path: string) => Readable;
	} = {},
): Promise<void> {
	const writer = new JsonStreamWriter(target, options.signal);
	const readArtifact = options.readArtifact ?? ((path: string) => createReadStream(path));
	const seen = new WeakSet<object>();

	await writer.write("{");
	await writer.write(`"schemaVersion":${JSON.stringify(plan.schemaVersion)},`);
	await writer.write('"exportedAt":');
	await writer.writeString(plan.exportedAt);
	await writer.write(',"capture":{');
	await writer.write(`"capturedAt":${JSON.stringify(plan.capture.capturedAt)},`);
	await writer.write('"note":');
	await writer.writeString(plan.capture.note);
	await writer.write('},"completeness":');
	await writer.writeValue(plan.completeness, seen);
	await writer.write(',"diagnostics":');
	await writer.writeValue(plan.diagnostics, seen);
	await writer.write(',"taskPrompt":');
	await writer.writeValue(plan.taskPrompt, seen);
	await writer.write(',"sessions":[');
	for (let sessionIndex = 0; sessionIndex < plan.sessions.length; sessionIndex += 1) {
		const session = plan.sessions[sessionIndex];
		if (!session) {
			continue;
		}
		if (sessionIndex > 0) {
			await writer.write(",");
		}
		await writer.write("{");
		await writer.write(`"kind":${JSON.stringify(session.kind)},`);
		await writer.write('"taskId":');
		await writer.writeString(session.taskId);
		await writer.write(`,"listingTruncated":${JSON.stringify(session.listingTruncated)},`);
		await writer.write('"transcript":');
		await writer.writeValue(session.transcript, seen);
		await writer.write(',"summary":');
		await writer.writeValue(session.summary, seen);
		await writer.write(',"segments":[');
		for (let segmentIndex = 0; segmentIndex < session.segments.length; segmentIndex += 1) {
			const segment = session.segments[segmentIndex];
			if (!segment) {
				continue;
			}
			if (segmentIndex > 0) {
				await writer.write(",");
			}
			await writer.write("{");
			await writer.write('"header":');
			await writer.writeValue(segment.header, seen);
			await writer.write(',"artifactTaskId":');
			await writer.writeString(segment.artifactTaskId);
			await writer.write(',"launchConfig":');
			await writer.writeValue(segment.launchConfig, seen);
			await writer.write(',"transcript":');
			await writer.writeValue(segment.transcript, seen);
			await writer.write(',"messages":[');
			for (let messageIndex = 0; messageIndex < segment.messages.length; messageIndex += 1) {
				const message = segment.messages[messageIndex];
				if (!message) {
					continue;
				}
				if (messageIndex > 0) {
					await writer.write(",");
				}
				await writer.writeValue(message, seen);
			}
			await writer.write('],"liveTail":');
			await writer.writeValue(segment.liveTail, seen);
			await writer.write(',"toolOrigins":');
			await writer.writeValue(segment.toolOrigins, seen);
			await writer.write(',"toolEvidence":[');
			for (let evidenceIndex = 0; evidenceIndex < segment.toolEvidence.length; evidenceIndex += 1) {
				const evidence = segment.toolEvidence[evidenceIndex];
				if (!evidence) {
					continue;
				}
				if (evidenceIndex > 0) {
					await writer.write(",");
				}
				await writeToolEvidence(evidence, writer, seen, readArtifact);
			}
			await writer.write("]}");
		}
		await writer.write("]}");
	}
	await writer.write("]");
	await writer.write("}");
}

/**
 * Streams one tool evidence entry. Resolved full outputs stream the artifact
 * file inline as an exact raw text string (`content`); everything else is
 * streamed from the typed value.
 */
async function writeToolEvidence(
	evidence: TaskDiagnosticsExportToolEvidence,
	writer: JsonStreamWriter,
	seen: WeakSet<object>,
	readArtifact: (path: string) => Readable,
): Promise<void> {
	await writer.write("{");
	await writer.write(`"messageIndex":${JSON.stringify(evidence.messageIndex)},`);
	await writer.write(`"partIndex":${JSON.stringify(evidence.partIndex)},`);
	await writer.write('"toolCallId":');
	await writer.writeString(evidence.toolCallId);
	await writer.write(`,"kind":${JSON.stringify(evidence.kind)}`);
	if (evidence.kind === "tool_result" && evidence.fullOutput) {
		const fullOutput = evidence.fullOutput;
		await writer.write(',"fullOutput":{');
		await writer.write(`"status":${JSON.stringify(fullOutput.status)},`);
		await writer.write('"artifactFileName":');
		await writer.writeValue(fullOutput.artifactFileName, seen);
		await writer.write(',"artifactPath":');
		await writer.writeValue(fullOutput.artifactPath, seen);
		await writer.write(',"contentFormat":');
		await writer.writeValue(fullOutput.contentFormat, seen);
		await writer.write(',"gap":');
		await writer.writeValue(fullOutput.gap, seen);
		if (fullOutput.status === "resolved" && fullOutput.artifactPath !== null) {
			await writer.write(',"content":');
			await streamArtifactText(writer, fullOutput.artifactPath, readArtifact);
		}
		await writer.write("}");
	}
	if (evidence.annotation !== undefined) {
		await writer.write(',"annotation":');
		await writer.writeString(evidence.annotation);
	}
	await writer.write("}");
}
