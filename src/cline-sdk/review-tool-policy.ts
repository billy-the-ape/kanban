// B-6.6: tool policy for bounded review sessions.
//
// A review session may read anything inside the task worktree and run
// read-only commands, but it must not publish or move history (`git push`,
// `git commit`, merges, ref/branch edits, `gh pr create`), must not discard
// worktree state (`git reset --hard`, forced `git clean`, `git stash`,
// checkout/restore of paths, `git worktree remove`, `rm -rf .`/`.git`), and
// may only write files that are part of the reviewed change set (or the task
// plan doc). Command checks are best-effort scans of the tool input, so the
// policy is a guardrail, not a sandbox. It only ever adds denials: anything
// it does not object to is decided by the workspace's existing approval
// handler (`delegate`), so project tool approvals stay effective.
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ClineSdkToolApprovalRequest, ClineSdkToolApprovalResult } from "./sdk-runtime-boundary";

export type ReviewToolApprovalHandler = (request: ClineSdkToolApprovalRequest) => Promise<ClineSdkToolApprovalResult>;

export interface CreateReviewToolPolicyOptions {
	/** Absolute path to the task worktree (anchor for write-path scoping). */
	worktreePath: string;
	/** Worktree-relative paths the review session may create or modify. */
	allowedWritePaths: readonly string[];
	/**
	 * The workspace's existing approval handler; it decides every request the
	 * review policy does not deny. Defaults to approving (the Kanban default).
	 */
	delegate?: ReviewToolApprovalHandler;
}

const approveByDefault: ReviewToolApprovalHandler = async () => ({ approved: true });

