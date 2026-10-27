// AR-4: focused composition tests for the proportionate planning guidance in
// the native coding system prompt. These verify prompt composition only —
// they do not assert that a real model behaves differently.
import { describe, expect, it } from "vitest";

import { buildReviewInitialPrompt } from "../../../src/cline-sdk/review-prompt";
import {
	applyProportionalPlanningGuidance,
	CLINE_EDITOR_SIZE_GUIDANCE,
	CLINE_PROPORTIONAL_PLANNING_GUIDANCE,
	getClineDefaultSystemPrompt,
	resolveClineSdkSystemPrompt,
} from "../../../src/cline-sdk/sdk-runtime-boundary";
import {
	renderAppendSystemPrompt,
	resolveHomeAgentAppendSystemPrompt,
} from "../../../src/prompts/append-system-prompt";

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

describe("AR-4 proportionate planning guidance", () => {
	it("replaces the installed SDK's verbose plan paragraph in place", () => {
		const defaultPrompt = getClineDefaultSystemPrompt({
			ide: "Kanban",
			rootPath: "/tmp",
			providerId: "openai",
			metadata: "",
			rules: "",
		});
		const result = applyProportionalPlanningGuidance(defaultPrompt);
		expect(result.status).toBe("replaced");
		expect(result.prompt).toContain(CLINE_PROPORTIONAL_PLANNING_GUIDANCE);
		expect(result.prompt).not.toContain("It's OK for this section to be quite long");
	});

	it("composes the act-mode coding prompt with the guidance exactly once", async () => {
		const prompt = await resolveClineSdkSystemPrompt({ cwd: process.cwd(), providerId: "openai" });
		expect(countOccurrences(prompt, CLINE_PROPORTIONAL_PLANNING_GUIDANCE)).toBe(1);
		expect(prompt).not.toContain("It's OK for this section to be quite long");
		// The editor recovery/publication guidance stays a separate intact section.
		expect(countOccurrences(prompt, CLINE_EDITOR_SIZE_GUIDANCE)).toBe(1);
	});

	it("keeps explicit planning requests authoritative", async () => {
		const prompt = await resolveClineSdkSystemPrompt({ cwd: process.cwd(), providerId: "openai" });
		expect(CLINE_PROPORTIONAL_PLANNING_GUIDANCE).toContain("Follow explicit user requests for planning");
		// The SDK's own planning bullet is preserved, so explicit plan-mode
		// instructions remain authoritative in the composed prompt.
		expect(prompt).toContain("Always show your planning process before executing any task.");
	});

	it("still permits extended investigation for complex work", () => {
		expect(CLINE_PROPORTIONAL_PLANNING_GUIDANCE).toContain(
			"Expand the plan when complexity or uncertainty warrants it, including design decisions and experiments needed for correctness.",
		);
		expect(CLINE_PROPORTIONAL_PLANNING_GUIDANCE).toContain(
			"Revisit it when new evidence changes the approach, requirements, or risk",
		);
		// No word/token/turn caps, first-edit deadlines, or reread bans.
		expect(CLINE_PROPORTIONAL_PLANNING_GUIDANCE).not.toContain("must finish");
		expect(CLINE_PROPORTIONAL_PLANNING_GUIDANCE).not.toContain("within");
	});

	it("keeps the SDK guardrails unchanged around the replaced section", async () => {
		const prompt = await resolveClineSdkSystemPrompt({ cwd: process.cwd(), providerId: "openai" });
		// The replaced section is followed verbatim by the guardrails that used
		// to follow the SDK's planning paragraph.
		expect(prompt).toContain(`${CLINE_PROPORTIONAL_PLANNING_GUIDANCE}\n\nREMEMBER, be helpful and proactive!`);
		expect(prompt).toContain("IMPORTANT: Always includes tool calls in your response until the task is completed.");
		expect(prompt).toContain(
			"If user asked a simple question without any coding context, answer it directly without using any tools.",
		);
		expect(prompt).toContain("Environment you are running in:");
	});

	it("keeps the bounded review role's mandate intact and free of the guidance", () => {
		const reviewPrompt = buildReviewInitialPrompt({
			artifact: buildMinimalReviewArtifact(),
			diff: "(no diff)",
			policyInstructions: "",
		});
		expect(reviewPrompt).not.toContain(CLINE_PROPORTIONAL_PLANNING_GUIDANCE);
		expect(reviewPrompt).toContain("### Your mandate");
	});

	it("keeps the sidebar role boundary intact and free of the guidance", () => {
		const homePrompt = resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:codex", {
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
		expect(homePrompt).not.toContain(CLINE_PROPORTIONAL_PLANNING_GUIDANCE);
		expect(homePrompt).toContain("You are NOT a coding agent");
		expect(renderAppendSystemPrompt("kanban")).not.toContain(CLINE_PROPORTIONAL_PLANNING_GUIDANCE);
	});

	it("applies the guidance at most once, including for composed home-agent prompts", async () => {
		const base = await resolveClineSdkSystemPrompt({ cwd: process.cwd(), providerId: "openai" });
		const appended = resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:codex", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path: string) => path,
		});
		if (appended === null) {
			throw new Error("expected a home-agent append system prompt");
		}
		const combined = `${base}\n\n${appended}`;
		expect(countOccurrences(combined, CLINE_PROPORTIONAL_PLANNING_GUIDANCE)).toBe(1);
		// Re-applying the helper to an already composed prompt is a no-op.
		const reApplied = applyProportionalPlanningGuidance(base);
		expect(reApplied.status).toBe("already-present");
		expect(reApplied.prompt).toBe(base);
	});

	it("appends the guidance once when the upstream SDK paragraph has drifted", () => {
		const drifted =
			"You are Cline, an AI coding agent.\n\nSome other planning sentence.\n\nREMEMBER, be helpful and proactive!";
		const result = applyProportionalPlanningGuidance(drifted);
		expect(result.status).toBe("appended");
		expect(result.prompt).toContain(drifted);
		expect(countOccurrences(result.prompt, CLINE_PROPORTIONAL_PLANNING_GUIDANCE)).toBe(1);
	});
});
