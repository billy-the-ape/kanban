import type { RuntimeTaskAutoReviewMode, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";

export type TaskGitAction = Extract<RuntimeTaskAutoReviewMode, "commit" | "pr">;

interface TaskGitPromptVariable {
	key: string;
	token: string;
	description: string;
}

export const TASK_GIT_BASE_REF_PROMPT_VARIABLE: TaskGitPromptVariable = {
	key: "base_ref",
	token: "{{base_ref}}",
	description: "the branch this task worktree was created from",
};

export interface TaskGitPromptTemplates {
	commitPromptTemplate?: string | null;
	openPrPromptTemplate?: string | null;
	commitPromptTemplateDefault?: string | null;
	openPrPromptTemplateDefault?: string | null;
}

interface BuildTaskGitActionPromptInput {
	action: TaskGitAction;
	workspaceInfo: RuntimeTaskWorkspaceInfoResponse;
	templates?: TaskGitPromptTemplates | null;
}

function resolveTemplate(action: TaskGitAction, templates?: TaskGitPromptTemplates | null): string {
	if (action === "commit") {
		const template = templates?.commitPromptTemplate?.trim();
		if (template) {
			return template;
		}
		const defaultTemplate = templates?.commitPromptTemplateDefault?.trim();
		if (defaultTemplate) {
			return defaultTemplate;
		}
		return "Handle this commit action using the provided git context.";
	}
	const template = templates?.openPrPromptTemplate?.trim();
	if (template) {
		return template;
	}
	const defaultTemplate = templates?.openPrPromptTemplateDefault?.trim();
	if (defaultTemplate) {
		return defaultTemplate;
	}
	return "Handle this pull request action using the provided git context.";
}

function interpolateTemplate(template: string, variables: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(variables)) {
		result = result.replaceAll(`{{${key}}}`, value);
	}
	return result;
}

export function buildTaskGitActionPrompt(input: BuildTaskGitActionPromptInput): string {
	const variables: Record<string, string> = {
		[TASK_GIT_BASE_REF_PROMPT_VARIABLE.key]: input.workspaceInfo.baseRef,
	};
	// AUTOGIT: the template is the single source of truth for the prompt.
	// Previously a hard-coded PR description block was appended after the
	// template, so a custom open-PR template that already covers the PR
	// description received the guidance twice in one message.
	const template = resolveTemplate(input.action, input.templates);
	return interpolateTemplate(template, variables);
}