const COMMAND_TOOL_NAMES = new Set(["run_commands", "bash"]);
const EDITOR_TOOL_NAMES = new Set(["editor", "write_to_file", "replace_in_file"]);
const APPLY_PATCH_TOOL_NAME = "apply_patch";
const READ_TOOL_NAMES = new Set(["read_files", "list_files", "search_codebase", "search_files", "fetch_web_content"]);
// File header lines of the block-form patch ("*** Add File: <path>", ...).
const PATCH_FILE_HEADER_PATTERN = /^\*\*\*\s*(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/gm;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes a `run_commands` tool input to raw command strings. The SDK
 * accepts a string, an array, a `{ commands: [...] }` object, or structured
 * `{ command, args }` entries; all variants are reduced to joined strings
 * so the deny checks below work uniformly.
 */
function extractCommandStrings(input: unknown): string[] {
	const commands: string[] = [];
	const collect = (value: unknown): void => {
		if (typeof value === "string") {
			if (value.trim()) {
				commands.push(value);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) {
				const command = normalizeCommandEntry(entry);
				if (command) {
					commands.push(command);
				}
			}
			return;
		}
		if (isRecord(value)) {
			for (const key of ["commands", "command", "cmd"]) {
				const candidate = value[key];
				if (typeof candidate === "string" || Array.isArray(candidate)) {
					collect(candidate);
				}
			}
		}
	};
	collect(input);
	return commands;
}

function normalizeCommandEntry(entry: unknown): string | null {
	if (typeof entry === "string") {
		const trimmed = entry.trim();
		return trimmed ? entry : null;
	}
	if (isRecord(entry)) {
		const base = typeof entry.command === "string" ? entry.command : typeof entry.cmd === "string" ? entry.cmd : null;
		if (base === null) {
			return null;
		}
		const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
		const joined = [base, ...args].join(" ").trim();
		return joined ? joined : null;
	}
	return null;
}
/**
 * Finds the first bare `git` token and the subcommand that follows it,
 * skipping git's global options (`git -C repo push` → `push`). Returns null
 * when the fragment has no git invocation or when `--` is reached before a
 * subcommand (anything after it is a pathspec, not a subcommand).
 */
function locateGitSubcommand(tokens: string[]): { subcommand: string; rest: string[] } | null {
	for (let i = 0; i < tokens.length; i += 1) {
		if (tokens[i] !== "git") {
			continue;
		}
		let j = i + 1;
		while (j < tokens.length) {
			const token = tokens[j] ?? "";
			if (token === "--") {
				return null;
			}
			if (token.startsWith("--")) {
				j += token.includes("=") ? 1 : 2;
				continue;
			}
			if (token.startsWith("-") && token.length > 1) {
				const flag = token.charAt(1);
				j += token.length === 2 && (flag === "c" || flag === "C") ? 2 : 1;
				continue;
			}
			return { subcommand: token, rest: tokens.slice(j + 1) };
		}
		return null;
	}
	return null;
}

/** Splits a command line into fragments at unquoted shell operators. */
function splitCommandFragments(command: string): string[] {
	const masked = command
		.replace(/'(?:[^'\\]|\\.)*'/g, " '' ")
		.replace(/"(?:[^"\\]|\\.)*"/g, ' "" ')
		.replace(/`[^`]*`/g, " `` ");
	return masked
		.split(/&&|\|\||;|\||\r?\n/)
		.map((fragment) => fragment.trim())
		.filter(Boolean);
}

/** Targets whose recursive forced removal would discard the worktree or its repository. */
function isProtectedRemovalTarget(token: string): boolean {
	const normalized = token.replace(/\/+$/, "");
	return (
		normalized === "" ||
		normalized === "." ||
		normalized === ".." ||
		normalized === "*" ||
		normalized === "~" ||
		normalized === ".git" ||
		normalized.endsWith("/.git")
	);
}

/** True for `rm -rf .`, `rm -rf *`, `rm -rf .git` style invocations. */
function isDestructiveRemoval(tokens: string[]): boolean {
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) {
		i += 1; // skip env var assignments such as `FOO=bar rm -rf ...`
	}
	const command = tokens[i] ?? "";
	if (command !== "rm" && !/\/rm$/.test(command)) {
		return false;
	}
	let recursive = false;
	let force = false;
	let targetsProtected = false;
	for (const token of tokens.slice(i + 1)) {
		if (token.startsWith("--")) {
			recursive ||= token === "--recursive";
			force ||= token === "--force";
			continue;
		}
		if (token.startsWith("-") && token.length > 1) {
			if (/[rR]/.test(token)) {
				recursive = true;
			}
			if (/f/.test(token)) {
				force = true;
			}
			continue;
		}
		if (isProtectedRemovalTarget(token)) {
			targetsProtected = true;
		}
	}
	return recursive && force && targetsProtected;
}

const DELIVERY_OWNED_GIT_SUBCOMMANDS = new Set([
	"push",
	"commit",
	"merge",
	"rebase",
	"cherry-pick",
	"revert",
	"am",
	"pull",
	"update-ref",
	"tag",
]);

/** Returns why a git invocation is forbidden in a review session, else null. */
function checkGitInvocation(subcommand: string, rest: string[]): string | null {
	if (DELIVERY_OWNED_GIT_SUBCOMMANDS.has(subcommand)) {
		return `git ${subcommand} is not allowed in review sessions; Kanban owns commits, integration, and Git delivery.`;
	}
	if (
		subcommand === "reset" &&
		rest.some((token) => token === "--hard" || token === "--merge" || token === "--keep")
	) {
		return "git reset --hard is not allowed in review sessions; review fixes must not discard work.";
	}
	if (
		subcommand === "clean" &&
		rest.some((token) => token.startsWith("-") && token.length > 1 && /[fF]/.test(token))
	) {
		return "forced git clean is not allowed in review sessions; untracked work must not be deleted.";
	}
	if (subcommand === "stash" && !["list", "show"].includes(rest[0] ?? "")) {
		return "git stash is not allowed in review sessions; it removes uncommitted task work from the worktree.";
	}
	if (subcommand === "checkout" || subcommand === "switch") {
		return `git ${subcommand} is not allowed in review sessions; it moves HEAD or discards worktree changes.`;
	}
	if (
		subcommand === "restore" &&
		!(rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W"))
	) {
		return "git restore of worktree files is not allowed in review sessions; it discards task changes.";
	}
	if (subcommand === "worktree" && ["remove", "prune", "move"].includes(rest[0] ?? "")) {
		return `git worktree ${rest[0]} is not allowed in review sessions; worktree cleanup is Kanban's job.`;
	}
	if (
		subcommand === "branch" &&
		rest.some((token) => ["-d", "-D", "--delete", "-m", "-M", "--move", "-f", "--force"].includes(token))
	) {
		return "deleting, moving, or force-updating branches is not allowed in review sessions.";
	}
	return null;
}

/** Returns why a `gh` invocation is forbidden in a review session (publication), else null. */
function checkGhInvocation(tokens: string[]): string | null {
	const ghIndex = tokens.indexOf("gh");
	if (ghIndex === -1) {
		return null;
	}
	const [group, action] = tokens.slice(ghIndex + 1).filter((token) => !token.startsWith("-"));
	if (
		(group === "pr" && ["create", "merge", "close", "edit", "ready"].includes(action ?? "")) ||
		(group === "release" && action === "create")
	) {
		return `gh ${group} ${action} is not allowed in review sessions; Kanban owns Git delivery.`;
	}
	return null;
}

