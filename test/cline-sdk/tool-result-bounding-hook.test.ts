// B-2.6 + B-2.7 — unit tests for the ingestion-time tool-result bound: the window-scaled
// cap math, the head+tail char excerpt builder (hard budget), command-output routing
// (structured line excerpt with char fallback), and the afterTool hook behavior.
import { describe, expect, it, vi } from "vitest";

import {
	buildBoundedToolResultExcerpt,
	CLINE_COMMAND_OUTPUT_BOUND_TOOL_NAMES,
	CLINE_READ_RESULT_BOUND_TOOL_NAMES,
	CLINE_TOOL_RESULT_BOUND_MAX_CHARS,
	CLINE_TOOL_RESULT_BOUND_MIN_CHARS,
	CLINE_TOOL_RESULT_BOUND_TOOL_NAMES,
	computeToolResultBoundChars,
	createClineToolResultBoundingHook,
} from "../../src/cline-sdk/cline-tool-result-bounding-hook";
import type { ClineSdkAgentAfterToolContext } from "../../src/cline-sdk/sdk-runtime-boundary";

function createContext(
	overrides: { toolName?: string; toolCallId?: string; output?: unknown; isError?: boolean } = {},
): ClineSdkAgentAfterToolContext {
	return {
		snapshot: {} as ClineSdkAgentAfterToolContext["snapshot"],
		tool: {} as ClineSdkAgentAfterToolContext["tool"],
		toolCall: {
			type: "tool-call",
			toolCallId: overrides.toolCallId ?? "call-1",
			toolName: overrides.toolName ?? "read_files",
			input: {},
		},
		input: {},
		result: { output: overrides.output ?? "", isError: overrides.isError },
		startedAt: new Date(0),
		endedAt: new Date(0),
		durationMs: 0,
	} as ClineSdkAgentAfterToolContext;
}

function createFakeLogger() {
	return { debug: vi.fn(), log: vi.fn(), error: vi.fn() };
}

describe("computeToolResultBoundChars", () => {
	it("derives the 10% window ratio in chars/4", () => {
		expect(computeToolResultBoundChars(100_000)).toBe(40_000);
		expect(computeToolResultBoundChars(32_000)).toBe(12_800);
	});

	it("caps at the SDK's 50k request-assembly per-tool cap", () => {
		expect(computeToolResultBoundChars(262_144)).toBe(CLINE_TOOL_RESULT_BOUND_MAX_CHARS);
		expect(computeToolResultBoundChars(128_000)).toBe(CLINE_TOOL_RESULT_BOUND_MAX_CHARS);
		expect(CLINE_TOOL_RESULT_BOUND_MAX_CHARS).toBe(50_000);
	});

	it("floors at 4k chars for small windows", () => {
		expect(computeToolResultBoundChars(10_000)).toBe(CLINE_TOOL_RESULT_BOUND_MIN_CHARS);
		expect(computeToolResultBoundChars(8_000)).toBe(CLINE_TOOL_RESULT_BOUND_MIN_CHARS);
	});

	it("falls back to the SDK default window for unknown or invalid limits", () => {
		expect(computeToolResultBoundChars()).toBe(CLINE_TOOL_RESULT_BOUND_MAX_CHARS);
		expect(computeToolResultBoundChars(0)).toBe(CLINE_TOOL_RESULT_BOUND_MAX_CHARS);
		expect(computeToolResultBoundChars(NaN)).toBe(CLINE_TOOL_RESULT_BOUND_MAX_CHARS);
		expect(computeToolResultBoundChars(-5)).toBe(CLINE_TOOL_RESULT_BOUND_MAX_CHARS);
	});
});

