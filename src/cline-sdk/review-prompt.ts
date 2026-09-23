// B-6.3: prompt construction for bounded review sessions.
//
// A review session starts with a fresh context: no implementation
// transcript. The initial prompt is the authoritative briefing — acceptance
// criteria, change set, plan documents, the diff against the recorded
// starting revision (truncated to a bounded size), and the reviewer's
// mandate. The reviewer must end its session by submitting a fenced
// `kanban-review-result` JSON block; Kanban parses it and treats a missing
// or malformed block as `parse_failed`, never as a pass.
import type {
	RuntimeReviewFinding,
	RuntimeReviewHandoffArtifact,
	RuntimeVerificationReceipt,
} from "../core/api-contract";

/** Hard cap on the diff embedded in a review prompt (large diffs: reviewer paginates via git). */
const MAX_DIFF_CHARS = 20000;
/** Hard cap on the implementation self-report (unverified text) embedded in a review prompt. */
const MAX_NOTES_CHARS = 4000;

function renderList(items: readonly string[]): string {
	if (items.length === 0) {
		return "(none)";
	}
	return items.map((item) => `- ${item}`).join("\n");
}

function renderTruncated(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}\n… [truncated — inspect the rest with git, e.g. \`git diff -- <path>\`]`;
}

function renderPlanDocuments(artifact: RuntimeReviewHandoffArtifact): string {
	const documents = artifact.planDocuments;
	if (documents.length === 0) {
		return "(none)";
	}
	return documents
		.map((doc) => {
			const state = doc.exists ? `sha256=${doc.sha256 ?? "unknown"}` : "MISSING (file not found)";
			const revision = doc.revision ? ` last revision ${doc.revision.slice(0, 12)}` : "";
			return `- ${doc.path} (${state}${revision})`;
		})
		.join("\n");
}

/**
 * Builds the initial review prompt: the fresh-context briefing for a
 * review session. Covers the diff against the starting revision plus
 * uncommitted/untracked content, and carries the coverage checklist the
 * reviewer must account for in its result.
 */
export function buildReviewInitialPrompt(input: {
	artifact: RuntimeReviewHandoffArtifact;
	/** Unified diff vs the recorded starting revision (tracked + staged). */
	diff: string;
	/** Optional user/operator review policy instructions (global runtime config). */
	policyInstructions: string;
}): string {
	const { artifact, diff, policyInstructions } = input;
	const baseline = artifact.startingCommit ?? "HEAD (no recorded starting revision)";
	const sections: string[] = [
		"### Bounded review session",
		`You are the reviewer for task ${artifact.taskId}. You are starting with a fresh context: you have no memory of the implementation session. Everything you need is in this briefing; inspect anything else in the workspace on demand.`,
		"",
		"### Your mandate",
		"1. Review the change set against the acceptance criteria below and against the authoritative plan documents. Verify behavior by reading code; do not trust the self-report.",
		"2. If a finding is small and clearly scoped (typo, missing null check, wrong constant, small missing case), fix it directly and record it in `fixesApplied`.",
		"3. Do NOT: commit, push, or run any Git publication command; do not restructure code, add features, upgrade dependencies, or reformat unrelated code. If a fix is broader than a scoped defect, record it as a finding instead of applying it.",
		"4. You may run read-only commands (`git diff`, `git log`, `git show`, `git status`, tests, linters) to gather evidence.",
		"5. Cover every changed path and every acceptance criterion; list what you covered in `requirementsCovered` and anything you could not resolve in `unresolvedItems`.",
		"",
		"### Acceptance criteria (authoritative)",
		renderList(artifact.acceptanceCriteria),
		"",
		"### Change set (vs starting revision)",
		`- starting revision: ${baseline}`,
		`- latest commit: ${artifact.latestCommit ?? "(no commits)"}`,
		`- changed paths:\n${renderList(artifact.changedPaths)}`,
		`- untracked files:\n${renderList(artifact.untrackedPaths)}`,
		"",
		"### Plan documents (authoritative)",
		renderPlanDocuments(artifact),
	];
	if (policyInstructions.trim()) {
		sections.push("", "### Review policy instructions", policyInstructions.trim());
	}
	const notes = artifactNotes(artifact);
	if (notes) {
		sections.push("", "### Implementation self-report (UNVERIFIED — claims only, verify against code)", notes);
	}
	sections.push(
		"",
		"### Diff (vs starting revision, truncated at 20000 chars)",
		"```diff",
		renderTruncated(diff || "(no tracked diff — review the untracked files above)", MAX_DIFF_CHARS),
		"```",
		"",
		"### Result format (required)",
		"When you are done, submit a final message containing exactly one fenced block:",
		"```kanban-review-result",
		"{",
		'  "findings": [ { "severity": "blocking" | "non-blocking", "file": "path or null", "line": 12 or null, "description": "...", "evidence": "file/line or diff excerpt" } ],',
		'  "blocking": true|false,',
		'  "fixesApplied": ["..."],',
		'  "requirementsCovered": ["..."],',
		'  "unresolvedItems": ["..."]',
		"}",
		"```",
		"A missing or malformed block is recorded as parse_failed and is never treated as a pass.",
	);
	return sections.join("\n");
}
/** Renders the self-report lists recorded in the handoff, or null when empty. */
function artifactNotes(artifact: RuntimeReviewHandoffArtifact): string | null {
	const sections: string[] = [];
	if (artifact.designDecisions.length > 0) {
		sections.push(`Design decisions:\n${renderList(artifact.designDecisions)}`);
	}
	if (artifact.testsAttempted.length > 0) {
		sections.push(`Tests attempted:\n${renderList(artifact.testsAttempted)}`);
	}
	if (artifact.knownLimitations.length > 0) {
		sections.push(`Known limitations:\n${renderList(artifact.knownLimitations)}`);
	}
	if (artifact.unresolvedQuestions.length > 0) {
		sections.push(`Unresolved questions:\n${renderList(artifact.unresolvedQuestions)}`);
	}
	if (sections.length === 0) {
		return null;
	}
	return renderTruncated(sections.join("\n\n"), MAX_NOTES_CHARS);
}

