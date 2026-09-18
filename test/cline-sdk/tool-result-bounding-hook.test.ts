// B-2.6 — unit tests for the ingestion-time tool-result bound: the window-scaled cap math,
// the head+tail excerpt builder (hard budget), and the afterTool hook behavior.
import { describe, expect, it, vi } from "vitest";

import {
	buildBoundedToolResultExcerpt,
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

		it("serializes structured tool outputs before bounding", async () => {
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
			const { hook, writeArtifact } = createHook({ toolName: "run_commands", output: "r".repeat(boundChars + 500) });
			expect(
				await hook(createContext({ toolName: "run_commands", output: "r".repeat(boundChars + 500) })),
			).toBeUndefined();
			expect(writeArtifact).not.toHaveBeenCalled();
		});

		it("honors a custom tool-name set and defaults to the read-family tools", async () => {
			expect(CLINE_TOOL_RESULT_BOUND_TOOL_NAMES).toContain("read_files");
			expect(CLINE_TOOL_RESULT_BOUND_TOOL_NAMES).toContain("read");
			const { hook, writeArtifact } = createHook({
				toolNames: ["run_commands"],
				toolName: "run_commands",
				output: "r".repeat(boundChars + 10),
			});
			const result = await hook(createContext({ toolName: "run_commands", output: "r".repeat(boundChars + 10) }));
			expect(result?.result?.output).not.toBeUndefined();
			expect(writeArtifact).toHaveBeenCalledTimes(1);
		});
	});
});
