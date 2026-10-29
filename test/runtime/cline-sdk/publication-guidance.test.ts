// AR-5: focused composition tests for the safe publication guidance in the
// native coding system prompt. These verify prompt composition and role
// scoping only — they do not assert that a real model behaves differently.
import { describe, expect, it } from "vitest";
import { isPublicationCapableSessionId } from "../../../src/cline-sdk/cline-session-ids";
import { buildReviewInitialPrompt } from "../../../src/cline-sdk/review-prompt";
import { findDeniedReviewCommand } from "../../../src/cline-sdk/review-tool-policy";
import {
	CLINE_EDITOR_SIZE_GUIDANCE,
	CLINE_PROPORTIONAL_PLANNING_GUIDANCE,
	CLINE_PUBLICATION_GUIDANCE,
	resolveClineSdkSystemPrompt,
} from "../../../src/cline-sdk/sdk-runtime-boundary";
import { resolveHomeAgentAppendSystemPrompt } from "../../../src/prompts/append-system-prompt";
import { PR_CI_HANDOFF_GUIDANCE } from "../../../src/prompts/pr-ci-handoff";

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

function buildMinimalReviewArtifact() {
	return {
		taskId: "task-1",
		worktreePath: "/tmp/worktree",
		repoPath: "/tmp/repo",
		startingCommit: null,
		latestCommit: null,
		changedPaths: ["src/example.ts"],
		untrackedPaths: [],
		planDocuments: [],
		acceptanceCriteria: ["The example works"],
		designDecisions: [],
		testsAttempted: [],
		knownLimitations: [],
		unresolvedQuestions: [],
		createdAt: 1700000000000,
	};
}

const HOME_AGENT_TASK_ID = "__home_agent__:workspace-1:codex";

describe("AR-5 safe publication guidance", () => {
	it("composes the ordinary native coding prompt with the guidance exactly once as a final section", async () => {
		const prompt = await resolveClineSdkSystemPrompt({
			cwd: process.cwd(),
			providerId: "openai",
			includePublicationGuidance: true,
		});
		expect(countOccurrences(prompt, CLINE_PUBLICATION_GUIDANCE)).toBe(1);
		expect(countOccurrences(prompt, PR_CI_HANDOFF_GUIDANCE)).toBe(1);
		// The other guidance sections stay intact and separate.
		expect(countOccurrences(prompt, CLINE_PROPORTIONAL_PLANNING_GUIDANCE)).toBe(1);
		expect(countOccurrences(prompt, CLINE_EDITOR_SIZE_GUIDANCE)).toBe(1);
		// The publication guidance is a standalone final section.
		expect(prompt.endsWith(`\n\n${CLINE_PUBLICATION_GUIDANCE}`)).toBe(true);
	});

	it("omits the guidance from non-publication-capable compositions", async () => {
		const prompt = await resolveClineSdkSystemPrompt({
			cwd: process.cwd(),
			providerId: "openai",
			includePublicationGuidance: false,
		});
		expect(prompt).not.toContain(CLINE_PUBLICATION_GUIDANCE);
		expect(prompt).not.toContain(PR_CI_HANDOFF_GUIDANCE);
		// The other guidance sections are unaffected.
		expect(prompt).toContain(CLINE_PROPORTIONAL_PLANNING_GUIDANCE);
		expect(prompt).toContain(CLINE_EDITOR_SIZE_GUIDANCE);
	});

	it("scopes the guidance to publication-capable coding sessions", () => {
		// Ordinary task sessions are publication-capable.
		expect(isPublicationCapableSessionId("task-1")).toBe(true);
		// Sidebar-only (home agent) sessions are not.
		expect(isPublicationCapableSessionId(HOME_AGENT_TASK_ID)).toBe(false);
		// Bounded review and verification-repair sessions are not.
		expect(isPublicationCapableSessionId("task-1::review")).toBe(false);
		expect(isPublicationCapableSessionId("task-1::verification-repair-1")).toBe(false);
	});

	it("keeps the sidebar role boundary intact and free of the guidance", () => {
		const homePrompt = resolveHomeAgentAppendSystemPrompt(HOME_AGENT_TASK_ID, {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path: string) => path,
		});
		if (homePrompt === null) {
			throw new Error("expected a home-agent append system prompt");
		}
		expect(homePrompt).not.toContain(CLINE_PUBLICATION_GUIDANCE);
		expect(homePrompt).toContain("You are NOT a coding agent");
	});

	it("keeps the bounded review role intact, free of the guidance, and still denying publication", () => {
		const reviewPrompt = buildReviewInitialPrompt({
			artifact: buildMinimalReviewArtifact(),
			diff: "(no diff)",
			policyInstructions: "",
		});
		expect(reviewPrompt).not.toContain(CLINE_PUBLICATION_GUIDANCE);
		expect(reviewPrompt).toContain("### Your mandate");
		// The review tool policy still denies publication regardless of the
		// composition change.
		expect(findDeniedReviewCommand("gh pr create --title t --body b")).not.toBeNull();
		expect(findDeniedReviewCommand("git push origin task-branch")).not.toBeNull();
	});

	it("pins the wording contract without new retry, re-read, or snapshot requirements", () => {
		// The exact proposed wording is what ships.
		expect(CLINE_PUBLICATION_GUIDANCE).toContain(
			"When publication is authorized, preserve the exact intended Markdown.",
		);
		expect(CLINE_PUBLICATION_GUIDANCE).toContain(
			"write the body as UTF-8 to a file and use the command's supported --body-file option",
		);
		expect(CLINE_PUBLICATION_GUIDANCE).toContain(
			"For an API operation, use its supported structured input or file input",
		);
		expect(CLINE_PUBLICATION_GUIDANCE).toContain("Keep temporary body files out of commits");
		expect(CLINE_PUBLICATION_GUIDANCE).toContain("Verify the stored body once after publication");
		// The timeout example says: investigate the existing remote object,
		// not automatically retry publication.
		expect(CLINE_PUBLICATION_GUIDANCE).toContain(
			"If publication times out or its identity is unclear, inspect the existing remote state before creating another object.",
		);
		expect(CLINE_PUBLICATION_GUIDANCE).not.toContain("retry");
		// No new feedback-snapshot or fresh-comment recheck requirement.
		expect(CLINE_PUBLICATION_GUIDANCE).toContain(
			"Follow the current bounded feedback instructions when choosing which comments to address",
		);
		expect(CLINE_PUBLICATION_GUIDANCE).not.toContain("recheck");
	});

	it("does not duplicate the existing Auto-PR publication instructions in the native prompt", async () => {
		const prompt = await resolveClineSdkSystemPrompt({
			cwd: process.cwd(),
			providerId: "openai",
			includePublicationGuidance: true,
		});
		// The Auto-PR template's step-by-step instructions stay in the
		// template, not the system prompt.
		expect(prompt).not.toContain("write the description to a UTF-8 file in the task worktree");
		expect(prompt).not.toContain("open a pull request against {{base_ref}}");
	});
});