describe("buildBoundedToolResultExcerpt", () => {
	const full = "A".repeat(10_000) + "MIDDLE" + "B".repeat(10_000);

	it("keeps head + tail with an accurate omission marker, within budget, with the reference", () => {
		const excerpt = buildBoundedToolResultExcerpt(full, 4_000, "/tmp/artifact.txt");
		expect(excerpt.length).toBeLessThanOrEqual(4_000);
		const match = excerpt.match(
			/^([AB]*)\n\n\.\.\.\[truncated (\d+) chars\]\.\.\.\n\n([AB]*)\nFull content: \/tmp\/artifact\.txt$/,
		);
		expect(match).not.toBeNull();
		const [, head, omitted, tail] = match!;
		expect(head.length).toBe(tail.length);
		expect(Number(omitted)).toBe(full.length - head.length - tail.length);
		expect(head).toBe("A".repeat(head.length));
		expect(tail).toBe("B".repeat(tail.length));
	});

	it("reserves the reference line length inside the same budget", () => {
		const longReference = `/tmp/${"x".repeat(300)}.txt`;
		const withReference = buildBoundedToolResultExcerpt(full, 4_000, longReference);
		const withoutReference = buildBoundedToolResultExcerpt(full, 4_000);
		expect(withoutReference.length).toBeLessThanOrEqual(4_000);
		expect(withoutReference).not.toContain("Full content:");
		expect(withReference.length).toBeLessThanOrEqual(4_000);
		expect(withReference.endsWith(`Full content: ${longReference}`)).toBe(true);
	});

	it("passes through content that already fits the budget (no marker, no overlap)", () => {
		expect(buildBoundedToolResultExcerpt("abc", 100)).toBe("abc");
		expect(buildBoundedToolResultExcerpt("abc", 100, "/tmp/a.txt")).toBe("abc\nFull content: /tmp/a.txt");
	});

	it("stays within budget when the content only slightly exceeds it", () => {
		const edge = "z".repeat(4_001);
		const excerpt = buildBoundedToolResultExcerpt(edge, 4_000);
		expect(excerpt.length).toBeLessThanOrEqual(4_000);
		const match = excerpt.match(/^([z]*)\n\n\.\.\.\[truncated (\d+) chars\]\.\.\.\n\n([z]*)$/);
		expect(match).not.toBeNull();
		const [, head, omitted, tail] = match!;
		expect(Number(omitted)).toBeGreaterThan(0);
		expect(head.length + tail.length + Number(omitted)).toBe(edge.length);
	});

	describe("createClineToolResultBoundingHook", () => {
		const boundChars = CLINE_TOOL_RESULT_BOUND_MIN_CHARS; // limitTokens: 8_000 -> floor

		function createHook(options: { toolName?: string; output?: unknown; toolNames?: readonly string[] }) {
			const logger = createFakeLogger();
			const writeArtifact = vi.fn().mockResolvedValue("fake-artifact.txt");
			const hook = createClineToolResultBoundingHook({
				taskId: "task-1",
				limitTokens: 8_000,
				logger,
				toolNames: options.toolNames,
				writeArtifact,
			});
			return {
				hook,
				logger,
				writeArtifact,
				context: createContext({ toolName: options.toolName, output: options.output }),
			};
		}

		it("does not touch results at or under the bound", async () => {
			const { hook, context, writeArtifact } = createHook({ output: "x".repeat(boundChars) });
			expect(await hook(context)).toBeUndefined();
			expect(writeArtifact).not.toHaveBeenCalled();
		});

		it("bounds oversized string results with the artifact reference and preserves error flags", async () => {
			const fullOutput = "y".repeat(boundChars + 500);
			const { hook, logger, writeArtifact, context } = createHook({ output: fullOutput });
			const result = await hook({ ...context, result: { output: fullOutput, isError: true } });
			expect(result?.result?.output).toBeTypeOf("string");
			const output = result!.result!.output as string;
			expect(output.length).toBeLessThanOrEqual(boundChars);
			expect(output).toContain("Full content: fake-artifact.txt");
			expect(result!.result!.isError).toBe(true);
			expect(writeArtifact).toHaveBeenCalledWith({ taskId: "task-1", toolCallId: "call-1", content: fullOutput });
			expect(logger.log).toHaveBeenCalledWith(
				expect.stringContaining("Bounded oversized tool result"),
				expect.objectContaining({ originalChars: fullOutput.length, artifactPath: "fake-artifact.txt" }),
			);
		});

		it("serializes structured read-family outputs before bounding (char path)", async () => {
			const payload = { entries: [{ query: "big-file.txt", result: "w".repeat(boundChars + 100), success: true }] };
			const { hook, writeArtifact } = createHook({ output: payload });
			const result = await hook(createContext({ output: payload }));
			const output = result!.result!.output as string;
			expect(output.length).toBeLessThanOrEqual(boundChars);
			expect(output).toContain("Full content: fake-artifact.txt");
			expect(writeArtifact).toHaveBeenCalledWith(
				expect.objectContaining({ content: expect.stringContaining('"query":"big-file.txt"') }),
			);
		});

		it("still bounds when the artifact write fails, without the reference line", async () => {
			const fullOutput = "v".repeat(boundChars + 500);
			const logger = createFakeLogger();
			const hook = createClineToolResultBoundingHook({
				taskId: "task-1",
				limitTokens: 8_000,
				logger,
				writeArtifact: () => Promise.reject(new Error("disk full")),
			});
			const result = await hook(createContext({ output: fullOutput }));
			const output = result!.result!.output as string;
			expect(output.length).toBeLessThanOrEqual(boundChars);
			expect(output).not.toContain("Full content:");
			expect(logger.log).toHaveBeenCalledWith(
				expect.stringContaining("Failed to write full tool-result content"),
				expect.objectContaining({ severity: "warn" }),
			);
		});

		it("ignores tools outside the bound set", async () => {
			const { hook, writeArtifact } = createHook({
				toolName: "write_to_file",
				output: "r".repeat(boundChars + 500),
			});
			expect(
				await hook(createContext({ toolName: "write_to_file", output: "r".repeat(boundChars + 500) })),
			).toBeUndefined();
			expect(writeArtifact).not.toHaveBeenCalled();
		});

		it("honors a custom tool-name set and defaults to read-family + command tools", async () => {
			expect(CLINE_TOOL_RESULT_BOUND_TOOL_NAMES).toContain("read_files");
			expect(CLINE_READ_RESULT_BOUND_TOOL_NAMES).toContain("read");
			expect(CLINE_COMMAND_OUTPUT_BOUND_TOOL_NAMES).toContain("run_commands");
			expect(CLINE_COMMAND_OUTPUT_BOUND_TOOL_NAMES).toContain("bash");
			const { hook, writeArtifact } = createHook({
				toolNames: ["my_tool"],
				toolName: "my_tool",
				output: "r".repeat(boundChars + 10),
			});
			const result = await hook(createContext({ toolName: "my_tool", output: "r".repeat(boundChars + 10) }));
			expect(result?.result?.output).not.toBeUndefined();
			expect(writeArtifact).toHaveBeenCalledTimes(1);
		});

		it("routes structured command results to the line-based excerpt with the artifact marker", async () => {
			const output = [
				{
					query: "seq 1 100000",
					result: Array.from({ length: 100_000 }, (_, i) => `${i + 1}:${"x".repeat(58)}`).join("\n"),
					success: true,
				},
			];
			const { hook, writeArtifact, logger } = createHook({ toolName: "run_commands", output });
			const result = await hook(createContext({ toolName: "run_commands", output }));
			expect(result?.result?.output).toBeTypeOf("string");
			const excerpt = result!.result!.output as string;
			expect(excerpt.length).toBeLessThanOrEqual(boundChars);
			expect(excerpt).toContain("Command 1/1: seq 1 100000");
			expect(excerpt).toContain("Exit status: success");
			expect(excerpt).toMatch(/\.\.\. \[truncated \d+ lines; full output: fake-artifact\.txt\]/);
			expect(excerpt).toContain("1:" + "x".repeat(58));
			expect(excerpt).toContain("100000:" + "x".repeat(58));
			expect(writeArtifact).toHaveBeenCalledWith({
				taskId: "task-1",
				toolCallId: "call-1",
				content: JSON.stringify(output),
			});
			expect(logger.log).toHaveBeenCalledWith(
				expect.stringContaining("Bounded oversized tool result"),
				expect.objectContaining({ excerptKind: "command-lines", artifactPath: "fake-artifact.txt" }),
			);
		});

		it("preserves a failed exit status in the head of the line excerpt (SDK failure shape)", async () => {
			// The SDK reports a non-zero exit as result: "" plus an error string
			// ("Command failed: " + stderr / exit code text); the stderr IS the body.
			const stderr = Array.from({ length: 5_000 }, (_, i) => `step ${i + 1}`);
			const output = [
				{
					query: "bash -lc 'seq 1 5000 >&2; echo ERR-TAIL-MARK >&2; exit 1'",
					result: "",
					success: false,
					error: `Command failed: ${stderr.join("\n")}\nERR-TAIL-MARK`,
				},
			];
			const { hook, writeArtifact } = createHook({ toolName: "run_commands", output });
			const result = await hook(createContext({ toolName: "run_commands", output }));
			const excerpt = result!.result!.output as string;
			const lines = excerpt.split("\n");
			expect(lines[0]).toBe("Command 1/1: bash -lc 'seq 1 5000 >&2; echo ERR-TAIL-MARK >&2; exit 1'");
			expect(lines[1]).toBe("Exit status: failed — Command failed: step 1");
			// The tail of the stderr survives, the middle is bounded away.
			expect(excerpt).toContain("ERR-TAIL-MARK");
			expect(excerpt).not.toContain("step 2500");
			expect(excerpt.length).toBeLessThanOrEqual(boundChars);
			// The full structured output (incl. the full stderr) is persisted as the artifact.
			expect(writeArtifact).toHaveBeenCalledWith({
				taskId: "task-1",
				toolCallId: "call-1",
				content: JSON.stringify(output),
			});
		});

		it("prepends a per-file stat summary for diff command output", async () => {
			const body = [
				"diff --git a/src/large.ts b/src/large.ts",
				"--- a/src/large.ts",
				"+++ b/src/large.ts",
				"@@ -1,1 +1,4901 @@",
				"-old",
				...Array.from({ length: 4_900 }, (_, i) => `+line ${i + 1}`),
				"diff --git a/src/small.ts b/src/small.ts",
				"--- a/src/small.ts",
				"+++ b/src/small.ts",
				"@@ -1,1 +1,2 @@",
				"-old",
				"+new",
			].join("\n");
			const output = [{ query: "git diff --cached", result: body, success: true }];
			const { hook } = createHook({ toolName: "run_commands", output });
			const result = await hook(createContext({ toolName: "run_commands", output }));
			const excerpt = result!.result!.output as string;
			expect(excerpt.length).toBeLessThanOrEqual(boundChars);
			const summaryIndex = excerpt.indexOf("Diff summary (2 files):");
			expect(summaryIndex).toBeGreaterThan(-1);
			expect(excerpt).toContain("  src/large.ts | +4901 -1");
			expect(excerpt).toContain("  src/small.ts | +2 -1");
			// The summary sits in the head, before the diff body.
			expect(summaryIndex).toBeLessThan(excerpt.indexOf("diff --git"));
			expect(excerpt).toMatch(/\.\.\. \[truncated \d+ lines; full output: fake-artifact\.txt\]/);
		});

		it("falls back to the char-based excerpt for unstructured command output", async () => {
			const output = "r".repeat(boundChars + 10);
			const { hook } = createHook({ toolName: "bash", output });
			const result = await hook(createContext({ toolName: "bash", output }));
			const excerpt = result!.result!.output as string;
			expect(excerpt.length).toBeLessThanOrEqual(boundChars);
			expect(excerpt).toContain("Full content: fake-artifact.txt");
		});
	});
});