function checkCommandFragment(fragment: string): string | null {
	const tokens = fragment.split(/\s+/).filter(Boolean);
	const git = locateGitSubcommand(tokens);
	const gitDenial = git ? checkGitInvocation(git.subcommand, git.rest) : null;
	if (gitDenial) {
		return gitDenial;
	}
	const ghDenial = checkGhInvocation(tokens);
	if (ghDenial) {
		return ghDenial;
	}
	if (isDestructiveRemoval(tokens)) {
		return "removing the .git directory or the worktree itself (rm -rf) is not allowed in review sessions.";
	}
	return null;
}

/** Returns the denial reason when `command` is a forbidden review-session command, else null. */
export function findDeniedReviewCommand(command: string): string | null {
	for (const fragment of splitCommandFragments(command)) {
		const denial = checkCommandFragment(fragment);
		if (denial) {
			return denial;
		}
	}
	return null;
}

/** Resolves a tool-input path against the worktree, returning a worktree-relative path or null. */
function toWorktreeRelative(worktreePath: string, candidatePath: unknown): string | null {
	if (typeof candidatePath !== "string") {
		return null;
	}
	const trimmed = candidatePath.trim();
	if (!trimmed) {
		return null;
	}
	const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(worktreePath, trimmed);
	const rel = relative(worktreePath, absolute);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
		return null;
	}
	return rel.split(sep).join("/");
}

/** Extracts every file a block-form `apply_patch` input touches. */
function extractPatchPaths(input: unknown): string[] {
	let patchText: string | null = null;
	if (typeof input === "string") {
		patchText = input;
	} else if (isRecord(input) && typeof input.input === "string") {
		patchText = input.input;
	}
	if (patchText === null) {
		return [];
	}
	const paths: string[] = [];
	for (const match of patchText.matchAll(PATCH_FILE_HEADER_PATTERN)) {
		const path = match[1];
		if (path) {
			paths.push(path);
		}
	}
	return paths;
}

/**
 * Builds the tool approval handler for a review session: delivery/destructive
 * git commands and out-of-scope writes are denied with an explanatory reason
 * the reviewer can act on; everything else is decided by `delegate` (the
 * workspace's existing approval behavior).
 */
export function createReviewToolPolicy(options: CreateReviewToolPolicyOptions): ReviewToolApprovalHandler {
	const { worktreePath } = options;
	const delegate = options.delegate ?? approveByDefault;
	const allowedWritePaths = new Set(
		options.allowedWritePaths.map((path) => path.split(sep).join("/")).filter(Boolean),
	);

	return async (request: ClineSdkToolApprovalRequest): Promise<ClineSdkToolApprovalResult> => {
		const toolName = request.toolName;
		const input = isRecord(request.input) ? request.input : {};

		if (toolName === "submit" || READ_TOOL_NAMES.has(toolName)) {
			return await delegate(request);
		}

		if (COMMAND_TOOL_NAMES.has(toolName)) {
			for (const command of extractCommandStrings(input)) {
				const denial = findDeniedReviewCommand(command);
				if (denial) {
					return { approved: false, reason: denial };
				}
			}
			return await delegate(request);
		}

		if (EDITOR_TOOL_NAMES.has(toolName)) {
			const relPath = toWorktreeRelative(worktreePath, input.path);
			if (relPath && allowedWritePaths.has(relPath)) {
				return await delegate(request);
			}
			return {
				approved: false,
				reason: `Review sessions may only modify reviewed files (requested ${relPath ?? String(input.path ?? "")}).`,
			};
		}

		if (toolName === APPLY_PATCH_TOOL_NAME) {
			const paths = extractPatchPaths(input);
			if (paths.length > 0) {
				for (const path of paths) {
					const relPath = toWorktreeRelative(worktreePath, path);
					if (!relPath || !allowedWritePaths.has(relPath)) {
						return {
							approved: false,
							reason: `Review sessions may only modify reviewed files (patch targets ${relPath ?? path}).`,
						};
					}
				}
				return await delegate(request);
			}
			return { approved: false, reason: "Review sessions may only modify reviewed files (unparseable patch)." };
		}

		// Unknown tools (SDK-specific extras): the workspace approval decides.
		return await delegate(request);
	};
}
