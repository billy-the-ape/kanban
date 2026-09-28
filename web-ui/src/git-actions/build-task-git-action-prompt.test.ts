import { describe, expect, it } from "vitest";

import {
	buildTaskGitActionPrompt,
	TASK_GIT_BASE_REF_PROMPT_VARIABLE,
} from "@/git-actions/build-task-git-action-prompt";

describe("buildTaskGitActionPrompt", () => {
	it("interpolates the shared base ref variable into custom templates", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "commit",
				workspaceInfo: {
					taskId: "task-123",
					path: "/tmp/task-123",
					exists: true,
					baseRef: "main",
					branch: null,
					isDetached: true,
					headCommit: "abc123",
				},
				templates: {
					commitPromptTemplate: `Commit onto ${TASK_GIT_BASE_REF_PROMPT_VARIABLE.token}.`,
				},
			}),
		).toBe("Commit onto main.");
	});

	it("falls back to the default action prompt when no template is configured", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "pr",
				workspaceInfo: {
					taskId: "task-123",
					path: "/tmp/task-123",
					exists: true,
					baseRef: "main",
					branch: null,
					isDetached: true,
					headCommit: "abc123",
				},
			}),
		).toContain("Handle this pull request action using the provided git context.");
	});

	it("requires Markdown and a body file even with a custom PR template", () => {
		const prompt = buildTaskGitActionPrompt({
			action: "pr",
			workspaceInfo: {
				taskId: "task-123",
				path: "/tmp/task-123",
				exists: true,
				baseRef: "main",
				branch: null,
				isDetached: true,
				headCommit: "abc123",
			},
			templates: { openPrPromptTemplate: "Open a PR against {{base_ref}}." },
		});
		expect(prompt).toContain("Open a PR against main.");
		expect(prompt).toContain("Summary, Changes, Testing, and Deployment and follow-up");
		expect(prompt).toContain("gh pr create --body-file <path>");
		expect(prompt).toContain("Check the created PR description on GitHub");
	});
});