/**
 * Builds the repair-round prompt: re-enters the same session with the
 * findings that were not resolved, keeping the same scope limits.
 */
export function buildReviewRepairPrompt(input: {
	artifact: RuntimeReviewHandoffArtifact;
	/** Findings from the previous round that are still unresolved. */
	findings: RuntimeReviewFinding[];
	/** 1-based repair round number. */
	round: number;
	maxRounds: number;
}): string {
	const { artifact, findings, round, maxRounds } = input;
	const findingLines = findings
		.map((finding, index) => {
			const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "(whole change)";
			return `${index + 1}. [${finding.severity}] ${location} — ${finding.description}\n   Evidence: ${finding.evidence}`;
		})
		.join("\n");
	return [
		"### Review repair round",
		`Repair round ${round} of at most ${maxRounds} for task ${artifact.taskId}. The previous review round left the following unresolved findings. Fix ONLY these findings with the smallest scoped changes possible — no refactors, no new features, no unrelated formatting.`,
		"",
		findingLines,
		"",
		"You may not commit or push. When you are done (or if a finding cannot be fixed within scope), submit a final message containing the same fenced ```kanban-review-result block as before, with the remaining open findings in `findings` and everything still unresolved in `unresolvedItems`.",
	].join("\n");
}

/**
 * B-7.5: builds the verification-repair prompt for a FRESH bounded repair
 * session: the task context it needs (acceptance criteria, editable change
 * set) plus the deterministic check failures from the last gate receipt.
 * Verification repairs share the review policy's maxRepairRounds budget.
 */
export function buildVerificationRepairPrompt(input: {
	artifact: RuntimeReviewHandoffArtifact;
	/** The deterministic verification receipt from the last gate run (its required checks did not all pass). */
	receipt: RuntimeVerificationReceipt;
	/** 1-based repair round number (shared with review repairs). */
	round: number;
	maxRounds: number;
}): string {
	const { artifact, receipt, round, maxRounds } = input;
	const failed = receipt.checks.filter((check) => check.status !== "passed");
	const checkLines =
		failed.length === 0
			? "(all configured checks passed — the gate failed for a tree-identity reason below)"
			: failed
					.map((check) => {
						const detail =
							check.error ?? (check.exitCode !== null ? `exit code ${check.exitCode}` : "no exit code");
						const excerpt = check.outputExcerpt.trim().slice(0, 4000);
						const excerptBlock = excerpt
							? `\n   Output (head):\n${excerpt
									.split("\n")
									.map((line) => `   ${line}`)
									.join("\n")}`
							: "";
						return `- "${check.id}" (${check.status}): ${detail}${excerptBlock}`;
					})
					.join("\n");
	const sections: string[] = [
		"### Verification repair round",
		`Repair round ${round} of at most ${maxRounds} for task ${artifact.taskId}. You are a fresh repair session: the deterministic verification gate FAILED on this task's reviewed change set, and the results below are authoritative. Fix ONLY what is needed to make the failing checks pass, with the smallest scoped changes. Do not modify, weaken, or remove the checks themselves, and do not commit, push, or run any Git publication command.`,
		"",
		"Task acceptance criteria:",
		...(artifact.acceptanceCriteria.length > 0
			? artifact.acceptanceCriteria.map((criterion) => `- ${criterion}`)
			: ["- (none recorded)"]),
		"",
		"Files you may edit (the reviewed change set):",
		...[...artifact.changedPaths, ...artifact.untrackedPaths].map((path) => `- ${path}`),
		"",
		"Failed checks:",
		checkLines,
	];
	if (!receipt.treeIdentityPreserved) {
		sections.push(
			"",
			"The worktree changed while the checks ran (tree identity not preserved). If a check writes generated files into the worktree, keep them gitignored or write them outside the worktree.",
		);
	}
	sections.push(
		"",
		"When you are done (or if the failure cannot be fixed within scope), stop and briefly report what you changed and why the checks now pass (or why they cannot).",
	);
	return sections.join("\n");
}
