import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCommentHandlingInstruction,
	MAX_COMMENT_PROMPT_CHARS,
	prepareCommentHandlingInstruction,
} from "../../../src/pr-tracking/comment-handling-prompt";
import * as artifacts from "../../../src/workspace/task-artifacts";
import { isolateTestEnvironment } from "../../utilities/test-environment";

let env: ReturnType<typeof isolateTestEnvironment>;
beforeEach(() => {
	env = isolateTestEnvironment();
});
afterEach(() => {
	vi.restoreAllMocks();
	env.cleanup();
});

describe("bounded PR feedback prompt", () => {
	const event = {
		kind: "inline" as const,
		providerId: "inline-12",
		updatedAt: 1_700_000_000_000,
		bodyDigest: "digest",
		body: "Fix this case",
		path: "src/file.ts",
		line: 8,
		author: "reviewer",
		url: "https://github.com/o/r/pull/1#discussion_r12",
		diffHunk: "@@ context @@",
	};
	it("includes complete feedback and explicitly defers later feedback without restricting replies", () => {
		const prompt = buildCommentHandlingInstruction("https://github.com/o/r/pull/1", {
			events: [event],
			capturedAt: event.updatedAt,
			headSha: "abc",
		});
		for (const value of [
			event.body,
			event.path,
			event.url,
			event.author,
			event.diffHunk,
			event.providerId,
			"2023-11-14T22:13:20.000Z",
			"abc",
			"Do not fetch/list new PR comments",
			"Use the supplied IDs/URLs for replies",
		])
			expect(prompt).toContain(value);
	});
	it("guards synchronous callers against accidentally sending an oversized inline batch", () => {
		expect(() =>
			buildCommentHandlingInstruction("url", {
				events: [{ ...event, body: "x".repeat(MAX_COMMENT_PROMPT_CHARS) }],
				capturedAt: event.updatedAt,
				headSha: "abc",
			}),
		).toThrow("No feedback was marked dispatched");
	});

	const prUrl = "https://github.com/o/r/pull/1";
	const artifact = { taskId: "t1", dispatchId: "dispatch-1" };
	const batch = { events: [event], capturedAt: event.updatedAt, headSha: "abc" };
	it("keeps small batches inline without creating an artifact", async () => {
		const write = vi.spyOn(artifacts, "writeTaskContextArtifact");
		expect(await prepareCommentHandlingInstruction(prUrl, batch, artifact)).toBe(
			buildCommentHandlingInstruction(prUrl, batch),
		);
		expect(write).not.toHaveBeenCalled();
	});

	it("falls back only when the entire rendered prompt exceeds the limit", async () => {
		const overhead = buildCommentHandlingInstruction(prUrl, { ...batch, events: [{ ...event, body: "" }] }).length;
		const exact = { ...batch, events: [{ ...event, body: "x".repeat(MAX_COMMENT_PROMPT_CHARS - overhead) }] };
		const write = vi.spyOn(artifacts, "writeTaskContextArtifact");
		expect((await prepareCommentHandlingInstruction(prUrl, exact, artifact)).length).toBe(MAX_COMMENT_PROMPT_CHARS);
		expect(write).not.toHaveBeenCalled();
		const larger = { ...batch, events: [{ ...exact.events[0], body: `${exact.events[0]?.body}x` }] };
		expect(await prepareCommentHandlingInstruction(prUrl, larger, artifact)).toContain("Feedback snapshot file:");
	});

	it.each(["one long comment", "many comments"])(
		"preserves complete versions for %s in a readable artifact",
		async (kind) => {
			const events = Array.from({ length: kind === "one long comment" ? 1 : 100 }, (_, index) => ({
				...event,
				providerId: `inline-${index}`,
				body: `${"Long feedback 🐒\n\t".repeat(kind === "one long comment" ? 4000 : 40)}END-${index}`,
			}));
			const prompt = await prepareCommentHandlingInstruction(prUrl, { ...batch, events }, artifact);
			const dir = artifacts.getTaskContextArtifactsDir(artifact.taskId);
			const files = (await readdir(dir)).filter((name) => name.endsWith(".txt"));
			expect(files).toHaveLength(1);
			const path = join(dir, files[0] ?? "missing");
			const saved = JSON.parse(await artifacts.readTaskContextArtifact(path));
			expect(saved).toMatchObject({
				schemaVersion: 1,
				prUrl,
				capturedAt: "2023-11-14T22:13:20.000Z",
				headSha: "abc",
			});
			expect(saved.events).toEqual(
				events.map(({ providerId, updatedAt, ...item }) => ({
					...item,
					id: providerId,
					updatedAt: new Date(updatedAt).toISOString(),
				})),
			);
			expect(prompt).toContain(JSON.stringify(path));
			expect(prompt.length).toBeLessThanOrEqual(MAX_COMMENT_PROMPT_CHARS);
			expect(prompt).not.toContain("END-0");
			for (const instruction of [
				"Do not fetch/list new PR comments",
				"bounded character slices",
				"every item's complete body",
				"Do not edit, delete, or commit it",
				"stop and report the failure",
			])
				expect(prompt).toContain(instruction);
		},
	);

	it.each(["unreadable", "mismatch"])("rejects a snapshot that is %s before dispatch", async (failure) => {
		const read = vi.spyOn(artifacts, "readTaskContextArtifact");
		if (failure === "unreadable") read.mockRejectedValueOnce(new Error("Read denied"));
		else read.mockResolvedValueOnce("incomplete");
		await expect(
			prepareCommentHandlingInstruction(
				prUrl,
				{
					...batch,
					events: [{ ...event, body: "x".repeat(MAX_COMMENT_PROMPT_CHARS) }],
				},
				artifact,
			),
		).rejects.toThrow("No feedback was marked dispatched");
	});

	it("retains earlier snapshots when a later preparation captures a different version", async () => {
		const events = [{ ...event, body: "x".repeat(MAX_COMMENT_PROMPT_CHARS) }];
		const original = await prepareCommentHandlingInstruction(prUrl, { ...batch, events }, artifact);
		const revised = await prepareCommentHandlingInstruction(
			prUrl,
			{
				...batch,
				events: [{ ...events[0], body: "y".repeat(MAX_COMMENT_PROMPT_CHARS), bodyDigest: "revised" }],
			},
			artifact,
		);
		expect(original).not.toBe(revised);
		const dir = artifacts.getTaskContextArtifactsDir(artifact.taskId);
		const files = (await readdir(dir)).filter((name) => name.endsWith(".txt"));
		expect(files).toHaveLength(2);
		const saved = await Promise.all(
			files.map(async (name) => JSON.parse(await artifacts.readTaskContextArtifact(join(dir, name)))),
		);
		expect(saved.map((snapshot) => snapshot.events[0].bodyDigest).sort()).toEqual(["digest", "revised"]);
	});
});
