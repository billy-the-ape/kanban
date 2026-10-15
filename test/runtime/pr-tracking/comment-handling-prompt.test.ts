import { describe, expect, it } from "vitest";
import {
	buildCommentHandlingInstruction,
	MAX_COMMENT_PROMPT_CHARS,
} from "../../../src/pr-tracking/comment-handling-prompt";

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
	it("rejects oversized batches instead of silently dropping comments", () => {
		expect(() =>
			buildCommentHandlingInstruction("url", {
				events: [{ ...event, body: "x".repeat(MAX_COMMENT_PROMPT_CHARS) }],
				capturedAt: event.updatedAt,
				headSha: "abc",
			}),
		).toThrow("No feedback was marked dispatched");
	});
});
