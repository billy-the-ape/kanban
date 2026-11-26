// PCR-2: the server-rendered conflict-repair prompt.
//
// Rendered server-side (never in the browser) because the prompt must carry
// the provider-authoritative head/base branch and SHAs — facts the browser
// does not have. The rendering rules are deliberate:
//
// - A required token with no value is a refusal, never an empty string: a
//   prompt that says `Head branch:` with nothing after it sends a turn with
//   push rights to guess.
// - A missing OPTIONAL token drops the whole line that carried it, so the
//   turn never sees `Known remote head: null`.
// - Unknown `{{tokens}}` stay untouched: the template is operator-owned
//   configuration and must survive intact.
// - Every interpolated value is sanitized (control characters/line breaks
//   collapsed, length-capped): branch names and provider-owned strings are
//   untrusted and end up in a turn that has push rights.

import { interpolateTemplate, sanitizeTemplateValue } from "../core/prompt-template-interpolation";

export interface ConflictRepairPromptVariables {
	/** Canonical URL of the clicked PR link. Required. */
	prUrl: string;
	/** `owner/repo` from the PR link. Required. */
	repository: string;
	/** Provider snapshot `head.ref`. Required. */
	headBranch: string | null;
	/** Provider snapshot `base.ref`. Required. */
	baseBranch: string | null;
	/** The task worktree path — the only checkout the turn may touch. Required. */
	taskWorktreePath: string;
	/** Provider snapshot `head.sha`. Optional; the sentence is dropped when absent. */
	headSha: string | null;
	/** Provider snapshot `base.sha`. Optional. */
	baseSha: string | null;
	/** The card's own base ref (`card.baseRef`), which may differ from the PR base. Optional. */
	cardBaseRef: string | null;
}

export type RenderConflictRepairPromptResult =
	| { ok: true; prompt: string }
	| { ok: false; missing: ConflictRepairPromptMissingToken[] };

export type ConflictRepairPromptMissingToken =
	| "pr_url"
	| "repository"
	| "head_branch"
	| "base_branch"
	| "task_worktree_path";

const MISSING_TOKEN_MESSAGES: Record<ConflictRepairPromptMissingToken, string> = {
	pr_url: "The PR link URL is missing.",
	repository: "The PR repository (owner/repo) could not be derived from the link.",
	head_branch:
		"The PR head branch is unknown. Open the PRs tab and use Refresh linked PRs, then press Resolve conflicts again.",
	base_branch:
		"The PR base branch is unknown. Open the PRs tab and use Refresh linked PRs, then press Resolve conflicts again.",
	task_worktree_path: "The task checkout path is unavailable, so the repair has no working copy to run in.",
};

/** Human-facing explanation for one refusal token. */
export function describeMissingConflictPromptToken(token: ConflictRepairPromptMissingToken): string {
	return MISSING_TOKEN_MESSAGES[token];
}

export function renderConflictRepairPrompt(
	template: string,
	variables: ConflictRepairPromptVariables,
): RenderConflictRepairPromptResult {
	const missing: ConflictRepairPromptMissingToken[] = [];
	const set = new Map<string, string>();
	const putRequired = (token: ConflictRepairPromptMissingToken, value: string | null | undefined): void => {
		const sanitized = value === null || value === undefined ? "" : sanitizeTemplateValue(value);
		if (sanitized.length === 0) {
			missing.push(token);
			return;
		}
		set.set(token, sanitized);
	};
	const putOptional = (token: string, value: string | null | undefined): void => {
		const sanitized = value === null || value === undefined ? "" : sanitizeTemplateValue(value);
		if (sanitized.length === 0) {
			// Drop every line that carried the token; never render `null`.
			text = dropLinesContaining(text, token);
			return;
		}
		set.set(token, sanitized);
	};
	let text = template;
	putRequired("pr_url", variables.prUrl);
	putRequired("repository", variables.repository);
	putRequired("head_branch", variables.headBranch);
	putRequired("base_branch", variables.baseBranch);
	putRequired("task_worktree_path", variables.taskWorktreePath);
	putOptional("head_sha", variables.headSha);
	putOptional("base_sha", variables.baseSha);
	putOptional("base_ref", variables.cardBaseRef);
	if (missing.length > 0) {
		return { ok: false, missing };
	}
	const prompt = interpolateTemplate(text, Object.fromEntries(set));
	if (prompt.trim().length === 0) {
		return { ok: false, missing: [] };
	}
	return { ok: true, prompt };
}

/** Removes whole lines containing `{{token}}` (an absent optional value). */
export function dropLinesContaining(text: string, token: string): string {
	const needle = `{{${token}}}`;
	return text
		.split("\n")
		.filter((line) => !line.includes(needle))
		.join("\n");
}
